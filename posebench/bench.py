"""Times MediaPipe Pose on a high-fps clip, the way the home server would run it.

  python bench.py CLIP.mp4 [--model pose_landmarker_full.task] [--workers 1 2 4 6 8] [--scale 0.5]

Reports decode time, single-process pose speed, and wall time with the clip split across
N worker processes (each worker tracks its own chunk). Writes a skeleton contact sheet
around peak hand speed (≈ just before impact) next to the clip.
"""
import argparse
import os
import time
from concurrent.futures import ProcessPoolExecutor

import cv2
import numpy as np

DEFAULT_MODEL = os.path.join(os.path.dirname(__file__), "..", "public", "mediapipe",
                             "pose_landmarker_full.task")

BONES = [(11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (11, 23), (12, 24), (23, 24),
         (23, 25), (25, 27), (24, 26), (26, 28)]


def clip_info(path):
    cap = cv2.VideoCapture(path)
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    cap.release()
    return n, fps


def decode_all(path):
    cap = cv2.VideoCapture(path)
    n = 0
    while cap.grab():
        cap.retrieve()
        n += 1
    cap.release()
    return n


def make_landmarker(model):
    from mediapipe.tasks.python import BaseOptions
    from mediapipe.tasks.python.vision import PoseLandmarker, PoseLandmarkerOptions, RunningMode
    return PoseLandmarker.create_from_options(PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=model),
        running_mode=RunningMode.VIDEO,
        num_poses=1,
    ))


def run_chunk(args):
    """Pose on frames [start, end). Returns (start, landmarks list, seconds spent in pose)."""
    import mediapipe as mp
    path, model, start, end, fps, scale = args
    lm = make_landmarker(model)
    cap = cv2.VideoCapture(path)
    for _ in range(start):  # sequential skip; seeking H.264 by frame index isn't reliable
        cap.grab()
    out, pose_s = [], 0.0
    for i in range(start, end):
        ok, frame = cap.read()
        if not ok:
            break
        if scale != 1.0:
            frame = cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        img = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        t = time.perf_counter()
        res = lm.detect_for_video(img, int(round(i * 1000 / fps)))
        pose_s += time.perf_counter() - t
        out.append([(p.x, p.y, p.visibility) for p in res.pose_landmarks[0]] if res.pose_landmarks else None)
    cap.release()
    lm.close()
    return start, out, pose_s


def run(path, model, n, fps, workers, scale):
    bounds = np.linspace(0, n, workers + 1).astype(int)
    jobs = [(path, model, int(a), int(b), fps, scale) for a, b in zip(bounds[:-1], bounds[1:])]
    t = time.perf_counter()
    if workers == 1:
        results = [run_chunk(jobs[0])]
    else:
        with ProcessPoolExecutor(workers) as ex:
            results = list(ex.map(run_chunk, jobs))
    wall = time.perf_counter() - t
    landmarks = [lm for _, chunk, _ in sorted(results, key=lambda r: r[0]) for lm in chunk]
    pose_s = sum(r[2] for r in results)
    return wall, pose_s, landmarks


def contact_sheet(path, landmarks, fps, out_path, count=12, step=2):
    """Frames around peak hand speed, skeleton drawn, 4 per row."""
    wrists = []
    for lm in landmarks:
        wrists.append(None if lm is None else ((lm[15][0] + lm[16][0]) / 2, (lm[15][1] + lm[16][1]) / 2))
    speed = [0.0] + [
        0.0 if a is None or b is None else float(np.hypot(b[0] - a[0], b[1] - a[1]))
        for a, b in zip(wrists, wrists[1:])
    ]
    peak = int(np.argmax(speed))
    picks = [peak + (k - count // 2) * step for k in range(count)]
    picks = [p for p in picks if 0 <= p < len(landmarks)]

    cap = cv2.VideoCapture(path)
    tiles, i = {}, 0
    want = set(picks)
    while cap.grab() and i <= max(picks):
        if i in want:
            _, frame = cap.retrieve()
            h, w = frame.shape[:2]
            lm = landmarks[i]
            if lm:
                pts = [(int(x * w), int(y * h)) for x, y, _ in lm]
                for a, b in BONES:
                    cv2.line(frame, pts[a], pts[b], (0, 255, 0), 4)
                for j in {j for bone in BONES for j in bone}:
                    cv2.circle(frame, pts[j], 7, (0, 0, 255), -1)
            label = f"#{i}  {(i - peak) * 1000 / fps:+.1f} ms" + ("" if lm else "  NO POSE")
            cv2.putText(frame, label, (20, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (255, 255, 255), 4)
            tiles[i] = cv2.resize(frame, None, fx=0.35, fy=0.35, interpolation=cv2.INTER_AREA)
        i += 1
    cap.release()
    row = [tiles[p] for p in picks if p in tiles]
    while len(row) % 4:
        row.append(np.zeros_like(row[0]))
    rows = [np.hstack(row[k:k + 4]) for k in range(0, len(row), 4)]
    cv2.imwrite(out_path, np.vstack(rows))
    return peak


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clip")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--workers", type=int, nargs="+", default=[1, 2, 4, 6, 8])
    ap.add_argument("--scale", type=float, default=0.5, help="downscale frames before pose (MediaPipe works at 256px anyway)")
    a = ap.parse_args()

    n, fps = clip_info(a.clip)
    print(f"{os.path.basename(a.clip)}: {n} frames @ {fps:.1f} fps, {os.cpu_count()} logical CPUs, scale {a.scale}")

    t = time.perf_counter()
    decoded = decode_all(a.clip)
    dec = time.perf_counter() - t
    print(f"decode only: {decoded} frames in {dec:.2f} s ({decoded / dec:.0f} fps)")

    best = None
    for w in a.workers:
        wall, pose_s, lms = run(a.clip, a.model, decoded, fps, w, a.scale)
        found = sum(lm is not None for lm in lms)
        print(f"workers {w}: wall {wall:5.2f} s | pose {pose_s * 1000 / max(len(lms), 1):5.1f} ms/frame (per process) "
              f"| {found}/{len(lms)} frames with pose")
        if w == 1 or best is None:
            best = lms

    sheet = os.path.splitext(a.clip)[0] + "_pose_sheet.jpg"
    peak = contact_sheet(a.clip, best, fps, sheet)
    print(f"contact sheet around peak hand speed (frame {peak}): {sheet}")


if __name__ == "__main__":
    main()
