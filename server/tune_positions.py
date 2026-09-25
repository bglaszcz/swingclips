"""Key positions against the hand labels, scored leave-one-swing-out: for each labeled swing, the
tuning (phases.js TUNING) is picked on all the other swings and then scored on that one, so the
numbers say how the rules do on swings they weren't tuned on.

  python tune_positions.py                       the fixtures (tests/fixtures/real), both body models
  python tune_positions.py --folders pose        just MediaPipe's pose files
  python tune_positions.py --labels D:\\SwingClips\\labels --pose D:\\SwingClips\\pose --clips clips.json

Prints, per key position and angle, the median, 90th percentile and mean (bias, + = found late)
of the error in ms and the share within one frame; then which tuning the whole set picks, which is
what phases.js should hold. RTMPose-m is the primary target; the pick also counts MediaPipe at half
weight, so it doesn't get worse. Down-the-line errors are for the face-on clip's positions carried
across by the sync, as the page shows them.
"""
import argparse
import bisect
import json
import sys
from pathlib import Path

import numpy as np

import swings

HERE = Path(__file__).parent
REAL = HERE / "tests" / "fixtures" / "real"
EVENTS = ["takeaway", "p2", "p3", "p4", "p5", "p6", "impact", "p8"]
PREDICTED = {"impact": "p7"}
# What each knob moves, and the values tried.
GRID = {"takeawayDegrees": [1, 3, 5], "topSpeedShares": [[0.1, 0.4], [0.2, 0.5], [0.3, 0.6]],
        "topSmoothSeconds": [0.02, 0.03, 0.04]}
KNOB_EVENTS = {"takeawayDegrees": ["takeaway"], "topSpeedShares": ["p4"], "topSmoothSeconds": ["p4"]}
PRIMARY, SECONDARY = "pose-rtmpose-m", "pose"
# The errors test_fixtures.py holds phases.js to (tune_positions.py --baseline writes it).
BASELINE = REAL / "key-positions.json"


def load_swings(labels_dir: Path, clips_file: Path) -> list[dict]:
    """Each labeled swing once: {main, other (clip dicts), labels: {clip name: events}}."""
    labels = {}
    for f in sorted(labels_dir.glob("*.json")):
        if f.name.endswith(".pass2.json"):
            continue
        doc = json.loads(f.read_text(encoding="utf-8"))
        if doc.get("events"):
            labels[doc["clip"]["name"]] = doc["events"]
    clips = {c["name"]: c for c in json.loads(clips_file.read_text(encoding="utf-8"))}
    out = {}
    for name in labels:
        c = clips[name]
        main = clips[c["partner"]] if c["angle"] == "dtl" and c.get("partner") in clips else c
        other = clips.get(main.get("partner") or "")
        out[main["name"]] = {"main": main, "other": other,
                             "labels": {n: labels[n] for n in (main["name"], other and other["name"]) if n in labels}}
    return list(out.values())


def frame_index(ts, t):
    return max(0, bisect.bisect_right(ts, t + 0.0005) - 1)


class Scorer:
    """Errors per swing for one pose folder, for any tuning (cached)."""

    def __init__(self, folder: Path, swing_list: list[dict]):
        self.js = swings.Summarizer(HERE / "static")
        self.inputs = []
        for s in swing_list:
            mi = swings.pose_input(s["main"], folder / f"{s['main']['name']}.v6.json.gz")
            oi = swings.pose_input(s["other"], folder / f"{s['other']['name']}.v6.json.gz") if s["other"] else None
            self.inputs.append((s, mi, oi))
        self.cache = {}

    def errors(self, tuning: dict) -> list[list[dict]]:
        """Per swing: [{angle, event, ms, frames}] for every labeled event."""
        key = json.dumps(tuning, sort_keys=True)
        if key in self.cache:
            return self.cache[key]
        self.js.call("aspectOf", "x", 0)   # the engine is up
        self.js.ctx.eval(f"Object.assign(SwingPhases.TUNING, {json.dumps(tuning)})")
        out = []
        for s, mi, oi in self.inputs:
            got = self.js.call("positionTimes", mi, oi, swings.LEAD_SIDE)
            rows = []
            for angle, clip, inp, pred in (("face", s["main"], mi, got["main"]), ("dtl", s["other"], oi, got["dtl"])):
                if clip is None or clip["name"] not in s["labels"] or inp is None:
                    continue
                ts = [f["t"] for f in inp["frames"]]
                for ev in EVENTS:
                    lt = s["labels"][clip["name"]].get(ev)
                    pt = (pred or {}).get("times", {}).get(PREDICTED.get(ev, ev))
                    if lt is None:
                        continue
                    rows.append({"clip": clip["name"], "angle": angle, "event": ev, "ms": None if pt is None else (pt - lt) * 1000,
                                 "frames": None if pt is None else frame_index(ts, pt) - frame_index(ts, lt)})
            out.append(rows)
        self.cache[key] = out
        return out

    def tuning(self) -> dict:
        """phases.js's TUNING as the file holds it."""
        self.js.call("aspectOf", "x", 0)   # the engine is up
        return json.loads(self.js.ctx.eval("JSON.stringify(SwingPhases.TUNING)"))

    def close(self):
        self.js.close()


