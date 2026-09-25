"""Stand-ins for real model weights and real clips, for testing models.py and pose.py's plumbing.

simcc_model() writes a tiny ONNX model shaped like RTMPose (input 1x3xHxW, SimCC outputs 1xKx2W and
1xKx2H) that puts each keypoint on the brightest pixel of one colour of its input; club_model() one
shaped like the club model's YOLO pose export. They're written as raw protobuf, so the tests need
only onnxruntime, not the onnx package.

clip() writes a short video of a drawn figure with a red dot moving across the chest and a blue one
between the feet, for the fake model to find: the ankles on the blue one, the rest on the red. mediapipe() stands in for MediaPipe's pose landmarker: it finds the figure by its colour and
puts the 33 landmarks at fixed places in its box. (The real one only sometimes takes a drawing for a
person, and on Linux mediapipe 1.0.1 crashes reading its own segmentation mask.)
"""
import sys
import types
from unittest import mock

import av
import cv2
import numpy as np


# ---- Protobuf, just enough of ONNX's ----

def _varint(n: int) -> bytes:
    n &= (1 << 64) - 1
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def _int(field: int, n: int) -> bytes:
    return _varint(field << 3) + _varint(n)


def _bytes(field: int, data: bytes | str) -> bytes:
    data = data.encode() if isinstance(data, str) else data
    return _varint(field << 3 | 2) + _varint(len(data)) + data


FLOAT, INT64 = 1, 7


def _tensor(name: str, array: np.ndarray) -> bytes:
    kind = {np.float32: FLOAT, np.int64: INT64}[array.dtype.type]
    return (b"".join(_int(1, d) for d in array.shape) + _int(2, kind) + _bytes(8, name)
            + _bytes(9, np.ascontiguousarray(array).tobytes()))


def _value_info(name: str, shape) -> bytes:
    dims = b"".join(_bytes(1, _int(1, d)) for d in shape)
    tensor_type = _int(1, FLOAT) + _bytes(2, dims)
    return _bytes(1, name) + _bytes(2, _bytes(1, tensor_type))


def _node(op: str, inputs, outputs, **ints) -> bytes:
    out = b"".join(_bytes(1, i) for i in inputs) + b"".join(_bytes(2, o) for o in outputs) + _bytes(4, op)
    for name, value in ints.items():
        if isinstance(value, (list, tuple)):
            attr = _bytes(1, name) + b"".join(_int(8, v) for v in value) + _int(20, 7)     # INTS
        else:
            attr = _bytes(1, name) + _int(3, value) + _int(20, 2)                           # INT
        out += _bytes(5, attr)
    return out


def simcc_model(path, width: int = 192, height: int = 256, channels=(0,) * 17) -> None:
    """RTMPose's shape, finding the brightest pixel: for keypoint k, colour channels[k] (0 red, 1
    green, 2 blue), its max over rows (for x) and columns (for y), spread onto 2 SimCC bins per pixel."""
    keypoints = len(channels)
    ux = np.zeros((width, 2 * width), np.float32)
    ux[np.arange(width), 2 * np.arange(width)] = 1
    uy = np.zeros((height, 2 * height), np.float32)
    uy[np.arange(height), 2 * np.arange(height)] = 1
    nodes = [
        _node("Gather", ["input", "channels"], ["planes"], axis=1),
        _node("ReduceMax", ["planes"], ["cols"], axes=[2], keepdims=0),
        _node("ReduceMax", ["planes"], ["rows"], axes=[3], keepdims=0),
        _node("MatMul", ["cols", "ux"], ["simcc_x"]),
        _node("MatMul", ["rows", "uy"], ["simcc_y"]),
    ]
    graph = (b"".join(_bytes(1, n) for n in nodes) + _bytes(2, "fake-rtmpose")
             + _bytes(5, _tensor("ux", ux)) + _bytes(5, _tensor("uy", uy))
             + _bytes(5, _tensor("channels", np.array(channels, np.int64)))
             + _bytes(11, _value_info("input", (1, 3, height, width)))
             + _bytes(12, _value_info("simcc_x", (1, keypoints, 2 * width)))
             + _bytes(12, _value_info("simcc_y", (1, keypoints, 2 * height))))
    model = _int(1, 8) + _bytes(2, "swingclips-tests") + _bytes(7, graph) + _bytes(8, _bytes(1, "") + _int(2, 13))
    with open(path, "wb") as f:
        f.write(model)


