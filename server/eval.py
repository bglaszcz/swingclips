"""The scorecard: how far the pipeline is from hand labels, and how much its numbers move while the
golfer stands still at address (the noise floor). Labels come from the review page's labeling mode
(static/labels.js) and live in the labels folder (see app.py).

  .venv\\Scripts\\python.exe eval.py              score the saved pose results against the labels
  .venv\\Scripts\\python.exe eval.py --rerun      analyze the labeled clips again first, with pose.py as it is now
  .venv\\Scripts\\python.exe eval.py --compare D:\\SwingClips\\eval\\<an earlier result>.json
  .venv\\Scripts\\python.exe eval.py --no-noise   skip the noise floor

The key positions and numbers are worked out by the review page's own JavaScript (as the server
does, see swings.py), so the scorecard scores exactly what the page shows. Prints the tables and
writes everything to SWINGCLIPS_EVAL (default: an "eval" folder next to the clips folder) as
<date>_v<pose version>_<JavaScript fingerprint>.json.
"""
import argparse
import bisect
import gzip
import hashlib
import json
import math
import os
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime
from pathlib import Path

import numpy as np

import app
import pose
import swings

EVAL_DIR = Path(os.environ.get("SWINGCLIPS_EVAL", app.CLIPS_DIR.parent / "eval"))
LEAD_SIDE = swings.LEAD_SIDE

# Labeled moments, in order, and the key position each is compared with. P1 (address) isn't
# labeled: it's defined as a fixed time before the takeaway, so the takeaway is what's scored.
EVENTS = ["takeaway", "p2", "p3", "p4", "p5", "p6", "impact", "p8"]
PREDICTED = {"impact": "p7"}
# Labeled joints and their MediaPipe landmark index. l_ / r_ are the golfer's own left and right.
JOINTS = {"l_shoulder": 11, "r_shoulder": 12, "l_elbow": 13, "r_elbow": 14,
          "l_wrist": 15, "r_wrist": 16, "l_hip": 23, "r_hip": 24}
JOINT_GROUPS = {"shoulders": ("l_shoulder", "r_shoulder"), "elbows": ("l_elbow", "r_elbow"),
                "wrists": ("l_wrist", "r_wrist"), "hips": ("l_hip", "r_hip")}
PAIRS = [("l_shoulder", "r_shoulder"), ("l_elbow", "r_elbow"), ("l_wrist", "r_wrist"), ("l_hip", "r_hip")]
# The one-frame angles need these labeled (the lead side is the golfer's left).
ANGLE_JOINTS = {"face": ("l_shoulder", "r_shoulder", "l_hip", "r_hip", "l_wrist"),
                "dtl": ("l_shoulder", "r_shoulder", "l_hip", "r_hip")}
PHASES = ["address", "backswing", "downswing", "through"]
# Frames of clips without the takeaway, top and impact labeled.
UNKNOWN = "unknown"
# A shaft sighting this sure counts as found (as in club.py and phases.js).
CLUB_SEEN = 0.35
# A labeled frame belongs to the pose frame starting within this much of it (s).
SAME_FRAME = 0.001


# ---- Loading ----

def labels(label_pass: int) -> dict[str, dict]:
    """Every label file of one pass, by clip name."""
    out = {}
    if app.LABELS_DIR.is_dir():
        for f in sorted(app.LABELS_DIR.glob("*.json")):
            if (label_pass == 2) != f.name.endswith(".pass2.json"):
                continue
            doc = json.loads(f.read_text(encoding="utf-8"))
            out[doc["clip"]["name"]] = doc
    return out


def saved_pose(name: str) -> Path | None:
    """The server's pose file for a clip (in the trash too), for this pose.py version."""
    for path in (app.pose_file(name), app.TRASH_DIR / "pose" / app.pose_file(name).name):
        if path.is_file():
            return path
    return None


def pipeline_fingerprint() -> str:
    """Changes whenever pose.py, club.py or the pose model changes, so --rerun caches don't go stale."""
    here = Path(__file__).parent
    h = hashlib.sha1()
    for f in ("pose.py", "club.py"):
        h.update((here / f).read_bytes())
    model = Path(pose.MODEL)
    h.update(f"{model.name}:{model.stat().st_size if model.is_file() else 0}".encode())
    return h.hexdigest()[:10]


