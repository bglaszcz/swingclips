"""SwingClips home server: lists the clips in CLIPS_DIR and serves them to any browser on the LAN.
A background worker runs pose on each new clip and saves it to POSE_DIR for the skeleton overlay.

Run with "Start server.cmd", or:  .venv\\Scripts\\python.exe app.py
Settings (environment variables): SWINGCLIPS_CLIPS (clips folder), SWINGCLIPS_POSE (pose results,
default: a "pose" folder next to the clips folder), SWINGCLIPS_PORT (default 8000),
SWINGCLIPS_POSE_MODEL (MediaPipe .task file; default public/mediapipe/pose_landmarker_full.task),
SWINGCLIPS_LABELS (hand labels for the scorecard, eval.py; default: a "labels" folder next to the clips folder),
SWINGCLIPS_PRACTICE / SWINGCLIPS_PRACTICE_LOG (practice mode's target and log; default next to the clips folder),
SWINGCLIPS_GAME / SWINGCLIPS_GAMES_LOG (the practice game in play and finished games; default next to the clips folder),
SWINGCLIPS_NOISE (the noise floor per number; default noise.json next to the clips folder),
SWINGCLIPS_GOODSHOTS (the rules for which shots count as good, for your personal ranges; default
goodshots.json next to the clips folder),
SWINGCLIPS_3D=on (3D from both phones: calib.py, tri.py; off by default) and SWINGCLIPS_CALIB (its
calibrations; default: a "calib" folder next to the clips folder),
SWINGCLIPS_ORT_PROVIDER (where the ONNX body and club models run: cpu, the default, dml, cuda or auto;
see models.py and docs/performance.md, "Using a GPU").
Once a clip's pose is saved, the same worker measures its light, grain, flicker and sharpness (quality.py).
The swing worker keeps each swing's numbers (swings.py) and the noise floor per number (noise.json),
which the page's trust rules (static/trust.js) use.
"""
import asyncio
import bisect
import glob
import gzip
import json
import collections
import logging
import math
import multiprocessing
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
from pydantic import BaseModel, Field

import aicoach
import ballflight
import bodycalib
import calib
import calibrun
import drills
import games
import goodshots
import improve
import labelcheck
import models
import night
import pose
import quality
import practice
import programs
import setup
import square_watch
import status
import swing3d
import swings
import tri
import update