def summary(rows: list[dict]) -> dict:
    v = np.array([r["ms"] for r in rows if r["ms"] is not None], float)
    if not len(v):
        return {"n": 0}
    within = [abs(r["frames"]) <= 1 for r in rows if r["frames"] is not None]
    return {"n": len(v), "median": float(np.median(np.abs(v))), "p90": float(np.percentile(np.abs(v), 90)),
            "bias": float(v.mean()), "within1": 100 * sum(within) / len(within), "missed": sum(r["ms"] is None for r in rows)}


def cost(scorers: dict, tuning: dict, events: list[str], swing_ids) -> float:
    """What a tuning is picked by: RTMPose-m's median |error| over the events (both angles), plus
    half of MediaPipe's."""
    total = 0.0
    for folder, weight in ((PRIMARY, 1.0), (SECONDARY, 0.5)):
        if folder not in scorers:
            continue
        errs = scorers[folder].errors(tuning)
        v = [abs(r["ms"]) if r["ms"] is not None else 500.0 for i in swing_ids for r in errs[i] if r["event"] in events]
        total += weight * (float(np.median(v)) if v else 0.0)
    return total


def best_tuning(scorers, swing_ids, base: dict) -> dict:
    """Each knob picked on its own events (they don't interact: one moves the takeaway, one the top)."""
    out = dict(base)
    for knob, values in GRID.items():
        out[knob] = min(values, key=lambda v: (cost(scorers, {**out, knob: v}, KNOB_EVENTS[knob], swing_ids),
                                               v != base[knob]))
    return out


def loso(scorers, n: int, base: dict) -> tuple[dict, list]:
    """{folder: [rows]} scored leave-one-swing-out, and the tuning each held-out swing got."""
    rows = {f: [] for f in scorers}
    picks = []
    for held in range(n):
        tuning = best_tuning(scorers, [i for i in range(n) if i != held], base)
        picks.append(tuning)
        for f, sc in scorers.items():
            rows[f] += sc.errors(tuning)[held]
    return rows, picks


def table(title: str, by_folder: dict) -> None:
    print(f"\n{title}")
    print(f"  {'event':9} {'angle':5} " + "  ".join(f"{f[:14]:>36}" for f in by_folder))
    print(f"  {'':15} " + "  ".join(f"{'n  median   p90   bias  %1fr':>36}" for _ in by_folder))
    for ev in EVENTS:
        for angle in ("face", "dtl"):
            cells = []
            for rows in by_folder.values():
                s = summary([r for r in rows if r["event"] == ev and r["angle"] == angle])
                cells.append("-".rjust(36) if not s["n"] else
                             f"{s['n']:>3} {s['median']:8.1f} {s['p90']:6.1f} {s['bias']:+6.1f} {s['within1']:5.0f}".rjust(36))
            if any(c.strip() != "-" for c in cells):
                print(f"  {ev:9} {angle:5} " + "  ".join(cells))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--labels", type=Path, default=REAL / "labels")
    ap.add_argument("--clips", type=Path, default=REAL / "clips.json")
    ap.add_argument("--pose", type=Path, default=REAL, help="the folder holding the pose folders")
    ap.add_argument("--folders", nargs="+", default=[PRIMARY, SECONDARY])
    ap.add_argument("--json", type=Path, help="also write the rows here")
    ap.add_argument("--baseline", action="store_true",
                    help=f"save each labeled clip's errors with phases.js as it is to {BASELINE.relative_to(HERE)}, "
                         "which tests/test_fixtures.py holds later changes to")
    args = ap.parse_args(argv)
    swing_list = load_swings(args.labels, args.clips)
    scorers = {f: Scorer(args.pose / f, swing_list) for f in args.folders}
    try:
        base = next(iter(scorers.values())).tuning()
        as_is = {f: [r for rs in sc.errors(base) for r in rs] for f, sc in scorers.items()}
        table(f"As phases.js holds it now ({json.dumps(base)}), all swings (tuned on them: optimistic)", as_is)
        rows, picks = loso(scorers, len(swing_list), base)
        table(f"Leave one swing out ({len(swing_list)} swings): tuned on the others, scored on the one left out", rows)
        whole = best_tuning(scorers, range(len(swing_list)), base)
        print(f"\nTuning picked on all {len(swing_list)} swings: {json.dumps(whole)}"
              + ("" if whole == base else f"  (phases.js has {json.dumps(base)})"))
        spread = {k: sorted({json.dumps(p[k]) for p in picks}) for k in GRID}
        print(f"Picked with one swing left out: {json.dumps(spread)}")
        if args.baseline:
            doc = {"tuning": base, "note": "ms, + = found late; per pose folder, clip and event (tune_positions.py --baseline)",
                   "errors": {f: {} for f in scorers}}
            for f, rs in as_is.items():
                for r in rs:
                    doc["errors"][f].setdefault(r["clip"], {})[r["event"]] = None if r["ms"] is None else round(r["ms"], 2)
            BASELINE.write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n", encoding="utf-8")
            print(f"Saved {BASELINE}")
        if args.json:
            args.json.write_text(json.dumps({"asIs": as_is, "loso": rows, "tuning": whole, "picks": picks}, indent=1))
    finally:
        for sc in scorers.values():
            sc.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
