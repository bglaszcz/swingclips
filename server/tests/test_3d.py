"""3D from both phones: boards, lens and position calibration, triangulation, the 3D numbers and the
swing worker's 3D pass, on made-up cameras and a made-up swing (synthetic3d.py).

  cd server && python -m unittest tests.test_3d
"""
import gzip
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import cv2
import numpy as np

HERE = Path(__file__).parent
TMP = Path(tempfile.mkdtemp(prefix="swingclips-3d-"))
os.environ.setdefault("SWINGCLIPS_CLIPS", str(TMP / "clips"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import board  # noqa: E402
import calib  # noqa: E402
import swings  # noqa: E402
import synthetic3d as syn  # noqa: E402
import tri  # noqa: E402

STATIC = HERE.parent / "static"
LENS_VIEWS = 14


def render_swing(seed=1, drop=0.25, noise=2.0, dtl_start=-0.35):
    """(session, face pose, dtl pose): each clip starts at its own time (dtl_start s apart), drops
    its own frames, and has noisy points."""
    rng = np.random.default_rng(seed)
    ses = syn.session()
    face = syn.render(ses["cameras"]["face"], 0.0, drop, noise, rng)
    dtl = syn.render(ses["cameras"]["dtl"], dtl_start, drop, noise, rng, hand_vis=0.4)
    return ses, face, dtl


class BoardTest(unittest.TestCase):
    def test_printed_boards_are_found_whole(self):
        for spec in (board.LENS, board.MAT):
            s = 8 if spec is board.LENS else 1
            img = board.render(spec, s, margin_mm=spec.square_mm)
            found = calib.detect(img, spec)
            self.assertIsNotNone(found, spec.name)
            self.assertEqual(len(found[1]), (spec.squares[0] - 1) * (spec.squares[1] - 1), spec.name)
            # Where the detector puts each corner is where the print has it.
            want = (calib.object_points(spec, found[1])[:, :2] * 1000 + spec.square_mm) * s - 0.5
            self.assertLess(np.abs(want - found[0]).max(), 0.5, spec.name)

    def test_the_boards_never_see_each_other(self):
        self.assertIsNone(calib.detect(board.render(board.MAT, 1, margin_mm=100), board.LENS))
        self.assertIsNone(calib.detect(board.render(board.LENS, 8, margin_mm=20), board.MAT))

    def test_pdfs(self):
        out = TMP / "pdf"
        out.mkdir(exist_ok=True)
        for args, pages in ((["lens"], 1), (["mat"], 1), (["mat", "--tile", "letter"], 20)):
            path = out / ("-".join(args) + ".pdf")
            self.assertEqual(board.main(args + ["--out", str(path)]), 0)
            data = path.read_bytes()
            self.assertTrue(data.startswith(b"%PDF-1.4") and data.rstrip().endswith(b"%%EOF"))
            self.assertIn(f"/Count {pages}".encode(), data)


class CalibrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cam = syn.camera((0, 1, 3))
        cls.ray = syn.rays(cls.cam)

    def test_lens_round_trip(self):
        """The lens board waved in front of a known lens: its numbers come back."""
        rng = np.random.default_rng(3)
        spec, (w, h) = board.LENS, board.LENS.size_mm
        k = np.array(self.cam["K"])
        views = []
        for _ in range(LENS_VIEWS):
            u, v, d = rng.uniform(0.15, 0.85) * 1080, rng.uniform(0.12, 0.88) * 1920, rng.uniform(0.45, 0.8)
            rv = rng.uniform(-0.6, 0.6, 3)
            rb = cv2.Rodrigues(rv)[0]
            tb = np.array([(u - k[0, 2]) / k[0, 0] * d, (v - k[1, 2]) / k[1, 1] * d, d]) - rb @ [w / 2000, h / 2000, 0]
            found = calib.detect(syn.render_board(spec, rb, tb, self.cam, self.ray, px_per_mm=8), spec)
            if found is not None:
                views.append(found)
        c = calib.calibrate(views, tuple(self.cam["imageSize"]))
        got = np.array(c["K"])
        self.assertTrue(c["good"], c)
        self.assertLess(c["rms"], 0.5)
        self.assertLess(abs(got[0, 0] / k[0, 0] - 1), 0.01)
        self.assertLess(abs(got[1, 1] / k[1, 1] - 1), 0.01)
        self.assertLess(np.hypot(got[0, 2] - k[0, 2], got[1, 2] - k[1, 2]), 8)
        # The focal length and distortion as they act: where points across the picture land, true lens
        # against found, from the same centre (a centre a few pixels off only turns the camera a little,
        # and the position solve takes that up).
        g = np.stack(np.meshgrid(np.linspace(-0.3, 0.3, 9), np.linspace(-0.55, 0.55, 15)), -1).reshape(-1, 1, 2)
        pts = np.concatenate([g, np.ones((len(g), 1, 1))], -1)
        a = cv2.projectPoints(pts, np.zeros(3), np.zeros(3), k, np.array(self.cam["dist"]))[0]
        same_centre = got.copy()
        same_centre[:2, 2] = k[:2, 2]
        b = cv2.projectPoints(pts, np.zeros(3), np.zeros(3), same_centre, np.array(c["dist"]))[0]
        d = np.linalg.norm(a - b, axis=-1)
        self.assertLess(np.median(d), 1.0)
        self.assertLess(d.max(), 4.0)

    def test_too_few_views(self):
        with self.assertRaises(ValueError):
            calib.calibrate([], (1080, 1920))

    def test_camera_positions_from_the_mat_board(self):
        """Both cameras placed from the board lying on the mat, in golf axes."""
        ses = syn.session()
        for angle in ("face", "dtl"):
            cam = ses["cameras"][angle]
            ray = self.ray if cam["position"] == [0, 1, 3] else syn.rays(cam)
            rb, tb = syn.mat_pose(cam, board.MAT)
            img = syn.render_board(board.MAT, rb, tb, cam, ray, px_per_mm=1.0)
            lens = {"K": cam["K"], "dist": cam["dist"], "imageSize": cam["imageSize"], "name": "test", "mode": "m"}
            got = calib.camera_from_pictures([img], angle, lens)
            self.assertLess(np.linalg.norm(np.array(got["position"]) - cam["position"]), 0.02, angle)
            dr = np.array(got["R"]) @ np.array(cam["R"]).T
            self.assertLess(np.degrees(np.arccos(np.clip((np.trace(dr) - 1) / 2, -1, 1))), 0.3, angle)
            self.assertEqual(got["warnings"], [], angle)
            self.assertLess(got["rms"], 1.0)
            # Upside down (the board turned over the wrong way) is caught.
            flipped = dict(got, position=[-got["position"][0], got["position"][1], -got["position"][2]])
            self.assertTrue(calib.placement_warnings(angle, flipped), angle)

    def test_a_still_at_another_resolution(self):
        k, _ = calib.scaled_lens({"K": [[1500, 0, 540], [0, 1500, 960], [0, 0, 1]], "dist": [0] * 5,
                                  "imageSize": [1080, 1920]}, (540, 960))
        self.assertAlmostEqual(k[0, 0], 750)
        self.assertAlmostEqual(k[1, 2], 480)
        with self.assertRaises(ValueError):
            calib.scaled_lens({"K": np.eye(3).tolist(), "dist": [0] * 5, "imageSize": [1080, 1920]}, (720, 960))


class TriangulationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ses, cls.face, cls.dtl = render_swing()
        cls.offset = cls.dtl["impact"] - cls.face["impact"]
        cls.doc = tri.swing(cls.face, cls.dtl, cls.ses, cls.offset, cls.face["impact"])

    def errors(self, doc):
        out = []
        for f in doc["frames"]:
            X, _ = syn.truth(f["t"])
            out += [np.linalg.norm(np.array(p) - X[j]) for j, p in enumerate(f["p"]) if p is not None]
        return np.array(out)

    def test_joints_come_back(self):
        e = self.errors(self.doc)
        self.assertGreater(len(e), 30 * 500)
        self.assertLess(np.median(e), 0.006)          # metres
        self.assertLess(np.percentile(e, 90), 0.012)

    def test_the_club_comes_back(self):
        e = [np.linalg.norm(np.array(f["club"]) - syn.truth(f["t"])[1]) for f in self.doc["frames"] if f.get("club")]
        self.assertGreater(len(e), 500)
        self.assertLess(np.median(e), 0.01)

    def test_sync_to_a_fraction_of_a_frame(self):
        """The true offset is 0.35 s; the impact frames only say it to a frame, the fit to ~0.5 ms."""
        self.assertLess(abs(self.doc["offset"] - 0.35), 0.001)
        for wrong in (-0.004, 0.005):
            doc = tri.swing(self.face, self.dtl, self.ses, 0.35 + wrong, self.face["impact"])
            self.assertLess(abs(doc["offset"] - 0.35), 0.001, wrong)
            self.assertGreater(doc["syncError"]["atImpactOffset"], doc["syncError"]["atBest"])

    def test_reports(self):
        r = self.doc["reprojection"]
        for view in ("face", "dtl"):
            self.assertLess(r[view]["median"], 3)                  # 2 px of noise
            self.assertLess(r["filtered" + view.capitalize()]["median"], 4)
        self.assertLess(self.doc["boneSpreadPct"], 12)
        for name, b in self.doc["bones"].items():
            self.assertLess(b["filteredSpreadPct"], 1.0, name)
        self.assertAlmostEqual(self.doc["bones"]["lead forearm"]["length"], syn.FOREARM, delta=0.01)
        json.dumps(self.doc)

    def test_filter_beats_raw_points(self):
        """With more noise, the bone-length and smoothing filter lands closer than the raw fit."""
        ses, face, dtl = render_swing(seed=5, noise=5.0)
        cams = [tri.Camera(ses["cameras"]["face"]), tri.Camera(ses["cameras"]["dtl"])]
        off = 0.35
        t, pxs, wts, norm = tri.paired(tri.points(face["frames"], cams[0].size), tri.points(dtl["frames"], cams[1].size),
                                       cams, off)
        raw = tri.triangulate(cams, norm, wts)[:, :33]
        truth = np.array([syn.truth(ti)[0] for ti in t])
        raw_err = np.nanmedian(np.linalg.norm(raw - truth, axis=-1))
        doc = tri.swing(face, dtl, ses, off, face["impact"])
        self.assertLess(np.median(self.errors(doc)), 0.8 * raw_err)

    def test_no_dtl_frames_nearby(self):
        """Down-the-line frames missing for a stretch: those face-on frames get nothing made up
        beyond FILL_MAX."""
        ses, face, dtl = render_swing(seed=2)
        dtl = dict(dtl, frames=[f for f in dtl["frames"] if not 0.9 < f["t"] - 0.35 < 1.2])
        doc = tri.swing(face, dtl, ses, 0.35, face["impact"])
        mid = [f for f in doc["frames"] if 0.98 < f["t"] < 1.12]
        self.assertTrue(mid and all(p is None for f in mid for p in f["p"]))


class Metrics3DTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ses, face, dtl = render_swing(seed=4)
        cls.doc = tri.swing(face, dtl, ses, dtl["impact"] - face["impact"], face["impact"])
        cls.js = swings.Summarizer(STATIC, swings.JS_3D)
        cls.positions = [{"key": "p1", "t": 0.9}, {"key": "p4", "t": syn.TOP}, {"key": "p7", "t": face["impact"]}]

    @classmethod
    def tearDownClass(cls):
        cls.js.close()

    def compute(self, club="I7"):
        return self.js.call("compute", self.doc, self.positions, "left", club, ns="SwingMetrics3D")

    def test_turns_against_the_truth(self):
        r = self.compute()
        for v in r["values"]:
            if not 1.0 <= v["t"] <= 2.2 or "pelvisTurn" not in v:
                continue
            p, th, _, _ = syn.turns(v["t"])
            self.assertAlmostEqual(v["pelvisTurn"], p, delta=4, msg=v["t"])
            self.assertAlmostEqual(v["thoraxTurn"], th, delta=4, msg=v["t"])
            self.assertAlmostEqual(v["thoraxBend"], syn.SPINE_BEND, delta=3, msg=v["t"])
            self.assertAlmostEqual(v["pelvisSway"], 0, delta=0.5, msg=v["t"])

    def test_kinematic_sequence(self):
        seq = self.compute()["sequence"]
        self.assertEqual(seq["order"], ["pelvis", "thorax", "arm", "club"])
        self.assertTrue(seq["inOrder"])
        peaks = {s["key"]: s for s in seq["segments"]}
        # Designed peaks: pelvis 1.95 s, thorax 1.97 s (each halfway through its move).
        self.assertAlmostEqual(peaks["pelvis"]["t"], syn.PELVIS_DOWN[0] + syn.PELVIS_DOWN[1] / 2, delta=0.012)
        self.assertAlmostEqual(peaks["thorax"]["t"], syn.THORAX_DOWN[0] + syn.THORAX_DOWN[1] / 2, delta=0.012)
        # Peak rotation speed of a smoothstep: 1.5 x the change over its time.
        want = 1.5 * (syn.PELVIS_TOP - syn.PELVIS_END) / syn.PELVIS_DOWN[1]
        self.assertAlmostEqual(peaks["pelvis"]["peak"], want, delta=0.1 * want)

    def test_club_length_check(self):
        cc = self.compute("I7")["clubCheck"]
        self.assertTrue(cc["ok"])
        self.assertAlmostEqual(cc["measured"], syn.HANDS_TO_HEAD * 39.37, delta=0.5)
        self.assertFalse(self.compute("DR")["clubCheck"]["ok"])
        self.assertIsNone(self.compute(None)["clubCheck"]["ok"])

    def test_left_handed_is_not_guessed(self):
        self.assertIsNone(self.js.call("compute", self.doc, self.positions, "right", None, ns="SwingMetrics3D"))


class SwingWorkerTest(unittest.TestCase):
    """The worker's 3D pass on a made-up swing with both angles: made with a calibration, left out
    without one, and when a camera moved."""

    def setUp(self):
        import app
        self.app = app
        self.dir = Path(tempfile.mkdtemp(dir=TMP))
        for d in ("clips", "pose", "calib"):
            (self.dir / d).mkdir()
        self.patches = [mock.patch.object(app, "CLIPS_DIR", self.dir / "clips"),
                        mock.patch.object(app, "POSE_DIR", self.dir / "pose"),
                        mock.patch.object(calib, "CALIB_DIR", self.dir / "calib"),
                        mock.patch.dict(os.environ, {"SWINGCLIPS_3D": "on"})]
        for p in self.patches:
            p.start()
        self.js = swings.Summarizer(STATIC, swings.JS_3D)
        app.swings_code = self.js.code
        app.swing_records = {}

    def tearDown(self):
        self.js.close()
        for p in self.patches:
            p.stop()

    def add_swing(self, unix, face, dtl):
        names = []
        for angle, data in (("face", face), ("dtl", dtl)):
            # Each phone names its clip after the strike it heard, a little after the ball went.
            name = f"swing_{angle}_1920x1080_240fps_{unix}_{round((data['impact'] + 0.025) * 1000)}ms.mp4"
            (self.app.CLIPS_DIR / name).write_bytes(b"not a video")
            os.utime(self.app.CLIPS_DIR / name, (unix, unix))
            self.app.pose_file(name).write_bytes(gzip.compress(json.dumps(data).encode()))
            names.append(name)
        return names

    def records(self):
        clips = {c["name"]: c for c in self.app.listed_clips(with_shots=False)}
        for c in clips.values():
            if c["angle"] == "face" and c["partner"]:
                rec = self.js.summarize(swings.pose_input(c, self.app.pose_file(c["name"])),
                                        swings.pose_input(clips[c["partner"]], self.app.pose_file(c["partner"])))
                self.app.swing_records[c["name"]] = dict(rec, code=self.js.code, partner=c["partner"])
        return clips

    def session(self, created):
        ses = syn.session()
        for cam in ses["cameras"].values():
            cam["mode"] = "1920x1080_240fps"
        calib.save_session(ses["cameras"], created=created)

    def test_made_with_a_calibration(self):
        _, face, dtl = render_swing(seed=7)
        face_name, _ = self.add_swing(1789000000, face, dtl)
        clips = self.records()
        self.assertTrue(self.app.swing_records[face_name]["body"]), "the made-up swing isn't found as a swing"
        # No calibration yet: said why, nothing made.
        self.assertEqual(self.app.pass_3d(clips, self.js, mock.Mock(is_set=lambda: False)), 1)
        self.assertIn("no calibration", self.app.swing_records[face_name]["why3d"])
        self.assertFalse(self.app.file_3d(face_name).exists())
        # Calibrated before the swing: made, and its numbers kept.
        self.session(1788999000)
        self.assertEqual(self.app.pass_3d(clips, self.js, mock.Mock(is_set=lambda: False)), 1)
        rec = self.app.swing_records[face_name]
        self.assertIsNone(rec["why3d"])
        self.assertTrue(self.app.file_3d(face_name).is_file())
        # At the top as phases.js finds it (the end of the hands' rise), against the made-up turn then.
        c = clips[face_name]
        top = self.js.call("positionTimes", swings.pose_input(c, self.app.pose_file(face_name)),
                           swings.pose_input(clips[c["partner"]], self.app.pose_file(c["partner"])), "left")["main"]["times"]["p4"]
        self.assertAlmostEqual(rec["body3d"]["numbers"]["thoraxTop"], syn.turns(top)[1], delta=4)
        self.assertAlmostEqual(rec["body3d"]["numbers"]["pelvisTop"], syn.turns(top)[0], delta=4)
        self.assertEqual(rec["body3d"]["sequence"]["order"], ["pelvis", "thorax", "arm", "club"])
        # Nothing new: nothing done again.
        self.assertEqual(self.app.pass_3d(clips, self.js, mock.Mock(is_set=lambda: False)), 0)

    def test_camera_moved(self):
        _, face, dtl = render_swing(seed=8)
        first, _ = self.add_swing(1789000000, face, dtl)
        # The same swing again later, with the face-on camera moved: the golfer is further left.
        shifted = json.loads(json.dumps(face))
        for f in shifted["frames"]:
            for i in range(0, 99, 3):
                f["lm"][i] -= 0.08
        later, _ = self.add_swing(1789000100, shifted, dtl)
        self.session(1788999000)
        clips = self.records()
        self.app.pass_3d(clips, self.js, mock.Mock(is_set=lambda: False))
        self.assertIsNone(self.app.swing_records[first]["why3d"])
        self.assertIn("face-on camera moved", self.app.swing_records[later]["why3d"])
        self.assertFalse(self.app.file_3d(later).exists())

    def test_scorecard(self):
        """Labels on both angles (the true joints): the 3D joints put back into each view land on them."""
        import eval as scorecard
        ses, face, dtl = render_swing(seed=9)
        face_name, dtl_name = self.add_swing(1789000000, face, dtl)
        self.session(1788999000)
        self.app.pass_3d(self.records(), self.js, mock.Mock(is_set=lambda: False))
        labels = self.dir / "labels"
        labels.mkdir()
        infos = {"face": {"name": face_name, "angle": "face", "strike": face["impact"] + 0.025},
                 "dtl": {"name": dtl_name, "angle": "dtl", "strike": dtl["impact"] + 0.025}}
        for angle, data, start in (("face", face, 0.0), ("dtl", dtl, -0.35)):
            cam = tri.Camera(ses["cameras"][angle])
            frames = {}
            for f in data["frames"][200:700:50]:
                px = cam.project(syn.truth(f["t"] + start)[0])
                frames[f"{f['t']:.6f}"] = {j: {"x": px[i, 0] / 1080, "y": px[i, 1] / 1920} for j, i in scorecard.JOINTS.items()}
            doc = {"schema": 1, "clip": infos[angle], "partner": infos["dtl" if angle == "face" else "face"],
                   "events": {}, "frames": frames}
            (labels / f"{infos[angle]['name']}.json").write_text(json.dumps(doc))
        out = self.dir / "eval"
        with mock.patch.object(self.app, "LABELS_DIR", labels):
            self.assertEqual(scorecard.main(["--no-noise", "--no-quality", "--out", str(out)]), 0)
        t = json.loads(max(out.glob("*.json")).read_text())["tables"]
        self.assertEqual(len(t["threeD"]), 1)
        self.assertLess(t["threeD"][0]["face"], 3)
        rows = {(r["angle"], r["joints"]): r for r in t["threeDJoints"]}
        self.assertEqual({a for a, _ in rows}, {"face", "dtl"})
        for r in rows.values():
            self.assertLess(r["median3d"], 0.5, r)     # % of height: a few millimetres
            self.assertLess(r["median3d"], r["median2d"] + 0.1, r)

    def test_off_by_default(self):
        with mock.patch.dict(os.environ, {"SWINGCLIPS_3D": ""}):
            self.assertFalse(calib.enabled())
            self.assertEqual(swings.Summarizer(STATIC).code, swings.Summarizer(STATIC, ()).code)
            try:
                from fastapi.testclient import TestClient
            except (ImportError, RuntimeError):
                return
            c = TestClient(self.app.app)
            self.assertEqual(c.get("/api/calib").json(), {"enabled": False})


if __name__ == "__main__":
    unittest.main()
