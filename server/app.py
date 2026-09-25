"""SwingClips home server: lists the clips in CLIPS_DIR and serves them to any browser on the LAN.
A background worker runs pose on each new clip and saves it to POSE_DIR for the skeleton overlay.

Run with "Start server.cmd", or:  .venv\\Scripts\\python.exe app.py
Settings (environment variables): SWINGCLIPS_CLIPS (clips folder), SWINGCLIPS_POSE (pose results,
default: a "pose" folder next to the clips folder), SWINGCLIPS_PORT (default 8000),
SWINGCLIPS_POSE_MODEL (MediaPipe .task file; default public/mediapipe/pose_landmarker_full.task),
SWINGCLIPS_LABELS (hand labels for the scorecard, eval.py; default: a "labels" folder next to the clips folder).
"""
import asyncio
import bisect
import glob
import gzip
import json
import logging
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
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import pose
import setup
import swings

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

# Clips end in _<unix seconds>.mp4 (e.g. c0_1920x1080_240_hs_1789123456.mp4), capture app clips in
# _<unix seconds>_<strike>ms.mp4.
UNIX_TIME_SUFFIX = re.compile(r"_(\d{10})(?:_\d+ms)?$")
# Capture app clips: swing_[<angle>_]<W>x<H>_<fps>fps_<unix seconds>[_<ms into the clip of the strike>ms].mp4
# The angle and strike were added for two cameras; older clips have neither and are face-on.
SWING_NAME = re.compile(r"^swing_(?:(face|dtl)_)?\d+x\d+_\d+fps_\d{10}(?:_(\d+)ms)?\.")
# Two phones' clips of one swing are named after the strike each heard, on the server's clock
# (each phone reads it from /api/time). Strikes are at least 3 s apart (the app's cooldown).
PAIR_SLACK_S = 2.0

# Each swing's numbers for the trends (see swings.py), by the clip it's listed by; kept in SWINGS_FILE.
SWINGS_FILE = Path(os.environ.get("SWINGCLIPS_SWINGS", CLIPS_DIR.parent / "swings.json"))
swing_records: dict[str, dict] = {}
swings_code = ""   # fingerprint of the JavaScript the records are worked out with
records_lock = threading.Lock()

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


def swing_worker(stop: threading.Event):
    """Forever: work out the numbers of each analyzed swing that has none, or old ones."""
    global swing_records, swings_code
    summarizer = swings.Summarizer(STATIC_DIR)
    swings_code = summarizer.code
    with records_lock:
        swing_records = swings.load(SWINGS_FILE)
    try:
        while not stop.is_set():
            clips = {c["name"]: c for c in listed_clips(with_shots=False)}
            done = 0
            for c in clips.values():
                if stop.is_set() or c["pose"] != "done" or (c["partner"] and c["angle"] != "face"):
                    continue
                other = clips.get(c["partner"] or "")
                if other and other["pose"] not in ("done", "failed"):
                    continue  # wait for the other angle
                other = other if other and other["pose"] == "done" else None
                old = swing_records.get(c["name"])
                if old and old.get("code") == swings_code and old.get("partner") == (other and other["name"]):
                    continue
                try:
                    record = summarizer.summarize(swings.pose_input(c, pose_file(c["name"])),
                                                  swings.pose_input(other, pose_file(other["name"])) if other else None)
                except FileNotFoundError:
                    continue  # just deleted
                except Exception:
                    record = {"error": traceback.format_exc(limit=2)}
                record.update(code=swings_code, partner=other and other["name"])
                with records_lock:
                    swing_records[c["name"]] = record
                done += 1
                if done % 25 == 0:
                    swings.save(SWINGS_FILE, swing_records)
            if done:
                with records_lock:
                    swings.save(SWINGS_FILE, swing_records)
                print(f"Swings: worked out the numbers of {done} swing(s)", flush=True)
            stop.wait(5)
    finally:
        summarizer.close()


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
    worker = threading.Thread(target=swing_worker, args=(stop,), daemon=True)
    worker.start()
    yield
    stop.set()
    worker.join(timeout=5)  # lets it close its JavaScript engine, which otherwise holds up the exit
    camera_setup.close()


