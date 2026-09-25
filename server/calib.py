"""Calibration for 3D from both phones: each phone's lens once per recording mode, and both phones'
positions each session. Nothing here runs unless SWINGCLIPS_3D=on (tri.py, app.py); the 2D
analysis never uses it.

Lens (once per phone and mode; the lens board from board.py, waved in front of the phone):
  python calib.py lens --phone s23ultra --angle face <clip.mp4> [more clips]
    -> calib/s23ultra-1920x1080_240fps.json: intrinsics, distortion, image size (upright), RMS
       reprojection error, and whether it's good enough (RMS under 0.5 px, corners all over the
       picture). The mode comes from the clip's name (swing_<angle>_<W>x<H>_<fps>fps_...), or --mode.
       Record in the mode you swing in: 240 fps high-speed crops the sensor, so its lens numbers
       aren't the 30 fps ones. --angle also notes which phone films which angle (calib/phones.json).

Positions (each session; the mat board flat on the mat with its centre on the ball, arrow to the
target, both phones recording it for a few seconds):
  python calib.py session <face clip or still> <dtl clip or still>
    -> calib/sessions/<date>_<time>.json: each camera's rotation and position in golf axes
       (metres; x toward the target, y up, z toward the golfer's front, origin at the ball).
The camera setup (setup.py) does the same from the phones' setup stills when it sees the board.

A session's positions hold for the swings after it until a camera moves: the golfer's place and
size in each picture (summary.js framing / cameraMoved, the check the trends use) is compared with
the first swings after the session.
"""
import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

import board

CALIB_DIR = Path(os.environ.get("SWINGCLIPS_CALIB") or
                 Path(os.environ.get("SWINGCLIPS_CLIPS", r"D:\SwingClips\clips")).parent / "calib")
# Good enough: RMS reprojection error under this (pixels), and corners seen in this share of the
# picture's 4 x 4 grid of cells (the edges are where the distortion is).
GOOD_RMS = 0.5
GOOD_COVERAGE = 0.75
# Views: a frame counts with at least this many board corners; at most this many are used (spread
# through the clips), and one is dropped after the first fit if its error is this many times the median.
MIN_CORNERS = 12
MAX_VIEWS = 60
OUTLIER = 3.0
# A board position solved with an RMS above this (pixels) isn't kept.
POSE_RMS = 2.0
MODE = re.compile(r"_(\d+)x(\d+)_(\d+)fps_")
# Golf axes from board axes (board: x along the print, y down it, z into it; it lies face up).
BOARD_TO_GOLF = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], float)


def enabled() -> bool:
    """3D from both phones is on (SWINGCLIPS_3D=on); read each time, so tests can set it."""
    return os.environ.get("SWINGCLIPS_3D", "").strip().lower() in ("1", "on", "yes", "true")


def mode_of(name: str) -> str | None:
    """"1920x1080_240fps" from a capture app clip name."""
    m = MODE.search(name)
    return f"{m.group(1)}x{m.group(2)}_{m.group(3)}fps" if m else None


# ---- Pictures ----

def upright_frames(path: str, every: int = 1):
    """(time, upright grayscale frame) for every `every`-th frame of a clip."""
    import av
    import pose
    _, _, rotation = pose.probe(path)
    with av.open(path) as c:
        s = c.streams.video[0]
        tb = float(s.time_base)
        for k, f in enumerate(c.decode(s)):
            if k % every == 0:
                yield f.pts * tb, pose.upright_gray(f, rotation)


def load_picture(path: str) -> np.ndarray:
    """A still as grayscale (already upright: the capture app's stills are)."""
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ValueError(f"{path}: not a picture")
    return img


def is_video(path: str) -> bool:
    return Path(path).suffix.lower() in (".mp4", ".mov", ".webm")


def detect(gray: np.ndarray, spec: board.Spec):
    """The board's inner corners in a picture: (pixels (n, 2) float32, corner ids (n,)), or None."""
    det = cv2.aruco.CharucoDetector(board.charuco(spec))
    corners, ids, _, _ = det.detectBoard(gray)
    if corners is None or ids is None or len(ids) < 4:
        return None
    return corners.reshape(-1, 2).astype(np.float32), ids.ravel().astype(np.int32)


def object_points(spec: board.Spec, ids) -> np.ndarray:
    """The corners' positions on the board (metres, board axes)."""
    return board.charuco(spec).getChessboardCorners()[np.asarray(ids)].astype(np.float32)


# ---- Lens ----

