"""How fast the ONNX models run on the CPU and on this PC's GPU, to decide whether a GPU is worth it.

  .venv\\Scripts\\python.exe bench_models.py                  the newest clip on the server
  .venv\\Scripts\\python.exe bench_models.py D:\\SwingClips\\clips\\<clip>.mp4
  .venv\\Scripts\\python.exe bench_models.py --providers cpu,dml --no-clip

For each provider (every one the installed ONNX Runtime has: cpu, and dml or cuda once
requirements-dml.txt or requirements-cuda.txt is installed; or --providers):

1. Each model whose file is here (RTMPose-m, RTMPose-l, RTMW, the club model): milliseconds a frame
   on crops of the clip's own frames, on one CPU thread as each pose worker runs it, and how far its
   points land from the CPU's (a GPU's arithmetic differs a little).
2. The whole clip through pose.analyze, as the server runs it: its workers (SWINGCLIPS_POSE_WORKERS),
   body model (SWINGCLIPS_POSE_BACKEND; rtmpose-m if that's mediapipe and the file is here) and club
   backend, with the body model on every frame on a GPU and every other one on the CPU (the defaults,
   see pose.body_stride), and on a GPU at every other frame too. Run twice; the second, with the
   workers already up and the models loaded, is what counts, as on the server.
3. The floor: the whole clip with no body model at all (MediaPipe only; the club as set). However
   fast a GPU runs the body model, a clip can't get below this: the rest stays on the CPU.
4. Keeping up (pose.py's speed settings, HOME-SETUP.md "Keeping up during a session"): the whole clip
   on the CPU with those settings as they were before them, next to the run as set now (1. and 2.
   run as set now too), and where each one's time went: milliseconds a frame for decoding,
   converting the picture, MediaPipe, the body model and the shaft search (and how many frames each
   ran on), how busy each worker was, and the steps outside the workers (the empty scene, the ball
   search, smoothing, the shaft's tracking). --each also runs the clip with each setting put back on
   its own, --workers 6,8 with other worker counts.

Then a verdict on one screen. Nothing is written; the server can keep running, but it slows both down.

  .venv\\Scripts\\python.exe bench_models.py --accuracy

instead checks that the speed settings as set now score no worse than as before, on the labeled
clips: eval.py --rerun both ways (cached like any rerun), then the key positions leave-one-out as
tune_positions.py scores them, and a verdict ("No worse" below says what that is). Needs the
clips and labels, so the dev PC or the server; ~2 x 25 min the first time.
"""
import argparse
import gzip
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from unittest import mock

import av
import cv2
import numpy as np

import app
import models
import pose

LABELS = {"rtmpose-m": "RTMPose-m", "rtmpose-l": "RTMPose-l", "rtmw": "RTMW", "club": "Club model"}
# A swing (two clips) every ~20 s: the server keeps up at this many seconds a clip or less.
KEEP_UP_SECONDS = 10.0
# Warm-up runs before timing a model: DirectML and CUDA build their kernels on the first ones.
WARMUP = 5
# No worse, for --accuracy: the speed settings as set now against as before them, on the labeled
# clips: each key position's median error (per angle) within a frame at 240 fps of before's, none
# more missed, and the same scored leave-one-out by tune_positions.py; the tracked joints within
# JOINT_PX of before's (median, full-size picture, over the frames up to pose.BODY_AFTER_STRIKE after
# the strike); impact (the ball-gone frame) within a frame and the ball found as often; the shaft
# found as often (within FOUND_POINTS percentage points) and its angle within CLUB_DEGREES.
ONE_FRAME_MS = 1000 / 240
JOINT_PX = 1.0
FOUND_POINTS = 2.0
CLUB_DEGREES = 0.5
# The per-part split (pose.parts), in the order it's printed.
PART_NAMES = {"decode": "decode", "convert": "convert", "mediapipe": "MediaPipe", "body": "body", "shaft": "shaft",
              "club": "club model"}


# ---- The clip ----

def newest_clip() -> Path | None:
    """The newest clip on the server, preferring the capture app's (named with the heard strike)."""
    if not app.CLIPS_DIR.is_dir():
        return None
    clips = [p for p in app.CLIPS_DIR.iterdir() if p.suffix.lower() in app.VIDEO_TYPES]
    with_strike = [p for p in clips if pose.clip_facts(str(p))[1] is not None]
    return max(with_strike or clips, key=lambda p: p.stat().st_mtime, default=None)


def saved_landmarks(clip: Path) -> list | None:
    """The server's pose result for the clip: [(t, landmarks | None)], or None without one."""
    f = app.pose_file(clip.name)
    if not f.is_file():
        return None
    doc = json.loads(gzip.decompress(f.read_bytes()))
    return [(fr["t"], None if fr["lm"] is None else [tuple(fr["lm"][i:i + 3]) for i in range(0, len(fr["lm"]), 3)])
            for fr in doc["frames"]]


