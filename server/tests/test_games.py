"""Practice games on the server (games.py): targets spoken, shots scored with games.js, the game saved."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import games  # noqa: E402

T0 = 1_790_000_000.0


def shot(carry, side, club="7i", **extra):
    return {"club": club, "ball": {"carry": carry, "side": side, **extra}}


class Clock:
    def __init__(self):
        self.t = T0

    def __call__(self):
        return self.t


class GamesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rules = games.Rules()

    @classmethod
    def tearDownClass(cls):
        cls.rules.close()

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        d = Path(self.dir.name)
        self.clock = Clock()
        self.ids = iter(range(1, 10_000))
        self.g = games.Games(d / "game.json", d / "games-log.jsonl", lambda: next(self.ids), self.clock, self.rules)

    def tearDown(self):
        self.dir.cleanup()

    def swing(self, dt, s=None, name=None):
        return {"name": name or f"swing_face_{int(T0 + dt)}.mp4", "t": T0 + dt, "shot": s}

    def test_catalog_has_the_four_games(self):
        self.assertEqual({g["id"] for g in self.g.catalog()}, {"combine", "wedges", "random", "ladder"})

    def test_start_says_the_first_target(self):
        g = self.g.start("wedges")
        self.assertEqual(g["target"], 40)
        said = self.g.latest(0)
        self.assertEqual(len(said), 1)
        self.assertIn("First target: 40 yards.", said[0]["text"])
        with self.assertRaises(ValueError):
            self.g.start("golf")

    def test_a_shot_is_scored_and_the_next_target_said(self):
        self.g.start("wedges")
        self.clock.t = T0 + 20
        made = self.g.step([self.swing(5, shot(38, 2))])
        self.assertEqual(len(made), 1)
        self.assertEqual(made[0]["target"], 40)
        self.assertTrue(made[0]["onGreen"])
        self.assertGreater(made[0]["sg"], -1)
        self.assertEqual(self.g.game["target"], 50)
        self.assertIn("Next: 50 yards.", self.g.latest(0)[-1]["text"])
        # The same swing (or its other clip) isn't scored twice.
        self.assertEqual(self.g.step([self.swing(5, shot(38, 2)), self.swing(5.5, shot(38, 2), "swing_dtl_x.mp4")]), [])

    def test_waits_for_a_shot_in_order_and_skips_one_that_never_comes(self):
        self.g.start("wedges")
        self.clock.t = T0 + 15
        swings = [self.swing(5), self.swing(12, shot(50, 0))]
        self.assertEqual(self.g.step(swings), [])        # the first swing's shot may still come
        self.clock.t = T0 + 40
        made = self.g.step(swings)                       # it didn't: skipped, the target stays 40
        self.assertEqual([m["target"] for m in made], [40])

    def test_mishit_scores_the_worst(self):
        self.g.start("wedges")
        self.clock.t = T0 + 20
        made = self.g.step([self.swing(5, shot(0, 0))])
        self.assertIsNone(made[0]["sg"])
        self.assertIn("Mishit", self.g.latest(0)[-1]["text"])
        self.assertEqual(self.g.state()["game"]["summary"]["mishits"], 1)

    def test_a_game_ends_and_is_logged(self):
        self.g.start("wedges")
        targets = []
        for i in range(13):
            self.clock.t = T0 + 20 * i + 15
            targets.append(self.g.game["target"])
            self.g.step([self.swing(20 * i + 5, shot(targets[-1], 0))])
        self.assertIsNone(self.g.game)
        self.assertEqual(targets, [40, 50, 60, 70, 80, 90, 100, 90, 80, 70, 60, 50, 40])
        log = self.g.state()["log"]
        self.assertEqual(len(log), 1)
        self.assertEqual(log[0]["how"], "done")
        self.assertEqual(log[0]["summary"]["greens"], 13)
        self.assertIn("done", self.g.latest(0)[-1]["text"])

    def test_stop_saves_what_was_played_and_state_survives_a_restart(self):
        self.g.start("combine", {"seed": 7})
        self.clock.t = T0 + 20
        self.g.step([self.swing(5, shot(100, 3))])
        d = Path(self.dir.name)
        again = games.Games(d / "game.json", d / "games-log.jsonl", lambda: next(self.ids), self.clock, self.rules)
        self.assertEqual(len(again.game["results"]), 1)
        done = again.stop()
        self.assertEqual(done["how"], "stopped")
        self.assertIsNone(again.game)
        self.assertEqual(json.loads((d / "games-log.jsonl").read_text().splitlines()[0])["id"], "combine")

    def test_left_idle_ends(self):
        self.g.start("random")
        self.clock.t = T0 + games.IDLE_END_S + 1
        self.g.step([])
        self.assertIsNone(self.g.game)
        self.assertEqual(self.g.state()["log"], [])   # nothing hit: nothing logged

    def test_shot_of(self):
        self.assertEqual(games.shot_of(shot(100, -3)), {"carry": 100, "offline": -3})
        self.assertIsNone(games.shot_of(shot(100, -3, valid=False))["carry"])
        self.assertIsNone(games.shot_of({"ball": {"carry": None}})["carry"])
        self.assertIsNone(games.shot_of(None)["carry"])


if __name__ == "__main__":
    unittest.main()