def club_model(path, size: int = 320, score: float = 0.9) -> None:
    """A YOLO11 pose export's shape for the club (input 1x3xSxS, output 1 x 14 x anchors): two
    anchors, the first with a box score of `score` and its grip end on the brightest red pixel, the
    hosel on the brightest green, the clubhead on the brightest blue; each point's visibility is
    how bright that is past 0.7 of full. The second anchor is a weak (0.1) decoy with its points
    in a corner, which the runner must pass over."""
    nodes = [
        _node("Gather", ["images", "channels"], ["planes"], axis=1),
        _node("ReduceMax", ["planes"], ["cols"], axes=[2], keepdims=0),
        _node("ArgMax", ["cols"], ["xi"], axis=2, keepdims=0),
        _node("Cast", ["xi"], ["x"], to=FLOAT),
        _node("ReduceMax", ["planes"], ["rows"], axes=[3], keepdims=0),
        _node("ArgMax", ["rows"], ["yi"], axis=2, keepdims=0),
        _node("Cast", ["yi"], ["y"], to=FLOAT),
        _node("ReduceMax", ["planes"], ["peak"], axes=[2, 3], keepdims=0),
        _node("Sub", ["peak", "floor"], ["over"]),
        _node("Mul", ["over", "gain"], ["overg"]),
        _node("Relu", ["overg"], ["v"]),
        _node("Unsqueeze", ["x", "last"], ["x3"]),
        _node("Unsqueeze", ["y", "last"], ["y3"]),
        _node("Unsqueeze", ["v", "last"], ["v3"]),
        _node("Concat", ["x3", "y3", "v3"], ["xyv"], axis=2),
        _node("Reshape", ["xyv", "kp_shape"], ["kp"]),
        _node("Concat", ["box", "kp"], ["row"], axis=1),
        _node("Reshape", ["row", "col_shape"], ["col"]),
        _node("Concat", ["col", "decoy"], ["output0"], axis=2),
    ]
    decoy = np.array([size / 2, size / 2, 10, 10, 0.1] + [2, 2, 1] * 3, np.float32).reshape(1, 14, 1)
    consts = {"channels": np.array([0, 1, 2], np.int64), "floor": np.array([0.7], np.float32),
              "gain": np.array([1 / 0.3], np.float32), "last": np.array([2], np.int64),
              "kp_shape": np.array([1, 9], np.int64), "col_shape": np.array([1, 14, 1], np.int64),
              "box": np.array([[size / 2, size / 2, size / 4, size / 4, score]], np.float32), "decoy": decoy}
    graph = (b"".join(_bytes(1, n) for n in nodes) + _bytes(2, "fake-club-yolo")
             + b"".join(_bytes(5, _tensor(k, v)) for k, v in consts.items())
             + _bytes(11, _value_info("images", (1, 3, size, size)))
             + _bytes(12, _value_info("output0", (1, 14, 2))))
    model = _int(1, 8) + _bytes(2, "swingclips-tests") + _bytes(7, graph) + _bytes(8, _bytes(1, "") + _int(2, 13))
    with open(path, "wb") as f:
        f.write(model)


# ---- A clip ----

W, H = 540, 960            # upright, as stored for rotation 0; pose.py works on half of it
FPS, FRAMES = 60, 48


RED, BLUE = 0, 2
FEET = (0.5, 0.87)          # the blue dot, between the feet
# The ankles (COCO 15 and 16) look for blue, everything else for red.
CHANNELS = tuple(BLUE if k in (15, 16) else RED for k in range(17))


def sway(k: int) -> int:
    """How far the figure is moved right in frame k (pixels): a slow sway with some jitter, so the
    smoothing has something to do."""
    return int(round(20 * np.sin(k / 6) + (7 * k * k) % 5 - 2))


def dot_at(k: int) -> tuple[float, float]:
    """Where the red dot is in frame k, in upright picture units: across the chest."""
    return 0.4 + 0.2 * k / (FRAMES - 1), 0.35


def figure(k: int) -> np.ndarray:
    """Frame k upright, RGB: a plain drawn figure with the dots on it."""
    img = np.full((H, W, 3), (90, 110, 80), np.uint8)
    cx = W // 2 + sway(k)
    skin, shirt, pants = (200, 160, 130), (40, 70, 160), (40, 40, 50)
    cv2.ellipse(img, (cx, 140), (44, 56), 0, 0, 360, skin, -1)
    cv2.rectangle(img, (cx - 70, 210), (cx + 70, 460), shirt, -1)
    cv2.line(img, (cx - 64, 230), (cx - 110, 460), shirt, 36)
    cv2.line(img, (cx + 64, 230), (cx + 110, 460), shirt, 36)
    cv2.circle(img, (cx - 110, 476), 18, skin, -1)
    cv2.circle(img, (cx + 110, 476), 18, skin, -1)
    cv2.line(img, (cx - 36, 460), (cx - 56, 840), pants, 52)
    cv2.line(img, (cx + 36, 460), (cx + 56, 840), pants, 52)
    cv2.ellipse(img, (cx - 70, 856), (40, 16), 0, 0, 360, (20, 20, 20), -1)
    cv2.ellipse(img, (cx + 70, 856), (40, 16), 0, 0, 360, (20, 20, 20), -1)
    x, y = dot_at(k)
    cv2.circle(img, (int(round(x * W)), int(round(y * H))), 7, (255, 0, 0), -1)
    cv2.circle(img, (int(FEET[0] * W), int(FEET[1] * H)), 7, (0, 0, 255), -1)
    return img


