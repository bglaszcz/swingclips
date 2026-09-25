"""3D joints from the two phones' pose files and a calibration session (calib.py): real positions in
golf axes (metres; x toward the target, y up, z toward the golfer's front, origin at the ball).

1. Pair frames: the phones have no shared clock, so the swing is synced on impact (the first frame
   without the ball in each clip, as the review page does: summary.js syncOffset). Each face-on
   frame is matched with the down-the-line landmarks interpolated to the same moment (the phones
   drop different frames, and their frames start at different times anyway).
2. Sync to a fraction of a frame: each clip's impact is only known to its frame (~4 ms at 240 fps),
   so the offset is searched within a frame and a half either way for the one at which the fast
   joints (elbows, wrists) triangulate best in the downswing: with the wrong offset the two views
   see the hands at different moments and their rays miss each other.
3. Triangulate each landmark with a linear (DLT) fit, each view's rows weighted by how sure the
   pose model was of the point.
4. Filter: least squares over the whole swing that stays close to the triangulated points (by how
   well each fitted), keeps each bone's length the same in every frame, and is smooth in time (a
   penalty on acceleration, about a SMOOTH_HZ cutoff). Solved by alternating the bone lengths and a
   banded linear solve per joint.

Reports the reprojection error in each view (pixels, before and after the filter) and how much bone
lengths varied before it. Output: <face clip>.3d.json beside the pose files (app.py).
"""
import numpy as np

VERSION = 1
# The 33 MediaPipe landmarks, and the clubhead when both pose files have it (the club model's).
JOINTS = 33
# Bones kept at one length: (name, a, b), MediaPipe indices. Not shoulder to hip: the trunk bends
# and twists, so that distance really changes through the swing.
BONES = [
    ("shoulders", 11, 12), ("hips", 23, 24),
    ("lead upper arm", 11, 13), ("trail upper arm", 12, 14), ("lead forearm", 13, 15), ("trail forearm", 14, 16),
    ("lead hand", 15, 19), ("trail hand", 16, 20),
    ("lead thigh", 23, 25), ("trail thigh", 24, 26), ("lead shin", 25, 27), ("trail shin", 26, 28),
    ("lead heel", 27, 29), ("trail heel", 28, 30), ("lead foot", 27, 31), ("trail foot", 28, 32),
    ("ears", 7, 8),
]
# Joints whose triangulation sets the sub-frame sync: they move fastest in the downswing.
SYNC_JOINTS = (13, 14, 15, 16)
SYNC_WINDOW = (-0.25, 0.05)        # seconds around impact (face-on clip)
SYNC_SEARCH = 1.5                  # frames either way
SYNC_STEP = 0.00025                # seconds
# A down-the-line landmark is interpolated between two frames at most this far apart (s); dropped
# frames at 240 fps leave gaps of 8-12 ms.
MAX_GAP = 0.015
MIN_WEIGHT = 0.05
# A point that misses its ray by REPROJ_SCALE px counts half.
REPROJ_SCALE = 12.0
SMOOTH_HZ = 15.0
CLUB_SMOOTH_HZ = 40.0
BONE_WEIGHT = 10.0
ITERATIONS = 12
# Frames further than this from any triangulated point of a joint are left empty (s).
FILL_MAX = 0.06
CLUB_MIN_CONF = 0.3


# ---- Cameras ----

class Camera:
    """A calibrated camera in golf axes: x_cam = R X + t, then the lens (K, distortion)."""

    def __init__(self, c: dict):
        self.K = np.array(c["K"], float)
        self.dist = np.array(c["dist"], float).ravel()
        self.R = np.array(c["R"], float)
        self.t = np.array(c["t"], float).ravel()
        self.size = tuple(c["imageSize"])       # upright (w, h)
        self.P = np.hstack([self.R, self.t[:, None]])   # normalized camera

    def normalize(self, px: np.ndarray) -> np.ndarray:
        """Pixels (n, 2) to undistorted normalized coordinates."""
        import cv2
        if not len(px):
            return px.reshape(0, 2)
        return cv2.undistortPoints(px.reshape(-1, 1, 2).astype(np.float64), self.K, self.dist).reshape(-1, 2)

    def project(self, X: np.ndarray) -> np.ndarray:
        """Points (..., 3) in golf axes to pixels (..., 2), with the lens distortion."""
        shape = X.shape[:-1]
        c = X.reshape(-1, 3) @ self.R.T + self.t
        z = np.where(np.abs(c[:, 2]) < 1e-9, 1e-9, c[:, 2])
        x, y = c[:, 0] / z, c[:, 1] / z
        d = np.zeros(8)
        d[:min(8, len(self.dist))] = self.dist[:8]
        k1, k2, p1, p2, k3 = d[:5]
        r2 = x * x + y * y
        radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 ** 3
        if len(self.dist) >= 8:
            radial /= 1 + d[5] * r2 + d[6] * r2 * r2 + d[7] * r2 ** 3
        xd = x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x)
        yd = y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y
        u = self.K[0, 0] * xd + self.K[0, 1] * yd + self.K[0, 2]
        v = self.K[1, 1] * yd + self.K[1, 2]
        return np.stack([u, v], -1).reshape(*shape, 2)


