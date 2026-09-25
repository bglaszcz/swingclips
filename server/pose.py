"""Pose for whole clips: MediaPipe on every frame, split across worker processes at keyframes.

Grew out of a timing benchmark (posebench/bench2.py, since removed; see git history). Frames keep
their real timestamps, because high-fps phone clips have dropped frames and index / fps would drift.

Also finds the ball on the mat and the frame it leaves, which pins impact to the frame, and the
club shaft's angle in each frame (club.py).

SWINGCLIPS_POSE_BACKEND picks another body model to place the 2D landmarks (models.py), for scoring
with eval.py --rerun; MediaPipe still runs alongside for everything else. The default, mediapipe,
leaves the output exactly as it was.

SWINGCLIPS_CLUB_BACKEND=yolo has a trained club model (models.py) find the shaft instead of the ray
casting in club.py, and saves its clubhead per frame too; raycast, the default, leaves the output
exactly as it was.
"""
import os
import re
import time
from concurrent.futures import ProcessPoolExecutor

import av
import cv2
import numpy as np

import club
import models

# MediaPipe's "full" model. "heavy" was tried (2026-09): slower, and at the top of the backswing it
# put the trail wrist beside the head, where "full" stays on the hands. SWINGCLIPS_POSE_MODEL can point
# at another .task file to compare.
MODEL = os.environ.get("SWINGCLIPS_POSE_MODEL", os.path.join(
    os.path.dirname(__file__), "..", "public", "mediapipe", "pose_landmarker_full.task"))
VERSION = 6
# The ball search's own version: when only it changes, the server finds the ball again in each
# analyzed clip (find_ball_again, a few seconds a clip) instead of analyzing it all over.
BALL_VERSION = 2
# MediaPipe works on a 256px input internally, so half size loses nothing and halves the conversion.
SCALE = 0.5
ROTATE_CW = {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}

# Landmark indices used here: nose, then ankles, heels and toes.
NOSE = 0
FEET = (27, 28, 29, 30, 31, 32)
# Smoothing: drop one- or two-frame spikes, then fit a curve through each moment's neighbours.
# Done over the whole clip at once, so it looks both ways and doesn't lag behind fast motion.
MEDIAN_FRAMES = 5
SMOOTH_SECONDS = 0.02   # half-width of the curve-fitting window
# Ball search: how many candidate spots to follow, and the span either side of a drop that must look settled.
BALL_CANDIDATES = 6
BALL_STEP_SECONDS = 0.15
# The hands peak in the follow-through, at impact they are at ~40% of that or more; anything "leaving"
# while the hands are slower than this share of their peak isn't the ball. Down the line the hands
# move mostly away from the camera right at impact and look nearly still, so it's their fastest
# within HANDS_WINDOW_SECONDS either side.
HANDS_AT_IMPACT = 0.2
HANDS_WINDOW_SECONDS = 0.1
# The ball goes a little before the phone hears the strike (sound travels; 8-53 ms on real clips,
# never after): a spot that "leaves" outside this window around the heard strike (s) isn't the ball.
# Wrong spots once left 104-106 ms after the strike.
STRIKE_WINDOW = (-0.08, 0.01)
# The ball's radius as a share of nose-to-feet height: 1.1-2.6% on real clips (wrong spots 0.9% and 3.2%).
BALL_RADIUS = (0.010, 0.030)
# Where the ball sits against the lowest foot point, in nose-to-feet heights (+ = lower in the
# picture): face-on the camera looks down on it, 0.16-0.36 below; down the line it's farther away,
# 0.02-0.15 above. Clips of unknown angle get the whole range.
BALL_ROWS = {"face": (0.0, 0.6), "dtl": (-0.3, 0.1), None: (-0.3, 0.6)}
CLIP_NAME = re.compile(r"^swing_(?:(face|dtl)_)?\d+x\d+_\d+fps_\d+(?:_(\d+)ms)?")


def clip_facts(path):
    """(angle "face" | "dtl" | None, heard strike in clip seconds | None) from a capture-app clip name."""
    m = CLIP_NAME.match(os.path.basename(path))
    if not m:
        return None, None
    return m.group(1), (int(m.group(2)) / 1000 if m.group(2) else None)