def rerun_pose(name: str, cache: Path, pool: ProcessPoolExecutor, workers: int) -> Path | None:
    """The clip analyzed by pose.py as it is now, cached in `cache`."""
    out = cache / f"{name}.v{pose.VERSION}.json.gz"
    if out.is_file():
        return out
    clip = next((p for p in (app.CLIPS_DIR / name, app.TRASH_DIR / name) if p.is_file()), None)
    if clip is None:
        return None
    print(f"  analyzing {name} ...", flush=True)
    result = pose.analyze(str(clip), pool, workers)
    cache.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    tmp.write_bytes(gzip.compress(json.dumps(result, separators=(",", ":")).encode()))
    tmp.replace(out)
    return out


# ---- Scoring one clip ----

def frame_index(ts: list[float], t: float) -> int:
    """The frame on screen at time t: the last one starting at or before it."""
    return max(0, bisect.bisect_right(ts, t + 0.0005) - 1)


def phase_of(t: float, events: dict) -> str:
    """Which part of the swing a labeled frame is in, by the labeled moments."""
    bounds = [events.get(k) for k in ("takeaway", "p4", "impact")]
    if any(b is None for b in bounds):
        return UNKNOWN
    return PHASES[bisect.bisect_right(bounds, t)]


def wrap(deg: float) -> float:
    return (deg + 180) % 360 - 180


def labeled_xy(p) -> tuple[float, float] | None:
    return (p["x"], p["y"]) if isinstance(p, dict) and "x" in p and "y" in p else None


def body_height(frames: list[dict], events: dict) -> float | None:
    """Nose to ankles at address, in picture heights (the unit joint errors are given in)."""
    ts = [f["t"] for f in frames]
    start = frame_index(ts, events["takeaway"] - 0.2) if events.get("takeaway") is not None else 0
    for f in frames[start:] + frames[:start]:
        lm = f["lm"]
        if lm:
            h = max(lm[27 * 3 + 1], lm[28 * 3 + 1]) - lm[1]
            if h > 0:
                return h
    return None


def score_clip(summ: swings.Summarizer, label: dict, inp: dict, predicted: dict | None, dtl_side) -> dict:
    """Everything compared for one labeled clip: {events, joints, swaps, club, angles, ball, notes}."""
    name, angle = inp["name"], inp["angle"]
    frames = inp["frames"]
    ts = [f["t"] for f in frames]
    aspect = summ.call("aspectOf", name, inp["rotation"])
    events = label.get("events") or {}
    out = {"clip": name, "angle": angle, "events": [], "joints": [], "swaps": [], "club": [], "angles": [],
           "ball": None, "notes": []}

    for key in EVENTS:
        lt = events.get(key)
        if lt is None:
            continue
        pt = (predicted or {}).get("times", {}).get(PREDICTED.get(key, key))
        out["events"].append({
            "event": key, "label": lt, "pred": pt,
            "ms": None if pt is None else (pt - lt) * 1000,
            "frames": None if pt is None else frame_index(ts, pt) - frame_index(ts, lt),
            "estimated": (predicted or {}).get("estimated", {}).get(PREDICTED.get(key, key)),
        })
    if events.get("impact") is not None:
        # pose.py's own impact: the first frame the ball is gone.
        lt, pt = events["impact"], inp.get("impact")
        out["events"].append({"event": "ball gone", "label": lt, "pred": pt,
                              "ms": None if pt is None else (pt - lt) * 1000,
                              "frames": None if pt is None else frame_index(ts, pt) - frame_index(ts, lt)})

    height = body_height(frames, events)
    if height is None:
        out["notes"].append("no person tracked: joints and ball not scored")
    tracked_lms, labeled_lms, angle_meta = [], [], []
    for tkey, points in sorted((label.get("frames") or {}).items(), key=lambda kv: float(kv[0])):
        t = float(tkey)
        i = frame_index(ts, t)
        if abs(ts[i] - t) > SAME_FRAME:
            out["notes"].append(f"labeled frame at {t:.4f} s isn't a frame of this pose file")
            continue
        lm = frames[i]["lm"]
        phase = phase_of(t, events)
        if height is not None:
            for joint, idx in JOINTS.items():
                xy = labeled_xy(points.get(joint))
                if xy is None:
                    continue
                err = None if lm is None else math.hypot((lm[idx * 3] - xy[0]) * aspect, lm[idx * 3 + 1] - xy[1]) / height
                out["joints"].append({"t": t, "joint": joint, "phase": phase, "err": err})
            for a, b in PAIRS:
                pa, pb = labeled_xy(points.get(a)), labeled_xy(points.get(b))
                if lm is None or pa is None or pb is None:
                    continue
                d = lambda idx, xy: math.hypot((lm[idx * 3] - xy[0]) * aspect, lm[idx * 3 + 1] - xy[1])
                same = d(JOINTS[a], pa) + d(JOINTS[b], pb)
                crossed = d(JOINTS[a], pb) + d(JOINTS[b], pa)
                out["swaps"].append({"t": t, "pair": a[2:], "phase": phase, "swapped": crossed < 0.5 * same})
        grip, head = points.get("grip"), points.get("head")
        g, h = labeled_xy(grip), labeled_xy(head)
        if g is not None and h is not None:
            want = math.degrees(math.atan2(h[1] - g[1], (h[0] - g[0]) * aspect)) % 360
            club = frames[i].get("club")
            found = bool(club) and club[1] >= CLUB_SEEN
            out["club"].append({"t": t, "phase": phase, "blur": bool(head.get("blur") or grip.get("blur")),
                                "found": found, "label": want,
                                "err": None if not club else abs(wrap(club[0] - want)), "conf": club[1] if club else None})
        needed = ANGLE_JOINTS["dtl" if angle == "dtl" else "face"]
        if lm is not None and all(labeled_xy(points.get(j)) for j in needed):
            fixed = list(lm)
            for joint, idx in JOINTS.items():
                xy = labeled_xy(points.get(joint))
                if xy is not None:
                    fixed[idx * 3], fixed[idx * 3 + 1] = xy
            tracked_lms.append(lm)
            labeled_lms.append(fixed)
            angle_meta.append((t, phase))
    if tracked_lms:
        got = summ.call("frameAngles", tracked_lms + labeled_lms, aspect, LEAD_SIDE, angle, dtl_side)
        n = len(tracked_lms)
        for k, (t, phase) in enumerate(angle_meta):
            a, b = got[k], got[n + k]
            for key in (a or {}):
                if a[key] is not None and b and b.get(key) is not None:
                    out["angles"].append({"t": t, "phase": phase, "metric": key, "err": a[key] - b[key]})

    ball = labeled_xy(label.get("ball"))
    if ball is not None and height is not None:
        found = inp.get("ball")
        out["ball"] = {"found": bool(found), "err": None if not found else
                       math.hypot((found["x"] - ball[0]) * aspect, found["y"] - ball[1]) / height}
    return out