# ---- The two views' points ----

def points(frames: list[dict], size) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(times (n,), pixels (n, J, 2), weights (n, J)) from pose frames; joint J-1 is the clubhead
    where the pose file has one. Frames without a person have weight 0."""
    w, h = size
    n = len(frames)
    t = np.array([f["t"] for f in frames], float)
    px = np.zeros((n, JOINTS + 1, 2))
    wt = np.zeros((n, JOINTS + 1))
    for i, f in enumerate(frames):
        lm = f.get("lm")
        if lm:
            a = np.asarray(lm, float).reshape(JOINTS, 3)
            px[i, :JOINTS] = a[:, :2] * (w, h)
            wt[i, :JOINTS] = np.clip(a[:, 2], MIN_WEIGHT, 1.0)
        head = f.get("clubhead")
        if head and head[2] >= CLUB_MIN_CONF:
            px[i, JOINTS] = (head[0] * w, head[1] * h)
            wt[i, JOINTS] = min(1.0, head[2])
    return t, px, wt


def normalized(cam: Camera, px: np.ndarray, wt: np.ndarray) -> np.ndarray:
    out = np.zeros_like(px)
    have = wt > 0
    out[have] = cam.normalize(px[have])
    return out


def resample(t_src, xy, wt, t_want):
    """Points at times t_want, linear between the two frames either side when they are at most
    MAX_GAP apart (per joint: both must have it); weight 0 where they can't be."""
    n, J = len(t_want), xy.shape[1]
    out = np.zeros((n, J, 2))
    ow = np.zeros((n, J))
    k = np.searchsorted(t_src, t_want, side="right")
    ok = (k > 0) & (k < len(t_src))
    k = np.clip(k, 1, len(t_src) - 1)
    t0, t1 = t_src[k - 1], t_src[k]
    ok &= (t1 - t0) <= MAX_GAP
    a = np.clip((t_want - t0) / np.maximum(t1 - t0, 1e-9), 0, 1)
    both = (wt[k - 1] > 0) & (wt[k] > 0) & ok[:, None]
    out = xy[k - 1] * (1 - a)[:, None, None] + xy[k] * a[:, None, None]
    ow = np.where(both, np.minimum(wt[k - 1], wt[k]), 0.0)
    return out, ow


# ---- Triangulation ----

def dlt(Ps, xys, ws):
    """Weighted linear triangulation. Ps: [3x4] per view; xys: (V, n, 2) normalized; ws: (V, n).
    Returns (n, 3); rows where fewer than two views have weight are NaN."""
    V, n = ws.shape
    A = np.zeros((n, 2 * V, 4))
    for v in range(V):
        x, y = xys[v, :, 0:1], xys[v, :, 1:2]
        w = ws[v][:, None]
        A[:, 2 * v] = w * (x * Ps[v][2] - Ps[v][0])
        A[:, 2 * v + 1] = w * (y * Ps[v][2] - Ps[v][1])
    _, _, vt = np.linalg.svd(A)
    X = vt[:, -1]
    out = X[:, :3] / np.where(np.abs(X[:, 3:]) < 1e-12, 1e-12, X[:, 3:])
    out[(ws > 0).sum(axis=0) < 2] = np.nan
    return out


def triangulate(cams, norm, wts):
    """(n, J, 3) points from each view's normalized points (V, n, J, 2) and weights (V, n, J)."""
    V, n, J = wts.shape
    X = dlt([c.P for c in cams], norm.reshape(V, n * J, 2), wts.reshape(V, n * J))
    return X.reshape(n, J, 3)


def reprojection(cams, X, pxs, wts):
    """Pixel error per view (V, n, J): NaN where a view doesn't have the point or X is missing."""
    out = []
    for cam, px, w in zip(cams, pxs, wts):
        e = np.linalg.norm(cam.project(np.nan_to_num(X)) - px, axis=-1)
        e[(w <= 0) | np.isnan(X[..., 0])] = np.nan
        out.append(e)
    return np.array(out)


