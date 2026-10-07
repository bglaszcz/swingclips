"""Coach programs: a ladder of drill blocks, each with a gate to pass ("7 of 10 with attack -2 or
steeper and strike no higher than +3 mm"), as a coach writes them. The programs are data
(programs.json), so a new plan from the coach is a new entry there, not new code.

A block is either no-ball reps the golfer judges and taps on the Start page (pass / miss), or ball
shots judged on Square's numbers once the shot pairs with the swing (as games.py waits for them),
plus, where the block asks, the golfer's tap on what they saw (the flush-line mark). The phone says
each shot's verdict and the gate's count, through the practice feed like a game. A block ends once
its reps are in (or its streak is made); the next starts (skipped when the block it requires wasn't
passed). The program ends after its last block or at its cap: every swing counts toward the cap,
tapped reps, shots, and swings whose shot never came.

Shots Square didn't read are left out of the gate (neither pass nor miss): club speed 0, or the
strike's across-the-face reading exactly 0.0 (Square's failed impact read, whose up-down reading is
filler: 15.9, 20.0, or 0.0, which would pass a strike gate). A strike gate's floor (strikeV min -8 in
programs.json) keeps a fat strike, low on the face, from passing as "not high"; adjust it once real
numbers are in.

Drill blocks switch drill mode on (drills.py), so their swings stay out of the trends; their Square
numbers stay here for the gate and the report for the coach (report()).

Square's strike height can shift as a whole (about -14 mm on every club between Sep 16 and Sep 23 2026,
and on Aug 21 alone), so a program may set a "calibration": the median of the session's first readable
shots with that club must sit near the usual value, or the strike checks are dropped for the session
("calibration shifted") while attack and loft still gate. The band is wide (+-8 mm on 10 shots): the owner's
7 iron strikes scatter ~8 mm (SD), so a 10-shot median wanders +-6 mm by chance; +-4 dropped the strike
checks wrongly in ~1 session in 7 (Oct 6: -21 on a day within chance), +-8 in ~1 in 100, and the real
shift was ~14 mm. The golfer's setup notes (Omni moved, mat
changed, an update) go with the run into the report, so a jump like that can be traced.
"""
import json
import math
import statistics
import threading
import time
from datetime import datetime
from pathlib import Path

import swings

PROGRAMS_FILE = Path(__file__).parent / "programs.json"
# A swing with no shot this long after the strike never gets one (games.py SHOT_GIVE_UP_S).
SHOT_GIVE_UP_S = 25.0
# A swing with no 3D this long after the strike never gets one. Long: during a session the face-on
# phone keeps up but the down-the-line one can fall several swings behind and catch up between sets
# (docs/performance.md), and a rep left out because the server is behind is worse than a late verdict.
BODY3D_GIVE_UP_S = 300.0
# Two clips of one swing are at most this far apart (app.py PAIR_SLACK_S).
PAIR_SLACK_S = 2.0
# The phone doesn't speak sentences older than this (practice.py SPEAK_WITHIN_S).
SPEAK_WITHIN_S = 45.0
# A block that asks for the golfer's mark waits this long after its last shot for the tap.
MARK_WAIT_S = 10.0
# A program with nothing done for this long is ended and saved as it stands.
IDLE_END_S = 45 * 60
# The report splits each block's shots here: the first ones (cold?) and the rest.
SPLIT_AT = 10

BODY3D_KEYS = {"pelvisPeakMs", "armPeakMs", "pelvisOpen", "pelvisStartMs", "armAfterPelvis"}
# The face-on camera's numbers a gate can check (the swing record's "body", summary.js). They're in
# by the time the swing's 3D is, so a block checking them waits the way a 3D block does.
CAMERA_KEYS = {"pelvisBall", "chestBall", "handsAhead"}


