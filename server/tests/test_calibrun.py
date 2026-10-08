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


def lens_clip(path: Path, views: int = 14, repeat: int = 4, tilt: float = 0.6) -> None:
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
        rb = cv2.Rodrigues(rng.uniform(-tilt, tilt, 3))[0]
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


class TripodSpotApi(unittest.TestCase):
    """The tripod setup page's saved spot: the camera's latest still kept, a new one replaces it and
    the old one goes to the trash folder."""

    def test_save_and_replace(self):
        from fastapi.testclient import TestClient
        import app
        app.TRIPOD_DIR = TMP / "tripods"
        client = TestClient(app.app)
        saved_latest = dict(app.camera_setup.latest)
        try:
            app.camera_setup.latest.pop("dtl", None)
            self.assertEqual(client.post("/api/tripods/dtl", json={}).status_code, 409)
            self.assertEqual(client.post("/api/tripods/nope", json={}).status_code, 404)
            lm = [0.5] * 99
            app.camera_setup.latest["dtl"] = {"verdict": {"lm": lm, "ok": True, "time": time.time()},
                                              "jpeg": b"small", "big": b"big one"}
            self.assertEqual(client.get("/api/setup/dtl.jpg?big=1").content, b"big one")
            self.assertEqual(client.get("/api/setup/dtl.jpg").content, b"small")
            out = client.post("/api/tripods/dtl", json={"note": "40 in high"}).json()
            self.assertEqual(out["dtl"]["note"], "40 in high")
            self.assertEqual(out["dtl"]["lm"], lm)
            self.assertIsNone(out["face"] if "face" not in saved_latest else None)
            self.assertEqual(client.get("/api/tripods/dtl.jpg").content, b"big one")
            app.camera_setup.latest["dtl"]["big"] = b"newer"
            client.post("/api/tripods/dtl", json={})
            self.assertEqual(client.get("/api/tripods/dtl.jpg").content, b"newer")
            self.assertTrue(list((app.TRASH_DIR / "tripods").glob("dtl_*.jpg")))
            self.assertEqual(client.get("/tripods").status_code, 200)
        finally:
            app.camera_setup.latest.clear()
            app.camera_setup.latest.update(saved_latest)


class KeepGoodLensTest(unittest.TestCase):
    def test_a_worse_try_never_replaces_a_good_lens(self):
        import calib
        good_clip = TMP / "swing_face_1920x1080_240fps_1790000000_6000ms.mp4"
        flat_clip = TMP / "swing_face_1920x1080_240fps_1790000100_6000ms.mp4"
        lens_clip(good_clip)
        lens_clip(flat_clip, tilt=0.1)
        try:
            self.assertEqual(calib.main(["lens", "--phone", "keeper", str(good_clip)]), 0)
            out = calib.lens_file("keeper", "1920x1080_240fps")
            before = out.read_text(encoding="utf-8")
            self.assertEqual(calib.main(["lens", "--phone", "keeper", str(flat_clip)]), 2)
            self.assertEqual(out.read_text(encoding="utf-8"), before)
            self.assertTrue(list((calib.CALIB_DIR / "tries").glob("keeper-1920x1080_240fps-*.json")))
        finally:
            good_clip.unlink(missing_ok=True)
            flat_clip.unlink(missing_ok=True)


class LensBoardTest(unittest.TestCase):
    """The lens board on a phone whose video blooms (white spreading into black), and a recording
    with the board never tilted."""

    @classmethod
    def setUpClass(cls):
        import calib
        cls.calib = calib
        cls.cam = syn.session()["cameras"]["face"]
        cls.ray = syn.rays(cls.cam)

    def view(self, rng, tilt):
        spec, (w, h) = board.LENS, board.LENS.size_mm
        k = np.array(self.cam["K"])
        u, v, d = rng.uniform(0.2, 0.8) * 1080, rng.uniform(0.15, 0.85) * 1920, rng.uniform(0.45, 0.8)
        rb = cv2.Rodrigues(rng.uniform(-tilt, tilt, 3))[0]
        tb = np.array([(u - k[0, 2]) / k[0, 0] * d, (v - k[1, 2]) / k[1, 1] * d, d]) - rb @ [w / 2000, h / 2000, 0]
        return syn.render_board(spec, rb, tb, self.cam, self.ray, px_per_mm=8)

    def test_blooming_board_still_read(self):
        rng = np.random.default_rng(5)
        img = self.view(rng, 0.3)
        clean = self.calib.detect(img, board.LENS)
        bloomed = cv2.dilate(img, np.ones((5, 5), np.uint8))       # white 2 px wider each way
        markers = cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(board.DICTIONARY))
        _, ids, _ = markers.detectMarkers(bloomed)
        self.assertLess(0 if ids is None else len(ids), 6)          # read as it is, the markers fail
        got = self.calib.detect(bloomed, board.LENS)
        self.assertIsNotNone(got)
        self.assertGreaterEqual(len(got[1]), 0.75 * len(clean[1]))
        common, a, b = np.intersect1d(clean[1], got[1], return_indices=True)
        self.assertLess(np.median(np.linalg.norm(clean[0][a] - got[0][b], axis=1)), 0.5)

    def test_flat_on_board_is_not_good(self):
        rng = np.random.default_rng(6)
        views = [v for v in (self.calib.detect(self.view(rng, 0.12), board.LENS) for _ in range(16)) if v is not None]
        c = self.calib.calibrate(views, tuple(self.cam["imageSize"]))
        self.assertFalse(c["good"])
        self.assertIn("tilt", self.calib.verdict(c))


