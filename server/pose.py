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

Keeping up during a session (a swing, two clips, every ~20 s): the settings under "Keeping up"
below trade work for time. speed_settings() lists the ones that can change the result, for eval.py's
cache fingerprint; SPEED_AS_BEFORE sets them all back to how clips were analyzed before them.
"""
import os
from pathlib import Path
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
BALL_VERSION = 3
# Saved results from a ball search older than this have the impact timed again, not just checked
# (3: face-on counts the ball as gone once it starts to move, BALL_STILL).
BALL_TIMING_VERSION = 3
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
# A frame still shows the ball while its spot matches at least this share of how well it matched
# while settled; below that the ball has started to leave. Face-on the ball's first frame on the move
# (a streak starting at its spot) still matches 0.66-0.97, while a sitting ball stays at ~1.0: 0.85
# puts 15 of 17 labeled face-on swings on the labeled frame and none early (0.5 had 7 a frame or
# more late, one 21 ms: dropped frames after the streak). Down the line the club passes between the
# camera and the ball just before contact, so anything above 0.5 goes early there (by up to 21 ms).
BALL_STILL = {"face": 0.85, "dtl": 0.5, None: 0.5}
# The hands peak in the follow-through, at impact they are at ~40% of that or more; anything "leaving"
# while the hands are slower than this share of their peak isn't the ball. Down the line the hands
# move mostly away from the camera right at impact and look nearly still, so it's their fastest
# within HANDS_WINDOW_SECONDS either side.
# The body model (RTMPose) is the slowest part of a clip (~40 ms a frame against MediaPipe's ~17). At
# 240 fps it runs on every BODY_STRIDE-th frame, with the frames between filled in from their
# neighbours (4 ms apart; the smoothing spans +-20 ms anyway), and only up to BODY_AFTER_STRIKE s
# after the heard strike: no number is measured later in the follow-through. MediaPipe still runs
# on every frame. SWINGCLIPS_BODY_STRIDE=1 runs it on every frame. On a GPU (SWINGCLIPS_ORT_PROVIDER,
# models.py) it's no longer the slow part, so there every frame is the default (body_stride()).
BODY_STRIDE = max(1, int(os.environ["SWINGCLIPS_BODY_STRIDE"])) if os.environ.get("SWINGCLIPS_BODY_STRIDE") else None
BODY_STRIDE_CPU, BODY_STRIDE_GPU = 2, 1
BODY_AFTER_STRIKE = 0.9
# The ball search looks this far either side of the heard strike (the whole clip without one).
BALL_SEARCH_SECONDS = 0.6
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


def body_stride() -> int:
    """How often the body model runs: SWINGCLIPS_BODY_STRIDE, else every other frame on the CPU and
    every frame on a GPU."""
    if BODY_STRIDE is not None:
        return BODY_STRIDE
    return BODY_STRIDE_GPU if models.on_gpu() else BODY_STRIDE_CPU


# ---- Keeping up: settings that trade work for time (HOME-SETUP.md, "Keeping up during a session") ----
# Read each time (tests set them), in the main process: the workers get them with their jobs.
#
# SWINGCLIPS_MP_STRIDE_AFTER: MediaPipe on every n-th frame after the swing (later than
# BODY_AFTER_STRIKE after the heard strike: ~1.1 s of a 4 s capture clip), the frames between filled
# in from their neighbours. Nothing is measured there (P8 comes at most ~0.35 s after the strike); the
# review page still draws the skeleton on every frame. 1 = every frame, as before.
MP_STRIDE_AFTER = 4
# SWINGCLIPS_FRAME_CONVERT: how MediaPipe's half-size picture is made from the decoded frame.
#   planes: straight from the decoded YUV planes (the brightness averaged 2x2, the colour as coded,
#           which 4:2:0 already has at half size), then to RGB. ~2.5x less work; within ~1 level of
#           full's (rounding, and clipping in the brightest colours).
#   full:   the whole 1080p frame to RGB, then halved (as before). The body model's crop is made from
#           the full-size picture either way, converted only on the frames it runs on.
# full is the default: on the 37 labeled clips (bench_models.py --accuracy) planes moved the joints
# 1.1 px (median) and the takeaway and face-on P4 by 4-8 ms; with full, everything else as set now
# was within a frame.
FRAME_CONVERTS = ("full", "planes")
# SWINGCLIPS_POSE_SPLIT: where the clip is cut between the workers.
#   cost:   so each worker gets about the same work, by what each frame costs (COST_MS), cut only
#           at keyframes.
#   frames: the same, cut at any frame: a worker starting between keyframes decodes from the
#           keyframe before and drops the frames up to its start (their decoding counted in its
#           cost). The phones put a keyframe every 0.25 s, ~6 s of work in the swing, so cost leaves
#           workers idle up to 40% of the clip (8 workers busy 6.3-10.8 s); frames evens them out
#           (9.7-10.1 s) but the dropped frames' decoding eats most of it: 12.6 -> 11.9 s a clip on
#           the dev PC, and nothing with the quick pass (9.1 vs 9.3 s). Try it with the benchmark.
#   even:   the same number of keyframes each (as before).
# Frames after the swing cost little (MediaPipe only, and only every MP_STRIDE_AFTER-th), so an even
# split left the last worker idle while the others were still in the downswing.
POSE_SPLITS = ("cost", "frames", "even")
# What a frame costs, roughly (ms in one worker on the i5-12400, bench_models.py 2026-09-27; only
# the proportions matter). mediapipe includes making its picture (convert, ~9 ms).
COST_MS = {"decode": 9, "mediapipe": 30, "shaft": 20, "body": 50, "club": 50}
# SWINGCLIPS_SHAFT_STRIDE: the club shaft searched on every n-th frame of the swing, with club.track
# filling the frames between as it does blurred ones. 1 (every frame) is the default.
# SWINGCLIPS_DECODE_THREADS: threads FFmpeg decodes each worker's frames with (frame and slice
# threading); unset, FFmpeg's own choice (as before). Doesn't change the result: decoding is exact.
# The result-changing settings as clips were analyzed before them: as set in the environment, and
# as speed_settings() gives them.
SPEED_AS_BEFORE = {"SWINGCLIPS_MP_STRIDE_AFTER": "1", "SWINGCLIPS_FRAME_CONVERT": "full",
                   "SWINGCLIPS_POSE_SPLIT": "even", "SWINGCLIPS_SHAFT_STRIDE": "1"}
BEFORE = {"mpStrideAfter": 1, "convert": "full", "split": "even", "shaftStride": 1}


def _setting(name, default):
    return os.environ.get(name, "").strip().lower() or default


def _count(name, default):
    value = _setting(name, str(default))
    if not value.isdigit() or int(value) < 1:
        raise ValueError(f"{name}={value!r}: use a whole number, 1 or more")
    return int(value)


def mp_stride_after() -> int:
    return _count("SWINGCLIPS_MP_STRIDE_AFTER", MP_STRIDE_AFTER)


def frame_convert() -> str:
    value = _setting("SWINGCLIPS_FRAME_CONVERT", FRAME_CONVERTS[0])
    if value not in FRAME_CONVERTS:
        raise ValueError(f"SWINGCLIPS_FRAME_CONVERT={value!r}: use one of {', '.join(FRAME_CONVERTS)}")
    return value


def pose_split() -> str:
    value = _setting("SWINGCLIPS_POSE_SPLIT", POSE_SPLITS[0])
    if value not in POSE_SPLITS:
        raise ValueError(f"SWINGCLIPS_POSE_SPLIT={value!r}: use one of {', '.join(POSE_SPLITS)}")
    return value


def shaft_stride() -> int:
    return _count("SWINGCLIPS_SHAFT_STRIDE", 1)


def decode_threads() -> int | None:
    """SWINGCLIPS_DECODE_THREADS, or None for FFmpeg's own choice."""
    return _count("SWINGCLIPS_DECODE_THREADS", 1) if _setting("SWINGCLIPS_DECODE_THREADS", "") else None


