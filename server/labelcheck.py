"""What each hand-label file has, and what looks like a slip, for the review page's Labels view.

A label file (labeling mode, static/labels.js) is checked on its own (key moments present and in
order, frames with points, the ball, joints all marked blurry) and against the tracker's pose file
for the clip: left and right swapped on a frame, the ball far from where the tracker found it, and
impact away from the frame the ball disappears. Disagreeing with the tracker isn't always a slip
(the tracker is what's being measured), so the view words these as things to look at.
"""
import bisect
import gzip
import json
import math
import re
from pathlib import Path

EVENTS = ("takeaway", "p2", "p3", "p4", "p5", "p6", "impact", "p8")
POINTS = ("l_shoulder", "l_elbow", "l_wrist", "r_shoulder", "r_elbow", "r_wrist", "l_hip", "r_hip",
          "grip", "hosel", "head")
BODY = POINTS[:8]
# MediaPipe landmark for each labeled joint.
JOINTS = {"l_shoulder": 11, "r_shoulder": 12, "l_elbow": 13, "r_elbow": 14, "l_wrist": 15, "r_wrist": 16,
          "l_hip": 23, "r_hip": 24}
PAIRS = (("l_shoulder", "r_shoulder", "shoulders"), ("l_hip", "r_hip", "hips"), ("l_elbow", "r_elbow", "elbows"),
         ("l_wrist", "r_wrist", "wrists"))
NOSE, ANKLES = 0, (27, 28)
# A frame counts as labeled with this many of the 11 points done (seen, blurred or marked hidden).
FRAME_DONE = 8
# The tracker's left and right must be this far apart (share of body height) to tell a mix-up, and
# at least this many pairs must look crossed: the tracker swaps a single pair now and then itself.
SWAP_APART = 0.04
SWAP_PAIRS = 2
# Face-on hips labeled this much wider apart than the tracker's (share of body height): clicked at
# the outer edge of the hips rather than the hip joint centre, where the trackers put them.
HIP_WIDE = 0.07
# The same key moment on the two angles, lined up by the labeled impacts, this far apart (s).
ANGLES_APART = 0.02
# The ball this far from the tracker's (share of body height), impact this far from ball-gone (s).
BALL_OFF = 0.05
IMPACT_OFF = 0.0125   # 3 frames at 240 fps

_cache: dict[str, tuple] = {}


def load_pose(path: Path | None):
    if path is None or not path.is_file():
        return None
    with gzip.open(path, "rb") as f:
        return json.loads(f.read())


def aspect_of(name: str, rotation: int) -> float:
    """Upright picture width / height, from the clip name's size and the pose file's rotation."""
    m = re.search(r"_(\d+)x(\d+)_", name)
    w, h = (int(m.group(1)), int(m.group(2))) if m else (16, 9)
    return h / w if rotation in (90, 270) else w / h


def check(doc: dict, pose: dict | None) -> dict:
    """One label file: what it has and a list of possible slips (plain sentences)."""
    events = doc.get("events") or {}
    frames = doc.get("frames") or {}
    issues = []

    have = [k for k in EVENTS if isinstance(events.get(k), (int, float))]
    times = [events[k] for k in have]
    if any(b <= a for a, b in zip(times, times[1:])):
        order = [k for k in sorted(have, key=lambda k: events[k])]
        issues.append("Key moments are out of order: " + " → ".join(k.upper() if k != "takeaway" else "T" for k in order))

    point_frames, all_blur = 0, 0
    for pts in frames.values():
        if sum(1 for k in POINTS if pts.get(k)) >= FRAME_DONE:
            point_frames += 1
        seen = [pts[k] for k in BODY if pts.get(k) and not pts[k].get("hidden")]
        if len(seen) >= 4 and all(p.get("blur") for p in seen):
            all_blur += 1
    if all_blur:
        issues.append(f"Every joint is marked blurry on {all_blur} frame(s). Blur (Shift+click) is for motion "
                      "streaks; a soft-focus joint is a normal click.")

    if pose:
        name = (doc.get("clip") or {}).get("name", "")
        aspect = aspect_of(name, pose.get("rotation") or 0)
        pf = pose.get("frames") or []
        ts = [f["t"] for f in pf]
        swapped, wide_hips = [], 0
        face_on = (doc.get("clip") or {}).get("angle", "face") != "dtl"
        for key, pts in frames.items():
            if not ts:
                break
            t = float(key)
            i = min(max(bisect.bisect_left(ts, t), 0), len(ts) - 1)
            if i > 0 and abs(ts[i - 1] - t) < abs(ts[i] - t):
                i -= 1
            lm = pf[i].get("lm")
            if not lm:
                continue
            height = abs((lm[ANKLES[0] * 3 + 1] + lm[ANKLES[1] * 3 + 1]) / 2 - lm[NOSE * 3 + 1]) or 1.0
            tracked = lambda k: (lm[JOINTS[k] * 3] * aspect, lm[JOINTS[k] * 3 + 1])
            labeled = lambda k: (pts[k]["x"] * aspect, pts[k]["y"])
            crossed = []
            for a, b, what in PAIRS:
                if not all(pts.get(k) and pts[k].get("x") is not None and not pts[k].get("hidden") for k in (a, b)):
                    continue
                ta, tb, la, lb = tracked(a), tracked(b), labeled(a), labeled(b)
                if math.dist(ta, tb) < SWAP_APART * height:
                    continue
                straight = math.dist(la, ta) + math.dist(lb, tb)
                if math.dist(la, tb) + math.dist(lb, ta) < 0.5 * straight:
                    crossed.append(what)
            if len(crossed) >= SWAP_PAIRS:
                swapped.append((t, crossed))
            elif face_on and all(pts.get(k) and pts[k].get("x") is not None and not pts[k].get("hidden")
                                 for k in ("l_hip", "r_hip")):
                wider = abs(pts["l_hip"]["x"] - pts["r_hip"]["x"]) * aspect - math.dist(tracked("l_hip"), tracked("r_hip"))
                if wider > HIP_WIDE * height:
                    wide_hips += 1
        if wide_hips:
            issues.append(f"The hips look clicked at the outer edge on {wide_hips} frame(s). Click the hip joint centre: "
                          "where the thigh bone meets the pelvis, well inside the outline.")
        for t, crossed in sorted(swapped):
            issues.append(f"Left and right look swapped at {t:.3f} s ({', '.join(crossed)}). Left is the golfer's "
                          "own: the lead side, nearer the target.")

        ball, tball = doc.get("ball"), pose.get("ball")
        if ball and tball and ball.get("x") is not None:
            height = _address_height(pf)
            d = math.dist((ball["x"] * aspect, ball["y"]), (tball["x"] * aspect, tball["y"]))
            if height and d > BALL_OFF * height:
                issues.append("The ball is far from where the tracker found it: check B was clicked on the ball.")

        imp, timp = events.get("impact"), pose.get("impact")
        if isinstance(imp, (int, float)) and isinstance(timp, (int, float)) and abs(imp - timp) > IMPACT_OFF:
            ms = round((imp - timp) * 1000)
            issues.append(f"Impact is {abs(ms)} ms {'after' if ms > 0 else 'before'} the frame the tracker saw the ball "
                          "go. Impact is the first frame the ball is gone (either could be off).")

    return {
        "events": len(have),
        "missing": [k for k in EVENTS if k not in have],
        "pointFrames": point_frames,
        "frames": len(frames),
        "ball": bool(doc.get("ball")),
        "issues": issues,
    }