def sample_frames(clip: Path, count: int) -> list[tuple[float, np.ndarray]]:
    """Up to `count` frames spread over the clip: (t, full-size upright RGB), as pose.run_chunk sees them."""
    _, _, rotation = pose.probe(str(clip))
    with av.open(str(clip)) as c:
        s = c.streams.video[0]
        total = s.frames or 0
        tb = float(s.time_base)
        step = max(1, total // count) if total else 1
        out = []
        for k, f in enumerate(c.decode(s)):
            if k % step:
                continue
            rgb = cv2.cvtColor(f.to_ndarray(format="yuv420p"), cv2.COLOR_YUV2RGB_I420)
            if rotation in pose.ROTATE_CW:
                rgb = cv2.rotate(rgb, pose.ROTATE_CW[rotation])
            out.append((f.pts * tb, rgb))
            if len(out) >= count:
                break
    return out


def golfer(frames, saved) -> list:
    """Per sampled frame, the golfer's landmarks from the saved result (nearest frame), or a stand-in
    box's corners in the middle of the picture when there is none."""
    out = []
    for t, rgb in frames:
        lm = None
        if saved:
            lm = min(saved, key=lambda r: abs(r[0] - t))[1]
        out.append(lm or [(0.3, 0.1, 1.0), (0.7, 0.1, 1.0), (0.3, 0.9, 1.0), (0.7, 0.9, 1.0)])
    return out


# ---- One model ----

def time_model(name: str, where: str, frames, landmarks) -> dict | None:
    """ms a frame (crop, preprocessing and the model, as in a worker) and the points, or None
    without the model file. `got` is the provider the session actually got."""
    if name == "club":
        path = models.club_model_path()
        if not path.is_file():
            return None
        runner = models.ClubRunner(path, threads=1, where=where)

        def run(rgb, lm):
            found = runner.find(rgb, lm)
            return [] if found is None else [(x, y, found[0] * c) for x, y, c in found[1]]
    else:
        path = models.model_path(name)
        if not path.is_file():
            return None
        runner = models.Runner(name, path, threads=1, where=where)

        def run(rgb, lm):
            h, w = rgb.shape[:2]
            box = models.box_of(lm, w, h, min_conf=0)
            return runner.track(rgb, box) if box else []
    for _ in range(WARMUP):
        run(frames[0][1], landmarks[0])
    ms, points = [], []
    for (t, rgb), lm in zip(frames, landmarks):
        started = time.perf_counter()
        pts = run(rgb, lm)
        ms.append(1000 * (time.perf_counter() - started))
        h, w = rgb.shape[:2]
        points.append([(x * w, y * h, c) for x, y, c in pts])
    return {"ms": float(np.median(ms)), "got": runner.provider, "points": points}


def difference(a: list, b: list, min_conf: float = models.LOST) -> dict | None:
    """How far one run's points are from another's, over the points both are sure of: median and
    largest distance in picture pixels, and the largest confidence change."""
    dist, conf = [], []
    for fa, fb in zip(a, b):
        for (xa, ya, ca), (xb, yb, cb) in zip(fa, fb):
            conf.append(abs(ca - cb))
            if ca >= min_conf and cb >= min_conf:
                dist.append(float(np.hypot(xa - xb, ya - yb)))
    if not dist:
        return None
    return {"median": float(np.median(dist)), "max": max(dist), "conf": max(conf)}


# ---- The whole clip ----

def whole_clip(clip: Path, where: str, stride: int, workers: int, backend: str, runs: int,
               env: dict | None = None) -> dict:
    """pose.analyze on the clip with the models on `where` and the body model every `stride` frames
    (and `env` set meanwhile, e.g. pose.SPEED_AS_BEFORE): seconds (the last run), the per-frame
    split, where the time went (pose.analyze's timing) and the landmarks."""
    os.environ["SWINGCLIPS_ORT_PROVIDER"] = where
    os.environ["SWINGCLIPS_POSE_BACKEND"] = backend
    saved_env = {k: os.environ.get(k) for k in env or {}}
    os.environ.update(env or {})
    saved_stride, pose.BODY_STRIDE = pose.BODY_STRIDE, stride
    seconds = []
    timing = {}
    try:
        speed = pose.speed_settings()
        threads = pose.decode_threads()
        # A fresh pool: workers read the provider when they load the models, and keep them loaded.
        pool = ProcessPoolExecutor(workers)
        try:
            for _ in range(runs):
                started = time.perf_counter()
                timing = {}
                out = pose.analyze(str(clip), pool, workers, timing)
                seconds.append(time.perf_counter() - started)
        finally:
            pool.shutdown(cancel_futures=True)
    finally:
        pose.BODY_STRIDE = saved_stride
        for k, v in saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    h, w = frame_size(clip)
    lms = [None if f["lm"] is None else [(f["lm"][i] * w, f["lm"][i + 1] * h, f["lm"][i + 2])
                                         for i in range(0, len(f["lm"]), 3)] for f in out["frames"]]
    return {"seconds": seconds[-1], "first": seconds[0], "frames": len(out["frames"]),
            "split": out.get("msPerFrame", {}), "provider": out.get("provider", "cpu"), "landmarks": lms,
            "timing": timing, "speed": speed, "threads": threads, "workers": workers, "stride": stride}


def speed_label(speed: dict, threads=None) -> str:
    """pose.speed_settings() (and the decode threads) in words."""
    decoding = "FFmpeg's own threads" if threads is None else f"{threads} thread(s)"
    return (f"MediaPipe after the swing {every(speed['mpStrideAfter'])}, picture {speed['convert']}, "
            f"split by {'cost' if speed['split'] == 'cost' else 'keyframes'}, shaft {every(speed['shaftStride'])}, "
            f"decoding {decoding}")


def where_it_went(run: dict) -> list[str]:
    """A clip run's time, part by part (pose.analyze's timing)."""
    t = run.get("timing") or {}
    if not t:
        return []
    cells = [f"{name} {t[k]['ms']:.1f} ({t[k]['frames']})" for k, name in PART_NAMES.items() if k in t]
    busy = t.get("workerSeconds") or []
    stages = t.get("stages") or {}
    lines = [f"ms a frame in each worker (frames it ran on, of {t.get('frames', 0)}): " + ", ".join(cells)]
    if busy:
        lines.append(f"{t.get('jobs', len(busy))} worker(s) busy {min(busy):.1f}-{max(busy):.1f} s of the "
                     f"{stages.get('workers', 0):.1f} s they took (loading MediaPipe {t.get('start', 0):.1f} s in all)")
    steps = {"background": "empty scene", "ball": "ball search", "smooth": "smoothing", "track": "shaft tracking"}
    if stages:
        lines.append("outside the workers: " + ", ".join(f"{name} {stages[k]:.1f} s" for k, name in steps.items()
                                                         if k in stages))
    return lines


def speed_runs(result: dict, clip: Path, workers: int, backend: str, runs: int, each: bool,
               more_workers: list[int]) -> dict:
    """The whole clip on the CPU as the server runs it, with the speed settings as before them and as
    set now (and with each put back on its own, and other worker counts, if asked), into
    result["speed_runs"]. Returns the run as set now."""
    stride = pose.BODY_STRIDE or pose.BODY_STRIDE_CPU
    body = "no body model" if backend == models.DEFAULT else f"body model {every(stride)}"
    todo = [("as before", pose.SPEED_AS_BEFORE, workers), ("as set now", {}, workers)]
    if each:
        now = pose.speed_settings()
        for key, value in pose.SPEED_AS_BEFORE.items():
            with mock.patch.dict(os.environ, {key: value}):
                if pose.speed_settings() != now:
                    todo.append((f"as set now, but {key}={value}", {key: value}, workers))
        if pose.decode_threads() is not None:
            todo.append(("as set now, but SWINGCLIPS_DECODE_THREADS unset", {"SWINGCLIPS_DECODE_THREADS": ""}, workers))
        # Further ways to save time that change more (check them with --accuracy before using them).
        if pose.shaft_stride() == 1:
            todo.append(("as set now, and SWINGCLIPS_SHAFT_STRIDE=2", {"SWINGCLIPS_SHAFT_STRIDE": "2"}, workers))
        if backend != models.DEFAULT and stride < 3:
            todo.append(("as set now, and SWINGCLIPS_BODY_STRIDE=3", {"body stride": 3}, workers))
    todo += [(f"as set now, {n} workers", {}, n) for n in more_workers if n != workers]
    out = None
    for label, env, n in todo:
        print(f"Whole clip on the CPU, {body}, the speed settings {label} ...", flush=True)
        env = dict(env)
        r = whole_clip(clip, "cpu", env.pop("body stride", stride), n, backend, runs, env=env)
        print(f"  {r['seconds']:.1f} s (first run, starting the workers: {r['first']:.1f} s)", flush=True)
        for line in where_it_went(r):
            print(f"  {line}", flush=True)
        result["speed_runs"].append({"label": label, "where": "cpu", "stride": r["stride"], "default": True,
                                     **{k: r[k] for k in ("seconds", "split", "provider", "timing", "speed", "threads",
                                                          "workers")}})
        if label == "as set now":
            out = r
    return {**out, "stride": stride}


def frame_size(clip: Path) -> tuple[int, int]:
    """(height, width) of the upright picture."""
    _, _, rotation = pose.probe(str(clip))
    with av.open(str(clip)) as c:
        s = c.streams.video[0]
        h, w = s.height, s.width
    return (w, h) if rotation in (90, 270) else (h, w)


def body_points(landmarks: list, layout: str) -> list:
    """Only the landmarks the body model places, frame by frame (frames without a person: none)."""
    idx = sorted(set(models.TO_MP[layout].values()))
    return [[lm[i] for i in idx] if lm else [] for lm in landmarks]


# ---- Naming the GPU ----

def gpu_name(where: str) -> str:
    """The GPU's name for the verdict, best effort: "" when it can't be told."""
    device = int(os.environ.get("SWINGCLIPS_ORT_DEVICE") or 0)
    try:
        if where == "cuda":
            out = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
                                 capture_output=True, text=True, timeout=10).stdout
        elif where == "dml" and platform.system() == "Windows":
            out = subprocess.run(["powershell", "-NoProfile", "-Command",
                                  "(Get-CimInstance Win32_VideoController).Name"],
                                 capture_output=True, text=True, timeout=20).stdout
        else:
            return ""
    except (OSError, subprocess.SubprocessError):
        return ""
    names = [n.strip() for n in out.splitlines() if n.strip()]
    if where == "cuda" and device < len(names):
        return names[device]
    # DirectML numbers the adapters its own way; with one GPU there's no doubt.
    return names[0] if len(names) == 1 else " or ".join(names)


