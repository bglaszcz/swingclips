"""Pose for whole clips: MediaPipe on every frame, split across worker processes at keyframes.

Grew out of a timing benchmark (posebench/bench2.py, since removed; see git history). Frames keep
their real timestamps, because high-fps phone clips have dropped frames and index / fps would drift.

Also finds the ball on the mat and the frame it leaves, which pins impact to the frame, and the
club shaft's angle in each frame (club.py).
"""
import os
import time
from concurrent.futures import ProcessPoolExecutor

import av
import cv2
import numpy as np

import club

# MediaPipe's "full" model. "heavy" was tried (2026-09): slower, and at the top of the backswing it
# put the trail wrist beside the head, where "full" stays on the hands. SWINGCLIPS_POSE_MODEL can point
# at another .task file to compare.
MODEL = os.environ.get("SWINGCLIPS_POSE_MODEL", os.path.join(
    os.path.dirname(__file__), "..", "public", "mediapipe", "pose_landmarker_full.task"))
VERSION = 3
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
# while the hands are slower than this share of their peak isn't the ball.
HANDS_AT_IMPACT = 0.2


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

    Returns [(t seconds, landmarks | None, shaft scores | None)].
    """
    cv2.setNumThreads(1)
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions
    from mediapipe.tasks.python.vision import PoseLandmarker, PoseLandmarkerOptions, RunningMode

    path, start_pts, end_pts, rotation, bg = args
    lm = PoseLandmarker.create_from_options(PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=MODEL), running_mode=RunningMode.VIDEO, num_poses=1,
        output_segmentation_masks=True))
    out = []
    try:
        with av.open(path) as c:
            tb = float(c.streams.video[0].time_base)
            for f in decode_range(c, start_pts, end_pts):
                rgb = cv2.cvtColor(f.to_ndarray(format="yuv420p"), cv2.COLOR_YUV2RGB_I420)
                rgb = cv2.resize(rgb, None, fx=SCALE, fy=SCALE, interpolation=cv2.INTER_AREA)
                if rotation in ROTATE_CW:
                    rgb = cv2.rotate(rgb, ROTATE_CW[rotation])
                t = f.pts * tb
                res = lm.detect_for_video(
                    mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)),
                    int(round(t * 1000)))
                landmarks = shaft = None
                if res.pose_landmarks:
                    landmarks = [(p.x, p.y, p.visibility) for p in res.pose_landmarks[0]]
                    if bg is not None and res.segmentation_masks:
                        shaft = shaft_scores(f, rotation, landmarks, res.segmentation_masks[0].numpy_view(), bg)
                out.append((t, landmarks, shaft))
    finally:
        lm.close()
    return out


def shaft_scores(frame, rotation, landmarks, person, bg):
    """club.scores for one frame: full-size upright picture, with the person mask grown a little so
    the golfer's outline doesn't count either."""
    img = frame.to_ndarray(format="bgr24")
    if rotation in ROTATE_CW:
        img = cv2.rotate(img, ROTATE_CW[rotation])
    h, w = img.shape[:2]
    grow = max(3, int(0.03 * club.body_height(landmarks, h)))
    mask = cv2.resize((person > 0.5).astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST)
    mask = cv2.dilate(mask, np.ones((grow, grow), np.uint8)) > 0
    return club.scores(img, landmarks, mask, bg)


def smooth(times, landmarks):
    """Landmarks with jitter taken out: a running median, then a local quadratic fit in time.

    A quadratic follows the hands through impact without cutting the corner, where a plain average
    would drag them behind. Frames without a person are left out and stay None.
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
    out[..., 2] = med[..., 2]                          # visibility: no curve, just the median
    result = list(landmarks)
    for k, i in enumerate(have):
        result[i] = out[k]
    return result


def ball_candidates(path, rotation, frames):
    """Places near the feet that look like a ball at the start of the clip and are gone at the end.

    Returns [(cx, cy, r)] in upright full-size pixels, best first.
    """
    lm = next((lm for _, lm, *_ in frames if lm is not None), None)
    if lm is None:
        return []
    with av.open(path) as c:
        first = upright_gray(next(c.decode(video=0)), rotation)
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
    y1 = int(min(h, foot_y + 0.5 * height))
    region = cv2.GaussianBlur(first[y0:y1, x0:x1], (5, 5), 1.2)
    # A ball is ~43 mm against ~1.6 m nose to feet; allow for it being nearer or farther than the golfer.
    r_min, r_max = max(3, int(0.006 * height)), max(6, int(0.04 * height))
    circles = cv2.HoughCircles(region, cv2.HOUGH_GRADIENT, dp=1, minDist=r_min * 2, param1=80, param2=14,
                               minRadius=r_min, maxRadius=r_max)
    if circles is None:
        return []
    scored = []
    for cx, cy, r in circles[0]:
        cx, cy = cx + x0, cy + y0
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
    """The ball's spot and the time of the first frame it's gone from, or (None, None)."""
    candidates = ball_candidates(path, rotation, frames)
    if not candidates:
        return None, None
    with av.open(path) as c:
        first = upright_gray(next(c.decode(video=0)), rotation)
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
            at = int(np.argmin(np.abs(speed[0] - times[found[0]])))
            if speed[1][at] < HANDS_AT_IMPACT * speed[1].max():
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
    frames = sorted((fr for chunk in pool.map(run_chunk, [j + (bg,) for j in jobs]) for fr in chunk),
                    key=lambda fr: fr[0])
    ball, impact = find_impact(path, rotation, frames, jobs, pool)
    times = [t for t, *_ in frames]
    smoothed = smooth(times, [lm for _, lm, _ in frames])
    shaft = club.track(times, [s for *_, s in frames])
    first = next((lm for lm in smoothed if lm is not None), None)
    h, w = (bg.shape[:2] if bg is not None else (1, 1))
    return {
        "version": VERSION,
        "rotation": rotation,
        "seconds": round(time.perf_counter() - started, 2),
        "ball": ball,
        "impact": impact,
        # Shaft length to draw, as a share of the picture height.
        "clubLength": club.length(first, ball, w, h) if first is not None else None,
        # lm: flat [x, y, visibility] * 33 per frame, rounded to keep the JSON small.
        # club: [shaft angle in degrees (0 = right, 90 = down), confidence 0-1] or null.
        "frames": [{"t": round(t, 6), "lm": None if lm is None else [round(float(v), 4) for p in lm for v in p],
                    "club": list(c) if c else None}
                   for t, lm, c in zip(times, smoothed, shaft)],
    }