def probe(path):
    """Keyframe pts, time base, and how far to turn frames clockwise to display them upright.

    PyAV's frame.rotation is the display matrix angle (counter-clockwise), e.g. -90 for a
    portrait phone clip. (Reading it with OpenCV instead crashes: its FFmpeg DLLs clash with PyAV's.)
    """
    with av.open(path) as c:
        s = c.streams.video[0]
        keys = [p.pts for p in c.demux(s) if p.is_keyframe and p.pts is not None]
    with av.open(path) as c:
        first = next(c.decode(video=0))
        rotation = int(-getattr(first, "rotation", 0)) % 360
        return sorted(keys), float(c.streams.video[0].time_base), rotation


def upright_gray(frame, rotation):
    g = frame.to_ndarray(format="gray")
    return cv2.rotate(g, ROTATE_CW[rotation]) if rotation in ROTATE_CW else g


def decode_range(container, start_pts, end_pts):
    s = container.streams.video[0]
    container.seek(start_pts, stream=s, backward=True, any_frame=False)
    for f in container.decode(s):
        if f.pts is None or f.pts < start_pts:
            continue
        if end_pts is not None and f.pts >= end_pts:
            break
        yield f


def run_chunk(args):
    """Pose and shaft scores for frames with start_pts <= pts < end_pts.

    Returns ([(t seconds, landmarks | None, world landmarks | None, shaft scores | None,
    clubhead | None)], timing).
    World landmarks are MediaPipe's 3D estimate: metres, origin between the hips, z away from the
    camera. With a body model (`body` = (backend name, .onnx path)), its points replace MediaPipe's
    2D landmarks where it has them, the shaft scores included. With a club model (`clubm`, its .onnx
    path) the shaft scores come from it, and the clubhead with them. timing: {frames, mediapipe, body,
    club} in seconds spent.
    """
    cv2.setNumThreads(1)
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions
    from mediapipe.tasks.python.vision import PoseLandmarker, PoseLandmarkerOptions, RunningMode

    path, start_pts, end_pts, rotation, bg, body, clubm = args
    tracker = models.BodyTracker(models.load(*body)) if body else None
    clubber = models.ClubRunner(clubm) if clubm else None
    timing = {"frames": 0, "mediapipe": 0.0, "body": 0.0, "club": 0.0}
    lm = PoseLandmarker.create_from_options(PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=MODEL), running_mode=RunningMode.VIDEO, num_poses=1,
        output_segmentation_masks=True))
    out = []
    try:
        with av.open(path) as c:
            tb = float(c.streams.video[0].time_base)
            for f in decode_range(c, start_pts, end_pts):
                full = cv2.cvtColor(f.to_ndarray(format="yuv420p"), cv2.COLOR_YUV2RGB_I420)
                rgb = cv2.resize(full, None, fx=SCALE, fy=SCALE, interpolation=cv2.INTER_AREA)
                if rotation in ROTATE_CW:
                    rgb = cv2.rotate(rgb, ROTATE_CW[rotation])
                    if tracker is not None or clubber is not None:
                        full = cv2.rotate(full, ROTATE_CW[rotation])
                t = f.pts * tb
                started = time.perf_counter()
                res = lm.detect_for_video(
                    mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)),
                    int(round(t * 1000)))
                timing["frames"] += 1
                timing["mediapipe"] += time.perf_counter() - started
                landmarks = world = shaft = head = None
                if res.pose_landmarks:
                    landmarks = [(p.x, p.y, p.visibility) for p in res.pose_landmarks[0]]
                    if tracker is not None:
                        # The full-size picture: the half size is plenty for MediaPipe's 256px input,
                        # but the crop around the golfer would lose the hands' detail.
                        started = time.perf_counter()
                        landmarks = tracker.frame(full, landmarks)
                        timing["body"] += time.perf_counter() - started
                    if res.pose_world_landmarks:
                        world = [(p.x, p.y, p.z) for p in res.pose_world_landmarks[0]]
                    if clubber is not None:
                        started = time.perf_counter()
                        found = clubber.find(full, landmarks)
                        shaft = club.model_scores(found, landmarks, full.shape[1], full.shape[0])
                        head = club.clubhead(found)
                        timing["club"] += time.perf_counter() - started
                    elif bg is not None and res.segmentation_masks:
                        shaft = shaft_scores(f, rotation, landmarks, res.segmentation_masks[0].numpy_view(), bg)
                elif tracker is not None:
                    tracker.frame(full, None)            # lost: the next crop comes from MediaPipe
                out.append((t, landmarks, world, shaft, head))
    finally:
        lm.close()
    return out, timing