# ---- The verdict ----

def provider_label(where: str, gpus: dict) -> str:
    name = models.PROVIDER_NAMES[where]
    return f"{name} ({gpus[where]})" if gpus.get(where) else name


def every(stride: int) -> str:
    return "every frame" if stride == 1 else f"every {stride} frames"


def verdict(result: dict) -> list[str]:
    """The one-screen summary, from what main() measured."""
    gpus = result["gpus"]
    lines = [f"Verdict: {result['clip']}, {result['workers']} worker(s)"]
    for name, per in result["models"].items():
        cpu = per.get("cpu")
        parts = []
        for where, r in per.items():
            text = f"{provider_label(where, gpus)} {r['ms']:.0f} ms"
            if r["got"] != where:
                text += f" (fell back to {models.PROVIDER_NAMES[r['got']]})"
            elif where != "cpu" and cpu:
                text += f" ({cpu['ms'] / max(r['ms'], 1e-3):.1f}x)"
            parts.append(text)
        lines.append(f"  {LABELS[name]}: " + ", ".join(parts) + " a frame, one worker alone")
    speed_runs = result.get("speed_runs") or []
    before = next((r for r in speed_runs if r["label"] == "as before"), None)
    now = next((r for r in speed_runs if r["label"] == "as set now"), None)
    if now:
        body = "no body model" if result["backend"] == models.DEFAULT else \
            f"{result['backend']} {every(now['stride'])}"
        lines.append(f"  Keeping up, whole clip on the CPU ({body}, {now['workers']} worker(s)): "
                     + (f"{before['seconds']:.1f} s with the speed settings as before -> " if before else "")
                     + f"{now['seconds']:.1f} s as set now ({speed_label(now['speed'], now['threads'])})")
        for r in speed_runs:
            if r in (before, now):
                for k, line in enumerate(where_it_went(r)):
                    lines.append(f"    {r['label'] + ': ' if k == 0 else '  '}{line}")
            else:
                lines.append(f"    {r['label']}: {r['seconds']:.1f} s")
    runs = result["clip_runs"]
    if runs or speed_runs:
        runs = runs or []
        cpu = next((r for r in runs if r["where"] == "cpu" and r["default"]), None)
        gpu_runs = [r for r in runs if r["where"] != "cpu"]
        if gpu_runs:
            text = f"  Whole clip ({result['backend']}): "
            if cpu:
                text += f"CPU {cpu['seconds']:.1f} s ({every(cpu['stride'])})"
            for r in gpu_runs:
                text += (" -> " if r is gpu_runs[0] and cpu else ", ") + \
                    f"{provider_label(r['where'], gpus)} {r['seconds']:.1f} s ({every(r['stride'])})"
                if r["provider"] != r["where"]:
                    text += " [ran on the CPU: see the messages above]"
            lines.append(text)
        elif cpu and not now:
            lines.append(f"  Whole clip ({result['backend']}): CPU {cpu['seconds']:.1f} s ({every(cpu['stride'])})")
        for r in runs:
            split = ", ".join(f"{k} {v:.0f}" for k, v in r["split"].items())
            if split:
                lines.append(f"    {models.PROVIDER_NAMES[r['where']]}, {every(r['stride'])}: ms a frame in each "
                             f"worker: {split}")
        if result.get("floor") is not None:
            lines.append(f"  Floor, no body model at all: {result['floor']:.1f} s. No GPU gets the body model's clips "
                         "below this; the rest (MediaPipe, the shaft, decoding) is the CPU's.")
        best = min(runs + [r for r in speed_runs if r is not before], key=lambda r: r["seconds"])
        keeps = best["seconds"] <= KEEP_UP_SECONDS
        lines.append(f"  Keeping up (a swing, two clips, every ~20 s: {KEEP_UP_SECONDS:.0f} s a clip or less): "
                     + ("yes" if keeps else "no") + f", best {best['seconds']:.1f} s "
                     f"({models.PROVIDER_NAMES[best['where']]}, {every(best['stride'])}"
                     + (f", {best['label']}" if best.get("label") else "") + ")")
        if best.get("label") and best is not now:
            lines.append(f"  Fastest: {best['label']} (settings.cmd; see HOME-SETUP.md, \"Keeping up during a "
                         "session\"), then bench_models.py --accuracy with it set")
        if best["where"] != "cpu":
            default = "" if best["default"] else f" and SWINGCLIPS_BODY_STRIDE={best['stride']}"
            reqs = models.PACKAGES[best["where"]][1]
            lines.append(f"  Fastest: settings.cmd with SWINGCLIPS_REQUIREMENTS={reqs}, "
                         f"SWINGCLIPS_ORT_PROVIDER={best['where']}{default}; first check it with "
                         f"eval.py --rerun --provider {best['where']} (see below)")
        elif gpu_runs:
            lines.append("  Fastest on the CPU: the GPU doesn't pay here.")
        if not keeps and result.get("floor") is not None and result["floor"] > KEEP_UP_SECONDS:
            lines.append("  Even the floor is over that: a faster GPU for the body model alone won't keep up.")
    for where, d in result["diffs"].items():
        if d is None:
            continue
        lines.append(f"  {provider_label(where, gpus)} against the CPU, same frames: body points "
                     f"{d['median']:.2f} px apart (at most {d['max']:.1f} px), confidence at most {d['conf']:.3f} off")
    for where, d in result.get("clip_diffs", {}).items():
        if d is not None:
            lines.append(f"  {provider_label(where, gpus)} against the CPU, whole clip at the same stride: landmarks "
                         f"{d['median']:.2f} px apart (at most {d['max']:.1f} px)")
    if result["diffs"]:
        lines.append("  Small but not nothing: eval.py caches a GPU run apart, and --rerun --provider scores it.")
    if list(result["providers"]) == ["cpu"]:
        lines.append("  Only the CPU here: install requirements-dml.txt (HOME-SETUP.md, \"Using a GPU\") to try the "
                     "built-in graphics.")
    return lines


