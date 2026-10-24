"""Uploads from the capture app, with and without what its camera used (shutter, ISO); a retry that
comes in while the first try is still open (each request has its own part file), and a body that stops
coming.

  cd server && python -m unittest discover tests
"""
import asyncio
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).parent
# app.py reads its folders when it's imported (another test may have imported it already).
os.environ.setdefault("SWINGCLIPS_CLIPS", str(Path(tempfile.mkdtemp(prefix="swingclips-test-")) / "clips"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import app  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from starlette.requests import Request  # noqa: E402
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

    def test_frames_and_heat_kept(self):
        # Capture app 0.13: the clip's frames, how many it's missing, and Android's heat level.
        name = "swing_face_1280x720_240fps_1789000151_2000ms.mp4"
        r = self.client.post(f"/api/upload?name={name}&shutter=Auto&exposure=auto&exposure_ns=4001007&iso=2998"
                             f"&frame_ns=4166666&frames=1180&dropped=24&thermal=2", content=b"video")
        self.assertEqual(r.status_code, 200)
        cam = self.listed(name)["camera"]
        self.assertEqual((cam["frames"], cam["dropped"], cam["thermal"]), (1180, 24, 2))

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

    def test_lost_frames_without_the_frame_count(self):
        # Once a 500 after the clip was saved (frames + dropped with no frames).
        name = "swing_face_1280x720_240fps_1789000501_2000ms.mp4"
        r = self.client.post(f"/api/upload?name={name}&dropped=3", content=b"video")
        self.assertEqual(r.status_code, 200)

    def test_a_short_body_is_refused_and_leaves_nothing(self):
        name = "swing_face_1280x720_240fps_1789000601_2000ms.mp4"
        r = self.client.post(f"/api/upload?name={name}", content=b"video", headers={"X-Clip-Size": "999"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(list(app.CLIPS_DIR.glob(name + "*")), [])


NO_CAMERA = dict(shutter=None, exposure=None, exposure_ns=None, iso=None, frame_ns=None, frames=None,
                 dropped=None, thermal=None)
SCOPE = {"type": "http", "method": "POST", "path": "/api/upload", "headers": [], "query_string": b""}


class StalledUpload(unittest.TestCase):
    def setUp(self):
        app.CLIPS_DIR.mkdir(parents=True, exist_ok=True)
        self.name = f"swing_face_1920x1080_240fps_{int(time.time()) - 7000}_1000ms.mp4"

    def tearDown(self):
        for f in app.CLIPS_DIR.glob(self.name + "*"):
            f.unlink()

    def test_a_retry_while_the_first_try_hangs_lands_whole(self):
        # The phone went off the Wi-Fi mid-clip and retried: the first request never ends on its own.
        async def run():
            sent = asyncio.Event()

            async def phone_went_away():
                if not sent.is_set():
                    sent.set()
                    return {"type": "http.request", "body": b"half a cl", "more_body": True}
                await asyncio.Event().wait()   # nothing more ever comes

            async def whole():
                return {"type": "http.request", "body": b"the whole clip", "more_body": False}

            first = asyncio.create_task(app.upload(self.name, Request(SCOPE, phone_went_away), **NO_CAMERA))
            await sent.wait()
            await asyncio.sleep(0.05)
            again = await app.upload(self.name, Request(SCOPE, whole), **NO_CAMERA)
            with self.assertRaises(HTTPException) as gave_up:
                await first
            return again, gave_up.exception.status_code

        with mock.patch.object(app, "UPLOAD_STALL_S", 0.3):
            again, code = asyncio.run(run())
        self.assertEqual(again["size"], len(b"the whole clip"))
        self.assertEqual(code, 408)
        self.assertEqual((app.CLIPS_DIR / self.name).read_bytes(), b"the whole clip")
        self.assertEqual(list(app.CLIPS_DIR.glob(self.name + "*.part")), [])   # neither left a part behind


if __name__ == "__main__":
    unittest.main()
