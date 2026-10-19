"""The night worker's improve step, server side: candidates for a better model, judged against the one
in use, and nothing changes until the owner taps Use it (the Night report, /api/improve in app.py).

When there are enough new club points since the last scored try (club_frames, MIN_NEW_FRAMES: the
club model learns only from them, not from key moments or body points), the gaming PC
(night_improve.py) trains a new club model on them and scores it and the model in use with eval.py's deep pass on the
labeled swings neither trained on (the dataset's validation split). It sends the model and the two
scorecards (scores_from) here; judge() says whether it's better: swing by swing against the model in
use, better beyond chance on the key positions a club model moves (or finding the club clearly more
often), and nothing clearly worse. A model scored better on its own training metric once made P2
and P8 worse, which is why the scorecard decides, and why the owner does.

Files, in the "improve" folder beside the pose folder: candidates/<id>/report.json and model.onnx,
and nights.json (what each night did, for the report).
"""
import hashlib
import json
import random
import re
import shutil
import time
from datetime import datetime
from pathlib import Path

# Rows scored on fewer labeled swings than this aren't judged.
MIN_N = 3
# A key position counts as worse with its within-one-frame share this many points lower, or its
# 90th percentile this many ms higher (2 frames at 240 fps).
WORSE_WITHIN1, WORSE_P90 = 10.0, 8.4
# Better on average: the 90th percentiles this many ms lower, or within one frame this many points higher.
BETTER_P90, BETTER_WITHIN1 = 1.0, 3.0
# The club found this many points less often in the downswing counts as worse; more often as better.
CLUB_FOUND = 5.0
# A new club model is trained only with at least this many club-labeled frames (grip, hosel, clubhead)
# new or changed since the last scored try: a handful more can't change the model, and a try costs the
# GPU ~40 min.
MIN_NEW_FRAMES = 40
CLUB_POINTS = ("grip", "hosel", "head")
# Night entries kept.
NIGHTS_KEPT = 60
STATUSES = ("better", "not better", "failed", "in use", "used before")


def same_model(a: str | None, b: str | None) -> bool:
    """Whether two club stamps (models.club_stamp: name@hash) are the same file: by the hash, since a
    candidate's model.onnx becomes club-deep.onnx when it's used."""
    return bool(a and b) and a.split("@")[-1] == b.split("@")[-1]


def labels_sig(labels_dir: Path) -> str:
    """Changes whenever a pass-1 label file is added, saved again or removed."""
    h = hashlib.sha1()
    if labels_dir.is_dir():
        for f in sorted(labels_dir.glob("*.json")):
            if f.name.endswith(".pass2.json"):
                continue
            st = f.stat()
            h.update(f"{f.name}:{st.st_size}:{st.st_mtime_ns}\n".encode())
    return h.hexdigest()[:12]


def club_frames(labels_dir: Path) -> set[str]:
    """Every pass-1 labeled frame with club points, as "clip|time|points": a new or moved point makes
    a new entry. What club_dataset.py trains on."""
    out = set()
    if labels_dir.is_dir():
        for f in sorted(labels_dir.glob("*.json")):
            if f.name.endswith(".pass2.json"):
                continue
            try:
                doc = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            for t, pts in (doc.get("frames") or {}).items():
                club = {k: (pts or {}).get(k) for k in CLUB_POINTS if (pts or {}).get(k)}
                if club:
                    out.add(f"{f.name}|{t}|{hashlib.sha1(json.dumps(club, sort_keys=True).encode()).hexdigest()[:8]}")
    return out