# ---- --accuracy: the speed settings against the labels ----

def accuracy() -> int:
    """eval.py --rerun with the speed settings as before them and as set now, then the key positions
    leave-one-out (tune_positions.py) on both, and whether "as set now" is no worse (see ONE_FRAME_MS)."""
    import eval as scorecard
    import tune_positions
    labels = scorecard.labels(1)
    if not labels:
        print(f"No labels in {app.LABELS_DIR}: --accuracy needs the labeled clips (the dev PC or the server).")
        return 1
    if pose.speed_settings() == pose.BEFORE and pose.BODY_STRIDE is None:
        print("The speed settings are all as before them (SWINGCLIPS_MP_STRIDE_AFTER, SWINGCLIPS_FRAME_CONVERT, "
              "SWINGCLIPS_POSE_SPLIT, SWINGCLIPS_SHAFT_STRIDE, and SWINGCLIPS_BODY_STRIDE unset): nothing to compare.")
        return 1
    now_label = speed_label(pose.speed_settings()) + \
        (f", body model {every(pose.BODY_STRIDE)}" if pose.BODY_STRIDE is not None else "")
    results, caches = {}, {}
    # Before: the speed settings as before them, and the body model as often as by default.
    for key, env, stride in (("before", pose.SPEED_AS_BEFORE, None), ("now", {}, pose.BODY_STRIDE)):
        with mock.patch.dict(os.environ, env), mock.patch.object(pose, "BODY_STRIDE", stride):
            caches[key] = scorecard.EVAL_DIR / "pose" / scorecard.pipeline_fingerprint()
            print(f"\n==== eval.py --rerun, the speed settings {'as before' if key == 'before' else 'as set now'} "
                  f"(cached in {caches[key]}) ====", flush=True)
            started = time.time()
            if scorecard.main(["--rerun", "--no-quality"]) != 0:
                return 1
            saved = [f for f in scorecard.EVAL_DIR.glob("*.json") if f.stat().st_mtime >= started - 1]
            results[key] = json.loads(max(saved, key=lambda f: f.stat().st_mtime).read_text(encoding="utf-8"))
    joints = joint_shift(labels, caches["before"], caches["now"])
    print("\n==== Key positions, leave one swing out (tune_positions.py), as before then as set now ====", flush=True)
    tuned = {}
    with tempfile.TemporaryDirectory() as tmp:
        clips = Path(tmp) / "clips.json"
        both = {f.name.split(".v")[0] for f in caches["before"].glob("*.json.gz")} & \
            {f.name.split(".v")[0] for f in caches["now"].glob("*.json.gz")}
        clips.write_text(json.dumps(label_clips(labels, both)), encoding="utf-8")
        for key in ("before", "now"):
            # Scored as the primary pose folder (the one the tuning is picked on).
            folder = Path(tmp) / key / tune_positions.PRIMARY
            shutil.copytree(caches[key], folder)
            print(f"\n-- {key} --", flush=True)
            tune_positions.main(["--labels", str(app.LABELS_DIR), "--clips", str(clips), "--pose", str(folder.parent),
                                 "--folders", tune_positions.PRIMARY, "--json", str(Path(tmp) / f"{key}.json")])
            tuned[key] = json.loads((Path(tmp) / f"{key}.json").read_text(encoding="utf-8"))
    print()
    print("\n".join(accuracy_verdict(results["before"], results["now"], joints, tuned, now_label)))
    return 0


