"""Keeping up during a session: pose.py's speed settings and the faster shaft search and background
in club.py. Where nothing was meant to change, exactly the numbers from before (REFERENCE_COMMIT);
the settings, the gap filling after the swing, the split between workers, the fingerprint, and
bench_models.py's new report and accuracy check. Drawn clips and a fake MediaPipe (fakes.py), and
the real fixtures' pose files for what the numbers read.

  cd server && python -m unittest tests.test_speed
"""
import contextlib
import copy
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import av
import cv2
import numpy as np

HERE = Path(__file__).parent
REAL = HERE / "fixtures" / "real"
TMP = Path(tempfile.mkdtemp(prefix="swingclips-speed-test-"))
os.environ.setdefault("SWINGCLIPS_CLIPS", str(TMP / "clips"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import app  # noqa: E402
import bench_models  # noqa: E402
import club  # noqa: E402
import eval as scorecard  # noqa: E402
import fakes  # noqa: E402
import models  # noqa: E402
import pose  # noqa: E402
import swings  # noqa: E402

try:
    import onnxruntime  # noqa: F401
except ImportError:
    onnxruntime = None
needs_ort = unittest.skipIf(onnxruntime is None, "needs onnxruntime (pip install -r requirements.txt)")

# pose.py, club.py and models.py before the speed settings: with them as before, exactly this output.
REFERENCE_COMMIT = "b9b3b1b33992c47e84570235dbe6846ac43021c7"
NO_MODELS = {"SWINGCLIPS_POSE_BACKEND": "", "SWINGCLIPS_CLUB_BACKEND": "", "SWINGCLIPS_ORT_PROVIDER": "",
             "SWINGCLIPS_DECODE_THREADS": ""}
MODELS = TMP / "models"
# A drawn clip whose name has the strike at 0.2 s; with BODY_AFTER_STRIKE at 0.2 (patched), the swing
# ends 0.4 s in, half way through the 0.8 s clip.
STRIKE_CLIP = "swing_face_540x960_60fps_1789123456_200ms.mp4"
AFTER = 0.2


def reference():
    """pose.py (with its club.py and models.py) from REFERENCE_COMMIT as a module, or None without git."""
    root = HERE.parent.parent
    try:
        src = {f: subprocess.run(["git", "-C", str(root), "show", f"{REFERENCE_COMMIT}:server/{f}"],
                                 capture_output=True, check=True).stdout for f in ("club.py", "models.py", "pose.py")}
    except (OSError, subprocess.CalledProcessError):
        return None
    folder = TMP / "reference"
    folder.mkdir(exist_ok=True)
    loaded = {}
    for f in ("club.py", "models.py", "pose.py"):
        (folder / f).write_bytes(src[f])
        spec = importlib.util.spec_from_file_location(f"speed_reference_{f[:-3]}", folder / f)
        loaded[f[:-3]] = importlib.util.module_from_spec(spec)
        with mock.patch.dict(sys.modules, {k: v for k, v in loaded.items() if k != f[:-3]}):
            spec.loader.exec_module(loaded[f[:-3]])
    return loaded


def fake_models() -> dict:
    MODELS.mkdir(parents=True, exist_ok=True)
    fakes.simcc_model(MODELS / models.SPECS["rtmpose-m"].file, *models.SPECS["rtmpose-m"].size, fakes.CHANNELS)
    return {"SWINGCLIPS_MODELS": str(MODELS), "SWINGCLIPS_POSE_BACKEND": "rtmpose-m"}


def analyze(module, path, timing=None, **kw) -> dict:
    """module.analyze on a clip in this process, with the fake MediaPipe; without the time it took."""
    with fakes.mediapipe(), mock.patch("builtins.print"), contextlib.redirect_stderr(io.StringIO()):
        out = module.analyze(str(path), fakes.Pool(), 2, *([timing] if timing is not None else []), **kw)
    out.pop("seconds")
    out.pop("msPerFrame", None)
    # The ball search's version stamp moves on by itself (BALL_VERSION); the ball it finds is compared.
    out.pop("ballVersion", None)
    return out


class ExactTest(unittest.TestCase):
    """The faster ways give exactly the old numbers."""

    def test_median_is_numpys(self):
        rng = np.random.default_rng(1)
        for n in (1, 2, 5, 16, 17):
            frames = list(rng.integers(0, 256, (n, 37, 23, 3), dtype=np.uint8))
            want = np.median(np.stack(frames), axis=0).astype(np.uint8)
            self.assertTrue(np.array_equal(club.median(frames), want), n)
        # Values at the ends of the range, and all the same.
        frames = [np.full((4, 4), v, np.uint8) for v in (0, 255, 255, 0, 255)]
        self.assertTrue(np.array_equal(club.median(frames), np.full((4, 4), 255, np.uint8)))

    def test_scores_as_before(self):
        ref = reference()
        if ref is None:
            self.skipTest(f"needs git and commit {REFERENCE_COMMIT[:7]}")
        rng = np.random.default_rng(2)
        h, w = 480, 270
        bg = rng.integers(0, 256, (h, w, 3), dtype=np.uint8)
        checked = 0
        for k in range(30):
            img = bg.copy()
            # A bright line from the hands, and noise.
            cv2.line(img, (135, 240), (int(135 + 150 * np.cos(k)), int(240 + 150 * np.sin(k))), (250, 250, 250), 2)
            img = cv2.add(img, rng.integers(0, 30, img.shape, dtype=np.uint8))
            lm = [(float(x), float(y), 0.9) for x, y in rng.uniform(0.3, 0.7, (33, 2))]
            lm[0] = (0.5, float(rng.uniform(0.05, 0.3)), 0.9)
            for i in club.FEET:
                lm[i] = (0.5, float(rng.uniform(0.7, 1.0)), 0.9)
            if k % 5 == 0:
                lm[19], lm[20] = (0.02, 0.02, 0.9), (0.01, 0.03, 0.9)      # hands at the corner
            mask = rng.random((h, w)) > 0.7
            a, b = ref["club"].scores(img, lm, mask, bg), club.scores(img, lm, mask, bg)
            self.assertEqual(a is None, b is None)
            if a is not None:
                self.assertTrue(np.array_equal(a, b), k)
                checked += 1
        self.assertGreater(checked, 20)

    def test_upright_crop(self):
        rng = np.random.default_rng(3)
        stored = rng.integers(0, 256, (48, 30, 3), dtype=np.uint8)
        for rotation in (0, 90, 180, 270):
            upright = cv2.rotate(stored, pose.ROTATE_CW[rotation]) if rotation else stored
            h, w = upright.shape[:2]
            for _ in range(20):
                x0, x1 = sorted(rng.integers(0, w + 1, 2))
                y0, y1 = sorted(rng.integers(0, h + 1, 2))
                if x1 == x0 or y1 == y0:
                    continue
                got = pose.upright_crop(stored, rotation, (x0, y0, x1, y1))
                self.assertTrue(np.array_equal(got, upright[y0:y1, x0:x1]), (rotation, x0, y0, x1, y1))

    def test_grown_mask(self):
        """Scaled up and grown only around the box: the same as the whole mask done so."""
        rng = np.random.default_rng(4)
        for (mh, mw), (h, w) in (((48, 27), (96, 54)), ((48, 27), (100, 61)), ((37, 50), (37, 50)),
                                 ((960, 540), (1920, 1080))):
            person = cv2.GaussianBlur(rng.random((mh, mw)).astype(np.float32), (5, 5), 0)
            for grow in (3, 4, 9):
                whole = cv2.resize((person > 0.5).astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST)
                whole = cv2.dilate(whole, np.ones((grow, grow), np.uint8)) > 0
                for _ in range(8):
                    x0, x1 = sorted(rng.integers(0, w + 1, 2))
                    y0, y1 = sorted(rng.integers(0, h + 1, 2))
                    if x1 == x0 or y1 == y0:
                        continue
                    got = pose.grown_mask(person, w, h, (x0, y0, x1, y1), grow)
                    self.assertTrue(np.array_equal(got, whole[y0:y1, x0:x1]), (h, w, grow, x0, y0, x1, y1))

    def test_pipeline_as_before(self):
        """The speed settings as before: the pose file exactly as the code before them gave it, in
        every rotation, with and without a body model on every other frame and a strike in the clip."""
        ref = reference()
        if ref is None:
            self.skipTest(f"needs git and commit {REFERENCE_COMMIT[:7]}")
        cases = [({}, "clip{}.mp4"), ({}, STRIKE_CLIP)]
        if onnxruntime is not None:
            cases.append((fake_models(), STRIKE_CLIP))
        for extra, name in cases:
            for rotation in (0, 90, 180, 270):
                path = TMP / "before" / str(rotation) / name.format(rotation)
                path.parent.mkdir(parents=True, exist_ok=True)
                if not path.is_file():
                    fakes.clip(path, rotation)
                env = {**NO_MODELS, **pose.SPEED_AS_BEFORE, **extra}
                with mock.patch.dict(os.environ, env), mock.patch.object(pose, "BODY_AFTER_STRIKE", AFTER), \
                        mock.patch.object(ref["pose"], "BODY_AFTER_STRIKE", AFTER), \
                        mock.patch.object(pose, "BODY_STRIDE", 2), mock.patch.object(ref["pose"], "BODY_STRIDE", 2):
                    before, now = analyze(ref["pose"], path), analyze(pose, path)
                self.assertNotIn("speed", now)
                self.assertTrue(any(f["club"] for f in now["frames"]))
                self.assertEqual(json.dumps(now), json.dumps(before), (extra, name, rotation))


class SettingsTest(unittest.TestCase):
    def test_defaults_and_values(self):
        with mock.patch.dict(os.environ, {k: "" for k in pose.SPEED_AS_BEFORE}):
            self.assertEqual(pose.speed_settings(), {"mpStrideAfter": pose.MP_STRIDE_AFTER, "convert": "full",
                                                     "split": "cost", "shaftStride": 1})
        with mock.patch.dict(os.environ, pose.SPEED_AS_BEFORE):
            self.assertEqual(pose.speed_settings(), pose.BEFORE)
        with mock.patch.dict(os.environ, {"SWINGCLIPS_MP_STRIDE_AFTER": " 8 ", "SWINGCLIPS_FRAME_CONVERT": "FULL",
                                          "SWINGCLIPS_SHAFT_STRIDE": "2"}):
            self.assertEqual(pose.mp_stride_after(), 8)
            self.assertEqual(pose.frame_convert(), "full")
            self.assertEqual(pose.shaft_stride(), 2)
        for key, bad in (("SWINGCLIPS_MP_STRIDE_AFTER", "0"), ("SWINGCLIPS_SHAFT_STRIDE", "two"),
                         ("SWINGCLIPS_FRAME_CONVERT", "gray"), ("SWINGCLIPS_POSE_SPLIT", "random"),
                         ("SWINGCLIPS_DECODE_THREADS", "-1")):
            with mock.patch.dict(os.environ, {key: bad}), self.assertRaises(ValueError, msg=key):
                pose.speed_settings()
                pose.decode_threads()
        with mock.patch.dict(os.environ, {"SWINGCLIPS_DECODE_THREADS": ""}):
            self.assertIsNone(pose.decode_threads())
        with mock.patch.dict(os.environ, {"SWINGCLIPS_DECODE_THREADS": "2"}):
            self.assertEqual(pose.decode_threads(), 2)

    def test_fingerprint(self):
        """Each setting that can change the result gives eval.py's reruns their own cache; the decoding
        threads don't (decoding is exact)."""
        base = {**NO_MODELS, **{k: "" for k in pose.SPEED_AS_BEFORE}}
        with mock.patch.dict(os.environ, base):
            default = scorecard.pipeline_fingerprint()
        seen = {default}
        for key, value in (("SWINGCLIPS_MP_STRIDE_AFTER", "1"), ("SWINGCLIPS_MP_STRIDE_AFTER", "8"),
                           ("SWINGCLIPS_FRAME_CONVERT", "planes"), ("SWINGCLIPS_POSE_SPLIT", "even"),
                           ("SWINGCLIPS_POSE_SPLIT", "frames"), ("SWINGCLIPS_SHAFT_STRIDE", "2")):
            with mock.patch.dict(os.environ, {**base, key: value}):
                seen.add(scorecard.pipeline_fingerprint())
        # The quick pass (eval.py --quick) too.
        with mock.patch.dict(os.environ, {**base, "SWINGCLIPS_QUICK": "", "SWINGCLIPS_QUICK_MP_STRIDE": ""}),                 mock.patch.object(scorecard, "QUICK", True),                 mock.patch.object(pose, "deep_profile", return_value={"bodyStride": 1, "clubModel": None}):
            seen.add(scorecard.pipeline_fingerprint())
        self.assertEqual(len(seen), 8)
        # Set to what it is by default: the same cache.
        with mock.patch.dict(os.environ, {**base, "SWINGCLIPS_SHAFT_STRIDE": "1", "SWINGCLIPS_POSE_SPLIT": "cost"}):
            self.assertEqual(scorecard.pipeline_fingerprint(), default)
        with mock.patch.dict(os.environ, {**base, "SWINGCLIPS_DECODE_THREADS": "3"}):
            self.assertEqual(scorecard.pipeline_fingerprint(), default)


class FillTest(unittest.TestCase):
    def test_fill_skipped(self):
        def lm(x):
            return [(x, 2 * x, 0.5)] * 33
        rows = [(0.00, lm(0.1)), (0.01, None), (0.02, None), (0.03, lm(0.4)), (0.04, None), (0.05, None),
                (0.06, None), (0.07, None), (0.08, None), (0.09, lm(0.9)), (0.10, None), (0.11, None),
                (0.12, None), (0.13, None), (0.14, None)]
        frames = [(t, l, None if l is None else [(1.0, 2.0, 3.0)] * 33, None, None) for t, l in rows]
        mp_ran = [True, False, False, True, False, False, False, False, False, True, False, False, False, False, False]
        out = pose.fill_skipped(frames, mp_ran, most=3)
        self.assertAlmostEqual(out[1][1][15][0], 0.2)                 # a third of the way
        self.assertAlmostEqual(out[2][1][15][1], 0.6)
        self.assertEqual(out[1][2][0], (1.0, 2.0, 3.0))               # the world landmarks too
        self.assertTrue(all(out[i][1] is None for i in range(4, 9)))  # 6 frames apart: more than 3
        self.assertEqual(out[10][1], out[9][1])                       # after the last one, held
        self.assertEqual(out[11][1], out[9][1])
        self.assertIsNone(out[12][1])                                 # for the `most` - 1 frames it skips
        # A frame where MediaPipe ran and found no one isn't filled from, nor into.
        frames[3] = (0.03, None, None, None, None)
        out = pose.fill_skipped(frames, mp_ran, most=3)
        self.assertIsNone(out[1][1])
        self.assertEqual(out[3][1], None)


class QuickProfileTest(unittest.TestCase):
    def test_only_when_a_deep_pass_follows(self):
        deep = {"bodyStride": 1, "clubModel": None, "rayTakeaway": True}
        with mock.patch.object(pose, "deep_profile", return_value=deep):
            with mock.patch.dict(os.environ, {"SWINGCLIPS_QUICK": "", "SWINGCLIPS_QUICK_MP_STRIDE": ""}):
                self.assertEqual(pose.quick_profile(), {"mpStrideSwing": 2})
            with mock.patch.dict(os.environ, {"SWINGCLIPS_QUICK": "off", "SWINGCLIPS_QUICK_MP_STRIDE": ""}):
                self.assertIsNone(pose.quick_profile())
            with mock.patch.dict(os.environ, {"SWINGCLIPS_QUICK": "", "SWINGCLIPS_QUICK_MP_STRIDE": "1"}):
                self.assertIsNone(pose.quick_profile())
            with mock.patch.dict(os.environ, {"SWINGCLIPS_QUICK": "", "SWINGCLIPS_QUICK_MP_STRIDE": "3"}):
                self.assertEqual(pose.quick_profile(), {"mpStrideSwing": 3})
        with mock.patch.object(pose, "deep_profile", return_value=None), \
                mock.patch.dict(os.environ, {"SWINGCLIPS_QUICK": "", "SWINGCLIPS_QUICK_MP_STRIDE": ""}):
            self.assertIsNone(pose.quick_profile())


class SplitTest(unittest.TestCase):
    @staticmethod
    def spent(runs, pts, costs, keys, lead):
        """Each run's cost, with the frames it decodes and drops from the keyframe before its start."""
        out = []
        for a, b in runs:
            k = max(x for x in keys if x <= a)
            dropped = sum(1 for p in pts if k <= p < a)
            out.append(dropped * lead + sum(c for p, c in zip(pts, costs) if a <= p and (b is None or p < b)))
        return out

    def test_frames_cut_between_keyframes(self):
        """SWINGCLIPS_POSE_SPLIT=frames: cut at any frame, so the runs come out closer than keyframes allow."""
        keys = list(range(0, 100, 10))
        pts = list(range(100))
        costs = [4.0] * 60 + [1.0] * 40            # 280 in all: 70 a run for 4 workers
        runs = pose.split_frames(keys, pts, costs, 4, lead=0.5)
        self.assertEqual(len(runs), 4)
        self.assertEqual(runs[0][0], 0)
        self.assertIsNone(runs[-1][1])
        for (_, end), (start, _) in zip(runs, runs[1:]):
            self.assertEqual(end, start)
        got = self.spent(runs, pts, costs, keys, 0.5)
        self.assertLessEqual(max(got), 74)
        self.assertLess(max(got), max(self.spent(pose.split_jobs(keys, pts, costs, 4), pts, costs, keys, 0.5)))

    def test_frames_dropping_counts(self):
        """When dropping frames costs more than it evens out, the cuts stay on keyframes."""
        keys = [0, 10, 20, 30]
        pts = list(range(40))
        self.assertEqual(pose.split_frames(keys, pts, [1.0] * 40, 4, lead=100), [(0, 10), (10, 20), (20, 30), (30, None)])
        self.assertEqual(pose.split_frames(keys, pts, [1.0] * 40, 1), [(0, None)])
        # Fewer frames than workers: a frame each at most.
        self.assertEqual(len(pose.split_frames([0], [0, 1, 2], [1.0] * 3, 8, lead=0)), 3)

    def test_even_costs(self):
        keys = [0, 10, 20, 30]
        pts = list(range(40))
        self.assertEqual(pose.split_jobs(keys, pts, [1.0] * 40, 2), [(0, 20), (20, None)])
        self.assertEqual(pose.split_jobs(keys, pts, [1.0] * 40, 8), [(0, 10), (10, 20), (20, 30), (30, None)])
        self.assertEqual(pose.split_jobs(keys, pts, [1.0] * 40, 1), [(0, None)])

    def test_balanced(self):
        """The cheap end of a clip goes to fewer workers: the largest run as small as it can be."""
        keys = list(range(0, 100, 10))
        pts = list(range(100))
        costs = [4.0] * 60 + [1.0] * 40
        runs = pose.split_jobs(keys, pts, costs, 4)
        self.assertEqual(runs[0][0], 0)
        self.assertIsNone(runs[-1][1])
        for (_, end), (start, _) in zip(runs, runs[1:]):
            self.assertEqual(end, start)
        spent = [sum(c for p, c in zip(pts, costs) if a <= p and (b is None or p < b)) for a, b in runs]
        self.assertEqual(max(spent), 80)       # 280 in all: 70 would need a cut inside a keyframe's run
        even = [sum(costs[i * 25:(i + 1) * 25]) for i in range(4)]
        self.assertGreater(max(even), max(spent))

    def test_costs(self):
        tb = 1 / 100
        pts = list(range(100))                  # 1 s at 100 fps; the swing ends at 0.5 s
        mp = pose.job_costs(pts, tb, 0.5, 4, 1, 1, None, None, True)
        self.assertEqual(mp[0], pose.COST_MS["decode"] + pose.COST_MS["mediapipe"] + pose.COST_MS["shaft"])
        self.assertEqual(mp[52], pose.COST_MS["decode"] + pose.COST_MS["mediapipe"])     # 52 % 4 == 0
        self.assertEqual(mp[53], pose.COST_MS["decode"])
        body = pose.job_costs(pts, tb, 0.5, 1, 2, 2, ("rtmpose-m", "x"), None, True)
        self.assertAlmostEqual(body[0] - mp[0], pose.COST_MS["body"] / 2 - pose.COST_MS["shaft"] / 2)
        self.assertEqual(pose.job_costs(pts, tb, None, 4, 1, 1, None, None, True)[90], mp[0])


class PipelineTest(unittest.TestCase):
    """The settings through pose.analyze on a drawn clip with a strike, the fake MediaPipe."""

    @classmethod
    def setUpClass(cls):
        cls.path = TMP / "strike" / STRIKE_CLIP
        cls.path.parent.mkdir(parents=True, exist_ok=True)
        fakes.clip(cls.path, 90)

    def run_it(self, timing=None, **env):
        with mock.patch.dict(os.environ, {**NO_MODELS, **env}), mock.patch.object(pose, "BODY_AFTER_STRIKE", AFTER):
            return analyze(pose, self.path, timing)

    def test_mediapipe_every_nth_after_the_swing(self):
        ran = []
        real = fakes._Landmarker.detect_for_video
        with mock.patch.object(fakes._Landmarker, "detect_for_video",
                               lambda self, image, ms: ran.append(ms) or real(self, image, ms)):
            got = self.run_it(**{**pose.SPEED_AS_BEFORE, "SWINGCLIPS_MP_STRIDE_AFTER": "4"})
        before = self.run_it(**pose.SPEED_AS_BEFORE)
        until = 0.2 + AFTER
        times = [f["t"] for f in got["frames"]]
        after = [t for t in times if t > until]
        self.assertEqual(len(times), fakes.FRAMES)
        self.assertEqual(len([t for t in times if t <= until]), len([ms for ms in ran if ms <= until * 1000]))
        self.assertLess(len([ms for ms in ran if ms > until * 1000]), len(after) / 3)
        self.assertEqual(got["speed"]["mpStrideAfter"], 4)
        # Every frame still has the golfer, near where MediaPipe on every frame put them.
        for f, b in zip(got["frames"], before["frames"]):
            self.assertIsNotNone(f["lm"], f["t"])
            self.assertIsNotNone(f["w"], f["t"])
            err = max(abs(x - y) for x, y in zip(f["lm"][:66:3], b["lm"][:66:3]))
            self.assertLess(err, 0.02, f["t"])
            if f["t"] <= until - 0.05:
                self.assertEqual(f["lm"], b["lm"], f["t"])         # the swing untouched

    def test_half_size_picture(self):
        """SWINGCLIPS_FRAME_CONVERT=planes: within ~1 level of halving the full-size RGB."""
        with av.open(str(self.path)) as c:
            for k, frame in enumerate(c.decode(video=0)):
                yuv = frame.to_ndarray(format="yuv420p")
                full = cv2.cvtColor(yuv, cv2.COLOR_YUV2RGB_I420)
                want = cv2.resize(full, None, fx=pose.SCALE, fy=pose.SCALE, interpolation=cv2.INTER_AREA)
                got = pose.half_rgb(yuv)
                self.assertEqual(got.shape, want.shape)
                diff = np.abs(got.astype(int) - want)
                self.assertLess(diff.mean(), 1.0, k)
                self.assertLessEqual(np.percentile(diff, 99), 3, k)
                if k == 5:
                    break

    def test_defaults(self):
        """The defaults: close to before, and the pose file says how it was made."""
        got = self.run_it(**{k: "" for k in pose.SPEED_AS_BEFORE})
        before = self.run_it(**pose.SPEED_AS_BEFORE)
        self.assertEqual(got["speed"], {"mpStrideAfter": 4, "convert": "full", "split": "cost", "shaftStride": 1})
        for f, b in zip(got["frames"], before["frames"]):
            self.assertLess(max(abs(x - y) for x, y in zip(f["lm"][:66:3], b["lm"][:66:3])), 0.02, f["t"])

    def test_quick_pass(self):
        """The quick pass (during a session): MediaPipe and the shaft on every other frame in the swing,
        the rest filled in; every frame still has the golfer, near where every frame put them."""
        ran = []
        real = fakes._Landmarker.detect_for_video
        with mock.patch.dict(os.environ, NO_MODELS), mock.patch.object(pose, "BODY_AFTER_STRIKE", AFTER), \
                mock.patch.object(fakes._Landmarker, "detect_for_video",
                                  lambda self, image, ms: ran.append(ms) or real(self, image, ms)):
            got = analyze(pose, self.path, quick={"mpStrideSwing": 2})
        full = self.run_it()
        until = 0.2 + AFTER
        in_swing = [f["t"] for f in got["frames"] if f["t"] <= until]
        self.assertEqual(got["pass"], "quick")
        self.assertEqual(got["quick"], {"mpStrideSwing": 2})
        self.assertLess(len([ms for ms in ran if ms <= until * 1000]), len(in_swing) * 0.6)
        for f, b in zip(got["frames"], full["frames"]):
            self.assertIsNotNone(f["lm"], f["t"])
            err = max(abs(x - y) for x, y in zip(f["lm"][:66:3], b["lm"][:66:3]))
            self.assertLess(err, 0.02, f["t"])
        # With the deep pass, no quick.
        with mock.patch.dict(os.environ, NO_MODELS):
            deep = analyze(pose, self.path, deep={"bodyStride": 1, "clubModel": None}, quick={"mpStrideSwing": 2})
        self.assertEqual(deep["pass"], "deep")

    def test_decode_threads_change_nothing(self):
        one = self.run_it(SWINGCLIPS_DECODE_THREADS="1")
        self.assertEqual(json.dumps(self.run_it(SWINGCLIPS_DECODE_THREADS="3")), json.dumps(one))

    def test_timing(self):
        t = {}
        self.run_it(t, SWINGCLIPS_SHAFT_STRIDE="2")
        self.assertEqual(t["frames"], fakes.FRAMES)
        self.assertEqual(t["decode"]["frames"], fakes.FRAMES)
        self.assertLess(t["mediapipe"]["frames"], fakes.FRAMES)
        # The shaft on every other frame of the swing (each worker counts from its own first frame).
        swing = sum(1 for k in range(fakes.FRAMES) if k / fakes.FPS <= 0.2 + AFTER)
        self.assertLessEqual(t["shaft"]["frames"], swing // 2 + t["jobs"])
        self.assertTrue({"background", "workers", "ball", "smooth", "track"} <= set(t["stages"]))
        self.assertEqual(len(t["workerSeconds"]), t["jobs"])


def thinned(inp: dict, stride: int) -> dict:
    """A pose input with MediaPipe's frames after the swing kept only every `stride`-th, the rest
    filled in as pose.fill_skipped does."""
    inp = copy.deepcopy(inp)
    until = inp["strike"] + pose.BODY_AFTER_STRIKE
    frames = inp["frames"]
    rows = [(f["t"], None if f["lm"] is None else [tuple(f["lm"][i:i + 3]) for i in range(0, 99, 3)],
             None if f["w"] is None else [tuple(f["w"][i:i + 3]) for i in range(0, 99, 3)], None, None) for f in frames]
    ran = [f["t"] <= until or k % stride == 0 for k, f in enumerate(frames)]
    rows = pose.fill_skipped([r if ok else (r[0], None, None, None, None) for r, ok in zip(rows, ran)], ran, stride)
    for f, r in zip(frames, rows):
        f["lm"] = None if r[1] is None else [v for p in r[1] for v in p]
        f["w"] = None if r[2] is None else [v for p in r[2] for v in p]
    return inp


@unittest.skipUnless((REAL / "pose-rtmpose-m").is_dir(), "no real fixtures")
class AfterTheSwingTest(unittest.TestCase):
    """Nothing the page or the server measures reads MediaPipe after the swing: on the real swings,
    with only every 4th frame there kept (and the rest filled), every number summary.js works out
    (body numbers, noise floor, setup, camera check, key positions) is the same."""

    def test_numbers_unchanged(self):
        clips = {c["name"]: c for c in json.loads((REAL / "clips.json").read_text(encoding="utf-8"))}
        js = swings.Summarizer(HERE.parent / "static")
        checked = 0
        try:
            for f in sorted((REAL / "pose-rtmpose-m").glob("*.json.gz")):
                clip = clips.get(f.name.split(".v")[0])
                if clip is None or clip.get("strike") is None:
                    continue
                inp = swings.pose_input(clip, f)
                thin = thinned(inp, pose.MP_STRIDE_AFTER)
                self.assertNotEqual(thin["frames"], inp["frames"])
                for call in ("summarize", "positionTimes"):
                    self.assertEqual(js.call(call, thin, None, swings.LEAD_SIDE), js.call(call, inp, None, swings.LEAD_SIDE),
                                     (call, clip["name"]))
                checked += 1
        finally:
            js.close()
        self.assertGreater(checked, 20)


class BenchTest(unittest.TestCase):
    def run_result(self, label, seconds, **speed):
        return {"label": label, "where": "cpu", "stride": 2, "default": True, "seconds": seconds, "split": {},
                "provider": "cpu", "workers": 6, "threads": None,
                "speed": {**pose.BEFORE, **speed},
                "timing": {"frames": 980, "jobs": 6, "workerSeconds": [9.5, 10.2], "start": 2.4,
                           "decode": {"ms": 7.0, "frames": 980, "seconds": 6.9},
                           "mediapipe": {"ms": 21.0, "frames": 800, "seconds": 16.8},
                           "shaft": {"ms": 8.1, "frames": 700, "seconds": 5.7},
                           "stages": {"background": 0.9, "workers": 10.5, "ball": 0.7, "smooth": 0.3, "track": 0.2}}}

    def test_verdict(self):
        result = {"clip": "c.mp4", "workers": 6, "backend": "rtmpose-m", "providers": ["cpu"], "gpus": {},
                  "models": {}, "diffs": {}, "clip_diffs": {}, "floor": 8.8, "clip_runs": [],
                  "speed_runs": [self.run_result("as before", 20.4),
                                 self.run_result("as set now", 11.9, mpStrideAfter=4, convert="planes", split="cost"),
                                 self.run_result("as set now, 8 workers", 11.2, mpStrideAfter=4, convert="planes",
                                                 split="cost")]}
        result["speed_runs"][2]["workers"] = 8
        result["clip_runs"].append({k: result["speed_runs"][1][k] for k in ("where", "stride", "default", "seconds",
                                                                            "split", "provider")})
        lines = "\n".join(bench_models.verdict(result))
        self.assertIn("Keeping up, whole clip on the CPU (rtmpose-m every 2 frames, 6 worker(s)): 20.4 s with the "
                      "speed settings as before -> 11.9 s as set now (MediaPipe after the swing every 4 frames, "
                      "picture planes, split by cost, shaft every frame, decoding FFmpeg's own threads)", lines)
        self.assertIn("as before: ms a frame in each worker (frames it ran on, of 980): decode 7.0 (980), "
                      "MediaPipe 21.0 (800), shaft 8.1 (700)", lines)
        self.assertIn("6 worker(s) busy 9.5-10.2 s of the 10.5 s they took (loading MediaPipe 2.4 s in all)", lines)
        self.assertIn("outside the workers: empty scene 0.9 s, ball search 0.7 s, smoothing 0.3 s, shaft tracking 0.2 s",
                      lines)
        self.assertIn("as set now, 8 workers: 11.2 s", lines)
        self.assertIn("): no, best 11.2 s (CPU, every 2 frames, as set now, 8 workers)", lines)
        self.assertIn("Fastest: as set now, 8 workers", lines)
        self.assertIn("Floor, no body model at all: 8.8 s", lines)

    def test_verdict_quick(self):
        """The quick pass (during a session) gets its own line, and isn't offered for settings.cmd."""
        result = {"clip": "c.mp4", "workers": 8, "backend": "rtmpose-m", "providers": ["cpu"], "gpus": {},
                  "models": {}, "diffs": {}, "clip_diffs": {}, "floor": 8.8, "clip_runs": [],
                  "speed_runs": [self.run_result("as before", 17.4),
                                 self.run_result("as set now", 13.6, mpStrideAfter=4, split="cost"),
                                 self.run_result(bench_models.QUICK_LABEL, 9.1, mpStrideAfter=4, split="cost")]}
        lines = "\n".join(bench_models.verdict(result))
        self.assertIn("During a session (the quick pass; the deep pass redoes each clip after it): 9.1 s a clip, "
                      "keeps up", lines)
        self.assertIn("): yes, best 9.1 s", lines)
        self.assertNotIn("Fastest:", lines)

    def scorecard(self, key_ms, joint, found, club_deg, pred_shift=0.0):
        events = [{"angle": "face", "event": e, "labeled": 10, "missed": 0, "median": key_ms}
                  for e in ("takeaway", "p4", "ball gone")]
        return {"labeledClips": 10,
                "tables": {"events": events,
                           "joints": [{"angle": "face", "joints": "wrists", "phase": "downswing", "median": joint}],
                           "ball": [{"angle": "face", "found": 100.0}],
                           "club": [{"angle": "face", "phase": "all", "found": found, "median": club_deg}]},
                "clips": [{"clip": "a", "events": [{"event": "p4", "pred": 1.0 + pred_shift}]}]}

    def tuned(self, ms):
        return {"tuning": {"takeawayDegrees": 1}, "loso": {"pose-rtmpose-m": [
            {"event": "p4", "angle": "face", "ms": ms}, {"event": "p4", "angle": "face", "ms": -ms}]}}

    def test_accuracy_verdict(self):
        before = self.scorecard(10.0, 1.7, 90.0, 3.0)
        ok = bench_models.accuracy_verdict(before, self.scorecard(12.0, 1.75, 89.0, 3.2, 0.002),
                                           {"median": 0.4, "p90": 2.0, "n": 1000},
                                           {"before": self.tuned(8.0), "now": self.tuned(9.0)}, "x")
        text = "\n".join(ok)
        self.assertIn("No worse: yes", text)
        self.assertIn("Found within a frame of before's: 100% of 1", text)
        self.assertIn("Joints moved 0.40 px", text)
        self.assertIn("tune_positions.py picks the same tuning both ways", text)
        bad = "\n".join(bench_models.accuracy_verdict(before, self.scorecard(15.0, 1.7, 85.0, 4.0, 0.01),
                                                      {"median": 1.4, "p90": 5.0, "n": 1000},
                                                      {"before": self.tuned(8.0), "now": self.tuned(14.0)}))
        self.assertIn("No worse: NO", bad)
        for why in ("p4 (face): median error 10.0 -> 15.0 ms", "joints moved 1.40 px", "shaft (face) found 90% -> 85%",
                    "shaft (face) angle error 3.0 -> 4.0 degrees", "p4 (face) left out of the tuning"):
            self.assertIn(why, bad)
        self.assertIn("Found within a frame of before's: 0% of 1", bad)

    def test_label_clips(self):
        labels = {"a": {"clip": {"name": "a", "angle": "face", "strike": 2.0},
                        "partner": {"name": "b", "angle": "dtl", "strike": 2.1}},
                  "c": {"clip": {"name": "c", "angle": "face", "strike": 2.0},
                        "partner": {"name": "d", "angle": "dtl", "strike": 2.1}}}
        got = {c["name"]: c for c in bench_models.label_clips(labels, {"a", "b", "c"})}
        self.assertEqual(got["a"]["partner"], "b")
        self.assertEqual(got["b"]["partner"], "a")
        self.assertIsNone(got["c"]["partner"])                  # d wasn't analyzed
        self.assertNotIn("d", got)
        self.assertEqual(bench_models.picture_size("swing_face_1920x1080_240fps_1_2000ms.mp4", 90), (1080, 1920))

    def test_accuracy_end_to_end(self):
        """--accuracy on a labeled drawn clip: both reruns, tune_positions.py on both, and the verdict."""
        root = TMP / "accuracy"
        folders = {"CLIPS_DIR": root / "clips", "POSE_DIR": root / "pose", "TRASH_DIR": root / "trash",
                   "LABELS_DIR": root / "labels"}
        for d in folders.values():
            d.mkdir(parents=True, exist_ok=True)
        name = "swing_face_960x540_60fps_1789123456_200ms.mp4"
        fakes.clip(folders["CLIPS_DIR"] / name, 90)
        ts = [k / fakes.FPS for k in range(fakes.FRAMES)]
        x, y = fakes.dot_at(20)
        label = {"schema": 1, "clip": {"name": name, "angle": "face", "strike": 0.2}, "partner": None,
                 "events": {"takeaway": ts[5], "p4": ts[12], "impact": ts[16]},
                 "frames": {f"{ts[20]:.6f}": {j: {"x": x, "y": y} for j in scorecard.JOINTS}}}
        (folders["LABELS_DIR"] / f"{name}.json").write_text(json.dumps(label))
        out = io.StringIO()
        with mock.patch.multiple(app, **folders), mock.patch.object(scorecard, "EVAL_DIR", root / "eval"), \
                mock.patch.object(scorecard, "ProcessPoolExecutor", lambda n: fakes.Pool()), \
                mock.patch.object(pose, "BODY_AFTER_STRIKE", AFTER), fakes.mediapipe(), \
                mock.patch.dict(os.environ, {**NO_MODELS, **{k: "" for k in pose.SPEED_AS_BEFORE}}), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(bench_models.main(["--accuracy"]), 0)
        text = out.getvalue()
        self.assertIn("the speed settings as before", text)
        self.assertIn("-- now --", text)
        verdict = text[text.index("Accuracy of the speed settings"):]
        self.assertIn("No worse:", verdict)
        self.assertEqual(len(list((root / "eval" / "pose").iterdir())), 2)      # cached apart


if __name__ == "__main__":
    unittest.main()