def consistency(first: dict, second: dict, aspect: float, height: float | None) -> dict:
    """How far a second labeling pass is from the first: the labels' own error."""
    out = {"events": [], "joints": [], "club": []}
    e1, e2 = first.get("events") or {}, second.get("events") or {}
    for key in EVENTS:
        if e1.get(key) is not None and e2.get(key) is not None:
            out["events"].append({"event": key, "ms": (e2[key] - e1[key]) * 1000})
    f1 = {round(float(k), 4): v for k, v in (first.get("frames") or {}).items()}
    for tkey, p2 in (second.get("frames") or {}).items():
        p1 = f1.get(round(float(tkey), 4))
        if not p1:
            continue
        if height:
            for joint in JOINTS:
                a, b = labeled_xy(p1.get(joint)), labeled_xy(p2.get(joint))
                if a and b:
                    out["joints"].append({"joint": joint, "err": math.hypot((a[0] - b[0]) * aspect, a[1] - b[1]) / height})
        pts = [(labeled_xy(p.get("grip")), labeled_xy(p.get("head"))) for p in (p1, p2)]
        if all(g and h for g, h in pts):
            deg = [math.degrees(math.atan2(h[1] - g[1], (h[0] - g[0]) * aspect)) for g, h in pts]
            out["club"].append({"err": abs(wrap(deg[1] - deg[0]))})
    return out


# ---- Summaries ----

def stats(values, scale=1.0) -> dict:
    """n, and the median, 90th percentile and mean (bias) of the values; absolute where it says so."""
    v = np.array([x for x in values if x is not None], dtype=float) * scale
    if not len(v):
        return {"n": 0}
    a = np.abs(v)
    return {"n": int(len(v)), "median": float(np.median(a)), "p90": float(np.percentile(a, 90)), "bias": float(v.mean())}