def label_clips(labels: dict, analyzed: set) -> list[dict]:
    """The labeled clips and their partners as tune_positions.py's --clips takes them, those in
    `analyzed` (names) only."""
    out = {}
    for doc in labels.values():
        clip, partner = doc["clip"], doc.get("partner")
        if partner and partner["name"] not in analyzed:
            partner = None
        if clip["name"] not in analyzed:
            continue
        out[clip["name"]] = {**clip, "partner": partner["name"] if partner else None}
        if partner and partner["name"] not in out:
            out[partner["name"]] = {**partner, "partner": clip["name"]}
    return list(out.values())


def picture_size(name: str, rotation: int) -> tuple[int, int] | None:
    """(width, height) of the upright picture from a clip's name (<width>x<height> as stored)."""
    m = re.search(r"_(\d+)x(\d+)_", name)
    if not m:
        return None
    w, h = int(m.group(1)), int(m.group(2))
    return (h, w) if rotation in (90, 270) else (w, h)


def joint_shift(labels: dict, before: Path, now: Path) -> dict | None:
    """How far the labeled joints (eval.JOINTS) moved from one rerun to the other, over each labeled
    clip's frames up to pose.BODY_AFTER_STRIKE after the strike (where the numbers are measured):
    {"median", "p90" (pixels of the full-size picture), "n"}, or None without both."""
    import eval as scorecard
    dist = []
    for name, doc in labels.items():
        fa, fb = before / f"{name}.v{pose.VERSION}.json.gz", now / f"{name}.v{pose.VERSION}.json.gz"
        if not fa.is_file() or not fb.is_file():
            continue
        a, b = (json.loads(gzip.decompress(f.read_bytes())) for f in (fa, fb))
        size = picture_size(name, a.get("rotation", 0))
        if size is None:
            continue
        strike = doc["clip"].get("strike")
        until = strike + pose.BODY_AFTER_STRIKE if strike is not None else float("inf")
        for x, y in zip(a["frames"], b["frames"]):
            if x["t"] > until or not x["lm"] or not y["lm"]:
                continue
            for i in scorecard.JOINTS.values():
                dist.append(float(np.hypot((x["lm"][i * 3] - y["lm"][i * 3]) * size[0],
                                           (x["lm"][i * 3 + 1] - y["lm"][i * 3 + 1]) * size[1])))
    if not dist:
        return None
    return {"median": float(np.median(dist)), "p90": float(np.percentile(dist, 90)), "n": len(dist)}


