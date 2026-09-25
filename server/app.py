"""SwingClips home server: lists the clips in CLIPS_DIR and serves them to any browser on the LAN.
A background worker runs pose on each new clip and saves it to POSE_DIR for the skeleton overlay.

Run with "Start server.cmd", or:  .venv\\Scripts\\python.exe app.py
Settings (environment variables): SWINGCLIPS_CLIPS (clips folder), SWINGCLIPS_POSE (pose results,
default: a "pose" folder next to the clips folder), SWINGCLIPS_PORT (default 8000),
SWINGCLIPS_POSE_MODEL (MediaPipe .task file; default public/mediapipe/pose_landmarker_full.task),
SWINGCLIPS_LABELS (hand labels for the scorecard, eval.py; default: a "labels" folder next to the clips folder),
SWINGCLIPS_PRACTICE / SWINGCLIPS_PRACTICE_LOG (practice mode's target and log; default next to the clips folder),
SWINGCLIPS_NOISE (the noise floor per number; default noise.json next to the clips folder),
SWINGCLIPS_GOODSHOTS (the rules for which shots count as good, for your personal ranges; default
goodshots.json next to the clips folder),
SWINGCLIPS_3D=on (3D from both phones: calib.py, tri.py; off by default) and SWINGCLIPS_CALIB (its
calibrations; default: a "calib" folder next to the clips folder).
Once a clip's pose is saved, the same worker measures its light, grain, flicker and sharpness (quality.py).
The swing worker keeps each swing's numbers (swings.py) and the noise floor per number (noise.json),
which the page's trust rules (static/trust.js) use.
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

import calib
import goodshots
import labelcheck
import models
import pose
import quality
import practice
import setup
import status
import swing3d
import swings
import tri

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


def body_model() -> str:
    """Which model places the 2D landmarks in new pose files: "mediapipe", or e.g. "rtmpose-m-256x192"
    (SWINGCLIPS_POSE_BACKEND, see models.py)."""
    b = models.backend()
    return b if b == models.DEFAULT else models.stamp(b)


# What made each pose file, by clip name: (file's mtime, body model, ball search version). The
# worker checks every clip.
_pose_models: dict[str, tuple[int, str, int]] = {}
# Clips that failed to be analyzed again with the current model, or to have the ball found again
# (kept as they were until a restart).
_again_failed: set[str] = set()
_ball_failed: set[str] = set()


def _pose_stamp(name: str) -> tuple[str, int] | None:
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
        got = (mtime, m.group(1) if m else models.DEFAULT, int(b.group(1)) if b else 1)
        _pose_models[name] = got
    return got[1], got[2]


def pose_model(name: str) -> str | None:
    """Which body model made a clip's pose file ("mediapipe" when it doesn't say), or None without one."""
    stamp = _pose_stamp(name)
    return stamp and stamp[0]


def pose_made(name: str) -> str | None:
    """What a clip's pose file came from: body model and ball search, e.g. "rtmpose-m-256x192+ball2".
    Quality records, swing numbers and 3D keep it, and are worked out again when it changes."""
    stamp = _pose_stamp(name)
    return stamp and f"{stamp[0]}+ball{stamp[1]}"


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
            pool = ProcessPoolExecutor(POSE_WORKERS)
    finally:
        with files_lock:
            pose_busy = None
    return pool


def analyze_clip(clip: Path, pool: ProcessPoolExecutor, again: bool = False) -> ProcessPoolExecutor:
    """Runs pose on one clip and saves the result; returns the pool (a fresh one if a worker died)."""
    global pose_busy
    with files_lock:
        if not clip.exists() or clip.name in pending_trash:
            return pool
        pose_busy = clip.name
    print(f"Pose: {clip.name} ...{' again, with ' + body_model() if again else ''}", flush=True)
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
        if again:  # a clip that was analyzed before keeps its old result
            _again_failed.add(clip.name)
        else:
            error_file(clip.name).write_text(traceback.format_exc())
        print(f"Pose: {clip.name} FAILED{' (keeps its old result)' if again else ' - see ' + str(error_file(clip.name))}",
              flush=True)
        if again:
            traceback.print_exc()
        if isinstance(e, BrokenProcessPool):
            # A worker process died (e.g. a bad video crashed the decoder); start fresh ones.
            pool = ProcessPoolExecutor(POSE_WORKERS)
    finally:
        with files_lock:
            pose_busy = None
    return pool


def pose_worker(stop: threading.Event):
    """Forever: find clips without pose results, newest first, and analyze them one at a time."""
    global pose_busy, pose_queued
    POSE_DIR.mkdir(parents=True, exist_ok=True)
    # Kept between clips so the worker processes only pay for importing MediaPipe once.
    pool = ProcessPoolExecutor(POSE_WORKERS)
    summarizer = None
    try:
        while not stop.is_set():
            retry_pending_trash()
            queued = [p for p in clip_paths() if pose_state(p.name) == "queued"]
            pose_queued = len(queued)
            todo = [p for p in queued if time.time() - p.stat().st_mtime > SETTLE_SECONDS]
            if not todo:
                # Nothing new: analyze again, newest first, a clip whose pose came from another body model
                # (after SWINGCLIPS_POSE_BACKEND changed), so every swing is measured the same way.
                model = body_model()
                again = [p for p in clip_paths() if p.name not in _again_failed and pose_state(p.name) == "done"
                         and pose_model(p.name) not in (None, model)]
                if again:
                    pool = analyze_clip(max(again, key=recorded_at), pool, again=True)
                    continue
                # Then the ball search again, newest first, on clips from an older one (pose.BALL_VERSION).
                reball = [p for p in clip_paths() if p.name not in _ball_failed and pose_state(p.name) == "done"
                          and (_pose_stamp(p.name) or (None, pose.BALL_VERSION))[1] != pose.BALL_VERSION]
                if reball:
                    pool = find_ball_again(max(reball, key=recorded_at), pool)
                    continue
                # Then measure a clip's quality (new ones first, then older clips).
                try:
                    if summarizer is None:
                        summarizer = swings.Summarizer(STATIC_DIR)
                    measured = quality_step(pool, summarizer)
                except BrokenProcessPool:
                    pool, measured = ProcessPoolExecutor(POSE_WORKERS), True
                if not measured:
                    stop.wait(5)
                continue
            pool = analyze_clip(max(todo, key=recorded_at), pool)
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
    moved = lambda a, b: summarizer.call("cameraMoved", a, b)
    shots = None
    made = 0
    for name, c in sorted(both.items(), key=lambda kv: times[kv[0]]):
        if stop.is_set():
            break
        rec = records.get(name)
        if not rec or rec.get("code") != swings_code or "error" in rec:
            continue  # its 2D numbers (and framing) first
        session, why = swing3d.session_for(name, times, records, all_sessions, moved)
        if session is not None:
            modes = {session["cameras"][k].get("mode") for k in ("face", "dtl")}
            if calib.mode_of(name) != session["cameras"]["face"].get("mode") or \
                    calib.mode_of(c["partner"]) != session["cameras"]["dtl"].get("mode"):
                session, why = None, f"recorded in another mode than calibrated ({', '.join(sorted(map(str, modes)))})"
        # The body model is in the key too: after a switch the pose files are analyzed again.
        key = (f"{session['id'] if session else why}|tri{tri.VERSION}|pose{pose.VERSION}"
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
    """Forever, while practice is on: make each new swing's spoken result once its number is known."""
    while not stop.is_set():
        if not practice_state.config["on"]:
            stop.wait(2)
            continue
        try:
            practice_tick()
        except Exception:
            traceback.print_exc()
        stop.wait(1)