app = FastAPI(title="SwingClips", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.middleware("http")
async def revalidate_page(request: Request, call_next):
    """The page and its scripts are checked for a newer copy on every load (a quick 304 when there
    isn't one): otherwise, after an update, a browser can run new HTML with an old cached script."""
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


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
    return listed_clips()


def listed_clips(with_shots: bool = True) -> list[dict]:
    """The clips, newest first, with their pose state, angle, strike, partner and (optionally) shot."""
    clips = []
    for p in clip_paths():
        if p.name in pending_trash:
            continue
        t = recorded_at(p)
        m = SWING_NAME.match(p.name)
        clips.append({
            "name": p.name,
            "size": p.stat().st_size,
            "recorded": datetime.fromtimestamp(t).isoformat(timespec="seconds"),
            "pose": pose_state(p.name),
            # Which way the camera looked, and when in the clip the phone heard the strike (s).
            "angle": (m.group(1) or "face") if m else "face",
            "strike": int(m.group(2)) / 1000 if m and m.group(2) else None,
            "partner": None,
            "_t": t,
        })
    # Only the capture app's clips are named after the strike itself.
    swing_clips = [c for c in clips if SWING_NAME.match(c["name"])]
    pair_angles(swing_clips)
    by_name = {c["name"]: c for c in clips}
    excluded = set(load_excluded())
    for c in clips:
        c["excluded"] = c["name"] in excluded or (c["partner"] or "") in excluded
    if not with_shots:
        for c in clips:
            c.pop("_t")
        return clips
    # One shot per swing: paired by the face-on clip (or the only one), then shown on both angles.
    shots = match_shots({c["name"]: c["_t"] for c in swing_clips if not (c["partner"] and c["angle"] != "face")})
    clubs = load_clubs()
    for name, shot in shots.items():
        # The club as corrected on the review page, if it was (Square's own is kept alongside).
        fix = clubs.get(name) or clubs.get(by_name[name]["partner"] or "")
        if fix and fix != shot.get("club"):
            shot["squareClub"], shot["club"] = shot.get("club"), fix
        by_name[name]["shot"] = shot
        if by_name[name]["partner"]:
            by_name[by_name[name]["partner"]]["shot"] = shot
    for c in clips:
        c.setdefault("shot", None)
    clips.sort(key=lambda c: c.pop("_t"), reverse=True)
    return clips


def pair_angles(swings: list[dict]) -> None:
    """Sets "partner" on each face-on clip and the down-the-line clip of the same swing, if both exist."""
    face = [c for c in swings if c["angle"] == "face"]
    dtl = sorted((c for c in swings if c["angle"] == "dtl"), key=lambda c: c["_t"])
    dtl_times = [c["_t"] for c in dtl]
    pairs = []
    for a in face:
        for b in dtl[bisect.bisect_left(dtl_times, a["_t"] - PAIR_SLACK_S):
                     bisect.bisect_right(dtl_times, a["_t"] + PAIR_SLACK_S)]:
            pairs.append((abs(a["_t"] - b["_t"]), a, b))
    # Closest first, each clip in one pair at most.
    for _, a, b in sorted(pairs, key=lambda p: p[0]):
        if a["partner"] is None and b["partner"] is None:
            a["partner"], b["partner"] = b["name"], a["name"]


@app.get("/api/time")
def server_time():
    """The server's clock, so each capture phone names its clips on the same clock."""
    return {"ms": int(time.time() * 1000)}


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


# ---- Club corrections ----
# When the club wasn't changed in Square's app, the review page can say which club it really was.
# Kept per swing (by clip name) in a small JSON file; the shot itself is never rewritten.
CLUBS_FILE = Path(os.environ.get("SWINGCLIPS_CLUBS", CLIPS_DIR.parent / "clubs.json"))
# Square's codes: DR, W3 (3 wood), H4 (4 hybrid), I7 (7 iron), PW / GW / SW / LW, PT (putter).
CLUB_CODE = re.compile(r"^(DR|[WHI][1-9]|PW|GW|SW|LW|PT)$")


def load_clubs() -> dict[str, str]:
    try:
        return json.loads(CLUBS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


class ClubFix(BaseModel):
    names: list[str]
    club: str | None  # None: back to what Square said


@app.post("/api/club")
def set_club(body: ClubFix):
    """Sets (or clears) the club for these swings."""
    if body.club is not None and not CLUB_CODE.match(body.club):
        raise HTTPException(400, "Unknown club")
    with files_lock:
        clubs = load_clubs()
        for name in body.names:
            if Path(name).name != name:
                continue
            if body.club is None:
                clubs.pop(name, None)
            else:
                clubs[name] = body.club
        CLUBS_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = CLUBS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(clubs, indent=1), encoding="utf-8")
        tmp.replace(CLUBS_FILE)
    print(f"Club: {len(body.names)} swing(s) -> {body.club or 'as Square said'}", flush=True)
    return {"ok": True}


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


# ---- Swings left out of the trends ----
# Someone else's swings (a friend hitting while the phones listen) shouldn't count as yours.
EXCLUDED_FILE = Path(os.environ.get("SWINGCLIPS_EXCLUDED", CLIPS_DIR.parent / "excluded.json"))


def load_excluded() -> list[str]:
    try:
        return json.loads(EXCLUDED_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


class Exclusion(BaseModel):
    names: list[str]
    exclude: bool


@app.post("/api/exclude")
def set_excluded(body: Exclusion):
    """Leaves these swings out of the trends, or puts them back."""
    with files_lock:
        names = set(load_excluded())
        for name in body.names:
            if Path(name).name == name:
                (names.add if body.exclude else names.discard)(name)
        EXCLUDED_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = EXCLUDED_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(sorted(names), indent=1), encoding="utf-8")
        tmp.replace(EXCLUDED_FILE)
    return {"ok": True}


# ---- Journal: handicap index over time, and a note per practice session ----
JOURNAL_FILE = Path(os.environ.get("SWINGCLIPS_JOURNAL", CLIPS_DIR.parent / "journal.json"))


def load_journal() -> dict:
    try:
        j = json.loads(JOURNAL_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        j = {}
    return {"handicap": j.get("handicap", []), "notes": j.get("notes", {})}


def save_journal(j: dict) -> None:
    JOURNAL_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = JOURNAL_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(j, indent=1), encoding="utf-8")
    tmp.replace(JOURNAL_FILE)


@app.get("/api/journal")
def get_journal():
    return load_journal()


class HandicapEntry(BaseModel):
    date: str             # YYYY-MM-DD
    index: float | None   # None: remove that day's entry


@app.post("/api/journal/handicap")
def set_handicap(body: HandicapEntry):
    datetime.strptime(body.date, "%Y-%m-%d")  # rejects a bad date
    if body.index is not None and not -10 <= body.index <= 54:
        raise HTTPException(400, "A handicap index is between +10 and 54")
    with files_lock:
        j = load_journal()
        j["handicap"] = [e for e in j["handicap"] if e["date"] != body.date]
        if body.index is not None:
            j["handicap"].append({"date": body.date, "index": body.index})
        j["handicap"].sort(key=lambda e: e["date"])
        save_journal(j)
    return {"ok": True}


class SessionNote(BaseModel):
    key: str   # the session's first clip
    note: str  # empty: remove


@app.post("/api/journal/note")
def set_note(body: SessionNote):
    with files_lock:
        j = load_journal()
        if body.note.strip():
            j["notes"][body.key] = body.note.strip()[:500]
        else:
            j["notes"].pop(body.key, None)
        save_journal(j)
    return {"ok": True}


@app.get("/api/swings")
def get_swings():
    """Each analyzed swing's numbers, by the clip it's listed by (see swings.py)."""
    # Only swings listed now, by the clip they're listed by (a lone angle may since have been paired).
    listed = {c["name"] for c in listed_clips(with_shots=False) if not (c["partner"] and c["angle"] != "face")}
    with records_lock:
        records = {k: v for k, v in swing_records.items() if k in listed}
    return {"code": swings_code, "swings": records}


# ---- Hand labels, for the scorecard (eval.py) ----
# One file per clip and labeling pass (a second pass, done later without looking, measures how
# consistent the labels themselves are). Made by the review page's labeling mode (static/labels.js).
# Kept when a clip goes to the trash: eval.py looks for the clip there too.
LABELS_DIR = Path(os.environ.get("SWINGCLIPS_LABELS", CLIPS_DIR.parent / "labels"))
LABEL_PASSES = (1, 2)


def label_file(name: str, label_pass: int) -> Path:
    return LABELS_DIR / (f"{name}.json" if label_pass == 1 else f"{name}.pass{label_pass}.json")


def checked_label(name: str, label_pass: int) -> Path:
    if Path(name).name != name or Path(name).suffix.lower() not in VIDEO_TYPES:
        raise HTTPException(404, "No such clip")
    if label_pass not in LABEL_PASSES:
        raise HTTPException(400, "Pass is 1 or 2")
    return label_file(name, label_pass)


@app.get("/api/labels")
def list_labels():
    """Which clips have labels: {pass: [clip names]}."""
    out = {str(n): [] for n in LABEL_PASSES}
    if LABELS_DIR.is_dir():
        for f in sorted(LABELS_DIR.glob("*.json")):
            n = 2 if f.name.endswith(".pass2.json") else 1
            out[str(n)].append(f.name[:-len(".pass2.json")] if n == 2 else f.name[:-len(".json")])
    return out


@app.get("/api/labels/{name}")
def get_label(name: str, label_pass: int = Query(1, alias="pass")):
    path = checked_label(name, label_pass)
    if not path.is_file():
        raise HTTPException(404, "Not labeled yet")
    return FileResponse(path, media_type="application/json", headers={"Cache-Control": "no-store"})


@app.post("/api/labels/{name}")
async def set_label(name: str, request: Request, label_pass: int = Query(1, alias="pass")):
    """Saves a clip's labels (the whole file each time)."""
    path = checked_label(name, label_pass)
    checked_clip(name)
    body = await request.body()
    if len(body) > 2_000_000:
        raise HTTPException(400, "Too big")
    try:
        doc = json.loads(body)
    except ValueError:
        raise HTTPException(400, "Expected JSON")
    if not isinstance(doc, dict) or doc.get("schema") != 1 or (doc.get("clip") or {}).get("name") != name:
        raise HTTPException(400, "Not a label file for this clip")
    doc["pass"] = label_pass
    doc["updated"] = datetime.now().isoformat(timespec="seconds")
    with files_lock:
        LABELS_DIR.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(doc, indent=1), encoding="utf-8")
        tmp.replace(path)
    return {"ok": True, "updated": doc["updated"]}


