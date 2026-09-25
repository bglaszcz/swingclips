"""Uploads from the capture app, with and without what its camera used (shutter, ISO).

  cd server && python -m unittest discover tests
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).parent
# app.py reads its folders when it's imported (another test may have imported it already).
os.environ.setdefault("SWINGCLIPS_CLIPS", str(Path(tempfile.mkdtemp(prefix="swingclips-test-")) / "clips"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import app  # noqa: E402
try:
    from fastapi.testclient import TestClient  # needs httpx, which the server itself doesn't
except (ImportError, RuntimeError):
    TestClient = None


@unittest.skipIf(TestClient is None, "needs httpx")
class UploadTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app.app)

    def listed(self, name):
        return next(c for c in self.client.get("/api/clips").json() if c["name"] == name)

    def test_older_app_uploads_without_camera_info(self):
        name = "swing_face_1280x720_240fps_1789000001_2000ms.mp4"
        r = self.client.post(f"/api/upload?name={name}", content=b"video")
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(self.listed(name)["camera"])
        self.assertFalse((app.CLIPS_DIR / (name + app.CAMERA_SUFFIX)).exists())

    def test_camera_info_kept_and_listed(self):
        name = "swing_dtl_1280x720_240fps_1789000101_2000ms.mp4"
        r = self.client.post(f"/api/upload?name={name}&shutter=1/1000&exposure=manual"
                             f"&exposure_ns=1000000&iso=1600&frame_ns=4166666", content=b"video")
        self.assertEqual(r.status_code, 200)
        cam = self.listed(name)["camera"]
        self.assertEqual(cam, {"shutter": "1/1000", "exposure": "manual", "exposureNs": 1000000, "iso": 1600,
                               "frameNs": 4166666, "shutterSpeed": 1000})
        # Still a two-angle swing clip as before.
        self.assertEqual(self.listed(name)["angle"], "dtl")

    def test_retry_fills_in_missing_camera_info(self):
        name = "swing_face_1280x720_240fps_1789000201_2000ms.mp4"
        self.client.post(f"/api/upload?name={name}", content=b"video")
        r = self.client.post(f"/api/upload?name={name}&exposure=auto&exposure_ns=4166666&iso=800", content=b"video")
        self.assertTrue(r.json()["duplicate"])
        self.assertEqual(self.listed(name)["camera"]["shutterSpeed"], 240)

    def test_bad_values_refused(self):
        name = "swing_face_1280x720_240fps_1789000301_2000ms.mp4"
        r = self.client.post(f"/api/upload?name={name}&iso=lots", content=b"video")
        self.assertEqual(r.status_code, 422)
        self.assertFalse((app.CLIPS_DIR / name).exists())

    def test_trash_and_restore_carry_camera_info(self):
        name = "swing_face_1280x720_240fps_1789000401_2000ms.mp4"
        self.client.post(f"/api/upload?name={name}&exposure=manual&exposure_ns=500000&iso=3200", content=b"video")
        self.assertTrue(app.move_clip(name, to_trash=True))
        self.assertTrue((app.TRASH_DIR / (name + app.CAMERA_SUFFIX)).exists())
        self.assertTrue(app.move_clip(name, to_trash=False))
        self.assertEqual(self.listed(name)["camera"]["iso"], 3200)


if __name__ == "__main__":
    unittest.main()
