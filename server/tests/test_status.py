"""Session status (status.py): phone heartbeats and going stale, the command queue and its answers,
the Square watcher's heartbeat, one voice for camera setup, and the first swing's check. Made-up
phones and swings, a fake clock.

  cd server && python -m unittest tests.test_status
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).parent
TMP = Path(tempfile.mkdtemp(prefix="swingclips-test-"))
os.environ.setdefault("SWINGCLIPS_CLIPS", str(TMP / "clips"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import status  # noqa: E402
from status import Status  # noqa: E402

T0 = 1_790_000_000.0


class Clock:
    def __init__(self, t=T0):
        self.t = t

    def __call__(self):
        return self.t


def hb(**kw):
    return {"recording": False, "mode": "1080p 240 fps", "shutter": "Auto", "battery": 80, "charging": False,
            "pending": 0, "practiceVoice": False, "setupVoice": "combined", "version": "0.6", **kw}


def verdict(ok=True, say=None, age=0.5, text=None, cam="Face on"):
    return {"ok": ok, "say": say or (f"{cam}: good." if ok else f"{cam}: tilt the phone up."),
            "text": text or ("Good: all of you is in the picture." if ok else "Tilt the phone up."), "age": age}


class HeartbeatTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.s = Status(self.clock)

    def test_keeps_the_latest_and_goes_stale(self):
        self.s.heartbeat("face", hb(battery=55, junk="x", mode=123))
        snap = self.s.snapshot({}, {"queued": 0}, None)
        face = snap["phones"]["face"]
        self.assertTrue(face["connected"])
        self.assertEqual(face["battery"], 55)
        self.assertNotIn("junk", face)
        self.assertNotIn("mode", face)          # wrong type: dropped
        self.clock.t += status.PHONE_GONE_S + 1
        self.assertFalse(self.s.connected("face"))
        row = next(r for r in self.s.snapshot({}, {}, None)["rows"] if r["key"] == "face")
        self.assertEqual(row["level"], "bad")
        self.assertIn("not connected", row["text"])

    def test_closing_is_gone_at_once(self):
        self.s.heartbeat("dtl", hb())
        self.s.heartbeat("dtl", hb(closing=True))
        self.assertFalse(self.s.connected("dtl"))
        row = next(r for r in self.s.snapshot({}, {}, None)["rows"] if r["key"] == "dtl")
        self.assertIn("app closed", row["text"])

    def test_ready_when_everything_is_fine(self):
        for a in ("face", "dtl"):
            self.s.heartbeat(a, hb(recording=True))
        self.s.relay_heartbeat({"source": "launcher", "squareRunning": True, "version": "1"})
        snap = self.s.snapshot({"face": verdict(), "dtl": verdict(cam="Down the line")}, {"queued": 0}, T0 - 60)
        self.assertEqual(snap["level"], "ok", snap["rows"])
        self.assertEqual(snap["headline"], "Ready")

    def test_amber_and_red(self):
        self.s.heartbeat("face", hb(recording=True, battery=15))
        self.s.relay_heartbeat({"squareRunning": True})
        snap = self.s.snapshot({}, {"queued": 0}, None)
        self.assertEqual(snap["level"], "warn")        # low battery, not charging
        self.s.heartbeat("face", hb(recording=True, battery=15, charging=True))
        self.assertEqual(self.s.snapshot({}, {"queued": 0}, None)["level"], "ok")
        self.s.heartbeat("face", hb(recording=False))
        snap = self.s.snapshot({}, {"queued": 0}, None)
        self.assertEqual(snap["level"], "bad")
        self.assertEqual(snap["headline"], "Face-on: not recording")

    def test_a_phone_never_seen_isnt_needed(self):
        self.s.heartbeat("face", hb(recording=True))
        self.s.relay_heartbeat({"squareRunning": True})
        snap = self.s.snapshot({}, {"queued": 0}, None)
        dtl = next(r for r in snap["rows"] if r["key"] == "dtl")
        self.assertEqual(dtl["level"], "off")
        self.assertEqual(snap["level"], "ok")

    def test_square_rows(self):
        row = lambda: next(r for r in self.s.snapshot({}, {}, T0 - 30)["rows"] if r["key"] == "square")
        self.assertEqual(row()["level"], "warn")                      # no heartbeat yet
        self.s.relay_heartbeat({"squareRunning": False})
        self.assertEqual(row()["level"], "bad")
        self.s.relay_heartbeat({"squareRunning": True, "lastShotAt": "2026-09-25T10:00:00"})
        self.assertEqual(row()["level"], "ok")
        self.assertIn("last shot 30 s ago", row()["text"])
        self.clock.t += status.RELAY_GONE_S + 1
        self.assertIn("watcher stopped", row()["text"])

    def test_pose_queue(self):
        row = lambda q: next(r for r in self.s.snapshot({}, {"queued": q}, None)["rows"] if r["key"] == "server")
        self.assertEqual(row(0)["level"], "ok")
        self.assertEqual(row(status.POSE_BEHIND)["level"], "warn")

    def test_old_setup_verdict_doesnt_block_ready(self):
        self.s.heartbeat("face", hb(recording=True))
        framing = lambda v: next(r for r in self.s.snapshot({"face": v}, {}, None)["rows"] if r["key"] == "framing")
        self.assertEqual(framing(verdict(ok=False, age=1))["level"], "bad")
        self.assertEqual(framing(verdict(ok=False, age=300))["level"], "ok")


class CommandTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.s = Status(self.clock)

    def test_queue_deliver_ack(self):
        self.s.heartbeat("face", hb())
        self.s.heartbeat("dtl", hb())
        out = self.s.command("start", "both")
        self.assertEqual([(r["angle"], r["state"]) for r in out], [("face", "queued"), ("dtl", "queued")])
        self.assertTrue(self.s.has_mail("face"))
        got = self.s.take("face")
        self.assertEqual([c["action"] for c in got["commands"]], ["start"])
        self.assertEqual(self.s.take("face")["commands"], [])          # once
        self.assertFalse(self.s.has_mail("face"))
        cid = got["commands"][0]["id"]
        self.s.heartbeat("face", hb(recording=True, acks=[{"id": cid, "ok": True}]))
        dtl_id = self.s.take("dtl")["commands"][0]["id"]
        self.s.heartbeat("dtl", hb(acks=[{"id": dtl_id, "ok": False, "error": "camera busy"}]))
        phones = self.s.snapshot({}, {}, None)["phones"]
        self.assertEqual(phones["face"]["command"]["state"], "done")
        self.assertEqual(phones["dtl"]["command"]["state"], "failed")
        self.assertEqual(phones["dtl"]["command"]["error"], "camera busy")

    def test_refused_when_not_connected_or_busy(self):
        self.s.heartbeat("face", hb(busy="a setting is being changed on the phone"))
        [r] = self.s.command("start", "face")
        self.assertEqual((r["state"], r["error"]), ("failed", "a setting is being changed on the phone"))
        [r] = self.s.command("stop", "dtl")
        self.assertEqual(r["state"], "failed")
        self.assertIn("not connected", r["error"])
        self.assertFalse(self.s.has_mail("face"))

    def test_both_means_the_phones_in_use(self):
        self.s.heartbeat("face", hb())
        self.assertEqual([r["angle"] for r in self.s.command("stop", "both")], ["face"])

    def test_no_answer_times_out_and_isnt_delivered_late(self):
        self.s.heartbeat("face", hb())
        self.s.command("start", "face")
        self.clock.t += status.COMMAND_TIMEOUT_S + 1
        self.assertEqual(self.s.take("face")["commands"], [])
        cmd = self.s.snapshot({}, {}, None)["phones"]["face"]["command"]
        self.assertEqual((cmd["state"], cmd["error"]), ("failed", "no answer from the phone"))

    def test_newer_command_replaces_an_undelivered_one(self):
        self.s.heartbeat("face", hb())
        self.s.command("start", "face")
        self.s.command("stop", "face")
        self.assertEqual([c["action"] for c in self.s.take("face")["commands"]], ["stop"])

    def test_bad_requests(self):
        with self.assertRaises(ValueError):
            self.s.command("explode", "face")
        with self.assertRaises(ValueError):
            self.s.command("start", "side")

    def test_ack_for_another_phone_is_ignored(self):
        self.s.heartbeat("face", hb())
        self.s.heartbeat("dtl", hb())
        [r] = self.s.command("start", "face")
        self.s.heartbeat("dtl", hb(acks=[{"id": r["id"], "ok": True}]))
        self.assertEqual(self.s.snapshot({}, {}, None)["phones"]["face"]["command"]["state"], "queued")


class CombinedVoiceTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.s = Status(self.clock)
        self.s.heartbeat("face", hb(practiceVoice=True))
        self.s.heartbeat("dtl", hb())

    def feed(self, face, dtl, times=3, step=1.0):
        said = []
        for _ in range(times):
            got = self.s.setup_verdicts({"face": face, "dtl": dtl})
            if got:
                said.append(got)
            self.clock.t += step
        return said

    def test_both_good_said_once_by_the_speaking_phone(self):
        self.assertEqual(self.feed(verdict(), verdict(cam="Down the line"), times=6), ["Both cameras look good."])
        self.assertEqual([x["text"] for x in self.s.take("face")["say"]], ["Both cameras look good."])
        self.assertEqual(self.s.take("dtl")["say"], [])

    def test_one_problem(self):
        dtl = verdict(ok=False, cam="Down the line", say="Down the line: you're at the left edge: aim the phone more toward you.")
        self.assertEqual(self.feed(verdict(), dtl),
                         ["Face-on good. Down the line: you're at the left edge: aim the phone more toward you."])

    def test_only_on_change_no_repeats(self):
        bad = verdict(ok=False, cam="Down the line")
        self.assertEqual(len(self.feed(verdict(), bad, times=20)), 1)
        self.assertEqual(self.feed(verdict(), verdict(cam="Down the line")), ["Both cameras look good."])
        self.assertEqual(self.feed(verdict(), bad), ["Face-on good. Down the line: tilt the phone up."])

    def test_a_flicker_isnt_said(self):
        good, bad = verdict(), verdict(ok=False)
        said = []
        for i in range(10):
            said += [x for x in [self.s.setup_verdicts({"face": good if i % 2 else bad, "dtl": None})] if x]
            self.clock.t += 1
        self.assertEqual(said, [])

    def test_a_phone_starting_to_record_isnt_announced(self):
        self.feed(verdict(), verdict(cam="Down the line"))
        self.s.heartbeat("dtl", hb(recording=True))
        self.assertEqual(self.feed(verdict(), verdict(cam="Down the line", age=0.5)), [])

    def test_own_voice_phone_is_left_out(self):
        self.s.heartbeat("dtl", hb(setupVoice="own"))
        self.assertEqual(self.feed(verdict(), verdict(ok=False, cam="Down the line")), ["Face-on good."])

    def test_speaker_on_own_voice_hands_it_to_a_combined_phone(self):
        self.s.heartbeat("face", hb(practiceVoice=True, setupVoice="own"))
        self.feed(verdict(), verdict(ok=False, cam="Down the line"))
        self.assertEqual([x["text"] for x in self.s.take("dtl")["say"]], ["Down the line: tilt the phone up."])

    def test_stale_verdicts_dont_count(self):
        self.assertEqual(self.feed(verdict(age=30), verdict(cam="Down the line", age=30)), [])

    def test_board(self):
        board = {"ok": True, "board": {"placed": True}, "say": "Face on: board seen.", "age": 0.2}
        self.assertEqual(self.feed(board, verdict(cam="Down the line")), ["Face on: board seen. Down the line good."])

    def test_nobody(self):
        nobody = {"ok": False, "say": "Down the line: I can't see you.", "text": "Can't see you: stand at the ball.", "age": 1}
        self.assertEqual(self.feed(verdict(), nobody), ["Face-on good. Down the line: I can't see you."])


def swing(i, t, shot=True, codes=None, dtl_codes=None, partner=True, quality=None, pose="done", record=True):
    rec = {"quality": {"swingFound": True, "camera": {"face": codes or [], "dtl": (dtl_codes or []) if partner else None}}}
    q = quality or {"face": {"warnings": []}, "dtl": {"warnings": []} if partner else None}
    return {"name": f"swing_face_{i}.mp4", "t": t, "angle": "face", "partner": f"swing_dtl_{i}.mp4" if partner else None,
            "pose": pose, "partnerPose": "done" if partner else None, "shot": {"club": "I7"} if shot else None,
            "record": rec if record else None, "quality": q}


class HealthTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.s = Status(self.clock)
        self.s.relay_heartbeat({"squareRunning": True})
        self.s.heartbeat("face", hb(practiceVoice=True))
        self.s.heartbeat("dtl", hb())
        # Recording starts: a session.
        self.s.heartbeat("face", hb(practiceVoice=True, recording=True))
        self.s.heartbeat("dtl", hb(recording=True))
        self.start = self.clock.t

    def step(self, swings, at):
        self.clock.t = at
        self.s.heartbeat("face", hb(practiceVoice=True, recording=True))
        self.s.heartbeat("dtl", hb(recording=True))
        self.s.relay_heartbeat({"squareRunning": True})
        return self.s.health_step(swings)

    def test_session_starts_when_recording_starts(self):
        self.assertEqual(self.s.session_since(), self.start)
        self.s.heartbeat("face", hb(recording=False))
        self.s.heartbeat("dtl", hb(recording=False))
        self.clock.t += status.SESSION_TAIL_S + 1
        self.assertIsNone(self.s.session_since())
        self.s.heartbeat("face", hb(recording=True))
        self.assertEqual(self.s.session_since(), self.clock.t)

    def test_first_swing_all_good_said_once(self):
        t = self.start + 10
        self.assertEqual(self.step([swing(1, t)], t + 40), ["First swing: both cameras saw you, Square paired."])
        self.assertEqual([x["text"] for x in self.s.take("face")["say"]], ["First swing: both cameras saw you, Square paired."])
        self.assertEqual(self.step([swing(1, t)], t + 42), [])
        # Later good swings: nothing.
        self.assertEqual(self.step([swing(1, t), swing(2, t + 30)], t + 80), [])

    def test_first_swing_problems(self):
        t = self.start + 10
        said = self.step([swing(1, t, shot=False, dtl_codes=["noball"])], t + 40)
        self.assertEqual(said, ["First swing. Down the line: ball not found. No Square shot."])

    def test_out_of_the_picture_at_the_top_and_quality(self):
        t = self.start + 10
        q = {"face": {"warnings": ["dark", "flicker"], "flickerLevel": "mild"}, "dtl": {"warnings": []}}
        said = self.step([swing(1, t, codes=["hands"], quality=q)], t + 40)
        self.assertEqual(said, ["First swing. Face-on: you're out of the picture at the top, and too dark."])

    def test_waits_for_the_shot_the_dtl_clip_and_the_analysis(self):
        t = self.start + 10
        self.assertEqual(self.step([swing(1, t, shot=False)], t + 15), [])           # Square not in yet
        self.assertEqual(self.step([swing(1, t, partner=False)], t + 40), [])        # dtl clip not in yet
        self.assertEqual(self.step([swing(1, t, record=False)], t + 40), [])         # not analyzed yet
        self.assertEqual(self.step([swing(1, t, quality={"face": None, "dtl": None})], t + 40), [])
        self.assertEqual(self.step([swing(1, t, partner=False)], t + status.DTL_WAIT_S + 1),
                         ["First swing. Down the line: no clip."])

    def test_one_phone_session(self):
        self.s.heartbeat("dtl", hb(closing=True))
        t = self.start + 10
        self.clock.t = t + 40
        said = self.s.health_step([swing(1, t, partner=False)])
        self.assertEqual(said[0], "First swing: face-on saw you, Square paired.")

    def test_square_watcher_down(self):
        t = self.start + 10
        self.clock.t = t + status.RELAY_GONE_S + 5
        self.s.heartbeat("face", hb(practiceVoice=True, recording=True))
        self.s.heartbeat("dtl", hb(recording=True))
        said = self.s.health_step([swing(1, t, shot=False)])
        self.assertEqual(said, ["First swing. No Square shot: the Square watcher isn't running."])

    def test_after_the_first_only_lasting_problems_once(self):
        t = self.start + 10
        self.step([swing(1, t)], t + 40)
        sw = [swing(1, t), swing(2, t + 30, shot=False)]
        self.assertEqual(self.step(sw, t + 70), [])                                   # one missed shot
        sw.append(swing(3, t + 60, shot=False))
        self.assertEqual(self.step(sw, t + 100), ["Square: no shot on the last 2 swings."])
        sw.append(swing(4, t + 90, shot=False))
        self.assertEqual(self.step(sw, t + 130), [])                                  # no repeat
        sw.append(swing(5, t + 120))
        self.assertEqual(self.step(sw, t + 160), [])                                  # cleared
        sw += [swing(6, t + 150, shot=False), swing(7, t + 180, shot=False)]
        self.assertEqual(self.step(sw, t + 230), ["Square: no shot on the last 2 swings."])

    def test_problem_from_the_first_swing_isnt_said_again(self):
        t = self.start + 10
        self.step([swing(1, t, shot=False)], t + 40)
        sw = [swing(1, t, shot=False), swing(2, t + 30, shot=False)]
        self.assertEqual(self.step(sw, t + 70), [])

    def test_camera_problem_needs_three_in_a_row(self):
        t = self.start + 10
        sw = [swing(1, t)]
        self.step(sw, t + 40)
        for i in range(2, 5):
            sw.append(swing(i, t + 30 * (i - 1), dtl_codes=["noball"]))
        said = self.step(sw, t + 200)
        self.assertEqual(said, ["Down the line: ball not found on the last 3 swings."])

    def test_phone_problems(self):
        t = self.start + 10
        self.step([swing(1, t)], t + 40)
        self.s.heartbeat("dtl", hb(recording=True, pending=4))
        self.assertEqual(self.s.health_step([swing(1, t)]), ["Down the line phone: 4 clips waiting to upload."])
        self.assertEqual(self.s.health_step([swing(1, t)]), [])
        # The face-on phone stops answering while recording.
        self.clock.t += status.PHONE_GONE_S + 1
        self.s.heartbeat("dtl", hb(recording=True))
        self.assertEqual(self.s.health_step([swing(1, t)]), ["The face-on phone isn't answering."])
        # Said by the phone that's left.
        self.assertIn("The face-on phone isn't answering.", [x["text"] for x in self.s.take("dtl")["say"]])

    def test_swings_from_before_the_session_arent_checked(self):
        self.assertEqual(self.step([swing(1, self.start - 60)], self.start + 40), [])

    def test_one_check_per_swing_when_the_listed_clip_changes(self):
        t = self.start + 10
        lone = swing(1, t, partner=False)
        lone["name"], lone["angle"], lone["quality"] = "swing_dtl_1.mp4", "dtl", {"dtl": {"warnings": []}}
        self.s.heartbeat("dtl", hb(recording=True))
        self.clock.t = t + 100
        self.assertEqual(self.s.health.step([lone], self.clock.t, expect_dtl=False, relay_ok=True),
                         ["First swing: down the line saw you, Square paired."])
        self.assertEqual(self.s.health.step([swing(1, t + 0.5)], self.clock.t, expect_dtl=True, relay_ok=True), [])


try:
    from fastapi.testclient import TestClient
except (ImportError, RuntimeError):
    TestClient = None


@unittest.skipIf(TestClient is None, "needs httpx")
class EndpointsTest(unittest.TestCase):
    """Through app.py, as a phone, the review page and the laptop use them."""

    @classmethod
    def setUpClass(cls):
        import app
        cls.app = app
        cls.clock = Clock()
        app.session_status = Status(cls.clock)
        cls.client = TestClient(app.app)

    def test_poll_command_ack(self):
        c = self.client
        got = c.post("/api/phones/face/poll?wait=0", json=hb(practiceVoice=True)).json()
        self.assertEqual((got["commands"], got["say"]), ([], []))
        r = c.post("/api/phones/command", json={"action": "start", "angle": "face"}).json()
        self.assertEqual(r["results"][0]["state"], "queued")
        got = c.post("/api/phones/face/poll?wait=5", json=hb()).json()     # comes back at once
        [cmd] = got["commands"]
        self.assertEqual(cmd["action"], "start")
        c.post("/api/phones/face/poll?wait=0", json=hb(recording=True, acks=[{"id": cmd["id"], "ok": True}]))
        snap = c.get("/api/status").json()
        self.assertEqual(snap["phones"]["face"]["command"]["state"], "done")
        self.assertTrue(snap["phones"]["face"]["recording"])

    def test_bad_requests(self):
        c = self.client
        self.assertEqual(c.post("/api/phones/side/poll", json=hb()).status_code, 404)
        self.assertEqual(c.post("/api/phones/face/poll", json=[1]).status_code, 400)
        self.assertEqual(c.post("/api/phones/command", json={"action": "fly"}).status_code, 400)
        self.assertEqual(c.post("/api/relay/heartbeat", json="x").status_code, 400)

    def test_relay_heartbeat(self):
        r = self.client.post("/api/relay/heartbeat", json={"source": "launcher", "squareRunning": True,
                                                           "lastShotAt": "2026-09-25T10:00:00", "version": "1.0"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["got"]["source"], "launcher")
        snap = self.client.get("/api/status").json()
        self.assertEqual(snap["relay"]["version"], "1.0")
        self.assertEqual(next(x for x in snap["rows"] if x["key"] == "square")["level"], "ok")

    def test_status_tick_first_swing(self):
        import json
        app = self.app
        t = int(self.clock.t) + 1000
        self.clock.t = t - 5
        app.session_status.heartbeat("face", hb(practiceVoice=True, recording=True))
        app.session_status.relay_heartbeat({"squareRunning": True})
        name = f"swing_face_1280x720_240fps_{t}_2000ms.mp4"
        app.CLIPS_DIR.mkdir(parents=True, exist_ok=True)
        (app.CLIPS_DIR / name).write_bytes(b"not really a video")
        (app.CLIPS_DIR / (name + ".camera.json")).write_text(json.dumps({"shutter": "Auto"}))
        self.clock.t = t + 30
        app.session_status.heartbeat("face", hb(practiceVoice=True, recording=True))
        app.session_status.relay_heartbeat({"squareRunning": True})
        self.assertEqual(app.status_tick(), [])       # not analyzed yet
        app.swings_code = "x"
        with app.records_lock:
            app.swing_records[name] = {"code": "x", "partner": None,
                                       "quality": {"swingFound": True, "camera": {"face": ["noball"], "dtl": None}}}
        self.clock.t = t + status.QUALITY_WAIT_S + 1
        app.session_status.heartbeat("face", hb(practiceVoice=True, recording=True))
        app.session_status.relay_heartbeat({"squareRunning": True})
        try:
            self.assertEqual(app.status_tick(), ["First swing. Face-on: ball not found. No Square shot."])
        finally:
            # The clips folder and the records are shared with the other tests.
            with app.records_lock:
                app.swing_records.pop(name, None)
            app.swings_code = ""
            for f in (name, name + ".camera.json"):
                (app.CLIPS_DIR / f).unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