def speed_settings() -> dict:
    """The settings above that can change the result, as they are now: for eval.py's cache
    fingerprint, and saved in the pose file when any differs from SPEED_AS_BEFORE."""
    return {"mpStrideAfter": mp_stride_after(), "convert": frame_convert(), "split": pose_split(),
            "shaftStride": shaft_stride()}


def clip_facts(path):
    """(angle "face" | "dtl" | None, heard strike in clip seconds | None) from a capture-app clip name."""
    m = CLIP_NAME.match(os.path.basename(path))
    if not m:
        return None, None
    return m.group(1), (int(m.group(2)) / 1000 if m.group(2) else None)


def probe(path, every_frame=False):
    """Keyframe pts, time base, and how far to turn frames clockwise to display them upright; with
    `every_frame`, every frame's pts after them (sorted).

    PyAV's frame.rotation is the display matrix angle (counter-clockwise), e.g. -90 for a
    portrait phone clip. (Reading it with OpenCV instead crashes: its FFmpeg DLLs clash with PyAV's.)
    """
    with av.open(path) as c:
        s = c.streams.video[0]
        packets = [(p.pts, p.is_keyframe) for p in c.demux(s) if p.pts is not None]
    keys = sorted(pts for pts, key in packets if key)
    with av.open(path) as c:
        first = next(c.decode(video=0))
        rotation = int(-getattr(first, "rotation", 0)) % 360
        tb = float(c.streams.video[0].time_base)
    if every_frame:
        return keys, tb, rotation, sorted(pts for pts, _ in packets)
    return keys, tb, rotation


def upright_gray(frame, rotation):
    g = frame.to_ndarray(format="gray")
    return cv2.rotate(g, ROTATE_CW[rotation]) if rotation in ROTATE_CW else g


# ---- The clubhead leaving the ball (the takeaway, as the labels mark it) ----
# The box watched: around the ball, CLUBHEAD_BOX ball radii either side and from CLUBHEAD_ROWS[0]
# above its middle to CLUBHEAD_ROWS[1] below: the clubhead behind the ball at address, not the
# shaft above it (which moves a little earlier, with the hands). Each crop is taken to zero mean and
# unit spread, so the lights' 120 Hz flicker doesn't count.
CLUBHEAD_BOX = 6
CLUBHEAD_ROWS = (2, 4)
# Where the change leaves the noise: K spreads over the level 0.2-0.08 s before it crosses half way
# to its peak (the keyframes, every 0.25 s, shift the level over longer stretches).
CLUBHEAD_K = 5
CLUBHEAD_LOCAL = (0.2, 0.08)


def clubhead_crops(path, rotation, ball, t0, t1):
    """[(t, crop)] for frames t0 <= t < t1: the clubhead box, upright gray, normalized. `ball`: the
    pose file's {x, y, r} (shares of the upright picture's width, height, height)."""
    out = []
    with av.open(path) as c:
        s = c.streams.video[0]
        tb = float(s.time_base)
        for f in decode_range(c, int(max(0.0, t0) / tb), int(t1 / tb)):
            g = upright_gray(f, rotation)
            h, w = g.shape
            r = max(ball.get("r") or 0.0, 0.004) * h
            cx, cy = ball["x"] * w, ball["y"] * h
            x0, x1 = int(max(0, cx - CLUBHEAD_BOX * r)), int(min(w, cx + CLUBHEAD_BOX * r))
            y0, y1 = int(max(0, cy - CLUBHEAD_ROWS[0] * r)), int(min(h, cy + CLUBHEAD_ROWS[1] * r))
            crop = g[y0:y1, x0:x1].astype(np.float32)
            crop -= crop.mean()
            out.append((f.pts * tb, crop / (crop.std() + 1e-6)))
    return out


