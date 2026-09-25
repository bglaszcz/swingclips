"""Practice mode (practice.py): the sentences, which numbers are trusted, the wait for Square's shot,
and the endpoints the review page and the speaking phone use. Synthetic swings and shots, no clips.

  cd server && python -m unittest tests.test_practice
"""
import gzip
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).parent
TMP = Path(tempfile.mkdtemp(prefix="swingclips-test-"))
# app.py reads its folders when it's imported (another test may have imported it already).
os.environ.setdefault("SWINGCLIPS_CLIPS", str(TMP / "clips"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import practice  # noqa: E402
from practice import BY_KEY, Practice  # noqa: E402

try:
    from py_mini_racer import MiniRacer
except ImportError:
    MiniRacer = None

T0 = 1_790_000_000.0   # a made-up strike time (unix seconds)


class Clock:
    def __init__(self, t):
        self.t = t

    def __call__(self):
        return self.t


def shot(path=-4.0, face=-1.0, carry=150.0, side=-3.0, club="I7"):
    return {"club": club, "ball": {"speed": 110.0, "carry": carry, "side": side, "vla": 18.0},
            "clubData": {"speed": 80.0, "path": path, "faceToTarget": face, "angleOfAttack": -3.5, "smash": 1.38}}


def record(body=None, face_codes=(), dtl_codes=(), p6_estimated=False, partner="dtl.mp4"):
    b = {"tempo": 3.2, "backswing": 0.78, "downswing": 0.24, "headSway": -0.4, "earlyExt": 1.1,
         "handsPlaneP6": 0.5, **(body or {})}
    return {"body": b, "partner": partner, "code": "x",
            "quality": {"camera": {"face": list(face_codes), "dtl": list(dtl_codes)}, "p6Estimated": p6_estimated}}


def swing(i, t, **kw):
    return {"name": f"swing_face_{i}.mp4", "t": t, "shot": None, "pose": "done", "partner": f"swing_dtl_{i}.mp4",
            "partnerPose": "done", "angle": "face", **kw}


class SentenceTest(unittest.TestCase):
    def test_in_range(self):
        m = BY_KEY["tempo"]
        self.assertEqual(practice.sentence(m, 3.2, practice.judge(m, 3.2, 2.8, 3.4)), "Tempo 3.2, in range")

    def test_out_of_range_says_which_way(self):
        m = BY_KEY["path"]
        self.assertEqual(practice.judge(m, -4.0, -2, 2), "low")
        self.assertEqual(practice.sentence(m, -4.0, "low"), "Club path minus 4, too far left")
        self.assertEqual(practice.sentence(m, 3.46, "high"), "Club path 3.5, too far right")
        self.assertEqual(practice.sentence(BY_KEY["faceToPath"], -2.26, "low"), "Face to path minus 2.3, too closed")

    def test_numbers(self):
        self.assertEqual(practice.spoken_number(BY_KEY["carry"], 151.6), "152")
        self.assertEqual(practice.spoken_number(BY_KEY["smash"], 1.4), "1.4")
        self.assertEqual(practice.spoken_number(BY_KEY["backswing"], 0.781), "0.78")
        self.assertEqual(practice.spoken_number(BY_KEY["path"], -0.04), "0")    # not "minus 0"
        self.assertEqual(practice.spoken_number(BY_KEY["tempo"], 3.0), "3")

    def test_compares_the_number_as_spoken(self):
        # 3.44 is heard as 3.4: it would be odd to hear "3.4, too high" with a range up to 3.4.
        m = BY_KEY["tempo"]
        self.assertEqual(practice.judge(m, 3.44, 2.8, 3.4), "in")
        self.assertEqual(practice.judge(m, 3.46, 2.8, 3.4), "high")

    def test_streak_and_no_reading(self):
        m = BY_KEY["tempo"]
        self.assertEqual(practice.sentence(m, 3.1, "in", streak=2), "Tempo 3.1, in range")
        self.assertEqual(practice.sentence(m, 3.1, "in", streak=3), "Tempo 3.1, in range, 3 in a row")
        self.assertEqual(practice.sentence(m, None, "none"), "Tempo, no reading")
        self.assertEqual(practice.sentence(BY_KEY["path"], None, "none", why="no shot"), "Club path, no shot")


class ReliabilityTest(unittest.TestCase):
    def test_camera_check_blocks_that_cameras_numbers_only(self):
        rec = record(face_codes=["out"])
        self.assertEqual(practice.reading(BY_KEY["tempo"], rec, None), (None, "camera check: out"))
        self.assertEqual(practice.reading(BY_KEY["headSway"], rec, None)[0], None)
        self.assertEqual(practice.reading(BY_KEY["earlyExt"], rec, None), (1.1, None))
        rec = record(dtl_codes=["hands", "small"])
        self.assertEqual(practice.reading(BY_KEY["earlyExt"], rec, None), (None, "camera check: hands"))
        self.assertEqual(practice.reading(BY_KEY["tempo"], rec, None), (3.2, None))

    def test_small_or_edge_alone_is_still_spoken(self):
        self.assertEqual(practice.reading(BY_KEY["tempo"], record(face_codes=["edge", "small"]), None), (3.2, None))

    def test_missing_and_failed(self):
        self.assertEqual(practice.reading(BY_KEY["tempo"], record({"tempo": None}), None), (None, "not measured"))
        self.assertEqual(practice.reading(BY_KEY["tempo"], {"error": "boom"}, None), (None, "not measured"))
        self.assertEqual(practice.reading(BY_KEY["tempo"], None, None), (None, "not measured"))
        self.assertEqual(practice.reading(BY_KEY["path"], None, {"ball": {}, "clubData": {}}), (None, "not in the shot"))
        self.assertEqual(practice.reading(BY_KEY["path"], None, None), (None, "no shot"))

    def test_estimated_p6(self):
        self.assertEqual(practice.reading(BY_KEY["handsPlaneP6"], record(p6_estimated=True), None), (None, "P6 estimated"))
        self.assertEqual(practice.reading(BY_KEY["handsPlaneP6"], record(), None), (0.5, None))

    def test_face_on_turns_not_offered_noisy_ones_labeled(self):
        for key in ("shoulderTop", "pelvisTop", "xFactor"):
            self.assertNotIn(key, BY_KEY)
        self.assertTrue(BY_KEY["shaftPlaneP6"]["noisy"])
        self.assertFalse(BY_KEY["tempo"]["noisy"])


class PracticeTest(unittest.TestCase):
    def setUp(self):
        d = Path(tempfile.mkdtemp(prefix="swingclips-practice-"))
        self.files = (d / "practice.json", d / "practice-log.jsonl")
        self.clock = Clock(T0 - 60)
        self.p = Practice(*self.files, clock=self.clock)

    def turn_on(self, metric="tempo", lo=2.8, hi=3.4, **kw):
        self.p.set_config({"on": True, "metric": metric, "min": lo, "max": hi, **kw})

    def test_nothing_while_off(self):
        self.clock.t = T0 + 30
        self.assertEqual(self.p.step([swing(1, T0)], {"swing_face_1.mp4": record()}), [])

    def test_body_number_once_ready_and_only_once(self):
        self.turn_on()
        s = [swing(1, T0)]
        self.clock.t = T0 + 20
        self.assertEqual(self.p.step(s, {}), [])  # not worked out yet
        self.clock.t = T0 + 40
        [e] = self.p.step(s, {"swing_face_1.mp4": record()})
        self.assertEqual((e["text"], e["status"], e["value"]), ("Tempo 3.2, in range", "in", 3.2))
        self.assertEqual(self.p.step(s, {"swing_face_1.mp4": record()}), [])

    def test_swings_before_practice_was_turned_on_stay_quiet(self):
        self.clock.t = T0 + 5
        self.turn_on()
        self.clock.t = T0 + 40
        self.assertEqual(self.p.step([swing(1, T0)], {"swing_face_1.mp4": record()}), [])

    def test_unreliable_camera_says_no_reading(self):
        self.turn_on()
        self.clock.t = T0 + 40
        [e] = self.p.step([swing(1, T0)], {"swing_face_1.mp4": record(face_codes=["hands"])})
        self.assertEqual((e["text"], e["status"], e["why"]), ("Tempo, no reading", "none", "camera check: hands"))

    def test_failed_pose_and_body_give_up(self):
        self.turn_on()
        self.clock.t = T0 + 30
        [e] = self.p.step([swing(1, T0, pose="failed")], {})
        self.assertEqual(e["text"], "Tempo, no reading")
        s = [swing(2, T0 + 10)]
        self.clock.t = T0 + 10 + practice.BODY_GIVE_UP_S - 1
        self.assertEqual(self.p.step(s, {}), [])
        self.clock.t = T0 + 10 + practice.BODY_GIVE_UP_S + 1
        self.assertEqual(self.p.step(s, {})[0]["text"], "Tempo, no reading")

    def test_square_number_waits_for_the_shot(self):
        self.turn_on("path", -2, 2)
        self.clock.t = T0 + 10
        self.assertEqual(self.p.step([swing(1, T0)], {}), [])
        self.clock.t = T0 + 14.5
        [e] = self.p.step([swing(1, T0, shot=shot(path=-4.0))], {})
        self.assertEqual(e["text"], "Club path minus 4, too far left")
        self.assertEqual(e["club"], "I7")

    def test_square_number_without_a_shot_gives_up(self):
        self.turn_on("faceToPath", -1, 1)
        s = [swing(1, T0)]
        self.clock.t = T0 + practice.SHOT_GIVE_UP_S - 1
        self.assertEqual(self.p.step(s, {"swing_face_1.mp4": record()}), [])
        self.clock.t = T0 + practice.SHOT_GIVE_UP_S + 0.5
        [e] = self.p.step(s, {"swing_face_1.mp4": record()})
        self.assertEqual((e["text"], e["status"], e["why"]), ("Face to path, no shot", "none", "no shot"))
        # The shot turning up late doesn't make it speak again.
        self.clock.t = T0 + 40
        self.assertEqual(self.p.step([swing(1, T0, shot=shot())], {}), [])

    def test_square_number_ignores_the_camera_check(self):
        self.turn_on("carry", 140, 160)
        self.clock.t = T0 + 15
        [e] = self.p.step([swing(1, T0, shot=shot(carry=151.2))], {"swing_face_1.mp4": record(face_codes=["out"])})
        self.assertEqual(e["text"], "Carry 151, in range")

    def test_one_result_per_swing_when_the_listed_clip_changes(self):
        # A down-the-line clip listed alone at first, then its face-on clip arrives and lists the swing.
        self.turn_on("path", -2, 2)
        self.clock.t = T0 + 15
        lone = {**swing(1, T0 + 0.4, shot=shot()), "name": "swing_dtl_1.mp4", "angle": "dtl", "partner": None}
        self.assertEqual(len(self.p.step([lone], {})), 1)
        self.clock.t = T0 + 16
        self.assertEqual(self.p.step([swing(1, T0, shot=shot())], {}), [])

    def test_down_the_line_number_waits_for_the_other_clip(self):
        self.turn_on("earlyExt", 0, 1.5)
        s = [swing(1, T0)]
        early = {"swing_face_1.mp4": record({"earlyExt": None}, partner=None)}
        self.clock.t = T0 + 40
        self.assertEqual(self.p.step(s, early), [])
        self.assertEqual(self.p.step(s, {"swing_face_1.mp4": record({"earlyExt": 2.04})})[0]["text"],
                         "Early extension 2, too far toward the ball")

    def test_streak(self):
        self.turn_on()
        texts = []
        values = [3.0, 3.1, None, 3.2, 3.6, 3.0]
        for i, v in enumerate(values):
            t = T0 + i * 30
            self.clock.t = t + 40
            [e] = self.p.step([swing(i, t)], {f"swing_face_{i}.mp4": record({"tempo": v})})
            texts.append(e["text"])
        self.assertEqual(texts, ["Tempo 3, in range", "Tempo 3.1, in range", "Tempo, no reading",
                                 "Tempo 3.2, in range, 3 in a row", "Tempo 3.6, too high", "Tempo 3, in range"])

    def test_streak_can_be_turned_off_and_resets_with_a_new_target(self):
        self.turn_on(streak=False)
        for i in range(3):
            self.clock.t = T0 + i * 30 + 40
            [e] = self.p.step([swing(i, T0 + i * 30)], {f"swing_face_{i}.mp4": record()})
        self.assertEqual(e["text"], "Tempo 3.2, in range")
        self.assertEqual(e["streak"], 3)
        self.turn_on(lo=3.0, hi=3.4)
        t = self.clock.t + 1
        self.clock.t = t + 40
        [e] = self.p.step([swing(9, t)], {"swing_face_9.mp4": record()})
        self.assertEqual(e["streak"], 1)

    def test_phone_gets_each_result_once_and_not_stale_ones(self):
        self.turn_on()
        first = self.p.latest(None, "face")
        self.assertEqual(first["results"], [])
        self.clock.t = T0 + 40
        [e] = self.p.step([swing(1, T0)], {"swing_face_1.mp4": record()})
        got = self.p.latest(first["last"])
        self.assertEqual([r["text"] for r in got["results"]], ["Tempo 3.2, in range"])
        self.assertEqual(self.p.latest(got["results"][-1]["id"])["results"], [])
        # After a long Wi-Fi drop: too late to say it.
        self.clock.t += practice.SPEAK_WITHIN_S + 1
        self.assertEqual(self.p.latest(first["last"])["results"], [])
        self.assertIn("face", self.p.state()["listeners"])

    def test_voice_check_speaks_even_when_off(self):
        last = self.p.latest(None)["last"]
        self.p.voice_check()
        [r] = self.p.latest(last)["results"]
        self.assertIn("voice check", r["text"])

    def test_log_and_ids_survive_a_restart(self):
        self.turn_on()
        self.clock.t = T0 + 40
        [e] = self.p.step([swing(1, T0)], {"swing_face_1.mp4": record()})
        again = Practice(*self.files, clock=self.clock)
        self.assertTrue(again.config["on"])
        self.assertEqual(again.log[-1]["text"], e["text"])
        self.assertEqual(again.step([swing(1, T0)], {"swing_face_1.mp4": record()}), [])  # not said twice
        self.assertGreater(again.voice_check()["id"], e["id"])

    def test_bad_targets_refused(self):
        for bad in ({"metric": "nope", "min": 0, "max": 1}, {"metric": "tempo", "min": 3, "max": 2},
                    {"metric": "tempo", "min": None, "max": 2}, {"metric": "tempo", "min": "x", "max": 2}):
            with self.assertRaises(ValueError):
                self.p.set_config(bad)


@unittest.skipIf(MiniRacer is None, "needs mini-racer")
class MatchesThePageTest(unittest.TestCase):
    """The keys and Square readings agree with summary.js, which the page and swings.py use."""

    @classmethod
    def setUpClass(cls):
        cls.ctx = MiniRacer()
        for f in ("phases.js", "metrics.js", "summary.js"):
            cls.ctx.eval((HERE.parent / "static" / f).read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls):
        cls.ctx.close()

    def js(self, expr):
        return json.loads(self.ctx.eval(f"JSON.stringify({expr})"))

    def test_body_keys_and_cameras(self):
        body = {f["key"]: f for f in self.js("SwingSummary.BODY")}
        for m in practice.METRICS:
            if m["kind"] == "body":
                self.assertIn(m["key"], body)
                self.assertEqual(m["view"], body[m["key"]]["view"], m["key"])
                self.assertEqual(m["pos"] == "p6", body[m["key"]].get("pos") == "p6", m["key"])

    def test_shot_numbers(self):
        s = shot(path=-3.1, face=0.4)
        js = self.js(f"SwingSummary.shotNumbers({json.dumps(s)})")
        for m in practice.METRICS:
            if m["kind"] == "shot":
                self.assertAlmostEqual(practice.reading(m, None, s)[0], js[m["key"]], msg=m["key"])


try:
    from fastapi.testclient import TestClient  # needs httpx, which the server itself doesn't
except (ImportError, RuntimeError):
    TestClient = None


@unittest.skipIf(TestClient is None, "needs httpx")
class EndpointsTest(unittest.TestCase):
    """Through app.py: real clip names, a shot posted like the shot listener does, the summarizer."""

    @classmethod
    def setUpClass(cls):
        import app
        cls.app = app
        d = Path(tempfile.mkdtemp(prefix="swingclips-practice-"))
        cls.clock = Clock(0)
        app.practice_state = Practice(d / "practice.json", d / "practice-log.jsonl", clock=cls.clock)
        cls.client = TestClient(app.app)  # not as a context manager: no background workers

    def put_clip(self, name):
        self.app.CLIPS_DIR.mkdir(parents=True, exist_ok=True)
        (self.app.CLIPS_DIR / name).write_bytes(b"not really a video")

    def test_1_target_validation(self):
        c = self.client
        self.assertEqual(c.post("/api/practice", json={"metric": "tempo", "min": 3.5, "max": 3}).status_code, 400)
        self.assertEqual(c.post("/api/practice", json={"metric": "xFactor", "min": 0, "max": 9}).status_code, 400)
        state = c.get("/api/practice").json()
        self.assertFalse(state["config"]["on"])
        self.assertIn("tempo", [m["key"] for m in state["metrics"]])

    def test_2_square_number_end_to_end(self):
        t = 1_789_300_000
        self.clock.t = t - 30
        r = self.client.post("/api/practice", json={"on": True, "metric": "path", "min": -2, "max": 2})
        self.assertEqual(r.status_code, 200, r.text)
        last = self.client.get("/api/practice/latest").json()["last"]
        self.put_clip(f"swing_face_1280x720_240fps_{t}_2000ms.mp4")
        self.put_clip(f"swing_dtl_1280x720_240fps_{t}_2010ms.mp4")
        self.clock.t = t + 10
        self.assertEqual(self.app.practice_tick(), [])
        # Square's report, ~14 s after the strike.
        sent = datetime.fromtimestamp(t + 14).astimezone().isoformat()
        self.assertEqual(self.client.post("/api/shots", json={**shot(path=2.6), "received": sent, "source": "square-app"}).status_code, 200)
        self.clock.t = t + 15
        [e] = self.app.practice_tick()
        self.assertEqual(e["text"], "Club path 2.6, too far right")
        got = self.client.get(f"/api/practice/latest?since={last}&angle=face&wait=1").json()
        self.assertEqual([x["text"] for x in got["results"]], [e["text"]])
        # A long poll with nothing new comes back empty after the wait.
        again = self.client.get(f"/api/practice/latest?since={e['id']}&wait=0.3").json()
        self.assertEqual(again["results"], [])

    def test_3_swing_without_a_shot(self):
        t = 1_789_300_100
        self.put_clip(f"swing_face_1280x720_240fps_{t}_2000ms.mp4")
        self.clock.t = t + 26
        [e] = self.app.practice_tick()
        self.assertEqual(e["text"], "Club path, no shot")

    def test_4_body_number_from_the_summarizer(self):
        import swings
        import synthetic
        app = self.app
        face = synthetic.pose_file(seed=1)
        self.clock.t = 1_789_123_456 - 30
        self.client.post("/api/practice", json={"on": True, "metric": "tempo", "min": 1, "max": 9})
        self.put_clip(synthetic.NAME)
        app.POSE_DIR.mkdir(parents=True, exist_ok=True)
        app.pose_file(synthetic.NAME).write_bytes(gzip.compress(json.dumps(face).encode()))
        summarizer = swings.Summarizer(app.STATIC_DIR)
        try:
            clip = next(c for c in app.listed_clips(with_shots=False) if c["name"] == synthetic.NAME)
            rec = summarizer.summarize(swings.pose_input(clip, app.pose_file(synthetic.NAME)), None)
        finally:
            summarizer.close()
        rec.update(code=summarizer.code, partner=clip["partner"])
        self.clock.t = 1_789_123_456 + 5
        self.assertEqual(app.practice_tick(), [])     # not worked out yet
        app.swings_code = summarizer.code
        with app.records_lock:
            app.swing_records[synthetic.NAME] = rec
        [e] = app.practice_tick()
        self.assertEqual(e["status"], "in", e)
        self.assertEqual(e["text"], f"Tempo {practice.spoken_number(BY_KEY['tempo'], rec['body']['tempo'])}, in range")

    def test_5_voice_check(self):
        last = self.client.get("/api/practice/latest").json()["last"]
        self.client.post("/api/practice/test")
        got = self.client.get(f"/api/practice/latest?since={last}").json()
        self.assertEqual(len(got["results"]), 1)


if __name__ == "__main__":
    unittest.main()
