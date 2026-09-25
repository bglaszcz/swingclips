"""Trust per number (static/trust.js) on the server: practice mode runs the same rules, quality.py and
summary.js agree on when impact can be believed, each swing's record carries what the noise table
needs, and the server works the table out and hands it to the page. Synthetic swings, no clips.

  cd server && python -m unittest tests.test_trust
(The rules themselves: node --test tests/trust.test.js)
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).parent
TMP = Path(tempfile.mkdtemp(prefix="swingclips-trust-"))
os.environ.setdefault("SWINGCLIPS_CLIPS", str(TMP / "clips"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import practice  # noqa: E402
import quality  # noqa: E402
import swings  # noqa: E402
import synthetic  # noqa: E402

try:
    from fastapi.testclient import TestClient
except (ImportError, RuntimeError):
    TestClient = None


def js():
    return swings.Summarizer(HERE.parent / "static")


class PracticeUsesTrustJs(unittest.TestCase):
    """practice.reading is SwingTrust.speakable: the page's suggested range and the phone agree."""

    def test_same_answers(self):
        summ = js()
        try:
            for face in ([], ["out"], ["edge"], ["noball"]):
                for dtl in ([], ["hands"], ["impact"]):
                    for p6 in (False, True):
                        rec = {"body": {"tempo": 3.0, "earlyExt": 1.0, "handsPlaneP6": None if p6 and not face else 0.4,
                                        "headRise": 0.2},
                               "quality": {"camera": {"face": face, "dtl": dtl}, "p6Estimated": p6}}
                        for m in practice.METRICS:
                            if m["kind"] != "body":
                                continue
                            got = summ.call("SwingTrust.speakable", m["key"], rec)
                            self.assertEqual(practice.reading(m, rec, None), (got["value"], got["why"]), (m["key"], rec))
        finally:
            summ.close()

    def test_no_rule_of_its_own(self):
        # The camera and P6 rules live in trust.js only.
        self.assertFalse(hasattr(practice, "BAD_CAMERA"))


class ImpactWindow(unittest.TestCase):
    def test_quality_and_summary_agree(self):
        summ = js()
        try:
            summ.call("impactCheck", None)                     # starts the engine
            window = json.loads(summ.ctx.eval("JSON.stringify(SwingSummary.IMPACT_WINDOW)"))
            fallback = json.loads(summ.ctx.eval("JSON.stringify(SwingSummary.STRIKE_FALLBACK)"))
            self.assertEqual(tuple(window), quality.IMPACT_WINDOW)
            self.assertEqual(tuple(fallback), quality.STRIKE_FALLBACK)
            # And they say the same about the same clips.
            for impact, strike in ((None, 2.0), (1.97, 2.0), (2.024, 2.0), (1.93, 2.0), (2.2, None), (2.3, None)):
                code = summ.call("impactCheck", {"impact": impact, "strike": strike})
                ok = quality.impact_check([{"angle": "face", "impact": impact, "strike": strike}])["ok"]
                self.assertEqual(code is None, ok, (impact, strike))
        finally:
            summ.close()