def shaft_scores(frame, rotation, landmarks, person, bg):
    """club.scores for one frame: full-size upright picture, with the person mask grown a little so
    the golfer's outline doesn't count either."""
    img = frame.to_ndarray(format="bgr24")
    if rotation in ROTATE_CW:
        img = cv2.rotate(img, ROTATE_CW[rotation])
    h, w = img.shape[:2]
    # Grown by 6% of the golfer's height: at 3% the edge of a leg (dark trousers on a dark mat) still
    # showed past the mask and passed for the shaft down the line.
    grow = max(3, int(0.06 * club.body_height(landmarks, h)))
    mask = cv2.resize((person > 0.5).astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST)
    mask = cv2.dilate(mask, np.ones((grow, grow), np.uint8)) > 0
    return club.scores(img, landmarks, mask, bg)


def smooth(times, landmarks, spatial=2):
    """Landmarks with jitter taken out: a running median, then a local quadratic fit in time.

    A quadratic follows the hands through impact without cutting the corner, where a plain average
    would drag them behind. Frames without a person are left out and stay None. The first `spatial`
    values of each point are positions and get the curve fit; any after that (visibility) just the
    median.
    """
    have = [i for i, lm in enumerate(landmarks) if lm is not None]
    if len(have) < MEDIAN_FRAMES:
        return landmarks
    t = np.array([times[i] for i in have])
    x = np.array([landmarks[i] for i in have], dtype=float)          # (n, 33, 3)
    half = MEDIAN_FRAMES // 2
    padded = np.concatenate([x[:1].repeat(half, 0), x, x[-1:].repeat(half, 0)])
    med = np.median(np.stack([padded[k:k + len(x)] for k in range(MEDIAN_FRAMES)]), axis=0)
    flat = med.reshape(len(x), -1)
    out = np.empty_like(flat)
    lo = hi = 0
    for i, ti in enumerate(t):
        while t[lo] < ti - SMOOTH_SECONDS:
            lo += 1
        while hi + 1 < len(t) and t[hi + 1] <= ti + SMOOTH_SECONDS:
            hi += 1
        dt = t[lo:hi + 1] - ti
        if len(dt) < 4:
            out[i] = flat[i]
            continue
        w = (1 - (np.abs(dt) / (SMOOTH_SECONDS * 1.001)) ** 3) ** 3            # tricube weights
        a = np.stack([np.ones_like(dt), dt, dt * dt], axis=1) * np.sqrt(w)[:, None]
        coef, *_ = np.linalg.lstsq(a, flat[lo:hi + 1] * np.sqrt(w)[:, None], rcond=None)
        out[i] = coef[0]
    out = out.reshape(x.shape)
    out[..., spatial:] = med[..., spatial:]
    result = list(landmarks)
    for k, i in enumerate(have):
        result[i] = out[k]
    return result


def frame_at(path, rotation, t):
    """The upright grayscale frame on screen at time t (s)."""
    with av.open(path) as c:
        s = c.streams.video[0]
        tb = float(s.time_base)
        c.seek(int(t / tb), stream=s, backward=True)
        got = None
        for f in c.decode(s):
            if got is not None and f.pts * tb > t + 1e-6:
                break
            got = f
        return upright_gray(got, rotation)


