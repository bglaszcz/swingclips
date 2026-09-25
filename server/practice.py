"""Practice mode: one number and a target range; after each swing the phone says the number and
whether it was in range ("Tempo 3.2, in range", "Club path minus 4, too far left").

The review page sets the target (practice.json). A worker in app.py calls Practice.step about once a
second with the recent swings; once a swing's number is known (its body numbers worked out, or its
Square shot paired, ~14 s after the strike) the sentence is made here, kept in practice-log.jsonl, and
handed to the phone that speaks it (GET /api/practice/latest, long-polled).

Only numbers that can be trusted are spoken: a number from a camera the camera check flags ("out",
"hands"), a P6 number where P6 was only estimated, or a missing number is "no reading" instead.
"""
import json
import math
import threading
import time
from datetime import datetime
from pathlib import Path

# Square numbers: a swing with no shot this long after the strike is spoken without one. Square's
# app reports ~14 s after the strike, and a shot pairs within 5 s of that (app.py SHOT_SLACK_S).
SHOT_GIVE_UP_S = 25.0
# Body numbers: a swing whose numbers haven't been worked out by then (pose stuck, or failed on a
# clip the list doesn't show as failed yet) gets "no reading". Pose waits 15 s for the upload to
# settle and then takes some seconds per clip.
BODY_GIVE_UP_S = 240.0
# A down-the-line number worked out before the down-the-line clip arrived is waited on this long
# for the record that has it.
DTL_WAIT_S = 90.0
# Swings older than this when first seen (the server was off) are skipped, not spoken late.
STALE_S = 300.0
# The phone doesn't speak results older than this (e.g. after a Wi-Fi drop): it's the next swing by then.
SPEAK_WITHIN_S = 45.0
# Two clips of one swing are at most this far apart (app.py PAIR_SLACK_S): one result per swing.
PAIR_SLACK_S = 2.0
# Swings in one session (as the review page groups them): a longer gap ends a streak.
SESSION_GAP_S = 45 * 60
STREAK_FROM = 3
# Camera check codes that make that camera's body numbers unreliable (as the trends leave them out).
BAD_CAMERA = ("out", "hands")


def _m(key, label, say, unit, kind, view, dec, low, high, noisy=None, pos=None):
    return {"key": key, "label": label, "say": say, "unit": unit, "kind": kind, "view": view, "dec": dec,
            "low": low, "high": high, "noisy": noisy, "pos": pos}


