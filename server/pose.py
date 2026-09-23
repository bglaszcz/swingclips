"""Pose for whole clips: MediaPipe on every frame, split across worker processes at keyframes.

Adapted from posebench/bench2.py. Frames keep their real timestamps, because high-fps phone clips
have dropped frames and index / fps would drift.
"""
import os
import time
from concurrent.futures import ProcessPoolExecutor

import av
import cv2
import numpy as np

MODEL = os.path.join(os.path.dirname(__file__), "..", "public", "mediapipe", "pose_landmarker_full.task")
# MediaPipe works on a 256px input internally, so half size loses nothing and halves the conversion.
SCALE = 0.5
ROTATE_CW = {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}


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


def run_chunk(args):
    """Pose for frames with start_pts <= pts < end_pts. Returns [(t seconds, landmarks | None)]."""
    cv2.setNumThreads(1)
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions
    from mediapipe.tasks.python.vision import PoseLandmarker, PoseLandmarkerOptions, RunningMode

    path, start_pts, end_pts, rotation = args
    lm = PoseLandmarker.create_from_options(PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=MODEL), running_mode=RunningMode.VIDEO, num_poses=1))
    out = []
    try:
        with av.open(path) as c:
            s = c.streams.video[0]
            tb = float(s.time_base)
            c.seek(start_pts, stream=s, backward=True, any_frame=False)
            for f in c.decode(s):
                if f.pts is None or f.pts < start_pts:
                    continue
                if end_pts is not None and f.pts >= end_pts:
                    break
                rgb = cv2.cvtColor(f.to_ndarray(format="yuv420p"), cv2.COLOR_YUV2RGB_I420)
                rgb = cv2.resize(rgb, None, fx=SCALE, fy=SCALE, interpolation=cv2.INTER_AREA)
                if rotation in ROTATE_CW:
                    rgb = cv2.rotate(rgb, ROTATE_CW[rotation])
                t = f.pts * tb
                res = lm.detect_for_video(
                    mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)),
                    int(round(t * 1000)))
                landmarks = None
                if res.pose_landmarks:
                    # Flat [x, y, visibility] * 33, rounded to keep the JSON small.
                    landmarks = [round(v, 4) for p in res.pose_landmarks[0] for v in (p.x, p.y, p.visibility)]
                out.append((round(t, 6), landmarks))
    finally:
        lm.close()
    return out


def analyze(path, pool: ProcessPoolExecutor, workers: int):
    """Pose for every frame of the clip, as a JSON-ready dict."""
    started = time.perf_counter()
    keys, _, rotation = probe(path)
    if not keys:
        keys = [0]
    groups = np.array_split(np.arange(len(keys)), min(workers, len(keys)))
    jobs = []
    for g in groups:
        start = keys[g[0]]
        end = keys[g[-1] + 1] if g[-1] + 1 < len(keys) else None
        jobs.append((path, start, end, rotation))
    frames = [fr for chunk in pool.map(run_chunk, jobs) for fr in chunk]
    frames.sort(key=lambda fr: fr[0])
    return {
        "version": 1,
        "rotation": rotation,
        "seconds": round(time.perf_counter() - started, 2),
        "frames": [{"t": t, "lm": lms} for t, lms in frames],
    }