def scores_from(tables: dict, clips: list[dict] | None = None) -> dict:
    """An eval.py result's tables in the report's shape: positions (key positions, ms and %), club and
    clubhead (found %, error); with its per-clip results (`clips`), each swing's too (swings_from), for
    judging swing by swing."""
    r1 = lambda v: None if v is None else round(v, 1)
    out = {
        "positions": [{"angle": r["angle"], "event": r["event"], "n": r.get("labeled", 0), "median": r1(r.get("median")),
                       "p90": r1(r.get("p90")), "within1": r1(r.get("within1"))}
                      for r in tables.get("events", []) if r["event"] != "ball gone"],
        "club": [{"angle": r["angle"], "phase": r["phase"], "n": r.get("labeled", 0), "found": r1(r.get("found")),
                  "median": r1(r.get("median")), "p90": r1(r.get("p90"))} for r in tables.get("club", [])],
        "clubhead": [{"angle": r["angle"], "phase": r["phase"], "n": r.get("labeled", 0), "found": r1(r.get("found")),
                      "median": r1(r.get("median")), "p90": r1(r.get("p90"))} for r in tables.get("clubhead", [])],
    }
    if clips:
        out["swings"] = swings_from(clips)
    return out


def _paired(a: list, b: list, key) -> list[tuple[dict, dict]]:
    other = {key(r): r for r in b}
    return [(r, other[key(r)]) for r in a if key(r) in other]


def _name(row: dict) -> str:
    event = {"p7": "impact", "impact": "impact", "takeaway": "takeaway"}.get(row["event"], row["event"].upper())
    return f"{event} {'face-on' if row['angle'] == 'face' else 'down the line'}"


def judge(current: dict, candidate: dict) -> dict:
    """{better, why}: swing by swing (judge_swings) when both scorecards have their swings; otherwise (reports
    from before Oct 18) from the tables: better when no key position (or the club in the downswing) is
    clearly worse and the key positions are better on average, or the club is found clearly more often
    with the key positions no worse."""
    if current.get("swings") and candidate.get("swings"):
        return judge_swings(current["swings"], candidate["swings"])
    rows = [(a, b) for a, b in _paired(current.get("positions", []), candidate.get("positions", []),
                                       lambda r: (r["angle"], r["event"]))
            if min(a["n"], b["n"]) >= MIN_N and None not in (a["p90"], b["p90"], a["within1"], b["within1"])]
    if not rows:
        return {"better": False, "why": "Nothing to compare: no labeled swings scored on both."}
    worse = []
    for a, b in rows:
        if a["within1"] - b["within1"] > WORSE_WITHIN1:
            worse.append(f"{_name(a)} within one frame {a['within1']:.0f}% -> {b['within1']:.0f}%")
        elif b["p90"] - a["p90"] > WORSE_P90:
            worse.append(f"{_name(a)} 90th percentile {a['p90']:.0f} -> {b['p90']:.0f} ms")
    clubs = [(table, a, b) for table in ("club", "clubhead")
             for a, b in _paired(current.get(table, []), candidate.get(table, []), lambda r: (r["angle"], r["phase"]))
             if a["phase"] == "downswing" and min(a["n"], b["n"]) >= MIN_N and None not in (a["found"], b["found"])]
    found_change = [b["found"] - a["found"] for _, a, b in clubs]
    for (table, a, b), d in zip(clubs, found_change):
        if d < -CLUB_FOUND:
            worse.append(f"{'shaft' if table == 'club' else 'clubhead'} found in the downswing "
                         f"{'face-on' if a['angle'] == 'face' else 'down the line'} {a['found']:.0f}% -> {b['found']:.0f}%")
    p90 = sum(b["p90"] - a["p90"] for a, b in rows) / len(rows)
    within1 = sum(b["within1"] - a["within1"] for a, b in rows) / len(rows)
    if worse:
        return {"better": False, "why": "Worse: " + "; ".join(worse[:3]) + "."}
    avg = f"key positions' 90th percentile {abs(p90):.1f} ms {'better' if p90 < 0 else 'worse'} on average, " \
          f"within one frame {within1:+.1f} points"
    if p90 <= -BETTER_P90 or within1 >= BETTER_WITHIN1:
        return {"better": True, "why": f"Better: {avg}; nothing clearly worse."}
    if found_change and max(found_change) >= CLUB_FOUND and p90 <= 0.5:
        return {"better": True, "why": f"Better: finds the club more often in the downswing ({max(found_change):+.0f} "
                                       f"points), {avg}."}
    return {"better": False, "why": f"About the same: {avg}."}


