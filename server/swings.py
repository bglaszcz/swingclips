"""Each swing's numbers for the trends, worked out on the server with the review page's own
JavaScript (static/phases.js, metrics.js, summary.js), run in an embedded V8 (mini-racer), so the page
and the server can't disagree.

A record per swing, keyed by the clip the swing is listed by (face-on, or a lone down-the-line one):
{partner, code, body, quality, setup}. `code` fingerprints the JavaScript: after an update changes
it, every swing is worked out again in the background.
"""
import gzip
import hashlib
import json
import threading
from pathlib import Path

from py_mini_racer import MiniRacer

JS_FILES = ("phases.js", "metrics.js", "summary.js")
# The trends assume a right-handed golfer (the lead side is the left).
LEAD_SIDE = "left"
# V8 sets itself up when the first engine starts; two threads starting one at once crash the process
# ("Check failed: !IsConfigurablePoolInitialized()"). The pose and swing workers both start one.
START_LOCK = threading.Lock()


class Summarizer:
    """Runs SwingSummary.summarize. Use from one thread; close() when done, or the process can't exit."""

    def __init__(self, static_dir: Path):
        self.sources = [(static_dir / f).read_text(encoding="utf-8") for f in JS_FILES]
        self.code = hashlib.sha1("\n".join(self.sources).encode()).hexdigest()[:12]
        self.ctx: MiniRacer | None = None

    def summarize(self, main: dict, other: dict | None) -> dict:
        return self.call("summarize", main, other, LEAD_SIDE)

    def call(self, function: str, *args):
        """SwingSummary.<function>(*args), with the arguments and result passed as JSON."""
        if self.ctx is None:
            with START_LOCK:
                self.ctx = MiniRacer()
            for source in self.sources:
                self.ctx.eval(source)
        args = json.dumps(list(args), separators=(",", ":"))
        return json.loads(self.ctx.eval(f"JSON.stringify(SwingSummary.{function}(...{args}))"))

    def close(self) -> None:
        if self.ctx is not None:
            self.ctx.close()
            self.ctx = None


def pose_input(clip: dict, pose_path: Path) -> dict:
    """A clip (as listed by /api/clips) and its pose file, in the shape SwingSummary takes."""
    data = json.loads(gzip.decompress(pose_path.read_bytes()))
    return {"name": clip["name"], "strike": clip["strike"], "angle": clip["angle"],
            "rotation": data.get("rotation", 0), "frames": data["frames"],
            "impact": data.get("impact"), "ball": data.get("ball")}


def load(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save(path: Path, records: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(records, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)
