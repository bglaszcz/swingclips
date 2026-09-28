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
        # A shoe's rivet: the right size and row, but on a foot (Sep 28, Crocs down the line).
        self.assertFalse(pose.ball_fits(DTL, doc_with(dict(dtl, x=0.505), 2.016)))

    def test_the_ball_starting_to_move_is_gone_face_on(self):
        # A real face-on clip: the ball sits (0.957), then one frame shows it as a streak leaving its
        # spot (0.683), then the phone dropped 4 frames. That streak frame is impact.
        dt = 1 / 240
        times = [1.8 + i * dt for i in range(75)]           # settled, up to 2.1072
        scores = [0.957] * 75
        times.append(2.1113)
        scores.append(0.683)
        times += [2.1321 + i * dt for i in range(240)]      # gone for good
        scores += [0.07 if i % 2 else -0.3 for i in range(240)]
        face = pose.ball_leaves(times, scores, pose.BALL_STILL["face"])
        self.assertAlmostEqual(times[face[0]], 2.1113)
        # With the down-the-line cutoff the streak still counts as the ball.
        dtl = pose.ball_leaves(times, scores, pose.BALL_STILL["dtl"])
        self.assertAlmostEqual(times[dtl[0]], 2.1321)

    def test_a_current_impact_is_kept(self):
        # A ball that passes its checks and was timed by the current search is kept as it was (an
        # older one is found again: that needs the video).
        ball = {"x": 0.55, "y": 0.88 + 0.2 * 0.33, "r": 0.018 * 0.33}
        doc = dict(doc_with(ball, 2.079), ballVersion=pose.BALL_TIMING_VERSION)
        self.assertEqual(pose.find_ball_again(FACE, doc, None, 1)["impact"], 2.079)

    def test_no_strike_in_the_name(self):
        ball = {"x": 0.55, "y": 0.88 + 0.2 * 0.33, "r": 0.018 * 0.33}
        self.assertTrue(pose.ball_fits("swing_1920x1080_240fps_1790206444.mp4", doc_with(ball, 2.3)))


if __name__ == "__main__":
    unittest.main()