# ---- Swing by swing (Oct 18) ----
# The table judge above compares within-one-frame shares on 7-17 swings, where one swing is 6-14 points:
# on the nine tries so far its verdicts followed one or two swings (and two trainings on the same frames
# disagreed by 50 points on face-on P2). With each swing's error from both models (the eval's own
# per-clip results, scores_from's "swings"), judge_swings compares the same swings: per key position the
# mean change in error, with a 90% bootstrap interval over the swings; clearly worse only when that whole
# interval is above zero AND the change is at least half a frame; better only when the key positions a
# club model moves (MODEL_EVENTS, both cameras, pooled by swing) are better beyond chance, or the club is
# found clearly more often or the clubhead placed clearly closer in the downswing with them no worse. On the same nine tries: no candidate was
# better beyond chance (pooled changes -0.6..+0.9 ms), and the Oct 10 "better" verdict was within it.
MODEL_EVENTS = ("p2", "p4", "p6", "p8")
JUDGED_EVENTS = ("takeaway", "p2", "p3", "p4", "p5", "p6", "impact", "p8")
# Half a frame at 240 fps: a mean change smaller than this isn't "clearly" anything, however sure.
MARGIN_MS = 2.1
# Off by more than this (one frame), a swing counts as worse / better in a row's tally.
FRAME_MS = 4.2
# Club found in the downswing: a change of this many points, beyond chance, counts.
FOUND_PTS = 5.0
# Clubhead placed this much further from the label (% of the golfer's height), beyond chance: worse.
HEAD_ERR_PCT = 0.5
BOOT = 2000


def swing_id(clip: str) -> str:
    """Both cameras' clips of a swing share its time in their names."""
    m = re.search(r"_(\d{10})(?:_|\.)", clip)
    return m.group(1) if m else clip


def swings_from(clips: list[dict]) -> list[dict]:
    """eval.py's per-clip results, compact: [{clip, angle, events: {event: signed ms}, club / clubhead:
    [[t, phase, found 0/1, err]]}] (club err in degrees, clubhead err in % of height)."""
    r = lambda v, d=1: None if v is None else round(v, d)
    out = []
    for c in clips or []:
        out.append({
            "clip": c["clip"], "angle": c["angle"],
            "events": {e["event"]: r(e["ms"]) for e in c.get("events", [])
                       if e["event"] in JUDGED_EVENTS and e.get("ms") is not None},
            "club": [[round(k["t"], 4), k["phase"], int(bool(k["found"])),
                      r(k.get("err"), 2) if k["found"] else None] for k in c.get("club", [])],
            "clubhead": [[round(k["t"], 4), k["phase"], int(bool(k["found"])),
                          r(k["err"] * 100, 2) if k["found"] and k.get("err") is not None else None]
                         for k in c.get("clubhead", [])],
        })
    return out


def _average_swings(runs: list[list[dict]]) -> list[dict]:
    """Several runs' swings (on the same clips) as one: each key position's error as the mean of the runs'
    |errors| (what a training on these labels gets, on average), found as the share of runs, the club's
    error as the mean where found."""
    by = [{(s["clip"], s["angle"]): s for s in run} for run in runs]
    out = []
    for key, first in by[0].items():
        group = [b[key] for b in by if key in b]
        if len(group) != len(by):
            continue
        events = {e: round(sum(abs(g["events"][e]) for g in group) / len(group), 1)
                  for e in first["events"] if all(e in g["events"] for g in group)}
        row = {"clip": first["clip"], "angle": first["angle"], "events": events}
        for table in ("club", "clubhead"):
            frames = [{(k[0], k[1]): k for k in g.get(table, [])} for g in group]
            merged = []
            for fk, k in frames[0].items():
                ks = [f[fk] for f in frames if fk in f]
                if len(ks) != len(frames):
                    continue
                errs = [x[3] for x in ks if x[2] and x[3] is not None]
                merged.append([k[0], k[1], round(sum(x[2] for x in ks) / len(ks), 3),
                               round(sum(errs) / len(errs), 2) if errs else None])
            row[table] = merged
        out.append(row)
    return out


