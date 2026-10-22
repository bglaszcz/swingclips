"""The 4-week ball plan (ballplan.py, /api/ballplan) and its two coach programs (programs.json): which shots
count for each number, the verdict against the start, which session today is, and the programs' ball gates
(smash for a solid strike, offline for the fairway).

  cd server && python -m unittest tests.test_ballplan
"""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

HERE = Path(__file__).parent
TMP = Path(tempfile.mkdtemp(prefix="swingclips-ballplan-"))
# app.py reads its folders when it's imported (another test may have imported it already).
os.environ.setdefault("SWINGCLIPS_CLIPS", str(TMP / "clips"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import ballplan  # noqa: E402
import drills  # noqa: E402
import programs  # noqa: E402


def ts(day: str, hour: int = 12, minute: int = 0) -> float:
    return datetime.fromisoformat(f"{day}T{hour:02d}:{minute:02d}:00").timestamp()


def shot(club="I7", carry=155.0, side=0.0, smash=1.3, speed=88.0, attack=-3.0, h=2.0, start=None):
    return {"club": club, "ball": {"carry": carry, "side": side, "speed": 110.0, "hla": start},
            "clubData": {"speed": speed, "smash": smash, "angleOfAttack": attack, "faceImpactH": h}}


def row(day, hour=12, out=False, hands=None, **kw):
    return ballplan.row_of(shot(**kw), ts(day, hour), out, hands=hands)


PLAN = {
    "id": "t", "name": "4-week ball plan", "start": "2026-10-22", "end": "2026-11-18",
    "baseline": {"from": "2026-09-23", "to": "2026-10-21"}, "why": "Why.", "week": {"practice": 2, "test": 1},
    "targets": {"solid7": 70, "heavyThin": 5, "centred": 60, "fairway": 55},
    "days": {
        "practice": {"title": "Practice day", "steps": [{"text": "Warm up."}, {"text": "Practice.", "program": "ballpractice"}]},
        "test": {"title": "Test day", "steps": [{"text": "Cold."}, {"text": "Test.", "program": "balltest"},
                                                {"text": "Combine.", "game": "combine"}]},
    },
}


def run(pid, day, hour=10, shots=20, how="done", running=False):
    return {"id": pid, "started": ts(day, hour), "how": how, "shots": shots, "running": running}


class Rows(unittest.TestCase):
    def test_read(self):
        r = ballplan.row_of(shot(), ts("2026-10-22", 9))
        self.assertEqual((r["day"], r["club"], r["carry"], r["smash"], r["strikeH"]), ("2026-10-22", "I7", 155.0, 1.3, 2.0))
        self.assertIsNone(ballplan.row_of({"club": "I7", "ball": {}, "clubData": {}}, 0))   # no carry: not a shot
        # No club read: no smash or attack (Square's 0 club speed); a failed strike read (0.0) is none.
        r = ballplan.row_of(shot(speed=0, smash=0.0, h=0.0), ts("2026-10-22"))
        self.assertEqual((r["speed"], r["smash"], r["attack"], r["strikeH"]), (None, None, None, None))

    def test_tally(self):
        stock = {"I7": 155.0, "PW": 115.0, "SW": 60.0}
        t = lambda key, **kw: ballplan.tally(key, row("2026-10-22", **kw), stock)
        self.assertTrue(t("solid7", smash=1.25))
        self.assertFalse(t("solid7", smash=1.24))
        self.assertIsNone(t("solid7", club="I8", smash=1.3))          # 7 iron only
        self.assertTrue(t("heavyThin", carry=131.0))                    # under 85% of 155 (131.75)
        self.assertFalse(t("heavyThin", carry=132.0))
        self.assertIsNone(t("heavyThin", club="SW", carry=20.0))       # wedges hit at part distances: not counted
        self.assertIsNone(t("heavyThin", club="I6", carry=100.0))      # no usual carry for the club
        self.assertTrue(t("centred", h=-10.0))
        self.assertFalse(t("centred", h=10.5))
        self.assertIsNone(t("centred", club="DR", h=1.0))
        self.assertTrue(t("fairway", club="DR", side=-15.0, speed=103.0))
        self.assertFalse(t("fairway", club="DR", side=15.5, speed=103.0))
        self.assertIsNone(t("fairway", club="DR", side=0.0, speed=88.0))  # not a full driver swing
        self.assertTrue(t("fairway", club="DR", side=3.0, speed=0, smash=0))  # no club read: still a drive
        self.assertTrue(t("left", club="DR", side=-3.0, speed=103.0))
        self.assertTrue(t("attack7", attack=-2.0))
        self.assertFalse(t("attack7", attack=-1.9))
        # Left out of the trends (a drill, a practice game, by hand): counts for nothing.
        self.assertIsNone(ballplan.tally("solid7", row("2026-10-22", out=True), stock))

    def test_stock(self):
        rows = [row("2026-10-01", carry=150.0 + i) for i in range(8)] + [row("2026-10-01", club="I6", carry=160.0)]
        rows.append(row("2026-10-01", carry=10.0, out=True))           # left out: not in the usual
        rows.append(row("2026-10-25", carry=10.0))                     # after the baseline
        self.assertEqual(ballplan.stock_carry(rows, "2026-09-23", "2026-10-21"), {"I7": 153.5})


class Verdict(unittest.TestCase):
    def days(self, base: list[tuple[int, int]], plan: list[tuple[int, int]]) -> dict:
        d = {}
        for i, (h, n) in enumerate(base):
            d[f"2026-10-{i + 1:02d}"] = {"solid7": [h, n]}
        for i, (h, n) in enumerate(plan):
            d[f"2026-10-{i + 22:02d}"] = {"solid7": [h, n]}
        return d

    def test_share(self):
        d = self.days([(10, 20), (5, 10)], [])
        self.assertEqual(ballplan.share(d, "solid7", "2026-10-01", "2026-10-21"), {"value": 50.0, "n": 30, "sessions": 2})
        self.assertEqual(ballplan.share(d, "solid7", "2026-10-22", "2026-10-30"), {"value": None, "n": 0, "sessions": 0})

    def test_verdicts(self):
        base, plan = ("2026-10-01", "2026-10-21"), ("2026-10-22", "2026-11-18")
        v = lambda b, p, better="up": ballplan.verdict(self.days(b, p), "solid7", base, plan, better)["verdict"]
        steady = [(11, 20), (12, 20), (10, 20), (11, 20), (12, 20)]
        self.assertEqual(v(steady, [(18, 20)]), "early")                      # one session isn't enough
        self.assertEqual(v(steady, [(18, 20), (19, 20), (18, 20)]), "better")  # 56% -> 92%
        self.assertEqual(v(steady, [(18, 20), (19, 20), (18, 20)], "down"), "worse")
        self.assertEqual(v(steady, [(12, 20), (11, 20), (10, 20)]), "same")
        self.assertEqual(v(steady, [(3, 20), (2, 20), (4, 20)]), "worse")
        r = ballplan.verdict(self.days(steady, [(18, 20), (19, 20)]), "solid7", base, plan, "up")
        self.assertLess(r["interval"][0], r["interval"][1])
        self.assertEqual(r, ballplan.verdict(self.days(steady, [(18, 20), (19, 20)]), "solid7", base, plan, "up"))  # seeded


class Today(unittest.TestCase):
    WEEK = ("2026-10-22", "2026-10-28")

    def today(self, day, runs=(), games=(), program_now=None, game_now=None):
        return ballplan.today_session(PLAN, self.WEEK, list(runs), list(games), day, program_now, game_now)

    def test_practice_first_then_test(self):
        self.assertEqual(self.today("2026-10-22")["kind"], "practice")
        one = [run("ballpractice", "2026-10-22")]
        self.assertEqual(self.today("2026-10-23", one)["kind"], "practice")
        two = one + [run("ballpractice", "2026-10-24")]
        t = self.today("2026-10-25", two)
        self.assertEqual((t["kind"], t["title"]), ("test", "Test day"))
        self.assertEqual([s.get("program") or s.get("game") for s in t["steps"]], [None, "balltest", "combine"])
        all_done = two + [run("balltest", "2026-10-25")]
        t = self.today("2026-10-26", all_done)
        self.assertEqual((t["kind"], t["title"]), ("extra", "Extra practice day"))
        self.assertEqual(t["steps"][1]["program"], "ballpractice")

    def test_test_when_the_week_runs_out(self):
        one = [run("ballpractice", "2026-10-22")]
        self.assertEqual(self.today("2026-10-27", one)["kind"], "test")   # 2 days left, a practice day still owed
        self.assertEqual(self.today("2026-10-28")["kind"], "test")        # the last day: the test

    def test_short_runs_dont_count(self):
        # Under SESSION_MIN_SHOTS shots, not got through: not a session.
        runs = [run("ballpractice", "2026-10-22", shots=3, how="stopped"), run("ballpractice", "2026-10-23", shots=3, how="stopped")]
        self.assertEqual(self.today("2026-10-24", runs)["kind"], "practice")

    def test_today_decided_by_what_started(self):
        # A practice day already begun today stays the practice day; the program in play decides it too.
        runs = [run("ballpractice", "2026-10-22"), run("ballpractice", "2026-10-23"), run("ballpractice", "2026-10-25", hour=9, how=None, shots=2, running=True)]
        t = self.today("2026-10-25", runs, program_now="ballpractice")
        self.assertEqual(t["kind"], "practice")
        self.assertEqual((t["steps"][1]["running"], t["steps"][1]["done"]), (True, False))
        t = self.today("2026-10-22", program_now="balltest")
        self.assertEqual(t["kind"], "test")

    def test_steps_done(self):
        runs = [run("balltest", "2026-10-25", how="done", shots=24)]
        games = [{"id": "combine", "how": "done", "started": ts("2026-10-25", 11), "summary": {"sgPerShot": -0.1}}]
        t = self.today("2026-10-25", runs, games)
        self.assertEqual([s.get("done") for s in t["steps"]], [None, True, True])
        t = self.today("2026-10-25", runs, [], game_now="combine")
        self.assertEqual((t["steps"][2]["running"], t["steps"][2]["done"]), (True, False))


class Build(unittest.TestCase):
    def rows(self):
        out = []
        for day, solid in (("2026-10-01", 10), ("2026-10-08", 11), ("2026-10-15", 12)):   # baseline: 55% solid
            out += [row(day, smash=1.3 if i < solid else 1.15) for i in range(20)]
            out += [row(day, club="DR", carry=230.0, side=-20.0 if i < 6 else 5.0, speed=103.0) for i in range(10)]
        for day in ("2026-10-22", "2026-10-24"):                                        # the plan: 90%
            out += [row(day, smash=1.3 if i < 18 else 1.15) for i in range(20)]
        return out

    def test_before_the_plan(self):
        m = ballplan.build(PLAN, self.rows(), [], [], ts("2026-10-21", 20))
        self.assertFalse(m["plan"]["started"])
        self.assertFalse(m["plan"]["active"])
        self.assertIsNone(m["today"])
        solid = next(n for n in m["numbers"] if n["key"] == "solid7")
        self.assertEqual((solid["start"]["value"], solid["start"]["n"], solid["plan"], solid["verdict"], solid["target"]),
                         (55.0, 60, None, "early", 70))
        self.assertEqual(m["plan"]["programs"], ["ballpractice", "balltest"])

    def test_during(self):
        runs = [run("ballpractice", "2026-10-22"), run("ballpractice", "2026-10-24")]
        games = [{"id": "combine", "how": "done", "started": ts("2026-10-08"), "summary": {"sgPerShot": -0.204, "greens": 19, "shots": 27}},
                 {"id": "combine", "how": "done", "started": ts("2026-10-25"), "summary": {"sgPerShot": -0.15, "greens": 20, "shots": 27}},
                 {"id": "combine", "how": "stopped", "started": ts("2026-10-26"), "summary": {"sgPerShot": 0.5}}]
        m = ballplan.build(PLAN, self.rows(), runs, games, ts("2026-10-25", 9), frm="2026-10-19", to="2026-10-25")
        self.assertEqual((m["plan"]["week"], m["plan"]["weeks"], m["plan"]["active"]), (1, 4, True))
        solid = next(n for n in m["numbers"] if n["key"] == "solid7")
        self.assertEqual((solid["plan"]["value"], solid["plan"]["n"], solid["verdict"]), (90.0, 40, "better"))
        self.assertEqual(solid["week"]["value"], 90.0)
        fair = next(n for n in m["numbers"] if n["key"] == "fairway")
        self.assertEqual((fair["start"]["value"], fair["plan"]["n"], fair["verdict"]), (40.0, 0, "early"))
        self.assertEqual(m["today"]["kind"], "test")
        self.assertEqual((m["weeks"][0]["practice"], m["weeks"][0]["test"]), (2, 0))
        self.assertEqual((m["combine"]["best"], m["combine"]["bestPlan"]), (-0.204, -0.15))   # a stopped one isn't a score
        self.assertEqual(m["range"]["numbers"]["solid7"], {"value": 90.0, "n": 40, "sessions": 2})
        self.assertEqual(m["range"]["practice"], 2)
        json.dumps(m)   # served as JSON

    def test_the_plans_file(self):
        """ballplan.json's programs and games exist, and their ball gates check numbers the programs know."""
        plan = ballplan.load_plan()
        progs = programs.load_programs()
        for pid in ballplan.plan_programs(plan):   # every day's programs, the tailored ones too
            for b in progs[pid]["blocks"]:
                self.assertTrue(programs.gate_keys(b) <= set(programs.NUMBERS), b["id"])
                if b.get("drill"):
                    self.assertIn(b["drill"], drills.DRILLS, b["id"])
        self.assertEqual(set(ballplan.plan_programs(plan)), {"ballpractice", "ballcentre", "balltest"})
        self.assertEqual(set(plan["targets"]), {n["key"] for n in ballplan.NUMBERS})
        self.assertLess(plan["start"], plan["end"])


class ProgramGates(unittest.TestCase):
    def test_offline_and_smash(self):
        n = programs.numbers_of({"ball": {"side": -12.4, "carry": 230}, "clubData": {"speed": 0, "smash": 0}})
        self.assertEqual(n["offline"], -12.4)
        # A gate on the ball's own numbers judges a drive Square read no club for; a club gate doesn't.
        self.assertIsNone(programs.no_read(n, {"offline"}))
        self.assertEqual(programs.no_read(n, {"smash"}), "no club speed")
        self.assertEqual(programs.cue({"key": "offline", "min": -15, "max": 15}, -20), "left of the fairway")
        self.assertEqual(programs.cue({"key": "offline", "min": -15, "max": 15}, 20), "right of the fairway")
        self.assertEqual(programs.cue({"key": "smash", "min": 1.25, "max": 1.45}, 1.1), "not solid")
        self.assertEqual(programs.say_number("offline", -12.4), "12 yards left")
        self.assertEqual(programs.fmt("offline", 7.6), "8 yd right")

    def test_centre_day_blocks(self):
        p = programs.load_programs()["ballcentre"]
        pump, centre = p["blocks"][0], next(b for b in p["blocks"] if b["id"] == "centre")
        self.assertEqual(pump.get("drill"), "pump")      # the phones' long lead-in; out of the trends
        self.assertFalse(centre.get("drill"))             # normal swings: they count
        reps = [{"t": i, "block": "centre", "kind": "shot", "numbers": programs.numbers_of(
            {"ball": {"carry": 150, "side": 0}, "clubData": {"speed": 88, "smash": 1.3, "faceImpactH": h}}),
            "noRead": None} for i, h in enumerate([2] * 12 + [15] * 8)]
        st = programs.block_state(centre, reps, [])
        self.assertEqual((st["passes"], st["reps"], st["passed"]), (12, 20, True))

    def test_practice_day_blocks(self):
        p = programs.load_programs()["ballpractice"]
        strike = next(b for b in p["blocks"] if b["id"] == "strike")
        fair = next(b for b in p["blocks"] if b["id"] == "fairway")
        self.assertFalse(strike.get("drill") or fair.get("drill"))   # normal swings: they count in the trends
        reps = []
        for i, sm in enumerate([1.3] * 14 + [1.1] * 6):
            reps.append({"t": i, "block": "strike", "kind": "shot", "numbers": programs.numbers_of(
                {"ball": {"carry": 150, "side": 0}, "clubData": {"speed": 88, "smash": sm}}), "noRead": None})
        st = programs.block_state(strike, reps, [])
        self.assertEqual((st["passes"], st["reps"], st["passed"], st["done"]), (14, 20, True, True))
        reps = [{"t": i, "block": "fairway", "kind": "shot", "numbers": programs.numbers_of(
            {"ball": {"carry": 230, "side": side}, "clubData": {}}), "noRead": None}
            for i, side in enumerate([0, 14, -15, 30, -40, 5, 2, 1, -3, 50, 60, 70, -70, 0])]
        st = programs.block_state(fair, reps, [])
        self.assertEqual((st["passes"], st["reps"], st["passed"]), (8, 14, True))
        self.assertEqual(programs.gate_miss_tone(fair, {"numbers": {"offline": 17.0}}), "near")


class Checks(unittest.TestCase):
    """What each miss was, the session / week check (going well, struggling, the hands on heel strikes), and
    the practice day tailored to the bigger kind of iron miss."""
    STOCK = {"I7": 155.0}

    def test_iron_miss(self):
        miss = lambda **kw: ballplan.iron_miss(row("2026-10-22", **kw), self.STOCK)
        self.assertEqual(miss(h=2.0), "good")
        self.assertEqual(miss(h=14.0), "heel")                 # + = heel (Square's watcher)
        self.assertEqual(miss(h=-14.0, carry=120.0), "toe")    # off-centre comes first
        self.assertEqual(miss(carry=120.0, attack=0.5), "shallow")
        self.assertEqual(miss(carry=120.0, attack=-6.0), "steep")
        self.assertEqual(miss(carry=120.0, attack=-3.0), "short")
        self.assertEqual(miss(carry=120.0, h=0.0, attack=-3.0), "short")   # a failed strike read: by carry alone
        self.assertIsNone(miss(club="GW"))                      # not a full-swing iron
        self.assertIsNone(ballplan.iron_miss(row("2026-10-22", club="I8", h=0.0), self.STOCK))   # nothing to judge
        self.assertIsNone(miss(out=True))

    def test_drive_miss(self):
        miss = lambda **kw: ballplan.drive_miss(row("2026-10-22", club="DR", carry=230.0, **{"speed": 103.0, **kw}))
        self.assertEqual(miss(side=5.0, start=1.0), "fairway")
        self.assertEqual(miss(side=-35.0, start=0.3), "left-curve")   # started on line: the curve did it
        self.assertEqual(miss(side=-30.0, start=-7.0), "left-start")  # 230 x tan(-7) = -28 yd at the start
        self.assertEqual(miss(side=25.0, start=0.0), "right-curve")
        self.assertEqual(miss(side=25.0), "right")                    # no start direction
        self.assertIsNone(miss(side=5.0, speed=80.0))                  # not a full drive

    def test_check(self):
        day = "2026-10-22"
        rows = ([row(day, h=2.0, hands=3.0) for _ in range(8)]                      # centred, hands at the day's usual
                + [row(day, h=15.0, smash=1.15, hands=3.6) for _ in range(5)]       # heel, hands higher
                + [row(day, club="DR", carry=230.0, speed=103.0, side=-30.0, start=0.0) for _ in range(4)]
                + [row(day, club="DR", carry=230.0, speed=103.0, side=3.0, start=0.0) for _ in range(6)]
                + [row("2026-10-21", h=15.0) for _ in range(5)])                    # another day: not in it
        c = ballplan.check(rows, self.STOCK, day, day, {"solid7": 56.0, "centred": 50.0, "fairway": 43.0},
                           {"solid7": 70, "centred": 60, "fairway": 55})
        self.assertEqual(c["days"], [day])
        self.assertEqual((c["irons"]["n"], c["irons"]["good"], c["irons"]["causes"]["heel"]), (13, 8, 5))
        self.assertEqual((c["drives"]["n"], c["drives"]["fairway"], c["drives"]["causes"]["left-curve"]), (10, 6, 4))
        self.assertEqual(c["solid7"], {"hits": 8, "n": 13})
        # Hands against the day's median for the club (3.0): heel +0.6, centred 0.
        self.assertEqual((c["hands"]["diff"], c["hands"]["nHeel"], c["hands"]["nCentre"]), (0.6, 5, 8))
        self.assertEqual([s["key"] for s in c["struggle"]], ["heel", "left-curve"])
        self.assertEqual(c["struggle"][0]["hands"]["diff"], 0.6)
        self.assertTrue(c["struggle"][0]["drill"] and c["struggle"][0]["thought"])
        self.assertEqual(c["good"], ["8 of 13 iron strikes near the centre (62%): at the target of 60%.",
                                     "6 of 10 drives in the fairway (60%): at the target of 55%.",
                                     "None of 13 irons came up heavy or thin."])
        # Fewer than HANDS_MIN of either: no hands line.
        c = ballplan.check(rows[:8] + rows[8:10], self.STOCK, day, day)
        self.assertIsNone(c["hands"])

    def test_emphasis_and_tailored_day(self):
        heel = [row("2026-10-20", h=15.0) for _ in range(8)] + [row("2026-10-20", carry=120.0, attack=0.5) for _ in range(3)]
        low = [row("2026-10-20", carry=120.0, attack=0.5) for _ in range(8)] + [row("2026-10-20", h=15.0) for _ in range(3)]
        e = ballplan.emphasis(heel, self.STOCK, "2026-10-22")
        self.assertEqual((e["key"], e["offCentre"], e["lowPoint"]), ("centre", 8, 3))
        self.assertEqual(ballplan.emphasis(low, self.STOCK, "2026-10-22")["key"], "lowpoint")
        self.assertIsNone(ballplan.emphasis(heel[:5], self.STOCK, "2026-10-22")["key"])     # too few to say
        self.assertIsNone(ballplan.emphasis(heel, self.STOCK, "2026-10-20")["key"])          # today's don't count
        plan = json.loads(json.dumps(PLAN))
        plan["days"]["practice"]["steps"][1]["emphasis"] = {"centre": {"text": "Centred.", "program": "ballcentre"}}
        week = ("2026-10-22", "2026-10-28")
        t = ballplan.today_session(plan, week, [], [], "2026-10-22", None, None, e)
        self.assertEqual((t["kind"], t["emphasis"], t["steps"][1]["program"], t["steps"][1]["text"]),
                         ("practice", "centre", "ballcentre", "Centred."))
        self.assertEqual(t["steps"][1]["why"], e["why"])
        t = ballplan.today_session(plan, week, [], [], "2026-10-22", None, None, {"key": "lowpoint"})
        self.assertEqual(t["steps"][1]["program"], "ballpractice")
        # The low point program already ran today: the day keeps it, whatever the emphasis says now.
        t = ballplan.today_session(plan, week, [run("ballpractice", "2026-10-22", how=None, shots=3)], [],
                                   "2026-10-22", None, None, e)
        self.assertEqual(t["steps"][1]["program"], "ballpractice")
        self.assertEqual(ballplan.plan_programs(plan), {"ballpractice": "practice", "ballcentre": "practice",
                                                        "balltest": "test"})

    def test_build_has_checks(self):
        rows = Build().rows() + [row("2026-10-24", h=15.0) for _ in range(6)]
        m = ballplan.build(PLAN, rows, [], [], ts("2026-10-25", 9), frm="2026-10-19", to="2026-10-25")
        self.assertEqual(m["checks"]["last"]["from"], "2026-10-24")
        self.assertEqual(m["checks"]["plan"]["days"], ["2026-10-22", "2026-10-24"])
        self.assertEqual(m["weeks"][0]["check"]["days"], ["2026-10-22", "2026-10-24"])
        self.assertIsNone(m["weeks"][1]["check"])            # a week to come
        self.assertEqual(m["range"]["check"]["irons"]["causes"]["heel"], 6)
        self.assertIn("key", m["emphasis"])
        json.dumps(m)


class Endpoint(unittest.TestCase):
    """/api/ballplan on a folder of clips and shots: paired swings count by their standing, a practice game's
    and a hand-excluded swing's shots don't, a shot no clip paired with counts unless a game was on."""

    def setUp(self):
        import app
        import games
        self.app = app
        d = Path(tempfile.mkdtemp(dir=TMP))
        (d / "clips").mkdir()
        (d / "pose").mkdir()
        t0 = ts("2026-10-01", 15)
        self.t = {"normal": t0, "game": t0 + 600, "excluded": t0 + 1200, "loneNormal": t0 + 1800, "loneGame": t0 + 650}
        names = {}
        for key in ("normal", "game", "excluded"):
            for angle in ("face", "dtl"):
                name = f"swing_{angle}_1920x1080_240fps_{int(self.t[key])}_2000ms.mp4"
                (d / "clips" / name).write_bytes(b"video")
                names[key, angle] = name
        self.names = names
        lines = []
        for i, key in enumerate(("normal", "game", "excluded", "loneNormal", "loneGame")):
            s = shot(smash=1.3 if key != "excluded" else 1.1)
            s.update(received=datetime.fromtimestamp(self.t[key] + 13).isoformat(), source="square-app", shotNumber=i)
            lines.append(json.dumps(s))
        (d / "shots.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
        (d / "excluded.json").write_text(json.dumps([names["excluded", "face"]]), encoding="utf-8")
        log = d / "games-log.jsonl"
        log.write_text(json.dumps({"id": "combine", "name": "Combine", "started": t0 + 500, "ended": t0 + 700,
                                   "how": "done", "results": [], "summary": {"sgPerShot": -0.2, "greens": 1, "shots": 2}}) + "\n",
                       encoding="utf-8")
        (d / "game.json").write_text("{}", encoding="utf-8")
        plan = dict(PLAN, start="2026-10-02", end="2026-10-29", baseline={"from": "2026-09-23", "to": "2026-10-01"})
        (d / "ballplan.json").write_text(json.dumps(plan), encoding="utf-8")
        progs = programs.Programs(d / "program.json", d / "programs-log.jsonl", new_id=lambda: 1)
        self.patches = [mock.patch.object(app, "CLIPS_DIR", d / "clips"), mock.patch.object(app, "POSE_DIR", d / "pose"),
                        mock.patch.object(app, "SHOTS_FILE", d / "shots.jsonl"),
                        mock.patch.object(app, "EXCLUDED_FILE", d / "excluded.json"),
                        mock.patch.object(app, "INCLUDED_FILE", d / "included.json"),
                        mock.patch.object(app, "games_state", games.Games(d / "game.json", log, new_id=lambda: 1)),
                        mock.patch.object(app, "programs_state", progs),
                        mock.patch.object(ballplan, "PLAN_FILE", d / "ballplan.json"),
                        mock.patch.dict(app.ballplan_cache, {"t": 0.0, "rows": None, "key": None})]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()

    def test_rows(self):
        # A swing's hands to plane comes from its record (the face clip's).
        with mock.patch.dict(self.app.swing_records, {self.names["normal", "face"]: {"body": {"handsPlaneP6": 3.2}}}):
            rows = sorted(self.app.ballplan_rows(), key=lambda r: r["t"])
        self.assertEqual([r["hands"] for r in rows], [3.2, None, None, None, None])
        self.assertEqual([(r["out"], r["game"]) for r in rows],
                         [(False, None), (True, "combine"), (True, "combine"), (True, None), (False, None)])
        with mock.patch("time.time", return_value=ts("2026-10-03", 9)):
            m = self.app.get_ballplan(frm=None, to=None)
        solid = next(n for n in m["numbers"] if n["key"] == "solid7")
        self.assertEqual((solid["start"]["n"], solid["start"]["value"]), (2, 100.0))   # the normal swing and the lone shot
        self.assertEqual(m["combine"]["best"], -0.2)
        self.assertEqual(m["today"]["kind"], "practice")


if __name__ == "__main__":
    unittest.main()