def accuracy_verdict(before: dict, now: dict, joints: dict | None, tuned: dict, now_label: str = "") -> list[str]:
    """Whether the speed settings as set now score no worse than as before (see ONE_FRAME_MS), line by line."""
    worse, lines = [], [f"Accuracy of the speed settings as set now ({now_label}) against as before them, "
                        f"{now.get('labeledClips')} labeled clip(s):"]

    def rows(result, table):
        """A scorecard table's rows by what they're of: (angle, event), (angle, joints, phase), ..."""
        keys = {"events": ("angle", "event"), "joints": ("angle", "joints", "phase"), "ball": ("angle",),
                "club": ("angle", "phase")}[table]
        return {tuple(r.get(k) for k in keys): r for r in result.get("tables", {}).get(table, [])}

    # Key positions and impact: median error, and how many weren't found.
    ev_b, ev_n = rows(before, "events"), rows(now, "events")
    moved = []
    for key, rn in ev_n.items():
        rb = ev_b.get(key)
        if rb is None or rn.get("median") is None or rb.get("median") is None:
            continue
        what = f"{key[1]} ({key[0]})"
        change = rn["median"] - rb["median"]
        moved.append(f"{what} {rb['median']:.1f} -> {rn['median']:.1f} ms")
        if change > ONE_FRAME_MS or (rn.get("missed") or 0) > (rb.get("missed") or 0):
            worse.append(f"{what}: median error {rb['median']:.1f} -> {rn['median']:.1f} ms"
                         f", not found {rb.get('missed') or 0} -> {rn.get('missed') or 0}")
    lines.append("  Key positions and impact, median error: " + (", ".join(moved) or "none scored"))
    same = [abs(en["pred"] - eb["pred"]) <= ONE_FRAME_MS / 1000 + 1e-9
            for cb, cn in zip(before.get("clips", []), now.get("clips", [])) if cb["clip"] == cn["clip"]
            for eb, en in zip(cb["events"], cn["events"])
            if eb["event"] == en["event"] and eb.get("pred") is not None and en.get("pred") is not None]
    if same:
        lines.append(f"  Found within a frame of before's: {100 * sum(same) / len(same):.0f}% of {len(same)}")
    # Joints: the tracked joints against before's, and the scorecard's own joint table.
    if joints:
        lines.append(f"  Joints moved {joints['median']:.2f} px (median; 90th percentile {joints['p90']:.1f} px) "
                     f"over {joints['n']} joint positions in the swing")
        if joints["median"] > JOINT_PX:
            worse.append(f"joints moved {joints['median']:.2f} px (median), more than {JOINT_PX:.0f} px")
    jb, jn = rows(before, "joints"), rows(now, "joints")
    changes = [(abs(jn[k]["median"] - jb[k]["median"]), k) for k in jn
               if k in jb and jn[k].get("median") is not None and jb[k].get("median") is not None]
    if changes:
        d, k = max(changes)
        lines.append(f"  Joint error (% of height), the most any group moved: {k[0]} {k[1]} {k[2]} "
                     f"{jb[k]['median']:.2f} -> {jn[k]['median']:.2f}")
    # The ball and the club shaft.
    bb, bn = rows(before, "ball"), rows(now, "ball")
    for k in bn:
        if k in bb and (bn[k].get("found") or 0) < (bb[k].get("found") or 0):
            worse.append(f"ball ({k[0]}) found {bb[k]['found']:.0f}% -> {bn[k]['found']:.0f}%")
    cb_, cn_ = rows(before, "club"), rows(now, "club")
    for k in cn_:
        if k[1] != "all" or k not in cb_:
            continue
        b, n = cb_[k], cn_[k]
        lines.append(f"  Shaft ({k[0]}): found {b['found']:.0f}% -> {n['found']:.0f}%, angle error "
                     f"{fmt(b.get('median'))} -> {fmt(n.get('median'))} degrees")
        if n["found"] < b["found"] - FOUND_POINTS:
            worse.append(f"shaft ({k[0]}) found {b['found']:.0f}% -> {n['found']:.0f}%")
        if n.get("median") is not None and b.get("median") is not None and n["median"] > b["median"] + CLUB_DEGREES:
            worse.append(f"shaft ({k[0]}) angle error {b['median']:.1f} -> {n['median']:.1f} degrees")
    # The key positions leave one swing out, and the tuning picked.
    if tuned.get("before") and tuned.get("now"):
        loso = {}
        for key in ("before", "now"):
            for r in next(iter(tuned[key]["loso"].values()), []):
                if r["ms"] is not None:
                    loso.setdefault((r["event"], r["angle"]), {}).setdefault(key, []).append(abs(r["ms"]))
        for (event, angle), got in sorted(loso.items()):
            if "before" in got and "now" in got:
                mb, mn = float(np.median(got["before"])), float(np.median(got["now"]))
                if mn - mb > ONE_FRAME_MS:
                    worse.append(f"{event} ({angle}) left out of the tuning: median error {mb:.1f} -> {mn:.1f} ms")
        if tuned["before"]["tuning"] != tuned["now"]["tuning"]:
            lines.append(f"  The tuning picked moved: {json.dumps(tuned['before']['tuning'])} -> "
                         f"{json.dumps(tuned['now']['tuning'])} (tune_positions.py above)")
        else:
            lines.append("  tune_positions.py picks the same tuning both ways")
    lines.append("  No worse: " + ("yes" if not worse else "NO"))
    lines += [f"    {w}" for w in worse]
    if worse:
        lines.append("  Put the setting(s) back one at a time (HOME-SETUP.md, \"Keeping up during a session\") and "
                     "run this again to find which.")
    return lines


