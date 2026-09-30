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
}


def numbers_of(shot: dict | None) -> dict:
    """A Square shot's numbers for the gates and the report. Face to path is face minus path (face
    +0.7, path +4.6 -> -3.9: closed to the path, the draw/hook side)."""
    c = (shot or {}).get("clubData") or {}
    b = (shot or {}).get("ball") or {}
    face, path = _finite(c.get("faceToTarget")), _finite(c.get("path"))
    return {
        "attack": _finite(c.get("angleOfAttack")), "loft": _finite(c.get("loft")),
        "faceToPath": round(face - path, 2) if face is not None and path is not None else None,
        "strikeV": _finite(c.get("faceImpactV")), "strikeH": _finite(c.get("faceImpactH")),
        "clubSpeed": _finite(c.get("speed")), "carry": _finite(b.get("carry")),
    }


def no_read(n: dict) -> str | None:
    """Why Square's shot can't be judged (None: it can)."""
    if n["clubSpeed"] is None or n["clubSpeed"] == 0:
        return "no club speed"
    if n["strikeH"] == 0.0:
        return "strike not read"
    return None


def check(n: dict, c: dict) -> bool | None:
    """One gate check ({key, min, max}) on a shot's numbers; None when the number is missing."""
    v = n.get(c["key"])
    if v is None:
        return None
    return (c.get("min") is None or v >= c["min"]) and (c.get("max") is None or v <= c["max"])


def load_programs(path: Path = PROGRAMS_FILE) -> dict:
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    return {p["id"]: p for p in doc["programs"]}


def say_number(key: str, v: float) -> str:
    if key == "strikeV":
        mm = round(v)
        return "strike center" if mm == 0 else f"strike {abs(mm)} millimeter{'s' if abs(mm) != 1 else ''} {'high' if mm > 0 else 'low'}"
    dec = NUMBERS[key][2]
    s = f"{abs(v):.{dec}f}".rstrip("0").rstrip(".") if dec else f"{abs(round(v))}"
    sign = "minus " if v < 0 and s != "0" else "plus " if v > 0 and key in ("attack", "faceToPath") and s != "0" else ""
    return f"{NUMBERS[key][0].lower()} {sign}{s}"


def say_limit(c: dict, v: float) -> str:
    """What a failed check (value v) wanted, in words for the phone."""
    key, lo, hi = c["key"], c.get("min"), c.get("max")
    if key == "strikeV":
        return f"strike no higher than {hi:g} millimeters" if hi is not None and v > hi \
            else f"strike no lower than {abs(lo):g} millimeters low"
    if lo is not None and hi is not None and lo == -hi:
        return f"{NUMBERS[key][0].lower()} within {hi:g}"
    if hi is not None and v > hi:
        return say_number(key, hi) + (" or steeper" if key == "attack" else " or less")
    return say_number(key, lo) + " or more"


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
    if gate["kind"] == "streak":
        passed = best >= gate["need"]
        done = passed or len(js) >= block["reps"]
    else:
        passed = passes >= gate["need"]
        done = len(js) >= block["reps"]
    return {"reps": len(js), "passes": passes, "streak": streak, "best": best, "passed": passed, "done": done}


def gate_text(block: dict) -> str:
    g = block["gate"]
    what = "in a row" if g["kind"] == "streak" else f"of {block['reps']}"
    return f"{g['need']} {what}"


