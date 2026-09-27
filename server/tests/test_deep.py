"""Recording first during a session, the deep pass after it (app.py: session_on, deep_profile, the pose
worker's order; pose.analyze's `deep`; the Ready panel's line)."""
import contextlib
import gzip
import io
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).parent
TMP = Path(tempfile.mkdtemp(prefix="swingclips-deep-test-"))
os.environ.setdefault("SWINGCLIPS_CLIPS", str(TMP / "clips"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import app  # noqa: E402
import fakes  # noqa: E402
import models  # noqa: E402
import pose  # noqa: E402
import status  # noqa: E402
from test_providers import MODELS, NO_SETTINGS, fake_models, needs_ort  # noqa: E402


def analyze(path, deep=None) -> dict:
    with fakes.mediapipe(), mock.patch("builtins.print"), contextlib.redirect_stderr(io.StringIO()):
        out = pose.analyze(str(path), fakes.Pool(), 2, deep=deep)
    out.pop("seconds")
    out.pop("msPerFrame", None)
    return out


@needs_ort
class DeepAnalyzeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.clip = TMP / "swing_face_960x540_60fps_1789123456_400ms.mp4"
        fakes.clip(cls.clip, 90)

    def test_deep_is_those_settings(self):
        """The deep pass gives exactly what the same settings in the environment give, and says so."""
        env = {**NO_SETTINGS, **fake_models()}
        club_file = MODELS / models.CLUB_FILE
        # (SWINGCLIPS_BODY_STRIDE is read when pose.py loads: pose.BODY_STRIDE.)
        with mock.patch.dict(os.environ, {**env, "SWINGCLIPS_CLUB_BACKEND": "yolo", "SWINGCLIPS_CLUB_MODEL": str(club_file)}),                 mock.patch.object(pose, "BODY_STRIDE", 1):
            by_env = analyze(self.clip)
        with mock.patch.dict(os.environ, env), mock.patch.object(pose, "BODY_STRIDE", 2):
            deep = analyze(self.clip, {"bodyStride": 1, "clubModel": club_file})
            quick = analyze(self.clip)
        self.assertEqual(deep.pop("pass"), "deep")
        self.assertEqual(json.dumps(deep), json.dumps(by_env))
        self.assertNotIn("pass", quick)
        self.assertNotIn("clubModel", quick)
        # Near the start of the file, where the server looks.
        with mock.patch.dict(os.environ, {**env}):
            text = json.dumps(analyze(self.clip, {"bodyStride": 1, "clubModel": None}), separators=(",", ":"))
        self.assertIn('"pass":"deep"', text[:400])


class SessionTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(dir=TMP))
        self.clip = self.dir / "swing_face_1920x1080_240fps_1790000000_2000ms.mp4"
        self.clip.write_bytes(b"x")

    def on(self, recording=False, age=None):
        now = time.time()
        if age is not None:
            os.utime(self.clip, (now - age, now - age))
        with mock.patch.object(app, "clip_paths", lambda: [self.clip]), \
                mock.patch.object(app.session_status, "recording", lambda now=None: recording):
            return app.session_on(now)

    def test_session_on(self):
        self.assertTrue(self.on(recording=True, age=5000))                    # a phone recording
        self.assertTrue(self.on(age=app.SESSION_QUIET_S - 30))               # a clip a few minutes ago
        self.assertFalse(self.on(age=app.SESSION_QUIET_S + 30))              # quiet for long enough

    def test_status_recording(self):
        s = status.Status(clock=lambda: 100.0)
        self.assertFalse(s.recording())
        s.heartbeat("face", {"recording": True})
        self.assertTrue(s.recording())
        s.heartbeat("face", {"recording": False})
        self.assertFalse(s.recording())


class DeepProfileTest(unittest.TestCase):
    def test_profile(self):
        d = Path(tempfile.mkdtemp(dir=TMP))
        base = {"SWINGCLIPS_MODELS": str(d), "SWINGCLIPS_DEEP": "", "SWINGCLIPS_DEEP_CLUB_MODEL": "",
                "SWINGCLIPS_DEEP_BODY_STRIDE": ""}
        with mock.patch.dict(os.environ, {**base, "SWINGCLIPS_POSE_BACKEND": "rtmpose-m"}):
            self.assertEqual(app.deep_profile(), {"bodyStride": 1, "clubModel": None, "rayTakeaway": True})
            (d / "club-deep.onnx").write_bytes(b"x")
            self.assertEqual(app.deep_profile(), {"bodyStride": 1, "clubModel": d / "club-deep.onnx", "rayTakeaway": True})
            with mock.patch.dict(os.environ, {"SWINGCLIPS_DEEP": "off"}):
                self.assertIsNone(app.deep_profile())
            with mock.patch.dict(os.environ, {"SWINGCLIPS_DEEP_BODY_STRIDE": "2"}):
                self.assertEqual(app.deep_profile()["bodyStride"], 2)
            with mock.patch.dict(os.environ, {"SWINGCLIPS_DEEP_CLUB_MODEL": str(d / "none.onnx")}), \
                    self.assertRaises(SystemExit):
                app.deep_profile()
        (d / "club-deep.onnx").unlink()
        with mock.patch.dict(os.environ, {**base, "SWINGCLIPS_POSE_BACKEND": ""}):
            self.assertIsNone(app.deep_profile())              # MediaPipe alone, no club model: nothing to do


class PoseMadeTest(unittest.TestCase):
    def test_deep_stamp(self):
        d = Path(tempfile.mkdtemp(dir=TMP))
        with mock.patch.object(app, "POSE_DIR", d):
            for name, head in (("quick.mp4", {"version": 6, "model": "rtmpose-m-256x192", "ballVersion": 3}),
                               ("deep.mp4", {"version": 6, "pass": "deep", "model": "rtmpose-m-256x192",
                                             "ballVersion": 3})):
                app.pose_file(name).write_bytes(gzip.compress(json.dumps({**head, "frames": []}, separators=(",", ":")).encode()))
            self.assertEqual(app.pose_made("quick.mp4"), "rtmpose-m-256x192+ball3")
            self.assertEqual(app.pose_made("deep.mp4"), "rtmpose-m-256x192+ball3+deep")
            self.assertFalse(app.is_deep("quick.mp4"))
            self.assertTrue(app.is_deep("deep.mp4"))
            self.assertEqual(app.pose_model("deep.mp4"), "rtmpose-m-256x192")


class ReadyPanelTest(unittest.TestCase):
    def row(self, pose_info):
        snap = status.Status(clock=lambda: 100.0).snapshot({}, pose_info, None)
        return next(r for r in snap["rows"] if r["key"] == "server")

    def test_lines(self):
        self.assertEqual(self.row({"queued": 0, "busy": None, "deepLeft": 0})["text"], "Pose: up to date")
        self.assertEqual(self.row({"queued": 0, "busy": None, "deepLeft": 12})["text"],
                         "Pose: up to date; deep pass: 12 clips to go")
        held = self.row({"queued": 30, "busy": None, "deepLeft": 0, "held": True})
        self.assertEqual((held["text"], held["level"]), ("Recording only: 30 clips to analyze after the session", "ok"))
        self.assertEqual(self.row({"queued": 30, "busy": "x"})["level"], "warn")


if __name__ == "__main__":
    unittest.main()