def clubhead_motion(crops, quiet_until):
    """How far the clubhead box is from its look while still (the median of the crops before
    `quiet_until`), per frame, and where that change starts: {"t": [...], "v": [...], "onset": t |
    None}. None when there's no still stretch to compare with."""
    ts = np.array([t for t, _ in crops])
    q = ts < quiet_until
    if q.sum() < 20:
        return None
    cs = np.stack([c for _, c in crops])
    d = np.abs(cs - np.median(cs[q], axis=0)).mean(axis=(1, 2))
    out = {"t": [round(float(t), 6) for t in ts], "v": [round(float(v), 4) for v in d], "onset": None}
    med = np.median(d[q])
    mad = np.median(np.abs(d[q] - med)) * 1.4826 + 1e-6
    if (~q).any() and d[~q].max() - med >= 10 * mad:
        half = med + 0.5 * (d[~q].max() - med)
        after = np.where(~q & (d > half))[0]
        i = int(after[0])
        # Walk back to the level just before; then again from there, since a slow start puts the
        # first bit of the rise in that stretch and lifts the level (until it stops moving).
        found = False
        for _ in range(5):
            loc = (ts > ts[i] - CLUBHEAD_LOCAL[0]) & (ts < ts[i] - CLUBHEAD_LOCAL[1])
            if loc.sum() < 10:
                break
            found = True
            b = np.median(d[loc])
            s = np.median(np.abs(d[loc] - b)) * 1.4826 + 1e-6
            j = i
            while j > 0 and d[j - 1] > b + CLUBHEAD_K * s:
                j -= 1
            if j == i:
                break
            i = j
        if found:
            out["onset"] = round(float(ts[i]), 6)
    return out


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
    path) the shaft scores come from it, and the clubhead with them. `opts` (from analyze) has the
    speed settings: mp_after, convert, shaft_stride, threads.

    timing: seconds spent in each part (start: loading MediaPipe; decode, convert, mediapipe, body,
    club, shaft) and how many frames each ran on (decoded, frames: MediaPipe's, shaft_frames); "ran":
    per frame, whether the body model placed its points; "mp": whether MediaPipe ran (it skips
    frames after the swing, fill_skipped fills them); "last": the clip's last frame, upright gray,
    from the job that reads to the end (the ball search compares with it).
    """
    started = time.perf_counter()
    cv2.setNumThreads(1)
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions
    from mediapipe.tasks.python.vision import PoseLandmarker, PoseLandmarkerOptions, RunningMode

    path, start_pts, end_pts, rotation, bg, body, clubm = args[:7]
    # When the body model stops (clip seconds, or None for the whole clip) and how often it runs.
    body_until, stride = args[7] if len(args) > 7 else (None, 1)
    opts = {**RUN_DEFAULTS, **(args[8] if len(args) > 8 else {})}
    mp_after, shaft_every, mp_swing = opts["mp_after"], opts["shaft_stride"], opts["mp_swing"]
    # With a club model: also the ray-cast shaft (the deep pass, for address and the takeaway), in
    # timing["ray"], one per frame.
    ray_too = bool(clubm) and opts["ray_too"]
    rays = []
    tracker = models.BodyTracker(models.load(*body)) if body else None
    ran = []                                 # per frame: whether the body model placed its points
    mp_ran = []                              # per frame: whether MediaPipe ran
    clubber = models.load_club(clubm) if clubm else None
    timing = {"frames": 0, "decoded": 0, "shaft_frames": 0, "start": 0.0, "decode": 0.0, "convert": 0.0,
              "mediapipe": 0.0, "body": 0.0, "club": 0.0, "shaft": 0.0}
    lm = PoseLandmarker.create_from_options(PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=MODEL), running_mode=RunningMode.VIDEO, num_poses=1,
        output_segmentation_masks=True))
    timing["start"] = time.perf_counter() - started
    out = []
    last = None
    try:
        with av.open(path) as c:
            tb = float(c.streams.video[0].time_base)
            if opts["threads"]:
                cc = c.streams.video[0].codec_context
                cc.thread_type, cc.thread_count = "AUTO", opts["threads"]
            frames = decode_range(c, start_pts, end_pts)
            while True:
                clock = time.perf_counter()
                f = next(frames, None)
                if f is None:
                    break
                last = f
                now = time.perf_counter()
                timing["decode"] += now - clock
                timing["decoded"] += 1
                t = f.pts * tb
                k = len(out)
                in_swing = body_until is None or t <= body_until
                if k % (mp_swing if in_swing else mp_after):
                    # After the swing, MediaPipe only on every mp_after-th frame (and in the quick pass,
                    # every mp_swing-th in it, the shaft search with it): filled in later.
                    out.append((t, None, None, None, None))
                    ran.append(False)
                    mp_ran.append(False)
                    rays.append(None)
                    continue
                clock = now
                yuv = f.to_ndarray(format="yuv420p")
                full = None                  # the full-size picture, upright RGB, made when needed
                if opts["convert"] == "planes":
                    rgb = half_rgb(yuv)
                else:
                    unturned = cv2.cvtColor(yuv, cv2.COLOR_YUV2RGB_I420)
                    rgb = cv2.resize(unturned, None, fx=SCALE, fy=SCALE, interpolation=cv2.INTER_AREA)
                if rotation in ROTATE_CW:
                    rgb = cv2.rotate(rgb, ROTATE_CW[rotation])
                now = time.perf_counter()
                timing["convert"] += now - clock
                res = lm.detect_for_video(
                    mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)),
                    int(round(t * 1000)))
                timing["frames"] += 1
                timing["mediapipe"] += time.perf_counter() - now
                mp_ran.append(True)

                def picture():
                    """The full-size picture, upright RGB (converted once, when a model needs it)."""
                    nonlocal full
                    if full is None:
                        clock = time.perf_counter()
                        full = unturned if opts["convert"] == "full" else cv2.cvtColor(yuv, cv2.COLOR_YUV2RGB_I420)
                        if rotation in ROTATE_CW:
                            full = cv2.rotate(full, ROTATE_CW[rotation])
                        timing["convert"] += time.perf_counter() - clock
                    return full

                landmarks = world = shaft = head = ray = None
                if res.pose_landmarks:
                    landmarks = [(p.x, p.y, p.visibility) for p in res.pose_landmarks[0]]
                    if tracker is not None and in_swing and k % stride == 0:
                        # The full-size picture: the half size is plenty for MediaPipe's 256px input,
                        # but the crop around the golfer would lose the hands' detail.
                        img = picture()
                        clock = time.perf_counter()
                        landmarks = tracker.frame(img, landmarks)
                        timing["body"] += time.perf_counter() - clock
                        ran.append(True)
                    else:
                        ran.append(False)
                    if res.pose_world_landmarks:
                        world = [(p.x, p.y, p.z) for p in res.pose_world_landmarks[0]]
                    if clubber is not None:
                        img = picture()
                        clock = time.perf_counter()
                        found = clubber.find(img, landmarks)
                        shaft = club.model_scores(found, landmarks, img.shape[1], img.shape[0])
                        head = club.clubhead(found)
                        timing["club"] += time.perf_counter() - clock
                        if ray_too and bg is not None and res.segmentation_masks and in_swing:
                            clock = time.perf_counter()
                            ray = shaft_scores(f, rotation, landmarks, res.segmentation_masks[0].numpy_view(), bg)
                            timing["shaft"] += time.perf_counter() - clock
                            timing["shaft_frames"] += 1
                    elif bg is not None and res.segmentation_masks and in_swing and k % shaft_every == 0:
                        # The shaft too only until then: nothing is measured from it later on.
                        clock = time.perf_counter()
                        shaft = shaft_scores(f, rotation, landmarks, res.segmentation_masks[0].numpy_view(), bg)
                        timing["shaft"] += time.perf_counter() - clock
                        timing["shaft_frames"] += 1
                else:
                    if tracker is not None:
                        tracker.frame(None, None)        # lost: the next crop comes from MediaPipe
                    ran.append(False)
                out.append((t, landmarks, world, shaft, head))
                rays.append(ray)
            if end_pts is None and last is not None:
                timing["last"] = upright_gray(last, rotation)
    finally:
        lm.close()
    timing["ran"] = ran
    timing["mp"] = mp_ran
    if ray_too:
        timing["ray"] = rays
    return out, timing


# run_chunk's speed settings when a job doesn't give them: everything as before them.
RUN_DEFAULTS = {"mp_after": 1, "convert": "full", "shaft_stride": 1, "threads": None, "ray_too": False, "mp_swing": 1}

# OpenCV's BT.601 YUV -> RGB (studio range, as its I420 conversion: the same constants, / 2^20),
# as a matrix on (Y, U, V, 1).
_CY, _CUB, _CUG, _CVG, _CVR = (v / (1 << 20) for v in (1220542, 2116026, -409993, -852492, 1673527))
YUV_TO_RGB = np.array([[_CY, 0, _CVR, -16 * _CY - 128 * _CVR],
                       [_CY, _CUG, _CVG, -16 * _CY - 128 * (_CUG + _CVG)],
                       [_CY, _CUB, 0, -16 * _CY - 128 * _CUB]], np.float32)


def half_rgb(yuv):
    """MediaPipe's half-size picture (not yet upright) from a decoded yuv420p frame (PyAV's
    to_ndarray: the Y rows, then U, then V): Y averaged over 2x2 pixels, U and V as coded (4:2:0 has
    them at half size already), then to RGB (SWINGCLIPS_FRAME_CONVERT=planes)."""
    h, w = yuv.shape[0] * 2 // 3, yuv.shape[1]
    y = cv2.resize(yuv[:h], (w // 2, h // 2), interpolation=cv2.INTER_AREA)
    u = yuv[h:h + h // 4].reshape(h // 2, w // 2)
    v = yuv[h + h // 4:h + h // 2].reshape(h // 2, w // 2)
    return cv2.transform(cv2.merge([y, u, v]), YUV_TO_RGB)


def fill_body(frames, ran, layout, until):
    """The frames the body model skipped (every other one, up to `until` s), with its points taken
    in a straight line between the nearest frames either side it ran on (within 30 ms); MediaPipe's
    stay where there are none. Frames after `until` keep MediaPipe's points."""
    idx = sorted(set(models.TO_MP[layout].values()))
    have = [i for i, (fr, r) in enumerate(zip(frames, ran)) if r and fr[1] is not None]
    out = list(frames)
    for k in range(len(have) - 1):
        a, b = have[k], have[k + 1]
        ta, tb = frames[a][0], frames[b][0]
        if b - a < 2 or tb - ta > 0.03:
            continue
        la, lb = frames[a][1], frames[b][1]
        for i in range(a + 1, b):
            t, lm, *rest = frames[i]
            if lm is None or (until is not None and t > until):
                continue
            w = (t - ta) / (tb - ta)
            lm = list(lm)
            for j in idx:
                lm[j] = (la[j][0] + w * (lb[j][0] - la[j][0]), la[j][1] + w * (lb[j][1] - la[j][1]),
                         min(la[j][2], lb[j][2]))
            out[i] = (t, lm, *rest)
    return out


