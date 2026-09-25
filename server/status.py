"""Session status: the phones and the Square watcher report in, the review page starts and stops the
phones, one phone speaks for camera setup, and the first swing of each session gets a spoken check.

- Phones (capture app 0.6): each asks POST /api/phones/<angle>/poll about every 10 s with what it's
  doing (recording, mode, shutter, battery, uploads...). The server holds the request open (a long
  poll) until it has a command or something to say for that phone, so the same request carries
  commands back. The phone answers a command (an ack) on its next poll. A phone that hasn't asked
  for PHONE_GONE_S is gone.
- The Square watcher on the sim laptop posts POST /api/relay/heartbeat.
- Camera setup, one voice: each phone's setup verdict (setup.py) is combined here and said by one
  phone, only when it changes: "Both cameras look good", "Face-on good. Down the line: tilt the
  phone up." (CombinedVoice).
- A session starts when a phone starts recording while none was. Its first analyzed swing gets a
  one-line check ("First swing: both cameras saw you, Square paired"); after that only problems are
  spoken (Health).
- The Ready panel (static/status.js) shows it all: snapshot().

Plain Python with a clock that can be swapped, so it's tested without phones (tests/test_status.py).
"""
import threading
import time
from datetime import datetime

ANGLES = ("face", "dtl")
NAMES = {"face": "Face-on", "dtl": "Down the line"}

# A phone asks at least every ~10 s (its long poll); one not heard from for this long is gone.
PHONE_GONE_S = 30
# The longest a phone's poll is held open (its read timeout is longer).
POLL_WAIT_MAX_S = 15
# The Square watcher's heartbeat: gone after this long.
RELAY_GONE_S = 90
# A phone seen this recently is expected in the session (Ready needs it recording).
EXPECTED_S = 12 * 3600
# A command not answered in this long is "no answer" (and no longer delivered).
COMMAND_TIMEOUT_S = 20
COMMANDS_KEPT = 20
# Something to say that hasn't been picked up in this long is dropped: it's out of date.
SAY_WITHIN_S = 20
# A setup verdict older than this is from a phone that stopped sending stills (setup.js's SETUP_STALE_S).
SETUP_LIVE_S = 5
# A combined setup sentence is said once it has held this long (not every flicker).
HOLD_S = 1.5
# Ready panel: amber below this battery (%) when not charging; spoken below LOW_BATTERY_SAY.
LOW_BATTERY = 20
LOW_BATTERY_SAY = 10
# Clips waiting on a phone: amber (and spoken during a session) from this many.
PENDING_WARN = 3
# Swings waiting for pose: amber from this many.
POSE_BEHIND = 3

# Health check timing, as practice.py's: a Square shot comes ~14 s after the strike (given up at
# 25 s), a down-the-line clip is waited on for 90 s, and a swing that still isn't analyzed after 4
# minutes is checked as it is. The clip quality record (quality.py) is waited on for 2 minutes.
SHOT_GIVE_UP_S = 25.0
DTL_WAIT_S = 90.0
BODY_GIVE_UP_S = 240.0
QUALITY_WAIT_S = 120.0
PAIR_SLACK_S = 2.0
# Swings older than this when first seen aren't checked (the server was off).
STALE_S = 300.0
# A session stays open this long after the last phone stopped, so its last swings are still checked.
SESSION_TAIL_S = 300.0
# After the first swing, a problem is spoken once it's been on this many swings in a row.
STREAK_TO_SAY = {"square": 2, "clip": 2, "camera": 3}

# The camera check's codes (summary.js cameraCheck, impactCheck), as said.
CODE_SAY = {
    "out": "you're partly out of the picture",
    "edge": "you're near the edge of the picture",
    "small": "you're small in the picture: move the phone closer",
    "hands": "you're out of the picture at the top",
    "noball": "ball not found",
    "impact": "the ball left at the wrong moment",
}
# Clip quality warnings (quality.py), as said. Flicker only when it matters (a fixed shutter, or strong).
QUALITY_SAY = {"dark": "too dark", "grainy": "grainy", "flicker": "flickering light"}

