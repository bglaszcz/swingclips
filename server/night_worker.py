"""The night worker (night.py): on a PC with an NVIDIA GPU, analyzes the server's clips again with
the bigger models, while nobody is hitting balls, and sends each pose file back. `Night worker.cmd`
sets it up and starts it; it runs until closed.

  .venv-gpu\\Scripts\\python.exe night_worker.py                       the home server, any time
  .venv-gpu\\Scripts\\python.exe night_worker.py --hours 23-7          only from 11 pm to 7 am
  .venv-gpu\\Scripts\\python.exe night_worker.py --stop-at 7           until 7:00, then exit (the 2 am task)
  .venv-gpu\\Scripts\\python.exe night_worker.py --server http://192.168.86.250:8000 --once

The server says which clip and how (/api/night/next), and nothing while a session is on. Once every
clip is done, the improve step (night_improve.py) runs once: a new club model when the labels changed,
for the Night report. What the night did goes to the server as it goes (/api/improve/night). The work runs
below normal priority, so the PC stays usable; --hours keeps it to the night when the PC is used for
games. The body model comes from public/models like the server's (fetch_models.py rtmw); the club
model is the server's deep-pass one, downloaded as public/models/club-night.onnx whenever it changes.
"""
import argparse
import gzip
import json
import os
import socket
import sys
import tempfile
import time
import traceback
import urllib.parse
import urllib.request
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from datetime import datetime, timedelta
from pathlib import Path

SERVER = "http://192.168.86.250:8000"
# How long to wait after the server can't be reached (s).
OFFLINE_WAIT_S = 120
# The longest single wait, so --hours and a closed window are noticed.
MAX_WAIT_S = 600