def paired(face, dtl, cams, offset, t=None):
    """Face-on points and the down-the-line ones at the same moments, `offset` s later in their clip:
    (face times, pixels (2, n, J, 2), weights (2, n, J), normalized (2, n, J, 2))."""
    tf, pf, wf = face
    td, pd, wd = dtl
    sel = slice(None) if t is None else t
    tq = tf[sel]
    pdq, wdq = resample(td, pd, wd, tq + offset)
    pxs = np.array([pf[sel], pdq])
    wts = np.array([wf[sel], wdq])
    norm = np.array([normalized(cams[0], pxs[0], wts[0]), normalized(cams[1], pxs[1], wts[1])])
    return tq, pxs, wts, norm


def refine_offset(face, dtl, cams, offset, impact, frame=1 / 240):
    """The sync offset within SYNC_SEARCH frames of `offset` at which the elbows and wrists
    triangulate best in the downswing: (offset, {offset tried: median error px}, error at `offset`)."""
    tf = face[0]
    if impact is None:
        return offset, {}, None
    win = np.nonzero((tf >= impact + SYNC_WINDOW[0]) & (tf <= impact + SYNC_WINDOW[1]))[0]
    if len(win) < 10:
        return offset, {}, None
    joints = list(SYNC_JOINTS)
    tried = {}
    steps = int(np.ceil(SYNC_SEARCH * frame / SYNC_STEP))
    for d in np.arange(-steps, steps + 1) * SYNC_STEP:
        _, pxs, wts, norm = paired(face, dtl, cams, offset + d, win)
        pxs, wts, norm = pxs[:, :, joints], wts[:, :, joints], norm[:, :, joints]
        X = triangulate(cams, norm, wts)
        e = reprojection(cams, X, pxs, wts)
        if np.isfinite(e).sum() >= 20:
            tried[round(float(offset + d), 6)] = float(np.nanmedian(e))
    if not tried:
        return offset, {}, None
    keys = sorted(tried)
    errs = np.array([tried[k] for k in keys])
    i = int(np.argmin(errs))
    best = keys[i]
    if 0 < i < len(keys) - 1:
        # A parabola through the three around the best.
        a, b, c = errs[i - 1], errs[i], errs[i + 1]
        den = a - 2 * b + c
        if den > 0:
            best += 0.5 * (a - c) / den * SYNC_STEP
    at = tried.get(round(float(offset), 6))
    return float(best), tried, at


# ---- The filter ----

def second_diff_bands(t, lam):
    """The pentadiagonal bands (main, first off, second off) of lam * D'D, D the second derivative
    over irregular times t (each row weighted by its span)."""
    n = len(t)
    a0, a1, a2 = np.zeros(n), np.zeros(n), np.zeros(n)
    if n < 3:
        return a0, a1, a2
    h1, h2 = np.diff(t)[:-1], np.diff(t)[1:]
    h1, h2 = np.maximum(h1, 1e-6), np.maximum(h2, 1e-6)
    c = np.stack([2 / (h1 * (h1 + h2)), -2 / (h1 * h2), 2 / (h2 * (h1 + h2))], 1)
    c *= np.sqrt(lam * (h1 + h2) / 2)[:, None]
    for r in range(3):
        for s in range(3):
            idx_r = np.arange(n - 2) + r
            v = c[:, r] * c[:, s]
            if r == s:
                np.add.at(a0, idx_r, v)
            elif abs(r - s) == 1 and r > s:
                np.add.at(a1, idx_r, v)          # A[i, i-1] stored at i
            elif r - s == 2:
                np.add.at(a2, idx_r, v)          # A[i, i-2] stored at i
    return a0, a1, a2


