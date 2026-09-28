"""The clubhead leaving the ball (pose.clubhead_motion, the Labels page's Clubhead motion trace):
flicker and noise while still don't count; the change starts where the clubhead starts to move.

  cd server && python -m unittest tests.test_clubmotion
"""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import pose  # noqa: E402

FPS = 240


def frames(start_move=0.5, seconds=0.9, flicker=0.03, seed=1):
    """Normalized crops as clubhead_crops makes them: a dark clubhead on a light mat, still until
    `start_move` s, then sliding away faster and faster; the lights flicker at 120 Hz."""
    rng = np.random.default_rng(seed)
    out = []
    for k in range(int(seconds * FPS)):
        t = k / FPS
        img = np.full((36, 72), 150.0)
        dt = max(0.0, t - start_move)
        x = 30 - 400 * dt * dt          # px: 1 px after 50 ms, 4 px after 100 ms
        xs = np.arange(72)
        img[12:30, (xs > x - 8) & (xs < x + 8)] = 40.0
        img *= 1 + flicker * (1 if k % 2 else -1)
        img += rng.normal(0, 3, img.shape)
        img = img.astype(np.float32)
        img -= img.mean()
        out.append((t, img / (img.std() + 1e-6)))
    return out


class ClubheadMotionTest(unittest.TestCase):
    def test_onset_where_the_clubhead_starts(self):
        for start in (0.45, 0.5, 0.6):
            got = pose.clubhead_motion(frames(start), quiet_until=start - 0.2)
            self.assertIsNotNone(got["onset"], start)
            # Within a few frames of the start (it has to move a pixel or so to show).
            self.assertGreaterEqual(got["onset"], start - 2 / FPS, start)
            self.assertLessEqual(got["onset"], start + 0.04, start)
            self.assertEqual(len(got["t"]), len(got["v"]))

    def test_still_club_no_onset(self):
        crops = frames(start_move=10)
        got = pose.clubhead_motion(crops, quiet_until=0.3)
        self.assertIsNone(got["onset"])

    def test_too_little_before(self):
        self.assertIsNone(pose.clubhead_motion(frames(), quiet_until=0.05))


if __name__ == "__main__":
    unittest.main()
