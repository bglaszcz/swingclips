"""The 3D calibration page (static/calibrate.html): record the boards and run calib.py from the
browser, so it can be done in the shed without a terminal on the server.

A calibration recording is a stretch of time: from its Start button until Calibrate (or Stop), the
clips the phones save are calibration clips (app.py tags them "calib" and leaves them out of the
trends, like drill swings), and Calibrate runs calib.py on them:
  lens  one phone's clips of the lens board -> calib.py lens --phone <name> --angle <angle> <clips>
  mat   the newest face-on and down-the-line clips of the mat board -> calib.py session <face> <dtl>
While a lens recording is on the phones keep LENS_PRE_S before the strike (status.py pre), so a
clap or knock after waving the board saves the waving.

calib.py runs as its own process (the same Python), one at a time; its printout is the result.
The stretches are kept in recordings.json (in calib.CALIB_DIR), so clips stay tagged after a restart.
"""
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

KINDS = ("lens", "mat")
ANGLES = ("face", "dtl")
# Seconds the phones keep before the strike during a lens recording (capture app: up to 8).
LENS_PRE_S = 6
# A recording left on ends after this long without the phones recording.
IDLE_END_S = 30 * 60
# A clip is named by when it starts, up to LENS_PRE_S before the clap: one that starts this long
# before the Start button still counts.
START_SLACK_S = LENS_PRE_S + 2
CALIB_PY = Path(__file__).with_name("calib.py")


class Runs:
    def __init__(self, path: Path, clock=time.time, python: str = sys.executable):
        self.path = Path(path)
        self.clock = clock
        self.python = python
        self.lock = threading.Lock()
        try:
            doc = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            doc = {}
        cur = doc.get("current")
        self.current: dict | None = cur if isinstance(cur, dict) and cur.get("kind") in KINDS else None
        self.periods: list[dict] = [p for p in doc.get("periods") or [] if isinstance(p, dict) and p.get("kind") in KINDS]
        self.job: dict | None = None

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"current": self.current, "periods": self.periods[-200:]}, indent=1), encoding="utf-8")
        tmp.replace(self.path)

    def _end(self, until: float) -> None:
        if self.current:
            self.periods.append({**self.current, "until": round(until, 3)})
            self.current = None
            self._save()

    def record(self, kind: str | None, angle: str | None = None) -> dict | None:
        """Starts a recording (ending any other) or stops it (kind None). Returns the one now on."""
        if kind is not None and kind not in KINDS:
            raise ValueError("Unknown calibration")
        if kind == "lens" and angle not in ANGLES:
            raise ValueError("Which phone? angle face or dtl")
        with self.lock:
            now = self.clock()
            self._end(now)
            if kind:
                self.current = {"kind": kind, "angle": angle if kind == "lens" else None, "from": round(now, 3)}
                self._save()
            return self.current

    def check(self, last_recording: float) -> None:
        """Ends a recording left on: no clip for IDLE_END_S since it started or the phones last recorded."""
        with self.lock:
            if self.current and self.clock() - max(self.current["from"], last_recording) > IDLE_END_S:
                self._end(max(self.current["from"], last_recording))

    def pre(self) -> int | None:
        """Seconds the phones should keep before the strike now, or None for the usual."""
        with self.lock:
            return LENS_PRE_S if self.current and self.current["kind"] == "lens" else None

    def kind_at(self, t: float) -> str | None:
        """The calibration being recorded at time t (s), or None."""
        with self.lock:
            # Inside a recording first; then one that started just after the clip did.
            for slack in (0, START_SLACK_S):
                if self.current and t >= self.current["from"] - slack:
                    return self.current["kind"]
                for p in reversed(self.periods):
                    if p["from"] - slack <= t <= p["until"]:
                        return p["kind"]
            return None

    def latest(self, kind: str, angle: str | None = None) -> dict | None:
        """The recording now on or the last one of this kind (and angle): {kind, angle, from, until?}."""
        with self.lock:
            for p in ([self.current] if self.current else []) + list(reversed(self.periods)):
                if p["kind"] == kind and (kind != "lens" or p["angle"] == angle):
                    return dict(p)
            return None

    def run(self, kind: str, args: list[str], clips: list[str]) -> dict:
        """Runs calib.py with `args` in the background; one at a time. The job: {kind, angle, ...}."""
        with self.lock:
            if self.job and self.job["code"] is None:
                raise ValueError("A calibration is already running")
            self.job = {"kind": kind, "angle": args[args.index("--angle") + 1] if "--angle" in args else None,
                        "clips": clips, "started": round(self.clock(), 3), "code": None, "output": ""}
            job = self.job
        # calib.py writes beside recordings.json, wherever the server's calibrations are.
        env = {**os.environ, "SWINGCLIPS_CALIB": str(self.path.parent)}
        proc = subprocess.Popen([self.python, "-u", str(CALIB_PY)] + args, cwd=str(CALIB_PY.parent), env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                encoding="utf-8", errors="replace")

        def follow():
            with proc.stdout:
                for line in proc.stdout:
                    with self.lock:
                        job["output"] += line
            code = proc.wait()
            with self.lock:
                job["code"] = code
                job["finished"] = round(self.clock(), 3)

        threading.Thread(target=follow, daemon=True).start()
        return dict(job)

    def state(self) -> dict:
        with self.lock:
            return {"current": self.current, "job": self.job and dict(self.job)}
