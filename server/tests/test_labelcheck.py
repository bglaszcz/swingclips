"""labelcheck.py: what the Labels view says about a label file, on made-up labels and a made-up pose."""
import gzip
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).parent
sys.path[:0] = [str(HERE.parent)]

import labelcheck  # noqa: E402

NAME = "swing_face_1920x1080_240fps_1790000000_2000ms.mp4"


def pose_with(points: dict, t=1.0, ball=(0.5, 0.9), impact=2.0):
    """One-frame pose file: MediaPipe landmarks at `points` ({index: (x, y)}), nose at top, ankles at bottom."""
    lm = [0.5, 0.5, 0.9] * 33
    for i, (x, y) in {0: (0.5, 0.2), 27: (0.45, 0.9), 28: (0.55, 0.9), **points}.items():
        lm[i * 3:i * 3 + 2] = [x, y]
    return {"version": 6, "rotation": 0, "ball": {"x": ball[0], "y": ball[1], "r": 0.01}, "impact": impact,
            "frames": [{"t": t, "lm": lm}]}


def label(frames=None, events=None, ball=(0.5, 0.9)):
    return {"schema": 1, "clip": {"name": NAME, "angle": "face"}, "partner": None,
            "events": events or {}, "ball": {"x": ball[0], "y": ball[1]} if ball else None, "frames": frames or {}}


# Face-on: the golfer's left (lead) is on the picture's right.
TRACKED = {11: (0.55, 0.35), 12: (0.45, 0.35), 23: (0.54, 0.55), 24: (0.46, 0.55)}
RIGHT = {"l_shoulder": {"x": 0.55, "y": 0.35}, "r_shoulder": {"x": 0.45, "y": 0.35},
         "l_hip": {"x": 0.54, "y": 0.55}, "r_hip": {"x": 0.46, "y": 0.55}}
SWAPPED = {"l_shoulder": {"x": 0.45, "y": 0.35}, "r_shoulder": {"x": 0.55, "y": 0.35},
           "l_hip": {"x": 0.46, "y": 0.55}, "r_hip": {"x": 0.54, "y": 0.55}}


class CheckTest(unittest.TestCase):
    def test_counts(self):
        pts = {k: {"x": 0.5, "y": 0.5} for k in labelcheck.POINTS[:9]}
        r = labelcheck.check(label({"1.000000": pts}, {"takeaway": 0.8, "p2": 1.1}), None)
        self.assertEqual((r["events"], r["pointFrames"], r["ball"]), (2, 1, True))
        self.assertEqual(r["missing"], ["p3", "p4", "p5", "p6", "impact", "p8"])
        self.assertEqual(r["issues"], [])

    def test_out_of_order(self):
        r = labelcheck.check(label(events={"takeaway": 0.8, "p2": 1.3, "p3": 1.2}), None)
        self.assertTrue(any("out of order" in i for i in r["issues"]))

    def test_left_right_swapped(self):
        pose = pose_with(TRACKED)
        ok = labelcheck.check(label({"1.000000": RIGHT}), pose)
        self.assertFalse(any("swapped" in i for i in ok["issues"]), ok["issues"])
        bad = labelcheck.check(label({"1.000000": SWAPPED}), pose)
        self.assertTrue(any("swapped at 1.000 s" in i and "shoulders" in i for i in bad["issues"]), bad["issues"])

    def test_one_crossed_pair_is_not_enough(self):
        one = dict(RIGHT, l_hip=SWAPPED["l_hip"], r_hip=SWAPPED["r_hip"])
        r = labelcheck.check(label({"1.000000": one}), pose_with(TRACKED))
        self.assertFalse(any("swapped" in i for i in r["issues"]))

    def test_ball_and_impact(self):
        pose = pose_with(TRACKED, ball=(0.5, 0.9), impact=2.0)
        r = labelcheck.check(label(events={"impact": 2.004}, ball=(0.5, 0.9)), pose)
        self.assertEqual(r["issues"], [])
        r = labelcheck.check(label(events={"impact": 1.95}, ball=(0.5, 0.5)), pose)
        self.assertTrue(any("ball is far" in i for i in r["issues"]))
        self.assertTrue(any("50 ms before" in i for i in r["issues"]))

    def test_all_blurry(self):
        pts = {k: {"x": 0.5, "y": 0.5, "blur": True} for k in labelcheck.BODY}
        r = labelcheck.check(label({"1.000000": pts}), None)
        self.assertTrue(any("blurry on 1 frame" in i for i in r["issues"]))

    def test_summary_flags_missing_other_angle(self):
        tmp = Path(tempfile.mkdtemp(prefix="swingclips-labelcheck-"))
        doc = label(events={"takeaway": 0.8})
        doc["partner"] = {"name": NAME.replace("face", "dtl"), "angle": "dtl"}
        (tmp / (NAME + ".json")).write_text(json.dumps(doc))
        pose_file = tmp / "pose.json.gz"
        pose_file.write_bytes(gzip.compress(json.dumps(pose_with(TRACKED)).encode()))
        rows = labelcheck.summary(tmp, lambda name: pose_file if name == NAME else None)
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["pose"])
        self.assertTrue(any("other camera angle" in i for i in rows[0]["issues"]))


if __name__ == "__main__":
    unittest.main()
