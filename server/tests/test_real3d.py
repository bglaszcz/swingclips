"""Regression tests on the first session of real calibrated 3D swings (tests/fixtures/real3d).
Re-triangulates each fixture from its pose inputs and verifies reprojection accuracy
and bone length spread do not degrade.

  cd server && python -m unittest tests.test_real3d
"""
import gzip
import json
import os
import unittest
from pathlib import Path

HERE = Path(__file__).parent
import tri  # noqa: E402

FIXTURES_DIR = HERE / "fixtures" / "real3d"

# Numerical slack allowed on re-triangulation checks compared to the saved fixture values:
REPROJ_SLACK = 0.15  # pixels
BONE_SPREAD_SLACK = 0.5  # percent


class TestReal3D(unittest.TestCase):
    def setUp(self):
        with open(FIXTURES_DIR / "session.json", "r", encoding="utf-8") as f:
            self.session = json.load(f)
        self.fixtures = sorted(FIXTURES_DIR.glob("swing_*.json.gz"))
        self.assertEqual(len(self.fixtures), 6, "Expected 6 real 3D fixture files")

    def test_retriangulate_fixtures(self):
        for fp in self.fixtures:
            with self.subTest(fixture=fp.name):
                with gzip.open(fp, "rt", encoding="utf-8") as f:
                    data = json.load(f)
                main = data["main"]
                other = data["other"]
                fix_tri = data["tri"]
                offset = fix_tri["offsetImpact"]
                main_impact = main.get("impact")

                retri = tri.swing(main, other, self.session, offset, main_impact)

                # Face-on core reprojection error median
                fix_face = fix_tri["reprojection"]["face"]["median"]
                retri_face = retri["reprojection"]["face"]["median"]
                self.assertLessEqual(
                    retri_face, fix_face + REPROJ_SLACK,
                    f"{fp.name}: Face reprojection median degraded: {retri_face} vs {fix_face}"
                )

                # DTL core reprojection error median
                fix_dtl = fix_tri["reprojection"]["dtl"]["median"]
                retri_dtl = retri["reprojection"]["dtl"]["median"]
                self.assertLessEqual(
                    retri_dtl, fix_dtl + REPROJ_SLACK,
                    f"{fp.name}: DTL reprojection median degraded: {retri_dtl} vs {fix_dtl}"
                )

                # Address core reprojection error median (both cameras)
                fix_addr = fix_tri["reprojection"]["address"]["median"]
                retri_addr = retri["reprojection"]["address"]["median"]
                self.assertLessEqual(
                    retri_addr, fix_addr + REPROJ_SLACK,
                    f"{fp.name}: Address reprojection median degraded: {retri_addr} vs {fix_addr}"
                )

                # Bone spread percentage (core bones)
                fix_bones = fix_tri["boneSpreadPct"]
                retri_bones = retri["boneSpreadPct"]
                self.assertLessEqual(
                    retri_bones, fix_bones + BONE_SPREAD_SLACK,
                    f"{fp.name}: Bone spread percentage degraded: {retri_bones}% vs {fix_bones}%"
                )


if __name__ == "__main__":
    unittest.main()
