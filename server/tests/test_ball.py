"""The ball search's checks (pose.py): the clip name's angle and heard strike, and whether a saved
ball passes (left near the heard strike, a ball's size, where a ball sits for the angle)."""
import sys
import unittest
from pathlib import Path

sys.path[:0] = [str(Path(__file__).parent.parent)]

import pose  # noqa: E402


def doc_with(ball, impact, feet_y=0.88, nose_y=0.55):
    """A saved pose result's first frame: nose and feet at those heights (nose-to-feet 0.33)."""
    lm = [0.5, 0.5, 0.9] * 33
    lm[pose.NOSE * 3 + 1] = nose_y
    for i in pose.FEET:
        lm[i * 3 + 1] = feet_y
    return {"version": 6, "ball": ball, "impact": impact, "frames": [{"t": 0.0, "lm": lm}]}


FACE = "swing_face_1920x1080_240fps_1790354261_2089ms.mp4"
DTL = "swing_dtl_1920x1080_240fps_1790354261_2066ms.mp4"


class BallTest(unittest.TestCase):
    def test_clip_facts(self):
        self.assertEqual(pose.clip_facts("D:/clips/" + FACE), ("face", 2.089))
        self.assertEqual(pose.clip_facts(DTL), ("dtl", 2.066))
        self.assertEqual(pose.clip_facts("swing_1920x1080_240fps_1790206444.mp4"), (None, None))
        self.assertEqual(pose.clip_facts("something else.mp4"), (None, None))

    def test_a_real_ball_passes(self):
        # Face-on: 0.2 of the golfer's height below the feet, radius 1.8% of it, gone 10 ms before the strike.
        ball = {"x": 0.55, "y": 0.88 + 0.2 * 0.33, "r": 0.018 * 0.33}
        self.assertTrue(pose.ball_fits(FACE, doc_with(ball, 2.079)))

    def test_the_wrong_spots_fail(self):
        good = {"x": 0.55, "y": 0.88 + 0.2 * 0.33, "r": 0.018 * 0.33}
        self.assertFalse(pose.ball_fits(FACE, doc_with(good, 2.195)))                       # gone after the strike
        self.assertFalse(pose.ball_fits(FACE, doc_with(dict(good, r=0.009 * 0.33), 2.079)))  # too small
        self.assertFalse(pose.ball_fits(FACE, doc_with(dict(good, y=0.88 - 0.27 * 0.33), 2.079)))  # above the feet
        self.assertFalse(pose.ball_fits(FACE, doc_with(None, None)))                        # none found
        # Down the line the ball sits a little above the feet, and the phone hears it later.
        dtl = {"x": 0.6, "y": 0.88 - 0.08 * 0.33, "r": 0.015 * 0.33}
        self.assertTrue(pose.ball_fits(DTL, doc_with(dtl, 2.016)))
        self.assertFalse(pose.ball_fits(DTL, doc_with(dict(dtl, r=0.032 * 0.33), 2.016)))   # too big

    def test_no_strike_in_the_name(self):
        ball = {"x": 0.55, "y": 0.88 + 0.2 * 0.33, "r": 0.018 * 0.33}
        self.assertTrue(pose.ball_fits("swing_1920x1080_240fps_1790206444.mp4", doc_with(ball, 2.3)))


if __name__ == "__main__":
    unittest.main()
