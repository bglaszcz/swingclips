"""Other body models than MediaPipe, and the club model, run through ONNX Runtime on the CPU, to score
with eval.py --rerun.

Chosen with SWINGCLIPS_POSE_BACKEND: mediapipe (the default: nothing here runs), rtmpose-m,
rtmpose-l or rtmw. pose.py still runs MediaPipe on every frame, for the person mask (the club
tracker needs it), the 3D estimate and the points these models don't have; the model then looks
again at a crop around the golfer and its points replace MediaPipe's where it has them. The output
keeps MediaPipe's 33-landmark layout, which the review page's JavaScript indexes by number.

RTMPose and RTMW (MMPose, Apache-2.0) are top-down: they place one person's keypoints in a crop,
through SimCC heads (a score per sub-pixel column and row for each keypoint). fetch_models.py
downloads the weights into public/models (SWINGCLIPS_MODELS to put them elsewhere).

The club model (SWINGCLIPS_CLUB_BACKEND=yolo; the default, raycast, runs nothing here) is a YOLO11
pose model with three keypoints, grip end, hosel and clubhead, trained on the hand labels
(club_dataset.py, then train/club_train.py on a PC with a GPU) and exported to ONNX. It looks at a
crop around the golfer, big enough for the club to fit, and club.py turns its points into the shaft
scores its tracking takes.
"""
import hashlib
import os
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

DEFAULT = "mediapipe"
_OMM = "https://download.openmmlab.com/mmpose/v1/projects/"


@dataclass(frozen=True)
class Spec:
    file: str             # the .onnx file in the models folder; its stem is the stamp in pose files
    size: tuple           # model input (width, height)
    layout: str           # "coco17" or "wholebody133"
    url: str              # the official MMPose release: a zip with end2end.onnx inside


SPECS = {
    "rtmpose-m": Spec("rtmpose-m-256x192.onnx", (192, 256), "coco17",
                      _OMM + "rtmposev1/onnx_sdk/rtmpose-m_simcc-body7_pt-body7_420e-256x192-e48f03d0_20230504.zip"),
    "rtmpose-l": Spec("rtmpose-l-384x288.onnx", (288, 384), "coco17",
                      _OMM + "rtmposev1/onnx_sdk/rtmpose-l_simcc-body7_pt-body7_420e-384x288-3f5a1437_20230504.zip"),
    # RTMW-l, at the larger input: the hands are the reason to use it, and they're small in a crop
    # of the whole golfer.
    "rtmw": Spec("rtmw-l-384x288.onnx", (288, 384), "wholebody133",
                 _OMM + "rtmw/onnx_sdk/rtmw-dw-x-l_simcc-cocktail14_270e-384x288_20231122.zip"),
}
BACKENDS = [DEFAULT, *SPECS]

# ImageNet mean and spread, RGB, as the models were trained with.
MEAN = np.array([123.675, 116.28, 103.53], np.float32)
STD = np.array([58.395, 57.12, 57.375], np.float32)
# The crop around the golfer: the keypoints' box grown by this share of its size (half each side),
# then by the models' own 1.25 as in training, then widened or heightened to the model's shape.
PAD = 0.25
MODEL_PAD = 1.25
# Below this mean confidence over the body points the golfer counts as lost, and the next frame's
# crop comes from MediaPipe again.
LOST = 0.3

# MediaPipe landmark index for each keypoint the models have. Left and right are the person's own
# in both. COCO-17: nose, eyes, ears, shoulders, elbows, wrists, hips, knees, ankles.
COCO_TO_MP = {0: 0, 1: 2, 2: 5, 3: 7, 4: 8, 5: 11, 6: 12, 7: 13, 8: 14, 9: 15, 10: 16,
              11: 23, 12: 24, 13: 25, 14: 26, 15: 27, 16: 28}
# COCO-WholeBody adds feet (17-22: left big toe, small toe, heel, then right), 68 face points, and
# 21 per hand (91-111 left, 112-132 right: 0 wrist, 4 thumb tip, 5 index knuckle, 17 pinky knuckle).
# MediaPipe's "index", "pinky" and "thumb" hand points are the knuckles and the thumb tip.
LEFT_HAND, RIGHT_HAND = 91, 112
WHOLEBODY_TO_MP = {**COCO_TO_MP, 17: 31, 19: 29, 20: 32, 22: 30,
                   LEFT_HAND + 5: 19, RIGHT_HAND + 5: 20, LEFT_HAND + 17: 17, RIGHT_HAND + 17: 18,
                   LEFT_HAND + 4: 21, RIGHT_HAND + 4: 22}
