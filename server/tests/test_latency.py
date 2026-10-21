"""From the strike to the numbers: an uploaded clip is analyzed at once (no settling wait), the pose
worker is woken by the upload rather than looking every 5 s, and a quality measure running beside its
loop doesn't hold a new clip up.

  cd server && python -m unittest tests.test_latency
"""
import os
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import Future
from pathlib import Path
from unittest import mock

HERE = Path(__file__).parent
TMP = Path(tempfile.mkdtemp(prefix="swingclips-latency-"))
# app.py reads its folders when it's imported (another test may have imported it already).
os.environ.setdefault("SWINGCLIPS_CLIPS", str(TMP / "clips"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import app  # noqa: E402
try:
    from fastapi.testclient import TestClient  # needs httpx, which the server itself doesn't
except (ImportError, RuntimeError):
    TestClient = None


def clip_name(unix: float, angle: str = "face") -> str:
    return f"swing_{angle}_1920x1080_240fps_{int(unix)}_2000ms.mp4"


class ReadyForPose(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(dir=TMP))

    def test_copied_in_waits_uploaded_goes_at_once(self):
        now = time.time()
        copied, uploaded, old = (self.dir / clip_name(now - k) for k in (1, 2, 100))
        for p in (copied, uploaded, old):
            p.write_bytes(b"video")
        os.utime(old, (now - 100, now - 100))
        with mock.patch.object(app, "uploaded_whole", {uploaded.name}):
            ready = app.ready_for_pose([copied, uploaded, old], now)
        self.assertEqual({p.name for p in ready}, {uploaded.name, old.name})
        # A clip gone meanwhile (moved to the trash) is simply left out.
        self.assertEqual(app.ready_for_pose([self.dir / "gone.mp4"], now), [])


@unittest.skipIf(TestClient is None, "needs httpx")
class UploadWakes(unittest.TestCase):
    def test_upload_marks_whole_and_wakes_the_pose_worker(self):
        client = TestClient(app.app)
        name = clip_name(time.time() - 3)
        app.pose_wake.clear()
        self.assertEqual(client.post(f"/api/upload?name={name}", content=b"video").status_code, 200)
        self.assertIn(name, app.uploaded_whole)
        self.assertTrue(app.pose_wake.is_set())
        self.assertEqual([p.name for p in app.ready_for_pose([app.CLIPS_DIR / name], time.time())], [name])


class DrillReps(unittest.TestCase):
    """A drill rep is finished (both clips) before the next rep is started."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(dir=TMP))
        for d in ("clips", "pose"):
            (self.dir / d).mkdir()
        self.patches = [mock.patch.object(app, "CLIPS_DIR", self.dir / "clips"),
                        mock.patch.object(app, "POSE_DIR", self.dir / "pose")]
        for p in self.patches:
            p.start()
        now = time.time()
        # Rep 1's face-on clip analyzed, its down-the-line one waiting; rep 2's face-on clip just in.
        self.rep1_face, self.rep1_dtl = clip_name(now - 50), clip_name(now - 49, "dtl")
        self.rep2_face = clip_name(now - 5)
        for n in (self.rep1_face, self.rep1_dtl, self.rep2_face):
            (app.CLIPS_DIR / n).write_bytes(b"video")
        app.pose_file(self.rep1_face).write_bytes(b"done")
        self.todo = [app.CLIPS_DIR / n for n in (self.rep1_dtl, self.rep2_face)]

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def as_drill(self, drill):
        return mock.patch.object(app, "clip_drill", lambda name, partner, t: (drill, False))

    def test_usual_swings_face_on_first(self):
        with self.as_drill(None):
            self.assertEqual(app.next_to_analyze(self.todo).name, self.rep2_face)

    def test_a_drill_rep_is_finished_first(self):
        for drill in ("pump", "move:handsPlaneP6:less"):
            with self.as_drill(drill):
                self.assertEqual(app.next_to_analyze(self.todo).name, self.rep1_dtl, drill)
        # Not while its face-on clip is still waiting: face-on first, as usual.
        app.pose_file(self.rep1_face).unlink()
        with self.as_drill("pump"):
            self.assertEqual(app.next_to_analyze(self.todo + [app.CLIPS_DIR / self.rep1_face]).name, self.rep2_face)

    def test_only_long_lead_in_drills_are_lighter(self):
        clip = app.CLIPS_DIR / self.rep2_face
        for drill, long in (("pump", True), ("move:handsPlaneP6:less", False), ("toetap", False), (None, False)):
            with self.as_drill(drill):
                self.assertEqual(app.long_drill(clip), long, drill)

    def test_a_marked_none_rep_is_a_usual_swing(self):
        # Marked "not a drill" afterwards (drills.NOT_A_DRILL): clip_drill says no drill.
        with self.as_drill(None):
            self.assertIsNone(app.drill_rep(app.CLIPS_DIR / self.rep1_dtl))
        self.assertIsNone(app.drill_rep(app.CLIPS_DIR / "not_a_swing.mp4"))


class PoseWorker(unittest.TestCase):
    """The worker loop itself, with the analysis stubbed out: a clip that comes in while a quality
    measure is running is analyzed within a moment of its upload."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(dir=TMP))
        for d in ("clips", "pose"):
            (self.dir / d).mkdir()
        self.analyzed = []
        running = Future()   # a quality measure that never finishes while the test runs

        def analyze(path, pool, workers, deep=None, quick=None):
            self.analyzed.append((Path(path).name, time.time()))
            return {"frames": [], "impact": None, "seconds": 0.0}

        self.patches = [mock.patch.object(app, "CLIPS_DIR", self.dir / "clips"),
                        mock.patch.object(app, "POSE_DIR", self.dir / "pose"),
                        mock.patch.object(app, "session_on", lambda now=None: True),
                        mock.patch.object(app, "new_pool", mock.Mock),
                        mock.patch.object(app, "uploaded_whole", set()),
                        mock.patch.object(app, "quality_job", {"clip": "older.mp4", "future": running, "pool": None,
                                                               "positions": {}, "started": 0.0}),
                        mock.patch.object(app, "quality_busy", "older.mp4"),
                        mock.patch.object(app.pose, "analyze", analyze)]
        for p in self.patches:
            p.start()
        self.stop = threading.Event()
        self.thread = threading.Thread(target=app.pose_worker, args=(self.stop,), daemon=True)

    def tearDown(self):
        self.stop.set()
        app.pose_wake.set()
        self.thread.join(timeout=10)
        for p in self.patches:
            p.stop()

    def test_upload_analyzed_at_once_beside_a_quality_measure(self):
        name = clip_name(time.time() - 3)
        (app.CLIPS_DIR / name).write_bytes(b"video")   # as a hand copy: still settling
        self.thread.start()
        time.sleep(0.5)
        self.assertEqual(self.analyzed, [])
        app.swing_wake.clear()
        app.uploaded_whole.add(name)   # what POST /api/upload does once the clip is whole
        woken = time.time()
        app.pose_wake.set()
        for _ in range(50):
            if self.analyzed:
                break
            time.sleep(0.1)
        self.assertEqual([n for n, _ in self.analyzed], [name])
        self.assertLess(self.analyzed[0][1] - woken, 1.0)   # was 15-20 s: the settle wait, then a 5 s look
        self.assertTrue(app.pose_file(name).exists())
        self.assertTrue(app.swing_wake.wait(2))             # the swing worker is told
        self.assertEqual(app.quality_busy, "older.mp4")     # the measure carried on beside it


if __name__ == "__main__":
    unittest.main()
