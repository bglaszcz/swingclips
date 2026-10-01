"""The 3D calibration page (calibrun.py, app.py /api/calib/*): recordings tag clips by time, the
lens recording lengthens the phones' lead-in, and Calibrate runs calib.py on the recording's clips
(here a made-up lens-board clip, synthetic3d.py, run end to end).

  cd server && python -m unittest tests.test_calibrun
"""
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).parent
TMP = Path(tempfile.mkdtemp(prefix="swingclips-calibrun-"))
os.environ.setdefault("SWINGCLIPS_CLIPS", str(TMP / "clips"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import board  # noqa: E402
import calibrun  # noqa: E402
import drills  # noqa: E402
import synthetic3d as syn  # noqa: E402
from test_status import Clock, T0  # noqa: E402


class RunsTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.path = Path(tempfile.mkdtemp(prefix="swingclips-runs-")) / "recordings.json"
        self.r = calibrun.Runs(self.path, self.clock)

    def test_tags_by_time_and_survives_a_restart(self):
        self.assertIsNone(self.r.pre())
        self.r.record("lens", "face")
        self.assertEqual(self.r.pre(), calibrun.LENS_PRE_S)
        # A clip is named by its start, before the clap: it still counts.
        self.assertEqual(self.r.kind_at(T0 - calibrun.LENS_PRE_S), "lens")
        self.clock.t += 60
        self.r.record("mat")
        self.assertIsNone(self.r.pre())
        self.clock.t += 60
        self.r.record(None)
        again = calibrun.Runs(self.path, self.clock)
        self.assertEqual(again.kind_at(T0 + 30), "lens")
        self.assertEqual(again.kind_at(T0 + 90), "mat")
        self.assertIsNone(again.kind_at(T0 + 200))
        self.assertIsNone(again.kind_at(T0 - 60))
        self.assertEqual(again.latest("lens", "face")["from"], T0)
        self.assertIsNone(again.latest("lens", "dtl"))

    def test_refused(self):
        with self.assertRaises(ValueError):
            self.r.record("nope")
        with self.assertRaises(ValueError):
            self.r.record("lens")              # which phone?

    def test_left_on_it_ends(self):
        self.r.record("mat")
        self.clock.t += calibrun.IDLE_END_S + 1
        self.r.check(T0)
        self.assertIsNone(self.r.state()["current"])


def lens_clip(path: Path, views: int = 14, repeat: int = 4) -> None:
    """A clip of the lens board waved in front of a made-up phone (each view `repeat` frames)."""
    rng = np.random.default_rng(3)
    cam = syn.session()["cameras"]["face"]
    ray = syn.rays(cam)
    spec, (w, h) = board.LENS, board.LENS.size_mm
    k = np.array(cam["K"])
    size = tuple(cam["imageSize"])
    out = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 30, size)
    for _ in range(views):
        u, v, d = rng.uniform(0.15, 0.85) * size[0], rng.uniform(0.12, 0.88) * size[1], rng.uniform(0.45, 0.8)
        rb = cv2.Rodrigues(rng.uniform(-0.6, 0.6, 3))[0]
        tb = np.array([(u - k[0, 2]) / k[0, 0] * d, (v - k[1, 2]) / k[1, 1] * d, d]) - rb @ [w / 2000, h / 2000, 0]
        img = syn.render_board(spec, rb, tb, cam, ray, px_per_mm=8)
        frame = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR) if img.ndim == 2 else img
        for _ in range(repeat):
            out.write(frame)
    out.release()


class Api(unittest.TestCase):
    def test_lens_from_the_page(self):
        from fastapi.testclient import TestClient
        import app
        saved = app.calib_runs
        app.calib_runs = calibrun.Runs(app.calib.CALIB_DIR / "recordings-api.json")
        client = TestClient(app.app)
        app.CLIPS_DIR.mkdir(parents=True, exist_ok=True)
        made = []
        try:
            self.assertEqual(client.post("/api/calib/run", json={"kind": "lens", "angle": "face"}).status_code, 400)
            on = client.post("/api/calib/record", json={"kind": "lens", "angle": "face"}).json()["recording"]
            self.assertEqual(app.session_status.pre_wanted, calibrun.LENS_PRE_S)
            t = int(on["from"]) + 1
            face = app.CLIPS_DIR / f"swing_face_1920x1080_240fps_{t}_6000ms.mp4"
            dtl = app.CLIPS_DIR / f"swing_dtl_1920x1080_240fps_{t}_6000ms.mp4"
            lens_clip(face)
            dtl.write_bytes(b"x")              # the other phone heard the clap too
            made = [face, dtl]
            listed = {c["name"]: c for c in app.listed_clips(with_shots=False)}
            self.assertEqual(listed[face.name]["calib"], "lens")
            self.assertTrue(listed[face.name]["excluded"])
            self.assertTrue(listed[dtl.name]["excluded"])
            st = client.get("/api/calib").json()
            self.assertEqual([c["name"] for c in st["clips"]["face"] if c["angle"] == "face"], [face.name])
            self.assertEqual(st["leftover"], [])           # the recording's still on
            # The mat board needs both phones' clips of it.
            client.post("/api/calib/record", json={"kind": "mat"})
            self.assertEqual(client.post("/api/calib/run", json={"kind": "mat"}).status_code, 400)

            st = client.post("/api/calib/run", json={"kind": "lens", "angle": "face", "phone": "test phone!"}).json()
            self.assertEqual(st["recording"]["kind"], "mat")   # a lens run leaves the mat recording on
            self.assertEqual(app.session_status.pre_wanted, drills.PRE_S)
            self.assertEqual(st["job"]["clips"], [face.name])
            give_up = time.time() + 300
            while st["job"]["code"] is None and time.time() < give_up:
                time.sleep(0.5)
                st = client.get("/api/calib").json()
            self.assertEqual(st["job"]["code"], 0, st["job"]["output"])
            self.assertIn("good", st["job"]["output"])
            self.assertEqual(st["phones"]["face"], "testphone")
            self.assertTrue(any(lens["phone"] == "testphone" and lens["good"] for lens in st["lenses"]))
            st = client.post("/api/calib/record", json={"kind": None}).json()
            self.assertEqual(sorted(st["leftover"]), sorted([dtl.name, face.name]))
        finally:
            for p in made:
                p.unlink(missing_ok=True)
            app.calib_runs = saved
            app.drills_tick()


if __name__ == "__main__":
    unittest.main()
