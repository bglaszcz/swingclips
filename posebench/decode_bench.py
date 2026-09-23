"""Compares ways to decode a clip to downscaled RGB frames (the input pose needs)."""
import sys
import time

import cv2

path = sys.argv[1]


def timed(name, fn):
    t = time.perf_counter()
    try:
        n = fn()
        dt = time.perf_counter() - t
        print(f"{name:34s} {n} frames in {dt:5.2f} s = {n / dt:4.0f} fps")
    except Exception as e:  # noqa: BLE001 — report and move on
        print(f"{name:34s} failed: {e}")


def cv2_default():
    cap = cv2.VideoCapture(path)
    n = 0
    while True:
        ok, f = cap.read()
        if not ok:
            return n
        cv2.resize(f, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
        n += 1


def cv2_hw():
    cap = cv2.VideoCapture(path, cv2.CAP_FFMPEG,
                           [cv2.CAP_PROP_HW_ACCELERATION, cv2.VIDEO_ACCELERATION_ANY])
    print(f"  (hw accel in use: {int(cap.get(cv2.CAP_PROP_HW_ACCELERATION))})")
    n = 0
    while True:
        ok, f = cap.read()
        if not ok:
            return n
        cv2.resize(f, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
        n += 1


def pyav(threaded):
    def run():
        import av
        with av.open(path) as c:
            s = c.streams.video[0]
            if threaded:
                s.thread_type = "AUTO"
            n = 0
            for frame in c.decode(s):
                # Scale in the decoder's own converter; rotation is applied later as a cheap transpose.
                frame.to_ndarray(format="rgb24", width=frame.width // 2, height=frame.height // 2)
                n += 1
            return n
    return run


timed("opencv (default)", cv2_default)
timed("opencv + hw acceleration", cv2_hw)
timed("pyav single-thread", pyav(False))
timed("pyav multi-thread", pyav(True))