def _interval(groups: list[list[float]], seed: int = 1) -> tuple[float, float, float]:
    """The mean of all values in `groups` and a 90% bootstrap interval for it, resampling whole groups
    (a swing's values move together). Seeded: the same scores give the same verdict."""
    flat = [v for g in groups for v in g]
    mean = sum(flat) / len(flat)
    rng = random.Random(seed)
    sums = [(sum(g), len(g)) for g in groups]
    means = []
    for _ in range(BOOT):
        tot = cnt = 0
        for _ in sums:
            a, b = sums[rng.randrange(len(sums))]
            tot += a
            cnt += b
        means.append(tot / cnt)
    means.sort()
    return mean, means[int(0.05 * BOOT)], means[int(0.95 * BOOT) - 1]


def _where(angle: str) -> str:
    return "face-on" if angle == "face" else "down the line"


def judge_swings(current: list[dict], candidate: list[dict]) -> dict:
    """judge() when both scorecards have their swings: {better, why, rows, pooled, club}. rows: per key
    position {angle, event, n, mean (change in error, ms; + = worse), lo, hi (its 90% interval), worse /
    better (swings off by more than a frame more / less), verdict "worse" | "better" | "same"}; pooled:
    MODEL_EVENTS together, by swing; club: the downswing per table and camera, {table, angle, n, found
    (change in points), foundLo, foundHi, and for the clubhead err, errLo, errHi (% of height)}."""
    cur = {(s["clip"], s["angle"]): s for s in current}
    pairs = [(cur[(s["clip"], s["angle"])], s) for s in candidate if (s["clip"], s["angle"]) in cur]
    rows, worse, pooled = [], [], {}
    for angle in ("face", "dtl"):
        for event in JUDGED_EVENTS:
            diffs = [(swing_id(a["clip"]), abs(b["events"][event]) - abs(a["events"][event]))
                     for a, b in pairs if a["angle"] == angle and event in a["events"] and event in b["events"]]
            if len(diffs) < MIN_N:
                continue
            if event in MODEL_EVENTS:
                for sid, d in diffs:
                    pooled.setdefault(sid, []).append(d)
            mean, lo, hi = _interval([[d] for _, d in diffs])
            verdict = ("worse" if lo > 0 and mean >= MARGIN_MS else
                       "better" if hi < 0 and mean <= -MARGIN_MS else "same")
            row = {"angle": angle, "event": event, "n": len(diffs), "mean": round(mean, 1), "lo": round(lo, 1),
                   "hi": round(hi, 1), "worse": sum(d > FRAME_MS for _, d in diffs),
                   "better": sum(d < -FRAME_MS for _, d in diffs), "verdict": verdict}
            rows.append(row)
            if verdict == "worse":
                worse.append(f"{_name(row)} off by {mean:.1f} ms more per swing on average "
                             f"({row['worse']} of {row['n']} swings worse by more than a frame)")
    club = []
    for table in ("club", "clubhead"):
        for angle in ("face", "dtl"):
            found, err = {}, {}
            for a, b in pairs:
                if a["angle"] != angle:
                    continue
                before = {(k[0], k[1]): k for k in a.get(table, []) if k[1] == "downswing"}
                for k in b.get(table, []):
                    o = before.get((k[0], k[1]))
                    if o is None:
                        continue
                    sid = swing_id(a["clip"])
                    found.setdefault(sid, []).append((k[2] - o[2]) * 100)
                    if table == "clubhead" and k[3] is not None and o[3] is not None:
                        err.setdefault(sid, []).append(k[3] - o[3])
            if sum(len(v) for v in found.values()) < MIN_N:
                continue
            mean, lo, hi = _interval(list(found.values()))
            row = {"table": table, "angle": angle, "n": sum(len(v) for v in found.values()), "found": round(mean, 1),
                   "foundLo": round(lo, 1), "foundHi": round(hi, 1)}
            what = "shaft" if table == "club" else "clubhead"
            if hi < 0 and mean <= -FOUND_PTS:
                worse.append(f"{what} found in the downswing {_where(angle)} {abs(mean):.0f} points less often")
            if sum(len(v) for v in err.values()) >= MIN_N:
                e, elo, ehi = _interval(list(err.values()))
                row.update(err=round(e, 2), errLo=round(elo, 2), errHi=round(ehi, 2))
                if elo > 0 and e >= HEAD_ERR_PCT:
                    worse.append(f"clubhead placed {e:.1f}% of your height further off in the downswing {_where(angle)}")
            club.append(row)
    out = {"rows": rows, "club": club, "pooled": None}
    if not rows:
        return {**out, "better": False, "why": "Nothing to compare: no labeled swings scored on both."}
    if pooled:
        m, lo, hi = _interval(list(pooled.values()))
        out["pooled"] = {"n": sum(len(v) for v in pooled.values()), "swings": len(pooled), "mean": round(m, 2),
                         "lo": round(lo, 2), "hi": round(hi, 2)}
    if worse:
        return {**out, "better": False, "why": "Worse: " + "; ".join(worse[:3]) + "."}
    p = out["pooled"]
    avg = (f"P2, the top, P6 and P8 off by {abs(p['mean']):.1f} ms {'less' if p['mean'] < 0 else 'more'} per swing "
           f"on average ({p['swings']} swings; 90% sure the change is between {p['lo']:+.1f} and {p['hi']:+.1f} ms)"
           if p else "no club key positions to compare")
    if p and p["hi"] < 0:
        return {**out, "better": True, "why": f"Better: {avg}; nothing clearly worse."}
    # The club itself clearly better (found more often, or the clubhead placed closer), the key positions no worse.
    gains = [f"finds the {'shaft' if r['table'] == 'club' else 'clubhead'} {r['found']:.0f} points more often in the "
             f"downswing {_where(r['angle'])}" for r in club if r["foundLo"] > 0 and r["found"] >= FOUND_PTS]
    gains += [f"places the clubhead {abs(r['err']):.1f}% of your height closer in the downswing {_where(r['angle'])}"
              for r in club if "err" in r and r["errHi"] < 0 and r["err"] <= -HEAD_ERR_PCT]
    if gains and (not p or p["mean"] <= 0.5):
        return {**out, "better": True, "why": f"Better: {'; '.join(gains[:2])}; {avg}."}
    return {**out, "better": False, "why": f"About the same: {avg}."}