def fill_skipped(frames, mp_ran, most):
    """The frames MediaPipe skipped (after the swing, SWINGCLIPS_MP_STRIDE_AFTER), with the
    landmarks, their visibility and the world landmarks in a straight line between the nearest
    frames either side it ran on and found the golfer, at most `most` frames apart; after the last
    one, it held. Where either side found no one, they stay None."""
    have = [i for i, (fr, r) in enumerate(zip(frames, mp_ran)) if r and fr[1] is not None]
    out = list(frames)

    def mix(a, b, w):
        if a is None or b is None:
            return None
        return [tuple(pa[j] + w * (pb[j] - pa[j]) for j in range(len(pa))) for pa, pb in zip(a, b)]

    for k, a in enumerate(have):
        b = have[k + 1] if k + 1 < len(have) else None
        end = b if b is not None else len(frames)
        if b is not None and b - a > most:
            continue
        ta, la, wa = frames[a][0], frames[a][1], frames[a][2]
        for i in range(a + 1, end):
            if mp_ran[i]:
                break
            t, _, _, *rest = frames[i]
            if b is None:
                if i - a >= most:
                    break
                out[i] = (t, list(la), None if wa is None else list(wa), *rest)
                continue
            tb_, lb, wb = frames[b][0], frames[b][1], frames[b][2]
            w = (t - ta) / (tb_ - ta) if tb_ > ta else 0.0
            out[i] = (t, mix(la, lb, w), mix(wa, wb, w), *rest)
    return out


