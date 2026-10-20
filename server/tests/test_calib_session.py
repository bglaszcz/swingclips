"""GET /api/calib/session: the latest calibration session in full, or one by its id (the shot tracer asks
for the session a swing's 3D is on).

  cd server && python -m unittest tests.test_calib_session
"""
import os
import sys
import tempfile
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

SESSIONS = [{"created": 1.0, "id": "2026-10-02_144534", "cameras": {}},
            {"created": 2.0, "id": "2026-10-06_145832", "cameras": {}}]


@unittest.skipIf(TestClient is None, "needs httpx")
class CalibSession(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app.app)

    def test_latest_without_id(self):
        with mock.patch.object(app.calib, "sessions", lambda: SESSIONS):
            self.assertEqual(self.client.get("/api/calib/session").json()["id"], "2026-10-06_145832")

    def test_by_id(self):
        with mock.patch.object(app.calib, "sessions", lambda: SESSIONS):
            self.assertEqual(self.client.get("/api/calib/session?id=2026-10-02_144534").json()["id"], "2026-10-02_144534")
            self.assertEqual(self.client.get("/api/calib/session?id=nope").status_code, 404)

    def test_none_yet(self):
        with mock.patch.object(app.calib, "sessions", lambda: []):
            self.assertEqual(self.client.get("/api/calib/session").status_code, 404)


if __name__ == "__main__":
    unittest.main()