# Each candidate is trained this many times (different seeds) and judged on the runs' average: on Oct 6
# two trainings on almost the same frames (872 vs 875) scored face-on P2 within one frame 25% and 75%,
# so one run's verdict was as much luck as model.
RUNS = 2
_AVERAGED = ("median", "p90", "within1", "found")


def average_scores(runs: list[dict]) -> dict:
    """Several runs' scores (scores_from) as one: each row's numbers averaged over the runs that have it."""
    keys = {"positions": lambda r: (r["angle"], r["event"]), "club": lambda r: (r["angle"], r["phase"]),
            "clubhead": lambda r: (r["angle"], r["phase"])}
    out = {}
    for table, key in keys.items():
        rows = {}
        for run in runs:
            for r in run.get(table, []):
                rows.setdefault(key(r), []).append(r)
        merged = []
        for group in rows.values():
            row = dict(group[0], n=min(r["n"] for r in group))
            for f in _AVERAGED:
                vals = [r[f] for r in group if r.get(f) is not None]
                if f in group[0]:
                    row[f] = round(sum(vals) / len(vals), 1) if len(vals) == len(group) else None
            merged.append(row)
        out[table] = merged
    if runs and all(run.get("swings") for run in runs):
        out["swings"] = _average_swings([run["swings"] for run in runs])
    return out