def job_costs(pts, tb, body_until, mp_after, body_stride_, shaft_every, body, clubm, raycast, mp_swing=1):
    """What each frame costs (COST_MS, only the proportions matter), for split_jobs."""
    out = []
    for k, p in enumerate(pts):
        t = p * tb
        in_swing = body_until is None or t <= body_until
        c = COST_MS["decode"]
        if k % (mp_swing if in_swing else mp_after) == 0:
            c += COST_MS["mediapipe"]
            if clubm:
                c += COST_MS["club"]
            elif raycast and in_swing:
                c += COST_MS["shaft"] / shaft_every
        if body and in_swing:
            c += COST_MS["body"] / body_stride_
        out.append(c)
    return out


def split_jobs(keys, pts, costs, workers):
    """The keyframes cut into at most `workers` runs (start pts, end pts | None) that each cost
    about the same: the most any one costs as small as it can be (every cut at a keyframe)."""
    keys = sorted(keys)
    # The cost of each keyframe's run of frames (up to the next keyframe).
    seg = np.zeros(len(keys))
    idx = np.clip(np.searchsorted(keys, pts, side="right") - 1, 0, len(keys) - 1)
    np.add.at(seg, idx, costs)
    n, m = len(keys), max(1, min(workers, len(keys)))
    pre = np.concatenate([[0.0], np.cumsum(seg)])
    # best[j][i]: the smallest largest run cutting the first i segments into j runs.
    best = np.full((m + 1, n + 1), np.inf)
    cut = np.zeros((m + 1, n + 1), int)
    best[0][0] = 0.0
    for j in range(1, m + 1):
        for i in range(j, n + 1):
            # The last run is segments c..i-1, for each possible c.
            v = np.maximum(best[j - 1][j - 1:i], pre[i] - pre[j - 1:i])
            c = int(np.argmin(v))
            best[j][i], cut[j][i] = v[c], c + j - 1
    bounds, i = [], n
    for j in range(m, 0, -1):
        bounds.append((cut[j][i], i))
        i = cut[j][i]
    bounds.reverse()
    return [(keys[a], keys[b] if b < n else None) for a, b in bounds]


def split_frames(keys, pts, costs, workers, lead=COST_MS["decode"]):
    """The clip cut into at most `workers` runs (start pts, end pts | None) that each cost about the
    same, cut at any frame: a run starting between keyframes also costs `lead` for each frame it
    decodes and drops from the keyframe before. The smallest largest run, by bisection on it."""
    keys, n = sorted(keys), len(pts)
    first = keys[0] if keys else (pts[0] if n else 0)
    if n == 0 or workers <= 1:
        return [(first, None)]
    # Frames decoded and dropped before a run starting at each frame.
    before = np.searchsorted(pts, keys, side="left")
    kf = np.clip(np.searchsorted(keys, pts, side="right") - 1, 0, len(keys) - 1) if keys else np.zeros(n, int)
    drop = np.array([i - before[k] if keys else 0 for i, k in enumerate(kf)], float)
    pre = np.concatenate([[0.0], np.cumsum(costs)])

    def levels(limit):
        """Where a run can start after k runs (a boolean per frame, for each k) until the end can be
        reached, and reach[a]: the furthest end of a run from frame a within `limit`. None if it can't."""
        reach = np.minimum(np.searchsorted(pre, limit + pre[:n] - drop * lead, side="right") - 1, n)
        now = np.zeros(n + 1, bool)
        now[0] = True
        out = []
        for _ in range(workers):
            out.append(now)
            starts = np.flatnonzero(now[:n] & (reach > np.arange(n)))
            if starts.size and reach[starts].max() >= n:
                return out, reach
            mark = np.zeros(n + 2, int)
            np.add.at(mark, starts + 1, 1)
            np.add.at(mark, reach[starts] + 1, -1)
            now = np.cumsum(mark)[:n + 1] > 0
            if not now.any():
                return None
        return None

    lo, hi = 0.0, float(pre[-1] + n * lead)
    for _ in range(60):
        mid = (lo + hi) / 2
        if levels(mid) is not None:
            hi = mid
        else:
            lo = mid
    out, reach = levels(hi)
    # Back from the end: each run's start, the first in its interval that reaches the next start.
    cuts, b = [], n
    for can in reversed(out):
        a = next(a for a in np.flatnonzero(can[:b]) if reach[a] >= b)
        cuts.append(int(a))
        b = a
    cuts.reverse()
    return [(pts[a] if a else first, pts[b] if b < n else None) for a, b in zip(cuts, cuts[1:] + [n])]


def shaft_scores(frame, rotation, landmarks, person, bg):
    """club.scores for one frame: full-size upright picture, with the person mask grown a little so
    the golfer's outline doesn't count either.

    Only the square around the hands the rays reach (club.region) is turned upright, and only that
    part of the mask is scaled up and grown: the same numbers as doing the whole picture, at a
    fraction of the work (a full 1080p picture turned and masked cost ~10 ms a frame)."""
    h, w = bg.shape[:2]
    box = club.region(landmarks, w, h)
    if box is None:
        return None
    img = upright_crop(frame.to_ndarray(format="bgr24"), rotation, box)
    # Grown by 6% of the golfer's height: at 3% the edge of a leg (dark trousers on a dark mat) still
    # showed past the mask and passed for the shaft down the line.
    grow = max(3, int(0.06 * club.body_height(landmarks, h)))
    mask = grown_mask(person, w, h, box, grow)
    x0, y0, x1, y1 = box
    return club.region_scores(img, mask, bg[y0:y1, x0:x1], box, landmarks, w, h)