# What a phone reports, and its type. Anything else is ignored; strings are cut short.
PHONE_FIELDS = {
    "recording": bool, "mode": str, "shutter": str, "shutterUsed": str, "exposure": str,
    "battery": int, "charging": bool, "freeMb": int, "version": str, "pending": int,
    "practiceVoice": bool, "setupVoice": str, "autoStart": bool, "busy": str, "cameraError": str,
    "saved": int, "closing": bool,
}
RELAY_FIELDS = {"source": str, "squareRunning": bool, "lastShotAt": str, "version": str}


def clean(body: dict, fields: dict) -> dict:
    out = {}
    for k, kind in fields.items():
        v = body.get(k)
        if v is None:
            continue
        if kind is int and isinstance(v, (int, float)) and not isinstance(v, bool):
            out[k] = int(v)
        elif kind is bool and isinstance(v, bool):
            out[k] = v
        elif kind is str and isinstance(v, str):
            out[k] = v[:120]
    return out


def ago(seconds: float | None) -> str:
    if seconds is None:
        return "never"
    s = max(0, int(seconds))
    if s < 60:
        return f"{s} s ago"
    if s < 3600:
        return f"{s // 60} min ago"
    return f"{s // 3600} h ago"


# ---- Camera setup, one voice ----

def setup_part(angle: str, verdict: dict) -> tuple[str, str]:
    """One phone's setup verdict as (kind, what to say): kind "good", "board" or "bad"."""
    name = NAMES[angle]
    say = (verdict.get("say") or "").strip()
    if verdict.get("board"):
        return "board", say
    if verdict.get("ok"):
        return "good", f"{name} good."
    # setupAdvice says "Face on: tilt the phone up." / "Down the line: I can't see you."
    tip = say.split(": ", 1)[1] if ": " in say else (verdict.get("text") or "check the camera")
    tip = tip.rstrip(".")
    return "bad", f"{name}: {tip}."


def combined_sentence(parts: dict[str, tuple[str, str]]) -> str:
    if len(parts) == 2 and all(kind == "good" for kind, _ in parts.values()):
        return "Both cameras look good."
    return " ".join(parts[a][1] for a in ANGLES if a in parts)


class CombinedVoice:
    """Says the combined setup verdict when it changes, once it has held for HOLD_S. No repeats."""

    def __init__(self):
        self.spoken: dict = {}       # the parts last said (or taken in silently)
        self.candidate: dict | None = None
        self.since = 0.0

    def update(self, parts: dict[str, tuple[str, str]], now: float) -> str | None:
        """parts: angle -> setup_part() of each phone in setup now. What to say, or None."""
        if not parts:
            # Nobody's in setup (recording, or gone): the next setup is said afresh.
            self.spoken, self.candidate = {}, None
            return None
        if parts != self.candidate:
            self.candidate, self.since = dict(parts), now
            return None
        if now - self.since < HOLD_S or parts == self.spoken:
            return None
        # A phone dropping out (it started recording) with the others as they were: nothing new.
        dropped_only = set(parts) < set(self.spoken) and all(self.spoken[a] == p for a, p in parts.items())
        self.spoken = dict(parts)
        return None if dropped_only else combined_sentence(parts)


# ---- The first swing's check, and problems after it ----

def camera_problems(angle: str, codes: list | None, quality: dict | None) -> list[str]:
    said = [CODE_SAY[c] for c in (codes or []) if c in CODE_SAY]
    q = quality or {}
    for w in q.get("warnings") or []:
        if w == "flicker" and q.get("flickerLevel") != "matters":
            continue
        if w in QUALITY_SAY:
            said.append(QUALITY_SAY[w])
    return said


def swing_findings(s: dict, expect_dtl: bool, relay_ok: bool) -> dict:
    """What's wrong with one checked swing: {"cameras": {angle: [problems] or None when fine},
    "clip": angles with no clip, "square": None or the problem}. `s` as Health.step takes it."""
    rec = s.get("record") or {}
    q = rec.get("quality") or {}
    codes = q.get("camera") or {}
    main = s.get("angle") or "face"
    out = {"cameras": {}, "clip": [], "square": None}
    angles = [main]
    if main == "face" and (s.get("partner") or expect_dtl):
        angles.append("dtl")
    for a in angles:
        if a != main and not s.get("partner"):
            out["clip"].append(a)
            continue
        pose = s.get("pose") if a == main else s.get("partnerPose")
        if pose == "failed":
            out["cameras"][a] = ["couldn't be analyzed"]
            continue
        if not rec:
            out["cameras"][a] = ["not analyzed yet"]
            continue
        if a == main and q.get("swingFound") is False:
            out["cameras"][a] = ["no swing found"]
            continue
        found = camera_problems(a, codes.get(a), (s.get("quality") or {}).get(a))
        out["cameras"][a] = found or None
    if not s.get("shot"):
        out["square"] = "No Square shot" + ("" if relay_ok else ": the Square watcher isn't running")
    return out