def solve_banded(d, a1, a2, b):
    """Solves (diag(d) + bands) x = b for many systems at once: d (n, m), a1 / a2 (n,) the shared
    first / second lower bands (A[i, i-1] at i, A[i, i-2] at i), b (n, m, k). Cholesky, by rows."""
    n = d.shape[0]
    l0 = np.zeros_like(d)
    l1 = np.zeros_like(d)
    l2 = np.zeros_like(d)
    z = np.zeros_like(b)
    for i in range(n):
        if i >= 2:
            l2[i] = a2[i] / l0[i - 2]
        if i >= 1:
            l1[i] = (a1[i] - (l2[i] * l1[i - 1] if i >= 2 else 0)) / l0[i - 1]
        l0[i] = np.sqrt(np.maximum(d[i] - l1[i] ** 2 - l2[i] ** 2, 1e-12))
        acc = b[i].copy()
        if i >= 1:
            acc -= l1[i][:, None] * z[i - 1]
        if i >= 2:
            acc -= l2[i][:, None] * z[i - 2]
        z[i] = acc / l0[i][:, None]
    x = np.zeros_like(b)
    for i in range(n - 1, -1, -1):
        acc = z[i].copy()
        if i + 1 < n:
            acc -= l1[i + 1][:, None] * x[i + 1]
        if i + 2 < n:
            acc -= l2[i + 2][:, None] * x[i + 2]
        x[i] = acc / l0[i][:, None]
    return x


def lam_for(hz, t):
    """The acceleration penalty that halves motion at `hz` (for weights ~1): 1 / (h w^4)."""
    h = float(np.median(np.diff(t))) if len(t) > 1 else 1 / 240
    return 1.0 / (h * (2 * np.pi * hz) ** 4)


def bone_lengths(X, c):
    """Each bone's length: the median over frames where both ends are sure (weighted by the surer)."""
    out = []
    for _, a, b in BONES:
        d = np.linalg.norm(X[:, a] - X[:, b], axis=1)
        w = np.minimum(c[:, a], c[:, b])
        ok = np.isfinite(d) & (w > 0.2)
        out.append(float(np.median(d[ok])) if ok.sum() >= 5 else np.nan)
    return np.array(out)


def filter_swing(t, Y, c, hz=SMOOTH_HZ, bones=True):
    """The filtered points (n, J, 3) from triangulated ones Y (NaN = none) with confidences c (n, J).

    Minimizes sum c |X - Y|^2 + lam |X''|^2 + BONE_WEIGHT sum (|Xa - Xb| - L)^2, alternating:
    bone ends are pulled to the length each iteration (as targets), then the linear smoothing
    solve for every joint at once."""
    n, J, _ = Y.shape
    c = np.where(np.isfinite(Y[..., 0]), c, 0.0)
    Yz = np.nan_to_num(Y)
    a0, a1, a2 = second_diff_bands(t, lam_for(hz, t))
    # Start: smoothing alone.
    X = solve_banded(c + a0[:, None] + 1e-9, a1, a2, c[..., None] * Yz)
    if not bones:
        return X, None
    L = bone_lengths(np.where(c[..., None] > 0, X, np.nan), c)
    for _ in range(ITERATIONS):
        tgt = np.zeros_like(X)
        cnt = np.zeros((n, J))
        for (_, a, b), length in zip(BONES, L):
            if not np.isfinite(length):
                continue
            m = (X[:, a] + X[:, b]) / 2
            u = X[:, b] - X[:, a]
            u /= np.maximum(np.linalg.norm(u, axis=1, keepdims=True), 1e-9)
            tgt[:, a] += m - u * length / 2
            tgt[:, b] += m + u * length / 2
            cnt[:, a] += 1
            cnt[:, b] += 1
        wb = BONE_WEIGHT * cnt
        X = solve_banded(c + wb + a0[:, None] + 1e-9, a1, a2, c[..., None] * Yz + BONE_WEIGHT * tgt)
    return X, L


def coverage_mask(t, c):
    """(n, J) True where a frame is within FILL_MAX of a triangulated point of that joint, and
    between the first and last of them."""
    n, J = c.shape
    out = np.zeros((n, J), bool)
    for j in range(J):
        have = np.nonzero(c[:, j] > 0)[0]
        if not len(have):
            continue
        th = t[have]
        k = np.clip(np.searchsorted(th, t), 1, len(th) - 1) if len(th) > 1 else np.zeros(n, int)
        near = np.minimum(np.abs(t - th[k - 1]), np.abs(t - th[k])) if len(th) > 1 else np.abs(t - th[0])
        out[:, j] = (near <= FILL_MAX) & (t >= th[0]) & (t <= th[-1])
    return out


# ---- One swing ----

def stats(e):
    e = np.asarray(e, float)
    e = e[np.isfinite(e)]
    return {"n": int(len(e)), "median": round(float(np.median(e)), 2) if len(e) else None,
            "p90": round(float(np.percentile(e, 90)), 2) if len(e) else None}