# How to store an upright picture so that turning it `rotation` clockwise shows it upright again.
STORE = {90: cv2.ROTATE_90_COUNTERCLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_CLOCKWISE}


def clip(path, rotation: int = 0) -> None:
    """The figure as an H.264 .mp4, stored turned and tagged the way a phone does for `rotation`."""
    with av.open(str(path), "w") as c:
        s = c.add_stream("libx264", rate=FPS)
        stored = STORE.get(rotation)
        s.width, s.height = (H, W) if rotation in (90, 270) else (W, H)
        s.pix_fmt = "yuv420p"
        s.options = {"g": "12", "crf": "12"}         # a keyframe every 12 frames, as sharp as needed
        if rotation:
            s.set_display_rotation(-rotation)         # pose.probe reads it back as `rotation`
        for k in range(FRAMES):
            img = figure(k)
            if stored is not None:
                img = cv2.rotate(img, stored)
            for p in s.encode(av.VideoFrame.from_ndarray(img, format="rgb24")):
                c.mux(p)
        for p in s.encode():
            c.mux(p)


# ---- MediaPipe's pose landmarker, faked ----

BACKGROUND = np.array((90, 110, 80))
# Each landmark's place in the figure's box (0-1 across, 0-1 down), in MediaPipe's order, from how
# figure() is drawn. The figure faces the camera: their left is on the picture's right.
_BOX = [(0.5, 0.11)] + [(0.5 + 0.03 * (i % 3 - 1), 0.1) for i in range(1, 7)] + [
    (0.56, 0.11), (0.44, 0.11), (0.53, 0.16), (0.47, 0.16),             # ears, mouth
    (0.7, 0.2), (0.3, 0.2), (0.8, 0.36), (0.2, 0.36), (0.92, 0.51), (0.08, 0.51),   # shoulders, elbows, wrists
    (0.93, 0.54), (0.07, 0.54), (0.92, 0.55), (0.08, 0.55), (0.9, 0.53), (0.1, 0.53),  # pinkies, index, thumbs
    (0.62, 0.5), (0.38, 0.5), (0.63, 0.7), (0.37, 0.7), (0.65, 0.93), (0.35, 0.93),   # hips, knees, ankles
    (0.64, 0.96), (0.36, 0.96), (0.72, 0.97), (0.28, 0.97)]                         # heels, toes


class _Point:
    def __init__(self, x, y, z=0.0, visibility=0.9):
        self.x, self.y, self.z, self.visibility = x, y, z, visibility


class _Mask:
    def __init__(self, mask):
        self._mask = mask

    def numpy_view(self):
        return self._mask


class _Landmarker:
    """Finds the figure: every pixel far from the background colour."""

    @classmethod
    def create_from_options(cls, options):
        return cls()

    def detect_for_video(self, image, ms):
        rgb = image.data
        person = np.abs(rgb.astype(int) - BACKGROUND).max(axis=2) > 40
        ys, xs = np.nonzero(person)
        res = types.SimpleNamespace(pose_landmarks=[], pose_world_landmarks=[], segmentation_masks=[])
        if len(xs) < 50:
            return res
        h, w = person.shape
        x0, x1, y0, y1 = xs.min() / w, xs.max() / w, ys.min() / h, ys.max() / h
        res.pose_landmarks = [[_Point(x0 + u * (x1 - x0), y0 + v * (y1 - y0)) for u, v in _BOX]]
        # Metres, origin between the hips, y down: a 1.7 m person standing straight.
        res.pose_world_landmarks = [[_Point((u - 0.5) * 0.8, (v - 0.5) * 1.7, 0.0) for u, v in _BOX]]
        res.segmentation_masks = [_Mask(person.astype(np.float32))]
        return res

    def close(self):
        pass


def mediapipe():
    """A context in which `import mediapipe` (as pose.run_chunk does it) gets the fake."""
    mp = types.ModuleType("mediapipe")
    mp.Image = lambda image_format, data: types.SimpleNamespace(data=data)
    mp.ImageFormat = types.SimpleNamespace(SRGB="srgb")
    tasks, python, vision = (types.ModuleType(n) for n in
                             ("mediapipe.tasks", "mediapipe.tasks.python", "mediapipe.tasks.python.vision"))
    python.BaseOptions = lambda **kw: kw
    vision.PoseLandmarker = _Landmarker
    vision.PoseLandmarkerOptions = lambda **kw: kw
    vision.RunningMode = types.SimpleNamespace(VIDEO="video")
    mp.tasks, tasks.python, python.vision = tasks, python, vision
    return mock.patch.dict(sys.modules, {"mediapipe": mp, "mediapipe.tasks": tasks,
                                         "mediapipe.tasks.python": python, "mediapipe.tasks.python.vision": vision})


class Pool:
    """Runs pose.py's jobs one after another in this process, where the fakes are."""

    def map(self, fn, items):
        return [fn(i) for i in items]

    def shutdown(self, **kw):
        pass