def first_swing_sentence(f: dict) -> str:
    problems = [f"{NAMES[a]}: no clip" for a in f["clip"]]
    problems += [f"{NAMES[a]}: {', and '.join(p)}" for a, p in f["cameras"].items() if p]
    if f["square"]:
        problems.append(f["square"])
    if problems:
        return "First swing. " + ". ".join(problems) + "."
    seen = "both cameras saw you" if len(f["cameras"]) == 2 else f"{NAMES[next(iter(f['cameras']))].lower()} saw you"
    return f"First swing: {seen}, Square paired."


class Health:
    """The first analyzed swing of a session gets its check; after it, problems that last are said once."""

    def __init__(self):
        self.start: float | None = None
        self.first: dict | None = None      # {"clip", "text", "ok", "t"}
        self.checked: set[str] = set()
        self.checked_times: list[float] = []
        self.streaks: dict[str, int] = {}
        self.active: set[str] = set()       # problems said and still going on
        self.last: dict | None = None       # the latest checked swing's findings, for the panel

    def new_session(self, t: float) -> None:
        self.start, self.first, self.last = t, None, None
        self.checked, self.checked_times, self.streaks, self.active = set(), [], {}, set()

    def ready(self, s: dict, now: float, expect_dtl: bool) -> bool:
        """Whether a swing is as done as it's going to get: analyzed, both clips, the shot paired."""
        age = now - s["t"]
        rec = s.get("record")
        failed = s.get("pose") == "failed"
        if rec is None and not failed and age < BODY_GIVE_UP_S:
            return False
        if expect_dtl and s.get("angle") == "face" and not s.get("partner") and age < DTL_WAIT_S:
            return False
        if s.get("partner") and s.get("partnerPose") not in ("done", "failed") and age < BODY_GIVE_UP_S:
            return False
        if not s.get("shot") and age < SHOT_GIVE_UP_S:
            return False
        q = s.get("quality") or {}
        if rec is not None and age < QUALITY_WAIT_S:
            for a, pose in ((s.get("angle") or "face", s.get("pose")), ("dtl", s.get("partnerPose"))):
                if pose == "done" and (a == s.get("angle") or s.get("partner")) and q.get(a) is None:
                    return False
        return True

    def step(self, swings: list[dict], now: float, expect_dtl: bool, relay_ok: bool) -> list[str]:
        """The session's swings (the listed one of each: {name, t, angle, partner, pose, partnerPose,
        shot, record, quality: {angle: quality record}}). Returns what to say."""
        if self.start is None:
            return []
        out = []
        for s in sorted(swings, key=lambda s: s["t"]):
            if s["t"] < self.start - PAIR_SLACK_S or s["name"] in self.checked or now - s["t"] > STALE_S:
                continue
            if any(abs(s["t"] - t) <= PAIR_SLACK_S for t in self.checked_times):
                continue  # the other clip of a swing already checked
            if not self.ready(s, now, expect_dtl):
                break  # in order: a later swing waits for this one
            self.checked.add(s["name"])
            self.checked_times.append(s["t"])
            f = swing_findings(s, expect_dtl, relay_ok)
            self.last = {"clip": s["name"], "t": s["t"], **f}
            if self.first is None:
                text = first_swing_sentence(f)
                self.first = {"clip": s["name"], "t": s["t"], "text": text, "ok": text.startswith("First swing:")}
                out.append(text)
                # What was said just now isn't said again unless it clears and comes back.
                for key in self._keys(f):
                    self.streaks[key] = STREAK_TO_SAY[key.split(":")[0]]
                    self.active.add(key)
                continue
            out += self._later(f)
        return out

    @staticmethod
    def _keys(f: dict) -> dict[str, str]:
        """Problem key -> what to say about it after the first swing."""
        keys = {}
        if f["square"]:
            keys["square"] = "Square: no shot"
        for a in f["clip"]:
            keys[f"clip:{a}"] = f"{NAMES[a]}: no clip"
        for a, problems in f["cameras"].items():
            for p in problems or []:
                keys[f"camera:{a}:{p}"] = f"{NAMES[a]}: {p}"
        return keys

    def _later(self, f: dict) -> list[str]:
        keys = self._keys(f)
        out = []
        for key in list(self.streaks):
            if key not in keys:
                self.streaks.pop(key)
                self.active.discard(key)
        for key, text in keys.items():
            n = self.streaks.get(key, 0) + 1
            self.streaks[key] = n
            if n >= STREAK_TO_SAY[key.split(":")[0]] and key not in self.active:
                self.active.add(key)
                out.append(f"{text} on the last {n} swings.")
        return out