def progress_text(block: dict, st: dict) -> str:
    g = block["gate"]
    if g["kind"] == "streak":
        return f"{st['streak']} in a row" + (f", best {st['best']}" if st["best"] > st["streak"] else "")
    return f"{st['passes']} of {st['reps']} passed, {g['need']} needed"


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
        listed swings with "t" (strike, unix s), "name", "partner" and "shot". Returns the reps made."""
        with self.lock:
            if not self.run:
                return []
            p, _ = self._current()
            now = self.clock()
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
                    n = numbers_of(s["shot"])
                    r.update(kind="shot" if block["ball"] else "ball", club=s["shot"].get("club"),
                             numbers=n, noRead=no_read(n))
                self.run["reps"].append(r)
                made.append(r)
                if r["kind"] == "shot":
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
        with self.lock:
            return {"program": self._state(), "programs": self.catalog(), "log": self._log()[-log_limit:]}

    def report(self, started: float | None = None) -> dict | None:
        """The report for the coach, of the program in play (or the finished one started at `started`,
        or the last finished): {text, frame (the toe-tap ball swing's clips, for its impact frame)}."""
        with self.lock:
            run = self.run if self.run and started in (None, self.run["started"]) else None
            if run is None:
                logged = self._log()
                run = next((x for x in reversed(logged) if started is None or x["started"] == started), None)
            if run is None or run["id"] not in self.programs:
                return None
            return report(self.programs[run["id"]], run)

    # ---- Inside (lock held) ----

    def _current(self) -> tuple[dict, dict]:
        p = self.programs[self.run["id"]]
        return p, p["blocks"][self.run["block"]]

    def _swings_used(self) -> int:
        return len(self.run["reps"])

    def _block_intro(self, block: dict, number: int) -> str:
        judge = ("Tap pass or miss on the Start page after each rep." if not block["ball"]
                 else "Tap where the mark starts after each shot." if block["gate"].get("mark") else "")
        return f"Block {number}: {block['name']}. {block['how']} Gate: {gate_text(block)}. {judge}".strip()

    def _say_shot(self, block: dict, t: float) -> None:
        js = judged(block, self.run["reps"], self.run["marks"])
        r = next(x for x in js if x["t"] == t)
        st = block_state(block, self.run["reps"], self.run["marks"])
        if r.get("noRead"):
            self._say(f"Square didn't read that one ({r['noRead']}): not counted.")
            return
        keys = [c["key"] for c in block["gate"].get("checks", [])]
        nums = ", ".join(say_number(k, r["numbers"][k]) for k in keys if r["numbers"].get(k) is not None)
        if r["gate"] is None:
            self._say(f"{nums}.")
            return
        if r["gate"]:
            self._say(f"Pass: {nums}. {progress_text(block, st)}.")
        else:
            why = " and ".join(say_limit(c, r["numbers"][c["key"]]) for c in r["fails"]) if r["fails"] else "the mark at or ahead of the ball"
            self._say(f"Miss: needs {why}. You had {nums}. {progress_text(block, st)}.")

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
            if js and js[-1]["mark"] is None and now - js[-1]["t"] < SHOT_GIVE_UP_S + MARK_WAIT_S:
                return True  # the last shot's mark may still come
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
        blocks = []
        for i, b in enumerate(p["blocks"]):
            js = judged(b, self.run["reps"], self.run["marks"])
            blocks.append({**b, "state": block_state(b, self.run["reps"], self.run["marks"]),
                           "result": self.run["results"].get(b["id"]), "now": i == self.run["block"],
                           "judged": js})
        return {"id": p["id"], "name": p["name"], "started": self.run["started"], "cap": p["cap"],
                "used": self._swings_used(), "block": self.run["block"], "blocks": blocks,
                "progress": progress_text(block, block_state(block, self.run["reps"], self.run["marks"]))}

    def _say(self, text: str) -> None:
        now = self.clock()
        self.said = [e for e in self.said if now - e["made"] <= SPEAK_WITHIN_S]
        self.said.append({"id": self.new_id(), "made": now, "text": " ".join(text.split()), "program": True})

    def _finish(self, how: str) -> dict:
        p = self.programs[self.run["id"]]
        passed = [b["name"] for b in p["blocks"] if self.run["results"].get(b["id"]) == "passed"]
        spoken = (f"{self._swings_used()} swings, gates passed: {', '.join(passed)}." if passed
                  else f"{self._swings_used()} swings, no gate passed yet.") + " The report for your coach is on the Start page."
        done = {**self.run, "ended": self.clock(), "how": how, "spoken": spoken,
                "day": datetime.fromtimestamp(self.run["started"]).isoformat(timespec="seconds")}
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
    dec = NUMBERS[key][2]
    return f"{v:+.{dec}f}" if key in ("attack", "faceToPath", "strikeV", "strikeH") else f"{v:.{dec}f}"


def spread(key: str, values: list) -> str:
    v = [x for x in values if x is not None]
    if not v:
        return f"{NUMBERS[key][0].lower()} –"
    med = statistics.median(v)
    rng = f" ({fmt(key, min(v))} to {fmt(key, max(v))})" if len(v) > 1 else ""
    return f"{NUMBERS[key][0].lower()} {fmt(key, med)}{NUMBERS[key][1]}{rng}"


REPORT_KEYS = ("attack", "loft", "faceToPath")


def report(p: dict, run: dict) -> dict:
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
                    lines.append(f"  {name}: " + "; ".join(spread(k, [r["numbers"][k] for r in read]) for k in REPORT_KEYS))
        for r in shots:
            if r["kind"] == "ball":
                lines.append(f"  Ball swing ({club_word(r.get('club'))}): " + ", ".join(
                    f"{NUMBERS[k][0].lower()} {fmt(k, r['numbers'][k])}" for k in ("attack", "loft", "faceToPath", "strikeV")))
                if frame is None:
                    frame = {"clip": r["clip"], "partner": r.get("partner"), "block": b["name"]}
    lines.append("")
    lines.append("Shot order (# overall, block, club: attack / dynamic loft / face to path / strike height, verdict):")
    by_block = {b["id"]: {r["t"]: r for r in judged(b, run["reps"], run["marks"])} for b in p["blocks"]}
    names = {b["id"]: b["name"] for b in p["blocks"]}
    for i, r0 in enumerate(reps, 1):
        r = by_block.get(r0["block"], {}).get(r0["t"], r0)
        if r0["kind"] == "tap":
            continue
        if r0["kind"] == "noshot":
            lines.append(f"  {i}. {names.get(r0['block'], r0['block'])}: no Square shot")
            continue
        n = r0["numbers"]
        nums = " / ".join(fmt(k, n[k]) for k in ("attack", "loft", "faceToPath", "strikeV"))
        verdict = ("not read (" + r0["noRead"] + ")" if r0.get("noRead") else
                   "pass" if r.get("gate") else "miss" if r.get("gate") is False else "")
        if r.get("mark") is not None:
            verdict += (", " if verdict else "") + ("mark ahead" if r["mark"] else "mark behind")
        lines.append(f"  {i}. {names.get(r0['block'], r0['block'])}, {club_word(r0.get('club'))}: {nums}" + (f", {verdict}" if verdict else ""))
    if not any(r["kind"] != "tap" for r in reps):
        lines.append("  (no ball shots yet)")
    return {"text": "\n".join(lines), "frame": frame, "started": run["started"]}
