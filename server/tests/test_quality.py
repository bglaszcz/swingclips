"""Clip quality (quality.py) on made-up videos: a flickering one, a dark grainy one, and a bar moving
at the hands, sharp or motion-blurred in the downswing. Plus the server's worker on a synthetic swing,
and the scorecard's grouping by shutter, with and without camera.json.

  cd server && python -m unittest discover tests
"""
import gzip
import json
import os
import random
import sys
import tempfile
import unittest
from concurrent.futures import ProcessPoolExecutor
from fractions import Fraction
from pathlib import Path

import av
import cv2
import numpy as np

HERE = Path(__file__).parent
TMP = Path(tempfile.mkdtemp(prefix="swingclips-quality-"))
os.environ.setdefault("SWINGCLIPS_CLIPS", str(TMP / "clips"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import app  # noqa: E402
import eval as scorecard  # noqa: E402
import quality  # noqa: E402
import synthetic  # noqa: E402

W, H = 320, 180
ASPECT = W / H


def times_of(seconds, fps=240, drop=0.1, seed=3):
    """Frame times with some dropped, the way phones drop them."""
    rng = random.Random(seed)
    return [round(k / fps, 6) for k in range(int(seconds * fps)) if k == 0 or rng.random() >= drop]


def write_video(path, times, draw):
    """An H.264 clip with frames at `times` (s); draw(t, k) gives each as a gray uint8 (H, W) picture."""
    with av.open(str(path), "w") as c:
        s = c.add_stream("libx264", rate=240)
        s.width, s.height, s.pix_fmt = W, H, "yuv420p"
        s.time_base = Fraction(1, 240000)
        s.codec_context.time_base = Fraction(1, 240000)
        s.options = {"crf": "2", "preset": "ultrafast"}
        for k, t in enumerate(times):
            g = draw(t, k)
            f = av.VideoFrame.from_ndarray(cv2.cvtColor(g, cv2.COLOR_GRAY2RGB), format="rgb24").reformat(format="yuv420p")
            f.pts = int(round(t * 240000))
            f.time_base = s.time_base
            c.mux(s.encode(f))
        c.mux(s.encode(None))


def texture(seed=0, level=130, contrast=40):
    rng = np.random.default_rng(seed)
    t = cv2.GaussianBlur(rng.normal(0, 1, (H, W)).astype(np.float32), (0, 0), 3)
    return level + contrast * t / t.std()


def frames_for(times):
    """Pose frames: the synthetic golfer (hands swinging), picture W x H."""
    return [(t, synthetic.landmarks(t, ASPECT)) for t in times]


def to_u8(img):
    return np.clip(np.round(img), 0, 255).astype(np.uint8)


class QualityVideos(unittest.TestCase):
    positions = {"p1": 0.9, "p5": 1.85, "p6": 1.92, "p7": 2.0, "takeaway": 1.0}

    def measure(self, name, times, draw):
        path = TMP / name
        write_video(path, times, draw)
        return quality.measure(str(path), frames_for(times), self.positions)

    def test_flicker(self):
        times = times_of(2.2)
        bg = texture()
        # A 100 Hz light swinging the picture's brightness 6% either way; phase so frames catch it.
        q = self.measure("flicker.mp4", times, lambda t, k: to_u8(bg * (1 + 0.06 * np.sin(2 * np.pi * 100 * t + 0.4))))
        self.assertIn("flicker", q["warnings"], q)
        self.assertAlmostEqual(q["flicker"]["hz"], 100, delta=1)
        self.assertEqual(q["flicker"]["mains"], 100)
        self.assertAlmostEqual(q["flicker"]["amplitude"], 0.06, delta=0.015)
        self.assertNotIn("dark", q["warnings"])
        self.assertNotIn("grainy", q["warnings"])

        steady = self.measure("steady.mp4", times, lambda t, k: to_u8(bg))
        self.assertEqual(steady["warnings"], [], steady)
        self.assertLess(steady["flicker"]["amplitude"], 0.005)
        self.assertLess(steady["noise"], 1.0)

    def test_banding(self):
        # Rolling shutter: bright and dark bands down the picture, moving from frame to frame.
        times = times_of(1.5)
        bg = texture(level=120)
        rows = np.arange(H)[:, None]
        q = self.measure("bands.mp4", times, lambda t, k: to_u8(bg * (1 + 0.05 * np.sin(2 * np.pi * (rows / 60 + 100 * t)))))
        self.assertGreater(q["banding"], quality.BANDING, q)
        self.assertIn("flicker", q["warnings"])
        self.assertNotIn("grainy", q["warnings"])       # the bands' change is taken out line by line

    def test_dark_and_grainy(self):
        times = times_of(2.2)
        bg = texture(level=28, contrast=8)
        rng = np.random.default_rng(5)
        q = self.measure("dark.mp4", times, lambda t, k: to_u8(bg + rng.normal(0, 7, (H, W))))
        self.assertLess(q["brightness"], quality.DARK)
        self.assertIn("dark", q["warnings"], q)
        self.assertIn("grainy", q["warnings"], q)
        self.assertNotIn("flicker", q["warnings"], q)
        self.assertGreater(q["noise"], 3)
        self.assertLess(q["banding"], quality.BANDING)   # grain alone isn't banding

    def test_sharp_vs_blurred(self):
        times = times_of(2.2)
        bg = np.full((H, W), 110, np.float32)
        cell = 3
        yy, xx = np.mgrid[0:24, 0:24]
        checker = np.where((yy // cell + xx // cell) % 2, 40, 210).astype(np.float32)

        def draw(blur):
            def frame(t, k):
                img = bg.copy()
                lm = synthetic.landmarks(t, ASPECT)
                x, y = int(lm[15 * 3] * W), int(lm[15 * 3 + 1] * H)
                y0, x0 = max(0, y - 12), max(0, x - 12)
                patch = checker[:min(H, y + 12) - y0, :min(W, x + 12) - x0]
                img[y0:y0 + patch.shape[0], x0:x0 + patch.shape[1]] = patch
                if blur and 1.8 <= t <= 2.1:
                    # The hands' streak in the downswing (a box along the way they move, roughly).
                    img = cv2.blur(img, (15, 15))
                return to_u8(img)
            return frame

        sharp = self.measure("sharp.mp4", times, draw(False))
        blurred = self.measure("blurred.mp4", times, draw(True))
        self.assertGreater(sharp["sharpness"]["p1"], 0)
        # Same light, same address: the address values agree.
        self.assertAlmostEqual(sharp["sharpness"]["p1"], blurred["sharpness"]["p1"], delta=0.05 * sharp["sharpness"]["p1"])
        self.assertGreater(sharp["sharpness"]["downswing"], 0.6, sharp)
        self.assertLess(blurred["sharpness"]["downswing"], 0.3, blurred)
        for key in ("p5", "p6", "p7"):
            self.assertLess(blurred["sharpness"][key], sharp["sharpness"][key])

    def test_arms_not_background(self):
        """A busy background where the hands pass in the downswing (not at address) barely changes
        the downswing's share of address: only the band along the forearms is measured, and against
        its own contrast. (Measured over the whole box round the hands, as v1 did, it came out 2.1
        against 1.0.)"""
        times = times_of(2.2)
        yy, xx = np.mgrid[0:H, 0:W]
        flat = np.full((H, W), 110, np.float32)
        # Fine stripes to the picture's left of the golfer, where the hands are at P5 and P6.
        busy = np.where((xx < W / 2 - 0.1 * H) & ((xx // 2) % 2 == 1), 240, 110).astype(np.float32)
        arm = np.where((yy // 3 + xx // 3) % 2, 70, 130).astype(np.float32)

        def draw(bg):
            def frame(t, k):
                lm = synthetic.landmarks(t, ASPECT)
                bh = quality.body_height(lm) * H
                inside = quality.arm_band(lm, (0, 0, W, H), W, H, 1.8 * quality.ARM_WIDTH * bh)
                return to_u8(np.where(inside, arm, bg))
            return frame

        a = self.measure("arms-flat.mp4", times, draw(flat))["sharpness"]
        b = self.measure("arms-busy.mp4", times, draw(busy))["sharpness"]
        self.assertGreater(a["downswing"], 0.6, a)
        self.assertAlmostEqual(a["downswing"], b["downswing"], delta=0.15)
        self.assertAlmostEqual(a["p1"], b["p1"], delta=0.2 * a["p1"])

    def test_sharpness_only_with_a_believable_impact(self):
        times = times_of(2.2)
        bg = texture(seed=2)
        path = TMP / "impact.mp4"
        write_video(path, times, lambda t, k: to_u8(bg))
        measure = lambda timing: quality.measure(str(path), frames_for(times), self.positions, timing)
        good = measure([{"angle": "face", "impact": 1.97, "strike": 2.0}])
        self.assertIsNotNone(good["sharpness"])
        self.assertIsNone(good["sharpnessSkipped"])
        self.assertEqual(good["impact"]["clips"], [{"angle": "face", "ball": True, "lead": -30}])
        for timing, why in (
                ([{"angle": "dtl", "impact": None, "strike": 2.0}], "ball not found (down the line)"),
                ([{"angle": "dtl", "impact": 2.1, "strike": 2.0}], "impact doubtful (down the line): 100 ms after the heard strike"),
                ([{"angle": "face", "impact": 1.9, "strike": 2.0}], "impact doubtful (face-on): 100 ms before the heard strike"),
                # A down-the-line clip carried from a face-on clip whose impact is off.
                ([{"angle": "face", "impact": 2.024, "strike": 2.0}, {"angle": "dtl", "impact": 1.98, "strike": 2.01}],
                 "impact doubtful (face-on): 24 ms after the heard strike")):
            q = measure(timing)
            self.assertIsNone(q["sharpness"], timing)
            self.assertEqual(q["sharpnessSkipped"], why)
            self.assertFalse(q["impact"]["ok"])
            self.assertIsNotNone(q["noise"])                          # the light is still measured

    def test_no_positions_or_person(self):
        # No swing found and nobody tracked: light and grain still measured, over the start.
        times = times_of(1.0)
        bg = texture()
        path = TMP / "empty.mp4"
        write_video(path, times, lambda t, k: to_u8(bg))
        q = quality.measure(str(path), [(t, None) for t in times], {})
        self.assertIsNone(q["brightness"])
        self.assertIsNone(q["sharpness"])
        self.assertIsNotNone(q["noise"])
        self.assertEqual(q["warnings"], [])


class Worker(unittest.TestCase):
    """The pose worker's quality step on a synthetic swing, with and without camera.json."""

    @classmethod
    def setUpClass(cls):
        cls.pool = ProcessPoolExecutor(1)
        # Folders of its own: other tests leave clips in app's (fakes that aren't really videos).
        cls.saved = app.CLIPS_DIR, app.POSE_DIR, app.TRASH_DIR
        app.CLIPS_DIR, app.POSE_DIR, app.TRASH_DIR = TMP / "w-clips", TMP / "w-pose", TMP / "w-trash"

    @classmethod
    def tearDownClass(cls):
        cls.pool.shutdown()
        app.CLIPS_DIR, app.POSE_DIR, app.TRASH_DIR = cls.saved

    def write_swing(self, name, camera=None):
        data = synthetic.pose_file(rotation=0)
        times = [f["t"] for f in data["frames"]]
        bg = texture(seed=7)
        app.CLIPS_DIR.mkdir(parents=True, exist_ok=True)
        app.POSE_DIR.mkdir(parents=True, exist_ok=True)
        write_video(app.CLIPS_DIR / name, times, lambda t, k: to_u8(bg))
        app.pose_file(name).write_bytes(gzip.compress(json.dumps(data).encode()))
        if camera:
            app.save_camera(name, *camera)

    def test_worker_and_listing(self):
        old = "swing_face_320x180_240fps_1789200000_2000ms.mp4"     # before capture app 0.4
        new = "swing_face_320x180_240fps_1789200100_2000ms.mp4"
        self.write_swing(old)
        self.write_swing(new, ("1/1000", "manual", 1_000_000, 1600, 4_166_666))
        summ = app.swings.Summarizer(app.STATIC_DIR)
        try:
            self.assertTrue(app.quality_step(self.pool, summ))
            self.assertTrue(app.quality_step(self.pool, summ))
            self.assertFalse(app.quality_step(self.pool, summ))      # both done
        finally:
            summ.close()
        listed = {c["name"]: c for c in app.listed_clips(with_shots=False)}
        self.assertIsNone(listed[old]["camera"])
        self.assertEqual(listed[new]["camera"]["shutterSpeed"], 1000)
        for name in (old, new):
            q = listed[name]["quality"]
            self.assertTrue(app.quality_file(name).is_file())
            self.assertEqual(q["poseVersion"], app.pose.VERSION)
            self.assertEqual(q["warnings"], [])
            self.assertIn("p6", q["positions"])
            # Nothing moves in the picture: near 1. (No arms are drawn, so the band along them
            # samples a different patch of the background texture at each key position.)
            self.assertAlmostEqual(q["sharpness"]["downswing"], 1, delta=0.35)
            self.assertTrue(q["impact"]["ok"], q["impact"])          # the made-up ball leaves at the strike
            self.assertEqual(q["shutter"], "unknown" if name == old else "1/1000")

        # The scorecard's label-free table, grouped by shutter (the old clip under "unknown").
        rows = scorecard.quality_rows([dict(c, clip=c["name"]) for c in listed.values()])
        groups = {(r["angle"], r["shutter"]) for r in rows}
        self.assertEqual(groups, {("face", "unknown"), ("face", "1/1000")})
        one = next(r for r in rows if r["shutter"] == "1/1000")
        self.assertEqual((one["clips"], one["speed"], one["iso"]), (1, 1000, 1600))

        # Trashed and restored: the quality record goes with the clip.
        with app.files_lock:
            self.assertTrue(app.move_clip(new, to_trash=True))
        self.assertFalse(app.quality_file(new).exists())
        with app.files_lock:
            self.assertTrue(app.move_clip(new, to_trash=False))
        self.assertTrue(app.quality_file(new).exists())


class RealClipNumbers(unittest.TestCase):
    """The warnings on the numbers quality.py v1 read from real clips (Galaxy S21, 1080p 240 fps, a
    barn under LED bulbs); see HOME-SETUP.md."""

    def q(self, brightness, noise, amplitude, banding, shutter):
        return {"brightness": brightness, "noise": noise, "banding": banding, "shutter": shutter,
                "flicker": {"amplitude": amplitude, "share": 0.6, "hz": 120.0, "mains": 120}}

    def test_auto_looks_normal(self):
        for b, n in ((102, 3.75), (109, 2.7), (105, 3.3)):
            q = self.q(b, n, 0.038, 0.015, "Auto")
            self.assertEqual(quality.warnings(q), ["flicker"], q)   # a real flicker, kept
            self.assertEqual(quality.flicker_level(q), "mild")

    def test_fixed_shutter_is_dark_not_grainy_and_its_flicker_matters(self):
        for b, n in ((63, 2.1), (65, 2.35)):
            q = self.q(b, n, 0.042, 0.020, "1/1000")
            self.assertEqual(quality.warnings(q), ["dark", "flicker"], q)
            self.assertEqual(quality.flicker_level(q), "matters")

    def test_grainy_still_caught(self):
        self.assertIn("grainy", quality.warnings(self.q(105, 5.6, 0, 0, "Auto")))
        self.assertIn("grainy", quality.warnings(self.q(40, 2.6, 0, 0, "Auto")))     # the floor
        self.assertIn("grainy", quality.warnings({"noise": 5.0}))                    # no brightness
        self.assertNotIn("grainy", quality.warnings({"noise": 4.9}))

    def test_strong_flicker_on_auto_matters(self):
        self.assertEqual(quality.flicker_level(self.q(105, 3, 0.09, 0.01, "Auto")), "matters")
        self.assertEqual(quality.flicker_level(self.q(105, 3, 0.03, 0.05, "unknown")), "matters")
        self.assertEqual(quality.flicker_level(self.q(105, 3, 0.03, 0.01, "unknown")), "mild")


class Groups(unittest.TestCase):
    def test_shutter_group(self):
        self.assertEqual(quality.shutter_group(None), "unknown")
        self.assertEqual(quality.shutter_group({"shutter": "Auto", "exposure": "auto"}), "Auto")
        self.assertEqual(quality.shutter_group({"shutter": "1/1000", "exposure": "manual"}), "1/1000")
        self.assertEqual(quality.shutter_group({"shutter": "1/1000", "exposure": "compensation"}), "1/1000 (compensation)")
        self.assertEqual(quality.shutter_group({"shutter": None, "exposure": "auto"}), "Auto")


if __name__ == "__main__":
    unittest.main()
