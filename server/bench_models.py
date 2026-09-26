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

Then a verdict on one screen. Nothing is written; the server can keep running, but it slows both down.
"""
import argparse
import os
import platform
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

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
    import gzip
    import json
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

def whole_clip(clip: Path, where: str, stride: int, workers: int, backend: str, runs: int) -> dict:
    """pose.analyze on the clip with the models on `where` and the body model every `stride` frames:
    seconds (the last run), the per-frame split, and the landmarks."""
    os.environ["SWINGCLIPS_ORT_PROVIDER"] = where
    os.environ["SWINGCLIPS_POSE_BACKEND"] = backend
    saved_stride, pose.BODY_STRIDE = pose.BODY_STRIDE, stride
    seconds = []
    try:
        # A fresh pool: workers read the provider when they load the models, and keep them loaded.
        pool = ProcessPoolExecutor(workers)
        try:
            for _ in range(runs):
                started = time.perf_counter()
                out = pose.analyze(str(clip), pool, workers)
                seconds.append(time.perf_counter() - started)
        finally:
            pool.shutdown(cancel_futures=True)
    finally:
        pose.BODY_STRIDE = saved_stride
    h, w = frame_size(clip)
    lms = [None if f["lm"] is None else [(f["lm"][i] * w, f["lm"][i + 1] * h, f["lm"][i + 2])
                                         for i in range(0, len(f["lm"]), 3)] for f in out["frames"]]
    return {"seconds": seconds[-1], "first": seconds[0], "frames": len(out["frames"]),
            "split": out.get("msPerFrame", {}), "provider": out.get("provider", "cpu"), "landmarks": lms}


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
    runs = result["clip_runs"]
    if runs:
        cpu = next((r for r in runs if r["where"] == "cpu" and r["default"]), None)
        gpu_runs = [r for r in runs if r["where"] != "cpu"]
        text = f"  Whole clip ({result['backend']}): "
        if cpu:
            text += f"CPU {cpu['seconds']:.1f} s ({every(cpu['stride'])})"
        for r in gpu_runs:
            text += (" -> " if r is gpu_runs[0] and cpu else ", ") + \
                f"{provider_label(r['where'], gpus)} {r['seconds']:.1f} s ({every(r['stride'])})"
            if r["provider"] != r["where"]:
                text += " [ran on the CPU: see the messages above]"
        lines.append(text)
        for r in runs:
            split = ", ".join(f"{k} {v:.0f}" for k, v in r["split"].items())
            if split:
                lines.append(f"    {models.PROVIDER_NAMES[r['where']]}, {every(r['stride'])}: ms a frame in each "
                             f"worker: {split}")
        if result.get("floor") is not None:
            lines.append(f"  Floor, no body model at all: {result['floor']:.1f} s. No GPU gets the body model's clips "
                         "below this; the rest (MediaPipe, the shaft, decoding) is the CPU's.")
        best = min(runs, key=lambda r: r["seconds"])
        keeps = best["seconds"] <= KEEP_UP_SECONDS
        lines.append(f"  Keeping up (a swing, two clips, every ~20 s: {KEEP_UP_SECONDS:.0f} s a clip or less): "
                     + ("yes" if keeps else "no") + f", best {best['seconds']:.1f} s "
                     f"({models.PROVIDER_NAMES[best['where']]}, {every(best['stride'])})")
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


# ---- Running it ----

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("clip", nargs="?", type=Path, help="a clip (default: the newest one on the server)")
    ap.add_argument("--providers", help="comma-separated, of cpu, dml, cuda (default: every one installed)")
    ap.add_argument("--frames", type=int, default=60, help="frames to time each model on (default 60)")
    ap.add_argument("--runs", type=int, default=2, help="whole-clip runs per setting; the last counts (default 2)")
    ap.add_argument("--no-clip", action="store_true", help="only the models, not the whole clip")
    args = ap.parse_args(argv)

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
              "clip_runs": []}
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
            if backend == models.DEFAULT:
                print("Whole clip: no body model (SWINGCLIPS_POSE_BACKEND is mediapipe and rtmpose-m isn't here), "
                      "so nothing in it runs on the GPU; skipped.")
            else:
                cpu_lms = None
                for where in providers:
                    default = pose.BODY_STRIDE or (pose.BODY_STRIDE_CPU if where == "cpu" else pose.BODY_STRIDE_GPU)
                    strides = [default] + ([pose.BODY_STRIDE_CPU] if where != "cpu" and default != pose.BODY_STRIDE_CPU
                                           else [])
                    for stride in strides:
                        print(f"Whole clip on {models.PROVIDER_NAMES[where]}, body model {every(stride)} ...", flush=True)
                        r = whole_clip(clip, where, stride, workers, backend, args.runs)
                        print(f"  {r['seconds']:.1f} s (first run, starting the workers: {r['first']:.1f} s)", flush=True)
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
