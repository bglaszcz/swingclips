"""The night worker's side of the server (night.py, app.py /api/night) and the deep pass redone after
the club model changes (app.needs_deep)."""
import gzip
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).parent
TMP = Path(tempfile.mkdtemp(prefix="swingclips-night-test-"))
os.environ.setdefault("SWINGCLIPS_CLIPS", str(TMP / "clips"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import app  # noqa: E402
import night  # noqa: E402

try:
    from fastapi.testclient import TestClient  # needs httpx, which the server itself doesn't
except (ImportError, RuntimeError):
    TestClient = None


def clip(name, angle="face", recorded="2026-10-04T17:00:00", pose="done"):
    return {"name": name, "angle": angle, "recorded": recorded, "pose": pose}


def pose_doc(**extra) -> bytes:
    return gzip.compress(json.dumps({"version": 6, **extra, "frames": [{"t": 0.0, "lm": None}]}, separators=(",", ":")).encode())


class NightTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(dir=TMP))

    def test_order(self):
        """Labeled clips first, then face-on before down the line, newest first; only analyzed ones,
        and not the ones handed out a moment ago."""
        clips = [clip("a", recorded="2026-10-01T10:00:00"), clip("b", recorded="2026-10-04T10:00:00"),
                 clip("c", "dtl", recorded="2026-10-05T10:00:00"), clip("d", pose="queued", recorded="2026-10-06T10:00:00")]
        self.assertEqual(night.next_clip(clips, self.dir, {"a"}, set())["name"], "a")
        self.assertEqual(night.next_clip(clips, self.dir, set(), set())["name"], "b")
        self.assertEqual(night.next_clip(clips, self.dir, set(), {"b"})["name"], "a")
        self.assertEqual(night.next_clip(clips, self.dir, set(), {"a", "b"})["name"], "c")
        self.assertIsNone(night.next_clip(clips, self.dir, set(), {"a", "b", "c"}))

    def test_saved_and_sent_again_after_a_new_version(self):
        stamp = night.save(self.dir, "b", pose_doc(night={"version": 0}), {"worker": "pc", "at": 5})
        self.assertEqual(stamp, {"version": night.VERSION, "worker": "pc", "at": 5})
        path = night.night_file(self.dir, "b")
        self.assertEqual(night.version_of(path), night.VERSION)
        self.assertTrue(gzip.decompress(path.read_bytes()).startswith(b'{"night":{"version":'))
        clips = [clip("b")]
        self.assertIsNone(night.next_clip(clips, self.dir, set(), set()))
        with mock.patch.object(night, "VERSION", night.VERSION + 1):
            self.assertEqual(night.next_clip(clips, self.dir, set(), set())["name"], "b")

    def test_not_a_pose_file(self):
        with self.assertRaises(ValueError):
            night.save(self.dir, "b", gzip.compress(b'{"x": 1}'), {})
        self.assertFalse(night.night_file(self.dir, "b").exists())

    def test_differences(self):
        ours = {"times": {"p1": 0.5, "p4": 1.2, "p7": 1.5, "p8": None}}
        theirs = {"times": {"p1": 0.5, "p4": 1.25, "p7": 1.4958, "p8": 1.7}}
        diff = night.differences(ours, theirs)
        self.assertEqual(diff, {"p1": 0.0, "p4": 50.0, "p7": -4.2})
        self.assertEqual(night.worst(diff), ("p4", 50.0))
        self.assertIsNone(night.worst(night.differences(None, theirs)))


class DeepAgainTest(unittest.TestCase):
    def test_new_club_model(self):
        """A clip deep-analyzed with another club model needs the deep pass again; one never
        deep-analyzed does; one with this model doesn't; no club model compares only the pass."""
        stamps = {"old": ("m", 4, True, True, 1, "club-deep@aaaa"), "now": ("m", 4, True, True, 1, "club-deep@bbbb"),
                  "never": ("m", 4, False, False, 0, None)}
        with mock.patch.object(app, "_pose_stamp", lambda n: stamps.get(n)):
            self.assertTrue(app.needs_deep("old", "club-deep@bbbb"))
            self.assertFalse(app.needs_deep("now", "club-deep@bbbb"))
            self.assertTrue(app.needs_deep("never", "club-deep@bbbb"))
            self.assertFalse(app.needs_deep("old", None))
            self.assertFalse(app.needs_deep("missing", "club-deep@bbbb"))
            self.assertFalse(app.needs_deep("now", "club-s640-v2@bbbb"))  # the same file, renamed

    def test_club_stamp_read_from_the_pose_file(self):
        app.POSE_DIR.mkdir(parents=True, exist_ok=True)
        name = "swing_face_1920x1080_240fps_1790000000_2000ms.mp4"
        app.pose_file(name).write_bytes(pose_doc(**{"pass": "deep", "model": "rtmpose-m-256x192",
                                                    "clubModel": "club-deep@0173e707"}))
        try:
            self.assertEqual(app._pose_stamp(name)[5], "club-deep@0173e707")
        finally:
            app.pose_file(name).unlink()


class WorkerHoursTest(unittest.TestCase):
    def test_stop_at_and_hours(self):
        from datetime import datetime
        import night_worker
        at2 = datetime(2026, 10, 5, 2, 0)
        self.assertEqual(night_worker.deadline(7, at2), datetime(2026, 10, 5, 7, 0))
        # Started after 7 (by hand in the day): the next morning's 7.
        self.assertEqual(night_worker.deadline(7, datetime(2026, 10, 5, 11, 0)), datetime(2026, 10, 6, 7, 0))
        self.assertIsNone(night_worker.deadline(None, at2))
        hours = night_worker.parse_hours("23-7")
        self.assertTrue(night_worker.in_hours(hours, datetime(2026, 10, 5, 2, 0)))
        self.assertFalse(night_worker.in_hours(hours, datetime(2026, 10, 5, 12, 0)))

    def test_only_one_worker(self):
        import night_worker
        lock = TMP / "night-worker.lock"  # not the real one: a worker may be running on this PC
        first = night_worker.only_one(lock)
        try:
            self.assertIsNotNone(first)
            self.assertIsNone(night_worker.only_one(lock))
        finally:
            first.close()
        again = night_worker.only_one(lock)
        self.assertIsNotNone(again)
        again.close()


@unittest.skipIf(TestClient is None, "needs httpx")
class NightApiTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app.app)
        self.dir = Path(tempfile.mkdtemp(dir=TMP))
        self.name = "swing_face_1920x1080_240fps_1790000001_2000ms.mp4"
        patches = [mock.patch.object(app, "NIGHT_DIR", self.dir), mock.patch.object(app, "night_table", {}),
                   mock.patch.object(app, "_night_claims", {}), mock.patch.object(app, "_night_failed", set()),
                   mock.patch.object(app, "listed_clips", lambda **k: [clip(self.name)]),
                   mock.patch.object(app, "deep_profile", lambda: None),
                   mock.patch.object(app, "checked_clip", lambda n: Path(n))]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_waits_during_a_session(self):
        with mock.patch.object(app, "session_on", lambda now=None: True):
            self.assertEqual(self.client.get("/api/night/next").json()["wait"], 300)

    def test_hands_out_then_takes_back(self):
        with mock.patch.object(app, "session_on", lambda now=None: False):
            job = self.client.get("/api/night/next?worker=pc").json()
            self.assertEqual(job["name"], self.name)
            self.assertEqual(job["bodyModel"], "rtmw")
            # Handed out a moment ago: not again.
            self.assertIn("wait", self.client.get("/api/night/next").json())
            r = self.client.post(f"/api/night/{self.name}?worker=pc", content=pose_doc())
            self.assertEqual(r.json()["night"]["worker"], "pc")
            self.assertEqual(night.version_of(night.night_file(self.dir, self.name)), night.VERSION)
            self.assertEqual(self.client.post(f"/api/night/{self.name}", content=b"junk").status_code, 400)

    def test_still_at_a_time(self):
        """The frame at any time, for the Labels view's pick between the two analyses' frames."""
        import fakes
        app.CLIPS_DIR.mkdir(parents=True, exist_ok=True)
        name = "swing_face_960x540_60fps_1789000000_400ms.mp4"
        fakes.clip(app.CLIPS_DIR / name)
        with mock.patch.object(app, "checked_clip", lambda n: app.CLIPS_DIR / n):
            r = self.client.get(f"/api/still/{name}?t=0.25")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["content-type"], "image/jpeg")
        self.assertEqual(r.content[:2], bytes([0xFF, 0xD8]))  # a JPEG

    def test_failed_isnt_handed_out_again(self):
        with mock.patch.object(app, "session_on", lambda now=None: False), mock.patch.object(app, "log_event"):
            self.client.post(f"/api/night/{self.name}?failed=boom", content=b"")
            self.assertIn("wait", self.client.get("/api/night/next").json())

    def test_pose_returns_404_when_missing(self):
        r = self.client.get(f"/api/night/pose/{self.name}")
        self.assertEqual(r.status_code, 404)

    def test_pose_returns_document_after_save(self):
        night.save(self.dir, self.name, pose_doc(), {"worker": "pc", "at": 100})
        r = self.client.get(f"/api/night/pose/{self.name}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers.get("content-encoding"), "gzip")
        self.assertTrue(r.content.startswith(b'{"night":'))
        doc = r.json()
        self.assertEqual(list(doc.keys())[0], "night")
        self.assertEqual(doc["night"]["worker"], "pc")
        # routes still answer
        with mock.patch.object(app, "session_on", lambda now=None: False):
            self.assertIn("wait", self.client.get("/api/night/next").json())
            other = clip("swing_face_1920x1080_240fps_1790000002_2000ms.mp4")
            with mock.patch.object(app, "listed_clips", lambda **k: [other]):
                self.assertEqual(self.client.get("/api/night/next").json()["name"], other["name"])
        self.assertEqual(self.client.get("/api/night/club").status_code, 404)
        model_file = self.dir / "club.onnx"
        model_file.write_bytes(b"model")
        with mock.patch.object(app, "deep_profile", lambda: {"clubModel": str(model_file)}):
            club_resp = self.client.get("/api/night/club")
            self.assertEqual(club_resp.status_code, 200)
            self.assertEqual(club_resp.content, b"model")


if __name__ == "__main__":
    unittest.main()