# What can be practiced. Keys are summary.js's (BODY for body numbers, SHOT for Square's). `low` / `high`
# are said when the number is under / over the range. Signs follow summary.js: sway + = toward the
# target, "to ball" + = toward it, hands to plane + = above it; Square: left is -.
# Face-on turns (shoulder, pelvis, X-factor) are left out: from one camera they come from how narrow
# the body looks, which isn't reliable enough to practice against one swing at a time.
METRICS = [
    _m("tempo", "Tempo (backswing : downswing)", "Tempo", ":1", "body", "face", 1, "too low", "too high"),
    _m("backswing", "Backswing time", "Backswing", "s", "body", "face", 2, "too quick", "too slow"),
    _m("downswing", "Downswing time", "Downswing", "s", "body", "face", 2, "too quick", "too slow"),
    _m("headSway", "Head sway at impact", "Head sway", "in", "body", "face", 1, "too far back", "too far forward"),
    _m("hipSway", "Hip sway at impact", "Hip sway", "in", "body", "face", 1, "too far back", "too far forward"),
    _m("headRise", "Head rise at impact", "Head rise", "in", "body", "face", 1, "too far down", "too far up",
       noisy="small up-and-down moves are near the tracking noise"),
    _m("spineTiltImpact", "Spine tilt at impact", "Spine tilt", "°", "body", "face", 0, "too little tilt", "too much tilt"),
    _m("earlyExt", "Early extension (hips to ball at impact)", "Early extension", "in", "body", "dtl", 1,
       "too far back", "too far toward the ball"),
    _m("bendLoss", "Bend vs address at impact", "Bend change", "°", "body", "dtl", 0, "lost too much bend", "too much bend"),
    _m("headToBall", "Head to ball at impact", "Head to ball", "in", "body", "dtl", 1, "too far back", "too far toward the ball"),
    _m("handsPlaneP6", "Hands to plane at P6", "Hands at P6", "in", "body", "dtl", 1, "too far under", "too far over",
       noisy="needs the shaft seen at address, and P6 is often estimated", pos="p6"),
    _m("shaftPlaneP6", "Shaft to plane at P6", "Shaft at P6", "°", "body", "dtl", 0, "too shallow", "too steep",
       noisy="the shaft is often a blur at P6", pos="p6"),
    _m("handsPlaneTop", "Hands to plane at top", "Hands at the top", "in", "body", "dtl", 1, "too far under", "too far over",
       noisy="needs the shaft seen at address"),
    _m("handHeightTop", "Hand height at top", "Hand height", "in", "body", "dtl", 1, "too low", "too high"),
    _m("handDepthTop", "Hand depth at top", "Hand depth", "in", "body", "dtl", 1, "too far out", "too deep"),
    _m("path", "Club path", "Club path", "°", "shot", None, 1, "too far left", "too far right"),
    _m("faceToPath", "Face to path", "Face to path", "°", "shot", None, 1, "too closed", "too open"),
    _m("face", "Face to target", "Face", "°", "shot", None, 1, "too closed", "too open"),
    _m("attack", "Attack angle", "Attack angle", "°", "shot", None, 1, "too steep", "too shallow"),
    _m("carry", "Carry", "Carry", "yd", "shot", None, 0, "too short", "too long"),
    _m("offline", "Offline", "Offline", "yd", "shot", None, 0, "too far left", "too far right"),
    _m("smash", "Smash", "Smash", "", "shot", None, 2, "too low", "too high"),
    _m("clubSpeed", "Club speed", "Club speed", "mph", "shot", None, 0, "too slow", "too fast"),
    _m("ballSpeed", "Ball speed", "Ball speed", "mph", "shot", None, 0, "too slow", "too fast"),
    _m("launch", "Launch", "Launch", "°", "shot", None, 1, "too low", "too high"),
]
BY_KEY = {m["key"]: m for m in METRICS}

# Square's numbers from a shot, as summary.js SHOT reads them.
SHOT_GET = {
    "path": lambda s: s["clubData"]["path"],
    "faceToPath": lambda s: s["clubData"]["faceToTarget"] - s["clubData"]["path"],
    "face": lambda s: s["clubData"]["faceToTarget"],
    "attack": lambda s: s["clubData"]["angleOfAttack"],
    "carry": lambda s: s["ball"]["carry"],
    "offline": lambda s: s["ball"]["side"],
    "smash": lambda s: s["clubData"]["smash"],
    "clubSpeed": lambda s: s["clubData"]["speed"],
    "ballSpeed": lambda s: s["ball"]["speed"],
    "launch": lambda s: s["ball"]["vla"],
}