def coverage(views, size) -> float:
    """Share of the picture's 4 x 4 cells with a corner in some view."""
    w, h = size
    cells = set()
    for pts, _ in views:
        for x, y in pts:
            cells.add((min(3, int(4 * x / w)), min(3, int(4 * y / h))))
    return len(cells) / 16


def spread(views, n):
    """At most n views, evenly through the list."""
    if len(views) <= n:
        return list(views)
    return [views[round(i)] for i in np.linspace(0, len(views) - 1, n)]


def calibrate(views, size, spec: board.Spec = board.LENS) -> dict:
    """Intrinsics from board views [(pixels, ids)] in pictures of `size` (w, h).

    Fits, drops views far worse than the rest (motion blur, a bad detection), fits again.
    """
    views = [v for v in views if len(v[1]) >= MIN_CORNERS]
    if len(views) < 5:
        raise ValueError(f"the board was found in {len(views)} frame(s) with {MIN_CORNERS}+ corners: need 5 or more "
                         "(more light, slower waving, or closer)")
    views = spread(views, MAX_VIEWS)

    def fit(vs):
        obj = [object_points(spec, ids) for _, ids in vs]
        img = [pts.reshape(-1, 1, 2) for pts, _ in vs]
        rms, k, dist, rvecs, tvecs = cv2.calibrateCamera(obj, img, size, None, None)
        errs = []
        for o, i, r, t in zip(obj, img, rvecs, tvecs):
            p, _ = cv2.projectPoints(o, r, t, k, dist)
            errs.append(float(np.sqrt(np.mean(np.sum((p - i) ** 2, axis=2)))))
        return rms, k, dist, np.array(errs)

    rms, k, dist, errs = fit(views)
    keep = errs <= max(OUTLIER * np.median(errs), GOOD_RMS)
    if keep.sum() >= 5 and not keep.all():
        views = [v for v, ok in zip(views, keep) if ok]
        rms, k, dist, errs = fit(views)
    cov = coverage(views, size)
    return {"imageSize": list(size), "K": k.tolist(), "dist": dist.ravel().tolist(), "rms": float(rms),
            "views": len(views), "coverage": cov, "good": bool(rms < GOOD_RMS and cov >= GOOD_COVERAGE)}


def lens_views(paths, spec=board.LENS, every=4):
    """Board views from clips (every `every`-th frame) or stills; (views, picture size)."""
    views, size = [], None
    for p in paths:
        pics = upright_frames(p, every) if is_video(p) else [(0.0, load_picture(p))]
        for _, g in pics:
            shape = (g.shape[1], g.shape[0])
            if size is None:
                size = shape
            elif shape != size:
                raise ValueError(f"{p}: {shape[0]}x{shape[1]} pictures, the others are {size[0]}x{size[1]}")
            found = detect(g, spec)
            if found is not None:
                views.append(found)
    return views, size


def lens_file(phone: str, mode: str) -> Path:
    return CALIB_DIR / f"{phone}-{mode}.json"


