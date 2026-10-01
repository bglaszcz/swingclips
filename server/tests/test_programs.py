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

    def hit(self, s, dt=30, mark=None):
        """A ball swing now, its shot in (so step takes it), and the mark tapped, if any."""
        self.clock.t += dt
        t = self.clock.t
        name = f"swing_face_1920x1080_240fps_{int(t)}_2000ms.mp4"
        self.swings.append({"t": t, "name": name, "partner": name.replace("face", "dtl"), "shot": s})
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
        self.assertIn("face to path within 2", self.said()[-1])
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
        self.assertIn("Miss: needs strike minus 8 or lower and attack angle minus 6 or shallower. You had strike minus 4, attack angle minus 7.",
                      self.said()[-1])

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


if __name__ == "__main__":
    unittest.main()
