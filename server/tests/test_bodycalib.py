"""Placing both phones from the golfer's body (bodycalib.py, app.py place_cameras), on made-up
swings filmed by made-up phones whose positions are known (synthetic3d.py).

  cd server && python -m unittest tests.test_bodycalib
"""
import gzip
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
TMP = Path(tempfile.mkdtemp(prefix="swingclips-bodycalib-"))
os.environ.setdefault("SWINGCLIPS_CLIPS", str(TMP / "clips"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import bodycalib  # noqa: E402
import calibrun  # noqa: E402
import synthetic3d as syn  # noqa: E402
import tri  # noqa: E402

# The made-up golfer's legs, as a height (bodycalib's own share, so the scale comes out right).
HEIGHT = (syn.THIGH + syn.SHIN) / bodycalib.LEG_SHARE
DTL_START = -0.35          # the down-the-line clip starts this much earlier: offset +0.35 s


def lens(cam: dict) -> dict:
    return {"K": cam["K"], "dist": cam["dist"], "imageSize": cam["imageSize"], "mode": "1920x1080_240fps"}


def ball(cam: dict) -> dict:
    w, h = cam["imageSize"]
    p = tri.Camera(cam).project(np.array([[0.0, bodycalib.BALL_RADIUS, 0.0]]))[0]
    return {"x": p[0] / w, "y": p[1] / h, "r": 0.01}


def made_up_swings(n: int, seed: int = 1, with_ball: bool = True):
    ses = syn.session()
    rng = np.random.default_rng(seed)
    out = []
    for _ in range(n):
        face = syn.render(ses["cameras"]["face"], 0.0, 0.25, 2.0, rng)
        dtl = syn.render(ses["cameras"]["dtl"], DTL_START, 0.25, 2.0, rng, hand_vis=0.4)
        if with_ball:
            face["ball"], dtl["ball"] = ball(ses["cameras"]["face"]), ball(ses["cameras"]["dtl"])
        out.append({"face": face, "dtl": dtl, "offset": -DTL_START})
    return ses, out


class SolveTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ses, cls.swings = made_up_swings(10)

    def test_both_phones_where_they_are(self):
        cams, report = bodycalib.solve(self.swings, lens(self.ses["cameras"]["face"]),
                                       lens(self.ses["cameras"]["dtl"]), HEIGHT)
        self.assertTrue(report["good"], report)
        for angle in ("face", "dtl"):
            got, want = np.array(cams[angle]["position"]), np.array(self.ses["cameras"][angle]["position"])
            # The made-up joints have 2 px of noise each: the phones come out within a few cm, and
            # turned at most ~2 degrees (the face-on phone's position follows that angle, 3 m out).
            self.assertLess(np.linalg.norm(got - want), 0.15 if angle == "face" else 0.05, angle)
            dr = np.array(cams[angle]["R"]) @ np.array(self.ses["cameras"][angle]["R"]).T
            self.assertLess(np.degrees(np.arccos(np.clip((np.trace(dr) - 1) / 2, -1, 1))), 2.5, angle)
            self.assertEqual(cams[angle]["warnings"], [], angle)
        self.assertEqual(report["warnings"], [])
        text = bodycalib.describe(report, cams)
        self.assertIn("Face-on phone:", text)
        self.assertIn("in high", text)

    def test_scale_follows_the_height(self):
        cams, _ = bodycalib.solve(self.swings[:5], lens(self.ses["cameras"]["face"]),
                                  lens(self.ses["cameras"]["dtl"]), HEIGHT * 1.1)
        d = np.linalg.norm(np.array(cams["face"]["position"]))
        self.assertAlmostEqual(d / np.linalg.norm(self.ses["cameras"]["face"]["position"]), 1.1, delta=0.03)

    def test_tape_measure_sets_the_size(self):
        # A height 15% off (as the real setup's legs made it), and the down-the-line phone's floor
        # distance from a tape measure: the phones come out where they are anyway.
        want = {a: np.array(self.ses["cameras"][a]["position"]) for a in ("face", "dtl")}
        floor = float(np.hypot(want["dtl"][0], want["dtl"][2]))
        cams, report = bodycalib.solve(self.swings, lens(self.ses["cameras"]["face"]), lens(self.ses["cameras"]["dtl"]),
                                       HEIGHT * 1.15, floor)
        self.assertEqual(report["scaleFrom"], "tape")
        self.assertAlmostEqual(report["fromBall"]["dtl"], floor, places=6)
        self.assertAlmostEqual(report["tapeVsHeight"], 1 / 1.15, delta=0.03)
        self.assertLess(np.linalg.norm(np.array(cams["face"]["position"]) - want["face"]), 0.15)
        self.assertLess(np.linalg.norm(np.array(cams["dtl"]["position"]) - want["dtl"]), 0.05)
        self.assertLess(report["rms"]["face"], bodycalib.GOOD_RMS)
        self.assertIn("Sized by your tape measure", bodycalib.describe(report, cams))

    def test_no_ball_origin_between_the_feet(self):
        _, swings = made_up_swings(4, seed=2, with_ball=False)
        cams, report = bodycalib.solve(swings, lens(self.ses["cameras"]["face"]), lens(self.ses["cameras"]["dtl"]), HEIGHT)
        self.assertTrue(report["warnings"])
        # The made-up feet are 0.72 m behind the ball: everything shifts by that, toward the golfer.
        self.assertAlmostEqual(cams["face"]["position"][2] - self.ses["cameras"]["face"]["position"][2], 0.72, delta=0.08)

    def test_refused(self):
        fl, dl = lens(self.ses["cameras"]["face"]), lens(self.ses["cameras"]["dtl"])
        with self.assertRaises(ValueError):
            bodycalib.solve(self.swings[:2], fl, dl, HEIGHT)
        with self.assertRaises(ValueError):
            bodycalib.solve(self.swings, fl, dl, 3.0)


class FakeSummarizer:
    def call(self, name, a, b, **kw):
        assert name == "syncOffset"
        return b["impact"] - a["impact"]


class PlaceCamerasTest(unittest.TestCase):
    """The page's buttons: tripods set, then the swing worker places the cameras from the swings after it."""

    def test_from_the_page(self):
        from fastapi.testclient import TestClient
        import app
        import calib
        saved = app.calib_runs
        app.calib_runs = calibrun.Runs(calib.CALIB_DIR / "recordings-body.json")
        client = TestClient(app.app)
        ses, swings = made_up_swings(6, seed=3)
        made = []
        try:
            # Lens calibrations for both phones, as calib.py lens leaves them.
            calib.write_json(calib.CALIB_DIR / "phones.json", {"face": "fphone", "dtl": "dphone"})
            for angle, phone in (("face", "fphone"), ("dtl", "dphone")):
                calib.write_json(calib.lens_file(phone, "1920x1080_240fps"), {**lens(ses["cameras"][angle]), "name": phone})
            self.assertEqual(client.post("/api/calib/body", json={"heightIn": 70}).status_code, 409)   # tripods first
            t0 = client.post("/api/calib/tripods").json()["tripods"]
            self.assertEqual(client.post("/api/calib/body", json={"heightIn": 20}).status_code, 400)
            app.POSE_DIR.mkdir(parents=True, exist_ok=True)
            clips = {}
            for i, s in enumerate(swings):
                t = int(t0) + 10 + 20 * i
                names = {a: f"swing_{a}_1920x1080_240fps_{t}_2000ms.mp4" for a in ("face", "dtl")}
                for a in ("face", "dtl"):
                    path = app.pose_file(names[a])
                    path.write_bytes(gzip.compress(json.dumps(s[a]).encode()))
                    made.append(path)
                    clips[names[a]] = {"name": names[a], "angle": a, "pose": "done", "strike": None, "calib": None,
                                       "partner": names["dtl" if a == "face" else "face"]}
            self.assertEqual(client.post("/api/calib/body", json={"heightIn": 70, "dtlFloorIn": 5}).status_code, 400)
            st = client.post("/api/calib/body", json={"heightIn": HEIGHT / 0.0254}).json()
            self.assertEqual(st["job"]["kind"], "body")
            self.assertIsNone(st["job"]["code"])
            app.place_cameras(clips, FakeSummarizer())
            st = client.get("/api/calib").json()
            self.assertEqual(st["job"]["code"], 0, st["job"]["output"])
            self.assertEqual(len(st["job"]["clips"]), 6)
            self.assertIn("in high", st["job"]["output"])
            self.assertEqual(st["session"]["method"], "body")
            self.assertEqual(st["session"]["created"], t0)        # holds for the swings since the tripods
            self.assertAlmostEqual(st["height"], HEIGHT, places=3)
            pos = st["session"]["cameras"]["face"]["position"]
            self.assertLess(np.linalg.norm(np.array(pos) - ses["cameras"]["face"]["position"]), 0.2)
            # The 3D pass picks it for those swings.
            s = calib.session_before(t0 + 30)
            self.assertEqual(s["method"], "body")
        finally:
            for p in made:
                p.unlink(missing_ok=True)
            for f in (calib.CALIB_DIR / "sessions").glob("*.json"):
                if json.loads(f.read_text(encoding="utf-8")).get("method") == "body":
                    f.unlink()
            app.calib_runs = saved


if __name__ == "__main__":
    unittest.main()
