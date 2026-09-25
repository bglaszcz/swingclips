"""The scorecard on the real labeled swings in tests/fixtures/real (no video needed)."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from unittest import mock

HERE = Path(__file__).parent
REAL = HERE / "fixtures" / "real"
TMP = Path(tempfile.mkdtemp(prefix="swingclips-fixtures-"))
os.environ.setdefault("SWINGCLIPS_CLIPS", str(TMP / "clips"))
sys.path[:0] = [str(HERE.parent)]

import app  # noqa: E402
import eval as scorecard  # noqa: E402
import tune_positions  # noqa: E402

# Key positions may be this much worse than the saved errors (ms): a frame at 240 fps.
TOLERANCE_MS = 4.2


@unittest.skipUnless((REAL / "labels").is_dir(), "no real fixtures")
class RealSwingsTest(unittest.TestCase):
    def test_scorecard_runs_on_real_swings(self):
        with mock.patch.object(app, "LABELS_DIR", REAL / "labels"), mock.patch.object(app, "POSE_DIR", REAL / "pose"):
            self.assertEqual(scorecard.main(["--no-noise", "--no-quality", "--out", str(TMP / "eval")]), 0)
        out = sorted((TMP / "eval").glob("*.json"))
        self.assertTrue(out)
        result = json.loads(out[-1].read_text(encoding="utf-8"))
        self.assertGreater(result["labeledClips"], 0)
        impact = [r for r in result["tables"]["events"] if r["event"] == "impact" and r["angle"] == "face"]
        self.assertTrue(impact and impact[0]["labeled"] > 0)



@unittest.skipUnless(tune_positions.BASELINE.is_file(), "no saved key-position errors")
class KeyPositionsTest(unittest.TestCase):
    """The key positions on the labeled swings must not get worse than the errors saved in
    key-positions.json (tune_positions.py --baseline, after a change that makes them better): per
    body model, angle and key position, the median and 90th percentile of the error."""

    def test_no_worse_than_saved(self):
        saved = json.loads(tune_positions.BASELINE.read_text(encoding="utf-8"))
        swing_list = tune_positions.load_swings(REAL / "labels", REAL / "clips.json")
        for folder, clips in saved["errors"].items():
            scorer = tune_positions.Scorer(REAL / folder, swing_list)
            try:
                rows = [r for rs in scorer.errors(scorer.tuning()) for r in rs
                        if r["event"] in clips.get(r["clip"], {})]
            finally:
                scorer.close()
            groups = {}
            for r in rows:
                was = clips[r["clip"]][r["event"]]
                g = groups.setdefault((r["angle"], r["event"]), ([], []))
                g[0].append(500.0 if was is None else abs(was))
                g[1].append(500.0 if r["ms"] is None else abs(r["ms"]))
            self.assertTrue(groups, folder)
            for (angle, event), (was, now) in sorted(groups.items()):
                for name, stat in (("median", np.median), ("90th percentile", lambda v: np.percentile(v, 90))):
                    with self.subTest(folder=folder, angle=angle, event=event, stat=name):
                        self.assertLessEqual(stat(now), stat(was) + TOLERANCE_MS,
                                             f"{folder} {angle} {event}: {name} {stat(now):.1f} ms, was {stat(was):.1f} ms")


if __name__ == "__main__":
    unittest.main()
