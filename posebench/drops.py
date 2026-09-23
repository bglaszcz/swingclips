"""Frame-drop report for any video, from the container's timestamps.

  python drops.py CLIP.mp4 [CLIP2.mp4 ...]

The nominal frame interval is the median gap, so it also works on slow-motion files whose
timestamps were stretched for playback (e.g. Samsung's own slow-mo mode).
"""
import glob
import sys

import av
import numpy as np

paths = sorted(p for arg in sys.argv[1:] for p in (glob.glob(arg) or [arg]))
for path in paths:
    with av.open(path) as c:
        s = c.streams.video[0]
        tb = float(s.time_base)
        pts = np.array(sorted(p.pts for p in c.demux(s) if p.pts is not None), dtype=np.float64) * tb
    gaps = np.diff(pts)
    step = float(np.median(gaps))
    big = gaps > step * 1.5
    missing = int(np.sum(np.round(gaps[big] / step) - 1))
    span = pts[-1] - pts[0]
    print(f"{path.split(chr(92))[-1]}")
    print(f"  {len(pts)} frames over {span:.2f} s (container), median step {step * 1000:.2f} ms "
          f"= {1 / step:.1f} fps nominal")
    if big.any():
        sizes = np.round(gaps[big] / step).astype(int) - 1
        print(f"  drops: {int(big.sum())} gaps, ~{missing} frames missing "
              f"({missing / (len(pts) + missing) * 100:.1f}%), gap sizes (frames: count) "
              f"{ {int(k): int(v) for k, v in zip(*np.unique(sizes, return_counts=True))} }")
    else:
        print("  drops: none")
