"""Pose over a clip split at keyframes: each worker decodes, converts and tracks its own chunk.

  python bench2.py CLIP.mp4 [--workers 1 2 3 4 5 6] [--scale 0.5]

Uses the frames' real timestamps (high-fps phone clips have dropped frames, so index / fps lies).
"""
import argparse
import os
import time
from concurrent.futures import ProcessPoolExecutor

import av
import cv2
import numpy as np

DEFAULT_MODEL = os.path.join(os.path.dirname(__file__), "..", "public", "mediapipe",
                             "pose_landmarker_full.task")

ROTATE = {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}


def keyframe_times(path):
    with av.open(path) as c:
        s = c.streams.video[0]
        return [p.pts for p in c.demux(s) if p.is_keyframe and p.pts is not None], float(s.time_base)


def rotation(path):
    cap = cv2.VideoCapture(path)
    r = int(cap.get(cv2.CAP_PROP_ORIENTATION_META)) % 360
    cap.release()
    return r


def run_chunk(args):
    """Frames with start_pts <= pts < end_pts. Returns [(ms, landmarks|None)], decode s, pose s."""
    cv2.setNumThreads(1)
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions
    from mediapipe.tasks.python.vision import PoseLandmarker, PoseLandmarkerOptions, RunningMode

    path, model, start_pts, end_pts, scale, rot = args
    lm = PoseLandmarker.create_from_options(PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=model), running_mode=RunningMode.VIDEO, num_poses=1))
    out, dec_s, pose_s = [], 0.0, 0.0
    with av.open(path) as c:
        s = c.streams.video[0]
        tb = float(s.time_base)
        c.seek(start_pts, stream=s, backward=True, any_frame=False)
        t = time.perf_counter()
        for f in c.decode(s):
            if f.pts < start_pts:
                continue
            if end_pts is not None and f.pts >= end_pts:
                break
            rgb = cv2.cvtColor(f.to_ndarray(format="yuv420p"), cv2.COLOR_YUV2RGB_I420)
            if scale != 1.0:
                rgb = cv2.resize(rgb, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
            if rot in ROTATE:
                rgb = cv2.rotate(rgb, ROTATE[rot])
            ms = int(round(f.pts * tb * 1000))
            t2 = time.perf_counter()
            dec_s += t2 - t
            res = lm.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)), ms)
            t = time.perf_counter()
            pose_s += t - t2
            out.append((ms, [(p.x, p.y, p.visibility) for p in res.pose_landmarks[0]] if res.pose_landmarks else None))
    lm.close()
    return out, dec_s, pose_s


def run(path, model, workers, scale):
    keys, _ = keyframe_times(path)
    rot = rotation(path)
    # Group consecutive GOPs into `workers` chunks of roughly equal length.
    groups = np.array_split(np.arange(len(keys)), min(workers, len(keys)))
    jobs = []
    for g in groups:
        start = keys[g[0]]
        end = keys[g[-1] + 1] if g[-1] + 1 < len(keys) else None
        jobs.append((path, model, start, end, scale, rot))
    t = time.perf_counter()
    if len(jobs) == 1:
        results = [run_chunk(jobs[0])]
    else:
        with ProcessPoolExecutor(len(jobs)) as ex:
            results = list(ex.map(run_chunk, jobs))
    wall = time.perf_counter() - t
    frames = [fr for r in results for fr in r[0]]
    return wall, len(jobs), frames, sum(r[1] for r in results), sum(r[2] for r in results)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clip")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--workers", type=int, nargs="+", default=[1, 2, 3, 4, 5])
    ap.add_argument("--scale", type=float, default=0.5)
    a = ap.parse_args()

    keys, tb = keyframe_times(a.clip)
    print(f"{os.path.basename(a.clip)}: keyframes at {[round(k * tb, 2) for k in keys]} s, "
          f"rotation {rotation(a.clip)}, {os.cpu_count()} logical CPUs, scale {a.scale}")
    for w in a.workers:
        wall, chunks, frames, dec_s, pose_s = run(a.clip, a.model, w, a.scale)
        n = len(frames)
        found = sum(lm is not None for _, lm in frames)
        ordered = all(x[0] < y[0] for x, y in zip(frames, frames[1:]))
        print(f"workers {w} ({chunks} chunks): wall {wall:5.2f} s | per frame: decode+convert "
              f"{dec_s * 1000 / n:4.1f} ms, pose {pose_s * 1000 / n:4.1f} ms | {found}/{n} with pose"
              f"{'' if ordered else ' | OUT OF ORDER'}")


if __name__ == "__main__":
    main()
