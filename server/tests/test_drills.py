"""Drill mode (drills.py) and the phones' lead-in before the strike (status.py pre)."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).parent
TMP = Path(tempfile.mkdtemp(prefix="swingclips-test-"))
os.environ.setdefault("SWINGCLIPS_CLIPS", str(TMP / "clips"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import drills  # noqa: E402
import status  # noqa: E402
from test_status import Clock, T0, hb  # noqa: E402


class DrillsTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.path = Path(tempfile.mkdtemp(prefix="swingclips-drills-")) / "drills.json"
        self.d = drills.Drills(self.path, self.clock)

    def test_on_off_tags_by_time_and_survives_a_restart(self):
        self.assertEqual(self.d.pre(), drills.PRE_S)
        self.d.set("pump")
        self.assertEqual(self.d.pre(), drills.DRILLS["pump"]["pre"])
        self.clock.t += 600
        self.d.set(None)
        self.assertEqual(self.d.pre(), drills.PRE_S)
        again = drills.Drills(self.path, self.clock)
        self.assertEqual(again.drill_at(T0 + 300), "pump")
        self.assertIsNone(again.drill_at(T0 - 1))
        self.assertIsNone(again.drill_at(T0 + 601))

    def test_the_drill_on_now_tags_new_clips(self):
        self.d.set("pump")
        self.assertEqual(self.d.drill_at(T0 + 5), "pump")

    def test_unknown_drill_refused(self):
        with self.assertRaises(ValueError):
            self.d.set("nope")

    def test_left_on_after_the_session_it_ends_where_recording_stopped(self):
        self.d.set("pump")
        self.clock.t += 300
        last = self.clock.t
        self.clock.t += drills.IDLE_END_S - 1
        self.d.check(last)
        self.assertIsNotNone(self.d.state()["current"])
        self.clock.t += 2
        self.d.check(last)
        self.assertIsNone(self.d.state()["current"])
        self.assertIsNone(self.d.drill_at(last + 60))      # the next session isn't tagged
        self.assertEqual(self.d.drill_at(last - 60), "pump")


class MarksTest(unittest.TestCase):
    """Said afterwards, clip by clip: it was this drill (not switched on), or no drill (left on)."""

    def setUp(self):
        self.clock = Clock()
        self.path = Path(tempfile.mkdtemp(prefix="swingclips-drills-")) / "drills.json"
        self.d = drills.Drills(self.path, self.clock)

    def test_a_mark_beats_the_time_and_survives_a_restart(self):
        self.assertEqual(self.d.drill_of("a.mp4", None, T0 - 50), (None, False))
        self.assertEqual(self.d.mark(["a.mp4"], "pump"), {"a.mp4": None})
        self.assertEqual(self.d.drill_of("a.mp4", None, T0 - 50), ("pump", True))
        again = drills.Drills(self.path, self.clock)
        self.assertEqual(again.drill_of("a.mp4", None, T0 - 50), ("pump", True))
        self.assertEqual(again.drill_of("b.mp4", None, T0 - 50), (None, False))

    def test_the_other_angle_goes_with_it(self):
        self.d.mark(["face.mp4"], "pump")
        self.assertEqual(self.d.drill_of("dtl.mp4", "face.mp4", T0), ("pump", True))

    def test_not_a_drill_with_one_left_on(self):
        self.d.set("pump")
        self.clock.t += 600
        self.d.set(None)
        self.assertEqual(self.d.drill_of("a.mp4", None, T0 + 300), ("pump", False))
        self.d.mark(["a.mp4"], drills.NOT_A_DRILL)
        self.assertEqual(self.d.drill_of("a.mp4", None, T0 + 300), (None, True))

    def test_taken_back_it_goes_by_the_time_again(self):
        self.d.mark(["a.mp4", "b.mp4"], "flush")
        self.assertEqual(self.d.mark(["a.mp4"], None), {"a.mp4": "flush"})
        self.assertEqual(self.d.drill_of("a.mp4", None, T0), (None, False))
        self.assertEqual(self.d.drill_of("b.mp4", None, T0), ("flush", True))

    def test_unknown_drill_refused(self):
        with self.assertRaises(ValueError):
            self.d.mark(["a.mp4"], "nope")
        self.assertEqual(self.d.marks, {})

    def test_a_bad_mark_in_the_file_is_dropped(self):
        self.path.write_text('{"marks": {"a.mp4": "nope", "b.mp4": "pump", "c.mp4": "none"}}', encoding="utf-8")
        self.assertEqual(drills.Drills(self.path, self.clock).marks, {"b.mp4": "pump", "c.mp4": "none"})


class PreTest(unittest.TestCase):
    """The phones keep more video before the strike during a drill (capture app 0.10 and later)."""

    def setUp(self):
        self.clock = Clock()
        self.s = status.Status(self.clock)

    def test_told_once_then_quiet(self):
        self.s.heartbeat("face", hb(pre=2))
        self.assertFalse(self.s.has_mail("face"))
        self.s.set_pre(6)
        self.assertTrue(self.s.has_mail("face"))
        self.assertEqual(self.s.take("face")["pre"], 6)
        self.assertNotIn("pre", self.s.take("face"))
        self.s.heartbeat("face", hb(pre=6))                 # it switched
        self.assertFalse(self.s.has_mail("face"))

    def test_an_older_app_is_left_alone(self):
        self.s.heartbeat("face", hb())
        self.s.set_pre(6)
        self.assertFalse(self.s.has_mail("face"))
        self.assertNotIn("pre", self.s.take("face"))

    def test_a_restarted_app_is_told_again(self):
        self.s.heartbeat("face", hb(pre=2))
        self.s.set_pre(6)
        self.s.take("face")
        self.s.heartbeat("face", hb(pre=6))
        self.s.heartbeat("face", hb(pre=2))                 # the app restarted with its default
        self.assertEqual(self.s.take("face")["pre"], 6)

    def test_drill_off_goes_back(self):
        self.s.heartbeat("face", hb(pre=6))
        self.s.set_pre(2)
        self.assertEqual(self.s.take("face")["pre"], 2)


class Api(unittest.TestCase):
    """/api/drill on and off; a clip recorded during it is tagged and left out of the trends."""

    def test_drill_tags_clips_and_tells_the_phones(self):
        from fastapi.testclient import TestClient
        import app
        app.drills_state = drills.Drills(TMP / "drills-api.json")
        client = TestClient(app.app)
        self.assertEqual(client.post("/api/drill", json={"drill": "nope"}).status_code, 400)
        on = client.post("/api/drill", json={"drill": "pump"}).json()
        self.assertEqual(on["current"]["drill"], "pump")
        self.assertEqual(app.session_status.pre_wanted, drills.DRILLS["pump"]["pre"])
        app.CLIPS_DIR.mkdir(parents=True, exist_ok=True)
        clip = app.CLIPS_DIR / f"swing_face_1920x1080_240fps_{int(on['current']['from']) + 5}_2000ms.mp4"
        clip.write_bytes(b"x")
        try:
            listed = {c["name"]: c for c in app.listed_clips(with_shots=False)}
            self.assertEqual(listed[clip.name]["drill"], "pump")
            self.assertTrue(listed[clip.name]["excluded"])
        finally:
            clip.unlink()
        off = client.post("/api/drill", json={"drill": None}).json()
        self.assertIsNone(off["current"])
        self.assertEqual(app.session_status.pre_wanted, drills.PRE_S)


class MarkApi(unittest.TestCase):
    """/api/drill/mark: swings marked afterwards are tagged, left out, and worked out again."""

    def test_marked_swings_are_drill_swings_until_taken_back(self):
        from fastapi.testclient import TestClient
        import app
        saved = app.drills_state
        app.drills_state = drills.Drills(TMP / "drills-mark.json")
        client = TestClient(app.app)
        app.CLIPS_DIR.mkdir(parents=True, exist_ok=True)
        face = app.CLIPS_DIR / "swing_face_1920x1080_240fps_1700000000_2100ms.mp4"
        dtl = app.CLIPS_DIR / "swing_dtl_1920x1080_240fps_1700000000_2050ms.mp4"
        for p in (face, dtl):
            p.write_bytes(b"x")

        def listed():
            return {c["name"]: c for c in app.listed_clips(with_shots=False)}
        try:
            self.assertEqual(client.post("/api/drill/mark", json={"names": [face.name], "drill": "nope"}).status_code, 400)
            was = listed()[face.name]
            self.assertEqual((was["drill"], was["drillMarked"], was["excluded"]), (None, False, False))
            out = client.post("/api/drill/mark", json={"names": [face.name, "../x.mp4", "notes.txt"], "drill": "pump"}).json()
            self.assertEqual(out["before"], {face.name: None})
            now = listed()
            for name in (face.name, dtl.name):
                self.assertEqual((now[name]["drill"], now[name]["drillMarked"], now[name]["excluded"]), ("pump", True, True))
            out = client.post("/api/drill/mark", json={"names": [face.name], "drill": None}).json()
            self.assertEqual(out["before"], {face.name: "pump"})
            self.assertEqual((listed()[face.name]["drill"], listed()[face.name]["excluded"]), (None, False))
        finally:
            face.unlink()
            dtl.unlink()
            app.drills_state = saved

    def test_a_marked_swing_is_worked_out_again(self):
        import app
        saved = app.swings_code
        app.swings_code = "abc"
        try:
            made = [app.models.DEFAULT, None]
            clip = {"name": "a.mp4", "drill": None, "drillMarked": False}
            old = {"code": "abc", "partner": None, "poseModel": made}
            self.assertTrue(app.swing_record_stale(None, clip, None, made))
            self.assertFalse(app.swing_record_stale(old, clip, None, made))
            # A record from before drillAs was kept, recorded in drill mode: as it was.
            self.assertFalse(app.swing_record_stale(old, {**clip, "drill": "pump"}, None, made))
            # Marked since: again, once.
            marked = {**clip, "drill": "pump", "drillMarked": True}
            self.assertTrue(app.swing_record_stale(old, marked, None, made))
            self.assertFalse(app.swing_record_stale({**old, "drillAs": "pump"}, marked, None, made))
            # The mark taken back, or "not a drill" on a swing recorded with one left on.
            self.assertTrue(app.swing_record_stale({**old, "drillAs": "pump"}, clip, None, made))
            self.assertTrue(app.swing_record_stale(old, {**clip, "drillMarked": True}, None, made))
            self.assertTrue(app.swing_record_stale({**old, "code": "old"}, clip, None, made))
        finally:
            app.swings_code = saved


class PlanStepApi(unittest.TestCase):
    """Starting a plan block sets up only what it needs: one thing on at a time."""

    def test_blocks_switch_drill_game_and_voice(self):
        from fastapi.testclient import TestClient
        import app
        import games
        # Its own drills and games, so the game's spoken target doesn't reach other tests' phones.
        saved = app.drills_state, app.games_state, dict(app.practice_state.config)
        app.drills_state = drills.Drills(TMP / "drills-plan.json")
        app.games_state = games.Games(TMP / "game-plan.json", TMP / "games-plan.jsonl", app.practice_state.new_id)
        app.PLAN_STEP_FILE = TMP / "plan-step.json"
        client = TestClient(app.app)
        try:
            self.assertEqual(client.post("/api/plan/step", json={"block": "x", "game": "nope"}).status_code, 400)
            app.practice_state.set_config({**app.practice_state.config, "metric": "tempo", "min": 2.8, "max": 3.4, "on": True})
            out = client.post("/api/plan/step", json={"block": "focus", "drill": "pump"}).json()
            self.assertEqual(out["step"]["block"], "focus")
            self.assertEqual(out["drill"]["current"]["drill"], "pump")
            self.assertFalse(app.practice_state.config["on"])
            out = client.post("/api/plan/step", json={"block": "scoring", "game": "distance"}).json()
            self.assertIsNone(out["drill"]["current"])
            self.assertEqual(out["game"]["id"], "distance")
            self.assertEqual(client.get("/api/plan/step").json()["step"]["block"], "scoring")
            out = client.post("/api/plan/step", json={"block": None}).json()
            self.assertIsNone(out["step"])
            self.assertIsNone(out["game"])
            self.assertIsNone(client.get("/api/plan/step").json()["step"])
        finally:
            app.games_state.stop()
            app.games_state.rules.close()
            app.drills_state, app.games_state = saved[0], saved[1]
            app.practice_state.set_config(saved[2])
            app.session_status.set_pre(drills.PRE_S)


if __name__ == "__main__":
    unittest.main()
