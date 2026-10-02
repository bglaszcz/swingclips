"""Both phones' positions from the golfer's own body, instead of the mat board (calib.py session).

Each phone's lens still comes from the lens board (calib.py lens); where the phones stand comes from
swings filmed from both angles after the tripods were set (the 3D calibration page: "Tripods are
set", then "Place the cameras from my swings"). Nothing here runs by itself.

1. Points: in each swing, the joints both views are sure of (shoulders to wrists, hips to ankles),
   paired at the same moments by the impact sync (as tri.py pairs them), and only while they move
   slowly: the sync is only good to a few ms, and a fast wrist would be in two places.
2. The second camera relative to the first: the essential matrix of those pairs (RANSAC), then
   refined by least squares on its rotation and baseline direction, the pairs triangulated and put
   back into both views each step.
3. Scale: the golfer's height. Thigh + shin are LEG_SHARE of standing height (Drillis & Contini);
   the legs are the most reliably seen bones and keep their length through the swing.
4. Golf axes (x toward the target, y up, z toward the golfer's front, origin at the ball):
   up is square to both phones' picture rows (a phone on a tripod is level side to side), the
   target is along the feet (lead ankle minus trail ankle at address, a right-handed golfer), and
   the origin is the ball as both phones saw it before the swing, on the floor.

Out: camera entries like calib.camera_from_pictures's, for calib.save_session, and a report with
the checks a tape measure can confirm (each phone's height and distance from the ball).
"""
import cv2
import numpy as np

import calib
import tri

LEG_SHARE = 0.491          # (thigh + shin) / standing height
UPPER_ARM_SHARE = 0.186    # for the report only: arms are seen less well
JOINTS_USED = (11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28)
LEG = ((23, 25, 27), (24, 26, 28))       # lead (left) and trail hip, knee, ankle
LEAD_ANKLE, TRAIL_ANKLE = 27, 28
MIN_CONF = 0.5
# Fastest a joint may move to count (picture px per second, in both views): ~1 px in 3 ms.
MAX_SPEED = 350.0
# Address: the clip up to this long before impact (the backswing takes ~0.8-1 s).
ADDRESS_BEFORE_IMPACT = 1.1
MAX_POINTS = 40000
MIN_POINTS = 300
MIN_SWINGS = 3
RANSAC_PX = 2.5
REFINE_ROUNDS = 6
BALL_RADIUS = 0.02135
# Ankle joint centre above the floor when no ball is found (the origin falls between the feet then).
ANKLE_HEIGHT = 0.08
GOOD_RMS = 4.0             # px: the joints' own noise is a few px


def _camera(lens: dict, R=None, t=None) -> tri.Camera:
    return tri.Camera({"K": lens["K"], "dist": lens["dist"], "imageSize": lens["imageSize"],
                       "R": np.eye(3) if R is None else R, "t": np.zeros(3) if t is None else t})


def _speed(t, px):
    """Each joint's picture speed (n, J) in px/s."""
    if len(t) < 3:
        return np.full(px.shape[:2], np.inf)
    v = np.gradient(px, t, axis=0)
    return np.linalg.norm(v, axis=-1)


def gather(swings: list[dict], face_lens: dict, dtl_lens: dict) -> dict:
    """The point pairs of all swings: {n1, n2 (normalized), p1, p2 (pixels), address (list per
    swing of (n1, n2) of the address frames, all joints), ball (per swing (n1, n2) or None)}.
    swings: [{face: pose doc, dtl: pose doc, offset: s to add to a face-on time for the same moment}]."""
    cams = [_camera(face_lens), _camera(dtl_lens)]
    n1, n2, p1, p2 = [], [], [], []
    address, balls = [], []
    for s in swings:
        face = tri.points(s["face"]["frames"], cams[0].size)
        dtl = tri.points(s["dtl"]["frames"], cams[1].size)
        if len(face[0]) < 10 or len(dtl[0]) < 10:
            continue
        t, pxs, wts, norm = tri.paired(face, dtl, cams, s["offset"])
        body = list(JOINTS_USED)
        slow = (_speed(t, pxs[0]) < MAX_SPEED) & (_speed(t, pxs[1]) < MAX_SPEED)
        ok = (wts[0] >= MIN_CONF) & (wts[1] >= MIN_CONF) & slow
        keep = np.zeros_like(ok)
        keep[:, body] = ok[:, body]
        n1.append(norm[0][keep])
        n2.append(norm[1][keep])
        p1.append(pxs[0][keep])
        p2.append(pxs[1][keep])
        impact = s["face"].get("impact")
        until = impact - ADDRESS_BEFORE_IMPACT if impact is not None else t[0] + 0.4
        at = t <= until
        address.append((norm[0][at], norm[1][at], (wts[0][at] >= MIN_CONF) & (wts[1][at] >= MIN_CONF)))
        bf, bd = s["face"].get("ball"), s["dtl"].get("ball")
        if bf and bd:
            px_f = np.array([[bf["x"] * cams[0].size[0], bf["y"] * cams[0].size[1]]])
            px_d = np.array([[bd["x"] * cams[1].size[0], bd["y"] * cams[1].size[1]]])
            balls.append((cams[0].normalize(px_f)[0], cams[1].normalize(px_d)[0]))
    if not n1:
        raise ValueError("none of the swings has both angles' joints")
    return {"n1": np.concatenate(n1), "n2": np.concatenate(n2), "p1": np.concatenate(p1), "p2": np.concatenate(p2),
            "address": address, "balls": balls, "swings": len(n1)}


