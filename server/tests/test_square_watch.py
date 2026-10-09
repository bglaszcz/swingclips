"""The server's own Square watcher (square_watch.py): reads new shots from a copy of Square's app's
database layout, as relay/square-watcher.ps1 does, and hands them to the server once each.

  cd server && python -m unittest tests.test_square_watch
"""
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

HERE = Path(__file__).parent
os.environ.setdefault("SWINGCLIPS_CLIPS", str(Path(tempfile.mkdtemp(prefix="swingclips-test-")) / "clips"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import square_watch  # noqa: E402

WHEN = datetime(2026, 10, 9, 18, 30, 5, 250000, tzinfo=timezone.utc)

SHOT = {"Speed": 50.0, "Angle": 18.5, "Direction": -1.2, "SpinRate": 6500, "BackSpin": 6400,
        "SideSpin": 300.0, "SpinAxis": 3.0}
RESULT = {"CarryDistance": 150.0, "TotalDistance": 160.0, "SideError": -4.0, "ApexHeight": 25.0, "LandingAngle": 45.33}
CLUB = {"ClubSpeed": 38.0, "SmashFactor": 1.32, "AttackAngle": -4.1, "FaceAngle": 0.5, "Path": 1.5,
        "DynamicLoft": 22.0, "ImpactHorizontal": 3.0, "ImpactVertical": -12.0, "IsValidImpactHorizontal": False}


def make_db(path: Path) -> None:
    con = sqlite3.connect(path)
    con.execute("create table IVSession (SessionID integer primary key, Name text)")
    con.execute("create table IVShotLog (ShotID integer primary key, SessionID integer, ClubType integer, "
                "Mode text, ShotData text, ShotResult text, ClubData text)")
    con.execute("insert into IVSession values (1, 'Range')")
    con.commit()
    con.close()


def add_row(path: Path, shot_id: int, club_type: int = 17, shot=SHOT, result=RESULT, club=CLUB) -> None:
    con = sqlite3.connect(path)
    con.execute("insert into IVShotLog values (?, 1, ?, 'Range', ?, ?, ?)",
                (shot_id, club_type, shot if isinstance(shot, str) else json.dumps(shot),
                 json.dumps(result) if result else None, json.dumps(club) if club else None))
    con.commit()
    con.close()
    # Writes a moment apart can share a modified time; the watcher looks again only when it changes.
    st = path.stat()
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 10_000_000 * shot_id))


class MakeShot(unittest.TestCase):
    def shot(self, **kw):
        row = (7, 1, kw.get("club_type", 17), "Range", json.dumps(kw.get("shot", SHOT)),
               json.dumps(RESULT), json.dumps(kw.get("club", CLUB)), "Range")
        return square_watch.make_shot(row, WHEN)

    def test_units_and_signs_as_the_laptop_watcher_sends_them(self):
        s = self.shot()
        self.assertEqual((s["source"], s["shotNumber"], s["club"], s["session"]), ("square-app", 7, "I7", "Range"))
        self.assertEqual(s["received"], "2026-10-09T18:30:05.250+00:00")
        b = s["ball"]
        self.assertAlmostEqual(b["speed"], 111.85, places=2)  # m/s -> mph
        self.assertEqual((b["vla"], b["hla"], b["totalSpin"]), (18.5, -1.2, 6500))
        self.assertEqual((b["sideSpin"], b["spinAxis"]), (-300.0, -3.0))  # Square's positive = left
        self.assertEqual((b["carry"], b["total"], b["side"], b["apexFt"], b["landingAngle"]), (164.0, 175.0, -4.4, 82.0, 45.3))
        c = s["clubData"]
        self.assertAlmostEqual(c["speed"], 85.0, places=1)
        self.assertEqual((c["smash"], c["angleOfAttack"], c["path"], c["faceImpactV"]), (1.32, -4.1, 1.5, -12.0))
        self.assertIsNone(c["faceImpactH"])  # Square marked it unreliable

    def test_an_unknown_club_keeps_squares_number(self):
        self.assertEqual(self.shot(club_type=40)["club"], "club40")

    def test_no_club_data(self):
        row = (8, 1, 0, "Range", json.dumps(SHOT), None, None, None)
        s = square_watch.make_shot(row, WHEN)
        self.assertIsNone(s["clubData"])
        self.assertIsNone(s["ball"]["carry"])
        self.assertEqual(s["club"], "DR")