# ---- Everything together ----

class Status:
    """The phones, the watcher, commands, what to say, the session's checks. Thread-safe."""

    def __init__(self, clock=time.time):
        self.clock = clock
        self.lock = threading.Lock()
        self.phones: dict[str, dict] = {}    # angle -> {"hb": fields, "seen": t}
        self.relay: dict | None = None       # {"hb": fields, "seen": t}
        self.commands: list[dict] = []
        self.outbox: dict[str, list[dict]] = {a: [] for a in ANGLES}
        self.voice = CombinedVoice()
        self.health = Health()
        self.combined: dict | None = None    # the last combined setup sentence: {"text", "t", "to"}
        self.spoken: list[dict] = []         # recent health sentences, for the panel
        self.phone_problems: set[str] = set()
        self.last_recording = 0.0
        self.last_id = 0

    def _id(self) -> int:
        self.last_id = max(self.last_id + 1, int(self.clock() * 1000))
        return self.last_id

    # ---- Phones ----

    def connected(self, angle: str, now: float | None = None) -> bool:
        p = self.phones.get(angle)
        now = self.clock() if now is None else now
        return bool(p) and not p["hb"].get("closing") and now - p["seen"] <= PHONE_GONE_S

    def _recording(self, now: float) -> set[str]:
        return {a for a in ANGLES if self.connected(a, now) and self.phones[a]["hb"].get("recording")}

    def heartbeat(self, angle: str, body: dict) -> None:
        """A phone's poll: what it's doing, and its answers to commands."""
        now = self.clock()
        with self.lock:
            # Recording lately, by what each phone last said (one that dropped off the Wi-Fi for a
            # minute and comes back recording is the same session).
            before = now - self.last_recording <= SESSION_TAIL_S and any(
                p["hb"].get("recording") and not p["hb"].get("closing") for p in self.phones.values())
            self.phones[angle] = {"hb": clean(body, PHONE_FIELDS), "seen": now}
            for ack in body.get("acks") or []:
                if not isinstance(ack, dict):
                    continue
                for c in self.commands:
                    if c["id"] == ack.get("id") and c["angle"] == angle and c["state"] in ("queued", "sent"):
                        c["state"] = "done" if ack.get("ok") else "failed"
                        c["error"] = str(ack.get("error") or "")[:160] or None
                        c["answered"] = now
            if self.phones[angle]["hb"].get("recording") and not self.phones[angle]["hb"].get("closing"):
                if not before:
                    self.health.new_session(now)   # recording started: a new session
                self.last_recording = now

    def speaker(self, now: float | None = None) -> str | None:
        """The phone that speaks: the one with Practice voice on (face-on first), else any connected one."""
        now = self.clock() if now is None else now
        on = [a for a in ANGLES if self.connected(a, now)]
        voiced = [a for a in on if self.phones[a]["hb"].get("practiceVoice")]
        return (voiced or on or [None])[0]

    def _say(self, angle: str | None, text: str, kind: str, now: float) -> None:
        if angle is None or not text:
            return
        box = self.outbox[angle]
        if kind == "setup":
            box[:] = [x for x in box if x["kind"] != "setup"]   # only the latest verdict matters
        box.append({"id": self._id(), "text": text, "kind": kind, "made": now, "flush": kind == "setup"})

    def has_mail(self, angle: str) -> bool:
        now = self.clock()
        with self.lock:
            self._expire(now)
            return any(c["angle"] == angle and c["state"] == "queued" for c in self.commands) or \
                any(now - x["made"] <= SAY_WITHIN_S for x in self.outbox[angle])

    def take(self, angle: str) -> dict:
        """The commands and sentences for a phone's poll; each goes out once."""
        now = self.clock()
        with self.lock:
            self._expire(now)
            cmds = []
            for c in self.commands:
                if c["angle"] == angle and c["state"] == "queued":
                    c["state"], c["sent"] = "sent", now
                    cmds.append({"id": c["id"], "action": c["action"]})
            say = [{"id": x["id"], "text": x["text"], "flush": x["flush"]}
                   for x in self.outbox[angle] if now - x["made"] <= SAY_WITHIN_S]
            self.outbox[angle] = []
            return {"commands": cmds, "say": say, "ms": int(now * 1000)}

    # ---- Commands from the review page ----

    def expected(self, now: float) -> list[str]:
        """The phones in use: seen in the last EXPECTED_S and not closed down on purpose long ago."""
        return [a for a in ANGLES if a in self.phones and now - self.phones[a]["seen"] <= EXPECTED_S]

    def command(self, action: str, target: str) -> list[dict]:
        """Start or stop one phone ("face", "dtl") or all in use ("both"). Each phone's outcome now:
        queued, or refused with why."""
        if action not in ("start", "stop"):
            raise ValueError("Unknown action")
        if target not in ANGLES + ("both",):
            raise ValueError("Unknown phone")
        now = self.clock()
        with self.lock:
            angles = [target] if target != "both" else (self.expected(now) or list(ANGLES))
            out = []
            for a in angles:
                c = {"id": self._id(), "angle": a, "action": action, "made": now, "state": "queued",
                     "error": None, "sent": None, "answered": None}
                hb = (self.phones.get(a) or {}).get("hb", {})
                if not self.connected(a, now):
                    c.update(state="failed", error="not connected (is the app open?)")
                elif action == "start" and hb.get("busy"):
                    c.update(state="failed", error=hb["busy"])
                else:
                    # A newer command replaces one the phone hasn't picked up yet.
                    for old in self.commands:
                        if old["angle"] == a and old["state"] == "queued":
                            old.update(state="failed", error="replaced by a newer command")
                self.commands.append(c)
                out.append({k: c[k] for k in ("id", "angle", "action", "state", "error")})
            self.commands = self.commands[-COMMANDS_KEPT:]
            return out

    def _expire(self, now: float) -> None:
        for c in self.commands:
            if c["state"] in ("queued", "sent") and now - c["made"] > COMMAND_TIMEOUT_S:
                c.update(state="failed", error="no answer from the phone")

    # ---- The Square watcher ----

    def relay_heartbeat(self, body: dict) -> dict:
        with self.lock:
            self.relay = {"hb": clean(body, RELAY_FIELDS), "seen": self.clock()}
            return dict(self.relay["hb"])

    def relay_ok(self, now: float) -> bool:
        return self.relay is not None and now - self.relay["seen"] <= RELAY_GONE_S

    # ---- Camera setup ----

    def setup_verdicts(self, verdicts: dict) -> str | None:
        """After each setup still: {angle: verdict with "age", or None} (setup.Setup.status()).
        Queues the combined sentence for the phone that speaks it; returns it, or None."""
        now = self.clock()
        with self.lock:
            combined = [a for a in ANGLES if self.connected(a, now)
                        and self.phones[a]["hb"].get("setupVoice", "combined") == "combined"]
            parts = {a: setup_part(a, verdicts[a]) for a in combined
                     if verdicts.get(a) and verdicts[a].get("age", 99) <= SETUP_LIVE_S
                     and not self.phones[a]["hb"].get("recording")}
            text = self.voice.update(parts, now)
            if text is None:
                return None
            to = self.speaker(now)
            if to not in combined:
                to = combined[0] if combined else None
            self._say(to, text, "setup", now)
            self.combined = {"text": text, "t": now, "to": to}
            return text

    # ---- The session's health ----

    def session_since(self) -> float | None:
        """When the current session started, while it's open (a phone recording, or lately)."""
        now = self.clock()
        with self.lock:
            if self.health.start is None:
                return None
            if self._recording(now) or now - self.last_recording <= SESSION_TAIL_S:
                return self.health.start
            return None

    def health_step(self, swings: list[dict]) -> list[str]:
        """The session's swings (see Health.step); queues what to say for the speaking phone."""
        now = self.clock()
        with self.lock:
            recording = self._recording(now)
            expect_dtl = "dtl" in recording
            said = self.health.step(swings, now, expect_dtl, self.relay_ok(now))
            said += self._phone_problems(now)
            to = self.speaker(now)
            for text in said:
                self._say(to, text, "health", now)
                self.spoken.append({"text": text, "t": now, "to": to})
            self.spoken = self.spoken[-10:]
            return said

    def _phone_problems(self, now: float) -> list[str]:
        """While a session is open: a phone gone, clips piling up on one, a battery nearly flat."""
        if self.health.start is None:
            return []
        found = {}
        for a in ANGLES:
            p = self.phones.get(a)
            if not p or p["seen"] < self.health.start:
                continue
            hb, name = p["hb"], NAMES[a]
            if not self.connected(a, now):
                if hb.get("recording") or hb.get("closing"):
                    found[f"gone:{a}"] = f"The {name.lower()} phone isn't answering."
                continue
            if (hb.get("pending") or 0) >= PENDING_WARN:
                found[f"pending:{a}"] = f"{name} phone: {hb['pending']} clips waiting to upload."
            if hb.get("battery") is not None and hb["battery"] < LOW_BATTERY_SAY and not hb.get("charging"):
                found[f"battery:{a}"] = f"{name} phone battery at {hb['battery']} percent."
        out = [text for key, text in found.items() if key not in self.phone_problems]
        self.phone_problems = set(found)
        return out

    # ---- For the review page ----

    def snapshot(self, setup_status: dict, pose: dict, last_shot: float | None) -> dict:
        """The Ready panel: a row per thing to check, each ok / warn / bad, and the raw state.
        setup_status: setup.Setup.status(); pose: {"queued", "busy"}; last_shot: unix s of the last
        shot the server got."""
        now = self.clock()
        with self.lock:
            self._expire(now)
            rows = []
            expected = self.expected(now)
            speaker = self.speaker(now)
            phones = {}
            for a in ANGLES:
                p = self.phones.get(a)
                hb = dict(p["hb"]) if p else {}
                cmd = next((c for c in reversed(self.commands) if c["angle"] == a), None)
                phones[a] = {**hb, "connected": self.connected(a, now), "age": round(now - p["seen"], 1) if p else None,
                             "expected": a in expected, "speaks": a == speaker,
                             "command": cmd and {k: cmd[k] for k in ("id", "action", "state", "error")}
                             | {"age": round(now - cmd["made"], 1)}}
                rows.append(self._phone_row(a, phones[a], now))
            rows.append(self._square_row(now, last_shot))
            rows.append(self._framing_row(setup_status, phones))
            if self.health.first:
                f = self.health.first
                rows.append({"key": "first", "label": "First swing", "level": "ok" if f["ok"] else "warn",
                             "text": f["text"]})
            queued = pose.get("queued") or 0
            rows.append({"key": "server", "label": "Server", "level": "ok" if queued < POSE_BEHIND else "warn",
                         "text": "Pose: up to date" if not queued else f"Pose: {queued} clip{'s' if queued != 1 else ''} waiting"
                         + (" (working on one)" if pose.get("busy") else "")})
            levels = [r["level"] for r in rows if r["level"] != "off"]
            level = "bad" if "bad" in levels else "warn" if "warn" in levels else "ok"
            first_bad = next((r for r in rows if r["level"] == "bad"), None) or next((r for r in rows if r["level"] == "warn"), None)
            return {
                "level": level,
                "headline": "Ready" if level == "ok" else f"{first_bad['label']}: {first_bad.get('problem') or first_bad['text']}",
                "rows": rows, "phones": phones, "speaker": speaker,
                "relay": self.relay and {**self.relay["hb"], "age": round(now - self.relay["seen"], 1)},
                "combined": self.combined and {**self.combined, "age": round(now - self.combined["t"], 1)},
                "session": {"start": self.health.start, "first": self.health.first, "last": self.health.last,
                            "spoken": [{**s, "age": round(now - s["t"], 1)} for s in self.spoken]},
                "commands": [{k: c[k] for k in ("id", "angle", "action", "state", "error")} for c in self.commands[-6:]],
            }

    def _phone_row(self, a: str, p: dict, now: float) -> dict:
        row = {"key": a, "label": NAMES[a], "angle": a}
        if p["age"] is None:
            return {**row, "level": "off", "text": "not seen (open SwingClips 0.6 on this phone)"}
        if not p["connected"]:
            why = "app closed" if p.get("closing") else f"last heard {ago(p['age'])}"
            return {**row, "level": "bad" if p["expected"] else "off", "text": f"not connected ({why})"}
        bits, level, problems = [], "ok", []
        if p.get("recording"):
            bits.append("recording")
        else:
            bits.append("not recording")
            level = "bad"
            problems.append("not recording")
        if p.get("mode"):
            bits.append(p["mode"].replace(" · ", " "))   # the app's label: "1080p · 240 fps"
        if p.get("shutter"):
            used = p.get("shutterUsed")
            bits.append(f"shutter {p['shutter']}" + (f" (using {used})" if used and used != p["shutter"] else ""))
        if p.get("battery") is not None:
            bits.append(f"battery {p['battery']}%" + (" charging" if p.get("charging") else ""))
            if p["battery"] < LOW_BATTERY and not p.get("charging"):
                level = "warn" if level == "ok" else level
                problems.append(f"battery {p['battery']}%")
        pending = p.get("pending") or 0
        bits.append(f"{pending} to upload" if pending else "all uploaded")
        if pending >= PENDING_WARN:
            level = "warn" if level == "ok" else level
            problems.append(f"{pending} clips waiting to upload")
        if p.get("freeMb") is not None and p["freeMb"] < 1000:
            bits.append(f"{p['freeMb']} MB free")
            level = "warn" if level == "ok" else level
            problems.append(f"only {p['freeMb']} MB free")
        if p.get("cameraError"):
            bits.append(f"camera: {p['cameraError']}")
            level = "bad"
            problems.insert(0, f"camera: {p['cameraError']}")
        if p.get("busy"):
            bits.append(p["busy"])
        if p.get("speaks"):
            bits.append("speaks")
        return {**row, "level": level, "text": " · ".join(bits), "problem": ", ".join(problems) or None}

    def _square_row(self, now: float, last_shot: float | None) -> dict:
        row = {"key": "square", "label": "Square"}
        if not last_shot and self.relay and self.relay["hb"].get("lastShotAt"):
            try:   # the watcher's own record of it (Square's app, before the server got any)
                last_shot = datetime.fromisoformat(self.relay["hb"]["lastShotAt"]).timestamp()
            except ValueError:
                pass
        shot = f"last shot {ago(now - last_shot)}" if last_shot else "no shots yet"
        if self.relay is None:
            return {**row, "level": "warn", "text": f"no heartbeat from the laptop yet · {shot}"}
        hb, age = self.relay["hb"], now - self.relay["seen"]
        if age > RELAY_GONE_S:
            return {**row, "level": "bad", "text": f"watcher stopped (last heard {ago(age)}) · {shot}"}
        if hb.get("squareRunning") is False:
            return {**row, "level": "bad", "text": f"watcher running, Square app closed · {shot}"}
        return {**row, "level": "ok", "text": f"watcher and Square app running · {shot}"}

    def _framing_row(self, setup_status: dict, phones: dict) -> dict:
        row = {"key": "framing", "label": "Framing"}
        bits, level = [], "ok"
        for a in ANGLES:
            v = (setup_status or {}).get(a)
            if not v:
                # (While recording there are no stills: the first swing's check covers it.)
                if phones[a]["expected"] and not phones[a].get("recording"):
                    bits.append(f"{NAMES[a]}: no camera check yet")
                    level = "warn" if level == "ok" else level
                continue
            live = v.get("age", 99) <= SETUP_LIVE_S
            when = "now" if live else ago(v.get("age"))
            if v.get("ok"):
                bits.append(f"{NAMES[a]} good ({when})")
            else:
                bits.append(f"{NAMES[a]}: {v.get('text', 'check the camera')} ({when})")
                # Only a live check counts: the last still before recording is often the golfer
                # walking away from the ball. While recording, the first swing's check covers it.
                if live:
                    level = "bad"
        if not bits:
            return {**row, "level": "off", "text": "no camera check yet"}
        return {**row, "level": level, "text": " · ".join(bits)}