CLIPS_DIR = Path(os.environ.get("SWINGCLIPS_CLIPS", r"D:\SwingClips\clips"))
POSE_DIR = Path(os.environ.get("SWINGCLIPS_POSE", CLIPS_DIR.parent / "pose"))
# Deleted clips (and their pose files) go here rather than being erased, so a delete can be undone.
TRASH_DIR = Path(os.environ.get("SWINGCLIPS_TRASH", CLIPS_DIR.parent / "trash"))
PORT = int(os.environ.get("SWINGCLIPS_PORT", "8000"))
STATIC_DIR = Path(__file__).parent / "static"
VIDEO_TYPES = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm"}
# Leave a few cores for serving video; pose splits each clip across this many processes.
# Half the logical CPUs, up to 6 (6 on the i5-12400): more fight over the cores. SWINGCLIPS_POSE_WORKERS overrides.
# The same with the ONNX models on a GPU (SWINGCLIPS_ORT_PROVIDER): MediaPipe, the shaft search and
# decoding still run on the CPU, and the workers take turns on the GPU (each has its own session).
POSE_WORKERS = int(os.environ.get("SWINGCLIPS_POSE_WORKERS", 0)) or max(1, min(6, (os.cpu_count() or 4) // 2))
# A session is on while a phone is recording, and for SESSION_QUIET_S after the last clip came in.
# Recording comes first then: the pose workers always run below normal priority (pose.low_priority),
# and the heavy work (analyzing clips again, the deep pass) waits for the end of the session.
# SWINGCLIPS_DURING_SESSION: "quick" (default) analyzes new clips as they come, face-on first, for the
# spoken checks and Practice voice; "wait" leaves them all until the session is over.
SESSION_QUIET_S = 600
DURING_SESSION = os.environ.get("SWINGCLIPS_DURING_SESSION", "quick").strip().lower() or "quick"
if DURING_SESSION not in ("quick", "wait"):
    raise SystemExit(f"SWINGCLIPS_DURING_SESSION={DURING_SESSION!r}: use quick or wait")
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

# What happened when, for tracking down clips with no swing in them: each sentence sent to a phone to
# say, each upload (and whether it came right after the other phone was sent something to say: its
# voice may have set this phone off), and each clip where no swing was found, with why (phases.js).
# One JSON object per line; trimmed to its newer half at start once it's over EVENTS_MAX_BYTES.
EVENTS_FILE = Path(os.environ.get("SWINGCLIPS_EVENTS", CLIPS_DIR.parent / "events.jsonl"))
EVENTS_MAX_BYTES = 5_000_000
events_lock = threading.Lock()
# Sentences sent to the phones lately: (server time sent, angle, text), for the upload check.
recent_speech: collections.deque = collections.deque(maxlen=50)
# Upload -> what the other phone was sent to say just before it (see speech_before), for the no-swing log.
upload_notes: dict[str, dict] = {}
# A phone starts talking a moment after it gets a sentence, talks ~0.4 s a word, and its room echo
# lasts a little after (the capture app mutes its own listener 1.5 s past its speech).
SPEECH_START_S, SPEECH_S_PER_WORD, SPEECH_TAIL_S = 0.5, 0.4, 2.0


def log_event(kind: str, **fields) -> None:
    """Appends one event to EVENTS_FILE; a failure to write is printed, never raised."""
    line = json.dumps({"t": datetime.now().isoformat(timespec="milliseconds"), "kind": kind, **fields},
                      separators=(",", ":"), default=str)
    try:
        with events_lock:
            EVENTS_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(EVENTS_FILE, "a", encoding="utf-8") as f:
                f.write(line + "\n")
    except OSError as e:
        print(f"Events: couldn't write {EVENTS_FILE}: {e}", flush=True)


def trim_events() -> None:
    """Keeps the newer half of EVENTS_FILE once it's grown past EVENTS_MAX_BYTES."""
    try:
        with events_lock:
            if not EVENTS_FILE.is_file() or EVENTS_FILE.stat().st_size <= EVENTS_MAX_BYTES:
                return
            lines = EVENTS_FILE.read_text(encoding="utf-8").splitlines()
            tmp = EVENTS_FILE.with_suffix(".tmp")
            tmp.write_text("\n".join(lines[len(lines) // 2:]) + "\n", encoding="utf-8")
            tmp.replace(EVENTS_FILE)
    except OSError:
        pass


def sent_to_say(angle: str, text: str, via: str) -> None:
    """A sentence went out to phone `angle` to say (via: "phone poll" or "practice")."""
    now = time.time()
    recent_speech.append((now, angle, text))
    session_status.talked(angle, text)   # the other phone stops listening meanwhile
    log_event("say", to=angle, text=text, via=via)


def speech_before(angle: str, strike_t: float) -> dict | None:
    """The sentence the OTHER phone was sent just before this phone heard a 'strike' at strike_t
    (server clock, whole seconds as in the clip name), if the strike fell while it was probably
    being said or echoing: {to, text, after (s from sent to strike)}."""
    best = None
    for sent, to, text in recent_speech:
        if to == angle:
            continue  # a phone doesn't hear itself: the capture app mutes its listener while it speaks
        end = sent + SPEECH_START_S + SPEECH_S_PER_WORD * len(text.split()) + SPEECH_TAIL_S
        # The name's time is cut to whole seconds, so the strike was up to 1 s later than strike_t.
        if sent - 1.0 <= strike_t <= end:
            best = {"to": to, "text": text, "after": round(max(0.0, strike_t - sent), 1)}
    return best


def note_no_swing(clip: dict, other: dict | None, record: dict, again: bool) -> None:
    """Logs a swing where no swing was found in its main clip, with why (summary.js quality.noSwing).
    `again`: worked out again (new JavaScript, a new partner), not new. Printed only when new."""
    q = record.get("quality") or {}
    if "error" in record or q.get("swingFound") is not False:
        return
    why = q.get("noSwing") or {}
    echo = upload_notes.get(clip["name"])
    log_event("noswing", clip=clip["name"], angle=clip["angle"], partner=other and other["name"],
              lone=not clip.get("partner"), strike=clip.get("strike"), recorded=clip.get("recorded"),
              again=again, why=why, afterSpeech=echo)
    if not again:
        tail = f' (a lone clip, heard {echo["after"]} s after the {status.NAMES[echo["to"]].lower()} phone was sent "{echo["text"]}")' \
            if echo else " (a lone clip: the other phone didn't record)" if not clip.get("partner") else ""
        print(f"No swing: {clip['name']}: {why.get('text', 'no reason given')}{tail}", flush=True)


# Each swing's numbers for the trends (see swings.py), by the clip it's listed by; kept in SWINGS_FILE.
SWINGS_FILE = Path(os.environ.get("SWINGCLIPS_SWINGS", CLIPS_DIR.parent / "swings.json"))
swing_records: dict[str, dict] = {}
# The noise floor per number over recent swings (trust.js noiseTable), for the trust shown on the
# page: worked out by the swing worker when the swings change, kept in NOISE_FILE.
NOISE_FILE = Path(os.environ.get("SWINGCLIPS_NOISE", CLIPS_DIR.parent / "noise.json"))
noise_table: dict = {}
# Worked out again at least this often (s): clubs corrected, swings left out.
NOISE_EVERY_S = 600
# The most recent swings passed in: trust.js noiseTable uses its RECENT (300) of them.
NOISE_RECENT = 300
swings_code = ""   # fingerprint of the JavaScript the records are worked out with
records_lock = threading.Lock()

# Name of the clip the worker is on right now, if any.
pose_busy: str | None = None
# Clips waiting for pose, as the worker last counted them (the Ready panel shows it).
pose_queued = 0
# Analyzed clips still waiting for the deep pass (0 while a session is on, or with it off).
pose_deep_left = 0
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


def file_3d(name: str) -> Path:
    # A swing's 3D joints (tri.py), by its face-on clip; only with SWINGCLIPS_3D=on.
    return POSE_DIR / f"{name}.3d.json"


def error_file(name: str) -> Path:
    return POSE_DIR / (name + ".error.txt")


def quality_file(name: str) -> Path:
    # Beside the pose file, named by quality.py's own version: pose.VERSION stays as it is.
    return POSE_DIR / f"{name}.quality.v{quality.VERSION}.json"


def quality_error_file(name: str) -> Path:
    return POSE_DIR / (name + ".quality.error.txt")


# Quality records as last read, by clip name: (file's mtime, record). The clip list is polled often.
quality_cache: dict[str, tuple[int, dict]] = {}


def load_quality(name: str) -> dict | None:
    """The clip's quality record (quality.py), or None if it hasn't been measured (yet)."""
    try:
        mtime = quality_file(name).stat().st_mtime_ns
    except OSError:
        return None
    got = quality_cache.get(name)
    if got is None or got[0] != mtime:
        try:
            got = (mtime, json.loads(quality_file(name).read_text()))
        except (OSError, ValueError):
            return None
        quality_cache[name] = got
    return got[1]


def pose_state(name: str) -> str:
    if pose_file(name).exists():
        return "done"
    if error_file(name).exists():
        return "failed"
    return "processing" if name == pose_busy else "queued"


def deep_profile() -> dict | None:
    """The deep pass's settings (pose.deep_profile), or None with it off."""
    return pose.deep_profile()


def session_on(now: float | None = None) -> bool:
    """Whether a session is on: a phone recording, or a clip in the last SESSION_QUIET_S."""
    now = time.time() if now is None else now
    if session_status.recording(now):
        return True
    newest = 0.0
    for p in clip_paths():
        try:
            newest = max(newest, p.stat().st_mtime)
        except OSError:
            pass
    return now - newest < SESSION_QUIET_S


def new_pool() -> ProcessPoolExecutor:
    return ProcessPoolExecutor(POSE_WORKERS, initializer=pose.low_priority)


def body_model() -> str:
    """Which model places the 2D landmarks in new pose files: "mediapipe", or e.g. "rtmpose-m-256x192"
    (SWINGCLIPS_POSE_BACKEND, see models.py)."""
    b = models.backend()
    return b if b == models.DEFAULT else models.stamp(b)


# What made each pose file, by clip name: (file's mtime, body model, ball search version, deep pass,
# clubhead onset looked for, hip edges version, club model).
# The worker checks every clip.
_pose_models: dict[str, tuple[int, str, int, bool]] = {}
# Clips that failed to be analyzed again with the current model, or to have the ball found again
# (kept as they were until a restart).
_again_failed: set[str] = set()
_ball_failed: set[str] = set()
_deep_failed: set[str] = set()
_onset_failed: set[str] = set()
_hip_failed: set[str] = set()


def _pose_stamp(name: str) -> tuple[str, int, bool, bool, int] | None:
    f = pose_file(name)
    try:
        mtime = f.stat().st_mtime_ns
    except OSError:
        return None
    got = _pose_models.get(name)
    if got is None or got[0] != mtime:
        # pose.py writes "model" and "ballVersion" near the start, so the start will do.
        try:
            with gzip.open(f, "rb") as g:
                head = g.read(400).decode("utf-8", "replace")
        except (OSError, EOFError):
            return None
        m = re.search(r'"model":"([^"]+)"', head)
        b = re.search(r'"ballVersion":(\d+)', head)
        e = re.search(r'"hipEdge":(\d+)', head)
        c = re.search(r'"clubModel":"([^"]+)"', head)
        got = (mtime, m.group(1) if m else models.DEFAULT, int(b.group(1)) if b else 1, '"pass":"deep"' in head,
               '"clubOnset":' in head, int(e.group(1)) if e else 0, c and c.group(1))
        _pose_models[name] = got
    return got[1], got[2], got[3], got[4], got[5], got[6]


def pose_model(name: str) -> str | None:
    """Which body model made a clip's pose file ("mediapipe" when it doesn't say), or None without one."""
    stamp = _pose_stamp(name)
    return stamp and stamp[0]


def pose_made(name: str) -> str | None:
    """What a clip's pose file came from: body model, ball search and the deep pass, e.g.
    "rtmpose-m-256x192+ball3+deep". Quality records, swing numbers and 3D keep it, and are worked out
    again when it changes."""
    stamp = _pose_stamp(name)
    return stamp and f"{stamp[0]}+ball{stamp[1]}" + ("+deep" if stamp[2] else "") + ("+onset" if stamp[3] else "") + (f"+hip{stamp[4]}" if stamp[4] else "")


def is_deep(name: str) -> bool:
    stamp = _pose_stamp(name)
    return bool(stamp and stamp[2])


# The deep pass's club model stamp (models.club_stamp), kept while the file is unchanged.
_deep_club: tuple = (None, None, None)


def deep_club_stamp(deep: dict) -> str | None:
    """The stamp the deep pass's club model puts in pose files, or None without one."""
    global _deep_club
    path = deep.get("clubModel")
    if not path:
        return None
    try:
        mtime = Path(path).stat().st_mtime_ns
    except OSError:
        return None
    if _deep_club[:2] != (str(path), mtime):
        _deep_club = (str(path), mtime, models.club_stamp(path))
    return _deep_club[2]


def needs_deep(name: str, club_stamp: str | None) -> bool:
    """Whether an analyzed clip still needs the deep pass: never had it, or had it with another club
    model (after club-deep.onnx is retrained, every clip is analyzed again with the new one). Models
    are told apart by the file's hash, so the same model under another name counts as the same."""
    stamp = _pose_stamp(name)
    return bool(stamp) and (not stamp[2] or (club_stamp is not None
                                             and (stamp[5] or "").split("@")[-1] != club_stamp.split("@")[-1]))


def find_ball_again(clip: Path, pool: ProcessPoolExecutor) -> ProcessPoolExecutor:
    """The ball search again on one analyzed clip (pose.find_ball_again): keeps a ball that passes
    the current checks, else finds it again. Returns the pool (a fresh one if a worker died)."""
    global pose_busy
    with files_lock:
        if not clip.exists() or clip.name in pending_trash:
            return pool
        pose_busy = clip.name
    try:
        doc = json.loads(gzip.decompress(pose_file(clip.name).read_bytes()))
        result = pose.find_ball_again(str(clip), doc, pool, POSE_WORKERS)
        if result.get("ball") != doc.get("ball"):
            result.pop("clubOnset", None)   # it watched the old ball's spot: looked for again
        tmp = pose_file(clip.name).with_suffix(".tmp")
        tmp.write_bytes(gzip.compress(json.dumps(result, separators=(",", ":")).encode()))
        tmp.replace(pose_file(clip.name))
        if (result.get("impact"), result.get("ball")) != (doc.get("impact"), doc.get("ball")):
            was = f"{doc['impact']} s" if doc.get("impact") is not None else "none"
            now = f"{result['impact']} s" if result.get("impact") is not None else "ball not found"
            print(f"Ball: {clip.name}: impact {was} -> {now}", flush=True)
    except Exception as e:
        _ball_failed.add(clip.name)
        print(f"Ball: {clip.name} FAILED (keeps its old result)", flush=True)
        traceback.print_exc()
        if isinstance(e, BrokenProcessPool):
            pool = new_pool()
    finally:
        with files_lock:
            pose_busy = None
    return pool


def add_club_onset(clip: dict, pool: ProcessPoolExecutor, summarizer: swings.Summarizer) -> ProcessPoolExecutor:
    """Where the clubhead starts to leave the ball (pose.club_onset), saved in a face-on clip's pose
    file (or a down-the-line clip's with no face-on partner: its takeaway can't come across from one),
    looked for around the shaft rule's takeaway (phases.js without it). None when there's no
    ball or swing, so it isn't looked for again. Returns the pool (a fresh one if a worker died)."""
    global pose_busy
    name = clip["name"]
    with files_lock:
        if not (CLIPS_DIR / name).exists() or name in pending_trash:
            return pool
        pose_busy = name
    try:
        path = pose_file(name)
        mtime = path.stat().st_mtime_ns
        doc = json.loads(gzip.decompress(path.read_bytes()))
        inp = swings.pose_input(clip, path)
        inp["clubOnset"] = None
        takeaway = summarizer.call("positionTimes", inp, None, swings.LEAD_SIDE)["main"]["times"].get("takeaway")
        onset = pool.submit(pose.club_onset, str(CLIPS_DIR / name), doc, takeaway).result()
        with files_lock:
            if path.stat().st_mtime_ns != mtime:
                return pool   # analyzed again meanwhile: looked for next time round
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(gzip.compress(json.dumps(pose.with_club_onset(doc, onset), separators=(",", ":")).encode()))
            tmp.replace(path)
        print(f"Onset: {name}: " + (f"clubhead leaves at {onset} s (shaft rule {takeaway:.3f} s)" if onset is not None
                                    else "not found"), flush=True)
    except Exception as e:
        _onset_failed.add(name)
        print(f"Onset: {name} FAILED", flush=True)
        traceback.print_exc()
        if isinstance(e, BrokenProcessPool):
            pool = new_pool()
    finally:
        with files_lock:
            pose_busy = None
    return pool


def add_hip_edges(clip: dict, pool: ProcessPoolExecutor, summarizer: swings.Summarizer) -> ProcessPoolExecutor:
    """The outer edges of the hips (pose.hip_edges) from P1 to P8, saved in a face-on clip's pose
    file: each frame's "hip", for the lead hip line. Stamped even when nothing is found, so it isn't
    looked for again. Returns the pool (a fresh one if a worker died)."""
    global pose_busy
    name = clip["name"]
    with files_lock:
        if not (CLIPS_DIR / name).exists() or name in pending_trash:
            return pool
        pose_busy = name
    try:
        path = pose_file(name)
        mtime = path.stat().st_mtime_ns
        doc = json.loads(gzip.decompress(path.read_bytes()))
        times = summarizer.call("positionTimes", swings.pose_input(clip, path), None, swings.LEAD_SIDE)["main"]["times"]
        edges = {}
        if times.get("p1") is not None:
            end = times.get("p8") or times.get("impact") or times["p1"] + 2.0
            edges = pool.submit(pose.hip_edges, str(CLIPS_DIR / name), doc, times["p1"] - pose.HIP_EDGE_PAD,
                                end + pose.HIP_EDGE_PAD).result()
        with files_lock:
            if path.stat().st_mtime_ns != mtime:
                return pool   # analyzed again meanwhile: looked for next time round
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(gzip.compress(json.dumps(pose.with_hip_edges(doc, edges), separators=(",", ":")).encode()))
            tmp.replace(path)
        print(f"Hips: {name}: outer edges on {len(edges)} frames", flush=True)
    except Exception as e:
        _hip_failed.add(name)
        print(f"Hips: {name} FAILED", flush=True)
        traceback.print_exc()
        if isinstance(e, BrokenProcessPool):
            pool = new_pool()
    finally:
        with files_lock:
            pose_busy = None
    return pool


def analyze_clip(clip: Path, pool: ProcessPoolExecutor, again: bool = False,
                 deep: dict | None = None, quick: dict | None = None) -> ProcessPoolExecutor:
    """Runs pose on one clip and saves the result (the deep pass's way with `deep`, deep_profile(); the
    quick pass's with `quick`, pose.quick_profile()); returns the pool (a fresh one if a worker died)."""
    global pose_busy
    with files_lock:
        if not clip.exists() or clip.name in pending_trash:
            return pool
        pose_busy = clip.name
    how = (" deep" if deep else " quick" if quick else "") + (" again, with " + body_model() if again else "")
    print(f"Pose: {clip.name} ...{how}", flush=True)
    try:
        result = pose.analyze(str(clip), pool, POSE_WORKERS, deep=deep, quick=quick)
        tmp = pose_file(clip.name).with_suffix(".tmp")
        tmp.write_bytes(gzip.compress(json.dumps(result, separators=(",", ":")).encode()))
        tmp.replace(pose_file(clip.name))
        found = sum(f["lm"] is not None for f in result["frames"])
        impact = f"impact at {result['impact']} s" if result["impact"] is not None else "ball not found"
        print(f"Pose: {clip.name} done in {result['seconds']} s, "
              f"{found}/{len(result['frames'])} frames with a person, {impact}", flush=True)
    except Exception as e:
        if again:  # a clip that was analyzed before keeps its old result
            _again_failed.add(clip.name)
            if deep:
                _deep_failed.add(clip.name)
        else:
            error_file(clip.name).write_text(traceback.format_exc())
        print(f"Pose: {clip.name} FAILED{' (keeps its old result)' if again else ' - see ' + str(error_file(clip.name))}",
              flush=True)
        if again:
            traceback.print_exc()
        if isinstance(e, BrokenProcessPool):
            # A worker process died (e.g. a bad video crashed the decoder); start fresh ones.
            pool = new_pool()
    finally:
        with files_lock:
            pose_busy = None
    return pool


def pose_worker(stop: threading.Event):
    """Forever: find clips without pose results, newest first, and analyze them one at a time. While a
    session is on, only new clips (or none, SWINGCLIPS_DURING_SESSION=wait); after it, the heavy work."""
    global pose_busy, pose_queued, pose_deep_left
    POSE_DIR.mkdir(parents=True, exist_ok=True)
    # Kept between clips so the worker processes only pay for importing MediaPipe once.
    pool = new_pool()
    summarizer = None
    try:
        while not stop.is_set():
            retry_pending_trash()
            queued = [p for p in clip_paths() if pose_state(p.name) == "queued"]
            pose_queued = len(queued)
            todo = [p for p in queued if time.time() - p.stat().st_mtime > SETTLE_SECONDS]
            busy = session_on()
            waiting = busy and DURING_SESSION == "wait"
            deep = None if busy else deep_profile()
            # During a session, new clips the quick way (when a deep pass will redo them after it).
            quick = pose.quick_profile() if busy else None
            deep_club = deep and deep_club_stamp(deep)
            pose_deep_left = 0 if deep is None else sum(
                1 for p in clip_paths() if p.name not in _deep_failed and pose_state(p.name) == "done"
                and needs_deep(p.name, deep_club))
            if todo and not waiting:
                # Face-on clips first: the phones' spoken checks and practice numbers mostly need them, and
                # during a session the down-the-line ones catch up between sets. After a session a new
                # clip goes straight to the deep pass.
                pool = analyze_clip(max(todo, key=lambda p: ("_face_" in p.name, recorded_at(p))), pool, deep=deep,
                                    quick=quick)
                continue
            if not busy:
                # Analyze again, newest first, a clip whose pose came from another body model (after
                # SWINGCLIPS_POSE_BACKEND changed), so every swing is measured the same way.
                model = body_model()
                again = [p for p in clip_paths() if p.name not in _again_failed and pose_state(p.name) == "done"
                         and pose_model(p.name) not in (None, model)]
                if again:
                    pool = analyze_clip(max(again, key=recorded_at), pool, again=True, deep=deep)
                    continue
                # Then the ball search again, newest first, on clips from an older one (pose.BALL_VERSION).
                reball = [p for p in clip_paths() if p.name not in _ball_failed and pose_state(p.name) == "done"
                          and (_pose_stamp(p.name) or (None, pose.BALL_VERSION))[1] != pose.BALL_VERSION]
                if reball:
                    pool = find_ball_again(max(reball, key=recorded_at), pool)
                    continue
                # Then the deep pass, newest first: the last session's swings are ready first. Clips
                # deep-analyzed with an older club model too.
                if deep is not None:
                    deepen = [p for p in clip_paths() if p.name not in _deep_failed and pose_state(p.name) == "done"
                              and needs_deep(p.name, deep_club)]
                    if deepen:
                        pool = analyze_clip(max(deepen, key=recorded_at), pool, again=True, deep=deep)
                        continue
                # Then the clubhead onset (the takeaway) of face-on clips without one, and of down-the-line
                # clips with no face-on partner, newest first.
                onsets = [c for c in listed_clips(with_shots=False)
                          if (c["angle"] == "face" or not c["partner"]) and c["pose"] == "done"
                          and c["name"] not in _onset_failed and not (_pose_stamp(c["name"]) or (0, 0, 0, True))[3]]
                if onsets:
                    if summarizer is None:
                        summarizer = swings.Summarizer(STATIC_DIR)
                    pool = add_club_onset(max(onsets, key=lambda c: c["recorded"]), pool, summarizer)
                    continue
                # Then the outer hip edges (the lead hip line) of face-on clips, newest first.
                hips = [c for c in listed_clips(with_shots=False) if c["angle"] == "face" and c["pose"] == "done"
                        and c["name"] not in _hip_failed
                        and (_pose_stamp(c["name"]) or (0, 0, 0, 0, pose.HIP_EDGE_VERSION))[4] != pose.HIP_EDGE_VERSION]
                if hips:
                    if summarizer is None:
                        summarizer = swings.Summarizer(STATIC_DIR)
                    pool = add_hip_edges(max(hips, key=lambda c: c["recorded"]), pool, summarizer)
                    continue
            if waiting:
                stop.wait(5)
                continue
            # Then measure a clip's quality (new ones first, then older clips).
            try:
                if summarizer is None:
                    summarizer = swings.Summarizer(STATIC_DIR)
                measured = quality_step(pool, summarizer)
            except BrokenProcessPool:
                pool, measured = new_pool(), True
            if not measured:
                stop.wait(5)
    except KeyboardInterrupt:
        # Ctrl+C reaches the pool's processes too, and comes back here out of the clip they were on.
        # Nothing half done was saved: that clip is simply analyzed (or measured) again at the next start.
        print("Pose: stopped (Ctrl+C); the clip it was on is picked up again at the next start", flush=True)
    pool.shutdown(cancel_futures=True)
    if summarizer is not None:
        summarizer.close()


def quality_step(pool: ProcessPoolExecutor, summarizer: swings.Summarizer) -> bool:
    """Measures the newest analyzed clip without a quality record (quality.py). False if there was none."""
    global pose_busy
    clips = {c["name"]: c for c in listed_clips(with_shots=False)}
    # Measured against an older pose file (its key positions may have moved): measured again.
    todo = [c for c in clips.values() if c["pose"] == "done" and not quality_error_file(c["name"]).exists()
            and (c["quality"] is None or c["quality"].get("poseVersion") != pose.VERSION
                 or c["quality"].get("poseModel", models.DEFAULT) != pose_made(c["name"]))]
    for c in sorted(todo, key=lambda c: c["recorded"], reverse=True):
        other = clips.get(c["partner"] or "")
        if c["angle"] == "dtl" and other and other["pose"] not in ("done", "failed"):
            continue  # its key positions come from the face-on clip: wait for that
        with files_lock:
            if c["name"] in pending_trash or not (CLIPS_DIR / c["name"]).exists():
                continue
            pose_busy = c["name"]
        try:
            measure_quality(c, other if other and other["pose"] == "done" else None, pool, summarizer)
        except BrokenProcessPool:
            raise
        except FileNotFoundError:
            pass  # just deleted
        except Exception:
            quality_error_file(c["name"]).write_text(traceback.format_exc())
            print(f"Quality: {c['name']} FAILED - see {quality_error_file(c['name'])}", flush=True)
        finally:
            with files_lock:
                pose_busy = None
        return True
    return False


def measure_quality(clip: dict, other: dict | None, pool: ProcessPoolExecutor, summarizer: swings.Summarizer) -> dict:
    """Measures one clip's quality and saves it beside its pose file. `other` is its other angle, if
    analyzed: a down-the-line clip's key positions are the face-on clip's, carried across."""
    inp = swings.pose_input(clip, pose_file(clip["name"]))
    if clip["angle"] == "dtl" and other is not None:
        times = summarizer.call("positionTimes", swings.pose_input(other, pose_file(other["name"])), inp,
                                swings.LEAD_SIDE)["dtl"]
    else:
        times = summarizer.call("positionTimes", inp, None, swings.LEAD_SIDE)["main"]
    positions = (times or {}).get("times", {})
    frames = [(f["t"], f["lm"]) for f in inp["frames"]]
    # The impacts the key positions hang on: this clip's, and for a down-the-line clip whose
    # positions come from the face-on clip, that one's too.
    timing = [{"angle": clip["angle"], "impact": inp.get("impact"), "strike": clip["strike"]}]
    if clip["angle"] == "dtl" and other is not None:
        o = swings.pose_input(other, pose_file(other["name"]))
        timing.insert(0, {"angle": other["angle"], "impact": o.get("impact"), "strike": other["strike"]})
    started = time.perf_counter()
    record = pool.submit(quality.measure, str(CLIPS_DIR / clip["name"]), frames, positions, timing,
                         clip.get("camera")).result()
    record["poseVersion"] = pose.VERSION
    record["poseModel"] = pose_made(clip["name"])
    record["positions"] = {k: round(v, 4) for k, v in positions.items() if k in quality.SHARP_KEYS}
    tmp = quality_file(clip["name"]).with_suffix(".tmp")
    tmp.write_text(json.dumps(record, separators=(",", ":")))
    tmp.replace(quality_file(clip["name"]))
    warn = ", ".join(record["warnings"]) or "fine"
    print(f"Quality: {clip['name']} in {time.perf_counter() - started:.1f} s: {warn}", flush=True)
    return record


def swing_worker(stop: threading.Event):
    """Forever: work out the numbers of each analyzed swing that has none, or old ones."""
    global swing_records, swings_code, noise_table
    summarizer = swings.Summarizer(STATIC_DIR, swings.JS_3D if calib.enabled() else ())
    swings_code = summarizer.code
    with records_lock:
        swing_records = swings.load(SWINGS_FILE)
    noise_table = swings.load(NOISE_FILE)
    noise_at = 0.0
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
                # Worked out again when the JavaScript, the partner or either clip's body model changed.
                made_by = [pose_made(c["name"]), other and pose_made(other["name"])]
                if (old and old.get("code") == swings_code and old.get("partner") == (other and other["name"])
                        and old.get("poseModel", [models.DEFAULT, other and models.DEFAULT]) == made_by):
                    continue
                try:
                    record = summarizer.summarize(swings.pose_input(c, pose_file(c["name"])),
                                                  swings.pose_input(other, pose_file(other["name"])) if other else None)
                except FileNotFoundError:
                    continue  # just deleted
                except Exception:
                    record = {"error": traceback.format_exc(limit=2)}
                record.update(code=swings_code, partner=other and other["name"], poseModel=made_by)
                note_no_swing(c, other, record, again=old is not None)
                with records_lock:
                    swing_records[c["name"]] = record
                done += 1
                if done % 25 == 0:
                    swings.save(SWINGS_FILE, swing_records)
            if done:
                with records_lock:
                    swings.save(SWINGS_FILE, swing_records)
                print(f"Swings: worked out the numbers of {done} swing(s)", flush=True)
            if done or noise_table.get("code") != swings_code or time.time() - noise_at > NOISE_EVERY_S:
                try:
                    noise_table = work_out_noise(summarizer)
                    swings.save(NOISE_FILE, noise_table)
                except Exception:
                    traceback.print_exc()
                noise_at = time.time()
            if not stop.is_set():
                try:
                    night_compare(clips, summarizer, stop)
                except Exception:
                    traceback.print_exc()
            if calib_runs.pending_job("body") and not stop.is_set():
                place_cameras(clips, summarizer)
            if calib.enabled() and not stop.is_set():
                try:
                    made = pass_3d(clips, summarizer, stop)
                except Exception:
                    traceback.print_exc()
                    made = 0
                if made:
                    with records_lock:
                        swings.save(SWINGS_FILE, swing_records)
                    print(f"3D: triangulated {made} swing(s)", flush=True)
            stop.wait(5)
    finally:
        summarizer.close()


# The night worker's files (night.py), and each swing's key positions by the server against by them.
NIGHT_DIR = Path(os.environ.get("SWINGCLIPS_NIGHT", CLIPS_DIR.parent / "night"))
NIGHT_COMPARE = NIGHT_DIR / "compare.json"
night_table: dict = {}
# Compared at most this many swings per round of the swing worker, so new swings aren't held up.
NIGHT_PER_ROUND = 40


def night_compare(clips: dict[str, dict], summarizer: swings.Summarizer, stop: threading.Event) -> int:
    """Works out the key positions from the night files of each swing that has them (both angles,
    when it has two) and keeps how far they are from the server's own (night.differences)."""
    global night_table
    if not NIGHT_DIR.is_dir():
        return 0
    if not night_table:
        night_table = night.load_compare(NIGHT_COMPARE)
    done = 0
    for c in clips.values():
        if stop.is_set() or done >= NIGHT_PER_ROUND:
            break
        if c["pose"] != "done" or (c["partner"] and c["angle"] != "face"):
            continue
        other = clips.get(c["partner"] or "")
        other = other if other and other["pose"] == "done" else None
        names = [c["name"]] + ([other["name"]] if other else [])
        files = [night.night_file(NIGHT_DIR, n) for n in names]
        try:
            sig = [summarizer.code] + [pose_made(n) for n in names] + [f.stat().st_mtime_ns for f in files]
        except OSError:
            continue  # no night file yet
        old = night_table.get(c["name"])
        if old and old.get("sig") == sig:
            continue
        try:
            ours = [swings.pose_input(c, pose_file(c["name"])), swings.pose_input(other, pose_file(other["name"])) if other else None]
            theirs = [swings.pose_input(c, files[0]), swings.pose_input(other, files[1]) if other else None]
            # The clubhead onset is an idle step on the server (add_club_onset), not in the night
            # files: the server's, so the takeaway differs only by what the models see.
            for a, b in zip(ours, theirs):
                if a and b and b.get("clubOnset") is None:
                    b["clubOnset"] = a.get("clubOnset")
            mine = summarizer.call("positionTimes", *ours, swings.LEAD_SIDE)
            theirs = summarizer.call("positionTimes", *theirs, swings.LEAD_SIDE)
        except FileNotFoundError:
            continue
        except Exception:
            night_table[c["name"]] = {"sig": sig, "error": traceback.format_exc(limit=1)}
            done += 1
            continue
        # Per angle: night minus server (ms), and the server's times (s) to go to them.
        entry = {"sig": sig, c["angle"]: {"ms": night.differences(mine["main"], theirs["main"]),
                                          "t": (mine["main"] or {}).get("times", {})}}
        if other:
            entry["dtl"] = {"ms": night.differences(mine["dtl"], theirs["dtl"]), "t": (mine["dtl"] or {}).get("times", {})}
        night_table[c["name"]] = entry
        done += 1
    if done:
        NIGHT_DIR.mkdir(parents=True, exist_ok=True)
        night.save_compare(NIGHT_COMPARE, night_table)
        print(f"Night: compared {done} swing(s) with the night worker's", flush=True)
    return done


# Placing the cameras from the body uses at most this many swings (the newest).
BODY_SWINGS = 20


def place_cameras(clips: dict[str, dict], summarizer: swings.Summarizer) -> None:
    """The 3D calibration page asked to place both phones from the swings since the tripods were set
    (bodycalib.py): saves a calibration session dated when the tripods were set, so it holds for
    those swings and the ones after, until a camera moves."""
    job = calib_runs.pending_job("body")
    since, height, floor = job["since"], job["height"], job.get("dtlFloor")
    both = [c for c in clips.values() if c["angle"] == "face" and c["partner"] and c["pose"] == "done"
            and clips.get(c["partner"], {}).get("pose") == "done" and not c.get("calib")
            and recorded_at(CLIPS_DIR / c["name"]) >= since]
    both = sorted(both, key=lambda c: recorded_at(CLIPS_DIR / c["name"]))[-BODY_SWINGS:]
    used = []
    try:
        if not both:
            raise ValueError("no swings filmed from both phones since the tripods were set (and analyzed): "
                             "hit about 10, wait for them to be analyzed, then try again")
        lenses = {}
        for angle, name in (("face", both[-1]["name"]), ("dtl", both[-1]["partner"])):
            lenses[angle] = calib.lens_for(angle, calib.mode_of(name))
            if lenses[angle] is None:
                raise ValueError(f"no lens calibration for the {'face-on' if angle == 'face' else 'down-the-line'} "
                                 f"phone in {calib.mode_of(name)}: do its lens board first")
        data = []
        for c in both:
            other = clips[c["partner"]]
            fi, di = swings.pose_input(c, pose_file(c["name"])), swings.pose_input(other, pose_file(other["name"]))
            offset = summarizer.call("syncOffset", {"impact": fi.get("impact"), "strike": fi.get("strike")},
                                     {"impact": di.get("impact"), "strike": di.get("strike")})
            data.append({"face": {"frames": fi["frames"], "impact": fi.get("impact"), "ball": fi.get("ball")},
                         "dtl": {"frames": di["frames"], "impact": di.get("impact"), "ball": di.get("ball")},
                         "offset": offset})
            used.append(c["name"])
        cams, report = bodycalib.solve(data, lenses["face"], lenses["dtl"], height, floor)
        out = calib.save_session(cams, None, since, {"method": "body", "report": report, "swings": used})
        text = bodycalib.describe(report, cams) + f"\nSaved {out.name}."
        for angle in ("face", "dtl"):
            for w in cams[angle]["warnings"]:
                text += f"\nWarning ({angle}): {w}"
        calib_runs.finish_job(0 if report["good"] else 2, text, used)
        print(f"3D: cameras placed from {len(used)} swing(s) ({out.name})", flush=True)
    except ValueError as e:
        calib_runs.finish_job(1, f"Couldn't place the cameras: {e}", used)
    except Exception:
        calib_runs.finish_job(1, "Couldn't place the cameras:\n" + traceback.format_exc(limit=3), used)


def work_out_noise(summarizer: swings.Summarizer) -> dict:
    """The noise table (trust.js noiseTable) from the listed swings' records, with the club each was
    hit with; swings left out of the trends don't count."""
    listed = [c for c in listed_clips() if not (c["partner"] and c["angle"] != "face") and not c["excluded"]]
    with records_lock:
        todo = [{"t": datetime.fromisoformat(c["recorded"]).timestamp(), "club": (c["shot"] or {}).get("club"),
                 "record": {k: swing_records[c["name"]].get(k) for k in ("body", "error", "quality", "at", "noise")}}
                for c in listed if swing_records.get(c["name"], {}).get("code") == swings_code]
    # Only the latest go in (trust.js takes its RECENT = 300 of them): less to pass to the JavaScript.
    todo = sorted(todo, key=lambda s: s["t"], reverse=True)[:NOISE_RECENT]
    table = summarizer.call("SwingTrust.noiseTable", todo)
    table.update(code=swings_code, updated=datetime.now().isoformat(timespec="seconds"))
    return table


def pass_3d(clips: dict[str, dict], summarizer: swings.Summarizer, stop: threading.Event) -> int:
    """Triangulates the swings filmed from both angles whose 3D is missing or out of date (a new
    calibration, a camera moved, new JavaScript or pose files). Returns how many were made."""
    both = {n: c for n, c in clips.items() if c["angle"] == "face" and c["partner"] and c["pose"] == "done"
            and clips.get(c["partner"], {}).get("pose") == "done"}
    if not both:
        return 0
    all_sessions = calib.sessions()
    with records_lock:
        records = dict(swing_records)
    times = {n: recorded_at(CLIPS_DIR / n) for n in both}
    shots = None
    refs: dict[str, dict | None] = {}

    def ball_of(name: str) -> dict | None:
        try:
            return swing3d.read_pose(pose_file(name)).get("ball")
        except (OSError, ValueError):
            return None

    def ball_ref(session: dict) -> dict | None:
        """Where the ball was in each picture on the first swings after this calibration."""
        if session["id"] not in refs:
            after = sorted((n for n in both if times[n] >= session["created"]), key=lambda n: times[n])
            balls = []
            for n in after:
                balls.append((ball_of(n), ball_of(both[n]["partner"])))
                if sum(1 for f, d in balls if f and d) >= swing3d.BALL_SWINGS:
                    break
            refs[session["id"]] = swing3d.ball_reference(balls)
        return refs[session["id"]]
    made = 0
    for name, c in sorted(both.items(), key=lambda kv: times[kv[0]]):
        if stop.is_set():
            break
        rec = records.get(name)
        if not rec or rec.get("code") != swings_code or "error" in rec:
            continue  # its 2D numbers (and framing) first
        session, why = swing3d.session_for(name, times, all_sessions)
        if session is not None:
            modes = {session["cameras"][k].get("mode") for k in ("face", "dtl")}
            if calib.mode_of(name) != session["cameras"]["face"].get("mode") or \
                    calib.mode_of(c["partner"]) != session["cameras"]["dtl"].get("mode"):
                session, why = None, f"recorded in another mode than calibrated ({', '.join(sorted(map(str, modes)))})"
        # The body model is in the key too: after a switch the pose files are analyzed again.
        key = (f"{session['id'] if session else why}|tri{tri.VERSION}|pose{pose.VERSION}|check{swing3d.CHECK_VERSION}"
               f"|{pose_made(name)}|{pose_made(c['partner'])}")
        if rec.get("key3d") == key:
            continue
        rec = dict(rec, key3d=key, body3d=None, why3d=None if session else why)
        if session is None:
            file_3d(name).unlink(missing_ok=True)
        else:
            if shots is None:
                shots = {x["name"]: x.get("shot") for x in listed_clips()}
            shot = shots.get(name) or {}
            try:
                other = clips[c["partner"]]
                doc, numbers = swing3d.build(
                    swings.pose_input(c, pose_file(name)), swings.pose_input(other, pose_file(other["name"])),
                    swing3d.read_pose(pose_file(name)), swing3d.read_pose(pose_file(other["name"])),
                    session, summarizer, shot.get("club"), swings.LEAD_SIDE)
                why_not = swing3d.moved(doc, session) or swing3d.ball_moved(
                    ball_ref(session), swing3d.read_pose(pose_file(name)).get("ball"),
                    swing3d.read_pose(pose_file(other["name"])).get("ball"))
                if why_not:
                    rec["why3d"] = why_not
                    file_3d(name).unlink(missing_ok=True)
                else:
                    swing3d.save(file_3d(name), doc)
                    rec["body3d"] = numbers
            except FileNotFoundError:
                continue
            except Exception:
                rec["why3d"] = "failed: " + traceback.format_exc(limit=2)
        with records_lock:
            swing_records[name] = rec
        made += 1
    return made


def practice_worker(stop: threading.Event):
    """Forever, while practice is on or a game or coach program is in play: make each new swing's
    spoken result once its number is known."""
    while not stop.is_set():
        if not practice_state.config["on"] and not games_state.game and not programs_state.run:
            stop.wait(2)
            continue
        try:
            if practice_state.config["on"]:
                practice_tick()
            if games_state.game:
                game_tick()
            if programs_state.run:
                program_tick()
        except Exception:
            traceback.print_exc()
        stop.wait(1)


def swings_since(since: float) -> list[dict]:
    """The swings as listed (by the face-on clip, or a lone one) struck after `since`, with the strike's
    time ("t"), partner clip's pose state, and 3D kinematics record."""
    clips = listed_clips(since=since - PAIR_SLACK_S)
    by_name = {c["name"]: c for c in clips}
    swings_now = [dict(c) for c in clips
                  if SWING_NAME.match(c["name"]) and not (c["partner"] and c["angle"] != "face")]
    with records_lock:
        for s in swings_now:
            s["t"] = recorded_at(CLIPS_DIR / s["name"])
            s["partnerPose"] = by_name[s["partner"]]["pose"] if s["partner"] in by_name else None
            rec = swing_records.get(s["name"]) or {}
            s["body3d"] = rec.get("body3d")
            s["why3d"] = rec.get("why3d")
            s["body"] = rec.get("body")
    return swings_now


def game_tick() -> list[dict]:
    """One look at the swings of the game in play; returns the shots scored."""
    g = games_state.game
    if not g:
        return []
    made = games_state.step(swings_since(g["started"]))
    for r in made:
        print(f"Game: {r['target']} yd target, carry {r['carry']} offline {r['offline']}, sg {r['sg']}", flush=True)
    return made


def program_tick() -> list[dict]:
    """One look at the swings of the coach program in play; returns the reps added."""
    run = programs_state.run
    if not run:
        return []
    made = programs_state.step(swings_since(run["started"]))
    for r in made:
        print(f"Program: {r['block']} {r['kind']}" + (f", {r['numbers']}" if r.get("numbers") else ""), flush=True)
    return made


def practice_tick() -> list[dict]:
    """One look at the swings since practice was turned on; returns the results made."""
    swings_now = swings_since(practice_state.config["since"])
    with records_lock:
        # Only records worked out with today's JavaScript and the swing's current partner.
        records = {s["name"]: swing_records[s["name"]] for s in swings_now
                   if s["name"] in swing_records and swing_records[s["name"]].get("code") == swings_code
                   and swing_records[s["name"]].get("partner") == s["partner"]}
    made = practice_state.step(swings_now, records)
    for e in made:
        print(f"Practice: {e['text']}", flush=True)
    return made


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
    if (src_clips / (name + CAMERA_SUFFIX)).is_file():
        (src_clips / (name + CAMERA_SUFFIX)).replace(dst_clips / (name + CAMERA_SUFFIX))
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
    threading.Thread(target=practice_worker, args=(stop,), daemon=True).start()
    threading.Thread(target=status_worker, args=(stop,), daemon=True).start()
    start_square_watch(stop)
    yield
    stop.set()
    worker.join(timeout=5)  # lets it close its JavaScript engine, which otherwise holds up the exit
    camera_setup.close()
    practice.close_rules()
    games_state.rules.close()


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
def list_clips(since: float | None = None):
    """The clips (newest first); only those recorded since `since` (unix seconds), if given (the Start page)."""
    if not CLIPS_DIR.is_dir():
        raise HTTPException(503, f"Clips folder not found: {CLIPS_DIR}")
    return listed_clips(since=since)


def listed_clips(with_shots: bool = True, since: float | None = None) -> list[dict]:
    """The clips, newest first, with their pose state, angle, strike, partner and (optionally) shot;
    only those recorded since `since` (unix seconds), if given."""
    clips = []
    for p in clip_paths():
        if p.name in pending_trash:
            continue
        t = recorded_at(p)
        if since is not None and t < since:
            continue
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
            # What the phone's camera really used (shutter, ISO), if it said.
            "camera": load_camera(p.name),
            # Light, grain, flicker and sharpness, once measured (quality.py).
            "quality": load_quality(p.name),
            "_t": t,
        })
    # Only the capture app's clips are named after the strike itself.
    swing_clips = [c for c in clips if SWING_NAME.match(c["name"])]
    pair_angles(swing_clips)
    by_name = {c["name"]: c for c in clips}
    excluded = set(load_excluded())
    for c in clips:
        # A drill swing (drills.py) is a rehearsal, not the usual swing: out of the trends too.
        # So is a clip of a calibration board (calibrun.py).
        c["calib"] = calib_runs.kind_at(c["_t"]) if SWING_NAME.match(c["name"]) else None
        c["drill"] = drills_state.drill_at(c["_t"]) if SWING_NAME.match(c["name"]) and not c["calib"] else None
        c["excluded"] = c["name"] in excluded or (c["partner"] or "") in excluded or bool(c["drill"] or c["calib"])
    if not with_shots:
        for c in clips:
            c.pop("_t")
        return clips
    # One shot per swing: paired by the face-on clip (or the only one), then shown on both angles.
    shots = match_shots({c["name"]: c["_t"] for c in swing_clips if not (c["partner"] and c["angle"] != "face")},
                        {c["name"] for c in swing_clips if not c["partner"]})
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


# What the camera used for a clip, kept next to it as <clip>.camera.json (capture app 0.4 and later).
CAMERA_SUFFIX = ".camera.json"


def load_camera(name: str) -> dict | None:
    try:
        return json.loads((CLIPS_DIR / (name + CAMERA_SUFFIX)).read_text())
    except (OSError, ValueError):
        return None


def save_camera(name: str, shutter: str | None, exposure: str | None, exposure_ns: int | None,
                iso: int | None, frame_ns: int | None) -> None:
    """Keeps what the phone reported: the setting ("Auto", "1/1000"), what the camera did with it
    ("auto", "manual", "compensation", "refused"), and the exposure (ns) and ISO it really used."""
    if shutter is None and exposure is None and exposure_ns is None and iso is None:
        return  # an older capture app: nothing to keep
    info = {"shutter": shutter, "exposure": exposure, "exposureNs": exposure_ns, "iso": iso, "frameNs": frame_ns,
            # The same exposure as 1/<n> s, for reading and grouping clips by shutter speed.
            "shutterSpeed": round(1e9 / exposure_ns) if exposure_ns else None}
    path = CLIPS_DIR / (name + CAMERA_SUFFIX)
    tmp = path.with_name(path.name + ".part")
    tmp.write_text(json.dumps(info))
    tmp.replace(path)


@app.post("/api/upload")
async def upload(name: str, request: Request, shutter: str | None = Query(None, max_length=20),
                 exposure: str | None = Query(None, max_length=20),
                 exposure_ns: int | None = Query(None, ge=1), iso: int | None = Query(None, ge=1),
                 frame_ns: int | None = Query(None, ge=1)):
    """The capture app sends each clip as the raw request body: POST /api/upload?name=<file name>,
    and from version 0.4 what its camera used: &shutter=1/1000&exposure=manual&exposure_ns=...&iso=...&frame_ns=..."""
    if not UPLOAD_NAME.match(name) or name.startswith("."):
        raise HTTPException(400, "Bad clip name")
    CLIPS_DIR.mkdir(parents=True, exist_ok=True)
    final = CLIPS_DIR / name
    # A retry after a lost response: already have it, so say so rather than keep a second copy.
    if final.exists():
        if not (CLIPS_DIR / (name + CAMERA_SUFFIX)).exists():
            save_camera(name, shutter, exposure, exposure_ns, iso, frame_ns)
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
        # The camera info first, so the clip never shows up without it.
        save_camera(name, shutter, exposure, exposure_ns, iso, frame_ns)
        part.replace(final)
    finally:
        part.unlink(missing_ok=True)
    shot = f", {exposure} 1/{round(1e9 / exposure_ns)} s ISO {iso}" if exposure_ns else ""
    m, t = SWING_NAME.match(name), UNIX_TIME_SUFFIX.search(Path(name).stem)
    angle = (m.group(1) or "face") if m else "face"
    echo = speech_before(angle, float(t.group(1))) if t else None
    if echo:
        upload_notes[name] = echo
        while len(upload_notes) > 200:
            upload_notes.pop(next(iter(upload_notes)))
    log_event("upload", clip=name, angle=angle, mb=round(size / 1e6, 1), afterSpeech=echo)
    heard = f' - heard {echo["after"]} s after the {status.NAMES[echo["to"]].lower()} phone was sent "{echo["text"]}"' if echo else ""
    print(f"Upload: {name} ({size / 1e6:.1f} MB{shot}){heard}", flush=True)
    return {"ok": True, "size": size}


# ---- Launch monitor shots ----
# The sim laptop posts each shot here: the Square watcher (source "square-app", from Square's app's
# saved shots) or the shot listener (source "gspro-connect", from Square's GSPro connector; chosen by
# relay/start-golf.ps1 -Source). Shots are paired with clips by time: the capture app names each
# clip after the second it heard the strike, and the launch monitor's report arrives a moment later.
# What a source doesn't measure (the connector: carry, club speed) is filled in or left out as the
# shot comes in (ballflight.fill).
SHOTS_FILE = Path(os.environ.get("SWINGCLIPS_SHOTS", CLIPS_DIR.parent / "shots.jsonl"))
# Typical seconds from the clip's name time to the report, per source. Square's own app saves a shot
# 6-17 s after it (409 shots to 2026-10-04: median 13.4, 5-95% 9.4-15.0; wedges quickest, GW 9.3,
# driver and hybrid ~14.5-15, up to 16.6; its ball-flight animation plays first); the GSPro connector
# reports within about a second. A shot pairs with the clip whose gap is closest to its source's
# delay, within SHOT_SLACK_S of it; a clip only one phone recorded counts LONE_PENALTY_S further
# off, so a sound one phone heard a few seconds after a swing (kids, a dropped club) doesn't take
# that swing's shot (2026-10-04 17:13: a driver shot 15.3 s after the swing went to a face-only
# clip 7.3 s before it when the delay was 11).
SHOT_DELAY_S = {"square-app": 13.0, "gspro-connect": 1.0}
DEFAULT_SHOT_DELAY_S = 1.0
SHOT_SLACK_S = 7.0
LONE_PENALTY_S = 3.0


# Square shot numbers already taken, so the same shot from both the laptop's watcher and the server's
# own (square_watch.py), or a retried send, is kept once.
recent_square_shots: collections.deque = collections.deque(maxlen=500)


@app.post("/api/shots")
async def add_shot(request: Request):
    shot = await request.json()
    if not isinstance(shot, dict) or "received" not in shot or "ball" not in shot:
        raise HTTPException(400, "Expected a shot with 'received' and 'ball'")
    return record_shot(shot)


def record_shot(shot: dict) -> dict:
    """Keeps a shot from a launch monitor (POST /api/shots, or the server's own Square watcher)."""
    global last_shot_at
    sent = datetime.fromisoformat(shot["received"])  # rejects a bad timestamp
    number = shot.get("shotNumber")
    if shot.get("source") == "square-app" and isinstance(number, int):
        with files_lock:
            if number in recent_square_shots:
                return {"ok": True, "duplicate": True}
            recent_square_shots.append(number)
    # Our own clock too: the difference shows whether the sending PC's clock is off.
    shot["serverReceived"] = datetime.now().astimezone().isoformat(timespec="milliseconds")
    skew = datetime.now().astimezone().timestamp() - sent.timestamp()
    if abs(skew) > 3:
        print(f"Shot: sender's clock is {-skew:+.1f} s off from this server's", flush=True)
    ballflight.fill(shot)
    SHOTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with files_lock, open(SHOTS_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(shot, separators=(",", ":")) + "\n")
    last_shot_at = time.time()
    calc = " (calculated)" if shot["ball"].get("computed") else ""
    print(f"Shot: {shot.get('club')} ball {shot['ball'].get('speed')} mph, carry {shot['ball'].get('carry')} yd{calc}", flush=True)
    return {"ok": True}


# Square's strike height reads about 14 mm low on every club since about Sep 17 2026 (CSV exports before:
# iron median -3 mm; every shot here, Sep 23 to Oct 8: -13 to -23 by day, -17 overall; the owner reads
# that as the face centre). Shots from then on are re-centred as they're read, so everything (the review
# page, programs, games, practice, the coach report) gets the face-centred height; the reading as sent
# stays in shots.jsonl and in clubData.faceImpactVRaw. programs.json's strike gates are in the
# re-centred units (the band -20..-8 as sent is -6..+6).
SQUARE_V_OFFSET_MM = 14.0
SQUARE_V_SHIFT_SINCE = datetime(2026, 9, 17).timestamp()


def recentre_strike(shot: dict) -> dict:
    """Adds SQUARE_V_OFFSET_MM to the strike height of a shot from the shifted era (keeps the raw one)."""
    cd = shot.get("clubData")
    v = cd.get("faceImpactV") if isinstance(cd, dict) else None
    if isinstance(v, (int, float)) and not isinstance(v, bool) and "faceImpactVRaw" not in cd \
            and shot.get("_t", 0) >= SQUARE_V_SHIFT_SINCE:
        cd["faceImpactVRaw"] = v
        cd["faceImpactV"] = round(v + SQUARE_V_OFFSET_MM, 2)
    return shot


def load_shots() -> list[dict]:
    if not SHOTS_FILE.exists():
        return []
    shots = []
    for line in SHOTS_FILE.read_text(encoding="utf-8").splitlines():
        try:
            s = json.loads(line)
            s["_t"] = datetime.fromisoformat(s["received"]).timestamp()
            shots.append(recentre_strike(s))
        except (ValueError, KeyError):
            continue
    return shots


def match_shots(clip_times: dict[str, float], lone: set[str] = frozenset()) -> dict[str, dict]:
    """Clip name -> the shot reported just after its strike. Each shot goes to one clip at most.
    `lone`: clips only one phone recorded, picked only when no two-phone swing fits better."""
    pairs = []
    for s in load_shots():
        delay = SHOT_DELAY_S.get(s.get("source"), DEFAULT_SHOT_DELAY_S)
        for name, t in clip_times.items():
            gap = s["_t"] - t
            if gap >= -1.0 and abs(gap - delay) <= SHOT_SLACK_S:
                pairs.append((abs(gap - delay) + (LONE_PENALTY_S if name in lone else 0.0), name, s))
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
    return {"handicap": j.get("handicap", []), "notes": j.get("notes", {}), "focus": j.get("focus"),
            "focuses": j.get("focuses", [])}


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


class Focus(BaseModel):
    """What I'm working on (Progress, "My focus"): a body move (summary.js BODY key) and which way
    (coach.js), with a club, the results it's for, and the day it started. move None ends it.
    target: what "better" looks like in the move's own number (goal.js: the bound a swing has to be
    on the aim's side of); without one the page uses the usual from before the focus started."""
    move: str | None = None
    aim: str | None = None       # "more" | "less"
    club: str | None = None
    scope: str | None = None     # "irons" | "woods" | None
    results: list[str] = []
    since: str | None = None     # YYYY-MM-DD; default today
    target: float | None = None


@app.post("/api/journal/focus")
def set_focus(body: Focus):
    key = re.compile(r"^[A-Za-z0-9]{1,32}$")
    today = datetime.now().strftime("%Y-%m-%d")
    if body.move is not None:
        if not key.match(body.move) or body.aim not in ("more", "less"):
            raise HTTPException(400, "A focus needs a move and which way (more or less)")
        if body.club is not None and not re.match(r"^[A-Z0-9]{1,4}$", body.club):
            raise HTTPException(400, "Unknown club")
        if body.scope is not None and body.scope not in ("irons", "woods"):
            raise HTTPException(400, "Unknown scope")
        if len(body.results) > 8 or not all(key.match(r) for r in body.results):
            raise HTTPException(400, "Bad results")
        if body.target is not None and not math.isfinite(body.target):
            raise HTTPException(400, "The target is a number")
        since = body.since or today
        try:
            datetime.strptime(since, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(400, "since is a date: YYYY-MM-DD")
    with files_lock:
        j = load_journal()
        old = j.get("focus")
        focuses = list(j.get("focuses") or [])
        if old:
            is_slip = (body.move is not None) and (old.get("since") == today)
            if not is_slip:
                focuses.append({**old, "until": today})
        if body.move is not None:
            focuses = [
                x for x in focuses
                if not (
                    x.get("move") == body.move
                    and x.get("aim") == body.aim
                    and x.get("club") == body.club
                    and x.get("since") == since
                )
            ]
        j["focuses"] = focuses
        if body.move is None:
            j["focus"] = None
        else:
            focus_dict = {
                "move": body.move,
                "aim": body.aim,
                "club": body.club,
                "results": body.results,
                "since": since,
            }
            if body.scope is not None:
                focus_dict["scope"] = body.scope
            if body.target is not None:
                focus_dict["target"] = body.target
            j["focus"] = focus_dict
        save_journal(j)
    return {"ok": True, "focus": j["focus"]}


# ---- Practice mode: one number and a range, spoken after each swing (see practice.py) ----
PRACTICE_FILE = Path(os.environ.get("SWINGCLIPS_PRACTICE", CLIPS_DIR.parent / "practice.json"))
PRACTICE_LOG = Path(os.environ.get("SWINGCLIPS_PRACTICE_LOG", CLIPS_DIR.parent / "practice-log.jsonl"))
practice_state = practice.Practice(PRACTICE_FILE, PRACTICE_LOG)
# A phone's long poll waits at most this long for a result (its read timeout must be longer).
PRACTICE_WAIT_MAX_S = 25


@app.get("/api/practice")
def get_practice():
    """The target, what can be practiced, the log of spoken results, and which phones are listening."""
    return practice_state.state()


@app.post("/api/practice")
async def set_practice(request: Request):
    """Sets the target: {on, metric, min, max, club (for the suggested range), streak}."""
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(400, "Expected a practice target")
    try:
        c = practice_state.set_config(body)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if c["on"] and games_state.game:
        games_state.stop()  # one thing spoken after each swing
    if c["on"] and programs_state.run:
        programs_state.stop()
    m = practice.BY_KEY[c["metric"]]
    print(f"Practice: {'on' if c['on'] else 'off'}, {m['label']} {practice.fmt_range(m, c['min'], c['max'])}", flush=True)
    return c


@app.post("/api/practice/test")
def practice_voice_check():
    """Makes the speaking phone say a test sentence (checks it's listening, and its volume)."""
    return practice_state.voice_check()


@app.get("/api/practice/latest")
async def practice_latest(since: int | None = None, angle: str | None = Query(None, max_length=8),
                          wait: float = Query(0, ge=0, le=PRACTICE_WAIT_MAX_S)):
    """For the phone that speaks: results after id `since` (none without it: just the latest id).
    With `wait`, holds the request up to that many seconds until there is one (a long poll)."""
    give_up = time.monotonic() + wait
    while True:
        out = practice_state.latest(since, angle)
        out["on"] = out["on"] or bool(games_state.game) or bool(programs_state.run)
        if since is not None:
            # Practice games and coach programs speak through the same phone, with ids from the same counter.
            out["results"] = sorted(out["results"] + [
                {"id": e["id"], "text": e["text"], "age": round(time.time() - e["made"], 1), "status": None,
                 "clip": None} for e in games_state.latest(since) + programs_state.latest(since)], key=lambda e: e["id"])
        if out["results"] or since is None or time.monotonic() >= give_up:
            if angle in status.ANGLES:
                for e in out["results"]:
                    sent_to_say(angle, e["text"], "practice")
            return out
        await asyncio.sleep(0.25)


# ---- Practice games: a target, the shot scored, the next target (see games.py) ----
GAME_FILE = Path(os.environ.get("SWINGCLIPS_GAME", CLIPS_DIR.parent / "game.json"))
GAMES_LOG = Path(os.environ.get("SWINGCLIPS_GAMES_LOG", CLIPS_DIR.parent / "games-log.jsonl"))
games_state = games.Games(GAME_FILE, GAMES_LOG, practice_state.new_id)


@app.get("/api/game")
def get_game():
    """The game in play (with its score so far), the games there are, and finished games."""
    return games_state.state()


@app.post("/api/game")
async def start_game(request: Request):
    """Starts a game: {game: "combine" | "wedges" | "random" | "ladder", options: {...}}. Turns practice
    mode off, so the phone says one thing after each swing."""
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(400, "Expected a game")
    try:
        g = games_state.start(body.get("game"), body.get("options") if isinstance(body.get("options"), dict) else {})
    except ValueError as e:
        raise HTTPException(400, str(e))
    if practice_state.config["on"]:
        practice_state.set_config({**practice_state.config, "on": False})
    if programs_state.run:
        programs_state.stop()
    print(f"Game: {g['name']} started, first target {g['target']} yd", flush=True)
    return g


@app.post("/api/game/stop")
def stop_game():
    """Ends the game in play and saves it as it stands."""
    done = games_state.stop()
    if done:
        print(f"Game: {done['name']} stopped. {done['spoken']}", flush=True)
    return {"stopped": done}


@app.get("/api/swings")
def get_swings():
    """Each analyzed swing's numbers, by the clip it's listed by (see swings.py)."""
    # Only swings listed now, by the clip they're listed by (a lone angle may since have been paired).
    listed = {c["name"] for c in listed_clips(with_shots=False) if not (c["partner"] and c["angle"] != "face")}
    with records_lock:
        # Without the numbers kept for the noise table: the page doesn't need them.
        records = {k: {f: x for f, x in v.items() if f not in SERVER_ONLY} for k, v in swing_records.items() if k in listed}
    return {"code": swings_code, "swings": records, "noise": noise_table}


# Parts of a swing record that stay on the server.
SERVER_ONLY = ("at", "noise")


@app.get("/api/noise")
def get_noise():
    """The noise floor per number over recent swings (trust.js noiseTable)."""
    return noise_table


# ---- Drill mode: longer lead-in on the phones, drill swings tagged and left out of trends (drills.py) ----
DRILLS_FILE = Path(os.environ.get("SWINGCLIPS_DRILLS", CLIPS_DIR.parent / "drills.json"))
drills_state = drills.Drills(DRILLS_FILE)


def drills_tick() -> None:
    """Ends a drill (or calibration recording) left on after the session, and keeps the phones'
    lead-in in step with it."""
    drills_state.check(session_status.last_recording)
    calib_runs.check(session_status.last_recording)
    session_status.set_pre(calib_runs.pre() or drills_state.pre())


@app.get("/api/drill")
def get_drill():
    """The drill that's on ({drill, from} or null), the drills there are, and recent drill stretches."""
    drills_tick()
    return drills_state.state()


class DrillChoice(BaseModel):
    drill: str | None = None


@app.post("/api/drill")
def set_drill(body: DrillChoice):
    """Turns a drill on ({drill: "pump"}) or off ({drill: null})."""
    try:
        cur = drills_state.set(body.drill)
    except ValueError as e:
        raise HTTPException(400, str(e))
    drills_tick()
    print(f"Drill: {drills.DRILLS[cur['drill']]['name'] if cur else 'off'}", flush=True)
    return drills_state.state()


# ---- Today's plan: the block being practiced (Start page, plan.js) ----
# Starting a block sets up everything it needs and ends what the one before had on: one thing at a
# time, so the golfer doesn't juggle practice voice, drill and game switches.
PLAN_STEP_FILE = Path(os.environ.get("SWINGCLIPS_PLAN_STEP", CLIPS_DIR.parent / "plan-step.json"))
PLAN_STEP_S = 4 * 3600   # a block this old is yesterday's


def load_plan_step() -> dict | None:
    try:
        step = json.loads(PLAN_STEP_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return step if isinstance(step, dict) and time.time() - step.get("since", 0) <= PLAN_STEP_S else None


def save_plan_step(step: dict | None) -> None:
    PLAN_STEP_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = PLAN_STEP_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(step), encoding="utf-8")
    tmp.replace(PLAN_STEP_FILE)


class PlanStep(BaseModel):
    block: str | None = None   # the plan block's id (warmup, focus, scoring, finish); None ends the plan
    drill: str | None = None   # a drill recorded in this block (drills.py)
    game: str | None = None    # a game played in this block (games.py)


@app.get("/api/plan/step")
def get_plan_step():
    """The plan block being practiced: {block, drill, game, since} or null."""
    return {"step": load_plan_step()}


@app.post("/api/plan/step")
def set_plan_step(body: PlanStep):
    """Starts a plan block (or ends the plan with block null): practice voice off, the block's drill on
    (any other off), its game started (any other stopped)."""
    if body.drill is not None and body.drill not in drills.DRILLS:
        raise HTTPException(400, "Unknown drill")
    if body.game is not None and body.game not in {g["id"] for g in games_state.catalog()}:
        raise HTTPException(400, "Unknown game")
    if practice_state.config["on"]:
        practice_state.set_config({**practice_state.config, "on": False})
    if programs_state.run and body.block:
        programs_state.stop()
    drills_state.set(body.drill)
    drills_tick()
    running = games_state.game
    if running and running.get("id") != body.game:
        games_state.stop()
        running = None
    if body.game and not running:
        games_state.start(body.game, {})
    step = {"block": body.block, "drill": body.drill, "game": body.game, "since": round(time.time(), 3)} if body.block else None
    save_plan_step(step)
    print(f"Plan: {body.block or 'ended'}" + (f", drill {body.drill}" if body.drill else "") + (f", game {body.game}" if body.game else ""), flush=True)
    return {"step": step, "drill": drills_state.state(), "game": games_state.game}


# ---- Coach programs: drill blocks with gates, from the coach (programs.py, programs.json) ----
PROGRAM_FILE = Path(os.environ.get("SWINGCLIPS_PROGRAM", CLIPS_DIR.parent / "program.json"))
PROGRAMS_LOG = Path(os.environ.get("SWINGCLIPS_PROGRAMS_LOG", CLIPS_DIR.parent / "programs-log.jsonl"))


def program_block_drill(drill: str | None) -> None:
    """A program block starts (or the program ends): its drill mode on, any other off."""
    drills_state.set(drill)
    drills_tick()


programs_state = programs.Programs(PROGRAM_FILE, PROGRAMS_LOG, practice_state.new_id, on_block=program_block_drill)


@app.get("/api/program")
def get_program():
    """The coach program in play (its blocks, reps judged, gates), the programs there are, finished ones."""
    return programs_state.state()


class ProgramChoice(BaseModel):
    program: str


@app.post("/api/program")
def start_program(body: ProgramChoice):
    """Starts a coach program: practice voice, game and plan block off (one voice, one thing at a time)."""
    try:
        run = programs_state.start(body.program)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if practice_state.config["on"]:
        practice_state.set_config({**practice_state.config, "on": False})
    if games_state.game:
        games_state.stop()
    save_plan_step(None)
    print(f"Program: {run['name']} started", flush=True)
    return run


@app.post("/api/program/stop")
def stop_program():
    done = programs_state.stop()
    if done:
        print(f"Program: {done['name']} stopped. {done['spoken']}", flush=True)
    return {"stopped": done}


class ProgramTap(BaseModel):
    ok: bool


@app.post("/api/program/tap")
def program_tap(body: ProgramTap):
    """The golfer's verdict on a no-ball rep (pass/miss), or the mark they saw for the last shot."""
    try:
        return programs_state.tap(body.ok)
    except ValueError as e:
        raise HTTPException(400, str(e))


class ProgramBlockTaps(BaseModel):
    passes: int
    misses: int = 0


@app.post("/api/program/taps")
def program_taps(body: ProgramBlockTaps):
    """A no-ball block's reps at once, after doing them all: how many passed and missed."""
    try:
        return programs_state.tap_block(body.passes, body.misses)
    except ValueError as e:
        raise HTTPException(400, str(e))


class ProgramNote(BaseModel):
    text: str = Field("", max_length=1000)
    started: float | None = None


@app.post("/api/program/note")
def program_note(body: ProgramNote):
    """The golfer's setup notes (Omni moved, mat changed, an update) on the run in play or the last one."""
    try:
        return programs_state.note(body.text, body.started)
    except ValueError as e:
        raise HTTPException(404, str(e))


class ProgramWrist(BaseModel):
    started: float | None = None
    clip: str
    verdict: str | None = None


@app.post("/api/program/wrist")
def program_wrist(body: ProgramWrist):
    """Saves the golfer's lead wrist call at impact on one shot of a finished run or the run in play."""
    try:
        return programs_state.wrist(body.started, body.clip, body.verdict)
    except ValueError as e:
        msg = str(e)
        code = 404 if "No such run" in msg else 400
        raise HTTPException(code, msg)


@app.post("/api/program/undo")
def program_undo():
    try:
        return programs_state.undo()
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/program/next")
def program_next():
    """Ends the block in play as it stands and starts the next."""
    try:
        return programs_state.next_block()
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/program/report")
def program_report(started: float | None = None):
    """The report to paste back to the coach, of the program in play or a finished one."""
    def body(clip: str) -> dict | None:
        # The swing's camera numbers, once analyzed (swings.py records, by the face-on clip).
        with records_lock:
            rec = swing_records.get(clip)
        return rec.get("body") if rec else None
    got = programs_state.report(started, body)
    if got is None:
        raise HTTPException(404, "No program yet")
    return got


class CoachAskBody(BaseModel):
    session: str | int | float = ""
    brief: str = ""
    again: bool = False
    kind: str = "session"
    question: str | None = None


@app.post("/api/coach/ask")
def coach_ask(body: CoachAskBody):
    """The AI coach's short take on a session, week, or question."""
    return aicoach.ask(
        session=body.session,
        brief=body.brief,
        again=body.again,
        kind=body.kind,
        question=body.question,
        lock=files_lock,
    )


@app.get("/api/coach/notes")
def coach_notes(session: str | None = None, kind: str | None = None):
    """The kept note for a session, or all kept notes newest first."""
    if session is not None and str(session).strip():
        return aicoach.get_kept_note(session, kind=kind)
    return aicoach.get_all_notes(kind=kind)


@app.get("/api/coach/status")
def coach_status():
    """The provider in use and its model, which providers have a key (never the key), calls today, the cap."""
    return aicoach.status()


class CoachSettingsBody(BaseModel):
    provider: str | None = None
    model: str | None = None
    baseUrl: str | None = None
    key: str | None = None


@app.post("/api/coach/settings")
def coach_settings(body: CoachSettingsBody):
    """Tools > AI coach: the provider, its model, the base URL (other providers) and, when given, its key
    (kept in the provider's key file next to shots.jsonl; never sent back)."""
    try:
        if body.key is not None:
            aicoach.save_key(body.provider or aicoach.current()["provider"], body.key)
        aicoach.save_settings(body.provider, body.model, body.baseUrl)
    except ValueError as e:
        raise HTTPException(400, str(e))
    print(f"AI coach: provider {aicoach.current()['provider']}, model {aicoach.current()['model']}"
          + (" (key saved)" if body.key else ""), flush=True)
    return aicoach.status()


@app.get("/api/coach/models")
def coach_models(provider: str):
    """The provider's models that can write a reply (from its own list, with the saved key)."""
    if provider not in aicoach.PROVIDERS:
        raise HTTPException(400, "Unknown provider")
    try:
        return {"models": aicoach.list_models(provider, base_url=aicoach.load_settings().get("baseUrl") or "")}
    except aicoach.CoachError as e:
        return {"models": [], "error": str(e)}


@app.get("/api/still/{name}")
def get_still(name: str, t: float | None = Query(None, ge=0, le=60)):
    """A clip's frame at impact (as found, else the heard strike) as a JPEG: the frame a coach asks for.
    With `t` (clip seconds), the frame at that time instead (the Labels view's pick between two)."""
    path = checked_clip(name)
    if t is not None:
        return Response(pose.still_jpeg(str(path), t), media_type="image/jpeg")
    doc = json.loads(gzip.decompress(pose_file(name).read_bytes())) if pose_state(name) == "done" else {}
    t = doc.get("impact")
    if t is None:
        t = pose.clip_facts(str(path))[1]
    if t is None:
        raise HTTPException(404, "No impact or strike in this clip")
    return Response(pose.still_jpeg(str(path), t), media_type="image/jpeg")


# ---- Good shots: the rules for which shots count as good, per club (goodshots.py) ----
# The page works out the personal ranges from them (static/goodshots.js).
GOODSHOTS_FILE = Path(os.environ.get("SWINGCLIPS_GOODSHOTS", CLIPS_DIR.parent / "goodshots.json"))


@app.get("/api/goodshots")
def get_goodshots():
    return {"settings": goodshots.load(GOODSHOTS_FILE), "defaults": goodshots.DEFAULTS}


@app.post("/api/goodshots")
async def set_goodshots(request: Request):
    """Saves the rules (missing parts from the defaults); 400 when they don't make sense."""
    body = await request.json()
    try:
        with files_lock:
            s = goodshots.save(GOODSHOTS_FILE, body)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"settings": s, "defaults": goodshots.DEFAULTS}


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


@app.get("/api/labels/summary")
def labels_summary():
    """Every label file checked (labelcheck.py): moments, point frames, the ball, possible slips."""
    def saved(name: str) -> Path | None:
        for path in (pose_file(name), TRASH_DIR / "pose" / pose_file(name).name):
            if path.is_file():
                return path
        return None
    return {"clips": labelcheck.summary(LABELS_DIR, saved), "frameDone": labelcheck.FRAME_DONE}


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
def setup_lens(angle: str) -> dict | None:
    """The lens calibration for the phone filming `angle`, in the mode of its newest clip."""
    newest = None
    for p in clip_paths():
        m = SWING_NAME.match(p.name)
        if m and (m.group(1) or "face") == angle and (newest is None or recorded_at(p) > recorded_at(newest)):
            newest = p
    return calib.lens_for(angle, calib.mode_of(newest.name) if newest else None)


camera_setup = setup.Setup(STATIC_DIR, lens_for=setup_lens)


@app.post("/api/setup/{angle}")
async def setup_still(angle: str, request: Request, rotation: int = 0):
    """A phone's preview still (JPEG body): finds the golfer, returns what to fix (see setup.py)."""
    if angle not in setup.ANGLES:
        raise HTTPException(404, "No such camera angle")
    body = await request.body()
    if not body or len(body) > 5_000_000:
        raise HTTPException(400, "Expected a JPEG")
    try:
        verdict = await asyncio.to_thread(camera_setup.judge, angle, body, rotation)
    except ValueError as e:
        raise HTTPException(400, str(e))
    # One phone says both verdicts together, when they change (status.py).
    said = session_status.setup_verdicts(camera_setup.status())
    if said:
        print(f"Setup: {said}", flush=True)
    return verdict


@app.get("/api/setup")
def setup_status():
    return camera_setup.status()


@app.get("/api/setup/{angle}.jpg")
def setup_picture(angle: str, big: bool = False):
    """A camera's latest setup still, upright; big=1: the sharper copy (the tripod setup page's zoom)."""
    jpeg = camera_setup.picture(angle, big)
    if jpeg is None:
        raise HTTPException(404, "No picture from that camera yet")
    return Response(jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


# ---- Tripod setup page (static/tripods.html): a saved spot per camera to put the tripods back on ----
TRIPOD_DIR = Path(os.environ.get("SWINGCLIPS_TRIPODS", CLIPS_DIR.parent / "tripods"))


def tripod_spot(angle: str) -> dict | None:
    try:
        return json.loads((TRIPOD_DIR / f"{angle}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


@app.get("/api/tripods")
def tripod_spots():
    """Each camera's saved spot: {face: {saved, lm, note} or null, dtl: ...}."""
    return {a: tripod_spot(a) for a in setup.ANGLES}


class TripodSpot(BaseModel):
    note: str | None = Field(None, max_length=200)    # e.g. "32 in high, 11 ft from the ball"


@app.post("/api/tripods/{angle}")
def save_tripod_spot(angle: str, body: TripodSpot):
    """Keeps the camera's latest still (and where the golfer is in it) as its saved spot. The one it
    replaces goes to the trash folder."""
    if angle not in setup.ANGLES:
        raise HTTPException(404, "No such camera angle")
    jpeg = camera_setup.picture(angle, big=True)
    verdict = camera_setup.status().get(angle)
    if jpeg is None or not verdict:
        raise HTTPException(409, "No picture from that camera yet: open SwingClips on the phone (not recording)")
    with files_lock:
        TRIPOD_DIR.mkdir(parents=True, exist_ok=True)
        old = TRIPOD_DIR / f"{angle}.jpg"
        doc_path = TRIPOD_DIR / f"{angle}.json"
        if old.is_file():
            (TRASH_DIR / "tripods").mkdir(parents=True, exist_ok=True)
            stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            for f in (old, doc_path):
                if f.is_file():
                    f.replace(TRASH_DIR / "tripods" / f"{f.stem}_{stamp}{f.suffix}")
        tmp_jpg = old.with_suffix(".tmp")
        tmp_jpg.write_bytes(jpeg)
        tmp_jpg.replace(old)
        doc = {"angle": angle, "saved": time.time(), "lm": verdict.get("lm"), "note": body.note}
        tmp_json = doc_path.with_suffix(".tmp")
        tmp_json.write_text(json.dumps(doc), encoding="utf-8")
        tmp_json.replace(doc_path)
    print(f"Tripods: saved the {angle} spot", flush=True)
    return tripod_spots()


@app.get("/api/tripods/{angle}.jpg")
def tripod_picture(angle: str):
    path = TRIPOD_DIR / f"{angle}.jpg"
    if angle not in setup.ANGLES or not path.is_file():
        raise HTTPException(404, "No saved spot for that camera")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@app.get("/api/3d/{name}")
def get_3d(name: str):
    """A swing's 3D joints (tri.py), by its face-on clip: 404 unless 3D is on and it has them."""
    checked_clip(name)
    path = file_3d(name)
    if not calib.enabled() or not path.is_file():
        with records_lock:
            why = (swing_records.get(name) or {}).get("why3d")
        raise HTTPException(404, why or "No 3D for this swing")
    return FileResponse(path, media_type="application/json", headers={"Cache-Control": "no-store"})


@app.get("/api/calib")
def calib_status():
    """Whether 3D from both phones is on, and what's calibrated: lenses, the latest session; and
    the calibration page's recording and run (calibrun.py)."""
    drills_tick()
    run = calib_runs.state()
    lenses = []
    for f in sorted(calib.CALIB_DIR.glob("*-*.json")):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            lenses.append({"name": f.stem, "phone": d.get("phone"), "mode": d.get("mode"), "created": d.get("created"),
                           "rms": d.get("rms"), "good": d.get("good"), "coverage": d.get("coverage")})
        except (OSError, ValueError):
            continue
    s = calib.sessions()
    latest = s[-1] if s else None
    with records_lock:
        recs = dict(swing_records)
    health = swing3d.calib_health(s, recs)
    return {"enabled": calib.enabled(), "phones": calib.phones(), "lenses": lenses,
            "recording": run["current"], "job": run["job"], "tripods": run["tripods"], "height": run["height"],
            # Swings filmed from both phones since the tripods were set (for placing the cameras from them).
            "swingsSinceTripods": swings_since_tripods(run["tripods"]),
            # 3D off for the latest swings because a camera moved since the latest calibration.
            "moved": camera_moved() if calib.enabled() else None,
            # The latest recording's clips: each phone's of the lens board, and both of the mat board.
            "clips": {"face": calib_clips("lens", "face"), "dtl": calib_clips("lens", "dtl"), "mat": calib_clips("mat", None)},
            # Every lens clip of each phone still here (what Calibrate uses).
            "lensClips": {a: len(lens_clips(a)) for a in ("face", "dtl")},
            # Every calibration clip still in the clips folder (any recording but the one on), for the trash.
            "leftover": calib_leftover(),
            "session": latest and {"id": latest["id"], "created": latest["created"], "method": latest.get("method", "board"),
                                   "cameras": {k: {"position": v["position"], "rms": v.get("rms"), "warnings": v.get("warnings", [])}
                                               for k, v in latest["cameras"].items()}},
            "health": health}


@app.get("/api/calib/session")
def calib_session_file():
    """The latest calibration session in full (each camera's lens and place), for checking the 3D."""
    s = calib.sessions()
    if not s:
        raise HTTPException(404, "No calibration session yet")
    return s[-1]


# ---- The 3D calibration page (static/calibrate.html, calibrun.py): record the boards, run calib.py ----
calib_runs = calibrun.Runs(calib.CALIB_DIR / "recordings.json")


def calib_clips(kind: str, angle: str | None) -> list[dict]:
    """The clips of the latest calibration recording of this kind (lens: for that phone), oldest first:
    both phones', since a clap makes both record."""
    rec = calib_runs.latest(kind, angle)
    if not rec:
        return []
    out = []
    for p in clip_paths():
        m = SWING_NAME.match(p.name)
        if not m or p.name in pending_trash:
            continue
        a = m.group(1) or "face"
        t = recorded_at(p)
        if t >= rec["from"] - calibrun.START_SLACK_S and t <= rec.get("until", float("inf"))                 and calib_runs.kind_at(t) == kind:
            out.append({"name": p.name, "angle": a, "t": t})
    return sorted(out, key=lambda c: c["t"])


def lens_clips(angle: str) -> list[dict]:
    """All clips of the lens board from the phone filming `angle`, from any lens recording of it
    still in the clips folder (the latest mode's only), oldest first."""
    out = []
    for p in clip_paths():
        m = SWING_NAME.match(p.name)
        if not m or p.name in pending_trash or (m.group(1) or "face") != angle:
            continue
        t = recorded_at(p)
        rec = calib_runs.recording_at(t)
        if rec and rec["kind"] == "lens" and rec.get("angle") == angle:
            out.append({"name": p.name, "angle": angle, "t": t})
    out.sort(key=lambda c: c["t"])
    if out:
        mode = calib.mode_of(out[-1]["name"])
        out = [c for c in out if calib.mode_of(c["name"]) == mode]
    return out


def calib_leftover() -> list[str]:
    """The calibration clips still in the clips folder, but those of the recording that's on."""
    cur = calib_runs.state()["current"]
    out = []
    for p in clip_paths():
        if not SWING_NAME.match(p.name) or p.name in pending_trash:
            continue
        t = recorded_at(p)
        if calib_runs.kind_at(t) and not (cur and t >= cur["from"]):
            out.append(p.name)
    return out


def swings_since_tripods(since: float | None) -> int:
    """Face-on clips with a down-the-line partner since `since`, calibration clips left out."""
    if since is None:
        return 0
    face = dtl = 0
    for p in clip_paths():
        m = SWING_NAME.match(p.name)
        if not m or p.name in pending_trash:
            continue
        t = recorded_at(p)
        if t >= since and not calib_runs.kind_at(t):
            if (m.group(1) or "face") == "face":
                face += 1
            else:
                dtl += 1
    return min(face, dtl)


class TripodsSet(BaseModel):
    since: float | None = None   # unix time: the swings from then on place the cameras (default: now)


@app.post("/api/calib/tripods")
def calib_tripods(body: TripodsSet | None = None):
    """The tripods are set (or were moved): the swings from now on place the cameras, or from `since`
    (the calibration page offers the start of the swings a moved camera turned 3D off for)."""
    since = body.since if body else None
    if since is not None:
        s = calib.sessions()
        if since > time.time() or (s and since <= s[-1]["created"]):
            raise HTTPException(400, "since must be after the latest calibration and not in the future")
    t = calib_runs.set_tripods(since)
    print(f"3D: tripods set at {datetime.fromtimestamp(t):%a %H:%M:%S}", flush=True)
    return calib_status()


# A camera moved: this many swings in a row since the latest calibration said so (swing3d.moved,
# ball_moved), with none in 3D after them. Shown on the Start and 3D calibration pages.
MOVED_SWINGS = 3


def camera_moved() -> dict | None:
    """{since: the first of those swings' time, swings: how many, text: the latest one's why}, or None."""
    s = calib.sessions()
    latest = s[-1]["created"] if s else None
    with records_lock:
        recs = [(n, r.get("why3d"), bool(r.get("body3d"))) for n, r in swing_records.items() if r.get("partner")]
    run = []
    for t, why, ok in sorted((recorded_at(CLIPS_DIR / n), why, ok) for n, why, ok in recs):
        if latest is not None and t < latest:
            continue
        if ok:
            run = []
        elif why and "moved" in why:
            run.append((t, why))
    if len(run) < MOVED_SWINGS:
        return None
    return {"since": run[0][0], "swings": len(run), "text": run[-1][1]}


class BodyPlacement(BaseModel):
    heightIn: float   # the golfer's height in inches
    dtlFloorIn: float | None = None   # tape measure: the down-the-line phone to the ball along the floor, inches


@app.post("/api/calib/body")
def calib_body(body: BodyPlacement):
    """Places both phones from the swings since the tripods were set (bodycalib.py), in the swing
    worker; poll /api/calib for the result (job kind "body")."""
    height = body.heightIn * 0.0254
    if not 1.2 <= height <= 2.3:
        raise HTTPException(400, "Height should be between 48 and 90 inches")
    floor = body.dtlFloorIn * 0.0254 if body.dtlFloorIn else None
    if floor is not None and not 1.0 <= floor <= 10.0:
        raise HTTPException(400, "The down-the-line phone's distance should be between 40 and 390 inches")
    try:
        calib_runs.start_job("body", height, floor)
    except ValueError as e:
        raise HTTPException(409, str(e))
    print(f"3D: placing the cameras from the swings (height {body.heightIn:g} in)", flush=True)
    return calib_status()


class CalibRecording(BaseModel):
    kind: str | None = None    # "lens" | "mat", or None to stop
    angle: str | None = None   # lens: the phone, "face" | "dtl"


@app.post("/api/calib/record")
def calib_record(body: CalibRecording):
    """Starts a calibration recording ({kind: "lens", angle} or {kind: "mat"}) or stops it ({kind: null})."""
    try:
        cur = calib_runs.record(body.kind, body.angle)
    except ValueError as e:
        raise HTTPException(400, str(e))
    drills_tick()
    print(f"Calibration recording: {cur['kind'] + (' ' + cur['angle'] if cur['angle'] else '') if cur else 'off'}", flush=True)
    return calib_status()


class CalibRun(BaseModel):
    kind: str                       # "lens" | "mat"
    angle: str | None = None        # lens: "face" | "dtl"
    phone: str | None = None        # lens: a name for the phone (default: phones.json's, else "<angle>-phone")
    squareMm: float | None = None   # mat: the mat board's square as printed, if not 150 mm


@app.post("/api/calib/run")
def calib_run(body: CalibRun):
    """Runs calib.py on the latest recording's clips (ending the recording); poll /api/calib for the result."""
    if body.kind == "lens":
        if body.angle not in calibrun.ANGLES:
            raise HTTPException(400, "Which phone? angle face or dtl")
        phone = re.sub(r"[^A-Za-z0-9_-]", "", body.phone or "") or calib.phones().get(body.angle) or f"{body.angle}-phone"
        # Every lens recording's clips of this phone still in the clips folder: each try adds views.
        clips = lens_clips(body.angle)
        if not clips:
            raise HTTPException(400, "No clips of the lens board from that phone yet")
        args = ["lens", "--phone", phone, "--angle", body.angle] + [str(CLIPS_DIR / c["name"]) for c in clips]
    elif body.kind == "mat":
        clips = calib_clips("mat", None)
        newest = {a: next((c for c in reversed(clips) if c["angle"] == a), None) for a in calibrun.ANGLES}
        missing = [{"face": "the face-on phone", "dtl": "the down-the-line phone"}[a] for a, c in newest.items() if not c]
        if missing:
            raise HTTPException(400, "No clip of the mat board from " + " or ".join(missing) + " yet")
        clips = [newest["face"], newest["dtl"]]
        args = ["session", str(CLIPS_DIR / clips[0]["name"]), str(CLIPS_DIR / clips[1]["name"])]
        if body.squareMm:
            args += ["--square-mm", f"{body.squareMm:g}"]
    else:
        raise HTTPException(400, "Unknown calibration")
    cur = calib_runs.state()["current"]
    if cur and cur["kind"] == body.kind:
        calib_runs.record(None)
        drills_tick()
    try:
        calib_runs.run(body.kind, args, [c["name"] for c in clips])
    except ValueError as e:
        raise HTTPException(409, str(e))
    print("Calibration: calib.py " + " ".join(args[:4]) + f" ... ({len(clips)} clip(s))", flush=True)
    return calib_status()


# ---- Session status: the phones and the Square watcher report in (see status.py) ----
session_status = status.Status()
# When the newest shot came in (unix s): kept as shots arrive, read from shots.jsonl once at the start.
last_shot_at: float | None = None
_shots_read = False


def newest_shot() -> float | None:
    global last_shot_at, _shots_read
    if last_shot_at is None and not _shots_read:
        _shots_read = True
        try:
            with open(SHOTS_FILE, "rb") as f:
                f.seek(max(0, f.seek(0, os.SEEK_END) - 8192))
                for line in reversed(f.read().decode("utf-8", "replace").splitlines()):
                    try:
                        last_shot_at = datetime.fromisoformat(json.loads(line)["received"]).timestamp()
                        break
                    except (ValueError, KeyError, TypeError):
                        continue
        except OSError:
            pass
    return last_shot_at


def start_square_watch(stop: threading.Event) -> square_watch.SquareWatcher | None:
    """Watches Square's app's shots when it runs on this PC (square_watch.py; SWINGCLIPS_SQUARE_DB)."""
    db = square_watch.configured_db()
    if db is None:
        return None
    watcher = square_watch.SquareWatcher(db, on_shot=record_shot, on_beat=session_status.relay_heartbeat)
    threading.Thread(target=watcher.run, args=(stop,), daemon=True).start()
    return watcher


def status_worker(stop: threading.Event):
    """Forever: time out unanswered commands, and while a session is open, check its swings."""
    while not stop.is_set():
        try:
            status_tick()
        except Exception:
            traceback.print_exc()
        stop.wait(2)


def status_tick() -> list[str]:
    """One look at the open session's swings (the first one's check, problems after); returns what was said."""
    since = session_status.session_since()
    if since is None:
        return []
    clips = listed_clips(since=since - PAIR_SLACK_S)
    by_name = {c["name"]: c for c in clips}
    swings_now = [dict(c) for c in clips
                  if SWING_NAME.match(c["name"]) and not (c["partner"] and c["angle"] != "face")]
    with records_lock:
        records = {s["name"]: swing_records.get(s["name"]) for s in swings_now}
    for s in swings_now:
        s["t"] = recorded_at(CLIPS_DIR / s["name"])
        partner = by_name.get(s["partner"] or "")
        s["partnerPose"] = partner["pose"] if partner else None
        rec = records[s["name"]]
        # Only a record worked out with today's JavaScript and the swing's current partner.
        if rec and rec.get("code") == swings_code and rec.get("partner") == s["partner"]:
            if "error" in rec:
                s["pose"], rec = "failed", None
        else:
            rec = None
        s["record"] = rec
        s["quality"] = {s["angle"]: s["quality"], **({"dtl": partner["quality"]} if partner else {})}
    # Square shots of the session, and whether a clip got each (listed_clips pairs them): soft
    # strikes the phones didn't hear show up as shots with no clip.
    paired = {(c.get("shot") or {}).get("received") for c in clips if c.get("shot")}
    shots = [{"t": s["_t"], "clipped": s.get("received") in paired} for s in load_shots() if s["_t"] >= since - PAIR_SLACK_S]
    said = session_status.health_step(swings_now, shots)
    for text in said:
        print(f"Status: {text}", flush=True)
    for e in session_status.drain_events():
        log_event(e.pop("kind"), **e)
    return said


@app.post("/api/phones/{angle}/poll")
async def phone_poll(angle: str, request: Request, wait: float = Query(0, ge=0, le=status.POLL_WAIT_MAX_S)):
    """A capture phone (0.6 and later) reports in: its state as JSON, with its answers to commands
    ("acks"). Held open up to `wait` s until there's a command or something to say for it (a long
    poll): {commands: [{id, action}], say: [{id, text, flush}], ms (the server's clock),
    quiet (s not to listen for strikes: the other phone is talking; 0 = listen again; only when new),
    pre (s of video to keep before the strike, more during a drill; only when it should change)}."""
    if angle not in status.ANGLES:
        raise HTTPException(404, "No such camera angle")
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "Expected JSON")
    if not isinstance(body, dict):
        raise HTTPException(400, "Expected the phone's state")
    session_status.heartbeat(angle, body)
    drills_tick()
    give_up = time.monotonic() + wait
    while not session_status.has_mail(angle) and time.monotonic() < give_up:
        if await request.is_disconnected():
            # The phone hung up to report something new: keep what's waiting for its next poll.
            return Response(status_code=204)
        # Often: a quiet for this phone (the other one is about to talk) must beat the voice.
        await asyncio.sleep(0.1)
    out = session_status.take(angle)
    for x in out["say"]:
        sent_to_say(angle, x["text"], "phone poll")
    if "quiet" in out:
        log_event("quiet", to=angle, s=out["quiet"])
    if "pre" in out:
        log_event("pre", to=angle, s=out["pre"])
    return out


class PhoneCommand(BaseModel):
    action: str
    angle: str = "both"


@app.post("/api/phones/command")
def phone_command(body: PhoneCommand):
    """Start or stop recording from the review page: {action: "start" | "stop", angle: "face" | "dtl" | "both"}.
    Each phone's outcome so far (queued, or refused with why); its answer shows in /api/status."""
    try:
        out = session_status.command(body.action, body.angle)
    except ValueError as e:
        raise HTTPException(400, str(e))
    print("Phones: " + ", ".join(f"{r['action']} {r['angle']}: {r['error'] or 'sent'}" for r in out), flush=True)
    return {"results": out}


class PhoneSensitivity(BaseModel):
    value: int
    angle: str = "both"


@app.post("/api/phones/sensitivity")
def phone_sensitivity(body: PhoneSensitivity):
    """The strike trigger's sensitivity from the Start page: {value: 0-120, angle: "face" | "dtl" | "both"}.
    Each phone takes it on its next poll, recording or not (capture app 0.12 and later)."""
    try:
        out = session_status.set_sensitivity(body.angle, body.value)
    except ValueError as e:
        raise HTTPException(400, str(e))
    print("Phones: " + ", ".join(f"sensitivity {body.value} {r['angle']}: {r['error'] or 'sent'}" for r in out), flush=True)
    log_event("sensitivity", value=body.value, angle=body.angle)
    return {"results": out}


@app.post("/api/relay/heartbeat")
async def relay_heartbeat(request: Request):
    """The sim laptop's launcher: {source, squareRunning, lastShotAt, version}, about every 30 s."""
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "Expected JSON")
    if not isinstance(body, dict):
        raise HTTPException(400, "Expected a heartbeat")
    return {"ok": True, "ms": int(time.time() * 1000), "got": session_status.relay_heartbeat(body)}


@app.post("/api/relay/agent")
async def relay_agent_poll(request: Request, wait: int = 15):
    """The sim laptop's launcher agent (relay/golf-agent.ps1): reports what is running on the laptop,
    holds open a long poll for launcher commands queued by the server."""
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "Expected JSON")
    if not isinstance(body, dict):
        raise HTTPException(400, "Expected agent status object")
    session_status.agent_heartbeat(body)
    give_up = time.monotonic() + max(0, min(wait, 30))
    while not session_status.has_agent_mail() and time.monotonic() < give_up:
        if await request.is_disconnected():
            return Response(status_code=204)
        await asyncio.sleep(0.2)
    return session_status.take_agent_mail()


class RelayCommand(BaseModel):
    action: str
    source: str | None = None


@app.post("/api/relay/command")
def relay_command(body: RelayCommand):
    """Queue a launcher action for the sim laptop agent (start/stop Square, watcher, gspro, switch source, open start)."""
    try:
        res = session_status.agent_command(body.action, source=body.source)
    except ValueError as e:
        raise HTTPException(400, str(e))
    print(f"Relay command: {body.action} ({body.source or ''}) -> {res['id']}", flush=True)
    return {"ok": True, "result": res}


@app.get("/api/events")
def get_events(since: str = "", kind: str = "", limit: int = Query(2000, ge=1, le=20000)):
    """The events log (what the phones were sent to say, uploads, quiet, clips with no swing), newest
    `limit` lines from `since` (an ISO time, e.g. 2026-10-04 or 2026-10-04T17:00), optionally one kind."""
    try:
        lines = EVENTS_FILE.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return []
    out = []
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if (not since or e.get("t", "") >= since) and (not kind or e.get("kind") == kind):
            out.append(e)
    return out[-limit:]


@app.get("/api/relay/files")
def relay_files():
    """The sim laptop's scripts and their SHA-256: relay/golf-launcher.ps1 fetches the ones that differ."""
    return {"files": update.relay_files()}


@app.get("/api/relay/files/{name}")
def relay_file(name: str):
    path = update.relay_file(name)
    if path is None:
        raise HTTPException(404, "No such relay script")
    return FileResponse(path, media_type="application/octet-stream")


# Tools > Update the server (static/update.js): what's new, then a fast-forward pull, then a restart
# when the change needs one (update.py says which). The restart is the server exiting with
# update.RESTART_EXIT; "Start server.cmd" runs it again.
restart_requested = threading.Event()
uvicorn_server = None


@app.get("/api/update")
def update_check():
    try:
        got = update.check()
    except update.GitError as e:
        raise HTTPException(502, str(e))
    got["session"] = session_on()
    return got


@app.post("/api/update")
def update_now(restart: bool = True):
    try:
        got = update.pull()
    except update.GitError as e:
        raise HTTPException(409, str(e))
    got["restarting"] = restart and got["restart"] == "auto"
    print(f"Update: {got['from']} -> {got['to']}, {len(got['files'])} files, restart {got['restart']}"
          + (" (restarting)" if got["restarting"] else ""), flush=True)
    if got["restarting"]:
        threading.Timer(1.0, restart_server).start()  # after this answer has gone
    return got


@app.post("/api/restart")
def restart_now():
    """Restart without updating (e.g. after an update that was pulled with restart=false)."""
    if uvicorn_server is None:
        raise HTTPException(409, "This server wasn't started by app.py, so it can't restart itself")
    threading.Timer(1.0, restart_server).start()
    return {"restarting": True}


def restart_server():
    restart_requested.set()
    if uvicorn_server is not None:
        uvicorn_server.should_exit = True


@app.get("/api/status")
def get_status():
    """The Ready panel (static/status.js): phones, Square, framing, the first swing's check, the pose queue."""
    setup_now = {a: v and {k: x for k, x in v.items() if k not in ("lm", "focus")}
                 for a, v in camera_setup.status().items()}
    return session_status.snapshot(setup_now, {"queued": pose_queued, "busy": pose_busy, "deepLeft": pose_deep_left,
                                              "held": DURING_SESSION == "wait" and session_on()},
                                   newest_shot())


# Clips handed to the night worker a moment ago (name -> time), so a second worker or a retry doesn't
# get the same one; handed out again after NIGHT_CLAIM_S. Clips it couldn't analyze, until a restart.
_night_claims: dict[str, float] = {}
_night_failed: set[str] = set()
NIGHT_CLAIM_S = 900
# The worker's last ask: {"at": time, "worker": its name, "clip": what it was given}.
night_seen: dict = {}


@app.get("/api/night/next")
def night_next(worker: str = Query("", max_length=60)):
    """The night worker's next clip (night.next_clip) and how to analyze it, or {"wait": s, "why"}:
    nothing while a session is on, so the phones' uploads and the server's own analysis come first."""
    now = time.time()
    night_seen.update(at=now, worker=worker, clip=None)
    if session_on(now):
        return {"wait": 300, "why": "A session is on"}
    labeled = set(list_labels()["1"])
    skip = {n for n, t in _night_claims.items() if now - t < NIGHT_CLAIM_S} | _night_failed
    c = night.next_clip(listed_clips(with_shots=False), NIGHT_DIR, labeled, skip)
    if c is None:
        # allDone: the worker's improve step may run now (night_worker.py).
        busy = any(now - t < NIGHT_CLAIM_S for t in _night_claims.values())
        return {"wait": 1800, "why": "Every clip is done", "allDone": not busy}
    _night_claims[c["name"]] = now
    night_seen["clip"] = c["name"]
    deep = deep_profile()
    return {"name": c["name"], "angle": c["angle"], "version": night.VERSION, **night.PROFILE,
            "clubStamp": deep and deep_club_stamp(deep)}


@app.get("/api/night/club")
def night_club():
    """The deep pass's club model, for the night worker to use the same one."""
    deep = deep_profile()
    if not deep or not deep.get("clubModel"):
        raise HTTPException(404, "No club model for the deep pass")
    return FileResponse(deep["clubModel"], media_type="application/octet-stream")


@app.post("/api/night/{name}")
async def night_put(name: str, request: Request, worker: str = Query("", max_length=60),
                    failed: str | None = Query(None, max_length=300)):
    """The worker's pose file for a clip (gzip JSON), or ?failed=why when it couldn't analyze it."""
    checked_clip(name)
    _night_claims.pop(name, None)
    if failed is not None:
        _night_failed.add(name)
        log_event("night", clip=name, worker=worker, failed=failed)
        print(f"Night: {name} FAILED on {worker or 'the worker'}: {failed}", flush=True)
        return {"ok": True}
    try:
        stamp = night.save(NIGHT_DIR, name, await request.body(), {"worker": worker, "at": round(time.time())})
    except (OSError, ValueError, EOFError) as e:
        raise HTTPException(400, f"Not a pose file: {e}")
    print(f"Night: {name} from {worker or 'the worker'}", flush=True)
    return {"ok": True, "night": stamp}


@app.get("/api/night")
def night_status():
    """How far the night worker has got, when it last asked, and each swing's key positions by it
    against the server's: {swings: {clip: {face, dtl: {ms: night minus server, t: the server's times}}}}."""
    names = [p.name for p in clip_paths()]
    done = sum(1 for n in names if night.version_of(night.night_file(NIGHT_DIR, n)) == night.VERSION)
    table = night_table or night.load_compare(NIGHT_COMPARE)
    return {"done": done, "clips": len(names), "seen": night_seen or None, "version": night.VERSION,
            "swings": {k: {a: v[a] for a in ("face", "dtl") if a in v} for k, v in table.items() if "error" not in v}}


# The improve step's candidates and nights (improve.py): the Night report (Tools menu).
IMPROVE_DIR = Path(os.environ.get("SWINGCLIPS_IMPROVE", CLIPS_DIR.parent / "improve"))
improve_store = improve.Store(IMPROVE_DIR)


def club_in_use() -> tuple[Path, str | None]:
    """Where the deep pass's club model is (or would be), and its stamp (None without one)."""
    deep = deep_profile()
    path = Path(deep["clubModel"]) if deep and deep.get("clubModel") else models.models_dir() / "club-deep.onnx"
    return path, (deep_club_stamp({"clubModel": path}) if path.is_file() else None)


def deep_left(stamp: str | None) -> int:
    return sum(1 for p in clip_paths() if p.name not in _deep_failed and pose_state(p.name) == "done"
               and needs_deep(p.name, stamp))


@app.get("/api/improve")
def improve_report():
    """The Night report: the club model in use, clips still waiting for the deep pass, the candidates
    (newest first) and what each night did."""
    path, stamp = club_in_use()
    since = datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds") if stamp else None
    sig = improve.labels_sig(LABELS_DIR)
    progress = improve_store.progress(improve.club_frames(LABELS_DIR), sig)
    return {"inUse": {"club": stamp, "since": since}, "deepLeft": deep_left(stamp),
            "candidates": improve_store.listing(stamp), "nights": improve_store.nights(),
            "progress": progress}


@app.get("/api/improve/next")
def improve_next():
    """For the night worker: whether a new club model is worth training (at least improve.MIN_NEW_FRAMES
    club-labeled frames new since the last scored try), the labeled clips to fetch, and the models to
    score against."""
    sig = improve.labels_sig(LABELS_DIR)
    labeled = list_labels()["1"]
    _, stamp = club_in_use()
    progress = improve_store.progress(improve.club_frames(LABELS_DIR), sig)
    new = progress["newFrames"]
    due, why = True, (f"{new} new club-labeled frames since the last try." if new is not None
                      else "No club model trained here yet.")
    if not labeled:
        due, why = False, "No labels yet."
    elif stamp is None:
        due, why = False, "No club model in use to compare with."
    elif new is not None and new < improve.MIN_NEW_FRAMES:
        due, why = False, (f"Nothing to train: {new} new club-labeled frame{'s' if new != 1 else ''} since the "
                           f"last try (needs {improve.MIN_NEW_FRAMES}; Tools > Club check adds them).")
    return {"due": due, "why": why, "labelsSig": sig, "labels": labeled, "bodyModel": models.backend(),
            "clubStamp": stamp, "newFrames": new, "need": improve.MIN_NEW_FRAMES}


@app.post("/api/improve/night")
async def improve_night(request: Request):
    """What a night did (the worker sends it as it goes): {started, ended, worker, clips, improve}."""
    try:
        return {"nights": improve_store.note_night(await request.json())}
    except (ValueError, TypeError, AttributeError) as e:
        raise HTTPException(400, str(e))


@app.post("/api/improve/{cid}/model")
async def improve_model(cid: str, request: Request):
    """A candidate's model (.onnx), before its report."""
    try:
        path = improve_store.save_model(cid, await request.body())
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "stamp": models.club_stamp(path)}


@app.post("/api/improve/{cid}/report")
async def improve_put_report(cid: str, request: Request):
    """A candidate's report (improve.py: status, scores, verdict, summary, train)."""
    try:
        report = improve_store.save_report(cid, await request.json())
    except (ValueError, TypeError, AttributeError) as e:
        raise HTTPException(400, str(e))
    log_event("improve", candidate=cid, status=report.get("status"))
    print(f"Improve: candidate {cid} is {report.get('status')}", flush=True)
    return {"ok": True}


@app.post("/api/improve/{cid}/use")
def improve_use(cid: str):
    """The owner's tap: candidate `cid`'s club model becomes the deep pass's; every clip gets the
    deep pass again with it (needs_deep). The model it replaces stays as a candidate to go back to."""
    target, stamp = club_in_use()
    try:
        improve_store.use(cid, target, stamp, TRASH_DIR / "models", models.club_stamp)
    except (OSError, ValueError) as e:
        raise HTTPException(400, str(e))
    _deep_failed.clear()
    _, now = club_in_use()
    log_event("improve", candidate=cid, used=now)
    print(f"Improve: now using {cid} ({now}); every clip gets the deep pass again when idle", flush=True)
    return {"ok": True, "inUse": {"club": now}, "deepLeft": deep_left(now)}


@app.get("/api/night/pose/{name}")
def get_night_pose(name: str):
    """The night worker's pose file for a clip (gzip JSON), 404 when not analyzed yet."""
    checked_clip(name)
    path = night.night_file(NIGHT_DIR, name)
    if not path.is_file():
        raise HTTPException(404, "No night pose for this clip")
    return FileResponse(path, media_type="application/json", headers={"Content-Encoding": "gzip"})


@app.get("/api/pose/{name}")
def get_pose(name: str):
    checked_clip(name)
    state = pose_state(name)
    if state != "done":
        raise HTTPException(404, f"Pose is {state}")
    return FileResponse(pose_file(name), media_type="application/json", headers={"Content-Encoding": "gzip"})


# The clubhead-motion trace for labeling the takeaway (labels.js): crops kept for the last few clips,
# since decoding the window takes a few seconds.
_clubhead_cache: dict[tuple, list] = {}
CLUBHEAD_CACHE = 4


@app.get("/api/clubmotion/{name}")
def get_clubmotion(name: str, quiet: float, until: float):
    """How the box round the clubhead at address changes, frame by frame (pose.clubhead_motion):
    against its look while still before `quiet` (s), from 0.35 s before that to `until`."""
    clip = checked_clip(name)
    if pose_state(name) != "done":
        raise HTTPException(404, "Not analyzed yet")
    doc = json.loads(gzip.decompress(pose_file(name).read_bytes()))
    if not doc.get("ball"):
        raise HTTPException(404, "No ball found in this clip: the trace watches the clubhead behind it")
    if not 0 <= quiet < until <= quiet + 2.5:
        raise HTTPException(400, "quiet must come before until, at most 2.5 s apart")
    key = (name, round(quiet, 3), round(until, 3), pose_file(name).stat().st_mtime)
    crops = _clubhead_cache.get(key)
    if crops is None:
        crops = pose.clubhead_crops(str(clip), doc.get("rotation", 0), doc["ball"], quiet - 0.35, until)
        while len(_clubhead_cache) >= CLUBHEAD_CACHE:
            _clubhead_cache.pop(next(iter(_clubhead_cache)))
        _clubhead_cache[key] = crops
    got = pose.clubhead_motion(crops, quiet)
    if got is None:
        raise HTTPException(404, "Too little of the clip before the takeaway to compare with")
    return got


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/start")
def start_page():
    """The session start page for the sim laptop: checks, both cameras' pictures, Start/Stop, the last swings."""
    return FileResponse(STATIC_DIR / "start.html")


@app.get("/tripods")
def tripods_page():
    """The tripod setup page: what each camera sees, framing meters, line tools, a saved spot to match."""
    return FileResponse(STATIC_DIR / "tripods.html")


@app.get("/calibrate")
def calibrate_page():
    """The 3D calibration page: record the lens and mat boards and run calib.py (calibrun.py)."""
    return FileResponse(STATIC_DIR / "calibrate.html")


class QuietPolling(logging.Filter):
    """Leaves out the requests every open review page (and phone) makes every second or few."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        # The phones' setup stills come every second; so do the Camera setup page's checks.
        return not any(path in message for path in ('"GET /api/clips ', '"GET /api/time ', " /api/setup",
                                                         " /api/practice/latest", " /api/phones/",
                                                         '"GET /api/status ', '"GET /api/calib ', " /api/relay/heartbeat",
                                                         " /api/relay/agent"))


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
    trim_events()
    print(f"Events (what was said, uploads, no-swing clips and why): {EVENTS_FILE}")
    # Another body model (settings.cmd: set SWINGCLIPS_POSE_BACKEND=rtmpose-m): fetched once if missing.
    # Without it every new clip would fail, so MediaPipe carries on until it can be downloaded.
    backend = models.backend()
    if backend != models.DEFAULT and not models.model_path(backend).is_file():
        try:
            import fetch_models
            fetch_models.fetch(backend)
        except Exception as e:
            print(f"Body model {backend}: couldn't download it ({e}); using MediaPipe until the next start")
            os.environ["SWINGCLIPS_POSE_BACKEND"] = models.DEFAULT
    print(f"Body model: {body_model()} (clips analyzed with another are analyzed again when the server is idle)")
    if models.provider_setting() != models.PROVIDER_DEFAULT and (
            models.backend() != models.DEFAULT or models.club_backend() != models.CLUB_DEFAULT):
        print(f"ONNX models on: {models.PROVIDER_NAMES[models.provider()]} (SWINGCLIPS_ORT_PROVIDER="
              f"{models.provider_setting()}), body model on "
              + ("every frame" if pose.body_stride() == 1 else f"every {pose.body_stride()} frames")
              + f", {POSE_WORKERS} workers")
    print(f"Open http://localhost:{PORT} here, or http://<this PC's name>:{PORT} from other devices")
    logging.getLogger("uvicorn.access").addFilter(QuietPolling())
    logging.getLogger("uvicorn.error").addFilter(QuietShutdown())
    # Ctrl+C: don't wait on open browser connections (a review page or a video keeps one open).
    uvicorn_server = uvicorn.Server(uvicorn.Config(app, host="0.0.0.0", port=PORT, timeout_graceful_shutdown=2))
    uvicorn_server.run()
    if restart_requested.is_set():
        # A clip being analyzed is analyzed again after the restart: don't wait for it.
        for child in multiprocessing.active_children():
            child.kill()
        print("Restarting...", flush=True)
        os._exit(update.RESTART_EXIT)
