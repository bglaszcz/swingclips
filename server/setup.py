"""Camera setup: each phone, while it isn't recording, sends a still of its preview about once a
second. The golfer is found in it (MediaPipe, one picture at a time) and judged with the page's own
setupAdvice (static/summary.js, via swings.Summarizer): what's wrong and what to do, which the phone
says out loud and the Camera setup page shows, plus where the golfer is for the phone to focus on.
"""
import threading
import time
from pathlib import Path

import cv2
import numpy as np

import pose
import swings

ANGLES = ("face", "dtl")
# The pose model works on a small input anyway; stills are scaled to this height first.
HEIGHT = 640


class Setup:
    """The latest still and verdict per camera. Thread-safe; close() when done."""

    def __init__(self, static_dir: Path):
        self.lock = threading.Lock()
        self.static_dir = static_dir
        self.landmarker = None
        self.summarizer: swings.Summarizer | None = None
        self.latest: dict[str, dict] = {}

    def _models(self):
        if self.landmarker is None:
            from mediapipe.tasks.python import BaseOptions
            from mediapipe.tasks.python.vision import PoseLandmarker, PoseLandmarkerOptions, RunningMode
            self.landmarker = PoseLandmarker.create_from_options(PoseLandmarkerOptions(
                base_options=BaseOptions(model_asset_path=pose.MODEL), running_mode=RunningMode.IMAGE, num_poses=1))
            self.summarizer = swings.Summarizer(self.static_dir)
        return self.landmarker, self.summarizer

    def judge(self, angle: str, jpeg: bytes, rotation: int) -> dict:
        """Finds the golfer in a still and keeps it as the camera's latest. Returns the verdict."""
        import mediapipe as mp
        img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("not a picture")
        if rotation in pose.ROTATE_CW:
            img = cv2.rotate(img, pose.ROTATE_CW[rotation])
        if img.shape[0] > HEIGHT:
            img = cv2.resize(img, None, fx=HEIGHT / img.shape[0], fy=HEIGHT / img.shape[0], interpolation=cv2.INTER_AREA)
        ok, upright = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 80])
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        with self.lock:
            landmarker, summarizer = self._models()
            res = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)))
            lm = None
            if res.pose_landmarks:
                lm = [round(v, 4) for p in res.pose_landmarks[0] for v in (p.x, p.y, p.visibility)]
            verdict = summarizer.call("setupAdvice", lm, angle)
            verdict["lm"] = lm
            verdict["time"] = time.time()
            self.latest[angle] = {"verdict": verdict, "jpeg": upright.tobytes() if ok else jpeg}
        return verdict

    def status(self) -> dict:
        """Each camera's latest verdict and how old it is (s), or None if it hasn't sent one."""
        now = time.time()
        with self.lock:
            return {a: ({**self.latest[a]["verdict"], "age": round(now - self.latest[a]["verdict"]["time"], 1)}
                        if a in self.latest else None) for a in ANGLES}

    def picture(self, angle: str) -> bytes | None:
        with self.lock:
            return self.latest[angle]["jpeg"] if angle in self.latest else None

    def close(self) -> None:
        with self.lock:
            if self.landmarker is not None:
                self.landmarker.close()
                self.landmarker = None
            if self.summarizer is not None:
                self.summarizer.close()
                self.summarizer = None