class CalibHealthTest(unittest.TestCase):
    def test_calib_health_calculation(self):
        import swing3d
        sessions = [
            {"id": "2026-10-02_144534", "created": 1790970334.0, "method": "board"},
            {"id": "2026-10-06_135224", "created": 1791312744.0, "method": "body"},
            {"id": "2026-10-06_145832", "created": 1791316712.0, "method": "body"},
        ]
        # Swings for session 145832: 5 swings, 2 lost lead shoulder at setup (> 20%)
        records = {
            "s1": {
                "key3d": "2026-10-06_145832|tri2|check3",
                "body3d": {
                    "setupMissing": ["lead shoulder"],
                    "reprojection": {"address": {"median": 3.4, "p90": 13.0}},
                },
            },
            "s2": {
                "key3d": "2026-10-06_145832|tri2|check3",
                "body3d": {
                    "setupMissing": ["lead shoulder"],
                    "reprojection": {"address": {"median": 3.6, "p90": 14.0}},
                },
            },
            "s3": {
                "key3d": "2026-10-06_145832|tri2|check3",
                "body3d": {
                    "setupMissing": [],
                    "addressError": {"median": 3.2, "p90": 11.0},
                },
            },
            "s4": {
                "key3d": "2026-10-06_145832|tri2|check3",
                "body3d": {
                    "setupMissing": [],
                    "addressError": {"median": 3.0, "p90": 10.0},
                },
            },
            "s5": {
                "key3d": "2026-10-06_145832|tri2|check3",
                "body3d": {
                    "setupMissing": [],
                    "addressError": {"median": 3.5, "p90": 12.0},
                },
            },
            # Swings for session 135224: 2 swings, 0 lost
            "s6": {
                "key3d": "2026-10-06_135224|tri2|check3",
                "body3d": {
                    "setupMissing": [],
                    "reprojection": {"address": {"median": 2.7, "p90": 6.8}},
                },
            },
            "s7": {
                "key3d": "2026-10-06_135224|tri2|check3",
                "body3d": {
                    "setupMissing": [],
                    "addressError": {"median": 2.5, "p90": 6.4},
                },
            },
        }

        h = swing3d.calib_health(sessions, records)
        # Should return the latest 2 sessions in reverse order
        self.assertEqual(len(h), 2)
        latest, prev = h[0], h[1]

        # Latest session (145832)
        self.assertEqual(latest["id"], "2026-10-06_145832")
        self.assertEqual(latest["method"], "body")
        self.assertEqual(latest["swings"], 5)
        self.assertEqual(latest["lostAtSetup"], 2)
        self.assertEqual(latest["mostLost"], "lead shoulder")
        self.assertEqual(latest["lostJoints"], {"lead shoulder": 2})
        self.assertEqual(latest["typical"], 3.4)  # median of [3.4, 3.6, 3.2, 3.0, 3.5] = 3.4
        self.assertEqual(latest["worstTenth"], 12.0)  # median of [13, 14, 11, 10, 12] = 12.0
        self.assertTrue(latest["recalibrate"])  # 2/5 = 40% > 20%
        # Check that addressError was stored in record
        self.assertEqual(records["s1"]["body3d"]["addressError"], {"median": 3.4, "p90": 13.0})

        # Previous session (135224)
        self.assertEqual(prev["id"], "2026-10-06_135224")
        self.assertEqual(prev["swings"], 2)
        self.assertEqual(prev["lostAtSetup"], 0)
        self.assertIsNone(prev["mostLost"])
        self.assertEqual(prev["typical"], 2.6)  # median of [2.7, 2.5] = 2.6
        self.assertEqual(prev["worstTenth"], 6.6)  # median of [6.8, 6.4] = 6.6
        self.assertFalse(prev["recalibrate"])

        # Empty sessions
        self.assertEqual(swing3d.calib_health([], records), [])

    def test_api_calib_returns_health(self):
        from fastapi.testclient import TestClient
        import app
        client = TestClient(app.app)
        res = client.get("/api/calib")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("health", data)
        self.assertIsInstance(data["health"], list)


if __name__ == "__main__":
    unittest.main()