# ---- Camera setup ----
camera_setup = setup.Setup(STATIC_DIR)


@app.post("/api/setup/{angle}")
async def setup_still(angle: str, request: Request, rotation: int = 0):
    """A phone's preview still (JPEG body): finds the golfer, returns what to fix (see setup.py)."""
    if angle not in setup.ANGLES:
        raise HTTPException(404, "No such camera angle")
    body = await request.body()
    if not body or len(body) > 5_000_000:
        raise HTTPException(400, "Expected a JPEG")
    try:
        return await asyncio.to_thread(camera_setup.judge, angle, body, rotation)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/setup")
def setup_status():
    return camera_setup.status()


@app.get("/api/setup/{angle}.jpg")
def setup_picture(angle: str):
    jpeg = camera_setup.picture(angle)
    if jpeg is None:
        raise HTTPException(404, "No picture from that camera yet")
    return Response(jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


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


class QuietPolling(logging.Filter):
    """Leaves out the requests every open review page (and phone) makes every second or few."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        # The phones' setup stills come every second; so do the Camera setup page's checks.
        return not any(path in message for path in ('"GET /api/clips ', '"GET /api/time ', " /api/setup"))


class QuietShutdown(logging.Filter):
    """Leaves out the reports of video streams cancelled on purpose when the server stops: a
    browser with clips open holds their downloads open, and each one printed a long traceback."""

    def filter(self, record: logging.LogRecord) -> bool:
        exc = record.exc_info[1] if record.exc_info else None
        if isinstance(exc, (asyncio.CancelledError, KeyboardInterrupt)):
            return False
        message = record.getMessage()
        return not ("CancelledError" in message or "timeout graceful shutdown exceeded" in message)


if __name__ == "__main__":
    print(f"Serving clips from {CLIPS_DIR}, pose results in {POSE_DIR}")
    print(f"Open http://localhost:{PORT} here, or http://<this PC's name>:{PORT} from other devices")
    logging.getLogger("uvicorn.access").addFilter(QuietPolling())
    logging.getLogger("uvicorn.error").addFilter(QuietShutdown())
    # Ctrl+C: don't wait on open browser connections (a review page or a video keeps one open).
    uvicorn.run(app, host="0.0.0.0", port=PORT, timeout_graceful_shutdown=2)