def relative_pose(n1, n2, p2, dtl_lens, f1: float):
    """(R, t with |t| = 1, inlier mask, RMS px in each view): the down-the-line camera relative to the
    face-on one (x2 = R x1 + t), from normalized point pairs."""
    E, mask = cv2.findEssentialMat(n1, n2, np.eye(3), method=cv2.RANSAC, prob=0.999, threshold=RANSAC_PX / f1)
    if E is None or E.shape != (3, 3):
        raise ValueError("couldn't relate the two views (too few joints seen well by both phones)")
    _, R, t, mask = cv2.recoverPose(E, n1, n2, np.eye(3), mask=mask)
    inl = mask.ravel() > 0
    if inl.sum() < MIN_POINTS:
        raise ValueError(f"only {int(inl.sum())} joint points agree between the two views: need {MIN_POINTS}+")
    a, b = n1[inl], n2[inl]
    R, t = refine(R, t.ravel(), a, b, f1, float(np.array(dtl_lens["K"])[0, 0]))
    return R, t, inl


def _t_from(angles):
    """A unit vector from two angles (the baseline's direction: its length is the unknown scale)."""
    th, ph = angles
    return np.array([np.sin(th) * np.cos(ph), np.sin(th) * np.sin(ph), np.cos(th)])


def _angles(t):
    t = t / np.linalg.norm(t)
    return np.array([np.arccos(np.clip(t[2], -1, 1)), np.arctan2(t[1], t[0])])


def refine(R, t, a, b, f1: float, f2: float):
    """Least squares (Levenberg-Marquardt) on the second camera's rotation and baseline direction: the
    point pairs triangulated, then put back into both views (normalized, scaled to pixels by each
    lens's focal length), with a robust (Cauchy) weight so a stray joint can't pull it."""
    def residuals(p):
        Rp, tp = cv2.Rodrigues(p[:3])[0], _t_from(p[3:])
        X = triangulate(np.eye(3), np.zeros(3), Rp, tp, a, b)
        x1 = X[:, :2] / X[:, 2:3]
        X2 = X @ Rp.T + tp
        x2 = X2[:, :2] / X2[:, 2:3]
        r = np.concatenate([((x1 - a) * f1).ravel(), ((x2 - b) * f2).ravel()])
        return np.nan_to_num(r, nan=1e3, posinf=1e3, neginf=-1e3)

    p = np.concatenate([cv2.Rodrigues(R)[0].ravel(), _angles(t)])
    lam = 1e-3
    r = residuals(p)
    c = RANSAC_PX * 2

    def cost(r):
        return float(np.sum(np.log1p((r / c) ** 2)))

    now = cost(r)
    for _ in range(REFINE_ROUNDS * 5):
        w = 1 / (1 + (r / c) ** 2)              # Cauchy weights (IRLS)
        J = np.empty((len(r), 5))
        for k in range(5):
            d = np.zeros(5)
            d[k] = 1e-6
            J[:, k] = (residuals(p + d) - r) / 1e-6
        JW = J * w[:, None]
        H, g = JW.T @ J, JW.T @ r
        better = False
        for _ in range(8):
            step = np.linalg.solve(H + lam * np.diag(np.diag(H) + 1e-12), -g)
            r_new = residuals(p + step)
            if cost(r_new) < now:
                p, r, now = p + step, r_new, cost(r_new)
                lam = max(lam / 3, 1e-7)
                better = True
                break
            lam *= 4
        if not better or np.abs(step).max() < 1e-9:
            break
    return cv2.Rodrigues(p[:3])[0], _t_from(p[3:])


def triangulate(R1, t1, R2, t2, a, b):
    """Points (n, 3) from normalized pairs a (view 1) and b (view 2), cameras x_i = R_i X + t_i."""
    P1 = np.hstack([R1, np.asarray(t1, float).reshape(3, 1)])
    P2 = np.hstack([R2, np.asarray(t2, float).reshape(3, 1)])
    X = cv2.triangulatePoints(P1, P2, a.T.astype(np.float64), b.T.astype(np.float64))
    return (X[:3] / X[3]).T