def upright_crop(img, rotation, box):
    """cv2.rotate(img, ROTATE_CW[rotation])[y0:y1, x0:x1] for box = (x0, y0, x1, y1) in the upright
    picture, turning only that part."""
    x0, y0, x1, y1 = box
    hs, ws = img.shape[:2]                   # as stored
    if rotation == 90:
        part = img[hs - x1:hs - x0, y0:y1]
    elif rotation == 180:
        part = img[hs - y1:hs - y0, ws - x1:ws - x0]
    elif rotation == 270:
        part = img[x0:x1, ws - y1:ws - y0]
    else:
        return img[y0:y1, x0:x1]
    return cv2.rotate(part, ROTATE_CW[rotation])


def grown_mask(person, w, h, box, grow):
    """The person mask (MediaPipe's, at its own size) scaled up to w x h (nearest pixel) and grown
    by a grow x grow square, as booleans, cut to box: exactly the whole mask done so and then cut,
    working only on the box and the margin the growing reaches into."""
    x0, y0, x1, y1 = box
    ex0, ey0, ex1, ey1 = max(0, x0 - grow), max(0, y0 - grow), min(w, x1 + grow), min(h, y1 + grow)
    mh, mw = person.shape[:2]
    # cv2.resize's nearest pixel: source = floor(destination * source size / destination size).
    rows = np.minimum(np.floor(np.arange(ey0, ey1) * (1.0 / (h / mh))).astype(np.intp), mh - 1)
    cols = np.minimum(np.floor(np.arange(ex0, ex1) * (1.0 / (w / mw))).astype(np.intp), mw - 1)
    mask = (person[np.ix_(rows, cols)] > 0.5).astype(np.uint8)
    mask = cv2.dilate(mask, np.ones((grow, grow), np.uint8)) > 0
    return mask[y0 - ey0:y1 - ey0, x0 - ex0:x1 - ex0]


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


def ball_candidates(path, rotation, frames, first, angle=None, last=None):
    """Places near the feet that look like a ball in frame `first` and are gone at the end (`last`,
    the clip's last frame upright gray: read here when not given): the size of a ball for the
    golfer's size, where a ball sits for the camera's angle.

    Returns [(cx, cy, r)] in upright full-size pixels, best first.
    """
    lm = next((lm for _, lm, *_ in frames if lm is not None), None)
    if lm is None:
        return []
    if last is None:
        last = last_frame(path, rotation)
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


def last_frame(path, rotation):
    """The clip's last frame, upright gray."""
    with av.open(path) as c:
        s = c.streams.video[0]
        if s.duration:
            c.seek(int(s.duration * 0.9), stream=s, backward=True)
        last = None
        for f in c.decode(s):
            last = f
        return upright_gray(last, rotation)


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


