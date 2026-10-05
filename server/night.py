"""The night worker's side of the server: a PC with a GPU (tools/night_worker.py) analyzes every clip
again with bigger models than the server can run (a second opinion), while nobody is hitting balls.

The worker asks for a clip (next_clip), analyzes it the deep pass's way but with the whole-body
model (RTMW-l, hands too) on every frame on its GPU, and sends the pose file back (save). Nothing
the page shows comes from these files: they're compared with the server's own (compare), and where
the two place a key position far apart the swing is worth labeling (the Labels view lists those
first). They're also the start of training data for the next club and body models.

Files live in the "night" folder beside the pose folder: <clip>.json.gz like a pose file, with
"night": {"version": VERSION, ...} near the start, and compare.json (one entry per swing).
"""
import gzip
import json
import re
from pathlib import Path

# Bumped when the worker's way of analyzing changes: every clip is sent out again.
VERSION = 1
# What the worker runs (it reads these from /api/night/next, so the server decides). The club model is
# the server's own deep-pass one, which the worker downloads (/api/night/club) when its copy differs.
PROFILE = {"bodyModel": "rtmw", "bodyStride": 1}
# The key positions compared, in swing order (phases.js: p1 = address, p7 = impact).
POSITIONS = ("p1", "takeaway", "p2", "p3", "p4", "p5", "p6", "p7", "p8")


def night_file(night_dir: Path, name: str) -> Path:
    return night_dir / (name + ".json.gz")


def version_of(path: Path) -> int | None:
    """The VERSION a night file was made with (None without one): "night" is near the start."""
    try:
        with gzip.open(path, "rb") as g:
            head = g.read(300).decode("utf-8", "replace")
    except (OSError, EOFError):
        return None
    m = re.search(r'"night":\{"version":(\d+)', head)
    return int(m.group(1)) if m else None


def next_clip(clips: list[dict], night_dir: Path, labeled: set[str], skip: set[str]) -> dict | None:
    """The next clip for the worker: analyzed by the server (so they can be compared), without a
    current night file. Labeled clips first (they score the worker's models against the hand labels),
    then face-on before down-the-line, newest first. `clips` as listed by /api/clips; `skip` = clips
    handed out a moment ago or that failed."""
    todo = [c for c in clips if c["pose"] == "done" and c["name"] not in skip
            and version_of(night_file(night_dir, c["name"])) != VERSION]
    if not todo:
        return None
    return max(todo, key=lambda c: (c["name"] in labeled, c["angle"] == "face", c["recorded"]))


def save(night_dir: Path, name: str, body: bytes, worker: dict) -> dict:
    """Keeps a night pose file sent by the worker (gzip JSON, a pose file as pose.analyze makes it),
    with "night" put first. Returns what was kept in "night"."""
    doc = json.loads(gzip.decompress(body))
    if not isinstance(doc, dict) or not isinstance(doc.get("frames"), list):
        raise ValueError("not a pose file")
    stamp = {"version": VERSION, **{k: v for k, v in worker.items() if k != "version"}}
    doc.pop("night", None)
    doc = {"night": stamp, **doc}
    night_dir.mkdir(parents=True, exist_ok=True)
    out = night_file(night_dir, name)
    tmp = out.with_suffix(".tmp")
    tmp.write_bytes(gzip.compress(json.dumps(doc, separators=(",", ":")).encode()))
    tmp.replace(out)
    return stamp


def differences(server: dict | None, night: dict | None) -> dict[str, float]:
    """Each key position both have, night minus server, in ms."""
    a, b = (server or {}).get("times") or {}, (night or {}).get("times") or {}
    return {p: round((b[p] - a[p]) * 1000, 1) for p in POSITIONS
            if isinstance(a.get(p), (int, float)) and isinstance(b.get(p), (int, float))}


def worst(diff: dict[str, float]) -> tuple[str, float] | None:
    """The key position the two disagree on most, and by how much (ms, signed)."""
    if not diff:
        return None
    p = max(diff, key=lambda k: abs(diff[k]))
    return p, diff[p]


def load_compare(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def save_compare(path: Path, table: dict) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(table, separators=(",", ":")))
    tmp.replace(path)