def practice_tick() -> list[dict]:
    """One look at the swings since practice was turned on; returns the results made."""
    clips = listed_clips(since=practice_state.config["since"] - PAIR_SLACK_S)
    by_name = {c["name"]: c for c in clips}
    # The swings as listed (by the face-on clip, or a lone one), with the strike's time.
    swings_now = [dict(c) for c in clips
                  if SWING_NAME.match(c["name"]) and not (c["partner"] and c["angle"] != "face")]
    for s in swings_now:
        s["t"] = recorded_at(CLIPS_DIR / s["name"])
        s["partnerPose"] = by_name[s["partner"]]["pose"] if s["partner"] in by_name else None
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
    yield
    stop.set()
    worker.join(timeout=5)  # lets it close its JavaScript engine, which otherwise holds up the exit
    camera_setup.close()
    practice.close_rules()


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
    print(f"Upload: {name} ({size / 1e6:.1f} MB{shot})", flush=True)
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
    global last_shot_at
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
    last_shot_at = time.time()
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
        if out["results"] or since is None or time.monotonic() >= give_up:
            return out
        await asyncio.sleep(0.25)


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
def setup_picture(angle: str):
    jpeg = camera_setup.picture(angle)
    if jpeg is None:
        raise HTTPException(404, "No picture from that camera yet")
    return Response(jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


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
    """Whether 3D from both phones is on, and what's calibrated: lenses, the latest session."""
    if not calib.enabled():
        return {"enabled": False}
    lenses = []
    for f in sorted(calib.CALIB_DIR.glob("*-*.json")):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            lenses.append({"name": f.stem, "rms": d.get("rms"), "good": d.get("good"), "coverage": d.get("coverage")})
        except (OSError, ValueError):
            continue
    s = calib.sessions()
    latest = s[-1] if s else None
    return {"enabled": True, "phones": calib.phones(), "lenses": lenses,
            "session": latest and {"id": latest["id"], "created": latest["created"],
                                   "cameras": {k: {"position": v["position"], "rms": v.get("rms"), "warnings": v.get("warnings", [])}
                                               for k, v in latest["cameras"].items()}}}


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
    said = session_status.health_step(swings_now)
    for text in said:
        print(f"Status: {text}", flush=True)
    return said


@app.post("/api/phones/{angle}/poll")
async def phone_poll(angle: str, request: Request, wait: float = Query(0, ge=0, le=status.POLL_WAIT_MAX_S)):
    """A capture phone (0.6 and later) reports in: its state as JSON, with its answers to commands
    ("acks"). Held open up to `wait` s until there's a command or something to say for it (a long
    poll): {commands: [{id, action}], say: [{id, text, flush}], ms (the server's clock)}."""
    if angle not in status.ANGLES:
        raise HTTPException(404, "No such camera angle")
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "Expected JSON")
    if not isinstance(body, dict):
        raise HTTPException(400, "Expected the phone's state")
    session_status.heartbeat(angle, body)
    give_up = time.monotonic() + wait
    while not session_status.has_mail(angle) and time.monotonic() < give_up:
        if await request.is_disconnected():
            # The phone hung up to report something new: keep what's waiting for its next poll.
            return Response(status_code=204)
        await asyncio.sleep(0.25)
    return session_status.take(angle)


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


@app.get("/api/status")
def get_status():
    """The Ready panel (static/status.js): phones, Square, framing, the first swing's check, the pose queue."""
    setup_now = {a: v and {k: x for k, x in v.items() if k not in ("lm", "focus")}
                 for a, v in camera_setup.status().items()}
    return session_status.snapshot(setup_now, {"queued": pose_queued, "busy": pose_busy}, newest_shot())


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
        return not any(path in message for path in ('"GET /api/clips ', '"GET /api/time ', " /api/setup",
                                                         " /api/practice/latest", " /api/phones/",
                                                         '"GET /api/status ', " /api/relay/heartbeat"))


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
    print(f"Open http://localhost:{PORT} here, or http://<this PC's name>:{PORT} from other devices")
    logging.getLogger("uvicorn.access").addFilter(QuietPolling())
    logging.getLogger("uvicorn.error").addFilter(QuietShutdown())
    # Ctrl+C: don't wait on open browser connections (a review page or a video keeps one open).
    uvicorn.run(app, host="0.0.0.0", port=PORT, timeout_graceful_shutdown=2)