class Records(unittest.TestCase):
    """What summarize keeps for the noise table, and the impact codes in the camera check."""

    @classmethod
    def setUpClass(cls):
        cls.summ = js()

    @classmethod
    def tearDownClass(cls):
        cls.summ.close()

    def summarize(self, impact=synthetic.IMPACT):
        data = synthetic.pose_file()
        main = {"name": synthetic.NAME, "strike": 2.0, "angle": "face", "rotation": data["rotation"],
                "frames": data["frames"], "impact": impact, "ball": data["ball"]}
        return self.summ.summarize(main, None)

    def test_values_at_key_positions_and_noise(self):
        rec = self.summarize()
        self.assertEqual(sorted(rec["at"]["face"]), ["p1", "p4", "p6", "p7"])
        self.assertAlmostEqual(rec["at"]["face"]["p7"]["spineTilt"], rec["body"]["spineTiltImpact"], places=2)
        # The made-up golfer stands perfectly still at address. (It has no 3D points, so no inches.)
        self.assertLess(rec["noise"]["face"]["spineTilt"], 0.01)
        self.assertIsNone(rec["noise"]["dtl"])
        # The same numbers as the scorecard's noise floor.
        data = synthetic.pose_file()
        nf = self.summ.call("noiseFloor", {"name": synthetic.NAME, "strike": 2.0, "angle": "face",
                                           "rotation": data["rotation"], "frames": data["frames"],
                                           "impact": synthetic.IMPACT, "ball": data["ball"]}, swings.LEAD_SIDE)
        for k, v in rec["noise"]["face"].items():
            self.assertAlmostEqual(v, nf["sd"][k], places=3)

    def test_impact_codes(self):
        self.assertNotIn("noball", self.summarize()["quality"]["camera"]["face"])
        self.assertIn("noball", self.summarize(impact=None)["quality"]["camera"]["face"])
        # 30 ms after the heard strike (the ball found at the wrong spot, or late).
        self.assertIn("impact", self.summarize(impact=2.03)["quality"]["camera"]["face"])


@unittest.skipIf(TestClient is None, "needs httpx")
class Server(unittest.TestCase):
    """The swing worker's noise table, /api/noise, and /api/swings without the server-only parts."""

    @classmethod
    def setUpClass(cls):
        import app
        cls.app = app
        cls.saved = app.CLIPS_DIR, app.POSE_DIR, app.swing_records, app.swings_code, app.noise_table
        app.CLIPS_DIR, app.POSE_DIR = TMP / "s-clips", TMP / "s-pose"
        cls.client = TestClient(app.app)   # not as a context manager: no background workers

    @classmethod
    def tearDownClass(cls):
        a = cls.app
        a.CLIPS_DIR, a.POSE_DIR, a.swing_records, a.swings_code, a.noise_table = cls.saved

    def test_noise_table(self):
        app = self.app
        summ = js()
        try:
            app.swings_code = summ.code
            app.CLIPS_DIR.mkdir(parents=True, exist_ok=True)
            records = {}
            # Two sessions of 6 swings a day apart; head sway at impact wobbles ±0.2 in and moves
            # 0.3 in standing still: shaky. Spine tilt varies ~2° against 0.1° of noise: fine.
            for k in range(12):
                t = 1_790_000_000 + k * 60 + (86400 if k >= 6 else 0)
                name = f"swing_face_1920x1080_240fps_{t}_2000ms.mp4"
                (app.CLIPS_DIR / name).write_bytes(b"not really a video")
                sway = 0.2 if k % 2 else -0.2
                records[name] = {
                    "code": summ.code, "partner": None,
                    "body": {"headSway": sway}, "quality": {"camera": {"face": [], "dtl": None}},
                    "at": {"face": {"p7": {"headSway": sway, "spineTilt": 30 + 2 * (k % 3)}}, "dtl": None},
                    "noise": {"face": {"headSway": 0.3, "spineTilt": 0.1}, "dtl": None},
                }
            app.swing_records = records
            table = app.work_out_noise(summ)
        finally:
            summ.close()
        self.assertEqual((table["swings"], table["sessions"], table["code"]), (12, 2, app.swings_code))
        self.assertTrue(table["keys"]["face.headSway.p7"]["shaky"])
        self.assertFalse(table["keys"]["face.spineTilt.p7"]["shaky"])

        app.noise_table = table
        self.assertEqual(self.client.get("/api/noise").json(), table)
        got = self.client.get("/api/swings").json()
        self.assertEqual(got["noise"], table)
        self.assertEqual(len(got["swings"]), 12)
        for rec in got["swings"].values():
            self.assertNotIn("at", rec)
            self.assertNotIn("noise", rec)
            self.assertIn("body", rec)


def tearDownModule():
    # practice.py keeps a V8 for the trust rules; left open, it keeps the process from exiting (Windows).
    practice.close_rules()


if __name__ == "__main__":
    unittest.main()
