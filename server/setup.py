"""Camera setup: each phone, while it isn't recording, sends a still of its preview about once a
second. The golfer is found in it (MediaPipe, one picture at a time) and judged with the page's own
setupAdvice (static/summary.js, via swings.Summarizer): what's wrong and what to do, which the phone
says out loud and the Camera setup page shows, plus where the golfer is for the phone to focus on.

With 3D on (calib.py), each still is also searched for the mat board: when a phone sees it, its
position is solved and it says so; once both have seen it within BOARD_PAIR_SECONDS, the pair is
saved as the session's calibration.
"""
import threading
import time
from pathlib import Path

import cv2
import numpy as np

import pose
import swings

ANGLES = ("face", "dtl")
# Both phones' views of the board count as one calibration when this close together (s).
BOARD_PAIR_SECONDS = 60
# The pose model works on a small input anyway; stills are scaled to this height first.
HEIGHT = 640


class Setup:
    """The latest still and verdict per camera. Thread-safe; close() when done."""

    def __init__(self, static_dir: Path, lens_for=None):
        self.lock = threading.Lock()
        # lens_for(angle) -> the lens calibration for that phone's current mode, or None (calib.py).
        self.lens_for = lens_for
        self.board: dict[str, tuple[float, dict]] = {}   # angle -> (time, camera) from the last still with it
        self.saved = None                                   # the board sightings last saved as a session
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
        board_seen = self._board(angle, img)
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
            if board_seen:
                # The board on the mat, not a golfer, is what this still is for.
                verdict.update(ok=True, codes=[], board=board_seen, text=board_seen["text"], say=board_seen["say"])
            verdict["lm"] = lm
            verdict["time"] = time.time()
            self.latest[angle] = {"verdict": verdict, "jpeg": upright.tobytes() if ok else jpeg}
        return verdict

    def _board(self, angle: str, img) -> dict | None:
        """Looks for the mat board (only with 3D on and the phone's lens calibrated); when both
        phones have seen it lately, saves the pair as a calibration session. What to say, or None."""
        import board
        import calib
        if not calib.enabled() or self.lens_for is None:
            return None
        lens = self.lens_for(angle)
        if lens is None:
            return None
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        cam_name = "Down the line" if angle == "dtl" else "Face on"
        try:
            cam = calib.camera_from_pictures([gray], angle, lens, board.MAT, f"setup still ({angle})")
        except ValueError:
            return None
        if cam["rms"] > calib.POSE_RMS:
            return {"placed": False, "text": f"Board seen but not clearly ({cam['rms']:.1f} px): more light, or a bigger board.",
                    "say": f"{cam_name}: I can see the board, but not clearly."}
        now = time.time()
        with self.lock:
            self.board[angle] = (now, cam)
            other = self.board.get("dtl" if angle == "face" else "face")
            pair = (other is not None and now - other[0] <= BOARD_PAIR_SECONDS
                    and not cam["warnings"] and not other[1]["warnings"])
            saved = False
            if pair:
                key = tuple(self.board[a][0] for a in ANGLES)
                if self.saved is None or all(k > s + BOARD_PAIR_SECONDS for k, s in zip(key, self.saved)):
                    calib.save_session({a: self.board[a][1] for a in ANGLES})
                    self.saved = key
                    saved = True
        warn = "; ".join(cam["warnings"])
        text = f"Board seen: camera placed ({cam['rms']:.1f} px)." + (f" {warn}." if warn else "")
        say = f"{cam_name}: board seen." + (" Both cameras are calibrated for 3D." if saved or pair else "")
        if warn:
            say = f"{cam_name}: board seen, but it looks turned round."
        return {"placed": True, "saved": saved, "rms": cam["rms"], "position": cam["position"], "text": text, "say": say}

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