TO_MP = {"coco17": COCO_TO_MP, "wholebody133": WHOLEBODY_TO_MP}
BODY = range(17)


def backend() -> str:
    """The body backend chosen with SWINGCLIPS_POSE_BACKEND (read each time, so tests can set it)."""
    name = os.environ.get("SWINGCLIPS_POSE_BACKEND", DEFAULT).strip().lower() or DEFAULT
    if name not in BACKENDS:
        raise ValueError(f"SWINGCLIPS_POSE_BACKEND={name!r}: use one of {', '.join(BACKENDS)}")
    return name


def models_dir() -> Path:
    return Path(os.environ.get("SWINGCLIPS_MODELS", Path(__file__).parent.parent / "public" / "models"))


def model_path(name: str) -> Path:
    return models_dir() / SPECS[name].file


def stamp(name: str) -> str:
    """What goes in the pose file's "model": the backend's model file, e.g. rtmpose-m-256x192."""
    return Path(SPECS[name].file).stem


# ---- The crop: the golfer's box in the picture <-> the model's input ----

def box_of(points, w, h, pad=PAD, min_conf=LOST):
    """(x0, y0, x1, y1) in pixels around the points [(x, y, conf)] in picture units (0-1), grown by
    `pad` of its size; None if fewer than 3 points are that sure or the box is empty."""
    xy = np.array([(x * w, y * h) for x, y, c in points if c >= min_conf and np.isfinite(x) and np.isfinite(y)])
    if len(xy) < 3:
        return None
    (x0, y0), (x1, y1) = xy.min(axis=0), xy.max(axis=0)
    if x1 - x0 < 1 or y1 - y0 < 1:
        return None
    gx, gy = (x1 - x0) * pad / 2, (y1 - y0) * pad / 2
    # Points MediaPipe guesses far outside the picture shouldn't blow the crop up.
    return (max(x0 - gx, -0.5 * w), max(y0 - gy, -0.5 * h), min(x1 + gx, 1.5 * w), min(y1 + gy, 1.5 * h))


def crop_transform(box, size):
    """The box as the model sees it: (centre x, centre y, picture pixels per input pixel), with the
    box grown by MODEL_PAD and to the input's shape (width, height)."""
    x0, y0, x1, y1 = box
    iw, ih = size
    bw, bh = (x1 - x0) * MODEL_PAD, (y1 - y0) * MODEL_PAD
    return (x0 + x1) / 2, (y0 + y1) / 2, max(bw / iw, bh / ih)


def crop(img, box, size, fill=0):
    """The model's input from the picture: (crop at the input size, transform). Outside the
    picture is `fill` (black by default)."""
    cx, cy, s = crop_transform(box, size)
    iw, ih = size
    m = np.array([[1 / s, 0, iw / 2 - cx / s], [0, 1 / s, ih / 2 - cy / s]], np.float32)
    return cv2.warpAffine(img, m, (iw, ih), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT,
                          borderValue=(fill, fill, fill)), (cx, cy, s)


def uncrop(points, transform, size):
    """Points [(u, v, conf)] in input pixels back to picture pixels."""
    cx, cy, s = transform
    iw, ih = size
    return [((u - iw / 2) * s + cx, (v - ih / 2) * s + cy, c) for u, v, c in points]


# ---- Running a model ----