def top_of_backswing(frames):
    """When the hands are highest before their fastest moment (the downswing), or None."""
    speed = hand_speed(frames)
    if speed is None:
        return None
    peak = speed[0][int(np.argmax(speed[1]))]
    rows = [(t, (lm[15][1] + lm[16][1]) / 2) for t, lm, *_ in frames if lm is not None and t < peak]
    return min(rows, key=lambda r: r[1])[0] if rows else None


def ball_candidates(path, rotation, frames, first, angle=None):
    """Places near the feet that look like a ball in frame `first` and are gone at the end: the size
    of a ball for the golfer's size, where a ball sits for the camera's angle.

    Returns [(cx, cy, r)] in upright full-size pixels, best first.
    """
    lm = next((lm for _, lm, *_ in frames if lm is not None), None)
    if lm is None:
        return []
    with av.open(path) as c:
        s = c.streams.video[0]
        if s.duration:
            c.seek(int(s.duration * 0.9), stream=s, backward=True)
        last = None
        for f in c.decode(s):
            last = f
        last = upright_gray(last, rotation)
    h, w = first.shape
    feet = [(lm[i][0] * w, lm[i][1] * h) for i in FEET]
    foot_y = max(y for _, y in feet)
    height = foot_y - lm[NOSE][1] * h                  # nose to feet, in pixels
    if height <= 0:
        return []
    x0 = int(max(0, min(x for x, _ in feet) - 0.6 * height))
    x1 = int(min(w, max(x for x, _ in feet) + 0.6 * height))
    y0 = int(max(0, foot_y - 0.3 * height))
    y1 = int(min(h, foot_y + 0.6 * height))
    region = cv2.GaussianBlur(first[y0:y1, x0:x1], (5, 5), 1.2)
    # Circles looked for broadly (a ball is ~43 mm against ~1.6 m nose to feet, nearer or farther
    # than the golfer), then kept only at a ball's size and where a ball sits for this angle: the
    # search itself stays as it was, so the circles it finds don't shift.
    r_min, r_max = max(3, int(0.006 * height)), max(6, int(0.04 * height))
    rows = BALL_ROWS.get(angle, BALL_ROWS[None])
    circles = cv2.HoughCircles(region, cv2.HOUGH_GRADIENT, dp=1, minDist=r_min * 2, param1=80, param2=14,
                               minRadius=r_min, maxRadius=r_max)
    if circles is None:
        return []
    scored = []
    for cx, cy, r in circles[0]:
        cx, cy = cx + x0, cy + y0
        if not (BALL_RADIUS[0] <= r / height <= BALL_RADIUS[1] and rows[0] <= (cy - foot_y) / height <= rows[1]):
            continue
        k = int(r * 2.1) + 1
        if cx - k < 0 or cy - k < 0 or cx + k >= w or cy + k >= h:
            continue
        yy, xx = np.mgrid[-k:k + 1, -k:k + 1]
        d = np.hypot(xx, yy)
        a = first[int(cy) - k:int(cy) + k + 1, int(cx) - k:int(cx) + k + 1].astype(float)
        b = last[int(cy) - k:int(cy) + k + 1, int(cx) - k:int(cx) + k + 1].astype(float)
        inner, ring = d <= r * 0.8, (d > r * 1.3) & (d < r * 2)
        bright = a[inner].mean() - a[ring].mean()      # a white ball stands out from the mat
        gone = np.abs(a[inner] - b[inner]).mean()      # and isn't there after the shot
        if bright > 10 and gone > 10:
            scored.append((bright * gone, (float(cx), float(cy), float(r))))
    scored.sort(key=lambda s: -s[0])
    return [c for _, c in scored[:BALL_CANDIDATES]]


def ball_patch(gray, c):
    cx, cy, r = c
    k = int(r * 1.4)
    return gray[int(cy) - k:int(cy) + k + 1, int(cx) - k:int(cx) + k + 1].astype(np.float32)


def ncc(a, b):
    a = a - a.mean()
    b = b - b.mean()
    return float((a * b).sum() / np.sqrt((a * a).sum() * (b * b).sum() + 1e-9))