class Setting(unittest.TestCase):
    def test_off(self):
        self.assertIsNone(square_watch.configured_db({"SWINGCLIPS_SQUARE_DB": "off"}))

    def test_a_file_named(self):
        self.assertEqual(square_watch.configured_db({"SWINGCLIPS_SQUARE_DB": r"E:\sq.bytes"}), Path(r"E:\sq.bytes"))

    def test_unset_only_when_squares_app_saved_here(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(square_watch, "default_db", return_value=Path(d) / "SQGDB.bytes"):
                self.assertIsNone(square_watch.configured_db({}))
                (Path(d) / "SQGDB.bytes").write_bytes(b"")
                self.assertEqual(square_watch.configured_db({}), Path(d) / "SQGDB.bytes")


class Watching(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.db = Path(self.dir.name) / "SQGDB.bytes"
        make_db(self.db)
        add_row(self.db, 1)  # already there when the watcher starts: not sent
        self.shots, self.beats, self.said = [], [], []
        self.w = square_watch.SquareWatcher(self.db, self.shots.append, self.beats.append,
                                            is_running=lambda: True, now=lambda: WHEN, log=self.said.append)

    def tearDown(self):
        self.dir.cleanup()

    def test_only_shots_saved_after_it_starts(self):
        self.assertTrue(self.w.start())
        self.assertEqual(self.w.poll(), [])
        add_row(self.db, 2, club_type=0)
        add_row(self.db, 3, club_type=20)
        self.assertEqual([s["shotNumber"] for s in self.w.poll()], [2, 3])
        self.assertEqual([s["club"] for s in self.shots], ["DR", "PW"])
        self.assertEqual(self.w.poll(), [])  # nothing changed since
        add_row(self.db, 4)
        self.assertEqual([s["shotNumber"] for s in self.w.poll()], [4])

    def test_an_unreadable_shot_is_skipped_and_the_rest_sent(self):
        self.w.start()
        add_row(self.db, 2, shot="{not json")
        add_row(self.db, 3)
        self.assertEqual([s["shotNumber"] for s in self.w.poll()], [3])
        self.assertTrue(any("#2" in line for line in self.said))

    def test_heartbeat_reports_squares_app_and_the_last_shot(self):
        self.w.start()
        add_row(self.db, 2)
        self.w.poll()
        self.w.beat(force=True)
        self.assertEqual(self.beats[-1], {"source": "square-watcher", "squareRunning": True,
                                          "lastShotAt": "2026-10-09T18:30:05.250+00:00", "version": "server"})

    def test_a_missing_database_waits(self):
        w = square_watch.SquareWatcher(Path(self.dir.name) / "none.bytes", self.shots.append, self.beats.append,
                                       is_running=lambda: False, log=self.said.append)
        self.assertEqual(w.poll(), [])
        self.assertIsNone(w.last_id)

    def test_it_never_writes_squares_database(self):
        self.w.start()
        before = self.db.read_bytes()
        add_row(self.db, 2)
        after_add = self.db.read_bytes()
        self.w.poll()
        self.assertNotEqual(before, after_add)
        self.assertEqual(self.db.read_bytes(), after_add)


class IntoTheServer(unittest.TestCase):
    """app.record_shot: what POST /api/shots and the watcher both use."""

    @classmethod
    def setUpClass(cls):
        import app
        cls.app = app

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.patch = mock.patch.object(self.app, "SHOTS_FILE", Path(self.dir.name) / "shots.jsonl")
        self.patch.start()
        self.app.recent_square_shots.clear()

    def tearDown(self):
        self.patch.stop()
        self.dir.cleanup()

    def kept(self):
        return [json.loads(x) for x in self.app.SHOTS_FILE.read_text(encoding="utf-8").splitlines()]

    def test_the_same_square_shot_is_kept_once(self):
        row = (12, 1, 17, "Range", json.dumps(SHOT), json.dumps(RESULT), json.dumps(CLUB), "Range")
        shot = square_watch.make_shot(row, datetime.now().astimezone())
        self.assertEqual(self.app.record_shot(dict(shot)), {"ok": True})
        self.assertEqual(self.app.record_shot(dict(shot)), {"ok": True, "duplicate": True})
        kept = self.kept()
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0]["shotNumber"], 12)
        self.assertIn("serverReceived", kept[0])

    def test_shots_without_a_number_are_all_kept(self):
        shot = {"received": datetime.now().astimezone().isoformat(), "source": "gspro-connect",
                "ball": {"speed": 100.0, "vla": 15.0, "totalSpin": 5000}}
        self.app.record_shot(dict(shot))
        self.app.record_shot(dict(shot))
        self.assertEqual(len(self.kept()), 2)

    def test_started_only_when_configured(self):
        import threading
        stop = threading.Event()
        stop.set()  # the thread ends at once: nothing reaches the shared session status
        try:
            with mock.patch.object(square_watch, "configured_db", return_value=None):
                self.assertIsNone(self.app.start_square_watch(stop))
            db = Path(self.dir.name) / "SQGDB.bytes"
            make_db(db)
            with mock.patch.object(square_watch, "configured_db", return_value=db), \
                    mock.patch.object(square_watch, "square_running", return_value=False):
                w = self.app.start_square_watch(stop)
            self.assertIsInstance(w, square_watch.SquareWatcher)
            self.assertEqual(w.db, db)
        finally:
            self.app.recent_square_shots.clear()


if __name__ == "__main__":
    unittest.main()
