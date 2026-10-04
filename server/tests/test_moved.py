"""A camera moved since the latest 3D calibration (app.py camera_moved, /api/calib "moved"), and the
tripods dated back to just before those swings (/api/calib/tripods {since}) so a calibration from
them holds for them too.

  cd server && python -m unittest tests.test_moved
"""
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).parent
os.environ.setdefault("SWINGCLIPS_CLIPS", str(Path(tempfile.mkdtemp(prefix="swingclips-test-")) / "clips"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import app  # noqa: E402
try:
    from fastapi.testclient import TestClient  # needs httpx, which the server itself doesn't
except (ImportError, RuntimeError):
    TestClient = None

CAL = 1_790_970_334.0  # the latest calibration
SESSIONS = [{"created": CAL, "id": "cal", "cameras": {a: {"position": [0, 0, 0]} for a in ("face", "dtl")}}]
MOVED = "a camera seems to have moved since calibration x: at address the joints miss by 45 px (want under 5)"


def name(t):
    return f"swing_face_1920x1080_240fps_{int(t)}_2000ms.mp4"


class CameraMoved(unittest.TestCase):
    def setUp(self):
        self.saved = dict(app.swing_records)
        app.swing_records.clear()
        self.addCleanup(lambda: (app.swing_records.clear(), app.swing_records.update(self.saved)))
        patch = mock.patch.object(app.calib, "sessions", lambda: SESSIONS)
        patch.start()
        self.addCleanup(patch.stop)

    def put(self, t, why=None, ok=False, partner=True):
        app.swing_records[name(t)] = {"partner": "dtl" if partner else None, "why3d": why, "body3d": {"x": 1} if ok else None}

    def test_a_run_of_moved_swings_after_the_last_good_one(self):
        self.put(CAL + 100, ok=True)
        self.put(CAL + 200, MOVED)          # a blip, then good again
        self.put(CAL + 300, ok=True)
        start = CAL + 180_000
        for i in range(5):
            self.put(start + 25 * i, MOVED)
        self.put(start + 10, partner=False)  # one phone only: not counted either way
        got = app.camera_moved()
        self.assertEqual(got["since"], start)
        self.assertEqual(got["swings"], 5)
        self.assertIn("45 px", got["text"])

    def test_too_few_or_before_the_calibration(self):
        self.put(CAL - 500, MOVED)
        self.put(CAL - 400, MOVED)
        self.put(CAL + 100, MOVED)
        self.put(CAL + 200, MOVED)
        self.assertIsNone(app.camera_moved())
        self.put(CAL + 300, "recorded in another mode than calibrated (x)")
        self.assertIsNone(app.camera_moved())


@unittest.skipIf(TestClient is None, "needs httpx")
class TripodsSince(unittest.TestCase):
    def test_since_checked(self):
        client = TestClient(app.app)
        with mock.patch.object(app.calib, "sessions", lambda: SESSIONS), \
                mock.patch.object(app.calib_runs, "set_tripods", lambda at=None: at or time.time()):
            self.assertEqual(client.post("/api/calib/tripods", json={"since": CAL - 10}).status_code, 400)
            self.assertEqual(client.post("/api/calib/tripods", json={"since": time.time() + 3600}).status_code, 400)
            self.assertEqual(client.post("/api/calib/tripods", json={"since": CAL + 100}).status_code, 200)
            self.assertEqual(client.post("/api/calib/tripods").status_code, 200)   # the page's own button: now


if __name__ == "__main__":
    unittest.main()