def summarize(clips: list[dict], label_checks: list[dict], noise: list[dict]) -> dict:
    """The tables, as {table: [rows]}, plus a flat {key: number} of the headline numbers for --compare."""
    tables, flat = {}, {}

    rows = []
    for angle in ("face", "dtl"):
        for key in EVENTS + ["ball gone"]:
            recs = [e for c in clips if c["angle"] == angle for e in c["events"] if e["event"] == key]
            if not recs:
                continue
            s = stats([e["ms"] for e in recs])
            within = [abs(e["frames"]) <= 1 for e in recs if e["frames"] is not None]
            estimated = [e for e in recs if e.get("estimated")]
            row = {"angle": angle, "event": key, "labeled": len(recs), "missed": sum(e["ms"] is None for e in recs),
                   **{k: s.get(k) for k in ("median", "p90", "bias")},
                   "within1": 100 * sum(within) / len(within) if within else None,
                   "estimated": len(estimated) if key in ("p2", "p6", "p8") else None}
            rows.append(row)
            flat[f"events.{angle}.{key}.median_ms"] = row["median"]
            flat[f"events.{angle}.{key}.within1_pct"] = row["within1"]
    tables["events"] = rows

    rows = []
    for angle in ("face", "dtl"):
        for group, names in JOINT_GROUPS.items():
            for phase in PHASES + [UNKNOWN]:
                recs = [j for c in clips if c["angle"] == angle for j in c["joints"]
                        if j["joint"] in names and j["phase"] == phase]
                if not recs:
                    continue
                s = stats([j["err"] for j in recs], 100)
                row = {"angle": angle, "joints": group, "phase": phase, "labeled": len(recs),
                       "untracked": sum(j["err"] is None for j in recs), "median": s.get("median"), "p90": s.get("p90")}
                rows.append(row)
                flat[f"joints.{angle}.{group}.{phase}.median_pct"] = row["median"]
    tables["joints"] = rows

    rows = []
    for angle in ("face", "dtl"):
        for pair in ("shoulder", "elbow", "wrist", "hip"):
            recs = [s for c in clips if c["angle"] == angle for s in c["swaps"] if s["pair"] == pair]
            if recs:
                rows.append({"angle": angle, "pair": pair + "s", "frames": len(recs),
                             "swapped": sum(s["swapped"] for s in recs)})
                flat[f"swaps.{angle}.{pair}.count"] = rows[-1]["swapped"]
    tables["swaps"] = rows

    rows = []
    for angle in ("face", "dtl"):
        for phase in PHASES + [UNKNOWN, "all"]:
            recs = [k for c in clips if c["angle"] == angle for k in c["club"] if phase == "all" or k["phase"] == phase]
            if not recs:
                continue
            found = [k for k in recs if k["found"]]
            s = stats([k["err"] for k in found])
            row = {"angle": angle, "phase": phase, "labeled": len(recs), "blurred": sum(k["blur"] for k in recs),
                   "found": 100 * len(found) / len(recs), "median": s.get("median"), "p90": s.get("p90")}
            rows.append(row)
            flat[f"club.{angle}.{phase}.found_pct"] = row["found"]
            flat[f"club.{angle}.{phase}.median_deg"] = row["median"]
    tables["club"] = rows

    rows = []
    for angle in ("face", "dtl"):
        for metric in sorted({a["metric"] for c in clips if c["angle"] == angle for a in c["angles"]}):
            recs = [a for c in clips if c["angle"] == angle for a in c["angles"] if a["metric"] == metric]
            s = stats([a["err"] for a in recs])
            rows.append({"angle": angle, "metric": metric, "frames": s["n"], "median": s.get("median"),
                         "p90": s.get("p90"), "bias": s.get("bias")})
            flat[f"angles.{angle}.{metric}.median_deg"] = rows[-1]["median"]
    tables["angles"] = rows

    rows = []
    for angle in ("face", "dtl"):
        recs = [c["ball"] for c in clips if c["angle"] == angle and c["ball"]]
        if recs:
            s = stats([b["err"] for b in recs if b["found"]], 100)
            rows.append({"angle": angle, "labeled": len(recs), "found": 100 * sum(b["found"] for b in recs) / len(recs),
                         "median": s.get("median"), "p90": s.get("p90")})
            flat[f"ball.{angle}.found_pct"] = rows[-1]["found"]
    tables["ball"] = rows

    rows = []
    if label_checks:
        s = stats([e["ms"] for c in label_checks for e in c["events"]])
        rows.append({"what": "events (ms)", "n": s["n"], "median": s.get("median"), "p90": s.get("p90")})
        s = stats([j["err"] for c in label_checks for j in c["joints"]], 100)
        rows.append({"what": "joints (% of height)", "n": s["n"], "median": s.get("median"), "p90": s.get("p90")})
        s = stats([k["err"] for c in label_checks for k in c["club"]])
        rows.append({"what": "club angle (deg)", "n": s["n"], "median": s.get("median"), "p90": s.get("p90")})
    tables["labeler"] = rows

    rows = []
    for angle in ("face", "dtl"):
        recs = [n for n in noise if n["angle"] == angle]
        for metric in sorted({k for n in recs for k in n["sd"]}):
            sds = [n["sd"][metric] for n in recs if metric in n["sd"]]
            rows.append({"angle": angle, "metric": metric, "clips": len(sds), "median": float(np.median(sds)),
                         "p90": float(np.percentile(sds, 90))})
            flat[f"noise.{angle}.{metric}.median_sd"] = rows[-1]["median"]
    tables["noise"] = rows
    return {"tables": tables, "headline": flat}