def run_ball_chunk(args):
    """For each frame in the range: how closely each candidate spot matches how it first looked."""
    cv2.setNumThreads(1)
    path, start_pts, end_pts, rotation, candidates, refs = args
    out = []
    with av.open(path) as c:
        tb = float(c.streams.video[0].time_base)
        for f in decode_range(c, start_pts, end_pts):
            g = upright_gray(f, rotation)
            out.append((f.pts * tb, [ncc(ball_patch(g, cand), ref) for cand, ref in zip(candidates, refs)]))
    return out


def ball_leaves(times, scores):
    """When the ball goes: the spot looks the same for a while, then suddenly not at all.

    At address the club sits against the ball, so the spot changes a little in the takeaway; what
    counts is the drop from wherever it settled to nothing. Returns (index of the first frame
    without the ball, strength of the drop), or None.
    """
    t = np.asarray(times)
    s = np.asarray(scores)
    best = None
    for i in range(1, len(s) - 1):
        before = s[np.searchsorted(t, t[i] - BALL_STEP_SECONDS):i]
        after = s[i:np.searchsorted(t, t[i] + BALL_STEP_SECONDS)]
        drop = np.median(before) - np.median(after)
        if best is None or drop > best[0]:
            best = (drop, i, np.median(before))
    if best is None:
        return None
    drop, i, level = best
    # A clean step, and the ball stays gone (a second's worth of frames after never look like it).
    rest = s[i:]
    if level < 0.3 or drop < 0.25 or np.percentile(rest, 90) > level / 2:
        return None
    # Pin it to the frame: the first one after the last that still looks like the settled ball.
    lo = np.searchsorted(t, t[i] - BALL_STEP_SECONDS)
    hi = np.searchsorted(t, t[i] + BALL_STEP_SECONDS)
    still = [j for j in range(lo, hi) if s[j] >= level / 2]
    first_gone = still[-1] + 1 if still else i
    return (first_gone, drop) if first_gone < len(s) else None


def hand_speed(frames):
    """(times, speed of the point between the wrists) for frames with a person, or None."""
    rows = [(t, (lm[15][0] + lm[16][0]) / 2, (lm[15][1] + lm[16][1]) / 2) for t, lm, *_ in frames if lm is not None]
    if len(rows) < 10:
        return None
    t, x, y = (np.array(v) for v in zip(*rows))
    # Over ~1/30 s: at 240 fps, frame-to-frame wrist movement is mostly tracking jitter.
    a = np.searchsorted(t, t - 1 / 60)
    b = np.clip(np.searchsorted(t, t + 1 / 60, side="right") - 1, 0, len(t) - 1)
    dt = np.maximum(t[b] - t[a], 1e-6)
    return t, np.hypot(x[b] - x[a], y[b] - y[a]) / dt


def find_impact(path, rotation, frames, jobs, pool):
    """The ball's spot and the time of the first frame it's gone from, or (None, None).

    The ball is looked for at the start of the clip (address) and, failing that, at the top of the
    backswing: from down the line the clubhead sits between the camera and the ball at address.
    The clip's name gives the camera's angle (where to look) and when the phone heard the strike
    (when the ball can have gone).
    """
    angle, strike = clip_facts(path)
    with av.open(path) as c:
        first = upright_gray(next(c.decode(video=0)), rotation)
    found = find_impact_from(path, rotation, frames, jobs, pool, first, angle, strike)
    top = top_of_backswing(frames)
    if found[1] is None and top is not None:
        found = find_impact_from(path, rotation, frames, jobs, pool, frame_at(path, rotation, top), angle, strike)
    return found


