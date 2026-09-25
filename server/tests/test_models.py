"""Other body models (models.py) and how pose.py and eval.py use them, with a tiny made-up ONNX model
and a drawn clip (fakes.py) instead of real weights and swings.

  cd server && python -m unittest discover tests
"""
import gzip
import importlib.util
import json
import math
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import cv2
import numpy as np

HERE = Path(__file__).parent
TMP = Path(tempfile.mkdtemp(prefix="swingclips-models-test-"))
os.environ.setdefault("SWINGCLIPS_CLIPS", str(TMP / "clips"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import app  # noqa: E402
import eval as scorecard  # noqa: E402
import fakes  # noqa: E402
import models  # noqa: E402
import pose  # noqa: E402

try:
    import onnxruntime  # noqa: F401
except ImportError:
    onnxruntime = None
needs_ort = unittest.skipIf(onnxruntime is None, "needs onnxruntime (pip install -r requirements.txt)")

# pose.py and club.py as they were before other body backends: the default must still give exactly this.
REFERENCE_COMMIT = "0e3ba90e4b63f4d48ec3b4d502ca817ae8d5f863"
MODELS = TMP / "models"


def fake_models() -> dict:
    """Environment for a fake rtmpose-m in its own models folder."""
    MODELS.mkdir(parents=True, exist_ok=True)
    fakes.simcc_model(MODELS / models.SPECS["rtmpose-m"].file, *models.SPECS["rtmpose-m"].size, fakes.CHANNELS)
    return {"SWINGCLIPS_MODELS": str(MODELS), "SWINGCLIPS_POSE_BACKEND": "rtmpose-m", "SWINGCLIPS_CLUB_BACKEND": ""}


def analyze(module, path) -> dict:
    """module.analyze on a clip, in this process with the fake MediaPipe; without the timing."""
    with fakes.mediapipe(), mock.patch("builtins.print"):
        out = module.analyze(str(path), fakes.Pool(), 2)
    out.pop("seconds")
    return out


class MappingTest(unittest.TestCase):
    def test_coco_to_mediapipe(self):
        self.assertEqual(sorted(models.COCO_TO_MP), list(range(17)))
        self.assertEqual(len(set(models.COCO_TO_MP.values())), 17)
        # Person's own left and right in both: COCO 5/6 shoulders, 9/10 wrists, 15/16 ankles.
        for coco, mp in ((0, 0), (1, 2), (2, 5), (3, 7), (4, 8), (5, 11), (6, 12), (7, 13), (8, 14), (9, 15),
                         (10, 16), (11, 23), (12, 24), (13, 25), (14, 26), (15, 27), (16, 28)):
            self.assertEqual(models.COCO_TO_MP[coco], mp)
        # The landmarks eval.py scores are all covered.
        self.assertTrue(set(scorecard.JOINTS.values()) <= set(models.COCO_TO_MP.values()))

    def test_wholebody_adds_feet_and_hands(self):
        m = models.WHOLEBODY_TO_MP
        self.assertEqual({m[17], m[19], m[20], m[22]}, {31, 29, 32, 30})
        self.assertEqual((m[91 + 5], m[112 + 5]), (19, 20))          # index knuckles
        self.assertEqual(len(set(m.values())), len(m))
        self.assertTrue(all(0 <= i < 33 for i in m.values()))

    def test_to_mediapipe_keeps_the_rest(self):
        mp = [(i / 100, i / 50, 0.5) for i in range(33)]
        coco = [(1 + k, 2 + k, 0.9) for k in range(17)]
        out = models.to_mediapipe(coco, mp, "coco17")
        self.assertEqual(len(out), 33)
        self.assertEqual(out[15], coco[9])
        self.assertEqual(out[24], coco[12])
        for i in set(range(33)) - set(models.COCO_TO_MP.values()):
            self.assertEqual(out[i], mp[i], i)
        whole = [(1 + k, 2 + k, 0.9) for k in range(133)]
        out = models.to_mediapipe(whole, mp, "wholebody133")
        self.assertEqual(out[19], whole[96])
        self.assertEqual(out[29], whole[19])
        self.assertEqual(out[1], mp[1])                             # inner eye: not in either


class CropTest(unittest.TestCase):
    def test_box_padding(self):
        pts = [(0.2, 0.1, 0.9), (0.4, 0.5, 0.9), (0.3, 0.3, 0.9), (0.9, 0.9, 0.1)]     # the last too unsure
        x0, y0, x1, y1 = models.box_of(pts, 1000, 1000)
        self.assertAlmostEqual(x0, 200 - 25)
        self.assertAlmostEqual(x1, 400 + 25)
        self.assertAlmostEqual(y0, 100 - 50)
        self.assertAlmostEqual(y1, 500 + 50)
        self.assertIsNone(models.box_of(pts[:2], 1000, 1000))

    def test_crop_shape(self):
        # A tall box: the height fills the input, grown by the models' 1.25.
        cx, cy, s = models.crop_transform((100, 0, 200, 400), (192, 256))
        self.assertEqual((cx, cy), (150, 200))
        self.assertAlmostEqual(s, 400 * 1.25 / 256)
        # A wide one: the width does.
        self.assertAlmostEqual(models.crop_transform((0, 0, 400, 100), (192, 256))[2], 400 * 1.25 / 192)

    def test_crop_and_uncrop(self):
        """A dot in the picture, found in the crop, lands back on the dot."""
        size = (192, 256)
        img = np.zeros((480, 270, 3), np.uint8)
        for x, y in ((60, 100), (135, 240), (250, 470), (5, 5)):
            img[:] = 0
            cv2.circle(img, (x, y), 2, (255, 255, 255), -1)
            for box in ((0, 0, 270, 480), (x - 40, y - 60, x + 30, y + 50)):
                patch, t = models.crop(img, box, size)
                self.assertEqual(patch.shape, (256, 192, 3))
                v, u = np.unravel_index(patch.max(axis=2).argmax(), patch.shape[:2])
                (bx, by, _), = models.uncrop([(u, v, 1)], t, size)
                self.assertLess(math.hypot(bx - x, by - y), 0.5 + t[2], (x, y, box))

    def test_decode_simcc(self):
        sx, sy = np.zeros((2, 384)), np.zeros((2, 512))
        sx[0, 101], sy[0, 300], sx[1, 10], sy[1, 20] = 0.8, 0.6, 2.0, 3.0
        (u, v, c), (_, _, c2) = models.decode_simcc(sx, sy, 192, 256)
        self.assertEqual((u, v), (50.5, 150.0))
        self.assertAlmostEqual(c, 0.7)
        self.assertEqual(c2, 1.0)                                   # clipped

    @needs_ort
    def test_fake_model_through_every_rotation(self):
        """A dot in a stored frame, turned upright as pose.py does, found by the fake model in the
        crop and put back in upright picture units: where the dot shows on screen."""
        path = TMP / "fake-rtmpose.onnx"
        fakes.simcc_model(path)
        runner = models.load("rtmpose-m", path)
        self.assertEqual(runner.size, (192, 256))
        for rotation in (0, 90, 180, 270):
            upright = np.zeros((960, 540, 3), np.uint8)
            x, y = 0.3, 0.7
            cv2.circle(upright, (int(x * 540), int(y * 960)), 5, (255, 255, 255), -1)
            stored = cv2.rotate(upright, fakes.STORE[rotation]) if rotation else upright
            # pose.run_chunk: half size, then turned upright.
            rgb = cv2.resize(stored, None, fx=pose.SCALE, fy=pose.SCALE, interpolation=cv2.INTER_AREA)
            if rotation in pose.ROTATE_CW:
                rgb = cv2.rotate(rgb, pose.ROTATE_CW[rotation])
            self.assertEqual(rgb.shape[:2], (480, 270), rotation)
            pts = runner.track(rgb, (0.1 * 270, 0.4 * 480, 0.6 * 270, 0.95 * 480))
            self.assertEqual(len(pts), 17)
            for px, py, c in pts:
                # Within 2.5 pixels of the half-size picture.
                self.assertAlmostEqual(px * 270, x * 270, delta=2.5, msg=rotation)
                self.assertAlmostEqual(py * 480, y * 480, delta=2.5, msg=rotation)
                self.assertEqual(c, 1.0)

    @needs_ort
    def test_tracker_falls_back_to_mediapipe(self):
        path = TMP / "fake-rtmpose.onnx"
        fakes.simcc_model(path)
        tracker = models.BodyTracker(models.load("rtmpose-m", path))
        img = np.zeros((480, 270, 3), np.uint8)
        cv2.circle(img, (100, 200), 3, (255, 255, 255), -1)
        mp = [(0.3 + 0.01 * (i % 5), 0.3 + 0.01 * i, 0.9) for i in range(33)]
        out = tracker.frame(img, mp)
        self.assertAlmostEqual(out[15][0], 100 / 270, delta=0.01)
        self.assertEqual(out[19], mp[19])                           # no hands in RTMPose: MediaPipe's
        self.assertIsNotNone(tracker.last)
        # Every keypoint on one dot: no box from them, so the next crop is MediaPipe's again.
        self.assertIsNone(models.box_of(tracker.last, 270, 480))
        self.assertIsNone(tracker.frame(img, None))                 # no one found: lost
        self.assertIsNone(tracker.last)

    def test_backend_setting(self):
        with mock.patch.dict(os.environ, {"SWINGCLIPS_POSE_BACKEND": ""}):
            self.assertEqual(models.backend(), "mediapipe")
        with mock.patch.dict(os.environ, {"SWINGCLIPS_POSE_BACKEND": "RTMW"}):
            self.assertEqual(models.backend(), "rtmw")
        with mock.patch.dict(os.environ, {"SWINGCLIPS_POSE_BACKEND": "openpose"}):
            self.assertRaises(ValueError, models.backend)
        self.assertEqual(models.stamp("rtmpose-l"), "rtmpose-l-384x288")


def reference_pose():
    """pose.py (with its club.py) from REFERENCE_COMMIT as a module, or None without git."""
    root = HERE.parent.parent
    try:
        src = {f: subprocess.run(["git", "-C", str(root), "show", f"{REFERENCE_COMMIT}:server/{f}"],
                                 capture_output=True, check=True).stdout for f in ("pose.py", "club.py")}
    except (OSError, subprocess.CalledProcessError):
        return None
    folder = TMP / "reference"
    folder.mkdir(exist_ok=True)
    modules = {}
    for f in ("club.py", "pose.py"):
        (folder / f).write_bytes(src[f])
        spec = importlib.util.spec_from_file_location(f"reference_{f[:-3]}", folder / f)
        modules[f] = importlib.util.module_from_spec(spec)
        # The old pose.py's `import club` gets the old club.py.
        with mock.patch.dict(sys.modules, {"club": modules.get("club.py", sys.modules["club"])}):
            spec.loader.exec_module(modules[f])
    return modules["pose.py"]


class PipelineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.clips = {}
        for rotation in (0, 90, 180, 270):
            cls.clips[rotation] = TMP / f"clip{rotation}.mp4"
            fakes.clip(cls.clips[rotation], rotation)

    def test_default_output_unchanged(self):
        """With the default backend, byte for byte what pose.py gave before body backends (bar the
        ball search's version stamp)."""
        old = reference_pose()
        if old is None:
            self.skipTest(f"needs git and commit {REFERENCE_COMMIT[:7]}")
        with mock.patch.dict(os.environ, {"SWINGCLIPS_POSE_BACKEND": "", "SWINGCLIPS_CLUB_BACKEND": ""}):
            for rotation in (0, 90):
                new = analyze(pose, self.clips[rotation])
                self.assertNotIn("model", new)
                self.assertTrue(any(f["lm"] for f in new["frames"]))
                # The ball search's version stamp (pose.BALL_VERSION) is the one thing added since.
                self.assertEqual(new.pop("ballVersion"), pose.BALL_VERSION)
                self.assertEqual(json.dumps(new), json.dumps(analyze(old, self.clips[rotation])), rotation)

    @needs_ort
    def test_skipped_frames_filled_in(self):
        """pose.fill_body: points the body model has, on a frame it skipped, halfway between its
        neighbours; not across a gap over 30 ms, nor after the end of its stretch."""
        mp_lm = [(0.9, 0.9, 0.5)] * 33
        def lm(x):
            out = list(mp_lm)
            for i in models.COCO_TO_MP.values():
                out[i] = (x, x, 0.8)
            return out
        frames = [(0.000, lm(0.1)), (0.004, mp_lm), (0.008, lm(0.3)), (0.012, mp_lm), (0.060, lm(0.5)), (0.064, mp_lm)]
        frames = [(t, l, None, None, None) for t, l in frames]
        ran = [True, False, True, False, True, False]
        out = pose.fill_body(frames, ran, "coco17", until=0.05)
        self.assertAlmostEqual(out[1][1][15][0], 0.2)            # wrist between 0.1 and 0.3
        self.assertEqual(out[1][1][19], mp_lm[19])               # index finger: MediaPipe's
        self.assertEqual(out[3][1], mp_lm)                       # 48 ms gap: left as it was
        self.assertEqual(out[5][1], mp_lm)                       # after the stretch

    def test_body_model_output(self):
        """The fake model's points (on the dots) replace MediaPipe's 2D points it has, in every
        rotation; the rest, the 3D estimate and the layout stay MediaPipe's."""
        env = fake_models()
        for rotation, path in self.clips.items():
            with mock.patch.dict(os.environ, {"SWINGCLIPS_POSE_BACKEND": ""}):
                base = analyze(pose, path)
            # On every frame: the test clip's frames are too far apart to fill in skipped ones.
            with mock.patch.dict(os.environ, env), mock.patch.object(pose, "BODY_STRIDE", 1):
                got = analyze(pose, path)
            self.assertEqual(got["model"], "rtmpose-m-256x192")
            self.assertEqual(set(got["msPerFrame"]), {"mediapipe", "body"})
            self.assertEqual(got["rotation"], rotation)
            self.assertEqual(len(got["frames"]), fakes.FRAMES)
            for k, (f, b) in enumerate(zip(got["frames"], base["frames"])):
                self.assertEqual(len(f["lm"]), 33 * 3)
                self.assertEqual(f["w"], b["w"])
                for coco, i in models.COCO_TO_MP.items():
                    x, y = fakes.FEET if fakes.CHANNELS[coco] == fakes.BLUE else fakes.dot_at(k)
                    # Within 4 pixels of the half-size picture pose.py works on (video coding and smoothing).
                    self.assertAlmostEqual(f["lm"][i * 3] * 270, x * 270, delta=4, msg=(rotation, k, i))
                    self.assertAlmostEqual(f["lm"][i * 3 + 1] * 480, y * 480, delta=4, msg=(rotation, k, i))
                for i in set(range(33)) - set(models.COCO_TO_MP.values()):
                    self.assertEqual(f["lm"][i * 3:i * 3 + 3], b["lm"][i * 3:i * 3 + 3], (rotation, k, i))

    def test_missing_model_file(self):
        with mock.patch.dict(os.environ, {"SWINGCLIPS_MODELS": str(TMP / "nothing-here"),
                                          "SWINGCLIPS_POSE_BACKEND": "rtmpose-l"}):
            with self.assertRaises(FileNotFoundError):
                pose.analyze(str(self.clips[0]), fakes.Pool(), 1)

    def test_fingerprint_follows_the_backend(self):
        env = fake_models()
        with mock.patch.dict(os.environ, {"SWINGCLIPS_POSE_BACKEND": ""}):
            default = scorecard.pipeline_fingerprint()
        with mock.patch.dict(os.environ, env):
            body = scorecard.pipeline_fingerprint()
        with mock.patch.dict(os.environ, {**env, "SWINGCLIPS_POSE_BACKEND": "rtmpose-l"}):
            other = scorecard.pipeline_fingerprint()
        self.assertEqual(len({default, body, other}), 3)


@needs_ort
class RerunTest(unittest.TestCase):
    """eval.py --rerun end to end with the fake model: MediaPipe first, then rtmpose-m compared with it."""

    def test_rerun_with_body_model(self):
        root = TMP / "rerun"
        folders = {"CLIPS_DIR": root / "clips", "POSE_DIR": root / "pose", "TRASH_DIR": root / "trash",
                   "LABELS_DIR": root / "labels"}
        for d in folders.values():
            d.mkdir(parents=True, exist_ok=True)
        # Named by the stored size, as phones do: portrait clips are stored landscape and turned on playback.
        name = "swing_face_960x540_60fps_1789123456_400ms.mp4"
        fakes.clip(folders["CLIPS_DIR"] / name, 90)
        ts = [k / fakes.FPS for k in range(fakes.FRAMES)]
        k = 20
        x, y = fakes.dot_at(k)
        joints = {j: {"x": x, "y": y} for j in scorecard.JOINTS}
        label = {"schema": 1, "clip": {"name": name, "angle": "face", "strike": 0.4}, "partner": None,
                 "events": {"takeaway": ts[10], "p4": ts[25], "impact": ts[40]},
                 "frames": {f"{ts[k]:.6f}": joints}}
        (folders["LABELS_DIR"] / f"{name}.json").write_text(json.dumps(label))
        out = root / "eval"
        env = fake_models()

        def run(backend, *extra):
            with mock.patch.multiple(app, **folders), mock.patch.object(scorecard, "ProcessPoolExecutor",
                                                                        lambda n: fakes.Pool()), \
                    fakes.mediapipe(), mock.patch.dict(os.environ, {**env, "SWINGCLIPS_POSE_BACKEND": backend}):
                self.assertEqual(scorecard.main(["--rerun", "--no-noise", "--out", str(out), *extra]), 0)
            return json.loads(max(out.glob("*.json"), key=lambda f: f.stat().st_mtime).read_text())

        with mock.patch("builtins.print"):
            base = run("")
        self.assertEqual(base["bodyModel"], "mediapipe")
        with mock.patch("builtins.print") as printed:
            got = run("rtmpose-m", "--compare")
        text = "\n".join(" ".join(map(str, c.args)) for c in printed.call_args_list)
        self.assertEqual(got["bodyModel"], "rtmpose-m-256x192")
        self.assertIn("Compared with", text)
        self.assertIn("body mediapipe", text)
        self.assertEqual(len(list(out.glob("*_rtmpose-m-256x192.json"))), 1)
        # Separate caches, and the cached pose file says which model made it.
        caches = sorted(p.name for p in (out / "pose").iterdir())
        self.assertEqual(len(caches), 2)
        stamped = [json.loads(gzip.decompress(f.read_bytes())).get("model") for f in (out / "pose").glob("*/*.gz")]
        self.assertEqual(sorted(map(str, stamped)), ["None", "rtmpose-m-256x192"])
        # The fake puts the joints on the red dot, where they're labeled: nearly no error.
        errs = [j["err"] for j in got["clips"][0]["joints"]]
        self.assertTrue(errs and all(e is not None and e < 0.05 for e in errs), errs)
        self.assertTrue(all(j["err"] > 0.05 for j in base["clips"][0]["joints"]))


if __name__ == "__main__":
    unittest.main()