class Runner:
    """One loaded model. keypoints() takes an RGB crop and gives [(x, y, conf)] in its pixels."""

    def __init__(self, name: str, path: Path | str | None = None, threads: int | None = None):
        import onnxruntime as ort
        self.name = name
        self.spec = SPECS[name]
        self.path = Path(path) if path else model_path(name)
        if not self.path.is_file():
            raise FileNotFoundError(f"{self.path} is missing: run fetch_models.py first")
        opts = ort.SessionOptions()
        # One thread by default: pose.py already runs one of these per worker process.
        opts.intra_op_num_threads = threads or int(os.environ.get("SWINGCLIPS_ORT_THREADS", "1"))
        opts.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(self.path), opts, providers=["CPUExecutionProvider"])
        inp = self.session.get_inputs()[0]
        self.input_name = inp.name
        # The file's own input shape (1, 3, height, width) wins over the table, where it's fixed.
        h, w = inp.shape[2:4]
        self.size = (w, h) if isinstance(w, int) and isinstance(h, int) else self.spec.size
        outs = [o.name for o in self.session.get_outputs()]
        named = {n: n for n in outs if n in ("simcc_x", "simcc_y")}
        self.outputs = [named.get("simcc_x", outs[0]), named.get("simcc_y", outs[1])]
        self.to_mp = TO_MP[self.spec.layout]

    def keypoints(self, rgb_crop):
        """[(x, y, conf 0-1)] per keypoint, in the crop's pixels."""
        ch, cw = rgb_crop.shape[:2]
        iw, ih = self.size
        img = rgb_crop if (cw, ch) == (iw, ih) else cv2.resize(rgb_crop, (iw, ih), interpolation=cv2.INTER_LINEAR)
        x = ((img.astype(np.float32) - MEAN) / STD).transpose(2, 0, 1)[None]
        simcc_x, simcc_y = self.session.run(self.outputs, {self.input_name: np.ascontiguousarray(x)})
        return [(u * cw / iw, v * ch / ih, c) for u, v, c in decode_simcc(simcc_x[0], simcc_y[0], iw, ih)]

    def track(self, rgb, box):
        """Keypoints [(x, y, conf)] in picture units (0-1) for the golfer in `box` (pixels)."""
        h, w = rgb.shape[:2]
        patch, t = crop(rgb, box, self.size)
        return [(x / w, y / h, c) for x, y, c in uncrop(self.keypoints(patch), t, self.size)]


def decode_simcc(simcc_x, simcc_y, iw, ih):
    """[(u, v, conf)] in input pixels from SimCC scores (keypoints x bins); the bins split each input
    pixel into len / size parts. Confidence is the mean of the two peaks, clipped to 0-1."""
    rx, ry = simcc_x.shape[1] / iw, simcc_y.shape[1] / ih
    ux, uy = simcc_x.argmax(axis=1), simcc_y.argmax(axis=1)
    conf = np.clip((simcc_x.max(axis=1) + simcc_y.max(axis=1)) / 2, 0, 1)
    return [(float(a / rx), float(b / ry), float(c)) for a, b, c in zip(ux, uy, conf)]


def to_mediapipe(points, mp_landmarks, layout):
    """The model's keypoints in MediaPipe's 33-landmark layout: [(x, y, visibility)], with
    MediaPipe's own value wherever the model has no matching point."""
    out = list(mp_landmarks)
    for k, i in TO_MP[layout].items():
        out[i] = tuple(points[k])
    return out


def lost(points) -> bool:
    """Too unsure of the body to crop the next frame around it."""
    return float(np.mean([points[k][2] for k in BODY])) < LOST


class BodyTracker:
    """Frame after frame, for one worker's run of frames: the crop comes from the previous frame's
    keypoints, or from MediaPipe's on the first frame and after a lost one."""

    def __init__(self, runner: Runner):
        self.runner = runner
        self.last = None            # the previous frame's keypoints, unless lost

    def frame(self, rgb, mp_landmarks):
        """MediaPipe's landmarks with the model's points in, or None when MediaPipe found no one."""
        if mp_landmarks is None:
            self.last = None
            return None
        h, w = rgb.shape[:2]
        box = box_of(self.last, w, h) if self.last is not None else None
        if box is None:
            box = box_of(mp_landmarks, w, h, min_conf=0)
        if box is None:
            self.last = None
            return mp_landmarks
        pts = self.runner.track(rgb, box)
        self.last = None if lost(pts) else pts
        return to_mediapipe(pts, mp_landmarks, self.runner.spec.layout)


_loaded: dict[tuple, Runner] = {}


def load(name: str, path: Path | str | None = None) -> Runner:
    """The model behind a backend name (not "mediapipe"), ready to run. Kept once loaded: the pose
    worker processes live across clips, and loading took ~1 s a clip in each."""
    if name not in SPECS:
        raise ValueError(f"no ONNX model for {name!r}: use one of {', '.join(SPECS)}")
    key = (name, str(path) if path else None)
    if key not in _loaded:
        _loaded[key] = Runner(name, path)
    return _loaded[key]


# ---- The club model ----

CLUB_DEFAULT = "raycast"
CLUB_BACKENDS = [CLUB_DEFAULT, "yolo"]
# train/club_train.py writes this; SWINGCLIPS_CLUB_MODEL points at another file.
CLUB_FILE = "club-yolo-pose.onnx"
CLUB_POINTS = ("grip", "hosel", "head")
# Input size when the file doesn't fix it (Ultralytics exports a fixed 640x640).
CLUB_SIZE = (640, 640)
# The crop for the club: the golfer's box grown by this share of its height on every side, then by
# MODEL_PAD and to the square input. The club reaches well past the body (a driver's head is ~0.65
# of nose-to-feet from the hands), and the golfer then fills about half the input, as in the whole
# upright frames the model is trained on.
CLUB_MARGIN = 0.25
# Ultralytics pads its letterbox (and mosaic) with this grey; outside the picture the crop gets it too.
LETTERBOX_FILL = 114


