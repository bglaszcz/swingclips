"""Coach programs (programs.py): tapped no-ball reps, shots judged on Square's numbers and the
golfer's mark, gates, blocks moving on, the cap, and the report for the coach."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import programs  # noqa: E402

T0 = 1_790_000_000.0


class Clock:
    def __init__(self):
        self.t = T0

    def __call__(self):
        return self.t


def shot(attack=-4.0, v=-12.0, face=0.5, path=0.0, h=4.0, speed=80.0, loft=24.0, club="I7"):
    return {"club": club, "ball": {"carry": 150.0, "side": 1.0},
            "clubData": {"speed": speed, "angleOfAttack": attack, "faceToTarget": face, "path": path,
                         "loft": loft, "faceImpactH": h, "faceImpactV": v}}


def body3d(pelvis_peak=-10, arm_peak=-50, pelvis_open=18.0, pelvis_start=-100.0):
    p7_t = 100.0
    pelvis_t = p7_t + pelvis_peak / 1000.0
    arm_t = p7_t + arm_peak / 1000.0
    return {
        "numbers": {
            "pelvisOpenImpact": pelvis_open,
            "pelvisStartMs": pelvis_start,
        },
        "sequence": {
            "segments": [
                {"key": "pelvis", "t": pelvis_t, "beforeImpact": -pelvis_peak, "afterImpact": pelvis_peak > 0},
                {"key": "arm", "t": arm_t, "beforeImpact": -arm_peak, "afterImpact": arm_peak > 0},
            ],
            "armsFirst": arm_t < pelvis_t,
        }
    }


class ProgramsTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        d = Path(self.dir.name)
        self.clock = Clock()
        self.ids = iter(range(1, 10_000))
        self.drills = []
        self.p = programs.Programs(d / "program.json", d / "programs-log.jsonl", lambda: next(self.ids),
                                   self.clock, on_block=self.drills.append)
        self.swings = []

    def tearDown(self):
        self.dir.cleanup()

    def said(self):
        return [e["text"] for e in self.p.latest(0)]

    def hit(self, s, dt=30, mark=None, body3d=None, why3d=None, body=None):
        """A ball swing now, its shot in (so step takes it), and the mark tapped, if any."""
        self.clock.t += dt
        t = self.clock.t
        name = f"swing_face_1920x1080_240fps_{int(t)}_2000ms.mp4"
        self.swings.append({"t": t, "name": name, "partner": name.replace("face", "dtl"),
                            "shot": s, "body3d": body3d, "why3d": why3d, "body": body})
        if mark is not None:
            self.clock.t += 3
            self.p.tap(mark)
        self.clock.t += 12
        return self.p.step(self.swings)

    def taps(self, *oks):
        for ok in oks:
            self.clock.t += 20
            self.p.tap(ok)

    def block(self):
        return self.p.state()["program"]["blocks"][self.p.state()["program"]["block"]]["id"]

    def test_face_to_path_is_face_minus_path(self):
        n = programs.numbers_of(shot(face=0.7, path=4.6))
        self.assertAlmostEqual(n["faceToPath"], -3.9)

    def test_failed_reads_are_left_out_of_the_gate(self):
        self.assertEqual(programs.no_read(programs.numbers_of(shot(h=0.0, v=0.0))), "strike not read")
        self.assertEqual(programs.no_read(programs.numbers_of(shot(speed=0.0))), "no club speed")
        self.assertIsNone(programs.no_read(programs.numbers_of(shot())))

    def test_square_flagged_strike_is_not_read(self):
        # Square's app flags a failed impact read; the watcher sends null (56 of 321 shots, Sep 23-Oct 1).
        n = programs.numbers_of(shot(h=None, v=None))
        self.assertEqual(programs.no_read(n), "strike not read")

    def test_transfer_needs_the_loft_median_too(self):
        self.p.start("lowpoint")
        self.p.programs["lowpoint"]["blocks"][3]["requires"] = None
        for _ in range(3):
            self.p.next_block()
        for _ in range(5):
            self.hit(shot(loft=28.0))   # 5 in a row on the checks, but median loft 28 > 26.5
        self.assertIsNotNone(self.p.run)
        self.assertIn("median dynamic loft 28.0", self.p.state()["program"]["progress"])
        for _ in range(5):
            self.hit(shot(loft=24.0))   # median now 26.0
        self.assertEqual(self.p.state()["log"][-1]["results"]["transfer"], "passed")

    def test_report_has_carry_spread(self):
        self.p.start("lowpoint")
        self.p.next_block()
        self.p.next_block()
        self.hit(shot())
        self.hit(shot())
        self.assertIn("carry 150 yd, SD 0 yd", self.p.report()["text"])

    def test_strike_gate_is_one_sided_with_a_floor(self):
        c = {"key": "strikeV", "max": 3, "min": -8}
        self.assertTrue(programs.check({"strikeV": 3.0}, c))
        self.assertFalse(programs.check({"strikeV": 3.5}, c))
        self.assertTrue(programs.check({"strikeV": -6.0}, c))
        self.assertFalse(programs.check({"strikeV": -9.0}, c))

    def test_start_turns_the_first_drill_on_and_says_the_block(self):
        self.p.start("lowpoint")
        self.assertEqual(self.drills, ["toetap"])
        self.assertIn("Block 1: Lead foot only", self.said()[0])
        with self.assertRaises(ValueError):
            self.p.start("nope")

    def test_the_whole_ladder(self):
        self.p.start("lowpoint")
        # Block 1: 10 in a row; one miss at rep 5 -> not passed after 10 reps. A ball swing counts toward the cap only.
        self.taps(True, True, True, True, False)
        self.hit(shot())
        self.taps(True, True, True, True, True)
        self.assertEqual(self.block(), "stepthrough")
        self.assertEqual(self.drills[-1], "stepthrough")
        # Block 2: 10 of 10.
        self.taps(*[True] * 10)
        self.assertEqual(self.block(), "flush")
        # A no-ball rep the phones heard during a no-ball block isn't a swing twice.
        # Block 3: 7 of 10 with strike <= +3, attack <= -2, and the mark at or ahead.
        self.hit(shot(), mark=True)                  # pass
        self.hit(shot(attack=-1.0), mark=True)       # miss: attack
        self.hit(shot(v=5.0), mark=True)             # miss: strike high
        self.hit(shot(), mark=False)                 # miss: mark behind
        self.hit(shot(h=0.0, v=0.0))                 # not read: not counted
        self.assertIn("Invalid read", self.said()[-1])
        for _ in range(5):
            self.hit(shot(), mark=True)              # 6 passes
        self.hit(shot())
        self.assertEqual(self.block(), "flush")      # the 10th judged shot waits for its mark
        self.p.tap(True)                             # 7 passes
        st = self.p.state()["program"]
        self.assertEqual(st["blocks"][2]["result"], "passed")
        self.assertEqual(self.block(), "transfer")
        self.assertIsNone(self.drills[-1])           # the transfer block isn't a rehearsal
        # Block 4: 5 in a row, face to path within 2 too.
        self.hit(shot(face=3.0))                     # miss: face to path +3
        self.assertEqual("Miss: face open to path.", self.said()[-1])
        for _ in range(5):
            self.hit(shot())
        self.assertIsNone(self.p.run)
        done = self.p.state()["log"][-1]
        self.assertEqual(done["how"], "done")
        self.assertEqual(done["results"], {"toetap": "not passed", "stepthrough": "passed", "flush": "passed", "transfer": "passed"})
        rep = self.p.report()
        self.assertIn("Shots 1-10: attack angle", rep["text"])
        self.assertIn("Shots 11 on", rep["text"])  # 12 flush shots: 11 read + the one not read
        self.assertIn("Club order: 7i x", rep["text"])
        self.assertIn("mark behind", rep["text"])
        self.assertIn("invalid read, not counted (strike not read)", rep["text"])
        self.assertEqual(rep["frame"]["block"], "Lead foot only")
        self.assertTrue(rep["frame"]["partner"].startswith("swing_dtl_"))

    def test_no_wait_for_marks_nobody_taps(self):
        self.p.start("lowpoint")
        self.p.next_block()
        self.p.next_block()
        for _ in range(10):
            self.hit(shot())   # no mark taps at all: the block ends on the 10th shot, not 35 s later
        self.assertEqual(self.block(), "transfer")

    def test_transfer_skipped_when_flush_not_passed(self):
        self.p.start("lowpoint")
        self.p.next_block()
        self.p.next_block()
        for _ in range(10):
            self.hit(shot(attack=0.0), mark=True)
        self.assertIsNone(self.p.run)
        done = self.p.state()["log"][-1]
        self.assertEqual(done["results"]["flush"], "not passed")
        self.assertEqual(done["results"]["transfer"], "skipped")
        self.assertIn("Skip Transfer", " ".join(self.said()))

    def test_cap_counts_every_swing(self):
        self.p.start("lowpoint")
        self.p.next_block()
        self.p.next_block()
        self.p.next_block()   # transfer, without the flush gate: skipped -> program done
        self.assertIsNone(self.p.run)
        self.p.start("lowpoint")
        self.p.programs["lowpoint"]["cap"] = 12
        self.taps(*[True] * 10)
        self.taps(True)
        self.hit(shot())      # 12th swing: stop
        self.assertIsNone(self.p.run)
        self.assertEqual(self.p.state()["log"][-1]["how"], "cap")

    def test_finished_runs_come_judged(self):
        self.p.start("lowpoint")
        self.p.next_block()
        self.p.next_block()
        self.hit(shot(), mark=True)
        self.hit(shot(attack=0.0), mark=True)
        self.p.stop()
        run = self.p.state()["log"][-1]
        flush = next(b for b in run["blocks"] if b["id"] == "flush")
        self.assertEqual([r["gate"] for r in flush["judged"]], [True, False])
        self.assertEqual((flush["state"]["reps"], flush["state"]["passes"]), (2, 1))

    def test_band_misses_say_which_way(self):
        self.p.start("lowpoint")
        self.p.next_block()
        self.p.next_block()
        self.hit(shot(v=-4.0, attack=-7.0))
        # Pass or miss and which way, no numbers (they're on the screen).
        self.assertEqual("Miss: strike high on the face, attack too steep.", self.said()[-1])

    def test_block_tapped_at_once(self):
        # A no-ball block's reps after doing them all: one walk off the mat.
        self.p.start("lowpoint")
        self.assertIn("then tap how many passed", self.said()[-1])
        with self.assertRaises(ValueError):
            self.p.tap_block(11, 0)
        self.p.tap_block(10, 0)                       # 10 in a row: passed, on to the next block
        self.assertEqual(self.block(), "stepthrough")
        self.p.tap_block(7, 3)                        # needs 10 of 10: not passed, on to the ball blocks
        self.assertEqual(self.block(), "flush")
        self.assertIn("Step through gate not passed", " ".join(self.said()))
        with self.assertRaises(ValueError):
            self.p.tap_block(1, 0)                    # a ball block now

    def test_streak_said_short(self):
        self.p.start("lowpoint")
        self.p.programs["lowpoint"]["blocks"][3]["requires"] = None
        for _ in range(3):
            self.p.next_block()                       # to Transfer: 5 in a row
        self.hit(shot())
        self.hit(shot())
        self.assertEqual("Pass. 2 in a row.", self.said()[-1])

    def test_brace_and_turn(self):
        # Oct 6 coach plan: attack -3 to -4.5, face to path within 2, pelvis open 10+ (3D) and the
        # pelvis 3+ in ahead of the ball (the face-on camera's number, from the swing record).
        self.p.start("braceturn")
        self.assertEqual(self.drills[-1], "braceturn")
        self.p.tap_block(10, 0)
        self.assertEqual(self.block(), "tier2")
        good = dict(body3d=body3d(pelvis_open=14), body={"pelvisBall": 4.5})
        self.hit(shot(attack=-4.0, face=0.5, path=0.0), **good)
        self.assertEqual("Pass.", self.said()[-1])
        self.hit(shot(attack=-5.5, face=3.5, path=0.0), **good)
        self.assertEqual("Miss: attack too steep, face open to path.", self.said()[-1])
        self.hit(shot(attack=-4.0), body3d=body3d(pelvis_open=4), body={"pelvisBall": 1.0})
        self.assertEqual("Miss: pelvis not open enough, pelvis not ahead enough.", self.said()[-1])
        n = self.p.state()["program"]["blocks"][1]["judged"][0]["numbers"]
        self.assertEqual((n["pelvisBall"], n["path"], n["face"]), (4.5, 0.0, 0.5))
        rep = self.p.report()["text"]
        self.assertIn("-4.0 / 24.0 / +0.5 / -12 (path +0.0°, face +0.5°, carry 150 yd)", rep)
        self.assertIn("(in brackets: club path", rep)

    def test_finished_runs_keep_their_gates_and_calibration(self):
        # Oct 7: widening the strike band re-judged the Oct 6 report (8 of 10 passed became 1 of 10).
        self.p.start("lowpoint")
        self.p.next_block()
        self.p.next_block()
        for _ in range(10):
            self.hit(shot(v=-30.0, attack=-4.0))      # strike median -30: shifted at -14 +-8, strike not gated
        self.p.stop()
        run = self.p.state()["log"][-1]
        self.assertTrue(run["calibration"]["shifted"])
        before = self.p.report(run["started"])["text"]
        self.assertIn("SHIFTED", before)
        cal = self.p.programs["lowpoint"]["calibration"]
        cal["within"] = 40                            # programs.json edited later
        self.p.programs["lowpoint"]["blocks"][2]["gate"]["need"] = 9
        self.assertEqual(self.p.report(run["started"])["text"], before)
        self.assertEqual(self.p.state()["log"][-1]["blocks"][2]["state"]["passed"],
                         run["blocks"][2]["state"]["passed"])

    def test_retention_median_gate(self):
        self.p.start("retention")
        self.assertIsNone(self.drills[-1])  # cold swings are normal swings: they count in the trends
        for a in (-2.0, -2.5, -4.0, -3.5, -2.0, -4.0, -3.2, -1.0, -3.4, -3.6):
            self.hit(shot(attack=a))       # all 10 in the strike band, median attack -3.3
        done = self.p.state()["log"][-1]
        self.assertEqual(done["results"], {"cold": "passed"})
        self.p.start("retention")
        for a in (-2.0, -2.5, -4.0, -2.9, -2.0, -4.0, -3.2, -1.0, -2.4, -3.6):
            self.hit(shot(attack=a))       # median attack -2.7: shallower than -3
        self.assertEqual(self.p.state()["log"][-1]["results"], {"cold": "not passed"})
        self.assertIn("median attack angle -2.7", self.p.report()["text"].replace("−", "-") + programs.progress_text(
            self.p.programs["retention"]["blocks"][0], self.p.state()["log"][-1]["blocks"][0]["state"]))

    def flush(self):
        self.p.start("lowpoint")
        self.p.next_block()
        self.p.next_block()

    def test_null_strike_is_left_out_of_both_sides_of_the_count(self):
        self.flush()
        self.hit(shot())
        self.hit(shot(h=None, v=None))   # Square flagged the impact read invalid
        st = self.p.state()["program"]["blocks"][2]["state"]
        self.assertEqual((st["passes"], st["reps"]), (1, 1))
        self.assertIn("Invalid read", " ".join(self.said()))

    def test_calibration_shift_stops_the_strike_gate_for_the_session(self):
        self.flush()
        for _ in range(9):
            self.hit(shot(v=-2.0))         # the whole frame moved (Square read about +11 mm higher)
        self.assertIsNone(self.p.state()["program"]["calibration"]["shifted"])
        self.assertEqual(self.p.state()["program"]["blocks"][2]["state"]["passes"], 0)
        self.hit(shot(v=-2.0))             # the 10th 7 iron decides: median -2, usual -13 +- 4
        self.assertIn("Calibration shifted", " ".join(self.said()))
        st = self.p.state()["program"]
        flush = next(b for b in st["blocks"] if b["id"] == "flush")
        self.assertEqual(flush["result"], "passed")   # judged on attack alone (+ mark): all 10 pass
        self.assertEqual(st["blocks"][st["block"]]["id"], "transfer")
        self.assertIn("SHIFTED", self.p.report()["text"])

    def test_calibration_normal_keeps_the_strike_gate(self):
        self.flush()
        for _ in range(10):
            self.hit(shot(v=-15.0))
        self.assertIn("Strike calibration: median -15.0", self.p.report()["text"])
        self.assertNotIn("Calibration shifted", " ".join(self.said()))

    def test_report_has_the_camera_numbers(self):
        self.flush()
        self.hit(shot())
        self.hit(shot())
        bodies = {s["name"]: {"handsAhead": v} for s, v in zip(self.swings, (1.2, 2.0))}
        self.assertIn("hands ahead of ball at impact +1.6 in (camera, 2 swings)", self.p.report(body=bodies.get)["text"])
        self.assertNotIn("hands ahead", self.p.report()["text"])

    def test_report_has_pelvis_and_chest_vs_ball_per_swing(self):
        self.flush()
        self.hit(shot())
        self.hit(shot())
        bodies = {self.swings[0]["name"]: {"pelvisBall": -2.04, "chestBall": 0.5}, self.swings[1]["name"]: {"pelvisBall": 3.0}}
        text = self.p.report(body=bodies.get)["text"]
        self.assertIn("| vs ball: pelvis -2.0 in, chest +0.5 in", text)
        self.assertIn("| vs ball: pelvis +3.0 in", text)
        self.assertNotIn("vs ball: pelvis", self.p.report()["text"])

    def test_setup_notes_go_into_the_report(self):
        self.flush()
        self.p.note("Omni moved 2 in back")
        self.hit(shot())
        self.p.stop()
        self.assertIn("Setup notes: Omni moved 2 in back", self.p.report()["text"])
        self.p.note("Omni moved 2 in back; Square app updated")      # on the finished run
        self.assertIn("Square app updated", self.p.report()["text"])
        self.assertEqual(self.p.state()["log"][-1]["notes"], "Omni moved 2 in back; Square app updated")

    def test_undo_takes_back_the_last_tap(self):
        self.p.start("lowpoint")
        self.taps(True, False)
        self.p.undo()
        st = self.p.state()["program"]["blocks"][0]["state"]
        self.assertEqual((st["reps"], st["streak"]), (1, 1))

    def test_a_program_survives_a_restart(self):
        self.p.start("lowpoint")
        self.taps(True, True)
        again = programs.Programs(self.p.state_file, self.p.log_file, lambda: 99, self.clock)
        self.assertEqual(again.state()["program"]["blocks"][0]["state"]["reps"], 2)

    def test_the_programs_file_is_well_formed(self):
        for p in programs.load_programs().values():
            ids = [b["id"] for b in p["blocks"]]
            for b in p["blocks"]:
                self.assertIn(b["gate"]["kind"], ("count", "streak"))
                self.assertLessEqual(b["gate"]["need"], b["reps"])
                for c in b["gate"].get("checks", []):
                    self.assertIn(c["key"], programs.NUMBERS)
                if b.get("requires"):
                    self.assertIn(b["requires"], ids[:ids.index(b["id"])])

    def test_sequence_tier2_pass_and_fail(self):
        self.p.start("sequence")
        # Tier 1: 10 taps in a row passes the block
        self.taps(*[True] * 10)
        self.assertEqual(self.block(), "tier2")
        # Pass: pelvis peak before impact (<= 0) and pelvis open >= 15 deg
        self.hit(shot(), body3d=body3d(pelvis_peak=-15, pelvis_open=18))
        self.assertTrue(self.said()[-1].startswith("Pass."))
        # Miss: pelvis peak after impact
        self.hit(shot(), body3d=body3d(pelvis_peak=20, pelvis_open=18))
        self.assertEqual("Miss: pelvis peaks late.", self.said()[-1])
        # Miss: pelvis not open enough
        self.hit(shot(), body3d=body3d(pelvis_peak=-15, pelvis_open=10))
        self.assertEqual("Miss: pelvis not open enough.", self.said()[-1])
        # Hit 6 more passes to reach 7 passes out of 10
        for _ in range(6):
            self.hit(shot(), body3d=body3d(pelvis_peak=-15, pelvis_open=18))
        # 10th rep deciding block (1 pass + 2 misses + 6 passes = 9 reps, hit 1 more)
        self.hit(shot(), body3d=body3d(pelvis_peak=-15, pelvis_open=18))
        self.assertEqual(self.block(), "tier3")

    def test_waiting_for_3d_and_late_arrival(self):
        self.p.start("sequence")
        self.taps(*[True] * 10)
        self.assertEqual(self.block(), "tier2")
        # Shot arrives without 3D
        self.hit(shot())
        self.assertEqual(self.p.state()["program"]["waiting3d"], 1)
        st = self.p.state()["program"]["blocks"][1]["state"]
        self.assertEqual(st["reps"], 0)  # waiting rep is not in judged gate count yet
        # Late 3D arrives
        self.swings[-1]["body3d"] = body3d(pelvis_peak=-20, pelvis_open=22)
        self.p.step(self.swings)
        self.assertEqual(self.p.state()["program"]["waiting3d"], 0)
        st = self.p.state()["program"]["blocks"][1]["state"]
        self.assertEqual(st["reps"], 1)
        self.assertEqual(st["passes"], 1)
        self.assertTrue(self.said()[-1].startswith("Pass."))

    def test_3d_never_arrived_timeout_and_why3d(self):
        self.p.start("sequence")
        self.taps(*[True] * 10)
        self.assertEqual(self.block(), "tier2")
        # Shot arrives without 3D
        self.hit(shot())
        self.assertEqual(self.p.state()["program"]["waiting3d"], 1)
        # 95 seconds later: timeout
        self.clock.t += programs.BODY3D_GIVE_UP_S + 5
        self.p.step(self.swings)
        self.assertEqual(self.p.state()["program"]["waiting3d"], 0)
        self.assertIn("Invalid read (no 3D): not counted.", self.said()[-1])
        # Camera moved failure
        self.hit(shot(), why3d="camera moved")
        self.assertIn("Invalid read (camera moved): not counted.", self.said()[-1])

    def test_tier3_locked_until_tier2_passes(self):
        self.p.start("sequence")
        self.taps(*[True] * 10)
        self.assertEqual(self.block(), "tier2")
        # 10 misses in Tier 2
        for _ in range(10):
            self.hit(shot(), body3d=body3d(pelvis_peak=20, pelvis_open=10))
        self.assertIsNone(self.p.run)
        done = self.p.state()["log"][-1]
        self.assertEqual(done["results"]["tier2"], "not passed")
        self.assertEqual(done["results"]["tier3"], "skipped")
        self.assertIn("Skip Tier 3: full speed, no pause", " ".join(self.said()))

    def test_tier3_streak_gate_and_bring_back_report(self):
        self.p.start("sequence")
        self.taps(*[True] * 10)
        for _ in range(7):
            self.hit(shot(), body3d=body3d(pelvis_peak=-15, pelvis_open=18))
        for _ in range(3):
            self.hit(shot(), body3d=body3d(pelvis_peak=-15, pelvis_open=18))
        self.assertEqual(self.block(), "tier3")
        # Tier 3 checks: pelvisPeakMs <= -30, armAfterPelvis: true, attack [-6, -3], faceToPath [-2, 2], median loft <= 26.5
        # Miss 1: pelvis peak not early enough (-20 > -30)
        self.hit(shot(attack=-4.0, loft=24.0, face=0.0, path=0.0), body3d=body3d(pelvis_peak=-20, arm_peak=-10, pelvis_open=20))
        self.assertEqual("Miss: pelvis peaks late.", self.said()[-1])
        # Miss 2: arm before pelvis
        self.hit(shot(attack=-4.0, loft=24.0, face=0.0, path=0.0), body3d=body3d(pelvis_peak=-40, arm_peak=-50, pelvis_open=20))
        self.assertEqual("Miss: arms before pelvis.", self.said()[-1])
        # 5 passes in a row
        for _ in range(5):
            self.hit(shot(attack=-4.0, loft=24.0, face=0.0, path=0.0), body3d=body3d(pelvis_peak=-40, arm_peak=-20, pelvis_open=20, pelvis_start=-110))
        self.assertIsNone(self.p.run)
        done = self.p.state()["log"][-1]
        self.assertEqual(done["results"]["tier3"], "passed")
        rep = self.p.report()
        self.assertIn("Shot order (# overall, block, club: attack / dynamic loft / face to path / strike height | 3D: pelvis peak / arm peak / pelvis open / pelvis start, verdict):", rep["text"])
        self.assertIn("pelvis peak -40 ms, arm peak -20 ms, pelvis open +20°, pelvis start -110 ms, pass", rep["text"])

    def test_sequence_cap_40(self):
        self.p.start("sequence")
        # 10 taps in Tier 1 passes to Tier 2
        self.taps(*[True] * 10)
        self.assertEqual(self.block(), "tier2")
        # 30 shots with unread strike in Tier 2: not counted in gate, but count toward 40 swing cap
        for _ in range(30):
            self.hit(shot(h=0.0, v=0.0))
        self.assertIsNone(self.p.run)
        self.assertEqual(self.p.state()["log"][-1]["how"], "cap")


if __name__ == "__main__":
    unittest.main()