def find_impact_from(path, rotation, frames, jobs, pool, first, angle=None, strike=None):
    """find_impact, with the ball looked for in the frame `first`."""
    candidates = ball_candidates(path, rotation, frames, first, angle)
    if not candidates:
        return None, None
    refs = [ball_patch(first, cand) for cand in candidates]
    rows = sorted((r for chunk in pool.map(run_ball_chunk, [j + (candidates, refs) for j in jobs]) for r in chunk),
                  key=lambda r: r[0])
    times = [r[0] for r in rows]
    speed = hand_speed(frames)
    best = None
    for k, cand in enumerate(candidates):
        found = ball_leaves(times, [r[1][k] for r in rows])
        # Something else near the feet can change for good too (a leg, a shadow); the ball leaves
        # while the hands are moving fast.
        if found and speed is not None:
            near = np.abs(speed[0] - times[found[0]]) <= HANDS_WINDOW_SECONDS
            if not near.any() or speed[1][near].max() < HANDS_AT_IMPACT * speed[1].max():
                found = None
        # And it leaves just before the phone hears the strike, never well before or after it.
        if found and strike is not None and not (STRIKE_WINDOW[0] <= times[found[0]] - strike <= STRIKE_WINDOW[1]):
            found = None
        if found and (best is None or found[1] > best[1]):
            best = (found[0], found[1], cand)
    if best is None:
        return None, None
    h, w = first.shape
    cx, cy, r = best[2]
    return {"x": round(cx / w, 4), "y": round(cy / h, 4), "r": round(r / h, 4)}, round(times[best[0]], 6)


def analyze(path, pool: ProcessPoolExecutor, workers: int):
    """Pose for every frame of the clip, plus the ball, impact and club shaft, as a JSON-ready dict."""
    started = time.perf_counter()
    backend = models.backend()
    body = None
    if backend != models.DEFAULT:
        body = (backend, str(models.model_path(backend)))
        if not os.path.isfile(body[1]):
            raise FileNotFoundError(f"{body[1]} is missing: run fetch_models.py first")
    clubm = None
    if models.club_backend() != models.CLUB_DEFAULT:
        clubm = str(models.club_model_path())
        if not os.path.isfile(clubm):
            raise FileNotFoundError(f"{clubm} is missing: train it (HOME-SETUP.md, \"Training the club model\") "
                                    "or point SWINGCLIPS_CLUB_MODEL at it")
    keys, _, rotation = probe(path)
    bg = club.background(path, rotation, ROTATE_CW)
    if not keys:
        keys = [0]
    groups = np.array_split(np.arange(len(keys)), min(workers, len(keys)))
    jobs = []
    for g in groups:
        start = keys[g[0]]
        end = keys[g[-1] + 1] if g[-1] + 1 < len(keys) else None
        jobs.append((path, start, end, rotation))
    chunks = list(pool.map(run_chunk, [j + (bg, body, clubm) for j in jobs]))
    frames = sorted((fr for chunk, _ in chunks for fr in chunk), key=lambda fr: fr[0])
    ms = per_frame_ms([timing for _, timing in chunks])
    print(f"pose: {os.path.basename(path)}: {len(frames)} frames, MediaPipe {ms['mediapipe']:.1f} ms/frame"
          + (f", {models.stamp(backend)} {ms['body']:.1f} ms/frame" if body else "")
          + (f", club model {ms['club']:.1f} ms/frame" if clubm else "")
          + f" (in each of {len(jobs)} worker(s))", flush=True)
    ball, impact = find_impact(path, rotation, frames, jobs, pool)
    times = [t for t, *_ in frames]
    smoothed = smooth(times, [lm for _, lm, *_ in frames])
    world = smooth(times, [w for _, _, w, *_ in frames], spatial=3)
    shaft = club.track(times, [s for _, _, _, s, _ in frames])
    first = next((lm for lm in smoothed if lm is not None), None)
    h, w = (bg.shape[:2] if bg is not None else (1, 1))
    out = {
        "version": VERSION,
        "ballVersion": BALL_VERSION,
        "rotation": rotation,
        "seconds": round(time.perf_counter() - started, 2),
        "ball": ball,
        "impact": impact,
        # Shaft length to draw, as a share of the picture height.
        "clubLength": club.length(first, ball, w, h) if first is not None else None,
        # lm: flat [x, y, visibility] * 33 per frame, rounded to keep the JSON small.
        # w: flat [x, y, z] * 33 in metres (MediaPipe's 3D estimate; origin between the hips, x to the
        # picture's right, y down, z away from the camera).
        # club: [shaft angle in degrees (0 = right, 90 = down), confidence 0-1] or null.
        "frames": [{"t": round(t, 6), "lm": None if lm is None else [round(float(v), 4) for p in lm for v in p],
                    "w": None if w is None else [round(float(v), 3) for p in w for v in p],
                    "club": list(c) if c else None}
                   for t, lm, w, c in zip(times, smoothed, world, shaft)],
    }
    if clubm:
        # clubhead: [x, y, confidence 0-1] in picture units where the club model is sure of it, else
        # null. Straight from the model, per frame: not smoothed or tracked (the shaft angle is).
        for fr, (*_, head) in zip(out["frames"], frames):
            fr["clubhead"] = head
    if body or clubm:
        # Which models placed the 2D landmarks and the club, and their cost; the defaults' output
        # has none of it.
        stamps = {"model": models.stamp(backend)} if body else {}
        if clubm:
            stamps["clubModel"] = models.club_stamp(clubm)
        cost = {"mediapipe": round(ms["mediapipe"], 1)}
        if body:
            cost["body"] = round(ms["body"], 1)
        if clubm:
            cost["club"] = round(ms["club"], 1)
        out = {"version": VERSION, **stamps, "msPerFrame": cost, **out}
    return out