def club_backend() -> str:
    """The club backend chosen with SWINGCLIPS_CLUB_BACKEND (read each time, so tests can set it)."""
    name = os.environ.get("SWINGCLIPS_CLUB_BACKEND", CLUB_DEFAULT).strip().lower() or CLUB_DEFAULT
    if name not in CLUB_BACKENDS:
        raise ValueError(f"SWINGCLIPS_CLUB_BACKEND={name!r}: use one of {', '.join(CLUB_BACKENDS)}")
    return name


def club_model_path() -> Path:
    return Path(os.environ.get("SWINGCLIPS_CLUB_MODEL") or models_dir() / CLUB_FILE)


def club_stamp(path: Path | str | None = None) -> str:
    """What goes in the pose file's "clubModel": the file's name and the start of its SHA-1, e.g.
    club-yolo-pose@1a2b3c4d, since a retrained model keeps the name. "@missing" without the file."""
    path = Path(path) if path else club_model_path()
    if not path.is_file():
        return f"{path.stem}@missing"
    h = hashlib.sha1()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return f"{path.stem}@{h.hexdigest()[:8]}"


def club_box(points, w, h):
    """The crop for the club around the golfer's landmarks [(x, y, conf)] (picture units), in pixels;
    None without a box."""
    box = box_of(points, w, h, pad=0, min_conf=0)
    if box is None:
        return None
    m = CLUB_MARGIN * (box[3] - box[1])
    return box[0] - m, box[1] - m, box[2] + m, box[3] + m


class ClubRunner:
    """The club model. find() takes the upright RGB picture and the golfer's landmarks and gives
    (score, [(x, y, visibility)] for grip, hosel, head) in picture units (0-1), or None."""

    def __init__(self, path: Path | str | None = None, threads: int | None = None):
        import onnxruntime as ort
        self.path = Path(path) if path else club_model_path()
        if not self.path.is_file():
            raise FileNotFoundError(f"{self.path} is missing: train it (HOME-SETUP.md, \"Training the club "
                                    "model\") or point SWINGCLIPS_CLUB_MODEL at it")
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads or int(os.environ.get("SWINGCLIPS_ORT_THREADS", "1"))
        opts.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(self.path), opts, providers=["CPUExecutionProvider"])
        inp = self.session.get_inputs()[0]
        self.input_name = inp.name
        h, w = inp.shape[2:4]
        self.size = (w, h) if isinstance(w, int) and isinstance(h, int) else CLUB_SIZE

    def detect(self, rgb_crop):
        """(score, [(x, y, visibility)] per point) in the crop's pixels, for the likeliest club.

        Ultralytics' pose export without NMS: one output (1, 4 + classes + 3 * points, anchors), each
        anchor a box (centre, size), its class scores and the points' x, y and visibility, in input
        pixels, scores and visibility already 0-1. There's one club, so no NMS: the best anchor.
        """
        ch, cw = rgb_crop.shape[:2]
        iw, ih = self.size
        img = rgb_crop if (cw, ch) == (iw, ih) else cv2.resize(rgb_crop, (iw, ih), interpolation=cv2.INTER_LINEAR)
        x = (img.astype(np.float32) / 255).transpose(2, 0, 1)[None]
        out = self.session.run(None, {self.input_name: np.ascontiguousarray(x)})[0][0]
        k = len(CLUB_POINTS)
        classes = out.shape[0] - 4 - 3 * k
        if classes < 1:
            raise ValueError(f"{self.path.name}: output {out.shape} isn't a {k}-point YOLO pose model's")
        score = out[4:4 + classes].max(axis=0)
        i = int(score.argmax())
        pts = out[4 + classes:, i].reshape(k, 3)
        return float(score[i]), [(float(u) * cw / iw, float(v) * ch / ih, float(c)) for u, v, c in pts]

    def find(self, rgb, landmarks):
        if landmarks is None:
            return None
        h, w = rgb.shape[:2]
        box = club_box(landmarks, w, h)
        if box is None:
            return None
        patch, t = crop(rgb, box, self.size, fill=LETTERBOX_FILL)
        score, pts = self.detect(patch)
        return score, [(x / w, y / h, c) for x, y, c in uncrop(pts, t, self.size)]