def ask(server: str, path: str, data: bytes | None = None, timeout: float = 60):
    req = urllib.request.Request(server + path, data=data, method="POST" if data is not None else "GET")
    if data is not None:
        req.add_header("Content-Type", "application/octet-stream")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def download(server: str, name: str, folder: Path) -> Path:
    """The clip, under its own name (pose.py reads the angle and strike from it)."""
    out = folder / name
    with urllib.request.urlopen(f"{server}/clips/{urllib.parse.quote(name)}", timeout=120) as r, open(out, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    return out


def club_model(server: str, stamp: str | None, models) -> Path | None:
    """The server's club model (stamp as models.club_stamp makes it), downloaded when the copy here
    differs; None when the server has none."""
    if not stamp:
        return None
    path = models.models_dir() / "club-night.onnx"
    if path.is_file() and models.club_stamp(path).split("@")[1] == stamp.split("@")[-1]:
        return path
    print(f"{datetime.now():%H:%M} downloading the server's club model ({stamp})", flush=True)
    tmp = path.with_suffix(".tmp")
    with urllib.request.urlopen(server + "/api/night/club", timeout=300) as r, open(tmp, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    tmp.replace(path)
    return path


def in_hours(hours: tuple[int, int] | None, now: datetime) -> bool:
    """Whether `now` is inside --hours (start, end), which can run past midnight (23-7)."""
    if hours is None:
        return True
    start, end = hours
    return start <= now.hour < end if start < end else now.hour >= start or now.hour < end


def only_one(path: Path | None = None):
    """An open, locked file while this is the only night worker on the PC (the 2 am task and one started
    by hand would both fill the graphics card's memory), else None. Kept open until the process ends."""
    path = path or Path(tempfile.gettempdir()) / "swingclips-night-worker.lock"
    f = open(path, "a+b")
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        return None
    return f


def stay_awake(on: bool) -> None:
    """Asks Windows not to sleep while a clip is being worked on (the PC sleeps after a while with
    nobody at it), and lets it again when idle. Nothing elsewhere."""
    if os.name != "nt":
        return
    import ctypes
    ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
    ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | (ES_SYSTEM_REQUIRED if on else 0))


def deadline(hour: int | None, now: datetime) -> datetime | None:
    """The next time it's `hour`:00 after `now` (--stop-at), or None without one."""
    if hour is None:
        return None
    at = now.replace(hour=hour, minute=0, second=0, microsecond=0)
    return at if at > now else at + timedelta(days=1)


def parse_hours(text: str | None) -> tuple[int, int] | None:
    if not text:
        return None
    start, end = (int(x) for x in text.split("-"))
    if not (0 <= start <= 23 and 0 <= end <= 24 and start != end):
        raise argparse.ArgumentTypeError("hours like 23-7")
    return start, end


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", default=os.environ.get("SWINGCLIPS_SERVER", SERVER))
    ap.add_argument("--hours", type=parse_hours, help="only between these hours, e.g. 23-7")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 4) // 2))
    ap.add_argument("--provider", default=os.environ.get("SWINGCLIPS_ORT_PROVIDER") or "cuda",
                    help="where the models run: cuda (default), dml or cpu")
    ap.add_argument("--once", action="store_true", help="one clip, then stop")
    ap.add_argument("--stop-at", type=int, choices=range(24), metavar="HOUR",
                    help="exit at this hour (after the clip it's on), e.g. 7")
    args = ap.parse_args(argv)
    lock = only_one()
    if lock is None:
        print("Night worker: another one is already running on this PC; nothing to do", flush=True)
        return 0
    server = args.server.rstrip("/")
    # Before pose and models are loaded, and before the worker processes start (they read it too).
    os.environ["SWINGCLIPS_ORT_PROVIDER"] = args.provider
    import models
    import pose

    me = socket.gethostname()
    print(f"Night worker on {me}: clips from {server}, {args.workers} workers, models on "
          f"{models.PROVIDER_NAMES.get(models.provider(), models.provider())}"
          + (f", {args.hours[0]}:00 to {args.hours[1]}:00" if args.hours else "")
          + (f", until {args.stop_at}:00" if args.stop_at is not None else ""), flush=True)
    stop = deadline(args.stop_at, datetime.now())

    def nap(seconds: float) -> None:
        """Waits, but not past the stop time."""
        if stop:
            seconds = min(seconds, (stop - datetime.now()).total_seconds())
        time.sleep(max(1.0, seconds))

    import night_improve
    night = {"started": datetime.now().isoformat(timespec="seconds"), "ended": None, "worker": me, "clips": 0,
             "improve": None}

    def note(**changes) -> None:
        """This run's line in the Night report."""
        night.update(changes)
        try:
            ask(server, "/api/improve/night", json.dumps(night).encode())
        except OSError:
            pass

    def improve_step() -> str:
        """The improve step, with the graphics card to itself: the pool's processes each hold the
        models on it, so they're stopped first (and started again after, by the caller)."""
        left = (stop - datetime.now()).total_seconds() / 60 if stop else None
        if left is not None and left < night_improve.MINUTES:
            return "Not enough time left tonight to train a model."
        stay_awake(True)
        try:
            return night_improve.try_once(server, lambda stamp: club_model(server, stamp, models),
                                          say=lambda m: print(f"{datetime.now():%H:%M} {m}", flush=True))
        except Exception as e:
            traceback.print_exc()
            return f"The improve step failed: {type(e).__name__}"
        finally:
            stay_awake(False)

    pool = ProcessPoolExecutor(args.workers, initializer=pose.low_priority)
    folder = Path(tempfile.mkdtemp(prefix="swingclips-night-"))
    try:
        while True:
            if stop and datetime.now() >= stop:
                print(f"{datetime.now():%H:%M} stopping ({args.stop_at}:00)", flush=True)
                note(ended=datetime.now().isoformat(timespec="seconds"))
                return 0
            if not in_hours(args.hours, datetime.now()):
                nap(MAX_WAIT_S)
                continue
            try:
                job = ask(server, "/api/night/next?" + urllib.parse.urlencode({"worker": me}))
            except OSError as e:
                print(f"{datetime.now():%H:%M} server not reached ({e}); trying again in {OFFLINE_WAIT_S // 60} min",
                      flush=True)
                nap(OFFLINE_WAIT_S)
                continue
            if "name" not in job and job.get("allDone") and night["improve"] is None and not args.once:
                pool.shutdown()
                note(improve=improve_step())
                pool = ProcessPoolExecutor(args.workers, initializer=pose.low_priority)
                continue
            if "name" not in job:
                print(f"{datetime.now():%H:%M} {job.get('why', 'nothing to do')}; asking again in "
                      f"{min(job.get('wait', 60), MAX_WAIT_S) // 60} min", flush=True)
                if args.once:
                    return 0
                nap(min(job.get("wait", 60), MAX_WAIT_S))
                continue
            name = job["name"]
            stay_awake(True)
            where = f"/api/night/{urllib.parse.quote(name)}?" + urllib.parse.urlencode({"worker": me})
            clip = None
            try:
                clip = download(server, name, folder)
                os.environ["SWINGCLIPS_POSE_BACKEND"] = job["bodyModel"]
                deep = {"bodyStride": job.get("bodyStride", 1),
                        "clubModel": club_model(server, job.get("clubStamp"), models), "rayTakeaway": True}
                result = pose.analyze(str(clip), pool, args.workers, deep=deep)
                ask(server, where, gzip.compress(json.dumps(result, separators=(",", ":")).encode()), timeout=120)
                print(f"{datetime.now():%H:%M} {name}: {result['seconds']} s", flush=True)
                note(clips=night["clips"] + 1)
            except OSError as e:
                # The server went away mid-clip (or the download failed): the clip is handed out again.
                print(f"{datetime.now():%H:%M} {name}: {e}", flush=True)
                nap(OFFLINE_WAIT_S)
            except Exception as e:
                traceback.print_exc()
                try:
                    ask(server, where + "&" + urllib.parse.urlencode({"failed": f"{type(e).__name__}: {e}"[:300]}), b"")
                except OSError:
                    pass
                if isinstance(e, BrokenProcessPool):
                    pool = ProcessPoolExecutor(args.workers, initializer=pose.low_priority)
            finally:
                stay_awake(False)
                if clip is not None:
                    clip.unlink(missing_ok=True)
            if args.once:
                return 0
    except KeyboardInterrupt:
        print("Night worker: stopped", flush=True)
        return 0
    finally:
        pool.shutdown(cancel_futures=True)


if __name__ == "__main__":
    sys.exit(main())