def best_run(runs: list[dict]) -> int:
    """Which of several runs to keep: the most key positions within one frame on average, then the lowest
    90th percentiles."""
    def rank(sc):
        rows = [r for r in sc.get("positions", []) if r["n"] >= MIN_N and r.get("within1") is not None]
        if not rows:
            return (0.0, 0.0)
        return (sum(r["within1"] for r in rows) / len(rows), -sum(r["p90"] or 0 for r in rows) / len(rows))
    return max(range(len(runs)), key=lambda i: rank(runs[i]))


def _within1_all(scores: dict) -> float | None:
    rows = [r for r in scores.get("positions", []) if r.get("within1") is not None and r["n"] >= MIN_N]
    return sum(r["within1"] for r in rows) / len(rows) if rows else None


def summary(train: dict, current: dict, candidate: dict, verdict: dict) -> str:
    """The plain sentence at the top of a candidate."""
    a, b = _within1_all(current), _within1_all(candidate)
    out = f"Trained on {train['swings']} labeled swings ({train['frames']:,} frames)" + (
        f", {train['runs']} times, judged on their average." if train.get("runs", 1) > 1 else ".")
    if a is not None and b is not None:
        seen = (f"{train['scoredClips']} labeled clips it never trained on" if train.get("scoredClips")
                else f"{train['valSwings']} swings it never saw")
        out += (f" On {seen}, key positions within one frame "
                f"went from {a:.0f}% to {b:.0f}% on average.")
    return out + (" Ready to use." if verdict.get("better") else " Kept the one in use.")


