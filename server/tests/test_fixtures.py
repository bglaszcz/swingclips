"""The scorecard on the real labeled swings in tests/fixtures/real (no video needed)."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).parent
REAL = HERE / "fixtures" / "real"
TMP = Path(tempfile.mkdtemp(prefix="swingclips-fixtures-"))
os.environ.setdefault("SWINGCLIPS_CLIPS", str(TMP / "clips"))
sys.path[:0] = [str(HERE.parent)]

import app  # noqa: E402
import eval as scorecard  # noqa: E402


@unittest.skipUnless((REAL / "labels").is_dir(), "no real fixtures")
class RealSwingsTest(unittest.TestCase):
    def test_scorecard_runs_on_real_swings(self):
        with mock.patch.object(app, "LABELS_DIR", REAL / "labels"), mock.patch.object(app, "POSE_DIR", REAL / "pose"):
            self.assertEqual(scorecard.main(["--no-noise", "--no-quality", "--out", str(TMP / "eval")]), 0)
        out = sorted((TMP / "eval").glob("*.json"))
        self.assertTrue(out)
        import json
        result = json.loads(out[-1].read_text(encoding="utf-8"))
        self.assertGreater(result["labeledClips"], 0)
        impact = [r for r in result["tables"]["events"] if r["event"] == "impact" and r["angle"] == "face"]
        self.assertTrue(impact and impact[0]["labeled"] > 0)


if __name__ == "__main__":
    unittest.main()
