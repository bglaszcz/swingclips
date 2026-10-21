"""Swings hit during a practice game: labeled with it, and left out of the trends unless it's a game of
the usual full swing (games.STOCK_SWING_GAMES); put back and left out again by hand (/api/exclude).

  cd server && python -m unittest tests.test_game_swings
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).parent
TMP = Path(tempfile.mkdtemp(prefix="swingclips-games-"))
# app.py reads its folders when it's imported (another test may have imported it already).
os.environ.setdefault("SWINGCLIPS_CLIPS", str(TMP / "clips"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import app  # noqa: E402
import games  # noqa: E402
try:
    from fastapi.testclient import TestClient  # needs httpx, which the server itself doesn't
except (ImportError, RuntimeError):
    TestClient = None

T0 = 1_790_000_000


def games_with_log(folder: Path, logged: list[dict], current: dict | None = None) -> games.Games:
    log = folder / "games-log.jsonl"
    log.write_text("".join(json.dumps(g) + "\n" for g in logged), encoding="utf-8")
    state = folder / "game.json"
    state.write_text(json.dumps(current or {}), encoding="utf-8")
    return games.Games(state, log, new_id=lambda: 1)


COMBINE = {"id": "combine", "name": "Combine", "started": T0 + 1000, "ended": T0 + 2000, "results": []}
DRIVING = {"id": "driving", "name": "Driving", "started": T0 + 3000, "ended": T0 + 3500, "results": []}


class GameAt(unittest.TestCase):
    def test_periods(self):
        d = Path(tempfile.mkdtemp(dir=TMP))
        shaping = {"id": "shaping", "name": "Shot shaping", "started": T0 + 5000, "results": []}
        g = games_with_log(d, [COMBINE, DRIVING], shaping)
        self.assertEqual(g.game_at(T0 + 1500), {"id": "combine", "name": "Combine", "inTrends": False})
        self.assertEqual(g.game_at(T0 + 999)["id"], "combine")      # struck the second it started
        self.assertIsNone(g.game_at(T0 + 2500))
        self.assertEqual(g.game_at(T0 + 3200), {"id": "driving", "name": "Driving", "inTrends": True})
        self.assertEqual(g.game_at(T0 + 9000)["id"], "shaping")     # the one in play
        # A game finished since: read again.
        with open(d / "games-log.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps({"id": "distance", "name": "Distance control", "started": T0 + 2400,
                                "ended": T0 + 2600, "results": []}) + "\n")
        self.assertEqual(g.game_at(T0 + 2500)["name"], "Distance control")


@unittest.skipIf(TestClient is None, "needs httpx")
class Listing(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(dir=TMP))
        for sub in ("clips", "pose"):
            (self.dir / sub).mkdir()
        self.patches = [mock.patch.object(app, "CLIPS_DIR", self.dir / "clips"),
                        mock.patch.object(app, "POSE_DIR", self.dir / "pose"),
                        mock.patch.object(app, "EXCLUDED_FILE", self.dir / "excluded.json"),
                        mock.patch.object(app, "INCLUDED_FILE", self.dir / "included.json"),
                        mock.patch.object(app, "games_state", games_with_log(self.dir, [COMBINE, DRIVING]))]
        for p in self.patches:
            p.start()
        self.client = TestClient(app.app)
        self.names = {}
        for key, t in (("combine", T0 + 1500), ("driving", T0 + 3200), ("normal", T0 + 4000)):
            for angle in ("face", "dtl"):
                name = f"swing_{angle}_1920x1080_240fps_{t}_2000ms.mp4"
                (app.CLIPS_DIR / name).write_bytes(b"video")
                self.names[key, angle] = name

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def listed(self):
        return {c["name"]: c for c in self.client.get("/api/clips").json()}

    def exclude(self, key, exclude):
        r = self.client.post("/api/exclude", json={"names": [self.names[key, "face"]], "exclude": exclude})
        self.assertEqual(r.status_code, 200)

    def test_labeled_and_out_of_the_trends(self):
        got = self.listed()
        for angle in ("face", "dtl"):
            c = got[self.names["combine", angle]]
            self.assertEqual(c["game"]["name"], "Combine")
            self.assertTrue(c["excluded"])
            c = got[self.names["driving", angle]]
            self.assertEqual(c["game"]["name"], "Driving")
            self.assertFalse(c["excluded"])             # the usual full swing: counted
            self.assertIsNone(got[self.names["normal", angle]]["game"])
            self.assertFalse(got[self.names["normal", angle]]["excluded"])

    def test_put_back_and_left_out_again(self):
        self.exclude("combine", False)
        got = self.listed()
        self.assertFalse(got[self.names["combine", "face"]]["excluded"])
        self.assertFalse(got[self.names["combine", "dtl"]]["excluded"])   # the swing, both angles
        self.assertEqual(got[self.names["combine", "face"]]["game"]["name"], "Combine")
        self.exclude("combine", True)
        self.assertTrue(self.listed()[self.names["combine", "face"]]["excluded"])
        self.assertEqual(json.loads((self.dir / "included.json").read_text()), [])
        # A Driving swing left out by hand and put back: nothing kept for it in included.json.
        self.exclude("driving", True)
        self.assertTrue(self.listed()[self.names["driving", "face"]]["excluded"])
        self.exclude("driving", False)
        self.assertFalse(self.listed()[self.names["driving", "face"]]["excluded"])
        self.assertEqual(json.loads((self.dir / "included.json").read_text()), [])


if __name__ == "__main__":
    unittest.main()
