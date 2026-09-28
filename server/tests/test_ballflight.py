"""Ball flight (ballflight.py): carry and the rest worked out for shots from Square's GSPro connector,
which sends no carry and club speed 0. Checked against Square's own numbers on real shots.

  cd server && python -m unittest tests.test_ballflight
"""
import copy
import os
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).parent
TMP = Path(tempfile.mkdtemp(prefix="swingclips-test-"))
os.environ.setdefault("SWINGCLIPS_CLIPS", str(TMP / "clips"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import ballflight  # noqa: E402

# Square's app's numbers for one shot of each club (Sept 2026): speed, launch, direction, spin,
# spin axis -> carry, total, offline, apex ft, landing angle.
SQUARE = [
    ("DR", (116.12, 21.16, 0.32, 6495, 4.4), (160.9, 162.4, 7.8, 109, 50.4)),
    ("W3", (145.33, 12.51, -1.83, 5486, -9.48), (216.3, 220.3, -27.8, 110, 46)),
    ("I5", (96.84, 14.22, -0.06, 3830, 12.21), (126.6, 142.2, 8.8, 40, 29.3)),
    ("I7", (113.32, 21.43, 0.1, 6847, 3.99), (154.7, 156.1, 6.2, 104, 50)),
    ("PW", (94.96, 25.67, -1.53, 8434, -7.35), (121.8, 122.3, -11.1, 86, 49.1)),
    ("GW", (84.98, 27.9, -2.24, 9562, 2.19), (104.6, 104.6, -2.2, 75, 48.8)),
]


def connector_shot(speed=113.32, vla=21.43, hla=0.1, spin=6847, axis=3.99):
    """As the shot listener posts it: no carry (0 from the connector is left out), club speed missing."""
    return {"received": datetime.now().astimezone().isoformat(), "source": "gspro-connect", "club": "I7",
            "ball": {"speed": speed, "vla": vla, "hla": hla, "totalSpin": spin, "backSpin": spin, "sideSpin": 0,
                     "spinAxis": axis, "carry": None},
            "clubData": {"speed": None, "angleOfAttack": -3, "faceToTarget": 0.6, "path": -2, "loft": 29}}


class Flight(unittest.TestCase):
    def test_close_to_square(self):
        for club, launch, want in SQUARE:
            got = ballflight.flight(*launch)
            with self.subTest(club):
                # (Wedges come out ~3 yd short of Square's carry on average.)
                far = 7 if club in ("PW", "GW") else 5
                self.assertAlmostEqual(got["carry"], want[0], delta=far)
                self.assertAlmostEqual(got["total"], want[1], delta=far + 1)
                self.assertAlmostEqual(got["side"], want[2], delta=2.5)
                self.assertAlmostEqual(got["apexFt"], want[3], delta=8)
                self.assertAlmostEqual(got["landingAngle"], want[4], delta=3)

    def test_direction_and_curve(self):
        straight = ballflight.flight(110, 20, 0, 6000, 0)
        self.assertAlmostEqual(straight["side"], 0, delta=0.05)
        self.assertGreater(ballflight.flight(110, 20, 0, 6000, 10)["side"], 5)     # tilted right: fades right
        self.assertLess(ballflight.flight(110, 20, -3, 6000, 0)["side"], -5)      # started left
        self.assertGreater(ballflight.flight(120, 20, 0, 6000, 0)["carry"], straight["carry"])

    def test_no_flight(self):
        self.assertIsNone(ballflight.flight(0, 20, 0, 6000, 0))
        self.assertIsNone(ballflight.flight(float("nan"), 20, 0, 6000, 0))
        self.assertIsNone(ballflight.flight(30, -10, 0, 3000, 0))   # into the ground


class Fill(unittest.TestCase):
    def test_connector_shot(self):
        s = ballflight.fill(connector_shot())
        self.assertAlmostEqual(s["ball"]["carry"], 154.7, delta=5)
        self.assertEqual(s["ball"]["computed"], list(ballflight.FIELDS))
        self.assertIsNone(s["clubData"]["speed"])

    def test_zero_means_not_measured(self):
        s = connector_shot()
        s["ball"]["carry"] = 0
        s["clubData"].update(speed=0, smash=0)
        ballflight.fill(s)
        self.assertGreater(s["ball"]["carry"], 100)
        self.assertIsNone(s["clubData"]["speed"])
        self.assertIsNone(s["clubData"]["smash"])

    def test_square_numbers_kept(self):
        s = connector_shot()
        s["ball"].update(carry=150.0, total=152.0, side=3.0, apexFt=100, landingAngle=48)
        s["clubData"].update(speed=86.0, smash=1.32)
        before = copy.deepcopy(s)
        self.assertEqual(ballflight.fill(s), before)

    def test_not_enough_to_fly(self):
        s = connector_shot()
        del s["ball"]["totalSpin"]
        self.assertNotIn("computed", ballflight.fill(s)["ball"])


class Api(unittest.TestCase):
    def test_posted_connector_shot_gets_carry(self):
        from fastapi.testclient import TestClient
        import app
        r = TestClient(app.app).post("/api/shots", json=connector_shot())
        self.assertEqual(r.status_code, 200, r.text)
        last = app.load_shots()[-1]
        self.assertEqual(last["source"], "gspro-connect")
        self.assertAlmostEqual(last["ball"]["carry"], 154.7, delta=5)
        self.assertIn("carry", last["ball"]["computed"])


if __name__ == "__main__":
    unittest.main()