def _finite(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


# The numbers a gate can check: label, unit, decimals, how the phone says them.
NUMBERS = {
    "attack": ("Attack angle", "°", 1),
    "loft": ("Dynamic loft", "°", 1),
    "faceToPath": ("Face to path", "°", 1),
    "strikeV": ("Strike height", " mm", 0),
    "strikeH": ("Strike toe/heel", " mm", 0),
    "clubSpeed": ("Club speed", " mph", 0),
    "carry": ("Carry", " yd", 0),
    "pelvisPeakMs": ("Pelvis peak vs impact", " ms", 0),
    "armPeakMs": ("Arm peak vs impact", " ms", 0),
    "pelvisOpen": ("Pelvis open at impact", "°", 0),
    "pelvisStartMs": ("Pelvis turn start vs top", " ms", 0),
    "armAfterPelvis": ("Arm peak after pelvis", "", 0),
    "pelvisBall": ("Pelvis vs ball at impact", " in", 1),
    "chestBall": ("Chest vs ball at impact", " in", 1),
    "handsAhead": ("Hands ahead of ball at impact", " in", 1),
    # Reported, for where the ball went (the coach's ask, Oct 6).
    "path": ("Club path", "°", 1),
    "face": ("Face to target", "°", 1),
    "startDir": ("Start direction", "°", 1),
    "ballSpeed": ("Ball speed", " mph", 1),
    "smash": ("Smash", "", 2),
}


def body3d_numbers(body3d: dict | None) -> dict:
    """Extracts 3D kinematic numbers for gates and reports from summarize3d() output."""
    if not body3d:
        return {"pelvisPeakMs": None, "armPeakMs": None, "pelvisOpen": None,
                "pelvisStartMs": None, "armAfterPelvis": None}
    nums = body3d.get("numbers") or {}
    seq = body3d.get("sequence") or {}
    segs = seq.get("segments") or []
    pelvis_seg = next((s for s in segs if s.get("key") == "pelvis"), None)
    arm_seg = next((s for s in segs if s.get("key") == "arm"), None)

    pelvis_peak = round(-pelvis_seg["beforeImpact"]) if pelvis_seg and pelvis_seg.get("beforeImpact") is not None else None
    arm_peak = round(-arm_seg["beforeImpact"]) if arm_seg and arm_seg.get("beforeImpact") is not None else None
    arm_after_pelvis = (arm_seg["t"] > pelvis_seg["t"]) if (pelvis_seg and arm_seg and pelvis_seg.get("t") is not None and arm_seg.get("t") is not None) else None

    return {
        "pelvisPeakMs": pelvis_peak,
        "armPeakMs": arm_peak,
        "pelvisOpen": _finite(nums.get("pelvisOpenImpact")),
        "pelvisStartMs": _finite(nums.get("pelvisStartMs")),
        "armAfterPelvis": arm_after_pelvis,
    }


def block_needs_3d(block: dict) -> bool:
    """Whether a block requires 3D kinematic numbers for its gate."""
    if not block.get("ball"):
        return False
    if block.get("needs3d"):
        return True
    gate = block.get("gate") or {}
    checks = gate.get("checks", []) + gate.get("medians", [])
    return any(c.get("key") in BODY3D_KEYS | CAMERA_KEYS for c in checks)


def camera_numbers(body: dict | None) -> dict:
    """The face-on camera's numbers a gate can check, from the swing record's "body"."""
    return {k: _finite((body or {}).get(k)) for k in CAMERA_KEYS}


def numbers_of(shot: dict | None, body3d: dict | None = None, body: dict | None = None) -> dict:
    """A Square shot's and 3D kinematics numbers for the gates and the report. Face to path is face
    minus path (face +0.7, path +4.6 -> -3.9: closed to the path, the draw/hook side)."""
    c = (shot or {}).get("clubData") or {}
    b = (shot or {}).get("ball") or {}
    face, path = _finite(c.get("faceToTarget")), _finite(c.get("path"))
    out = {
        "attack": _finite(c.get("angleOfAttack")), "loft": _finite(c.get("loft")),
        "faceToPath": round(face - path, 2) if face is not None and path is not None else None,
        "strikeV": _finite(c.get("faceImpactV")), "strikeH": _finite(c.get("faceImpactH")),
        "clubSpeed": _finite(c.get("speed")), "carry": _finite(b.get("carry")),
        "path": path, "face": face, "startDir": _finite(b.get("hla")), "ballSpeed": _finite(b.get("speed")),
        "smash": _finite(c.get("smash")),
    }
    out.update(body3d_numbers(body3d))
    out.update(camera_numbers(body))
    return out


def no_read(n: dict) -> str | None:
    """Why Square's shot can't be judged (None: it can)."""
    # Checked before any gate compares numbers, so a missing reading is never taken as 0.
    if n["clubSpeed"] is None or n["clubSpeed"] == 0:
        return "no club speed"
    # Square's app flags a failed impact read (IsValidImpact*: the watcher sends null); its CSV export
    # wrote 0.0 across the face with a filler height instead.
    if n["strikeH"] is None or n["strikeV"] is None or n["strikeH"] == 0.0:
        return "strike not read"
    return None


def check(n: dict, c: dict) -> bool | None:
    """One gate check ({key, min, max, equals}) on a shot's numbers; None when the number is missing."""
    v = n.get(c["key"])
    if v is None:
        return None
    if "equals" in c:
        return v == c["equals"]
    if isinstance(v, bool):
        if c.get("min") is True or c.get("min") == 1:
            return v is True
        if c.get("max") is False or c.get("max") == 0:
            return v is False
        return v == c.get("val", True)
    return (c.get("min") is None or v >= c["min"]) and (c.get("max") is None or v <= c["max"])


def load_programs(path: Path = PROGRAMS_FILE) -> dict:
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    return {p["id"]: p for p in doc["programs"]}


def say_number(key: str, v) -> str:
    # Square's strike height is said as the number it gives: its 0 isn't the owner's sweet spot
    # (7 iron median about -13, best carry -20..-8), so "high" and "low" would mislead.
    if isinstance(v, bool):
        return "arm after pelvis" if v else "arm before pelvis"
    dec = NUMBERS[key][2]
    s = f"{abs(v):.{dec}f}".rstrip("0").rstrip(".") if dec else f"{abs(round(v))}"
    sign = "minus " if v < 0 and s != "0" else "plus " if v > 0 and key in ("attack", "faceToPath", "strikeV") and s != "0" else ""
    if key == "pelvisPeakMs":
        name = "pelvis peak"
    elif key == "armPeakMs":
        name = "arm peak"
    elif key == "pelvisOpen":
        name = "pelvis open"
    elif key == "pelvisStartMs":
        name = "pelvis turn start"
    elif key == "strikeV":
        name = "strike"
    else:
        name = NUMBERS[key][0].lower()
    return f"{name} {sign}{s}"


# Which way past a check's max / min reads, in words: (past max, past min).
LIMIT_WORDS = {
    "attack": ("or steeper", "or shallower"),
    "strikeV": ("or lower", "or higher"),
    "pelvisPeakMs": ("or earlier", "or later"),
    "pelvisOpen": ("or less", "or more"),
}


def say_limit(c: dict, v) -> str:
    """What a failed check (value v) wanted, in words for the phone."""
    key, lo, hi = c["key"], c.get("min"), c.get("max")
    if key == "armAfterPelvis":
        return "arm peak after pelvis"
    if lo is not None and hi is not None and lo == -hi:
        return f"{NUMBERS[key][0].lower()} within {hi:g}"
    down, up = LIMIT_WORDS.get(key, ("or less", "or more"))
    if hi is not None and (v is None or v > hi):
        return f"{say_number(key, hi)} {down}"
    return f"{say_number(key, lo)} {up}"


# What a missed check was, in a few words for the phone (the number is on the screen): (too high, too low).
CUES = {
    "attack": ("attack too shallow", "attack too steep"),
    "strikeV": ("strike high on the face", "strike low on the face"),
    "faceToPath": ("face open to path", "face closed to path"),
    "loft": ("too much loft", "too little loft"),
    "clubSpeed": ("too fast", "too slow"),
    "carry": ("long", "short"),
    "pelvisPeakMs": ("pelvis peaks late", "pelvis peaks early"),
    "pelvisOpen": ("pelvis too open", "pelvis not open enough"),
    "pelvisStartMs": ("pelvis starts late", "pelvis starts early"),
    "pelvisBall": ("pelvis too far ahead", "pelvis not ahead enough"),
}


def cue(c: dict, v) -> str:
    """A failed check (value v) as a short cue: which way it missed, no numbers."""
    key, hi = c["key"], c.get("max")
    if key == "armAfterPelvis":
        return "arms before pelvis"
    up, down = CUES.get(key, (f"{NUMBERS[key][0].lower()} too high", f"{NUMBERS[key][0].lower()} too low"))
    return up if hi is not None and (v is None or v > hi) else down


def medians_of(block: dict, js: list[dict]) -> dict:
    """The median of each number a block's median gate checks, over its judged shots."""
    out = {}
    for c in block["gate"].get("medians", []):
        v = sorted(r["numbers"][c["key"]] for r in js if r.get("numbers") and r["numbers"].get(c["key"]) is not None)
        out[c["key"]] = statistics.median(v) if v else None
    return out


# ---- Judging a block (pure: used live and again for the report) ----

def judged(block: dict, reps: list[dict], marks: list[dict]) -> list[dict]:
    """The block's reps in order, each with "gate": True / False / None (not judged: not a gate rep,
    or a shot Square didn't read), "mark": the golfer's tap for that shot (True/False/None), and
    "fails": the checks it missed."""
    mine = sorted((r for r in reps if r["block"] == block["id"]), key=lambda r: r["t"])
    my_marks = sorted((m for m in marks if m["block"] == block["id"]), key=lambda m: m["t"])
    swings_t = [r["t"] for r in mine if r["kind"] != "tap"]
    out = []
    for r in mine:
        r = dict(r, gate=None, mark=None, fails=[])
        if r["kind"] == "tap":
            if not block["ball"]:
                r["gate"] = bool(r["pass"])
        elif r["kind"] == "shot" and block["ball"]:
            if not r.get("waiting3d"):
                if block["gate"].get("mark"):
                    # The golfer's tap for this swing: the first one from its strike to the next swing.
                    later = [t for t in swings_t if t > r["t"] + PAIR_SLACK_S]
                    until = later[0] if later else math.inf
                    m = next((m for m in my_marks if r["t"] - PAIR_SLACK_S <= m["t"] < until), None)
                    r["mark"] = m["ok"] if m else None
                if not r.get("noRead"):
                    results = [(c, check(r["numbers"], c)) for c in block["gate"].get("checks", [])]
                    r["fails"] = [c for c, ok in results if ok is False]
                    if all(ok is not None for _, ok in results):
                        r["gate"] = not r["fails"] and r["mark"] is not False
        out.append(r)
    return out


def block_state(block: dict, reps: list[dict], marks: list[dict]) -> dict:
    """{reps (gate reps so far), passes, streak, best (streak), passed, done} for a block."""
    js = [r for r in judged(block, reps, marks) if r["gate"] is not None]
    gate = block["gate"]
    passes = sum(r["gate"] for r in js)
    streak = best = 0
    for r in js:
        streak = streak + 1 if r["gate"] else 0
        best = max(best, streak)
    # A gate on the block's medians too ("median attack -3 or steeper"): checked over the shots judged.
    meds = medians_of(block, js)
    meds_ok = all(check(meds, c) for c in gate.get("medians", []))
    if gate["kind"] == "streak":
        passed = best >= gate["need"] and meds_ok
        done = passed or len(js) >= block["reps"]
    else:
        passed = passes >= gate["need"] and meds_ok
        done = len(js) >= block["reps"]
    return {"reps": len(js), "passes": passes, "streak": streak, "best": best, "passed": passed, "done": done,
            **({"medians": meds} if meds else {})}


def gate_text(block: dict) -> str:
    g = block["gate"]
    what = "in a row" if g["kind"] == "streak" else f"of {block['reps']}"
    meds = [f"median {NUMBERS[c['key']][0].lower()} " + (f"{c['max']:g} or {LIMIT_WORDS.get(c['key'], ('or less',))[0].split()[-1]}"
            if c.get("max") is not None else f"{c['min']:g} or more") for c in g.get("medians", [])]
    return f"{g['need']} {what}" + "".join(f", {m}" for m in meds)


def progress_text(block: dict, st: dict) -> str:
    g = block["gate"]
    meds = "".join(f", median {NUMBERS[k][0].lower()} {fmt(k, v)}" for k, v in (st.get("medians") or {}).items() if v is not None)
    if g["kind"] == "streak":
        return f"{st['streak']} in a row" + (f", best {st['best']}" if st["best"] > st["streak"] else "") + meds
    return f"{st['passes']} of {st['reps']} passed, {g['need']} needed{meds}"


def calibration(p: dict, run: dict) -> dict | None:
    """The session's check of Square's strike frame (programs.json "calibration": key, club, center,
    within, shots): {median, n, shots, shifted (None until enough shots)}, or None without one."""
    c = p.get("calibration")
    if not c:
        return None
    # Decided once enough shots were in (_calibration_check stores it): kept as decided, so widening the
    # band later (Oct 6: -13 +-4 -> -14 +-8) doesn't re-judge finished runs.
    if (run.get("calibration") or {}).get("shifted") is not None:
        return run["calibration"]
    vals = [r["numbers"][c["key"]] for r in sorted(run["reps"], key=lambda r: r["t"])
            if r["kind"] in ("shot", "ball") and r.get("club") == c["club"] and not r.get("noRead")
            and r["numbers"].get(c["key"]) is not None][:c["shots"]]
    med = statistics.median(vals) if vals else None
    shifted = None if len(vals) < c["shots"] else abs(med - c["center"]) > c["within"]
    return {"key": c["key"], "median": med, "n": len(vals), "shots": c["shots"], "center": c["center"],
            "within": c["within"], "shifted": shifted}


def effective(p: dict, run: dict) -> dict:
    """The program as it gates this run: without its calibrated checks once the session's calibration shifted."""
    cal = calibration(p, run)
    if not cal or not cal["shifted"]:
        return p
    drop = lambda g: {**g, "checks": [c for c in g.get("checks", []) if c["key"] != cal["key"]]}
    return {**p, "blocks": [{**b, "gate": drop(b["gate"])} if b.get("gate") else b for b in p["blocks"]]}


def judged_blocks(p: dict, run: dict) -> list[dict]:
    """Each block of a run (in play or finished) with its gate state, result and judged reps."""
    p = effective(p, run)
    return [{**b, "state": block_state(b, run["reps"], run["marks"]), "result": run["results"].get(b["id"]),
             "judged": judged(b, run["reps"], run["marks"])} for b in p["blocks"]]


class Programs:
    """The program in play, finished programs, and what the phone should say. Thread-safe.
    `on_block(drill or None)` is called when a block starts or the program ends (drill mode)."""

    def __init__(self, state_file: Path, log_file: Path, new_id, clock=time.time, on_block=None,
                 programs_file: Path = PROGRAMS_FILE):
        self.state_file, self.log_file, self.new_id, self.clock = state_file, log_file, new_id, clock
        self.on_block = on_block or (lambda drill: None)
        self.programs = load_programs(programs_file)
        self.lock = threading.Lock()
        doc = swings.load(state_file)
        self.run: dict | None = doc if doc.get("id") in self.programs else None
        self.said: list[dict] = []

    def catalog(self) -> list[dict]:
        return list(self.programs.values())

    # ---- Starting, tapping, moving on ----

    def start(self, program_id: str) -> dict:
        if program_id not in self.programs:
            raise ValueError("Unknown program")
        p = self.programs[program_id]
        with self.lock:
            if self.run:
                self._finish("stopped")
            now = self.clock()
            self.run = {"id": p["id"], "name": p["name"], "started": now, "block": 0, "blockStarted": now,
                        "reps": [], "marks": [], "results": {}}
            self._say(f"{p['name']}. {self._block_intro(p['blocks'][0], 1)}")
            self._save()
            self.on_block(p["blocks"][0].get("drill"))
            return self._state()

    def stop(self) -> dict | None:
        with self.lock:
            if not self.run:
                return None
            done = self._finish("stopped")
            self._say(f"{done['name']} stopped. {done['spoken']}")
            return done

    def tap(self, ok: bool) -> dict:
        """The golfer's verdict: a no-ball rep (pass / miss), or on a ball block, the mark they saw
        for the last shot (at or ahead of the ball / behind)."""
        with self.lock:
            if not self.run:
                raise ValueError("No program in play")
            p, block = self._current()
            now = self.clock()
            if block["ball"]:
                if not block["gate"].get("mark"):
                    raise ValueError("This block is judged on Square's numbers")
                self.run["marks"].append({"t": now, "block": block["id"], "ok": bool(ok)})
            else:
                self.run["reps"].append({"t": now, "block": block["id"], "kind": "tap", "pass": bool(ok)})
            self._settle(p, now)
            self._save()
            return self._state()

    def tap_block(self, passes: int, misses: int) -> dict:
        """A no-ball block's reps at once, tapped after doing them all (one walk off the mat, not one
        per rep). The misses go first, so on a streak gate the passes count as the run in a row."""
        with self.lock:
            if not self.run:
                raise ValueError("No program in play")
            p, block = self._current()
            if block["ball"]:
                raise ValueError("This block is judged on Square's numbers")
            left = block["reps"] - block_state(block, self.run["reps"], self.run["marks"])["reps"]
            if passes < 0 or misses < 0 or passes + misses < 1 or passes + misses > left:
                raise ValueError(f"Between 1 and {left} reps")
            now = self.clock()
            for i, ok in enumerate([False] * misses + [True] * passes):
                self.run["reps"].append({"t": now + i * 0.001, "block": block["id"], "kind": "tap", "pass": ok})
            self._settle(p, now)
            self._save()
            return self._state()

    def undo(self) -> dict:
        """Takes back the golfer's last tap in the block in play."""
        with self.lock:
            if not self.run:
                raise ValueError("No program in play")
            _, block = self._current()
            key = "marks" if block["ball"] else "reps"
            items = self.run[key]
            for i in range(len(items) - 1, -1, -1):
                if items[i]["block"] == block["id"] and (key == "marks" or items[i]["kind"] == "tap"):
                    del items[i]
                    break
            self._save()
            return self._state()

    def note(self, text: str, started: float | None = None) -> dict:
        """The golfer's setup notes (Omni moved, mat changed, an update) on the run in play, or on the
        finished run started at `started` (the last one without it)."""
        text = (text or "").strip()[:1000]
        with self.lock:
            if self.run and started in (None, self.run["started"]):
                self.run["notes"] = text
                self._save()
                return {"started": self.run["started"], "notes": text}
            logged = self._log()
            i = next((i for i in range(len(logged) - 1, -1, -1) if started is None or logged[i]["started"] == started), None)
            if i is None:
                raise ValueError("No such run")
            logged[i]["notes"] = text
            tmp = self.log_file.with_suffix(".tmp")
            tmp.write_text("".join(json.dumps(x, separators=(",", ":")) + "\n" for x in logged), encoding="utf-8")
            tmp.replace(self.log_file)
            return {"started": logged[i]["started"], "notes": text}

    def wrist(self, started: float | None = None, clip: str = "", verdict: str | None = None) -> dict:
        """Saves the golfer's lead wrist call at impact ('flat', 'bowed', 'cupped', 'can't tell',
        or None to clear) on one shot of a finished run, or the run in play."""
        if isinstance(started, str) and not isinstance(clip, (int, float)):
            clip, verdict, started = started, clip, None
        if not clip:
            raise ValueError("No clip specified")
        if verdict is not None and verdict not in VALID_WRIST:
            raise ValueError(f"Invalid wrist verdict: {verdict!r}")
        with self.lock:
            if self.run and (started is None or self.run["started"] == started
                             or (isinstance(started, (int, float)) and abs(self.run["started"] - started) < 0.001)):
                wrist = self.run.setdefault("wrist", {})
                if verdict is None:
                    wrist.pop(clip, None)
                else:
                    wrist[clip] = verdict
                self._save()
                return {"started": self.run["started"], "wrist": wrist}
            logged = self._log()
            i = next((i for i in range(len(logged) - 1, -1, -1)
                      if started is None or logged[i]["started"] == started
                      or (isinstance(started, (int, float)) and abs(logged[i]["started"] - started) < 0.001)), None)
            if i is None:
                raise ValueError("No such run")
            wrist = logged[i].setdefault("wrist", {})
            if verdict is None:
                wrist.pop(clip, None)
            else:
                wrist[clip] = verdict
            tmp = self.log_file.with_suffix(".tmp")
            tmp.write_text("".join(json.dumps(x, separators=(",", ":")) + "\n" for x in logged), encoding="utf-8")
            tmp.replace(self.log_file)
            return {"started": logged[i]["started"], "wrist": wrist}

    def next_block(self) -> dict:
        """Ends the block in play as it stands and moves on."""
        with self.lock:
            if not self.run:
                raise ValueError("No program in play")
            p, block = self._current()
            st = block_state(block, self.run["reps"], self.run["marks"])
            self._end_block(p, block, st)
            self._save()
            return self._state()

    # ---- Swings ----

    def step(self, swings_now: list[dict]) -> list[dict]:
        """Adds each new swing of the program once its shot is in (or never came). `swings_now`:
        listed swings with "t" (strike, unix s), "name", "partner", "shot", "body3d", "why3d". Returns the reps made."""
        with self.lock:
            if not self.run:
                return []
            p, _ = self._current()
            now = self.clock()

            # Check existing reps that are waiting for 3D
            by_name = {s["name"]: s for s in swings_now}
            for r in self.run["reps"]:
                if not r.get("waiting3d"):
                    continue
                s = by_name.get(r.get("clip"))
                if not s:
                    s = next((s for s in swings_now if abs(s["t"] - r["t"]) <= PAIR_SLACK_S), None)
                if s and s.get("body3d"):
                    r["waiting3d"] = False
                    r["numbers"].update(body3d_numbers(s["body3d"]))
                    r["numbers"].update(camera_numbers(s.get("body")))
                    p, block = self._current()
                    if block["id"] == r["block"]:
                        self._say_shot(block, r["t"])
                        self._settle(p, now)
                elif s and s.get("why3d"):
                    r["waiting3d"] = False
                    r["noRead"] = s["why3d"]
                    self._say(f"Invalid read ({r['noRead']}): not counted.")
                    p, block = self._current()
                    self._settle(p, now)
                elif now - r["t"] >= BODY3D_GIVE_UP_S:
                    r["waiting3d"] = False
                    r["noRead"] = "no 3D"
                    self._say("Invalid read (no 3D): not counted.")
                    p, block = self._current()
                    self._settle(p, now)

            if not self.run:
                return []

            done_t = [r["t"] for r in self.run["reps"] if r["kind"] != "tap"] + self.run.setdefault("ignored", [])
            last = max(done_t + [self.run["started"] - PAIR_SLACK_S])
            block_was = self.run["block"]
            made = []
            for s in sorted(swings_now, key=lambda s: s["t"]):
                if not self.run:
                    break
                t = s["t"]
                if t <= last or any(abs(t - d) <= PAIR_SLACK_S for d in done_t):
                    continue
                if not s.get("shot") and now - t < SHOT_GIVE_UP_S:
                    break  # Square's shots come in order: wait for this one before later ones
                p, block = self._current()
                done_t.append(t)
                if not s.get("shot") and not block["ball"]:
                    # A no-ball rep the phones heard: the golfer's tap counts it, not the clip.
                    self.run["ignored"].append(t)
                    continue
                r = {"t": t, "block": block["id"], "clip": s["name"], "partner": s.get("partner")}
                if not s.get("shot"):
                    r["kind"] = "noshot"
                else:
                    n = numbers_of(s["shot"], s.get("body3d"), s.get("body"))
                    nr = no_read(n)
                    needs_3d = block_needs_3d(block)
                    waiting = False
                    if not nr and needs_3d:
                        if s.get("body3d"):
                            pass
                        elif s.get("why3d"):
                            nr = s["why3d"]
                        elif now - t < BODY3D_GIVE_UP_S:
                            waiting = True
                        else:
                            nr = "no 3D"
                    r.update(kind="shot" if block["ball"] else "ball", club=s["shot"].get("club"),
                             numbers=n, noRead=nr, waiting3d=waiting)
                self.run["reps"].append(r)
                made.append(r)
                if r["kind"] in ("shot", "ball") and not r.get("waiting3d"):
                    self._calibration_check()
                if r["kind"] == "shot":
                    if not r.get("waiting3d"):
                        p, block = self._current()
                        self._say_shot(block, t)
                elif r["kind"] == "noshot":
                    self._say("No Square numbers for that one: not counted.")
                if not self._settle(p, now):
                    break
            if self.run and not made:
                self._settle(p, now)
                if self.run and now - max([r["t"] for r in self.run["reps"]] + [self.run["blockStarted"]]) > IDLE_END_S:
                    self._finish("idle")
            if self.run and (made or self.run["block"] != block_was):
                self._save()
            return made

    # ---- For the phone and the page ----

    def latest(self, since: int) -> list[dict]:
        with self.lock:
            now = self.clock()
            return [e for e in self.said if e["id"] > since and now - e["made"] <= SPEAK_WITHIN_S]

    def state(self, log_limit: int = 20) -> dict:
        """The program in play, the programs, and finished runs (newest last), each with its blocks
        judged as the gates judged them ("blocks": id, name, result, state, judged reps)."""
        with self.lock:
            log = [dict(x, blocks=judged_blocks(self._program_of(x), x)) if self._program_of(x) else x
                   for x in self._log()[-log_limit:]]
            return {"program": self._state(), "programs": self.catalog(), "log": log}

    def report(self, started: float | None = None, body=None) -> dict | None:
        """The report for the coach, of the program in play (or the finished one started at `started`,
        or the last finished): {text, frame (the toe-tap ball swing's clips, for its impact frame)}."""
        with self.lock:
            run = self.run if self.run and started in (None, self.run["started"]) else None
            if run is None:
                logged = self._log()
                run = next((x for x in reversed(logged) if started is None or x["started"] == started), None)
            if run is None or not self._program_of(run):
                return None
            return report(effective(self._program_of(run), run), run, body)

    # ---- Inside (lock held) ----

    def _program_of(self, run: dict) -> dict | None:
        """The program a run was judged by: a finished run keeps a copy (since Oct 7: editing programs.json,
        a coach's new gates, must not rewrite old reports); the run in play and older runs use the file's."""
        return run.get("program") or self.programs.get(run.get("id"))

    def _current(self) -> tuple[dict, dict]:
        p = effective(self.programs[self.run["id"]], self.run)
        return p, p["blocks"][self.run["block"]]

    def _swings_used(self) -> int:
        return len(self.run["reps"])

    def _calibration_check(self) -> None:
        cal = calibration(self.programs[self.run["id"]], self.run)
        if cal and cal["shifted"] is not None and "calibration" not in self.run:
            self.run["calibration"] = cal
            if cal["shifted"]:
                self._say(f"Calibration shifted: strike median {cal['median']:.0f} on the first {cal['n']} shots, "
                          f"usual {cal['center']}. Strike isn't gated this session; attack and loft still are.")

    def _block_intro(self, block: dict, number: int) -> str:
        judge = (f"Do the {block['reps']} reps, then tap how many passed on the Start page." if not block["ball"]
                 else "Tap where the mark starts after each shot." if block["gate"].get("mark") else "")
        return f"Block {number}: {block['name']}. {block['how']} Gate: {gate_text(block)}. {judge}".strip()

    def _say_shot(self, block: dict, t: float) -> None:
        js = judged(block, self.run["reps"], self.run["marks"])
        r = next(x for x in js if x["t"] == t)
        st = block_state(block, self.run["reps"], self.run["marks"])
        # Short: pass or miss and which way, no numbers (the owner reads them on the screen; Oct 6).
        if r.get("noRead"):
            self._say(f"Invalid read ({r['noRead']}): not counted.")
            return
        if r["gate"] is None:
            return
        streak = f" {st['streak']} in a row." if block["gate"]["kind"] == "streak" and st["streak"] >= 2 else ""
        if r["gate"]:
            self._say(f"Pass.{streak}")
        else:
            why = ", ".join(cue(c, r["numbers"][c["key"]]) for c in r["fails"]) if r["fails"] else "mark behind the ball"
            self._say(f"Miss: {why}.")

    def _settle(self, p: dict, now: float) -> bool:
        """Ends the block in play if its gate is decided, and the program at its cap. False once the
        program ended."""
        if self._swings_used() >= p["cap"]:
            _, block = self._current()
            st = block_state(block, self.run["reps"], self.run["marks"])
            if st["reps"]:
                self.run["results"][block["id"]] = "passed" if st["passed"] else "not passed"
            done = self._finish("cap")
            self._say(f"That's {p['cap']} swings, the cap: stop here. {done['spoken']}")
            return False
        _, block = self._current()
        st = block_state(block, self.run["reps"], self.run["marks"])
        if not st["done"]:
            return True
        if block["ball"] and block["gate"].get("mark"):
            js = [r for r in judged(block, self.run["reps"], self.run["marks"]) if r["kind"] == "shot"]
            tapping = any(m["block"] == block["id"] for m in self.run["marks"])
            if tapping and js and js[-1]["mark"] is None and now - js[-1]["t"] < SHOT_GIVE_UP_S + MARK_WAIT_S:
                return True  # the last shot's mark may still come (only when the golfer taps marks)
        self._end_block(p, block, st)
        return self.run is not None

    def _end_block(self, p: dict, block: dict, st: dict) -> None:
        self.run["results"][block["id"]] = "passed" if st["passed"] else "not passed"
        said = f"{block['name']} {'gate passed' if st['passed'] else 'gate not passed'}: {progress_text(block, st)}."
        i = self.run["block"] + 1
        while i < len(p["blocks"]) and p["blocks"][i].get("requires") \
                and self.run["results"].get(p["blocks"][i]["requires"]) != "passed":
            skipped = p["blocks"][i]
            self.run["results"][skipped["id"]] = "skipped"
            need = next(b["name"] for b in p["blocks"] if b["id"] == skipped["requires"])
            said += f" Skip {skipped['name']}: it needs the {need} gate first."
            i += 1
        if i >= len(p["blocks"]):
            done = self._finish("done")
            self._say(f"{said} {p['name']} done. {done['spoken']}")
            return
        self.run["block"], self.run["blockStarted"] = i, self.clock()
        self._say(f"{said} {self._block_intro(p['blocks'][i], i + 1)}")
        self.on_block(p["blocks"][i].get("drill"))

    def _state(self) -> dict | None:
        if not self.run:
            return None
        p, block = self._current()
        waiting_count = sum(1 for r in self.run["reps"] if r.get("waiting3d"))
        blocks = [{**b, "now": i == self.run["block"],
                   "waiting3d": sum(1 for r in b["judged"] if r.get("waiting3d"))}
                  for i, b in enumerate(judged_blocks(p, self.run))]
        return {"id": p["id"], "name": p["name"], "started": self.run["started"], "cap": p["cap"],
                "notes": self.run.get("notes", ""), "calibration": calibration(p, self.run),
                "used": self._swings_used(), "block": self.run["block"], "blocks": blocks,
                "waiting3d": waiting_count, "wrist": self.run.get("wrist", {}),
                "progress": progress_text(block, block_state(block, self.run["reps"], self.run["marks"]))}

    def _say(self, text: str) -> None:
        now = self.clock()
        self.said = [e for e in self.said if now - e["made"] <= SPEAK_WITHIN_S]
        self.said.append({"id": self.new_id(), "made": now, "text": " ".join(text.split()), "program": True})

    def _finish(self, how: str) -> dict:
        p = self.programs[self.run["id"]]
        passed = [b["name"] for b in p["blocks"] if self.run["results"].get(b["id"]) == "passed"]
        spoken = (f"{self._swings_used()} swings, gates passed: {', '.join(passed)}." if passed
                  else f"{self._swings_used()} swings, no gate passed yet.") + " The report for your coach is in Week for coach."
        done = {**self.run, "ended": self.clock(), "how": how, "spoken": spoken,
                "day": datetime.fromtimestamp(self.run["started"]).isoformat(timespec="seconds"),
                "program": json.loads(json.dumps(p))}
        if self.run["reps"]:
            self.log_file.parent.mkdir(parents=True, exist_ok=True)
            with open(self.log_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(done, separators=(",", ":")) + "\n")
        self.run = None
        self._save()
        self.on_block(None)
        return done

    def _save(self) -> None:
        swings.save(self.state_file, self.run or {})

    def _log(self) -> list[dict]:
        out = []
        try:
            for line in self.log_file.read_text(encoding="utf-8").splitlines():
                try:
                    out.append(json.loads(line))
                except ValueError:
                    continue
        except OSError:
            pass
        return out


# ---- The report for the coach ----

CLUB_WORDS = {"DR": "driver", "PW": "PW", "GW": "GW", "SW": "SW", "LW": "LW"}


def club_word(code: str | None) -> str:
    if not code:
        return "?"
    if code in CLUB_WORDS:
        return CLUB_WORDS[code]
    kind = {"W": "w", "H": "h", "I": "i"}.get(code[:1])
    return f"{code[1:]}{kind}" if kind and code[1:].isdigit() else code


def fmt(key: str, v) -> str:
    if v is None:
        return "–"
    if isinstance(v, bool):
        return "yes" if v else "no"
    dec = NUMBERS[key][2]
    return f"{v:+.{dec}f}" if key in ("attack", "faceToPath", "strikeV", "strikeH", "pelvisPeakMs", "armPeakMs", "pelvisOpen",
                                       "pelvisStartMs", "pelvisBall", "chestBall", "handsAhead", "path", "face",
                                       "startDir") else f"{v:.{dec}f}"


def spread(key: str, values: list) -> str:
    v = [x for x in values if x is not None]
    if not v:
        return f"{NUMBERS[key][0].lower()} –"
    med = statistics.median(v)
    rng = f" ({fmt(key, min(v))} to {fmt(key, max(v))})" if len(v) > 1 else ""
    return f"{NUMBERS[key][0].lower()} {fmt(key, med)}{NUMBERS[key][1]}{rng}"


REPORT_KEYS = ("attack", "loft", "faceToPath", "strikeV")


def carry_spread(values: list) -> str:
    """Carry's median and standard deviation: reported, not gated (the coach's call, Oct 1)."""
    v = [x for x in values if x is not None]
    if not v:
        return "carry –"
    sd = f", SD {statistics.stdev(v):.0f} yd" if len(v) > 1 else ""
    return f"carry {statistics.median(v):.0f} yd{sd}"


# Camera numbers reported per block when the swings have them (summary.js BODY key: label, unit).
BODY_REPORT = {"handsAhead": ("hands ahead of ball at impact", "in"), "pelvisBall": ("pelvis vs ball at impact", "in"),
               "chestBall": ("chest vs ball at impact", "in")}

# Square and 3D numbers reported per block when present on the block's read shots (the coach's ask).
SQUARE_MORE = ("path", "face", "ballSpeed", "smash")
BODY3D_REPORT = (
    ("pelvisOpen", "pelvis open at impact", "°"),
    ("pelvisPeakMs", "pelvis peak", " ms"),
    ("armPeakMs", "arm peak", " ms"),
)
VALID_WRIST = {"flat", "bowed", "cupped", "can't tell"}
WRIST_WORDS = {"flat": "flat", "bowed": "slightly bowed", "cupped": "cupped", "can't tell": "can't tell"}


def report(p: dict, run: dict, body=None) -> dict:
    """The text to paste back to the coach: per block the gate, the medians (and range) of attack
    angle, dynamic loft and face to path split into shots 1-10 and 11 on, and every swing in order."""
    day = datetime.fromtimestamp(run["started"])
    reps = sorted(run["reps"], key=lambda r: r["t"])
    lines = [f"{p['name']}: {day.strftime('%b %d %Y, %H:%M').replace(' 0', ' ')}"
             + (" (in progress)" if "ended" not in run else ""),
             f"Swings: {len(reps)} of the {p['cap']} cap."]
    clubs = [club_word(r.get("club")) for r in reps if r.get("club")]
    order = []
    for c in clubs:
        if order and order[-1][0] == c:
            order[-1][1] += 1
        else:
            order.append([c, 1])
    lines.append("Club order: " + (", ".join(f"{c} x{n}" for c, n in order) if order else "no ball shots"))
    lines.append("Setup notes: " + (run.get("notes") or "none (nothing changed)"))
    cal = calibration(p, run)
    if cal and cal["n"]:
        verdict = ("not enough shots yet" if cal["shifted"] is None else
                   "SHIFTED: strike not gated this session" if cal["shifted"] else "normal")
        lines.append(f"Strike calibration: median {cal['median']:+.1f} on the first {cal['n']} readable {club_word(p['calibration']['club'])} "
                     f"(usual {cal['center']:+} ± {cal['within']}): {verdict}.")
    frame = None
    for b in p["blocks"]:
        res = run["results"].get(b["id"])
        js = judged(b, run["reps"], run["marks"])
        st = block_state(b, run["reps"], run["marks"])
        if not js and res != "skipped":
            continue
        lines.append("")
        head = f"{b['name']}: gate {gate_text(b)}"
        if res == "skipped":
            need = next((x["name"] for x in p["blocks"] if x["id"] == b.get("requires")), b.get("requires"))
            lines.append(f"{head}: skipped (needs the {need} gate first).")
            continue
        lines.append(f"{head}: {res or 'in progress'} ({progress_text(b, st)}).")
        taps = [r for r in js if r["kind"] == "tap"]
        if taps:
            lines.append(f"  {len(taps)} reps, no ball: " + " ".join("✓" if r["pass"] else "✗" for r in taps))
        shots = [r for r in js if r["kind"] in ("shot", "ball")]
        if shots and b["ball"]:
            groups = [("Shots 1-10", shots[:SPLIT_AT]), (f"Shots {SPLIT_AT + 1} on", shots[SPLIT_AT:])]
            for name, g in groups:
                if g:
                    read = [r for r in g if r["numbers"]["clubSpeed"]]
                    cams = []
                    for k, (label, unit) in BODY_REPORT.items():
                        v = [x for x in ((body(r["clip"]) or {}).get(k) if body else None for r in g) if x is not None]
                        if v:
                            cams.append(f"{label} {statistics.median(v):+.1f} {unit} (camera, {len(v)} swings)")
                    square_more = [spread(k, [r["numbers"][k] for r in read])
                                   for k in SQUARE_MORE if any(r.get("numbers", {}).get(k) is not None for r in read)]
                    d3_cams = []
                    for k, label, unit in BODY3D_REPORT:
                        v = [r["numbers"][k] for r in read if r.get("numbers", {}).get(k) is not None]
                        if v:
                            d3_cams.append(f"{label} {fmt(k, statistics.median(v))}{unit} (3D, {len(v)} swings)")
                    lines.append(f"  {name}: " + "; ".join([spread(k, [r["numbers"][k] for r in read]) for k in REPORT_KEYS]
                                                           + [carry_spread([r["numbers"]["carry"] for r in read])]
                                                           + cams + square_more + d3_cams))
            wrist_map = run.get("wrist") or {}
            block_calls = [
                wrist_map.get(r.get("clip")) or (wrist_map.get(r.get("partner")) if r.get("partner") else None)
                for r in shots
            ]
            block_calls = [w for w in block_calls if w]
            if block_calls:
                # "Can't tell" is an answer, not a call: counted apart (a blurred hand at 240 fps often is one).
                called = [w for w in block_calls if w != "can't tell"]
                parts = [f"{label} {called.count(k)}" for k, label in (("flat", "flat"), ("bowed", "slightly bowed"),
                                                                      ("cupped", "cupped")) if called.count(k)]
                unsure = len(block_calls) - len(called)
                lines.append(f"  Lead wrist at impact (by eye): {', '.join(parts) or 'none called'} ({len(called)} of "
                             f"{len(shots)} shots called" + (f"; can't tell on {unsure}" if unsure else "") + ")")
        for r in shots:
            if r["kind"] == "ball":
                lines.append(f"  Ball swing ({club_word(r.get('club'))}): " + ", ".join(
                    f"{NUMBERS[k][0].lower()} {fmt(k, r['numbers'][k])}" for k in ("attack", "loft", "faceToPath", "strikeV")))
                if frame is None:
                    frame = {"clip": r["clip"], "partner": r.get("partner"), "block": b["name"]}
    lines.append("")
    has_any_3d = (any(r.get("numbers", {}).get("pelvisPeakMs") is not None for r in reps if r.get("numbers"))
                  or any(block_needs_3d(b) for b in p["blocks"]))
    has_shift = bool(body) and any((body(r["clip"]) or {}).get("pelvisBall") is not None for r in reps if r.get("clip"))
    shift_head = " | vs ball at impact, + = ahead" if has_shift else ""
    if has_any_3d:
        lines.append(f"Shot order (# overall, block, club: attack / dynamic loft / face to path / strike height | 3D: pelvis peak / arm peak / pelvis open / pelvis start{shift_head}, verdict):")
    else:
        lines.append(f"Shot order (# overall, block, club: attack / dynamic loft / face to path / strike height{shift_head}, verdict):")
    if any((r.get("numbers") or {}).get("path") is not None for r in reps):
        lines.append("  (in brackets: club path, face to target and start direction, + = right; ball speed, smash, carry)")
    by_block = {b["id"]: {r["t"]: r for r in judged(b, run["reps"], run["marks"])} for b in p["blocks"]}
    names = {b["id"]: b["name"] for b in p["blocks"]}
    wrist_map = run.get("wrist") or {}
    for i, r0 in enumerate(reps, 1):
        r = by_block.get(r0["block"], {}).get(r0["t"], r0)
        if r0["kind"] == "tap":
            continue
        if r0["kind"] == "noshot":
            lines.append(f"  {i}. {names.get(r0['block'], r0['block'])}: no Square shot")
            continue
        n = r0["numbers"]
        nums = " / ".join(fmt(k, n[k]) for k in ("attack", "loft", "faceToPath", "strikeV"))
        # Where the ball went (the coach's ask, Oct 6): path, face, start direction, ball speed, smash, carry.
        flight = [f"{word} {fmt(k, n.get(k))}{unit}" for k, word, unit in
                  (("path", "path", "°"), ("face", "face", "°"), ("startDir", "start", "°"), ("ballSpeed", "ball", " mph"),
                   ("smash", "smash", ""), ("carry", "carry", " yd")) if n.get(k) is not None]
        if n.get("path") is not None and flight:
            nums = f"{nums} ({', '.join(flight)})"
        if any(n.get(k) is not None for k in ("pelvisPeakMs", "armPeakMs", "pelvisOpen", "pelvisStartMs")):
            d3 = (f"pelvis peak {fmt('pelvisPeakMs', n.get('pelvisPeakMs'))} ms, "
                  f"arm peak {fmt('armPeakMs', n.get('armPeakMs'))} ms, "
                  f"pelvis open {fmt('pelvisOpen', n.get('pelvisOpen'))}°, "
                  f"pelvis start {fmt('pelvisStartMs', n.get('pelvisStartMs'))} ms")
            nums = f"{nums} | 3D: {d3}"
        # Pelvis and chest against the ball at impact (the coach's shift check), from the face-on
        # camera: the 3D's distances aren't used for it (on the Oct 2 swings its stance came out ~1.35x
        # too wide and the ball at the lead ankle; the camera's put it mid-stance).
        cam = (body(r0["clip"]) or {}) if body and r0.get("clip") else {}
        shift = [f"{word} {fmt(k, cam[k])} in" for k, word in (("pelvisBall", "pelvis"), ("chestBall", "chest"))
                 if cam.get(k) is not None]
        if shift:
            nums = f"{nums} | vs ball: " + ", ".join(shift)

        verdict = ("invalid read, not counted (" + r0["noRead"] + ")" if r0.get("noRead") else
                   "waiting for 3D" if r.get("waiting3d") else
                   "pass" if r.get("gate") else "miss" if r.get("gate") is False else "")
        if r.get("mark") is not None:
            verdict += (", " if verdict else "") + ("mark ahead" if r["mark"] else "mark behind")
        w_call = wrist_map.get(r0.get("clip")) or (wrist_map.get(r0.get("partner")) if r0.get("partner") else None)
        if w_call in WRIST_WORDS:
            verdict += (", " if verdict else "") + f"wrist {WRIST_WORDS[w_call]}"
        lines.append(f"  {i}. {names.get(r0['block'], r0['block'])}, {club_word(r0.get('club'))}: {nums}" + (f", {verdict}" if verdict else ""))
    if not any(r["kind"] != "tap" for r in reps):
        lines.append("  (no ball shots yet)")
    return {"text": "\n".join(lines), "frame": frame, "started": run["started"]}
