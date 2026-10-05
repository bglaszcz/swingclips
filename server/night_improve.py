"""The night worker's improve step (improve.py), on the gaming PC: when the server says the labels
changed since the last try (/api/improve/next), train a new club model on them and score it against
the one in use, and send the server the candidate. Nothing changes on the server until the owner taps
Use it on the Night report.

  1. Fetch the labels and the labeled clips (kept in a cache folder, so only new clips download).
  2. club_dataset.py: the club labels as a YOLO dataset; validation = ~20% of swings, by swing name, so
     the same swings stay out of training every time (the model in use left them out too).
  3. train/club_train.py in train\\.venv (PyTorch on the GPU, ~20 min).
  4. eval.py --rerun --deep --only-val twice, with the model in use and with the new one, the server's
     body model, on the validation swings (~10 min).
  5. improve.judge, and the model, scores and report to the server.

night_worker.py runs it once a night, after the clips are done and with enough time left (MINUTES).
By hand: .venv-gpu\\Scripts\\python.exe night_improve.py [--server URL] [--force]
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import time
import traceback
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

import improve

HERE = Path(__file__).resolve().parent
TRAIN_PY = HERE.parent / "train" / ".venv" / "Scripts" / "python.exe"
TRAIN_SCRIPT = HERE.parent / "train" / "club_train.py"
CACHE = Path(os.environ.get("SWINGCLIPS_NIGHT_CACHE") or Path.home() / "SwingClips-night")
# About how long a try takes; night_worker.py doesn't start one with less time left.
MINUTES = 50
# Longest each step may take (s).
DATASET_S, TRAIN_S, EVAL_S = 30 * 60, 120 * 60, 60 * 60
# For trying the step out quickly (tests, a PC without a free GPU): fewer epochs, train on the CPU,
# score on the CPU. Unset, it's 150 epochs on the GPU, as the club models so far.
EPOCHS = int(os.environ.get("SWINGCLIPS_IMPROVE_EPOCHS") or 150)
TRAIN_DEVICE = os.environ.get("SWINGCLIPS_IMPROVE_DEVICE") or "0"
EVAL_PROVIDER = os.environ.get("SWINGCLIPS_IMPROVE_PROVIDER") or "cuda"


def get(server: str, path: str, timeout: float = 60):
    with urllib.request.urlopen(server + path, timeout=timeout) as r:
        return r.read()


def post(server: str, path: str, data: bytes, kind: str = "application/json", timeout: float = 300):
    req = urllib.request.Request(server + path, data=data, method="POST", headers={"Content-Type": kind})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def sync(server: str, names: list[str], cache: Path, say) -> tuple[Path, Path]:
    """The labels (all fetched again: they change) and the clips (only new ones) into the cache.
    Label files no longer on the server are removed from the cache copy."""
    labels, clips = cache / "labels", cache / "clips"
    labels.mkdir(parents=True, exist_ok=True)
    clips.mkdir(parents=True, exist_ok=True)
    keep = set()
    for name in names:
        q = urllib.parse.quote(name)
        (labels / f"{name}.json").write_bytes(get(server, f"/api/labels/{q}?pass=1"))
        keep.add(f"{name}.json")
        if not (clips / name).is_file():
            tmp = clips / (name + ".part")
            tmp.write_bytes(get(server, f"/clips/{q}", timeout=300))
            tmp.replace(clips / name)
    for f in labels.glob("*.json"):
        if f.name not in keep:
            f.unlink()
    say(f"{len(names)} labeled clips in {cache}")
    return labels, clips


def run(cmd: list, env: dict, log: Path, timeout: float, cwd: Path) -> None:
    """A step as a child process, its output in `log`; raises with the log's end when it fails."""
    log.parent.mkdir(parents=True, exist_ok=True)
    with open(log, "w", encoding="utf-8", errors="replace") as f:
        p = subprocess.run([str(c) for c in cmd], env={**os.environ, **env}, cwd=cwd, stdout=f,
                           stderr=subprocess.STDOUT, timeout=timeout)
    if p.returncode != 0:
        tail = log.read_text(encoding="utf-8", errors="replace").strip().splitlines()[-3:]
        raise RuntimeError(f"{Path(str(cmd[1])).name} failed (exit {p.returncode}): " + " / ".join(tail))


def scorecard(env: dict, club_model: Path, out: Path, dataset_json: Path, log: Path) -> dict:
    """eval.py's deep pass on the validation swings with `club_model`: its tables."""
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    run([sys.executable, HERE / "eval.py", "--rerun", "--deep", "--no-noise", "--no-quality",
         "--only-val", dataset_json, "--out", out],
        {**env, "SWINGCLIPS_DEEP_CLUB_MODEL": str(club_model)}, log, EVAL_S, HERE)
    saved = sorted(glob.glob(str(out / "*.json")), key=os.path.getmtime)
    if not saved:
        raise RuntimeError("eval.py saved no scorecard")
    return json.loads(Path(saved[-1]).read_text(encoding="utf-8"))["tables"]