def swing(face_pose: dict, dtl_pose: dict, session: dict, offset: float, face_impact: float | None = None) -> dict:
    """The 3D swing: face_pose / dtl_pose as in the pose files ({frames: [{t, lm, clubhead?}]}),
    session from calib.py, offset = seconds to add to a face-on clip time for the same moment down
    the line (summary.js syncOffset). JSON-ready."""
    cams = [Camera(session["cameras"]["face"]), Camera(session["cameras"]["dtl"])]
    face = points(face_pose["frames"], cams[0].size)
    dtl = points(dtl_pose["frames"], cams[1].size)
    frame = float(np.median(np.diff(face[0]))) if len(face[0]) > 1 else 1 / 240
    best, tried, at = refine_offset(face, dtl, cams, offset, face_impact, frame)
    t, pxs, wts, norm = paired(face, dtl, cams, best)
    Y = triangulate(cams, norm, wts)
    err = reprojection(cams, Y, pxs, wts)                          # (2, n, J)
    worst = np.nanmax(np.nan_to_num(err, nan=0.0), axis=0)
    c = np.where(np.isfinite(Y[..., 0]), np.minimum(wts[0], wts[1]) / (1 + (worst / REPROJ_SCALE) ** 2), 0.0)

    body = slice(0, JOINTS)
    Xb, L = filter_swing(t, Y[:, body], c[:, body])
    Xc = None
    if (c[:, JOINTS] > 0).sum() >= 10:
        Xc, _ = filter_swing(t, Y[:, JOINTS:], c[:, JOINTS:], hz=CLUB_SMOOTH_HZ, bones=False)
    mask = coverage_mask(t, c)
    after = reprojection(cams, np.where(mask[:, body, None], Xb, np.nan), pxs[:, :, body], wts[:, :, body])

    bones = {}
    for (name, a, b), length in zip(BONES, L):
        d = np.linalg.norm(Y[:, a] - Y[:, b], axis=1)
        ok = np.isfinite(d) & (np.minimum(c[:, a], c[:, b]) > 0.2)
        if ok.sum() < 5 or not np.isfinite(length):
            continue
        p10, p90 = np.percentile(d[ok], [10, 90])
        df = np.linalg.norm(Xb[:, a] - Xb[:, b], axis=1)[mask[:, a] & mask[:, b]]
        bones[name] = {"length": round(float(length), 4), "spreadPct": round(float(100 * (p90 - p10) / length), 1),
                       "filteredSpreadPct": round(100 * float(np.ptp(np.percentile(df, [10, 90]))) / length, 2)
                       if len(df) else None}

    def rnd(p):
        return [round(float(v), 4) for v in p]

    frames = []
    for i, ti in enumerate(t):
        f = {"t": round(float(ti), 6), "p": [rnd(Xb[i, j]) if mask[i, j] else None for j in range(JOINTS)]}
        if Xc is not None:
            f["club"] = rnd(Xc[i, 0]) if mask[i, JOINTS] else None
        frames.append(f)
    spreads = [b["spreadPct"] for b in bones.values()]
    return {
        "version": VERSION,
        "session": session.get("id"),
        "offsetImpact": round(offset, 6), "offset": round(best, 6),
        "syncError": {"atImpactOffset": None if at is None else round(at, 2),
                      "atBest": round(min(tried.values()), 2) if tried else None},
        "axes": "metres; x toward the target, y up, z toward the golfer's front; origin at the ball",
        "reprojection": {"face": stats(err[0][:, body]), "dtl": stats(err[1][:, body]),
                         "filteredFace": stats(after[0]), "filteredDtl": stats(after[1])},
        "bones": bones,
        "boneSpreadPct": round(float(np.median(spreads)), 1) if spreads else None,
        "cameras": {k: {"position": session["cameras"][k]["position"]} for k in ("face", "dtl")},
        "frames": frames,
    }


def at_time(doc: dict, t: float) -> np.ndarray | None:
    """The 3D joints (J, 3) at face-on clip time t, linear between frames; NaN where missing."""
    ts = np.array([f["t"] for f in doc["frames"]])
    if not len(ts) or t < ts[0] or t > ts[-1]:
        return None
    k = int(np.clip(np.searchsorted(ts, t), 1, len(ts) - 1))
    a = (t - ts[k - 1]) / max(ts[k] - ts[k - 1], 1e-9)
    out = np.full((JOINTS, 3), np.nan)
    for j in range(JOINTS):
        p, q = doc["frames"][k - 1]["p"][j], doc["frames"][k]["p"][j]
        if p is not None and q is not None:
            out[j] = np.array(p) * (1 - a) + np.array(q) * a
    return out