def rms_px(cam: tri.Camera, X, px) -> float:
    return float(np.sqrt(np.mean(np.sum((cam.project(X) - px) ** 2, axis=1))))


def solve(swings: list[dict], face_lens: dict, dtl_lens: dict, height_m: float) -> tuple[dict, dict]:
    """(cameras {face, dtl} in golf axes, report). Raises ValueError with what to do."""
    if len(swings) < MIN_SWINGS:
        raise ValueError(f"{len(swings)} swing(s) filmed from both phones: need {MIN_SWINGS} or more")
    if not 1.2 <= height_m <= 2.3:
        raise ValueError("height should be between 1.2 and 2.3 m (4 to 7.5 ft)")
    g = gather(swings, face_lens, dtl_lens)
    n1, n2, p1, p2 = g["n1"], g["n2"], g["p1"], g["p2"]
    if len(n1) > MAX_POINTS:
        pick = np.random.default_rng(0).choice(len(n1), MAX_POINTS, replace=False)
        n1, n2, p1, p2 = n1[pick], n2[pick], p1[pick], p2[pick]
    if len(n1) < MIN_POINTS:
        raise ValueError(f"only {len(n1)} joint points seen well by both phones: need {MIN_POINTS}+ "
                         "(are both phones framing the whole golfer?)")
    f1 = float(np.array(face_lens["K"])[0, 0])
    R, t, inl = relative_pose(n1, n2, p2, dtl_lens, f1)
    I3, z3 = np.eye(3), np.zeros(3)

    # Scale from the legs at address.
    legs = []
    for a, b, ok in g["address"]:
        if not len(a):
            continue
        X = triangulate(I3, z3, R, t, a.reshape(-1, 2), b.reshape(-1, 2)).reshape(a.shape[0], a.shape[1], 3)
        for hip, knee, ankle in LEG:
            sel = ok[:, hip] & ok[:, knee] & ok[:, ankle]
            if sel.sum() >= 5:
                legs.append(np.median(np.linalg.norm(X[sel, hip] - X[sel, knee], axis=1)
                                      + np.linalg.norm(X[sel, knee] - X[sel, ankle], axis=1)))
    if not legs:
        raise ValueError("the legs weren't seen well enough at address by both phones")
    leg_unit = float(np.median(legs))
    s = LEG_SHARE * height_m / leg_unit
    tm = s * t

    # Address points in metres (face-on camera axes), for the axes and the origin.
    pts = []
    for a, b, ok in g["address"]:
        if len(a):
            X = s * triangulate(I3, z3, R, tm / s, a.reshape(-1, 2), b.reshape(-1, 2)).reshape(a.shape[0], a.shape[1], 3)
            pts.append((X, ok))

    # Up: square to both phones' picture rows; pointing the way the face-on picture's up does.
    up = np.cross([1.0, 0, 0], R.T @ [1.0, 0, 0])
    if np.linalg.norm(up) < 0.3:
        raise ValueError("the two phones look the same way (or opposite ways): one should be face on, one down the line")
    up /= np.linalg.norm(up)
    if up @ [0, -1.0, 0] < 0:
        up = -up

    # Target: along the feet (lead ankle minus trail), level.
    feet = []
    for X, ok in pts:
        sel = ok[:, LEAD_ANKLE] & ok[:, TRAIL_ANKLE]
        if sel.any():
            d = np.median(X[sel, LEAD_ANKLE] - X[sel, TRAIL_ANKLE], axis=0)
            d -= (d @ up) * up
            if np.linalg.norm(d) > 1e-6:
                feet.append(d / np.linalg.norm(d))
    if not feet:
        raise ValueError("the ankles weren't seen at address by both phones")
    x = np.mean(feet, axis=0)
    x -= (x @ up) * up
    x /= np.linalg.norm(x)
    z = np.cross(x, up)

    # Origin: the ball on the floor, else between the feet.
    warnings = []
    balls = [s * triangulate(I3, z3, R, t, np.array([bf]), np.array([bd]))[0] for bf, bd in g["balls"]]
    balls = [b for b in balls if np.isfinite(b).all()]
    if balls:
        origin = np.median(balls, axis=0) - BALL_RADIUS * up
        ball_spread = float(np.median(np.linalg.norm(np.array(balls) - np.median(balls, axis=0), axis=1)))
    else:
        mids = [np.median((X[ok[:, LEAD_ANKLE] & ok[:, TRAIL_ANKLE], LEAD_ANKLE]
                           + X[ok[:, LEAD_ANKLE] & ok[:, TRAIL_ANKLE], TRAIL_ANKLE]) / 2, axis=0)
                for X, ok in pts if (ok[:, LEAD_ANKLE] & ok[:, TRAIL_ANKLE]).any()]
        origin = np.median(mids, axis=0) - ANKLE_HEIGHT * up
        ball_spread = None
        warnings.append("no ball found in both views: the origin is between the feet instead of at the ball")

    # Golf axes: X1 = A^T Xg + origin (A's rows: x, up, z in face-on camera axes).
    A = np.stack([x, up, z])
    R1, t1 = A.T, origin
    R2, t2 = R @ A.T, R @ origin + tm
    cams = {}
    for angle, Rg, tg, lens in (("face", R1, t1, face_lens), ("dtl", R2, t2, dtl_lens)):
        cams[angle] = {"R": Rg.tolist(), "t": list(map(float, tg)), "position": list(map(float, -Rg.T @ tg)),
                       "angle": angle, "source": "body", "K": lens["K"], "dist": lens["dist"],
                       "imageSize": lens["imageSize"], "lens": lens.get("name"), "mode": lens.get("mode")}

    # How well it fits: the inlier joints back into each picture.
    c1, c2 = _camera(face_lens, R1, t1), _camera(dtl_lens, R2, t2)
    a, b = n1[inl], n2[inl]
    Xg = triangulate(R1, t1, R2, t2, a, b)
    rms1 = rms_px(c1, Xg, p1[inl])
    rms2 = rms_px(c2, Xg, p2[inl])
    for angle, rms in (("face", rms1), ("dtl", rms2)):
        cams[angle]["rms"] = rms
        cams[angle]["points"] = int(inl.sum())
        cams[angle]["warnings"] = calib.placement_warnings(angle, cams[angle])

    arms = []
    for X, ok in pts:
        for sh, el in ((11, 13), (12, 14)):
            sel = ok[:, sh] & ok[:, el]
            if sel.sum() >= 5:
                arms.append(float(np.median(np.linalg.norm(X[sel, sh] - X[sel, el], axis=1))))
    pos = {k: np.array(v["position"]) for k, v in cams.items()}
    feet_vs_dtl = None
    look = R2.T @ [0, 0, 1.0]                  # where the down-the-line phone looks, golf axes
    if abs(look[0]) + abs(look[2]) > 1e-6:
        feet_vs_dtl = float(np.degrees(np.arctan2(look[2], look[0])))
    report = {
        "swings": g["swings"], "points": int(inl.sum()), "rms": {"face": rms1, "dtl": rms2},
        "good": bool(rms1 < GOOD_RMS and rms2 < GOOD_RMS),
        "height": height_m, "legLength": LEG_SHARE * height_m,
        "upperArm": float(np.median(arms)) if arms else None, "upperArmExpected": UPPER_ARM_SHARE * height_m,
        "cameraHeights": {k: float(p[1]) for k, p in pos.items()},
        "fromBall": {k: float(np.hypot(p[0], p[2])) for k, p in pos.items()},
        "apart": float(np.linalg.norm(pos["face"] - pos["dtl"])),
        "ballSpread": ball_spread, "dtlLooksVsFeet": feet_vs_dtl, "warnings": warnings,
    }
    return cams, report


