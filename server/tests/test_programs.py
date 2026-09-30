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


def shot(attack=-3.0, v=1.0, face=0.5, path=0.0, h=4.0, speed=80.0, loft=24.0, club="I7"):
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
        self.assertIn("didn't read", self.said()[-1])
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
        self.assertIn("not read (strike not read)", rep["text"])
        self.assertEqual(rep["frame"]["block"], "Lead foot only")
        self.assertTrue(rep["frame"]["partner"].startswith("swing_dtl_"))

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