class Store:
    """The candidates and nights, in `folder`."""

    def __init__(self, folder: Path):
        self.folder = folder
        self.cands = folder / "candidates"

    def candidate_dir(self, cid: str) -> Path:
        if not cid or Path(cid).name != cid or cid.startswith("."):
            raise ValueError("bad candidate id")
        return self.cands / cid

    def save_model(self, cid: str, body: bytes) -> Path:
        d = self.candidate_dir(cid)
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / "model.tmp"
        tmp.write_bytes(body)
        tmp.replace(d / "model.onnx")
        return d / "model.onnx"

    def save_report(self, cid: str, report: dict) -> dict:
        d = self.candidate_dir(cid)
        d.mkdir(parents=True, exist_ok=True)
        report = {**report, "id": cid}
        if report.get("status") not in STATUSES:
            raise ValueError("bad status")
        if report.get("status") in ("better", "not better"):
            self.note_scored((report.get("train") or {}).get("labelsSig"))
        path = d / "report.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(report, separators=(",", ":")), encoding="utf-8")
        tmp.replace(path)
        return report

    def reports(self) -> list[dict]:
        out = []
        if self.cands.is_dir():
            for d in self.cands.iterdir():
                try:
                    out.append(json.loads((d / "report.json").read_text(encoding="utf-8")))
                except (OSError, ValueError):
                    pass
        return sorted(out, key=lambda r: r.get("made", ""), reverse=True)

    def new_club_frames(self, frames: set[str], sig: str) -> int | None:
        """How many of `frames` (club_frames) the last scored try didn't have; None before any try.
        Keeps `frames` as pending under `sig` (labelsSig), to become "the last try's" when a candidate
        trained on it is reported (note_scored)."""
        self.folder.mkdir(parents=True, exist_ok=True)
        last = self.folder / "club-frames.json"
        if not last.is_file() and any(r.get("status") != "failed" for r in self.reports()):
            # Tried before this was kept (the first runs): count from now.
            tmp = last.with_suffix(".tmp")
            tmp.write_text(json.dumps(sorted(frames)), encoding="utf-8")
            tmp.replace(last)
        sig_file = self.folder / f"club-frames-{sig}.json"
        tmp_sig = sig_file.with_suffix(".tmp")
        tmp_sig.write_text(json.dumps(sorted(frames)), encoding="utf-8")
        tmp_sig.replace(sig_file)
        if not last.is_file():
            return None
        return len(frames - set(json.loads(last.read_text(encoding="utf-8"))))

    def progress(self, frames: set[str], sig: str) -> dict:
        """How far toward the next club model: {newFrames, need}."""
        return {"newFrames": self.new_club_frames(frames, sig), "need": MIN_NEW_FRAMES}

    def note_scored(self, sig: str | None) -> None:
        """A candidate trained on `sig`'s club frames was scored: those are the last try's now."""
        pending = self.folder / f"club-frames-{sig}.json"
        if sig and pending.is_file():
            pending.replace(self.folder / "club-frames.json")
        for f in self.folder.glob("club-frames-*.json"):
            f.unlink()

    def tried(self, sig: str) -> bool:
        """Whether a candidate was already trained and scored on these labels. A failed try doesn't
        count: the next night tries again (after a fix, say)."""
        return any((r.get("train") or {}).get("labelsSig") == sig and r.get("status") != "failed"
                   for r in self.reports())

    def listing(self, in_use: str | None) -> list[dict]:
        """The reports, the one whose model is in use marked so."""
        out = []
        for r in self.reports():
            if same_model(r.get("model"), in_use):
                r = {**r, "status": "in use"}
            elif r.get("status") == "in use":
                r = {**r, "status": "used before"}
            out.append(r)
        return out

    def use(self, cid: str, target: Path, in_use: str | None, trash: Path, stamp_of) -> dict:
        """Makes candidate `cid`'s model the one at `target` (the deep pass's club model). The model
        there now is kept as a "used before" candidate (and in the trash), so going back is the same
        tap. `stamp_of(path)` = models.club_stamp."""
        d = self.candidate_dir(cid)
        report = json.loads((d / "report.json").read_text(encoding="utf-8"))
        if report.get("status") not in ("better", "used before", "in use"):
            raise ValueError(f"candidate is {report.get('status')}")
        model = d / "model.onnx"
        if not model.is_file():
            raise ValueError("candidate has no model")
        now = datetime.now()
        if target.is_file():
            old = stamp_of(target)
            if not any(same_model(r.get("model"), old) for r in self.reports()):
                pid = f"previous-{now:%Y-%m-%d-%H%M%S}"
                self.candidate_dir(pid).mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, self.candidate_dir(pid) / "model.onnx")
                self.save_report(pid, {"kind": report.get("kind", "club"), "made": now.isoformat(timespec="seconds"),
                                       "status": "used before", "model": old,
                                       "summary": f"The club model in use before {cid}.",
                                       "verdict": {"better": None, "why": ""}, "train": None, "scores": None})
            trash.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, trash / f"{target.stem}-{now:%Y%m%d_%H%M%S}{target.suffix}")
        tmp = target.with_suffix(".tmp")
        shutil.copyfile(model, tmp)  # a new mtime: "in use since" and the workers' reload (models.load_club)
        tmp.replace(target)
        report["status"] = "in use"
        report["used"] = now.isoformat(timespec="seconds")
        self.save_report(cid, report)
        return report

    def nights(self) -> list[dict]:
        try:
            return json.loads((self.folder / "nights.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []

    def note_night(self, entry: dict) -> list[dict]:
        """Adds or updates a night (keyed by worker and start time), newest first."""
        if not entry.get("started"):
            raise ValueError("started is needed")
        entry = {k: entry.get(k) for k in ("started", "ended", "worker", "clips", "improve")}
        entry["date"] = entry["started"][:10]
        nights = [n for n in self.nights() if (n.get("worker"), n.get("started")) != (entry["worker"], entry["started"])]
        nights = sorted([entry, *nights], key=lambda n: n.get("started", ""), reverse=True)[:NIGHTS_KEPT]
        self.folder.mkdir(parents=True, exist_ok=True)
        tmp = self.folder / "nights.tmp"
        tmp.write_text(json.dumps(nights, separators=(",", ":")), encoding="utf-8")
        tmp.replace(self.folder / "nights.json")
        return nights


def new_id(kind: str = "club", now: float | None = None) -> str:
    return f"{kind}-{datetime.fromtimestamp(now or time.time()):%Y-%m-%d-%H%M}"