def describe(report: dict, cams: dict) -> str:
    """The report in words, for the calibration page."""
    m_in = 39.37
    lines = [f"From {report['swings']} swing(s), {report['points']} joint points seen by both phones."]
    lines.append(f"Fit: {report['rms']['face']:.1f} px face on, {report['rms']['dtl']:.1f} px down the line "
                 f"({'good' if report['good'] else f'NOT good: want under {GOOD_RMS:g} px'}).")
    for k, name in (("face", "Face-on phone"), ("dtl", "Down-the-line phone")):
        lines.append(f"{name}: {report['cameraHeights'][k] * m_in:.0f} in high, {report['fromBall'][k] * m_in / 12:.1f} ft "
                     f"from the ball (check with a tape measure).")
    lines.append(f"Phones {report['apart'] * m_in / 12:.1f} ft apart.")
    if report.get("upperArm"):
        lines.append(f"Upper arm {report['upperArm'] * m_in:.1f} in (about {report['upperArmExpected'] * m_in:.1f} in "
                     "is usual for your height).")
    if report.get("dtlLooksVsFeet") is not None:
        lines.append(f"The down-the-line phone looks {abs(report['dtlLooksVsFeet']):.0f} degrees "
                     f"{'right' if report['dtlLooksVsFeet'] > 0 else 'left'} of your feet line.")
    for w in report["warnings"]:
        lines.append("Warning: " + w)
    return "\n".join(lines)
