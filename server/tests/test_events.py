"""The events log (app.py EVENTS_FILE): what the phones were sent to say, each upload and whether it
came right after the other phone was sent something to say, and each clip with no swing and why.

  cd server && python -m unittest tests.test_events
"""
import json
import os
import sys
import tempfile
import time
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


def events(kind=None):
    if not app.EVENTS_FILE.exists():
        return []
    out = [json.loads(line) for line in app.EVENTS_FILE.read_text(encoding="utf-8").splitlines() if line]
    return [e for e in out if kind is None or e["kind"] == kind]


class SpeechBefore(unittest.TestCase):
    def setUp(self):
        app.recent_speech.clear()

    def test_the_other_phones_speech_counts(self):
        now = time.time()
        app.recent_speech.append((now - 1.0, "face", "Down the line: no swing found on the last 3 swings."))
        echo = app.speech_before("dtl", now)
        self.assertEqual(echo["to"], "face")
        self.assertEqual(echo["after"], 1.0)

    def test_the_speaking_phone_itself_does_not(self):
        # Its listener is muted while it speaks (capture app).
        now = time.time()
        app.recent_speech.append((now - 1.0, "face", "Square: no shot on the last 2 swings."))
        self.assertIsNone(app.speech_before("face", now))

    def test_long_after_the_speech_does_not(self):
        now = time.time()
        # 3 words: said and echoing for about 0.5 + 1.2 + 2 s.
        app.recent_speech.append((now - 10, "face", "Seven point two."))
        self.assertIsNone(app.speech_before("dtl", now))
        self.assertIsNotNone(app.speech_before("dtl", now - 7))

    def test_whole_second_names(self):
        # The clip name's time is cut to whole seconds: a strike in the second the sentence went out counts.
        sent = 1789000000.6
        app.recent_speech.append((sent, "face", "Hello there."))
        self.assertIsNotNone(app.speech_before("dtl", 1789000000.0))


@unittest.skipIf(TestClient is None, "needs httpx")
class UploadLog(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app.app)
        app.recent_speech.clear()

    def test_upload_right_after_the_other_phone_spoke(self):
        now = int(time.time())
        app.sent_to_say("face", "Down the line: no swing found on the last 3 swings.", "phone poll")
        name = f"swing_dtl_1280x720_240fps_{now}_2000ms.mp4"
        self.assertEqual(self.client.post(f"/api/upload?name={name}", content=b"video").status_code, 200)
        said = [e for e in events("say") if e["text"].startswith("Down the line: no swing")]
        self.assertTrue(said and said[-1]["to"] == "face")
        up = next(e for e in events("upload") if e["clip"] == name)
        self.assertEqual(up["angle"], "dtl")
        self.assertEqual(up["afterSpeech"]["to"], "face")
        self.assertEqual(app.upload_notes[name]["to"], "face")

    def test_ordinary_upload(self):
        name = "swing_face_1280x720_240fps_1789000901_2000ms.mp4"
        self.client.post(f"/api/upload?name={name}", content=b"video")
        up = next(e for e in events("upload") if e["clip"] == name)
        self.assertIsNone(up["afterSpeech"])
        self.assertNotIn(name, app.upload_notes)


class NoSwingLog(unittest.TestCase):
    def clip(self, name, partner=None):
        return {"name": name, "angle": "dtl", "partner": partner, "strike": 2.0, "recorded": "2026-09-30T18:00:00"}

    def test_logged_with_why(self):
        name = "swing_dtl_1280x720_240fps_1789001001_2000ms.mp4"
        app.upload_notes[name] = {"to": "face", "text": "Seven point two.", "after": 1.2}
        why = {"reason": "tracking", "text": "the body was tracked in only 3 of 480 frames (20 needed)"}
        app.note_no_swing(self.clip(name), None, {"quality": {"swingFound": False, "noSwing": why}}, again=False)
        e = next(e for e in events("noswing") if e["clip"] == name)
        self.assertEqual(e["why"]["reason"], "tracking")
        self.assertTrue(e["lone"])
        self.assertFalse(e["again"])
        self.assertEqual(e["afterSpeech"]["text"], "Seven point two.")

    def test_found_swings_and_errors_are_not_logged(self):
        name = "swing_dtl_1280x720_240fps_1789001101_2000ms.mp4"
        app.note_no_swing(self.clip(name), None, {"quality": {"swingFound": True, "noSwing": None}}, again=False)
        app.note_no_swing(self.clip(name), None, {"error": "boom"}, again=False)
        self.assertFalse([e for e in events("noswing") if e["clip"] == name])


class Trim(unittest.TestCase):
    def test_keeps_the_newer_half(self):
        was_file, was_max = app.EVENTS_FILE, app.EVENTS_MAX_BYTES
        try:
            app.EVENTS_FILE = Path(tempfile.mkdtemp(prefix="swingclips-events-")) / "events.jsonl"
            app.EVENTS_MAX_BYTES = 100
            for i in range(20):
                app.log_event("say", n=i)
            app.trim_events()
            kept = [json.loads(line)["n"] for line in app.EVENTS_FILE.read_text().splitlines()]
            self.assertEqual(kept, list(range(10, 20)))
        finally:
            app.EVENTS_FILE, app.EVENTS_MAX_BYTES = was_file, was_max


if __name__ == "__main__":
    unittest.main()
