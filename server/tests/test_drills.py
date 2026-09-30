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