def fmt(v) -> str:
    return "-" if v is None else f"{v:.1f}"


# ---- Running it ----

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("clip", nargs="?", type=Path, help="a clip (default: the newest one on the server)")
    ap.add_argument("--providers", help="comma-separated, of cpu, dml, cuda (default: every one installed)")
    ap.add_argument("--frames", type=int, default=60, help="frames to time each model on (default 60)")
    ap.add_argument("--runs", type=int, default=2, help="whole-clip runs per setting; the last counts (default 2)")
    ap.add_argument("--no-clip", action="store_true", help="only the models, not the whole clip")
    ap.add_argument("--each", action="store_true",
                    help="also the whole clip with each speed setting put back to before on its own")
    ap.add_argument("--workers", help="also the whole clip with these worker counts, comma-separated (e.g. 6,8)")
    ap.add_argument("--accuracy", action="store_true",
                    help="instead: score the speed settings as set now against as before on the labeled clips")
    args = ap.parse_args(argv)
    if args.accuracy:
        return accuracy()
    try:
        more_workers = [int(n) for n in (args.workers or "").split(",") if n.strip()]
    except ValueError:
        print(f"--workers: {args.workers!r} isn't a list of whole numbers")
        return 1

    clip = args.clip or newest_clip()
    if clip is None or not clip.is_file():
        print(f"No clip: pass one, or put clips in {app.CLIPS_DIR}")
        return 1
    have = models.available()
    providers = ["cpu"] + [p for p in have if p != "cpu"]
    if args.providers:
        asked = [p.strip().lower() for p in args.providers.split(",") if p.strip()]
        for p in asked:
            if p not in models.PROVIDERS:
                print(f"--providers: {p!r} isn't one of {', '.join(models.PROVIDERS)}")
                return 1
            if p not in have:
                package, reqs = models.PACKAGES[p]
                print(f"{models.PROVIDER_NAMES[p]}: not in the installed onnxruntime (needs {package}: {reqs})")
        providers = [p for p in asked if p in have]
    if not providers:
        return 1
    env_backup = {k: os.environ.get(k) for k in ("SWINGCLIPS_ORT_PROVIDER", "SWINGCLIPS_POSE_BACKEND")}
    backend = models.backend()
    if backend == models.DEFAULT and models.model_path("rtmpose-m").is_file():
        backend = "rtmpose-m"
    workers = app.POSE_WORKERS
    print(f"Clip {clip.name}; providers {', '.join(providers)}; {workers} worker(s); ONNX Runtime "
          f"{__import__('onnxruntime').__version__}", flush=True)
    result = {"clip": clip.name, "workers": workers, "backend": backend, "providers": providers,
              "gpus": {p: gpu_name(p) for p in providers if p != "cpu"}, "models": {}, "diffs": {}, "clip_diffs": {},
              "clip_runs": [], "speed_runs": []}
    try:
        frames = sample_frames(clip, args.frames)
        landmarks = golfer(frames, saved_landmarks(clip))
        print(f"Timing the models on {len(frames)} frames ...", flush=True)
        for name in (*models.SPECS, "club"):
            per = {}
            for where in providers:
                r = time_model(name, where, frames, landmarks)
                if r is None:
                    break
                per[where] = r
                print(f"  {LABELS[name]} on {models.PROVIDER_NAMES[where]}: {r['ms']:.1f} ms a frame", flush=True)
            if per:
                result["models"][name] = per
                if name == backend and "cpu" in per:
                    for where, r in per.items():
                        if where != "cpu":
                            result["diffs"][where] = difference(per["cpu"]["points"], r["points"])
        if not args.no_clip:
            now = speed_runs(result, clip, workers, backend, args.runs, args.each, more_workers)
            if backend == models.DEFAULT:
                print("Whole clip on a GPU: no body model (SWINGCLIPS_POSE_BACKEND is mediapipe and rtmpose-m isn't "
                      "here), so nothing in it runs on the GPU; skipped.")
            else:
                cpu_lms = None
                for where in providers:
                    default = pose.BODY_STRIDE or (pose.BODY_STRIDE_CPU if where == "cpu" else pose.BODY_STRIDE_GPU)
                    strides = [default] + ([pose.BODY_STRIDE_CPU] if where != "cpu" and default != pose.BODY_STRIDE_CPU
                                           else [])
                    for stride in strides:
                        if where == "cpu" and stride == now["stride"]:
                            r = now                  # the CPU as set now: run above
                        else:
                            print(f"Whole clip on {models.PROVIDER_NAMES[where]}, body model {every(stride)} ...",
                                  flush=True)
                            r = whole_clip(clip, where, stride, workers, backend, args.runs)
                            print(f"  {r['seconds']:.1f} s (first run, starting the workers: {r['first']:.1f} s)",
                                  flush=True)
                        result["clip_runs"].append({"where": where, "stride": stride, "default": stride == default,
                                                    **{k: r[k] for k in ("seconds", "split", "provider")}})
                        if where == "cpu" and stride == pose.BODY_STRIDE_CPU:
                            cpu_lms = r["landmarks"]
                        elif stride == pose.BODY_STRIDE_CPU and cpu_lms is not None:
                            layout = models.SPECS[backend].layout
                            d = difference(body_points(cpu_lms, layout), body_points(r["landmarks"], layout))
                            result["clip_diffs"][where] = d
                            if d:
                                print(f"  landmarks against the CPU's, whole clip: {d['median']:.2f} px apart "
                                      f"(at most {d['max']:.1f} px)", flush=True)
                print("Whole clip without the body model (the floor) ...", flush=True)
                r = whole_clip(clip, "cpu", pose.BODY_STRIDE_CPU, workers, models.DEFAULT, args.runs)
                print(f"  {r['seconds']:.1f} s", flush=True)
                result["floor"] = r["seconds"]
    finally:
        for k, v in env_backup.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    print()
    print("\n".join(verdict(result)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