def ball_fits(path, doc) -> bool:
    """Whether a saved result's ball passes the current ball search's checks: left in the window
    around the heard strike, a ball's size, where a ball sits for the camera's angle."""
    ball, impact = doc.get("ball"), doc.get("impact")
    lm = next((f["lm"] for f in doc.get("frames") or [] if f.get("lm")), None)
    if not ball or impact is None or not lm:
        return False
    angle, strike = clip_facts(path)
    foot_y = max(lm[i * 3 + 1] for i in FEET)
    height = foot_y - lm[NOSE * 3 + 1]
    if height <= 0:
        return False
    rows = BALL_ROWS.get(angle, BALL_ROWS[None])
    return ((strike is None or STRIKE_WINDOW[0] <= impact - strike <= STRIKE_WINDOW[1])
            and BALL_RADIUS[0] <= ball["r"] / height <= BALL_RADIUS[1]
            and rows[0] <= (ball["y"] - foot_y) / height <= rows[1])


def find_ball_again(path, doc, pool: ProcessPoolExecutor, workers: int) -> dict:
    """A saved pose result checked by the current ball search, for when only the ball search
    changed. A ball that passes its checks is kept as it was; otherwise (or with no ball) it's found
    again, from the saved (smoothed) landmarks, with the shaft length drawn from it: a few seconds
    a clip instead of a whole analysis."""
    if ball_fits(path, doc):
        out = {}
        for k, v in doc.items():
            out[k] = v
            if k == "version":
                out["ballVersion"] = BALL_VERSION
        out["ballVersion"] = BALL_VERSION
        return out
    keys, _, rotation = probe(path)
    if not keys:
        keys = [0]
    groups = np.array_split(np.arange(len(keys)), min(workers, len(keys)))
    jobs = []
    for g in groups:
        start = keys[g[0]]
        end = keys[g[-1] + 1] if g[-1] + 1 < len(keys) else None
        jobs.append((path, start, end, rotation))
    frames = [(f["t"], None if f["lm"] is None else [tuple(f["lm"][i:i + 3]) for i in range(0, len(f["lm"]), 3)],
               None, None, None) for f in doc["frames"]]
    ball, impact = find_impact(path, rotation, frames, jobs, pool)
    first = next((lm for _, lm, *_ in frames if lm is not None), None)
    with av.open(path) as c:
        g = upright_gray(next(c.decode(video=0)), rotation)
    h, w = g.shape[:2]
    out = {}
    for k, v in doc.items():
        out[k] = v
        if k == "version":
            out["ballVersion"] = BALL_VERSION
    out.update(ballVersion=BALL_VERSION, ball=ball, impact=impact,
               clubLength=club.length(first, ball, w, h) if first is not None else doc.get("clubLength"))
    return out


def per_frame_ms(timings):
    """Milliseconds per frame spent in MediaPipe, the body model and the club model, over every
    worker's frames."""
    n = max(1, sum(t["frames"] for t in timings))
    return {k: 1000 * sum(t[k] for t in timings) / n for k in ("mediapipe", "body", "club")}
