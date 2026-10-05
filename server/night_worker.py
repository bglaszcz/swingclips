"""The night worker (night.py): on a PC with an NVIDIA GPU, analyzes the server's clips again with
the bigger models, while nobody is hitting balls, and sends each pose file back. `Night worker.cmd`
sets it up and starts it; it runs until closed.

  .venv-gpu\\Scripts\\python.exe night_worker.py                       the home server, any time
  .venv-gpu\\Scripts\\python.exe night_worker.py --hours 23-7          only from 11 pm to 7 am
  .venv-gpu\\Scripts\\python.exe night_worker.py --server http://192.168.86.250:8000 --once

The server says which clip and how (/api/night/next), and nothing while a session is on. The work runs
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
from datetime import datetime
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
    args = ap.parse_args(argv)
    server = args.server.rstrip("/")
    # Before pose and models are loaded, and before the worker processes start (they read it too).
    os.environ["SWINGCLIPS_ORT_PROVIDER"] = args.provider
    import models
    import pose

    me = socket.gethostname()
    print(f"Night worker on {me}: clips from {server}, {args.workers} workers, models on "
          f"{models.PROVIDER_NAMES.get(models.provider(), models.provider())}"
          + (f", {args.hours[0]}:00 to {args.hours[1]}:00" if args.hours else ""), flush=True)
    pool = ProcessPoolExecutor(args.workers, initializer=pose.low_priority)
    folder = Path(tempfile.mkdtemp(prefix="swingclips-night-"))
    try:
        while True:
            if not in_hours(args.hours, datetime.now()):
                time.sleep(MAX_WAIT_S)
                continue
            try:
                job = ask(server, "/api/night/next?" + urllib.parse.urlencode({"worker": me}))
            except OSError as e:
                print(f"{datetime.now():%H:%M} server not reached ({e}); trying again in {OFFLINE_WAIT_S // 60} min",
                      flush=True)
                time.sleep(OFFLINE_WAIT_S)
                continue
            if "name" not in job:
                print(f"{datetime.now():%H:%M} {job.get('why', 'nothing to do')}; asking again in "
                      f"{min(job.get('wait', 60), MAX_WAIT_S) // 60} min", flush=True)
                if args.once:
                    return 0
                time.sleep(min(job.get("wait", 60), MAX_WAIT_S))
                continue
            name = job["name"]
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
            except OSError as e:
                # The server went away mid-clip (or the download failed): the clip is handed out again.
                print(f"{datetime.now():%H:%M} {name}: {e}", flush=True)
                time.sleep(OFFLINE_WAIT_S)
            except Exception as e:
                traceback.print_exc()
                try:
                    ask(server, where + "&" + urllib.parse.urlencode({"failed": f"{type(e).__name__}: {e}"[:300]}), b"")
                except OSError:
                    pass
                if isinstance(e, BrokenProcessPool):
                    pool = ProcessPoolExecutor(args.workers, initializer=pose.low_priority)
            finally:
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