def try_once(server: str, current_of, force: bool = False, cache: Path = CACHE, say=print) -> str:
    """One try. `current_of(stamp)`: the club model in use, fetched from the server when the copy here
    differs (night_worker.club_model). Returns the sentence for the night's line in the report."""
    nxt = json.loads(get(server, "/api/improve/next"))
    if not nxt["due"] and not force:
        return nxt["why"]
    current_model = nxt["clubStamp"] and current_of(nxt["clubStamp"])
    if not current_model or not current_model.is_file():
        return "No club model in use to compare with."
    if not TRAIN_PY.is_file():
        return f"Can't train here: no {TRAIN_PY} (docs/club-model.md, \"Training the club model\")."
    cid = improve.new_id("club")
    work = cache / "runs" / cid
    started = time.time()
    report = {"kind": "club", "made": None, "model": None, "train": {"labelsSig": nxt["labelsSig"]}}
    try:
        say(f"Improve: {nxt['why']} Training a club model ({cid}).")
        labels, clips = sync(server, nxt["labels"], cache, say)
        env = {"SWINGCLIPS_CLIPS": str(clips), "SWINGCLIPS_LABELS": str(labels), "SWINGCLIPS_TRASH": str(cache / "trash"),
               "SWINGCLIPS_POSE_BACKEND": nxt.get("bodyModel") or "rtmpose-m", "SWINGCLIPS_ORT_PROVIDER": EVAL_PROVIDER,
               "SWINGCLIPS_EVAL": str(work / "eval"), "PYTHONIOENCODING": "utf-8"}
        dataset = work / "dataset"
        run([sys.executable, HERE / "club_dataset.py", "--out", dataset, "--force"], env, work / "dataset.log",
            DATASET_S, HERE)
        info = json.loads((dataset / "dataset.json").read_text(encoding="utf-8"))
        model = work / "model.onnx"
        clock = time.time()
        run([TRAIN_PY, TRAIN_SCRIPT, "--data", dataset / "data.yaml", "--project", work / "runs", "--name", "club",
             "--out", model, "--epochs", EPOCHS, "--device", TRAIN_DEVICE], {"PYTHONIOENCODING": "utf-8"}, work / "train.log", TRAIN_S, TRAIN_SCRIPT.parent)
        minutes = round((time.time() - clock) / 60, 1)
        say(f"Improve: trained in {minutes} min; scoring both models on the swings it didn't train on")
        current = improve.scores_from(scorecard(env, current_model, work / "eval-current", dataset / "dataset.json",
                                                work / "eval-current.log"))
        candidate = improve.scores_from(scorecard(env, model, work / "eval-candidate", dataset / "dataset.json",
                                                  work / "eval-candidate.log"))
        stamp = post(server, f"/api/improve/{cid}/model", model.read_bytes(), "application/octet-stream")["stamp"]
        verdict = improve.judge(current, candidate)
        train = {**report["train"], **counts(info), "epochs": EPOCHS, "minutes": minutes}
        report.update(model=stamp, train=train, scores={"current": current, "candidate": candidate}, verdict=verdict,
                      status="better" if verdict["better"] else "not better",
                      summary=improve.summary(train, current, candidate, verdict))
        line = (f"Trained a club model on {train['swings']} labeled swings: "
                + ("better on the swings it never saw, ready to use." if verdict["better"]
                   else "not better, kept the one in use."))
    except Exception as e:
        traceback.print_exc()
        report.update(status="failed", verdict={"better": False, "why": f"{type(e).__name__}: {e}"[:400]},
                      summary="Training or scoring a new club model failed: see the night worker's window.",
                      scores=None)
        line = "Tried to train a club model, but it failed."
    report["made"] = datetime.now().isoformat(timespec="seconds")
    report["minutesAll"] = round((time.time() - started) / 60, 1)
    post(server, f"/api/improve/{cid}/report", json.dumps(report).encode())
    say(f"Improve: {line} ({report['minutesAll']} min)")
    return line


def counts(info: dict) -> dict:
    """Swings and frames trained on, and validation swings, from club_dataset.py's dataset.json."""
    swings = info.get("swings") or {}
    return {"swings": len(swings.get("train", [])), "valSwings": len(swings.get("val", [])),
            "frames": sum(1 for i in info.get("images", []) if i.get("split") == "train")}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", default=os.environ.get("SWINGCLIPS_SERVER", "http://192.168.86.250:8000"))
    ap.add_argument("--force", action="store_true", help="train even if the labels haven't changed")
    args = ap.parse_args(argv)
    os.environ.setdefault("SWINGCLIPS_ORT_PROVIDER", "cuda")
    import models
    import night_worker
    server = args.server.rstrip("/")
    print(try_once(server, lambda stamp: night_worker.club_model(server, stamp, models), force=args.force))
    return 0


if __name__ == "__main__":
    sys.exit(main())
