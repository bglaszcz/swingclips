"""The label endpoints and the scorecard (eval.py), on a made-up swing (synthetic.py) in temporary folders.

  cd server && python -m unittest discover tests
"""
import gzip
import json
import math
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).parent
TMP = Path(tempfile.mkdtemp(prefix="swingclips-test-"))
# app.py reads its folders when it's imported.
os.environ.update(SWINGCLIPS_CLIPS=str(TMP / "clips"), SWINGCLIPS_EVAL=str(TMP / "eval"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import app  # noqa: E402
import eval as scorecard  # noqa: E402
import pose  # noqa: E402
import synthetic  # noqa: E402
try:
    from fastapi.testclient import TestClient  # needs httpx, which the server itself doesn't
except (ImportError, RuntimeError):
    TestClient = None

# How far off the "hand labels" are put from the synthetic truth, in picture heights.
OFFSET = 0.01


def write_clip(name: str, data: dict) -> None:
    app.CLIPS_DIR.mkdir(parents=True, exist_ok=True)
    app.POSE_DIR.mkdir(parents=True, exist_ok=True)
    (app.CLIPS_DIR / name).write_bytes(b"not really a video")
    app.pose_file(name).write_bytes(gzip.compress(json.dumps(data).encode()))


def label_doc(name: str, angle: str, strike: float, partner: dict | None, data: dict) -> dict:
    """Labels as the review page would save them: the true moments, joints a little off the truth."""
    ts = [f["t"] for f in data["frames"]]
    snap = lambda t: ts[scorecard.frame_index(ts, t)]
    events = {"takeaway": synthetic.TAKEAWAY, "p4": synthetic.TOP, "impact": synthetic.IMPACT}
    frames = {}
    for t in (0.5, 1.4, 1.9, 2.1):
        f = data["frames"][scorecard.frame_index(ts, t)]
        pts = {j: {"x": f["lm"][i * 3] + OFFSET / (1080 / 1920), "y": f["lm"][i * 3 + 1]}
               for j, i in scorecard.JOINTS.items()}
        grip = (f["lm"][15 * 3], f["lm"][15 * 3 + 1])
        a = math.radians(f["club"][0])
        aspect = 1080 / 1920
        pts["grip"] = {"x": grip[0], "y": grip[1]}
        pts["head"] = {"x": grip[0] + 0.3 * math.cos(a) / aspect, "y": grip[1] + 0.3 * math.sin(a), "blur": f["club"][1] < 0.35}
        pts["hosel"] = {"hidden": True}
        frames[f"{f['t']:.6f}"] = pts
    return {"schema": 1, "clip": {"name": name, "angle": angle, "strike": strike}, "partner": partner,
            "events": {k: snap(v) for k, v in events.items()}, "ball": {"x": 0.5, "y": 0.8}, "frames": frames}


class ScorecardTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.face = synthetic.pose_file(seed=1)
        cls.dtl = synthetic.pose_file(seed=2)
        write_clip(synthetic.NAME, cls.face)
        write_clip(synthetic.DTL_NAME, cls.dtl)
        # Not as a context manager: no background workers.
        cls.client = TestClient(app.app) if TestClient else None

    @unittest.skipIf(TestClient is None, "the endpoint test needs FastAPI's test client (pip install httpx)")
    def test_1_labels_endpoints(self):
        face = {"name": synthetic.NAME, "angle": "face", "strike": 2.0}
        dtl = {"name": synthetic.DTL_NAME, "angle": "dtl", "strike": 2.01}
        c = self.client
        self.assertEqual(c.get(f"/api/labels/{synthetic.NAME}").status_code, 404)
        doc = label_doc(synthetic.NAME, "face", 2.0, dtl, self.face)
        r = c.post(f"/api/labels/{synthetic.NAME}", content=json.dumps(doc))
        self.assertEqual(r.status_code, 200, r.text)
        got = c.get(f"/api/labels/{synthetic.NAME}").json()
        self.assertEqual(got["events"], doc["events"])
        self.assertEqual(got["pass"], 1)
        # The same, a little different, as a second pass.
        doc2 = json.loads(json.dumps(doc))
        doc2["events"]["p4"] += 0.01
        self.assertEqual(c.post(f"/api/labels/{synthetic.NAME}?pass=2", content=json.dumps(doc2)).status_code, 200)
        r = c.post(f"/api/labels/{synthetic.DTL_NAME}", content=json.dumps(label_doc(synthetic.DTL_NAME, "dtl", 2.01, face, self.dtl)))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(c.get("/api/labels").json(), {"1": sorted([synthetic.NAME, synthetic.DTL_NAME]), "2": [synthetic.NAME]})
        # Refused: a file for another clip, a path, a third pass, a clip that isn't there.
        self.assertEqual(c.post(f"/api/labels/{synthetic.DTL_NAME}", content=json.dumps(doc)).status_code, 400)
        self.assertEqual(c.post("/api/labels/..%2Fapp.py", content=json.dumps(doc)).status_code, 404)
        self.assertEqual(c.post(f"/api/labels/{synthetic.NAME}?pass=3", content=json.dumps(doc)).status_code, 400)
        missing = dict(doc, clip={"name": "swing_face_1920x1080_240fps_1789000000_2000ms.mp4"})
        self.assertEqual(c.post("/api/labels/swing_face_1920x1080_240fps_1789000000_2000ms.mp4",
                                content=json.dumps(missing)).status_code, 404)

    def test_2_scorecard(self):
        if self.client is None:
            # Without the endpoint test, write the label files directly.
            face = {"name": synthetic.NAME, "angle": "face", "strike": 2.0}
            dtl = {"name": synthetic.DTL_NAME, "angle": "dtl", "strike": 2.01}
            app.LABELS_DIR.mkdir(parents=True, exist_ok=True)
            doc = label_doc(synthetic.NAME, "face", 2.0, dtl, self.face)
            app.label_file(synthetic.NAME, 1).write_text(json.dumps(doc))
            doc["events"]["p4"] += 0.01
            app.label_file(synthetic.NAME, 2).write_text(json.dumps(doc))
            app.label_file(synthetic.DTL_NAME, 1).write_text(json.dumps(label_doc(synthetic.DTL_NAME, "dtl", 2.01, face, self.dtl)))
        out = TMP / "eval"
        self.assertEqual(scorecard.main(["--out", str(out)]), 0)
        result = json.loads(max(out.glob("*.json")).read_text())
        t = result["tables"]
        self.assertEqual(result["labeledClips"], 2)
        self.assertEqual(result["poseVersion"], pose.VERSION)

        events = {(r["angle"], r["event"]): r for r in t["events"]}
        # The synthetic takeaway is at 1.0 s; the page's is where the club starts moving.
        self.assertLess(events["face", "takeaway"]["median"], 60)
        self.assertLess(events["face", "p4"]["median"], 20)
        self.assertEqual(events["face", "impact"]["median"], 0)          # from the ball, exactly
        self.assertEqual(events["face", "ball gone"]["within1"], 100)
        self.assertIn(("dtl", "impact"), events)

        # Joints were labeled OFFSET off; body height is 0.5 picture heights, so ~2% of it.
        for r in t["joints"]:
            self.assertAlmostEqual(r["median"], OFFSET / 0.5 * 100, delta=0.2, msg=r)
        self.assertTrue(all(r["swapped"] == 0 for r in t["swaps"]))

        club = {(r["angle"], r["phase"]): r for r in t["club"]}
        self.assertEqual(club["face", "address"]["found"], 100)
        self.assertLess(club["face", "address"]["median"], 0.5)
        self.assertEqual(club["face", "downswing"]["found"], 0)          # blurred: low confidence

        angles = {(r["angle"], r["metric"]): r for r in t["angles"]}
        self.assertIn(("face", "spineTilt"), angles)
        self.assertIn(("dtl", "bend"), angles)
        self.assertEqual({r["angle"]: r["found"] for r in t["ball"]}, {"face": 100, "dtl": 100})

        labeler = {r["what"]: r for r in t["labeler"]}
        self.assertAlmostEqual(labeler["events (ms)"]["p90"], 8, delta=0.01)   # of 0, 0 and 10 ms
        self.assertEqual(labeler["joints (% of height)"]["median"], 0)

        noise = {(r["angle"], r["metric"]): r for r in t["noise"]}
        self.assertEqual(noise["face", "spineTilt"]["clips"], 1)
        self.assertLess(noise["face", "spineTilt"]["median"], 1e-6)       # a perfectly still made-up golfer

        # --compare against itself: every headline number unchanged.
        self.assertEqual(scorecard.main(["--out", str(out), "--no-noise", "--compare", str(max(out.glob("*.json")))]), 0)


if __name__ == "__main__":
    unittest.main()