def phones() -> dict:
    """Which phone films which angle: {"face": "s23ultra", "dtl": "s21"}."""
    try:
        return json.loads((CALIB_DIR / "phones.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def lens_for(angle: str, mode: str | None) -> dict | None:
    """The lens calibration of the phone that films `angle`, in `mode`, or None. Without a mode:
    the phone's only calibration, if it has just one."""
    phone = phones().get(angle)
    if not phone:
        return None
    if mode is None:
        found = list(CALIB_DIR.glob(f"{phone}-*.json"))
        if len(found) != 1:
            return None
        path = found[0]
    else:
        path = lens_file(phone, mode)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def write_json(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, indent=1), encoding="utf-8")
    tmp.replace(path)


def verdict(c: dict) -> str:
    if c["good"]:
        return f"good: RMS {c['rms']:.2f} px over {c['views']} views, corners in {c['coverage']:.0%} of the picture"
    why = []
    if c["rms"] >= GOOD_RMS:
        why.append(f"RMS {c['rms']:.2f} px (want under {GOOD_RMS}): hold the board flatter and steadier, more light")
    if c["coverage"] < GOOD_COVERAGE:
        why.append(f"corners only in {c['coverage']:.0%} of the picture: take the board into the corners and edges")
    return "NOT good enough: " + "; ".join(why)


# ---- Positions ----

def scaled_lens(lens: dict, size) -> tuple[np.ndarray, np.ndarray]:
    """K and distortion for pictures of `size`: the calibration's, scaled when the picture is the
    same view at another resolution (a setup still). A different shape isn't the same view."""
    w0, h0 = lens["imageSize"]
    w, h = size
    s = w / w0
    if abs(h / h0 - s) > 0.01 * s:
        raise ValueError(f"picture is {w}x{h}, the lens was calibrated at {w0}x{h0}: not the same view")
    k = np.array(lens["K"], float)
    k[:2] *= s
    return k, np.array(lens["dist"], float)


def solve_camera(views, k, dist, spec: board.Spec = board.MAT) -> dict:
    """A still camera's pose from board views [(pixels, ids)] (one or many frames: each corner's
    median place is used): rotation and position in golf axes, and the RMS error in pixels."""
    by_id = {}
    for pts, ids in views:
        for p, i in zip(pts, ids):
            by_id.setdefault(int(i), []).append(p)
    if len(by_id) < 6:
        raise ValueError(f"only {len(by_id)} board corner(s) seen: need 6 or more (a bigger board, or the phone lower "
                         "and closer)")
    ids = np.array(sorted(by_id))
    img = np.array([np.median(by_id[i], axis=0) for i in ids], np.float64)
    obj = object_points(spec, ids).astype(np.float64)
    ok, rvecs, tvecs, _ = cv2.solvePnPGeneric(obj, img, k, dist, flags=cv2.SOLVEPNP_IPPE)
    if not ok:
        raise ValueError("couldn't place the camera from the board")
    # IPPE gives the two mirror solutions of a flat target: keep the one that fits better.
    best = None
    for r, t in zip(rvecs, tvecs):
        r, t = cv2.solvePnPRefineLM(obj, img, k, dist, r.copy(), t.copy())
        p, _ = cv2.projectPoints(obj, r, t, k, dist)
        rms = float(np.sqrt(np.mean(np.sum((p.reshape(-1, 2) - img) ** 2, axis=1))))
        if best is None or rms < best[0]:
            best = (rms, r, t)
    rms, r, t = best
    rb = cv2.Rodrigues(r)[0]
    w, h = spec.size_mm
    centre = np.array([w / 2000, h / 2000, 0.0])
    # x_cam = Rb b + tb with b = A^T g + centre (A: board to golf axes).
    rg = rb @ BOARD_TO_GOLF.T
    tg = rb @ centre + t.ravel()
    return {"R": rg.tolist(), "t": tg.tolist(), "position": (-rg.T @ tg).tolist(), "rms": rms, "corners": len(ids)}


def placement_warnings(angle: str, cam: dict) -> list[str]:
    """What looks wrong about a solved camera for its angle (wrong board orientation, usually)."""
    x, y, z = cam["position"]
    out = []
    if not 0.2 <= y <= 3.0:
        out.append(f"camera {y:.2f} m above the mat: expected 0.2-3 m (is the board face up?)")
    if angle == "face" and z <= 0:
        out.append("the face-on camera comes out behind the golfer: turn the board round (y arrow away from you)")
    if angle == "dtl" and x >= 0:
        out.append("the down-the-line camera comes out on the target side: turn the board round (x arrow to the target)")
    return out


def camera_from(path: str, angle: str, lens: dict, spec: board.Spec = board.MAT, every: int = 8) -> dict:
    """One camera's session entry from a clip or still of the mat board."""
    if is_video(path):
        pics = [g for _, g in upright_frames(path, every)]
    else:
        pics = [load_picture(path)]
    return camera_from_pictures(pics, angle, lens, spec, Path(path).name)


def camera_from_pictures(pics: list[np.ndarray], angle: str, lens: dict, spec: board.Spec = board.MAT,
                         source: str = "") -> dict:
    """One camera's session entry from upright grayscale pictures of the mat board (same size)."""
    size = (pics[0].shape[1], pics[0].shape[0])
    k, dist = scaled_lens(lens, size)
    views = [v for v in (detect(g, spec) for g in pics) if v is not None]
    if not views:
        raise ValueError(f"{source or angle}: the mat board wasn't found")
    cam = solve_camera(views, k, dist, spec)
    # Stored at the calibration's own resolution, which the pose files' picture units map onto.
    s = lens["imageSize"][0] / size[0]
    return {**cam, "angle": angle, "source": source, "rms": cam["rms"] * s,
            "K": lens["K"], "dist": lens["dist"], "imageSize": lens["imageSize"], "lens": lens.get("name"),
            "mode": lens.get("mode"), "warnings": placement_warnings(angle, cam)}


def session_file(created: float) -> Path:
    return CALIB_DIR / "sessions" / f"{datetime.fromtimestamp(created):%Y-%m-%d_%H%M%S}.json"


def save_session(cameras: dict, spec: board.Spec = board.MAT, created: float | None = None) -> Path:
    created = time.time() if created is None else created
    doc = {"created": created, "board": spec.to_json(), "cameras": cameras}
    path = session_file(created)
    write_json(path, doc)
    return path


def sessions() -> list[dict]:
    """Every saved session, oldest first, each with its "id" (file stem)."""
    out = []
    folder = CALIB_DIR / "sessions"
    if folder.is_dir():
        for f in folder.glob("*.json"):
            try:
                doc = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if isinstance(doc, dict) and doc.get("cameras", {}).get("face") and doc["cameras"].get("dtl"):
                out.append({**doc, "id": f.stem})
    return sorted(out, key=lambda d: d["created"])


def session_before(t: float, all_sessions: list[dict] | None = None) -> dict | None:
    """The latest session made before unix time t."""
    best = None
    for s in all_sessions if all_sessions is not None else sessions():
        if s["created"] <= t:
            best = s
    return best


# ---- Command line ----

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    lens = sub.add_parser("lens", help="calibrate a phone's lens from clips of the lens board")
    lens.add_argument("clips", nargs="+")
    lens.add_argument("--phone", required=True, help="a name for the phone, e.g. s23ultra")
    lens.add_argument("--mode", help="recording mode, e.g. 1920x1080_240fps (default: from the clip name)")
    lens.add_argument("--angle", choices=["face", "dtl"], help="the angle this phone films (noted in phones.json)")
    lens.add_argument("--every", type=int, default=4, help="use every n-th frame (default 4)")
    sess = sub.add_parser("session", help="both cameras' positions from the mat board")
    sess.add_argument("face", help="face-on clip or still of the board on the mat")
    sess.add_argument("dtl", help="down-the-line clip or still")
    sess.add_argument("--square-mm", type=float, help="the mat board's square as printed, if not 150 mm")
    sess.add_argument("--face-mode", help="the face-on phone's mode (default: from the clip name)")
    sess.add_argument("--dtl-mode", help="the down-the-line phone's mode")
    args = ap.parse_args(argv)

    if args.cmd == "lens":
        mode = args.mode or mode_of(Path(args.clips[0]).name)
        if not mode:
            ap.error("no mode in the clip's name: give --mode, e.g. 1920x1080_240fps")
        print(f"Looking for the lens board in {len(args.clips)} clip(s) ...", flush=True)
        views, size = lens_views(args.clips, every=args.every)
        try:
            c = calibrate(views, size)
        except ValueError as e:
            print(f"Lens calibration failed: {e}")
            return 1
        c.update(name=f"{args.phone}-{mode}", phone=args.phone, mode=mode, board=board.LENS.to_json(),
                 clips=[Path(p).name for p in args.clips], created=time.time())
        out = lens_file(args.phone, mode)
        write_json(out, c)
        if args.angle:
            ph = phones()
            ph[args.angle] = args.phone
            write_json(CALIB_DIR / "phones.json", ph)
        k = np.array(c["K"])
        print(f"{out}: fx {k[0, 0]:.1f} fy {k[1, 1]:.1f} px, centre ({k[0, 2]:.1f}, {k[1, 2]:.1f}), "
              f"{size[0]}x{size[1]}")
        print(verdict(c))
        return 0 if c["good"] else 2

    spec = board.sized(board.MAT, args.square_mm)
    cams, failed = {}, False
    for angle, path, mode in (("face", args.face, args.face_mode), ("dtl", args.dtl, args.dtl_mode)):
        mode = mode or mode_of(Path(path).name)
        lens_c = lens_for(angle, mode)
        if lens_c is None:
            print(f"{angle}: no lens calibration for {phones().get(angle, '(which phone?)')} in {mode}: "
                  "run calib.py lens first (with --angle)")
            failed = True
            continue
        try:
            cams[angle] = camera_from(path, angle, lens_c, spec)
        except ValueError as e:
            print(f"{angle}: {e}")
            failed = True
            continue
        c = cams[angle]
        x, y, z = c["position"]
        print(f"{angle}: camera at x {x:+.2f} y {y:+.2f} z {z:+.2f} m, RMS {c['rms']:.2f} px over {c['corners']} corners")
        for w in c["warnings"]:
            print(f"  warning: {w}")
        if c["rms"] > POSE_RMS:
            print(f"  RMS over {POSE_RMS} px: not kept")
            failed = True
    if failed:
        return 1
    out = save_session(cams, spec)
    apart = np.degrees(np.arccos(np.clip(np.dot(np.array(cams["face"]["R"])[2], np.array(cams["dtl"]["R"])[2]), -1, 1)))
    print(f"{out}: cameras {apart:.0f} degrees apart")
    return 0


if __name__ == "__main__":
    sys.exit(main())