# ---- Printing ----

def fmt(v, digits=1) -> str:
    if v is None:
        return "-"
    if isinstance(v, float):
        return f"{v:.{digits}f}"
    return str(v)


def table(title: str, rows: list[dict], columns: list[tuple[str, str]], note: str = "") -> None:
    print(f"\n{title}")
    if not rows:
        print("  (nothing labeled for this yet)")
        return
    cells = [[fmt(r.get(key)) for key, _ in columns] for r in rows]
    widths = [max(len(head), *(len(c[k]) for c in cells)) for k, (_, head) in enumerate(columns)]
    print("  " + "  ".join(head.ljust(w) for (_, head), w in zip(columns, widths)))
    for c in cells:
        print("  " + "  ".join(v.ljust(w) for v, w in zip(c, widths)))
    if note:
        print("  " + note)


def print_report(result: dict) -> None:
    t = result["tables"]
    print(f"Scorecard {result['stamp']}: pose.py v{result['poseVersion']}, JavaScript {result['jsCode']}, "
          f"model {result['poseModel']}, {result['labeledClips']} labeled clip(s)"
          + (" (analyzed again with --rerun)" if result["rerun"] else ""))
    table("Key positions: labeled vs found (ms; + = found late)", t["events"],
          [("angle", "angle"), ("event", "event"), ("labeled", "n"), ("missed", "missed"), ("median", "median |err|"),
           ("p90", "90th pct"), ("bias", "bias"), ("within1", "% within 1 frame"), ("estimated", "shaft guessed")],
          "'ball gone' is pose.py's impact (the first frame without the ball); 'impact' is P7 as the page shows it.")
    table("Joints: distance from the label, % of nose-to-ankle height", t["joints"],
          [("angle", "angle"), ("joints", "joints"), ("phase", "phase"), ("labeled", "n"),
           ("untracked", "no person"), ("median", "median"), ("p90", "90th pct")])
    table("Left/right swaps (tracked left sits on the labeled right)", t["swaps"],
          [("angle", "angle"), ("pair", "pair"), ("frames", "frames"), ("swapped", "swapped")])
    table("Club shaft: found, and angle error where found (degrees)", t["club"],
          [("angle", "angle"), ("phase", "phase"), ("labeled", "n"), ("blurred", "blurred"), ("found", "% found"),
           ("median", "median |err|"), ("p90", "90th pct")])
    table("One-frame angles: from tracked vs labeled joints (degrees; + = tracked higher)", t["angles"],
          [("angle", "angle"), ("metric", "metric"), ("frames", "frames"), ("median", "median |err|"),
           ("p90", "90th pct"), ("bias", "bias")])
    table("Ball at address: found, and distance from the label (% of height)", t["ball"],
          [("angle", "angle"), ("labeled", "n"), ("found", "% found"), ("median", "median"), ("p90", "90th pct")])
    table("Your own consistency: second labeling pass vs the first", t["labeler"],
          [("what", "what"), ("n", "n"), ("median", "median |diff|"), ("p90", "90th pct")],
          "No tracker can be scored more finely than this.")
    table("Noise floor: spread (standard deviation) of each number while standing still at address", t["noise"],
          [("angle", "angle"), ("metric", "metric"), ("clips", "clips"), ("median", "median sd"), ("p90", "90th pct")],
          "Degrees for angles and turns, inches for sway / rise / depth, picture heights for widths.")


def print_compare(old: dict, new: dict) -> None:
    a, b = old.get("headline", {}), new["headline"]
    keys = [k for k in b if k in a and a[k] is not None and b[k] is not None]
    print(f"\nCompared with {old.get('stamp')} (pose.py v{old.get('poseVersion')}, JavaScript {old.get('jsCode')}):")
    if not keys:
        print("  nothing in common to compare")
        return
    width = max(len(k) for k in keys)
    for k in keys:
        change = b[k] - a[k]
        print(f"  {k.ljust(width)}  {a[k]:8.2f} -> {b[k]:8.2f}  ({change:+.2f})")


