"""SwingClips home server: lists the clips in CLIPS_DIR and serves them to any browser on the LAN.
A background worker runs pose on each new clip and saves it to POSE_DIR for the skeleton overlay.

Run with "Start server.cmd", or:  .venv\\Scripts\\python.exe app.py
Settings (environment variables): SWINGCLIPS_CLIPS (clips folder), SWINGCLIPS_POSE (pose results,
default: a "pose" folder next to the clips folder), SWINGCLIPS_PORT (default 8000),
SWINGCLIPS_POSE_MODEL (MediaPipe .task file; default public/mediapipe/pose_landmarker_full.task).
"""
import glob
import gzip
import json
import os
import re
import threading
import time
import traceback
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import pose

CLIPS_DIR = Path(os.environ.get("SWINGCLIPS_CLIPS", r"D:\SwingClips\clips"))
POSE_DIR = Path(os.environ.get("SWINGCLIPS_POSE", CLIPS_DIR.parent / "pose"))
# Deleted clips (and their pose files) go here rather than being erased, so a delete can be undone.
TRASH_DIR = Path(os.environ.get("SWINGCLIPS_TRASH", CLIPS_DIR.parent / "trash"))
PORT = int(os.environ.get("SWINGCLIPS_PORT", "8000"))
STATIC_DIR = Path(__file__).parent / "static"
VIDEO_TYPES = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm"}
# Leave a few cores for serving video; pose splits each clip across this many processes.
POSE_WORKERS = max(1, min(4, (os.cpu_count() or 4) // 3))
# A clip still being copied in keeps changing; wait until it has been left alone this long.
SETTLE_SECONDS = 15

# Probe clips end in _<unix seconds>.mp4, e.g. c0_1920x1080_240_hs_1789123456.mp4
UNIX_TIME_SUFFIX = re.compile(r"_(\d{10})$")

# Name of the clip the worker is on right now, if any.
pose_busy: str | None = None
# Deleted but not yet moved: Windows can't move a file that's open (being analyzed, or streaming to a
# browser), so these are hidden right away and moved as soon as they're free.
pending_trash: set[str] = set()
files_lock = threading.Lock()


def clip_paths():
    if not CLIPS_DIR.is_dir():
        return []
    return [p for p in CLIPS_DIR.iterdir() if p.is_file() and p.suffix.lower() in VIDEO_TYPES]


def pose_file(name: str) -> Path:
    # Stored gzipped (~800 KB of JSON per clip shrinks about 3x) and sent as-is with Content-Encoding.
    # Named by version, so clips analyzed by an older pose.py are simply analyzed again.
    return POSE_DIR / f"{name}.v{pose.VERSION}.json.gz"


def error_file(name: str) -> Path:
    return POSE_DIR / (name + ".error.txt")


def pose_state(name: str) -> str:
    if pose_file(name).exists():
        return "done"
    if error_file(name).exists():
        return "failed"
    return "processing" if name == pose_busy else "queued"


def pose_worker(stop: threading.Event):
    """Forever: find clips without pose results, newest first, and analyze them one at a time."""
    global pose_busy
    POSE_DIR.mkdir(parents=True, exist_ok=True)
    # Kept between clips so the worker processes only pay for importing MediaPipe once.
    pool = ProcessPoolExecutor(POSE_WORKERS)
    while not stop.is_set():
        retry_pending_trash()
        todo = [p for p in clip_paths()
                if pose_state(p.name) == "queued" and time.time() - p.stat().st_mtime > SETTLE_SECONDS]
        if not todo:
            stop.wait(5)
            continue
        clip = max(todo, key=recorded_at)
        with files_lock:
            if not clip.exists() or clip.name in pending_trash:
                continue
            pose_busy = clip.name
        print(f"Pose: {clip.name} ...", flush=True)
        try:
            result = pose.analyze(str(clip), pool, POSE_WORKERS)
            tmp = pose_file(clip.name).with_suffix(".tmp")
            tmp.write_bytes(gzip.compress(json.dumps(result, separators=(",", ":")).encode()))
            tmp.replace(pose_file(clip.name))
            found = sum(f["lm"] is not None for f in result["frames"])
            impact = f"impact at {result['impact']} s" if result["impact"] is not None else "ball not found"
            print(f"Pose: {clip.name} done in {result['seconds']} s, "
                  f"{found}/{len(result['frames'])} frames with a person, {impact}", flush=True)
        except Exception as e:
            error_file(clip.name).write_text(traceback.format_exc())
            print(f"Pose: {clip.name} FAILED - see {error_file(clip.name)}", flush=True)
            if isinstance(e, BrokenProcessPool):
                # A worker process died (e.g. a bad video crashed the decoder); start fresh ones.
                pool = ProcessPoolExecutor(POSE_WORKERS)
        finally:
            with files_lock:
                pose_busy = None
    pool.shutdown(cancel_futures=True)


def try_trash(name: str) -> None:
    """Moves a pending clip to the trash if nothing has it open. Call with files_lock held."""
    if name == pose_busy:
        return
    try:
        move_clip(name, to_trash=True)
        pending_trash.discard(name)
    except OSError:
        pass  # still open somewhere; the worker loop tries again


def retry_pending_trash() -> None:
    with files_lock:
        for name in list(pending_trash):
            try_trash(name)


def move_clip(name: str, to_trash: bool) -> bool:
    """Moves a clip and its pose files into the trash, or back out. False if it isn't there."""
    src_clips, dst_clips = (CLIPS_DIR, TRASH_DIR) if to_trash else (TRASH_DIR, CLIPS_DIR)
    src_pose, dst_pose = (POSE_DIR, TRASH_DIR / "pose") if to_trash else (TRASH_DIR / "pose", POSE_DIR)
    if not (src_clips / name).is_file():
        return False
    dst_clips.mkdir(parents=True, exist_ok=True)
    dst_pose.mkdir(parents=True, exist_ok=True)
    (src_clips / name).replace(dst_clips / name)
    # Every pose file for the clip, older versions included.
    for f in src_pose.glob(glob.escape(name) + ".*"):
        f.replace(dst_pose / f.name)
    return True


@asynccontextmanager
async def lifespan(app: FastAPI):
    stop = threading.Event()
    threading.Thread(target=pose_worker, args=(stop,), daemon=True).start()
    yield
    stop.set()


app = FastAPI(title="SwingClips", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def recorded_at(path: Path) -> float:
    """When the clip was recorded: from its filename if it carries a timestamp, else file mtime.

    Clips copied off the phone with adb get the copy time as mtime, so the name is more accurate.
    """
    m = UNIX_TIME_SUFFIX.search(path.stem)
    return float(m.group(1)) if m else path.stat().st_mtime


@app.get("/api/clips")
def list_clips():
    if not CLIPS_DIR.is_dir():
        raise HTTPException(503, f"Clips folder not found: {CLIPS_DIR}")
    clips = []
    for p in clip_paths():
        if p.name in pending_trash:
            continue
        t = recorded_at(p)
        clips.append({
            "name": p.name,
            "size": p.stat().st_size,
            "recorded": datetime.fromtimestamp(t).isoformat(timespec="seconds"),
            "pose": pose_state(p.name),
            "_t": t,
        })
    # Only the capture app's clips are named after the strike itself.
    shots = match_shots({c["name"]: c["_t"] for c in clips if c["name"].startswith("swing_")})
    for c in clips:
        c["shot"] = shots.get(c["name"])
    clips.sort(key=lambda c: c.pop("_t"), reverse=True)
    return clips


def checked_clip(name: str) -> Path:
    # Only plain filenames of videos directly inside CLIPS_DIR - no paths.
    path = CLIPS_DIR / name
    if Path(name).name != name or path.suffix.lower() not in VIDEO_TYPES or not path.is_file():
        raise HTTPException(404, "No such clip")
    return path


@app.get("/clips/{name}")
def get_clip(name: str):
    path = checked_clip(name)
    # FileResponse handles Range requests, which browsers need to seek in a video.
    return FileResponse(path, media_type=VIDEO_TYPES[path.suffix.lower()])


UPLOAD_NAME = re.compile(r"^[A-Za-z0-9_.-]{1,120}\.(mp4|mov|webm)$")


@app.post("/api/upload")
async def upload(name: str, request: Request):
    """The capture app sends each clip as the raw request body: POST /api/upload?name=<file name>."""
    if not UPLOAD_NAME.match(name) or name.startswith("."):
        raise HTTPException(400, "Bad clip name")
    CLIPS_DIR.mkdir(parents=True, exist_ok=True)
    final = CLIPS_DIR / name
    # A retry after a lost response: already have it, so say so rather than keep a second copy.
    if final.exists():
        return {"ok": True, "size": final.stat().st_size, "duplicate": True}
    # Written under a name the clip list and pose worker ignore, then renamed once complete.
    part = CLIPS_DIR / (name + ".part")
    size = 0
    try:
        with open(part, "wb") as f:
            async for chunk in request.stream():
                f.write(chunk)
                size += len(chunk)
        expected = request.headers.get("x-clip-size")
        if expected is not None and int(expected) != size:
            raise HTTPException(400, f"Upload cut short: got {size} of {expected} bytes")
        part.replace(final)
    finally:
        part.unlink(missing_ok=True)
    print(f"Upload: {name} ({size / 1e6:.1f} MB)", flush=True)
    return {"ok": True, "size": size}


# ---- Launch monitor shots ----
# The shot listener on the sim laptop posts each shot here as the launch monitor reports it. Shots
# are paired with clips by time: the capture app names each clip after the second it heard the
# strike, and the launch monitor's report arrives a moment later.
SHOTS_FILE = Path(os.environ.get("SWINGCLIPS_SHOTS", CLIPS_DIR.parent / "shots.jsonl"))
# Typical seconds from strike to report, per source. Square's own app saves a shot ~14 s after the
# strike (measured 13.6-14.2 s over a real session; its ball-flight animation plays first, or the
# laptop clock runs ahead); the GSPro connector reports within about a second. A shot pairs with
# the clip whose gap is closest to its source's delay, within SHOT_SLACK_S of it.
SHOT_DELAY_S = {"square-app": 14.0}
DEFAULT_SHOT_DELAY_S = 1.0
SHOT_SLACK_S = 5.0


@app.post("/api/shots")
async def add_shot(request: Request):
    shot = await request.json()
    if not isinstance(shot, dict) or "received" not in shot or "ball" not in shot:
        raise HTTPException(400, "Expected a shot with 'received' and 'ball'")
    sent = datetime.fromisoformat(shot["received"])  # rejects a bad timestamp
    # Our own clock too: the difference shows whether the sending PC's clock is off.
    shot["serverReceived"] = datetime.now().astimezone().isoformat(timespec="milliseconds")
    skew = datetime.now().astimezone().timestamp() - sent.timestamp()
    if abs(skew) > 3:
        print(f"Shot: sender's clock is {-skew:+.1f} s off from this server's", flush=True)
    SHOTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with files_lock, open(SHOTS_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(shot, separators=(",", ":")) + "\n")
    print(f"Shot: {shot.get('club')} ball {shot['ball'].get('speed')} mph", flush=True)
    return {"ok": True}


def load_shots() -> list[dict]:
    if not SHOTS_FILE.exists():
        return []
    shots = []
    for line in SHOTS_FILE.read_text(encoding="utf-8").splitlines():
        try:
            s = json.loads(line)
            s["_t"] = datetime.fromisoformat(s["received"]).timestamp()
            shots.append(s)
        except (ValueError, KeyError):
            continue
    return shots


def match_shots(clip_times: dict[str, float]) -> dict[str, dict]:
    """Clip name -> the shot reported just after its strike. Each shot goes to one clip at most."""
    pairs = []
    for s in load_shots():
        delay = SHOT_DELAY_S.get(s.get("source"), DEFAULT_SHOT_DELAY_S)
        for name, t in clip_times.items():
            gap = s["_t"] - t
            if gap >= -1.0 and abs(gap - delay) <= SHOT_SLACK_S:
                pairs.append((abs(gap - delay), name, s))
    matched, used = {}, set()
    for _, name, s in sorted(pairs, key=lambda p: p[0]):
        if name in matched or id(s) in used:
            continue
        matched[name] = {k: v for k, v in s.items() if k != "_t"}
        matched[name]["gap"] = round(s["_t"] - clip_times[name], 1)  # seconds from strike to report
        used.add(id(s))
    return matched


class ClipNames(BaseModel):
    names: list[str]


@app.post("/api/delete")
def delete_clips(body: ClipNames):
    """Moves clips to the trash folder (undo with /api/restore)."""
    moved = []
    for name in body.names:
        if Path(name).name != name:
            continue
        with files_lock:
            if (CLIPS_DIR / name).is_file():
                pending_trash.add(name)
                try_trash(name)
                moved.append(name)
    print(f"Trash: {len(moved)} clip(s)", flush=True)
    return {"moved": moved}


@app.post("/api/restore")
def restore_clips(body: ClipNames):
    """Brings clips back out of the trash."""
    restored = []
    for name in body.names:
        if Path(name).name != name:
            continue
        with files_lock:
            if name in pending_trash:
                pending_trash.discard(name)
                restored.append(name)
            elif not (CLIPS_DIR / name).exists() and move_clip(name, to_trash=False):
                restored.append(name)
    return {"restored": restored}


@app.get("/api/pose/{name}")
def get_pose(name: str):
    checked_clip(name)
    state = pose_state(name)
    if state != "done":
        raise HTTPException(404, f"Pose is {state}")
    return FileResponse(pose_file(name), media_type="application/json", headers={"Content-Encoding": "gzip"})


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


if __name__ == "__main__":
    print(f"Serving clips from {CLIPS_DIR}, pose results in {POSE_DIR}")
    print(f"Open http://localhost:{PORT} here, or http://<this PC's name>:{PORT} from other devices")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