def ball_leaves(times, scores, still=0.5):
    """When the ball goes: the spot looks the same for a while, then suddenly not at all.

    At address the club sits against the ball, so the spot changes a little in the takeaway; what
    counts is the drop from wherever it settled to nothing. Returns (index of the first frame
    without the ball, strength of the drop), or None. A frame whose spot matches less than `still`
    times the settled level no longer shows the ball where it sat.
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
    kept = [j for j in range(lo, hi) if s[j] >= still * level]
    first_gone = kept[-1] + 1 if kept else i
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


def find_impact(path, rotation, frames, jobs, pool, last=None, keys=None):
    """The ball's spot and the time of the first frame it's gone from, or (None, None).

    The ball is looked for at the start of the clip (address) and, failing that, at the top of the
    backswing: from down the line the clubhead sits between the camera and the ball at address.
    The clip's name gives the camera's angle (where to look) and when the phone heard the strike
    (when the ball can have gone). `last` (the clip's last frame, upright gray) and `keys`
    (keyframe pts and time base, from probe) save reading them again.
    """
    angle, strike = clip_facts(path)
    if strike is not None:
        jobs = window_jobs(path, rotation, jobs, strike - BALL_SEARCH_SECONDS, strike + BALL_SEARCH_SECONDS, keys)
    with av.open(path) as c:
        first = upright_gray(next(c.decode(video=0)), rotation)
    if last is None:
        last = last_frame(path, rotation)
    found = find_impact_from(path, rotation, frames, jobs, pool, first, angle, strike, last)
    top = top_of_backswing(frames)
    if found[1] is None and top is not None:
        found = find_impact_from(path, rotation, frames, jobs, pool, frame_at(path, rotation, top), angle, strike,
                                 last)
    return found


def window_jobs(path, rotation, jobs, t0, t1, keys=None):
    """`jobs` cut down to the part of the clip from t0 to t1 s (split across as many workers):
    each starts on a keyframe, so decoding is quick. `keys`: (keyframe pts, time base), else probed."""
    keys, tb = keys if keys is not None else probe(path)[:2]
    inside = [k for k in keys if t0 - 0.3 <= k * tb <= t1]
    if len(inside) < 2:
        return jobs
    end = next((k for k in keys if k * tb > t1), None)
    groups = np.array_split(np.arange(len(inside)), min(len(jobs), len(inside)))
    out = []
    for g in groups:
        start = inside[g[0]]
        stop = inside[g[-1] + 1] if g[-1] + 1 < len(inside) else end
        out.append((path, start, stop, rotation))
    return out


def find_impact_from(path, rotation, frames, jobs, pool, first, angle=None, strike=None, last=None):
    """find_impact, with the ball looked for in the frame `first`."""
    candidates = ball_candidates(path, rotation, frames, first, angle, last)
    if not candidates:
        return None, None
    refs = [ball_patch(first, cand) for cand in candidates]
    rows = sorted((r for chunk in pool.map(run_ball_chunk, [j + (candidates, refs) for j in jobs]) for r in chunk),
                  key=lambda r: r[0])
    times = [r[0] for r in rows]
    speed = hand_speed(frames)
    best = None
    for k, cand in enumerate(candidates):
        found = ball_leaves(times, [r[1][k] for r in rows], BALL_STILL.get(angle, BALL_STILL[None]))
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


def deep_profile() -> dict | None:
    """The server's deep pass, after a session (app.py): every clip analyzed again the slow, careful
    way, as analyze's `deep`: the body model on every frame (SWINGCLIPS_DEEP_BODY_STRIDE, default 1)
    and the club model (SWINGCLIPS_DEEP_CLUB_MODEL, or public\\models\\club-deep.onnx when it's there),
    with the ray-cast shaft too for address and the takeaway (rayTakeaway). None when it's off
    (SWINGCLIPS_DEEP=off) or would change nothing (no body model and no club model)."""
    if os.environ.get("SWINGCLIPS_DEEP", "on").strip().lower() == "off":
        return None
    club_path = os.environ.get("SWINGCLIPS_DEEP_CLUB_MODEL", "").strip()
    club_model = Path(club_path) if club_path else models.models_dir() / "club-deep.onnx"
    if club_path and not club_model.is_file():
        raise SystemExit(f"SWINGCLIPS_DEEP_CLUB_MODEL={club_path}: no such file")
    club_model = club_model if club_model.is_file() else None
    if models.backend() == models.DEFAULT and club_model is None:
        return None
    return {"bodyStride": max(1, int(os.environ.get("SWINGCLIPS_DEEP_BODY_STRIDE") or 1)), "clubModel": club_model,
            "rayTakeaway": True}


# The quick pass, during a session (app.py), when a deep pass follows it: inside the swing, MediaPipe
# and the shaft search only on every QUICK_MP_STRIDE-th frame (SWINGCLIPS_QUICK_MP_STRIDE), the ones
# the body model runs on at its CPU stride, with the frames between filled in from their neighbours
# (fill_skipped, and club.track as for blurred frames). Enough for the spoken checks and practice
# numbers; the deep pass after the session analyzes every clip again the careful way.
QUICK_MP_STRIDE = 2


def quick_profile() -> dict | None:
    """The quick pass's settings, as analyze's `quick`: {"mpStrideSwing": n}. None when it's off
    (SWINGCLIPS_QUICK=off, or SWINGCLIPS_QUICK_MP_STRIDE=1), or when no deep pass follows to redo the
    clips (deep_profile() is None)."""
    if os.environ.get("SWINGCLIPS_QUICK", "on").strip().lower() == "off":
        return None
    n = _count("SWINGCLIPS_QUICK_MP_STRIDE", QUICK_MP_STRIDE)
    if n <= 1 or deep_profile() is None:
        return None
    return {"mpStrideSwing": n}


def analyze(path, pool: ProcessPoolExecutor, workers: int, timing: dict | None = None, deep: dict | None = None,
            quick: dict | None = None):
    """Pose for every frame of the clip, plus the ball, impact and club shaft, as a JSON-ready dict.
    `timing`, if given, gets where the time went (parts(), and the steps in this process).

    `deep`, the server's after-session pass (app.py, deep_profile()): {"bodyStride": n, "clubModel":
    .onnx path or None} in place of SWINGCLIPS_BODY_STRIDE and SWINGCLIPS_CLUB_BACKEND/_MODEL, and the
    result says so ("pass": "deep").

    `quick`, the server's pass during a session (quick_profile()): {"mpStrideSwing": n}; the result
    says so ("pass": "quick"). Not with `deep`."""
    if deep is not None:
        quick = None
    mp_swing = quick["mpStrideSwing"] if quick else 1
    started = time.perf_counter()
    backend = models.backend()
    body = None
    if backend != models.DEFAULT:
        body = (backend, str(models.model_path(backend)))
        if not os.path.isfile(body[1]):
            raise FileNotFoundError(f"{body[1]} is missing: run fetch_models.py first")
    clubm = None
    if deep is not None:
        clubm = str(deep["clubModel"]) if deep.get("clubModel") else None
    elif models.club_backend() != models.CLUB_DEFAULT:
        clubm = str(models.club_model_path())
    if clubm:
        if not os.path.isfile(clubm):
            raise FileNotFoundError(f"{clubm} is missing: train it (HOME-SETUP.md, \"Training the club model\") "
                                    "or point SWINGCLIPS_CLUB_MODEL at it")
    speed = speed_settings()
    clock = time.perf_counter()
    stages = {}                              # seconds for each step, in this process (see timing)
    keys, tb, rotation, pts = probe(path, every_frame=True)
    bg = club.background(path, rotation, ROTATE_CW)
    stages["background"] = time.perf_counter() - clock
    if not keys:
        keys = [0]
    _, strike = clip_facts(path)
    body_until = strike + BODY_AFTER_STRIKE if strike is not None else None
    stride = (deep["bodyStride"] if deep is not None else body_stride()) if body else 1
    if speed["split"] in ("frames", "cost") and pts:
        costs = job_costs(pts, tb, body_until, speed["mpStrideAfter"], stride, speed["shaftStride"], body, clubm,
                          bg is not None, mp_swing)
        runs = (split_frames if speed["split"] == "frames" else split_jobs)(keys, pts, costs, workers)
    else:
        groups = np.array_split(np.arange(len(keys)), min(workers, len(keys)))
        runs = [(keys[g[0]], keys[g[-1] + 1] if g[-1] + 1 < len(keys) else None) for g in groups]
    jobs = [(path, start, end, rotation) for start, end in runs]
    opts = {"mp_after": speed["mpStrideAfter"], "convert": speed["convert"], "shaft_stride": speed["shaftStride"],
            "threads": decode_threads(), "mp_swing": mp_swing}
    if deep is not None and clubm and deep.get("rayTakeaway"):
        opts["ray_too"] = True
    clock = time.perf_counter()
    chunks = list(pool.map(run_chunk, [j + (bg, body, clubm, (body_until, stride), opts) for j in jobs]))
    stages["workers"] = time.perf_counter() - clock
    clock = time.perf_counter()
    rows = sorted(((fr, r, m, y) for chunk, tm in chunks
                   for fr, r, m, y in zip(chunk, tm["ran"], tm.get("mp") or [True] * len(chunk),
                                          tm.get("ray") or [None] * len(chunk))),
                  key=lambda x: x[0][0])
    frames = [fr for fr, _, _, _ in rows]
    rays = [y for _, _, _, y in rows] if opts.get("ray_too") else None
    if speed["mpStrideAfter"] > 1 or mp_swing > 1:
        frames = fill_skipped(frames, [m for _, _, m, _ in rows], max(speed["mpStrideAfter"], mp_swing))
    if body and stride > 1:
        frames = fill_body(frames, [r for _, r, _, _ in rows], models.SPECS[backend].layout, body_until)
    timings = [tm for _, tm in chunks]
    ms = per_frame_ms(timings)
    print(f"pose: {os.path.basename(path)}: {len(frames)} frames, MediaPipe {ms['mediapipe']:.1f} ms/frame"
          + (f", {models.stamp(backend)} {ms['body']:.1f} ms/frame" if body else "")
          + (f", club model {ms['club']:.1f} ms/frame" if clubm else "")
          + f" (in each of {len(jobs)} worker(s))", flush=True)
    last = next((t["last"] for t in timings if t.get("last") is not None), None)
    stages["fill"] = time.perf_counter() - clock
    clock = time.perf_counter()
    ball, impact = find_impact(path, rotation, frames, jobs, pool, last=last, keys=(keys, tb))
    stages["ball"] = time.perf_counter() - clock
    clock = time.perf_counter()
    times = [t for t, *_ in frames]
    smoothed = smooth(times, [lm for _, lm, *_ in frames])
    world = smooth(times, [w for _, _, w, *_ in frames], spatial=3)
    stages["smooth"] = time.perf_counter() - clock
    clock = time.perf_counter()
    shaft = club.track(times, [s for _, _, _, s, _ in frames])
    ray_shaft = club.track(times, rays) if rays is not None else None
    stages["track"] = time.perf_counter() - clock
    if timing is not None:
        timing.update(parts(timings, len(frames)), stages=stages, jobs=len(jobs),
                      workerSeconds=[round(sum(v for k, v in t.items() if k in PARTS or k == "start"), 2)
                                     for t in timings])
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
    if speed != BEFORE:
        # The speed settings the clip was analyzed with, when any isn't as before them (the output
        # as before otherwise).
        out["speed"] = speed
    if clubm:
        # clubhead: [x, y, confidence 0-1] in picture units where the club model is sure of it, else
        # null. Straight from the model, per frame: not smoothed or tracked (the shaft angle is).
        for fr, (*_, head) in zip(out["frames"], frames):
            fr["clubhead"] = head
    if ray_shaft is not None:
        # clubRay: the ray-cast shaft as "club" would be without the club model. The model's angle
        # wobbles a degree or two at address, so address and the takeaway come from this one
        # (phases.js); the rest of the swing from the model's.
        for fr, c in zip(out["frames"], ray_shaft):
            fr["clubRay"] = list(c) if c else None
    if body or clubm:
        # Which models placed the 2D landmarks and the club, and their cost; the defaults' output
        # has none of it.
        stamps = {"model": models.stamp(backend)} if body else {}
        if clubm:
            stamps["clubModel"] = models.club_stamp(clubm)
        # Where they ran, when not on the CPU: a GPU's arithmetic differs a little (models.py).
        where = models.provider()
        if where != models.PROVIDER_DEFAULT:
            stamps["provider"] = where
        cost = {"mediapipe": round(ms["mediapipe"], 1)}
        if body:
            cost["body"] = round(ms["body"], 1)
        if clubm:
            cost["club"] = round(ms["club"], 1)
        out = {"version": VERSION, **stamps, "msPerFrame": cost, **out}
    if deep is not None:
        # Near the start, where the server reads what made a pose file (app.py, _pose_stamp).
        out = {"version": VERSION, "pass": "deep", **out}
    elif quick:
        out = {"version": VERSION, "pass": "quick", "quick": quick, **out}
    return out


def low_priority():
    """For the pose workers (ProcessPoolExecutor's initializer): below normal priority, so recording
    and uploads from the phones, and the pages, always come first while a clip is analyzed."""
    try:
        if os.name == "nt":
            import ctypes
            BELOW_NORMAL_PRIORITY_CLASS = 0x4000
            k = ctypes.windll.kernel32
            k.SetPriorityClass(k.GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS)
        else:
            os.nice(5)
    except (OSError, AttributeError):
        pass


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
    changed. A ball that passes its checks is kept as it was, unless it was timed by a search older
    than BALL_TIMING_VERSION; otherwise (or with no ball) it's found again, from the saved (smoothed) landmarks, with the shaft length drawn from it: a few seconds
    a clip instead of a whole analysis."""
    if doc.get("ballVersion", 1) >= BALL_TIMING_VERSION and ball_fits(path, doc):
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
    out = {k: 1000 * sum(t[k] for t in timings) / n for k in ("mediapipe", "club")}
    # The body model's cost per frame it ran on.
    nb = max(1, sum(sum(t.get("ran", [])) for t in timings))
    out["body"] = 1000 * sum(t["body"] for t in timings) / nb
    return out


# The parts of a worker's time, and what each is counted per.
PARTS = {"decode": "decoded", "convert": "frames", "mediapipe": "frames", "body": "ran", "shaft": "shaft_frames",
         "club": "frames"}


def parts(timings, frames):
    """Where the workers' time went: {part: {"ms": per frame it ran on, "frames": how many,
    "seconds": in all workers together}} for decode, convert, mediapipe, body, shaft and club, plus
    "start" (loading MediaPipe, seconds in all) and "frames" (the clip's)."""
    out = {"frames": frames, "start": round(sum(t.get("start", 0.0) for t in timings), 2)}
    for part, per in PARTS.items():
        total = sum(t.get(part, 0.0) for t in timings)
        n = sum(sum(t.get(per, [])) if per == "ran" else t.get(per, 0) for t in timings)
        if total:
            out[part] = {"ms": round(1000 * total / max(n, 1), 2), "frames": n, "seconds": round(total, 2)}
    return out
