"""Personal ranges from good shots: the settings (goodshots.py, /api/goodshots) and goodshots.js run on
the owner's real shots (fixtures/real/clips.json, with body numbers worked out from their pose files as
the server does). The rules themselves, on synthetic swings: node --test tests/goodshots.test.js

  cd server && python -m unittest tests.test_goodshots
"""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).parent
TMP = Path(tempfile.mkdtemp(prefix="swingclips-goodshots-"))
os.environ.setdefault("SWINGCLIPS_CLIPS", str(TMP / "clips"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import goodshots  # noqa: E402
import swings  # noqa: E402

REAL = HERE / "fixtures" / "real"

try:
    from fastapi.testclient import TestClient
except (ImportError, RuntimeError):
    TestClient = None


def js():
    return swings.Summarizer(HERE.parent / "static", extra=("goodshots.js",))


class Settings(unittest.TestCase):
    def test_defaults_agree_with_goodshots_js(self):
        summ = js()
        try:
            summ.call("impactCheck", None)   # starts the engine
            self.assertEqual(json.loads(summ.ctx.eval("JSON.stringify(SwingGoodShots.DEFAULTS)")), goodshots.DEFAULTS)
        finally:
            summ.close()

    def test_check(self):
        s = goodshots.check_settings({"irons": {"offlinePct": 4}, "strike": {"on": False}})
        self.assertEqual(s["irons"]["offlinePct"], 4)
        self.assertEqual(s["irons"]["carryBelowPct"], goodshots.DEFAULTS["irons"]["carryBelowPct"])
        self.assertFalse(s["strike"]["on"])
        self.assertEqual(s["woods"], goodshots.DEFAULTS["woods"])
        self.assertEqual(goodshots.check_settings({"minCount": 12.0})["minCount"], 12)
        for bad in ({"minCount": 1}, {"irons": {"offlinePct": "5"}}, {"woods": {"smashBelow": 2}},
                    {"strike": {"heelToeMm": float("nan")}}, {"irons": 5}, [], {"minCount": True}):
            with self.assertRaises(ValueError, msg=bad):
                goodshots.check_settings(bad)

    def test_file(self):
        path = TMP / "gs" / "goodshots.json"
        self.assertEqual(goodshots.load(path), goodshots.DEFAULTS)            # none yet
        goodshots.save(path, {"minCount": 10})
        self.assertEqual(goodshots.load(path)["minCount"], 10)
        path.write_text("{broken", encoding="utf-8")
        self.assertEqual(goodshots.load(path), goodshots.DEFAULTS)


@unittest.skipIf(TestClient is None, "needs httpx")
class Endpoints(unittest.TestCase):
    def test_round_trip(self):
        import app
        app.GOODSHOTS_FILE = TMP / "endpoint" / "goodshots.json"
        c = TestClient(app.app)   # not as a context manager: no background workers
        got = c.get("/api/goodshots").json()
        self.assertEqual(got["settings"], goodshots.DEFAULTS)
        self.assertEqual(got["defaults"], goodshots.DEFAULTS)
        r = c.post("/api/goodshots", json={"minCount": 5, "woods": {"offlinePct": 8}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(c.get("/api/goodshots").json()["settings"]["woods"]["offlinePct"], 8)
        self.assertEqual(c.post("/api/goodshots", json={"minCount": 0}).status_code, 400)
        self.assertEqual(c.get("/api/goodshots").json()["settings"]["minCount"], 5)   # unchanged


class RealShots(unittest.TestCase):
    """The owner's shots: 7 with the 7 iron, 2 each with the PW and driver."""

    @classmethod
    def setUpClass(cls):
        clips = json.loads((REAL / "clips.json").read_text(encoding="utf-8"))
        by_name = {c["name"]: c for c in clips}
        cls.summ = js()
        cls.swings = []
        for c in clips:
            if c["partner"] and c["angle"] != "face":
                continue   # listed by its face-on clip
            other = by_name.get(c["partner"]) if c["partner"] else None
            rec = cls.summ.summarize(swings.pose_input(c, REAL / "pose" / f"{c['name']}.v6.json.gz"),
                                     swings.pose_input(other, REAL / "pose" / f"{other['name']}.v6.json.gz") if other else None)
            cls.swings.append({"name": c["name"], "t": datetime.fromisoformat(c["recorded"]).timestamp(),
                               "club": c["shot"]["club"], "excluded": c["excluded"], "shot": c["shot"],
                               "record": rec, "light": None})

    @classmethod
    def tearDownClass(cls):
        cls.summ.close()

    def build(self, settings=None, swings_=None):
        return self.summ.call("SwingGoodShots.build", swings_ or self.swings, settings, None)

    def test_good_shots(self):
        b = self.build()
        i7 = b["clubs"]["I7"]
        self.assertEqual(i7["shots"], 7)
        self.assertEqual(i7["baseline"]["carry"], 154.2)
        self.assertEqual(i7["baseline"]["smash"], 1.25)
        good = sorted(n[-18:] for n, v in i7["verdicts"].items() if v["good"])
        # Hand-checked: 20 yd left (13% of carry), the 118 yd chunk (short, smash 1.07) and smash 1.24
        # (under the median 1.25) are out; the 168 yd one is inside the band (up to 12% past 154).
        self.assertEqual(good, sorted(["fps_1790206444.mp4", "0271665_2103ms.mp4", "0278981_2308ms.mp4", "0279635_2049ms.mp4"]))
        fails = {n[-18:]: v["fails"] for n, v in i7["verdicts"].items()}
        self.assertTrue(fails["0271783_2209ms.mp4"][0].startswith("offline 20.2 yd"))
        self.assertTrue(fails["0271802_2307ms.mp4"][0].startswith("carry 118.3 yd: short"))
        self.assertEqual(fails["0271726_2025ms.mp4"], ["smash 1.24: under your median 1.25"])
        # Two shots each: too few to know the usual carry, so none is good yet.
        for club in ("PW", "DR"):
            self.assertEqual(b["clubs"][club]["good"], 0)
            self.assertIsNone(b["clubs"][club]["baseline"])

    def test_rules_change_the_answer(self):
        # Smash within 0.01 of the median, and no strike filter: the smash-1.24 shot comes in.
        b = self.build({"irons": {"smashBelow": 0.01}, "strike": {"on": False}})
        self.assertEqual(b["clubs"]["I7"]["good"], 5)
        # Excluded swings don't count toward the medians or the good shots.
        ex = [{**s, "excluded": s["name"].endswith("1790206444.mp4")} for s in self.swings]
        self.assertEqual(self.build(None, ex)["clubs"]["I7"]["shots"], 6)

    def test_minimum_count(self):
        # 4 good shots: below the 8 a range needs, so no range, only how many there are.
        r = self.build()["clubs"]["I7"]["ranges"]
        self.assertEqual(r["tempo"], {"n": 4, "enough": False, "need": 8})

    def test_ranges_and_trust_gating(self):
        b = self.build({"minCount": 2})
        r = b["clubs"]["I7"]["ranges"]
        verdicts = b["clubs"]["I7"]["verdicts"]
        good = [s for s in self.swings if s["name"] in verdicts and verdicts[s["name"]]["good"]]
        # Face-on numbers: all 4 good swings have a reading.
        for key in ("tempo", "hipSway", "headSway", "spineTiltImpact"):
            self.assertEqual(r[key]["n"], 4, key)
            values = [s["record"]["body"][key] for s in good]
            self.assertTrue(min(values) <= r[key]["q10"] <= r[key]["q25"] <= r[key]["q50"] <= r[key]["q75"]
                            <= r[key]["q90"] <= max(values), key)
        # Down the line: the old lone face-on clip has none, and on 1790279635 the down-the-line
        # camera check says "out" (no reading, trust.js): 2 left.
        out = next(s for s in good if s["name"].endswith("1790279635_2049ms.mp4"))
        self.assertIn("out", out["record"]["quality"]["camera"]["dtl"])
        self.assertIsNotNone(out["record"]["body"]["earlyExt"])   # measured, but not counted
        for key in ("earlyExt", "bendLoss", "headToBall", "handDepthTop"):
            self.assertEqual(r[key]["n"], 2, key)
        # Head rise: shaky by definition (trust.js), so its range is marked not reliable.
        self.assertFalse(r["headRise"]["reliable"])
        self.assertIn("head rise", r["headRise"]["why"])
        self.assertTrue(r["hipSway"]["reliable"])

    def test_separation_not_enough(self):
        b = self.build()
        sep = self.summ.call("SwingGoodShots.separation", b["clubs"]["I7"], 8)
        self.assertTrue(all(not x["enough"] for x in sep))
        self.assertEqual(next(x for x in sep if x["key"] == "tempo")["nGood"], 4)
        self.assertEqual(next(x for x in sep if x["key"] == "tempo")["nRest"], 3)


if __name__ == "__main__":
    unittest.main()
