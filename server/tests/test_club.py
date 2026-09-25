"""The club model (SWINGCLIPS_CLUB_BACKEND=yolo: models.ClubRunner, club.model_scores), how pose.py and
eval.py use it, and the dataset export (club_dataset.py), with a tiny made-up ONNX model and the
drawn clip from fakes.py: the fake puts the grip end on the red dot across the chest and the
clubhead on the blue one between the feet.

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
from unittest import mock

import av
import cv2
import numpy as np

HERE = Path(__file__).parent
TMP = Path(tempfile.mkdtemp(prefix="swingclips-club-test-"))
os.environ.setdefault("SWINGCLIPS_CLIPS", str(TMP / "clips"))
sys.path[:0] = [str(HERE.parent), str(HERE)]

import app  # noqa: E402
import club  # noqa: E402
import club_dataset  # noqa: E402
import eval as scorecard  # noqa: E402
import fakes  # noqa: E402
import models  # noqa: E402
import pose  # noqa: E402

try:
    import onnxruntime  # noqa: F401
except ImportError:
    onnxruntime = None
needs_ort = unittest.skipIf(onnxruntime is None, "needs onnxruntime (pip install -r requirements.txt)")

MODEL = TMP / "models" / models.CLUB_FILE
DEFAULTS = {"SWINGCLIPS_POSE_BACKEND": "", "SWINGCLIPS_CLUB_BACKEND": ""}


def club_env(**extra) -> dict:
    """Environment for the fake club model."""
    MODEL.parent.mkdir(parents=True, exist_ok=True)
    if not MODEL.is_file():
        fakes.club_model(MODEL)
    return {**DEFAULTS, "SWINGCLIPS_MODELS": str(MODEL.parent), "SWINGCLIPS_CLUB_BACKEND": "yolo", **extra}


def analyze(path) -> dict:
    with fakes.mediapipe(), mock.patch("builtins.print"):
        out = pose.analyze(str(path), fakes.Pool(), 2)
    out.pop("seconds")
    return out


def true_angle(k: int) -> float:
    """The fake's shaft in frame k: red dot (grip) to blue dot (clubhead), degrees in the upright picture."""
    (gx, gy), (hx, hy) = fakes.dot_at(k), fakes.FEET
    return math.degrees(math.atan2((hy - gy) * fakes.H, (hx - gx) * fakes.W)) % 360


def frame_times(path) -> list[float]:
    """Frame start times as pose.py and the labels have them."""
    with av.open(str(path)) as c:
        tb = float(c.streams.video[0].time_base)
        return sorted(round(f.pts * tb, 6) for f in c.decode(video=0))