# ---- Main ----

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--rerun", action="store_true", help="analyze the labeled clips again with pose.py as it is now")
    ap.add_argument("--no-noise", action="store_true", help="skip the noise floor")
    ap.add_argument("--compare", type=Path, help="an earlier result .json to show the changes against")
    ap.add_argument("--out", type=Path, default=EVAL_DIR, help=f"where results go (default {EVAL_DIR})")
    args = ap.parse_args(argv)

    first, second = labels(1), labels(2)
    if not first:
        print(f"No labels in {app.LABELS_DIR} yet: label some clips in the review page first (press L).")
        return 1
    summ = swings.Summarizer(app.STATIC_DIR)
    pool = None
    try:
        paths: dict[str, Path | None] = {}
        if args.rerun:
            workers = app.POSE_WORKERS
            pool = ProcessPoolExecutor(workers)
            cache = args.out / "pose" / pipeline_fingerprint()
            print(f"Analyzing labeled clips again (cached in {cache})")
        # Each swing once: through its face-on clip, or a down-the-line clip on its own.
        swing_list = {}
        for doc in first.values():
            clip, partner = doc["clip"], doc.get("partner")
            main_clip, other = (partner, clip) if clip["angle"] == "dtl" and partner else (clip, partner)
            swing_list[main_clip["name"]] = (main_clip, other)

        def pose_of(info):
            if info is None:
                return None
            name = info["name"]
            if name not in paths:
                paths[name] = rerun_pose(name, cache, pool, workers) if args.rerun else saved_pose(name)
            return paths[name]

        clips, label_checks, inputs = [], [], {}
        for main_clip, other in swing_list.values():
            main_path, other_path = pose_of(main_clip), pose_of(other)
            if main_path is None:
                print(f"  skipped {main_clip['name']}: not analyzed (yet)")
                continue
            mi = swings.pose_input(main_clip, main_path)
            oi = swings.pose_input(other, other_path) if other and other_path else None
            predicted = summ.call("positionTimes", mi, oi, LEAD_SIDE)
            for info, inp, pred in ((main_clip, mi, predicted["main"]), (other, oi, predicted["dtl"])):
                if info is None or inp is None or info["name"] not in first:
                    continue
                inputs[info["name"]] = inp
                clips.append(score_clip(summ, first[info["name"]], inp, pred, predicted["dtlSide"]))
        for name, doc in second.items():
            if name in first and name in inputs:
                inp = inputs[name]
                aspect = summ.call("aspectOf", name, inp["rotation"])
                label_checks.append(consistency(first[name], doc, aspect, body_height(inp["frames"], first[name].get("events") or {})))

        noise = []
        if not args.no_noise:
            if args.rerun:
                todo = [(inputs[c["clip"]]["name"], inputs[c["clip"]]) for c in clips]
            else:
                todo = []
                for c in app.listed_clips(with_shots=False):
                    if c["pose"] == "done" and not c["excluded"]:
                        try:
                            todo.append((c["name"], swings.pose_input(c, app.pose_file(c["name"]))))
                        except FileNotFoundError:
                            pass
            print(f"Noise floor over {len(todo)} clip(s) ...", flush=True)
            for name, inp in todo:
                nf = summ.call("noiseFloor", inp, LEAD_SIDE)
                if nf:
                    noise.append({"clip": name, "angle": inp["angle"], **nf})

        result = {
            "stamp": datetime.now().isoformat(timespec="seconds"),
            "poseVersion": pose.VERSION, "jsCode": summ.code, "poseModel": Path(pose.MODEL).name,
            "rerun": args.rerun, "labeledClips": len(clips),
            **summarize(clips, label_checks, noise),
            "clips": clips, "labeler": label_checks, "noise": noise,
        }
    finally:
        summ.close()
        if pool:
            pool.shutdown(cancel_futures=True)

    print_report(result)
    if args.compare:
        print_compare(json.loads(args.compare.read_text(encoding="utf-8")), result)
    args.out.mkdir(parents=True, exist_ok=True)
    out = args.out / f"{datetime.now():%Y-%m-%d_%H%M}_v{pose.VERSION}_{summ.code}.json"
    out.write_text(json.dumps(result, indent=1), encoding="utf-8")
    print(f"\nSaved {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