def _finite(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


def reading(metric: dict, record: dict | None, shot: dict | None) -> tuple[float | None, str | None]:
    """A swing's number for the metric, or (None, why not)."""
    if metric["kind"] == "shot":
        if not shot:
            return None, "no shot"
        try:
            v = _finite(SHOT_GET[metric["key"]](shot))
        except (KeyError, TypeError):
            v = None
        return (v, None) if v is not None else (None, "not in the shot")
    if not record or record.get("error") or not record.get("body"):
        return None, "not measured"
    quality = record.get("quality") or {}
    codes = (quality.get("camera") or {}).get(metric["view"]) or []
    bad = [c for c in codes if c in BAD_CAMERA]
    if bad:
        return None, "camera check: " + ", ".join(bad)
    if metric["pos"] == "p6" and quality.get("p6Estimated"):
        return None, "P6 estimated"
    v = _finite(record["body"].get(metric["key"]))
    return (v, None) if v is not None else (None, "not measured")


def rounded(metric: dict, value: float) -> float:
    return round(value, metric["dec"])


def spoken_number(metric: dict, value: float) -> str:
    """-4.2 -> "minus 4.2", 3.0 -> "3" (a whole number isn't read as "3 point 0")."""
    v = rounded(metric, value)
    text = f"{abs(v):.{metric['dec']}f}"
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    if text == "0":
        return "0"
    return ("minus " if v < 0 else "") + text


def judge(metric: dict, value: float | None, lo: float, hi: float) -> str:
    """"in", "low", "high", or "none". The number as spoken is what's compared, so what's heard adds up."""
    if value is None:
        return "none"
    v = rounded(metric, value)
    return "low" if v < lo else "high" if v > hi else "in"


def sentence(metric: dict, value: float | None, status: str, streak: int = 0, why: str | None = None) -> str:
    name = metric["say"]
    if status == "none":
        return f"{name}, no shot" if why == "no shot" else f"{name}, no reading"
    number = spoken_number(metric, value)
    if status == "in":
        return f"{name} {number}, in range" + (f", {streak} in a row" if streak >= STREAK_FROM else "")
    return f"{name} {number}, {metric['low' if status == 'low' else 'high']}"


def fmt_range(metric: dict, lo: float, hi: float) -> str:
    d = metric["dec"]
    return f"{lo:.{d}f} to {hi:.{d}f}"


def default_config() -> dict:
    # speaking comes from the phones' own setting; `since`: only swings struck after this speak.
    return {"on": False, "metric": "tempo", "min": 2.8, "max": 3.4, "club": None, "streak": True, "since": 0.0}


def check_config(c: dict) -> dict:
    """A config from the review page, cleaned up; ValueError when it doesn't make sense."""
    out = default_config()
    if c.get("metric") not in BY_KEY:
        raise ValueError("Unknown number")
    lo, hi = _finite(c.get("min")), _finite(c.get("max"))
    if lo is None or hi is None:
        raise ValueError("The range needs a low and a high number")
    if lo > hi:
        raise ValueError("The low end is above the high end")
    club = c.get("club")
    out.update(on=bool(c.get("on")), metric=c["metric"], min=float(lo), max=float(hi),
               club=club if isinstance(club, str) and len(club) <= 4 else None, streak=bool(c.get("streak", True)))
    return out


class Practice:
    """The target, the results so far, and the log. Thread-safe; step() runs on the worker."""

    def __init__(self, config_file: Path, log_file: Path, clock=time.time):
        self.config_file, self.log_file, self.clock = config_file, log_file, clock
        self.lock = threading.Lock()
        self.config = default_config()
        try:
            self.config.update(json.loads(config_file.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            pass
        self.log: list[dict] = []
        try:
            for line in log_file.read_text(encoding="utf-8").splitlines():
                try:
                    self.log.append(json.loads(line))
                except ValueError:
                    continue
        except OSError:
            pass
        self.tests: list[dict] = []            # voice checks from the review page: spoken, not logged
        self.listeners: dict[str, float] = {}  # phone angle -> when it last asked for results
        self.last_id = max([e["id"] for e in self.log] + [0])

    # ---- Target ----

    def set_config(self, c: dict) -> dict:
        new = check_config(c)
        with self.lock:
            old = self.config
            same_target = old["on"] and all(old[k] == new[k] for k in ("metric", "min", "max"))
            # Turning on, or a new target: only swings from now on speak (not the ones before).
            new["since"] = old["since"] if same_target else self.clock()
            self.config = new
            self.config_file.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.config_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(new, indent=1), encoding="utf-8")
            tmp.replace(self.config_file)
            return dict(new)

    def _next_id(self) -> int:
        # Milliseconds, and always going up: ids stay unique across server restarts, so a phone
        # still asking "since" an id from before a restart gets the new results.
        self.last_id = max(self.last_id + 1, int(self.clock() * 1000))
        return self.last_id

    # ---- Results ----

    def step(self, swings: list[dict], records: dict[str, dict]) -> list[dict]:
        """Makes the result of each swing whose number is ready. `swings`: the listed swings (as
        /api/clips lists them, the face-on clip or a lone one) with "t" (strike, unix s), "shot",
        "pose" and "partnerPose"; `records`: their current body-number records by clip name.
        Returns the new results."""
        with self.lock:
            c = self.config
            if not c["on"]:
                return []
            metric = BY_KEY[c["metric"]]
            now = self.clock()
            done_names = {e["clip"] for e in self.log}
            done_times = [e["t"] for e in self.log if e["t"] >= c["since"] - PAIR_SLACK_S]
            new = []
            for s in sorted(swings, key=lambda s: s["t"]):
                t, age = s["t"], now - s["t"]
                if t < c["since"] or s["name"] in done_names or age > STALE_S:
                    continue
                if any(abs(t - d) <= PAIR_SLACK_S for d in done_times):
                    continue  # the other clip of a swing that's had its say
                rec = records.get(s["name"])
                if metric["kind"] == "shot":
                    if not s.get("shot") and age < SHOT_GIVE_UP_S:
                        continue
                    value, why = reading(metric, None, s.get("shot"))
                else:
                    failed = s.get("pose") == "failed"
                    if rec is None and not failed and age < BODY_GIVE_UP_S:
                        continue
                    if (rec is not None and metric["view"] == "dtl" and not rec.get("partner")
                            and s.get("angle") != "dtl" and age < DTL_WAIT_S):
                        continue  # worked out before the down-the-line clip arrived
                    value, why = reading(metric, rec, None)
                status = judge(metric, value, c["min"], c["max"])
                streak = self._streak(metric, c, t) + 1 if status == "in" else 0
                e = {"id": self._next_id(), "clip": s["name"], "t": t,
                     "strike": datetime.fromtimestamp(t).isoformat(timespec="seconds"),
                     "made": now, "metric": metric["key"], "min": c["min"], "max": c["max"],
                     "value": None if value is None else rounded(metric, value), "status": status,
                     "why": why, "streak": streak, "club": (s.get("shot") or {}).get("club"),
                     "text": sentence(metric, value, status, streak if c["streak"] else 0, why)}
                self.log.append(e)
                done_names.add(s["name"])
                done_times.append(t)
                new.append(e)
            if new:
                self.log_file.parent.mkdir(parents=True, exist_ok=True)
                with open(self.log_file, "a", encoding="utf-8") as f:
                    for e in new:
                        f.write(json.dumps(e, separators=(",", ":")) + "\n")
            return new

    def _streak(self, metric: dict, c: dict, t: float) -> int:
        """In range in a row before a swing at t: same target, same session; no readings don't count."""
        n, after = 0, t
        for e in reversed(self.log):
            if e["metric"] != metric["key"] or e["min"] != c["min"] or e["max"] != c["max"]:
                break
            if after - e["t"] > SESSION_GAP_S:
                break
            after = e["t"]
            if e["status"] == "none":
                continue
            if e["status"] != "in":
                break
            n += 1
        return n

    def voice_check(self) -> dict:
        """A sentence for the speaking phone to say, to check it's listening and loud enough."""
        with self.lock:
            e = {"id": self._next_id(), "made": self.clock(), "test": True,
                 "text": "Practice voice check. " + ("Practice is on." if self.config["on"] else "Practice is off.")}
            self.tests = [x for x in self.tests if self.clock() - x["made"] < SPEAK_WITHIN_S] + [e]
            return e

    def latest(self, since: int | None, angle: str | None = None) -> dict:
        """For the speaking phone: results after id `since`. Without `since`, just where things are,
        so a phone that starts listening doesn't read out old swings."""
        with self.lock:
            now = self.clock()
            if angle:
                self.listeners[angle] = now
            out = {"on": self.config["on"], "last": self.last_id, "results": []}
            if since is None:
                return out
            # A voice check is spoken even with practice off; results only while it's on.
            fresh = [e for e in self.tests + (self.log[-50:] if self.config["on"] else [])
                     if e["id"] > since and now - e["made"] <= SPEAK_WITHIN_S]
            out["results"] = [{"id": e["id"], "text": e["text"], "age": round(now - e["made"], 1),
                               "status": e.get("status"), "clip": e.get("clip")}
                              for e in sorted(fresh, key=lambda e: e["id"])]
            return out

    def state(self, log_limit: int = 2000) -> dict:
        """For the review page: the target, what can be practiced, the log, and who's listening."""
        with self.lock:
            now = self.clock()
            return {"config": dict(self.config), "metrics": METRICS, "log": self.log[-log_limit:],
                    "listeners": {a: round(now - t, 1) for a, t in self.listeners.items()},
                    "timing": {"shotGiveUp": SHOT_GIVE_UP_S, "bodyGiveUp": BODY_GIVE_UP_S}}