class ScoresTest(unittest.TestCase):
    """club.model_scores and club.clubhead on made-up model output."""
    W, H = 540, 960
    LM = [(0.5, 0.5, 0.9)] * 33

    def lm(self, hands=(0.5, 0.5)):
        lm = list(self.LM)
        lm[0] = (0.5, 0.1, 0.9)                         # nose; feet at 0.9: body 0.8 of the height
        for i in club.FEET:
            lm[i] = (0.5, 0.9, 0.9)
        lm[club.L_INDEX] = lm[club.R_INDEX] = (*hands, 0.9)
        return lm

    def test_peak_at_the_shaft(self):
        found = (0.8, [(0.5, 0.5, 0.9), (0.55, 0.6, 0.9), (0.6, 0.7, 0.95)])
        s = club.model_scores(found, self.lm(), self.W, self.H)
        want = math.degrees(math.atan2(0.2 * self.H, 0.1 * self.W))
        self.assertEqual(s.shape, club.ANGLES.shape)
        self.assertAlmostEqual(float(np.rad2deg(club.ANGLES[s.argmax()])), want, delta=club.STEP / 2 + 1e-6)
        self.assertAlmostEqual(float(s.max()), 0.8 * 0.9, delta=0.02)
        # A bump, not a spike: a few bins either side still score, the far side nothing.
        k = int(s.argmax())
        self.assertGreater(s[(k + 2) % len(s)], 0.3 * s[k])
        self.assertLess(s[(k + len(s) // 2) % len(s)], 1e-6)

    def test_hands_stand_in_for_an_unsure_grip(self):
        # The grip end unsure (0.1): the hands, pointing straight down to the head, win.
        found = (1.0, [(0.9, 0.5, 0.1), (0, 0, 0), (0.5, 0.8, 1.0)])
        s = club.model_scores(found, self.lm(hands=(0.5, 0.5)), self.W, self.H)
        self.assertAlmostEqual(float(np.rad2deg(club.ANGLES[s.argmax()])), 90, delta=1e-6)
        self.assertAlmostEqual(float(s.max()), club.HANDS_WEIGHT, delta=0.01)

    def test_no_direction(self):
        # Grip and head on top of each other, and the hands too: nothing to go on.
        found = (0.9, [(0.5, 0.5, 1.0), (0, 0, 0), (0.5, 0.505, 1.0)])
        s = club.model_scores(found, self.lm(hands=(0.5, 0.5)), self.W, self.H)
        self.assertEqual(float(s.max()), 0.0)
        self.assertIsNone(club.model_scores(None, self.lm(), self.W, self.H))
        self.assertIsNone(club.model_scores(found, None, self.W, self.H))

    def test_clubhead_kept_only_when_sure(self):
        self.assertEqual(club.clubhead((0.9, [(0, 0, 0), (0, 0, 0), (0.123456, 0.654321, 0.8)])), [0.1235, 0.6543, 0.72])
        self.assertIsNone(club.clubhead((0.2, [(0, 0, 0), (0, 0, 0), (0.1, 0.6, 0.9)])))     # unsure of the club
        self.assertIsNone(club.clubhead((0.9, [(0, 0, 0), (0, 0, 0), (0.1, 0.6, 0.3)])))     # of the head
        self.assertIsNone(club.clubhead(None))

    def test_backend_setting(self):
        with mock.patch.dict(os.environ, {"SWINGCLIPS_CLUB_BACKEND": ""}):
            self.assertEqual(models.club_backend(), "raycast")
        with mock.patch.dict(os.environ, {"SWINGCLIPS_CLUB_BACKEND": "YOLO"}):
            self.assertEqual(models.club_backend(), "yolo")
        with mock.patch.dict(os.environ, {"SWINGCLIPS_CLUB_BACKEND": "hough"}):
            self.assertRaises(ValueError, models.club_backend)

    def test_club_box_reaches_past_the_body(self):
        pts = [(0.4, 0.1, 0.9), (0.6, 0.9, 0.1), (0.5, 0.5, 0.0)]      # every point counts, however unsure
        x0, y0, x1, y1 = models.club_box(pts, 1000, 1000)
        m = models.CLUB_MARGIN * 800
        self.assertEqual((x0, y0, x1, y1), (400 - m, 100 - m, 600 + m, 900 + m))


@needs_ort
class RunnerTest(unittest.TestCase):
    def test_detect_takes_the_best_anchor(self):
        path = TMP / "runner.onnx"
        fakes.club_model(path, size=320)
        runner = models.ClubRunner(path)
        self.assertEqual(runner.size, (320, 320))
        img = np.full((320, 320, 3), 114, np.uint8)
        cv2.circle(img, (50, 60), 4, (255, 0, 0), -1)
        cv2.circle(img, (200, 250), 4, (0, 0, 255), -1)
        score, (g, hosel, head) = runner.detect(img)
        self.assertAlmostEqual(score, 0.9, places=5)                 # not the 0.1 decoy
        self.assertLess(math.hypot(g[0] - 50, g[1] - 60), 6)
        self.assertLess(math.hypot(head[0] - 200, head[1] - 250), 6)
        self.assertEqual((g[2], head[2]), (1.0, 1.0))
        self.assertEqual(hosel[2], 0.0)                              # no green dot: not in sight
        # A crop of another size is resized to the input, and the points scaled back.
        big = cv2.resize(img, (640, 640), interpolation=cv2.INTER_NEAREST)
        _, (g2, _, _) = runner.detect(big)
        self.assertLess(math.hypot(g2[0] - 100, g2[1] - 120), 12)

    def test_find_through_every_rotation(self):
        """The dots in a stored frame, turned upright as pose.py does, found in the crop around the
        golfer and put back in upright picture units: where they show on screen."""
        path = TMP / "runner.onnx"
        fakes.club_model(path)
        runner = models.ClubRunner(path)
        upright = fakes.figure(10)
        with fakes.mediapipe():
            import mediapipe as mp
            res = mp.tasks.python.vision.PoseLandmarker.create_from_options(None).detect_for_video(
                mp.Image(image_format=None, data=upright), 0)
        lm = [(p.x, p.y, p.visibility) for p in res.pose_landmarks[0]]
        for rotation in (0, 90, 180, 270):
            stored = cv2.rotate(upright, fakes.STORE[rotation]) if rotation else upright
            full = cv2.rotate(stored, pose.ROTATE_CW[rotation]) if rotation in pose.ROTATE_CW else stored
            score, (g, _, head) = runner.find(full, lm)
            x, y = fakes.dot_at(10)
            self.assertLess(math.hypot((g[0] - x) * fakes.W, (g[1] - y) * fakes.H), 12, rotation)
            self.assertLess(math.hypot((head[0] - fakes.FEET[0]) * fakes.W, (head[1] - fakes.FEET[1]) * fakes.H), 12)
        self.assertIsNone(runner.find(upright, None))

    def test_missing_file(self):
        with self.assertRaises(FileNotFoundError):
            models.ClubRunner(TMP / "nothing.onnx")

    def test_stamp_follows_the_file(self):
        a, b = TMP / "stamp" / "a" / "club.onnx", TMP / "stamp" / "b" / "club.onnx"
        a.parent.mkdir(parents=True)
        b.parent.mkdir(parents=True)
        fakes.club_model(a, score=0.9)
        fakes.club_model(b, score=0.8)                              # "retrained": same name, other weights
        sa, sb = models.club_stamp(a), models.club_stamp(b)
        self.assertTrue(sa.startswith("club@") and len(sa) == len("club@") + 8, sa)
        self.assertNotEqual(sa, sb)
        self.assertEqual(models.club_stamp(TMP / "none.onnx"), "none@missing")


class PipelineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.clips = {r: TMP / f"clip{r}.mp4" for r in (0, 90)}
        for r, p in cls.clips.items():
            fakes.clip(p, r)

    def test_default_has_no_club_model(self):
        with mock.patch.dict(os.environ, DEFAULTS):
            out = analyze(self.clips[0])
        self.assertNotIn("clubModel", out)
        self.assertNotIn("msPerFrame", out)
        self.assertTrue(all("clubhead" not in f for f in out["frames"]))

    @needs_ort
    def test_club_model_output(self):
        """The shaft angle is the fake's grip -> head in every frame; the clubhead is on the blue dot;
        the body is untouched; the model is stamped."""
        for rotation, path in self.clips.items():
            with mock.patch.dict(os.environ, DEFAULTS):
                base = analyze(path)
            with mock.patch.dict(os.environ, club_env()):
                got = analyze(path)
            self.assertEqual(got["version"], pose.VERSION)
            self.assertEqual(got["clubModel"], models.club_stamp(MODEL))
            self.assertNotIn("model", got)
            self.assertEqual(set(got["msPerFrame"]), {"mediapipe", "club"})
            self.assertEqual(list(got)[:3], ["version", "clubModel", "msPerFrame"])
            self.assertEqual(got["clubLength"], base["clubLength"])
            for k, (f, b) in enumerate(zip(got["frames"], base["frames"])):
                self.assertEqual((f["lm"], f["w"]), (b["lm"], b["w"]))
                self.assertIsNotNone(f["club"], (rotation, k))
                self.assertLess(abs(scorecard.wrap(f["club"][0] - true_angle(k))), 3, (rotation, k, f["club"]))
                self.assertGreater(f["club"][1], 0.5)
                hx, hy, conf = f["clubhead"]
                self.assertLess(math.hypot((hx - fakes.FEET[0]) * fakes.W, (hy - fakes.FEET[1]) * fakes.H), 12, (rotation, k))
                self.assertGreater(conf, 0.5)

    @needs_ort
    def test_with_a_body_model_too(self):
        folder = TMP / "both"
        folder.mkdir(exist_ok=True)
        fakes.club_model(folder / models.CLUB_FILE)
        fakes.simcc_model(folder / models.SPECS["rtmpose-m"].file, *models.SPECS["rtmpose-m"].size, fakes.CHANNELS)
        with mock.patch.dict(os.environ, club_env(SWINGCLIPS_MODELS=str(folder), SWINGCLIPS_POSE_BACKEND="rtmpose-m")):
            got = analyze(self.clips[90])
        self.assertEqual(list(got)[:4], ["version", "model", "clubModel", "msPerFrame"])
        self.assertEqual(set(got["msPerFrame"]), {"mediapipe", "body", "club"})
        self.assertTrue(all("clubhead" in f for f in got["frames"]))

    def test_missing_model_file(self):
        with mock.patch.dict(os.environ, {**DEFAULTS, "SWINGCLIPS_CLUB_BACKEND": "yolo",
                                          "SWINGCLIPS_CLUB_MODEL": str(TMP / "nothing-here.onnx")}):
            with self.assertRaises(FileNotFoundError):
                pose.analyze(str(self.clips[0]), fakes.Pool(), 1)

    def test_fingerprint_follows_the_club_model(self):
        other = TMP / "retrained" / models.CLUB_FILE
        other.parent.mkdir(exist_ok=True)
        fakes.club_model(other, score=0.7)
        with mock.patch.dict(os.environ, DEFAULTS):
            default = scorecard.pipeline_fingerprint()
            self.assertEqual(scorecard.club_model(), "raycast")
        with mock.patch.dict(os.environ, club_env()):
            yolo = scorecard.pipeline_fingerprint()
            self.assertEqual(scorecard.club_model(), models.club_stamp(MODEL))
        with mock.patch.dict(os.environ, club_env(SWINGCLIPS_CLUB_MODEL=str(other))):
            retrained = scorecard.pipeline_fingerprint()
        self.assertEqual(len({default, yolo, retrained}), 3)


@needs_ort
class RerunTest(unittest.TestCase):
    """eval.py --rerun end to end: the ray casting first, then the club model compared with it,
    with the clubhead scored against labels on the blue dot."""

    def test_rerun_with_club_model(self):
        root = TMP / "rerun"
        folders = {"CLIPS_DIR": root / "clips", "POSE_DIR": root / "pose", "TRASH_DIR": root / "trash",
                   "LABELS_DIR": root / "labels"}
        for d in folders.values():
            d.mkdir(parents=True, exist_ok=True)
        name = "swing_face_960x540_60fps_1789123456_400ms.mp4"
        fakes.clip(folders["CLIPS_DIR"] / name, 90)
        ts = frame_times(folders["CLIPS_DIR"] / name)
        frames = {}
        for k in (12, 20, 30, 38):
            gx, gy = fakes.dot_at(k)
            frames[f"{ts[k]:.6f}"] = {"grip": {"x": gx, "y": gy}, "hosel": {"hidden": True},
                                     "head": {"x": fakes.FEET[0], "y": fakes.FEET[1], "blur": k > 25}}
        label = {"schema": 1, "clip": {"name": name, "angle": "face", "strike": 0.4}, "partner": None,
                 "events": {"takeaway": ts[10], "p4": ts[25], "impact": ts[40]}, "frames": frames}
        (folders["LABELS_DIR"] / f"{name}.json").write_text(json.dumps(label))
        out = root / "eval"

        def run(env, *extra):
            with mock.patch.multiple(app, **folders), mock.patch.object(scorecard, "ProcessPoolExecutor",
                                                                        lambda n: fakes.Pool()), \
                    fakes.mediapipe(), mock.patch.dict(os.environ, env):
                self.assertEqual(scorecard.main(["--rerun", "--no-noise", "--out", str(out), *extra]), 0)
            return json.loads(max(out.glob("*.json"), key=lambda f: f.stat().st_mtime).read_text())

        with mock.patch("builtins.print"):
            base = run(club_env(SWINGCLIPS_CLUB_BACKEND=""))
        self.assertEqual(base["clubModel"], "raycast")
        self.assertEqual(base["tables"]["clubhead"], [])
        with mock.patch("builtins.print") as printed:
            got = run(club_env(), "--compare")
        text = "\n".join(" ".join(map(str, c.args)) for c in printed.call_args_list)
        stamp = models.club_stamp(MODEL)
        self.assertEqual(got["clubModel"], stamp)
        self.assertIn(f"club {stamp}", text)
        self.assertIn("Clubhead: found", text)
        self.assertIn("club raycast):", text)                         # compared with the ray-cast run
        self.assertEqual(len(list(out.glob(f"*_{stamp.replace('@', '-')}.json"))), 1)
        stamped = [json.loads(gzip.decompress(f.read_bytes())).get("clubModel") for f in (out / "pose").glob("*/*.gz")]
        self.assertEqual(sorted(map(str, stamped)), sorted(["None", stamp]))

        rows = {r["phase"]: r for r in got["tables"]["clubhead"]}
        self.assertEqual(rows["all"]["labeled"], 4)
        self.assertEqual(rows["all"]["blurred"], 2)
        self.assertEqual(rows["all"]["found"], 100)
        self.assertLess(rows["all"]["median"], 3)                     # % of body height
        self.assertIsNotNone(rows["all"]["blurMedian"])
        self.assertEqual({"backswing", "downswing", "all"}, set(rows))
        self.assertIn("clubhead.face.downswing.median_pct", got["headline"])
        club_rows = {r["phase"]: r for r in got["tables"]["club"]}
        self.assertEqual(club_rows["all"]["found"], 100)
        self.assertLess(club_rows["all"]["median"], 3)                # degrees


class OnlyValTest(unittest.TestCase):
    def test_val_clips(self):
        manifest = {"swings": {"train": ["a"], "val": ["b"]},
                    "images": [{"clip": "a", "swing": "a"}, {"clip": "b", "swing": "b"}, {"clip": "c", "swing": "b"}]}
        self.assertEqual(scorecard.val_clips(manifest), {"b", "c"})

    def test_baseline_over_the_same_clips(self):
        folder = TMP / "baselines"
        folder.mkdir(exist_ok=True)
        (folder / "all.json").write_text(json.dumps({"headline": {}, "onlyVal": None}))
        os.utime(folder / "all.json", (1, 1))
        (folder / "val.json").write_text(json.dumps({"headline": {}, "onlyVal": "abc"}))
        self.assertEqual(scorecard.latest_mediapipe(folder).name, "all.json")
        self.assertEqual(scorecard.latest_mediapipe(folder, "abc").name, "val.json")
        self.assertIsNone(scorecard.latest_mediapipe(folder, "other"))


class DatasetTest(unittest.TestCase):
    """club_dataset.py on made-up label files for drawn clips."""

    @classmethod
    def setUpClass(cls):
        cls.root = TMP / "dataset"
        cls.clips = cls.root / "clips"
        cls.labels = cls.root / "labels"
        cls.clips.mkdir(parents=True)
        cls.labels.mkdir()
        cls.names = {"a": "swing_face_960x540_60fps_1789000001_400ms.mp4",       # stored turned, rotation 90
                     "b": "swing_dtl_540x960_60fps_1789000001_410ms.mp4",        # a's partner
                     "c": "swing_face_540x960_60fps_1789000002_400ms.mp4",
                     "d": "swing_face_540x960_60fps_1789000003_400ms.mp4"}       # labeled, clip gone
        fakes.clip(cls.clips / cls.names["a"], 90)
        fakes.clip(cls.clips / cls.names["b"], 0)
        fakes.clip(cls.clips / cls.names["c"], 0)
        ts = frame_times(cls.clips / cls.names["a"])
        cls.ts = ts
        key = lambda k: f"{ts[k]:.6f}"
        grip = lambda k: dict(zip("xy", fakes.dot_at(k)))
        head = {"x": fakes.FEET[0], "y": fakes.FEET[1]}
        info = lambda n, angle: {"name": cls.names[n], "angle": angle, "strike": 0.4}
        docs = {
            "a": {"clip": info("a", "face"), "partner": info("b", "dtl"), "frames": {
                key(10): {"grip": grip(10), "hosel": {"hidden": True}, "head": {**head, "blur": True}, "l_wrist": head},
                key(20): {"grip": {"hidden": True}, "hosel": {"hidden": True}, "head": {"hidden": True}},
                key(30): {"l_wrist": head},                                    # no club labeled
                key(5): {"grip": grip(5)},                                     # hosel and head skipped
                key(6): {"grip": {"hidden": True}, "head": {"hidden": True}},  # hosel skipped, nothing in sight
                "99.000000": {"grip": grip(0), "head": head},                  # no such frame
            }},
            "b": {"clip": info("b", "dtl"), "partner": None, "frames": {key(15): {"grip": grip(15), "head": head}}},
            "c": {"clip": info("c", "face"), "partner": None, "frames": {key(25): {"grip": grip(25), "head": head}}},
            "d": {"clip": info("d", "face"), "partner": None, "frames": {key(1): {"grip": grip(1), "head": head}}},
        }
        for n, doc in docs.items():
            (cls.labels / f"{cls.names[n]}.json").write_text(json.dumps({"schema": 1, "events": {}, "ball": None, **doc}))
        # A second pass is left out.
        (cls.labels / f"{cls.names['c']}.pass2.json").write_text(json.dumps({"schema": 1, **docs["c"]}))
        cls.out = cls.root / "out"
        with mock.patch.object(club_dataset, "CLIPS_DIR", cls.clips), \
                mock.patch.object(club_dataset, "TRASH_DIR", cls.root / "trash"), mock.patch("builtins.print"):
            cls.manifest = club_dataset.export(cls.out, 0.2, labels_dir=cls.labels)

    def image(self, n, k):
        return next(i for i in self.manifest["images"] if i["clip"] == self.names[n] and abs(i["t"] - self.ts[k]) < 1e-6)

    def label(self, entry) -> str:
        return (self.out / entry["image"].replace("images/", "labels/", 1)).with_suffix(".txt").read_text()

    def test_what_went_in(self):
        got = sorted((i["clip"], round(i["t"], 6)) for i in self.manifest["images"])
        want = sorted([(self.names["a"], self.ts[k]) for k in (5, 10, 20)] + [(self.names["b"], self.ts[15]),
                                                                                (self.names["c"], self.ts[25])])
        self.assertEqual(got, want)
        why = {(s["clip"], s.get("t")): s["why"] for s in self.manifest["skipped"]}
        self.assertEqual(why[(self.names["a"], 99.0)], "no frame starts there")
        self.assertEqual(why[(self.names["d"], None)], "clip not found")
        for i in self.manifest["images"]:
            self.assertTrue((self.out / i["image"]).is_file())

    def test_upright_and_on_the_dots(self):
        e = self.image("a", 10)
        img = cv2.imread(str(self.out / e["image"]))
        self.assertEqual(img.shape[:2], (fakes.H, fakes.W))              # turned upright
        self.assertEqual(e["size"], [fakes.W, fakes.H])
        v = self.label(e).split()
        self.assertEqual(len(v), 5 + 9)
        self.assertEqual(v[0], "0")
        (gx, gy, gv), (hx, hy, hv), (cx, cy, cv) = [(float(v[j]), float(v[j + 1]), int(v[j + 2])) for j in (5, 8, 11)]
        self.assertEqual((gv, hv, cv), (2, 0, 2))                        # hosel hidden; the blurred head stays in
        self.assertEqual((hx, hy), (0.0, 0.0))
        b, g, r = img[int(gy * fakes.H), int(gx * fakes.W)]
        self.assertTrue(r > 200 and g < 60 and b < 60, (b, g, r))        # the red dot: the grip end
        b, g, r = img[int(cy * fakes.H), int(cx * fakes.W)]
        self.assertTrue(b > 200 and r < 60, (b, g, r))                   # the blue one: the head
        self.assertEqual(e["blur"], ["head"])
        self.assertEqual(e["visible"], ["grip", "head"])

    def test_box_is_padded_around_the_points(self):
        v = [float(x) for x in self.label(self.image("a", 10)).split()]
        cx, cy, w, h = v[1:5]
        for x, y in ((v[5], v[6]), (v[11], v[12])):
            self.assertLess(cx - w / 2, x)
            self.assertLess(x, cx + w / 2)
            self.assertLess(cy - h / 2, y)
            self.assertLess(y, cy + h / 2)
        pad = club_dataset.BOX_MIN_PAD
        self.assertGreater(h, abs(v[12] - v[6]) + 2 * pad)
        self.assertTrue(0 <= cx - w / 2 and cx + w / 2 <= 1 and 0 <= cy - h / 2 and cy + h / 2 <= 1)
        # One point in sight still gets a box of some size.
        v = [float(x) for x in self.label(self.image("a", 5)).split()]
        self.assertAlmostEqual(v[4], 2 * pad, places=4)
        self.assertEqual([v[10], v[13]], [0, 0])

    def test_no_club_in_sight_is_an_empty_label(self):
        e = self.image("a", 20)
        self.assertEqual(self.label(e), "")
        self.assertEqual(e["visible"], [])

    def test_split_by_swing(self):
        splits = {i["clip"]: i["split"] for i in self.manifest["images"]}
        self.assertEqual(splits[self.names["a"]], splits[self.names["b"]])   # one swing, one side
        sw = self.manifest["swings"]
        self.assertFalse(set(sw["train"]) & set(sw["val"]))
        self.assertEqual(len(sw["val"]), 1)                                   # round(3 swings * 0.2) = 1
        self.assertEqual({i["swing"] for i in self.manifest["images"] if i["clip"] == self.names["b"]},
                         {min(self.names["a"], self.names["b"])})
        for i in self.manifest["images"]:
            self.assertTrue(i["image"].startswith(f"images/{i['split']}/"))

    def test_split_rules(self):
        self.assertEqual(club_dataset.split(["x"]), set())
        self.assertEqual(len(club_dataset.split(["x", "y"])), 1)
        self.assertEqual(len(club_dataset.split([f"s{k}" for k in range(20)])), 4)
        self.assertEqual(len(club_dataset.split(["x", "y"], 0.9)), 1)        # never all of them
        self.assertEqual(club_dataset.split(["p", "q", "r"]), club_dataset.split(["r", "q", "p"]))
        self.assertEqual(club_dataset.swings({"a": {"partner": {"name": "b"}}, "b": {"partner": None},
                                              "c": {"partner": None}}), {"a": "a", "b": "a", "c": "c"})

    def test_data_yaml(self):
        text = (self.out / "data.yaml").read_text()
        self.assertIn("kpt_shape: [3, 3]", text)
        self.assertIn("flip_idx: [0, 1, 2]", text)
        self.assertIn("train: images/train", text)
        self.assertNotRegex(text, r"(?m)^path:")                            # relative to itself: copyable
        self.assertIn("0: club", text)

    def test_rebuild_and_refuse(self):
        out = self.root / "again"
        with mock.patch.object(club_dataset, "CLIPS_DIR", self.clips), mock.patch("builtins.print"):
            club_dataset.export(out, labels_dir=self.labels)
            stale = out / "images" / "train" / "stale.jpg"
            stale.write_bytes(b"old")
            m = club_dataset.export(out, labels_dir=self.labels)
        self.assertFalse(stale.exists())
        self.assertEqual(len(m["images"]), 5)
        other = self.root / "someone-elses"
        other.mkdir()
        (other / "notes.txt").write_text("keep me")
        with self.assertRaises(SystemExit), mock.patch("builtins.print"):
            club_dataset.export(other, labels_dir=self.labels)
        self.assertTrue((other / "notes.txt").is_file())


if __name__ == "__main__":
    unittest.main()