def _address_height(pf: list) -> float | None:
    for f in pf:
        lm = f.get("lm")
        if lm:
            return abs((lm[ANKLES[0] * 3 + 1] + lm[ANKLES[1] * 3 + 1]) / 2 - lm[NOSE * 3 + 1]) or None
    return None


def _pass_and_clip(f: Path) -> tuple[int, str]:
    """(pass, clip name) from a label file's name: <clip>.json or <clip>.pass2.json."""
    if f.name.endswith(".pass2.json"):
        return 2, f.name[:-len(".pass2.json")]
    return 1, f.name[:-len(".json")]


def summary(labels_dir: Path, pose_path) -> list[dict]:
    """Every label file, checked. `pose_path(clip name)` gives the clip's pose file (or None).
    Cached by the label and pose files' times, since the view asks again as labels change."""
    out = []
    if not labels_dir.is_dir():
        return out
    files = sorted(labels_dir.glob("*.json"))
    labeled = {_pass_and_clip(f) for f in files}
    docs: dict[tuple[int, str], dict] = {}
    for f in files:
        label_pass = _pass_and_clip(f)[0]
        try:
            doc = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            out.append({"file": f.name, "pass": label_pass, "issues": ["The label file can't be read."]})
            continue
        clip = (doc.get("clip") or {}).get("name") or f.name
        pp = pose_path(clip)
        stamp = (f.stat().st_mtime_ns, pp.stat().st_mtime_ns if pp and pp.is_file() else 0)
        got = _cache.get(f.name)
        if got is None or got[0] != stamp:
            got = (stamp, check(doc, load_pose(pp)))
            _cache[f.name] = got
        partner = (doc.get("partner") or {}).get("name")
        docs[(label_pass, clip)] = doc
        row = {"clip": clip, "pass": label_pass, "angle": (doc.get("clip") or {}).get("angle", "face"),
               "partner": partner, "updated": doc.get("updated"), "pose": bool(pp and pp.is_file()), **got[1]}
        row["issues"] = list(row["issues"])
        if partner and (label_pass, partner) not in labeled:
            row["issues"].append("The other camera angle of this swing isn't labeled yet.")
        out.append(row)
    for row in out:
        # Once per swing, on the face-on row (the view shows a swing's rows together).
        if "clip" in row and row["angle"] != "dtl":
            row["issues"] += angles_disagree(docs.get((row["pass"], row["clip"])), docs.get((row["pass"], row["partner"])))
    return out


def angles_disagree(doc: dict | None, other: dict | None) -> list[str]:
    """Key moments marked at different points of the swing on the two angles. The clips' clocks differ,
    so they're lined up by the two labeled impacts."""
    if not doc or not other:
        return []
    ev, ov = doc.get("events") or {}, other.get("events") or {}
    if not isinstance(ev.get("impact"), (int, float)) or not isinstance(ov.get("impact"), (int, float)):
        return []
    out = []
    for k in EVENTS:
        if k == "impact" or not isinstance(ev.get(k), (int, float)) or not isinstance(ov.get(k), (int, float)):
            continue
        apart = (ev[k] - ev["impact"]) - (ov[k] - ov["impact"])
        if abs(apart) > ANGLES_APART:
            name = "Takeaway" if k == "takeaway" else k.upper()
            out.append(f"{name} differs by {round(abs(apart) * 1000)} ms between the angles (later "
                       f"{'face-on' if apart > 0 else 'down the line'}, lined up by the impacts). Check both.")
    return out
