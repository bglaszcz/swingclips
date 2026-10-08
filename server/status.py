"""Session status: the phones and the Square watcher report in, the review page starts and stops the
phones, one phone speaks for camera setup, and the first swing of each session gets a spoken check.

- Phones (capture app 0.6): each asks POST /api/phones/<angle>/poll about every 10 s with what it's
  doing (recording, mode, shutter, battery, uploads...). The server holds the request open (a long
  poll) until it has a command or something to say for that phone, so the same request carries
  commands back. The phone answers a command (an ack) on its next poll. A phone that hasn't asked
  for PHONE_GONE_S is gone.
- The Square watcher (or, with Square's GSPro connector, the shot listener) on the sim laptop posts
  POST /api/relay/heartbeat.
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
# The Square watcher's (or shot listener's) heartbeat: gone after this long.
RELAY_GONE_S = 90
# A phone seen this recently is expected in the session (Ready needs it recording).
EXPECTED_S = 12 * 3600
# A command not answered in this long is "no answer" (and no longer delivered).
COMMAND_TIMEOUT_S = 20
# Start recording asks for the session to record: a phone that wasn't there (app closed or in the
# background) is started when it reports in, until recording has stopped this long, or it's stopped.
WANT_S = 3600
# At most one automatic start per phone this often (one that fails isn't retried on every poll).
AUTO_START_EVERY_S = 30
COMMANDS_KEPT = 20
# Something to say that hasn't been picked up in this long is dropped: it's out of date.
SAY_WITHIN_S = 20
# A setup verdict older than this is from a phone that stopped sending stills (setup.js's SETUP_STALE_S).
SETUP_LIVE_S = 5
# While one phone speaks the other doesn't listen for strikes (the capture app mutes only its own
# listener, so the other phone heard the voice as a strike and recorded a clip of nobody). The
# server tells the other phone as it sends the sentence, before the voice starts; a phone that
# reports "speaking" (0.9 on) then says when it really stopped. Until its report comes (a poke,
# well under TALK_REPORT_S), and for older apps the whole estimated sentence, it's taken as talking.
# The listener stays quiet TALK_TAIL_S past the end (room echo), and at most TALK_MAX_S past the
# speaking phone's last report (one that drops off mid-sentence doesn't deafen the other for good).
TALK_START_S, TALK_S_PER_WORD, TALK_REPORT_S, TALK_TAIL_S, TALK_MAX_S = 0.5, 0.4, 2.0, 1.5, 30.0
# A combined setup sentence is said once it has held this long (not every flicker).
HOLD_S = 1.5
# Ready panel: amber below this battery (%) when not charging; spoken below LOW_BATTERY_SAY.
LOW_BATTERY = 20
LOW_BATTERY_SAY = 10
# Clips waiting on a phone: amber (and spoken during a session) from this many.
PENDING_WARN = 3
# Swings waiting for pose: amber from this many.
POSE_BEHIND = 3

# Health check timing, as practice.py's: a Square shot comes 6-16 s after the strike (given up at
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
# The other way round: Square shots the phones didn't record (soft strikes under the sound trigger:
# 40-yard wedges, Oct 8). A shot counts as missed once it's this old with no clip paired to it (the
# clip uploads within ~20 s of the strike; Square reports 6-16 s after it); said at this many in a row.
MISSED_WAIT_S = 45.0
MISSED_TO_SAY = 2

# The phones' strike trigger (capture app 0.12, Trigger.kt): a sensitivity of 0-120 sets the level a
# strike's sound must pass (the meter's units). Each phone reports the loud, sudden sounds it heard
# and what came of each ("strike", or why not: "quiet" = under the threshold, "notSudden",
# "cooldown", "ownVoice", "otherTalking"); kept this long, by the server's clock.
SENSITIVITY_MAX = 120
SOUNDS_KEEP_S = 1800.0
# A missed Square shot's strike is looked for this long before the shot came (Square reports 6-16 s
# after the strike; the phones stamp sounds on the server's clock, give or take the Wi-Fi).
STRIKE_BEFORE_SHOT_S = (3.0, 20.0)
# A sensitivity set on the Start page waits this long for the phone to take it.
SENSITIVITY_WAIT_S = 60.0
SOUND_WHY = {"quiet": "too quiet for its sensitivity", "notSudden": "not sudden enough (the room was loud just before)",
             "cooldown": "within 3 s of the last strike", "ownVoice": "it was talking",
             "otherTalking": "the other phone was talking", "strike": "it went off"}


def threshold_for(sensitivity: int) -> float:
    """The level a strike must pass at this sensitivity (Trigger.thresholdFor in the capture app)."""
    if sensitivity <= 100:
        return 150 - sensitivity / 100 * 140
    return 10 - (sensitivity - 100) * 0.4


def sensitivity_for(level: float) -> int | None:
    """The lowest sensitivity, in steps of 5, that a sound this loud would set off with a little room
    to spare (its threshold at 80% of the level); None when even the top won't."""
    for v in range(0, SENSITIVITY_MAX + 1, 5):
        if threshold_for(v) <= level * 0.8:
            return v
    return None

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
    "saved": int, "closing": bool, "speaking": bool, "pre": int,
    "sensitivity": int, "threshold": float, "noise": float,
}
RELAY_FIELDS = {"source": str, "squareRunning": bool, "lastShotAt": str, "version": str,
                "monitorConnected": bool, "monitorReady": bool}
# The shot listener's heartbeat source (relay/shot-listener.ps1): shots from Square's GSPro connector.
LISTENER = "shot-listener"

# The sim laptop launcher agent (relay/golf-agent.ps1).
AGENT_FIELDS = {
    "squareRunning": bool, "watcherRunning": bool, "connectorRunning": bool,
    "listenerRunning": bool, "source": str, "version": str, "computer": str,
    "lastAction": str, "lastResult": str,
}
# Fixed named actions the server may queue for the laptop agent.
AGENT_ACTIONS = {
    "start_square", "stop_square", "start_watcher", "stop_watcher",
    "switch_source", "start_gspro", "stop_gspro", "open_start",
}
# Agent seen within this many seconds is considered live.
AGENT_TIMEOUT_S = 30.0
# Agent command waiting without answer is marked failed after this many seconds.
AGENT_COMMAND_TIMEOUT_S = 30.0


def relay_name(hb: dict | None) -> str:
    return "the shot listener" if hb and hb.get("source") == LISTENER else "the Square watcher"


def clean(body: dict, fields: dict) -> dict:
    out = {}
    for k, kind in fields.items():
        v = body.get(k)
        if v is None:
            continue
        if kind is int and isinstance(v, (int, float)) and not isinstance(v, bool):
            out[k] = int(v)
        elif kind is float and isinstance(v, (int, float)) and not isinstance(v, bool):
            out[k] = round(float(v), 1)
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


def phantom(swing: dict, record: dict | None) -> bool:
    """A clip with nobody swinging: one phone alone recorded it (no partner), no swing was found in it
    and Square has no shot for it. Usually the other phone speaking set this one off (its listener
    heard the voice as a strike). Not a swing: practice mode doesn't speak about it and the health
    check doesn't count it; each would speak, and set off the next one (a loop)."""
    q = (record or {}).get("quality") or {}
    return not swing.get("partner") and not swing.get("shot") and q.get("swingFound") is False


def swing_findings(s: dict, expect_dtl: bool, relay_ok: bool, relay: str = "the Square watcher") -> dict:
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
        out["square"] = "No Square shot" + ("" if relay_ok else f": {relay} isn't running")
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
        # Each swing checked, what was found, the streaks after it and what was said about it,
        # for the server's events log (app.py drains it: Status.drain_events).
        self.notes: list[dict] = []
        # Square shots with no clip, in a row (shots_step).
        self.shots_seen: set[float] = set()
        self.missed = 0
        self.missed_said = False
        self.missed_times: list[float] = []   # the missed shots in a row, when each came

    def new_session(self, t: float) -> None:
        self.start, self.first, self.last = t, None, None
        self.checked, self.checked_times, self.streaks, self.active = set(), [], {}, set()
        self.shots_seen, self.missed, self.missed_said, self.missed_times = set(), 0, False, []

    def shots_step(self, shots: list[dict], now: float, hint=None) -> list[str]:
        """Square shots of the session ({t: when it came, clipped: a clip is paired with it}), oldest
        first: counts the ones in a row the phones didn't record; says so once at MISSED_TO_SAY, and once
        when they're heard again. hint(missed shot times) -> what to do about it (Status.missed_hint).
        Returns what to say."""
        if self.start is None:
            return []
        out = []
        for s in sorted(shots, key=lambda s: s["t"]):
            if s["t"] < self.start - PAIR_SLACK_S or s["t"] in self.shots_seen:
                continue
            if not s["clipped"] and now - s["t"] < MISSED_WAIT_S:
                break  # its clip may still be on its way; later shots wait for it
            self.shots_seen.add(s["t"])
            if s["clipped"]:
                if self.missed_said:
                    out.append("The phones are hearing the shots again.")
                self.missed, self.missed_said, self.missed_times = 0, False, []
                continue
            self.missed += 1
            self.missed_times = (self.missed_times + [s["t"]])[-10:]
            if self.missed >= MISSED_TO_SAY and not self.missed_said:
                self.missed_said = True
                todo = (hint and hint(self.missed_times)) or \
                    "Soft shots can be too quiet to set them off: turn the sensitivity up on the Start page."
                out.append(f"The phones missed the last {self.missed} Square shots. {todo}")
            self.notes.append({"kind": "missed", "shotAt": s["t"], "inRow": self.missed})
            del self.notes[:-200]
        return out

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

    def step(self, swings: list[dict], now: float, expect_dtl: bool, relay_ok: bool,
             relay: str = "the Square watcher") -> list[str]:
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
            if phantom(s, s.get("record")):
                # Not a swing: not said, not counted, and it doesn't clear a streak either.
                self.notes.append({"kind": "check", "clip": s["name"], "angle": s.get("angle"),
                                   "age": round(now - s["t"], 1), "ignored": "phantom: one phone, no swing, no Square shot"})
                continue
            self.checked_times.append(s["t"])
            f = swing_findings(s, expect_dtl, relay_ok, relay)
            self.last = {"clip": s["name"], "t": s["t"], **f}
            first = self.first is None
            if first:
                text = first_swing_sentence(f)
                self.first = {"clip": s["name"], "t": s["t"], "text": text, "ok": text.startswith("First swing:")}
                said = [text]
                # What was said just now isn't said again unless it clears and comes back.
                for key in self._keys(f):
                    self.streaks[key] = STREAK_TO_SAY[key.split(":")[0]]
                    self.active.add(key)
            else:
                said = self._later(f)
            out += said
            self.notes.append({"kind": "check", "clip": s["name"], "angle": s.get("angle"),
                               "partner": s.get("partner"), "shot": bool(s.get("shot")),
                               "age": round(now - s["t"], 1), "first": first, "problems": list(self._keys(f)),
                               "streaks": dict(self.streaks), "said": said})
            del self.notes[:-200]
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
                if key in self.active:
                    self.active.discard(key)
                    # A problem said (on the first swing or later) that's gone: say so once.
                    if key == "square":
                        out.append("Square paired now.")
                    elif not any(k.split(":")[:2] == key.split(":")[:2] for k in keys):
                        good = f"{NAMES[key.split(':')[1]]} looks good now."
                        if good not in out:
                            out.append(good)
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
        self.lock = threading.RLock()
        self.phones: dict[str, dict] = {}    # angle -> {"hb": fields, "seen": t}
        self.notes: list[dict] = []          # session starts, for the events log (drain_events)
        self.relays: dict[str, dict] = {}   # by source: {"hb": fields, "seen": t}
        self.agent: dict | None = None       # sim laptop launcher agent: {"hb": fields, "seen": t}
        self.agent_commands: list[dict] = []
        self.commands: list[dict] = []
        self.outbox: dict[str, list[dict]] = {a: [] for a in ANGLES}
        self.voice = CombinedVoice()
        self.health = Health()
        self.combined: dict | None = None    # the last combined setup sentence: {"text", "t", "to"}
        self.spoken: list[dict] = []         # recent health sentences, for the panel
        self.phone_problems: set[str] = set()
        self.last_recording = 0.0
        self.last_id = 0
        # Talking: angle -> {"sent": t, "words": n} (the latest sentence sent to it), "stopped": t
        # (when it reported it had stopped); quiet_sent: angle -> the quiet-until it was last told.
        self.talk: dict[str, dict] = {a: {"sent": 0.0, "words": 0, "stopped": 0.0} for a in ANGLES}
        self.quiet_sent: dict[str, float] = {a: 0.0 for a in ANGLES}
        # Seconds each phone should keep before the strike (more during a drill, drills.py), and what
        # each was last told; phones from 0.10 report theirs as "pre".
        self.pre_wanted = 2
        # Recording asked for (Start recording): angle -> when; and each phone's last automatic start.
        self.want: dict[str, float] = {}
        self.auto_started: dict[str, float] = {}
        self.pre_sent: dict[str, int | None] = {a: None for a in ANGLES}
        # The strike trigger: each phone's loud, sudden sounds by when (server s), and a sensitivity
        # set on the Start page that the phone hasn't taken yet: angle -> {"v", "t", "sent"}.
        self.sounds: dict[str, dict[float, dict]] = {a: {} for a in ANGLES}
        self.sens_wanted: dict[str, dict] = {}

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

    def recording(self, now: float | None = None) -> bool:
        """Whether a phone is recording now (the server's session check, app.session_on)."""
        with self.lock:
            return bool(self._recording(self.clock() if now is None else now))

    def heartbeat(self, angle: str, body: dict) -> None:
        """A phone's poll: what it's doing, and its answers to commands."""
        now = self.clock()
        with self.lock:
            # Recording lately, by what each phone last said (one that dropped off the Wi-Fi for a
            # minute and comes back recording is the same session).
            before = now - self.last_recording <= SESSION_TAIL_S and any(
                p["hb"].get("recording") and not p["hb"].get("closing") for p in self.phones.values())
            old = self.phones.get(angle, {}).get("hb", {})
            was = old.get("speaking")
            self.phones[angle] = {"hb": clean(body, PHONE_FIELDS), "seen": now}
            if self.phones[angle]["hb"].get("pre") != old.get("pre"):
                self.pre_sent[angle] = None   # it changed on its own (the app restarted): tell it again
            self._keep_sounds(angle, body.get("sounds"), now)
            w = self.sens_wanted.get(angle)
            if w and (self.phones[angle]["hb"].get("sensitivity") == w["v"] or now - w["t"] > SENSITIVITY_WAIT_S):
                self.sens_wanted.pop(angle)
            self._start_if_wanted(angle, old, now)
            if was and not self.phones[angle]["hb"].get("speaking"):
                self.talk[angle]["stopped"] = now
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
                    self.notes.append({"kind": "session", "by": angle,
                                       "sinceRecording": round(now - self.last_recording, 1) if self.last_recording else None})
                self.last_recording = now

    def _keep_sounds(self, angle: str, sounds, now: float) -> None:
        """A phone's loud, sudden sounds of the last 2 minutes ({ms, level, jump, result}): kept by when."""
        keep = self.sounds[angle]
        for x in sounds if isinstance(sounds, list) else []:
            if not isinstance(x, dict):
                continue
            ms, level, jump = x.get("ms"), x.get("level"), x.get("jump")
            if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (ms, level, jump)):
                continue
            result = x.get("result") if x.get("result") in SOUND_WHY else "quiet"
            t = round(ms / 1000, 3)
            keep[t] = {"t": t, "level": round(float(level), 1), "jump": round(float(jump), 1), "result": result}
        for t in [t for t in keep if now - t > SOUNDS_KEEP_S]:
            del keep[t]

    def heard(self, angle: str, start: float, end: float) -> list[dict]:
        """Phone `angle`'s loud, sudden sounds between two times (server s), oldest first."""
        with self.lock:
            return sorted((x for t, x in self.sounds[angle].items() if start <= t <= end), key=lambda x: x["t"])

    def set_sensitivity(self, target: str, value: int) -> list[dict]:
        """The strike trigger's sensitivity for one phone ("face", "dtl") or both, from the Start page:
        each phone takes it on its next poll, recording or not. Each phone's outcome: sent or why not."""
        if target not in ANGLES + ("both",):
            raise ValueError("Unknown phone")
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= SENSITIVITY_MAX:
            raise ValueError(f"Sensitivity goes from 0 to {SENSITIVITY_MAX}")
        now = self.clock()
        with self.lock:
            out = []
            for a in [target] if target != "both" else ANGLES:
                hb = (self.phones.get(a) or {}).get("hb", {})
                if not self.connected(a, now):
                    if target != "both":
                        out.append({"angle": a, "error": "not connected (is the app open?)"})
                    continue
                if "sensitivity" not in hb:
                    out.append({"angle": a, "error": "its app is too old to set this from here: update it"})
                    continue
                if hb["sensitivity"] == value:
                    self.sens_wanted.pop(a, None)
                else:
                    self.sens_wanted[a] = {"v": value, "t": now, "sent": False}
                out.append({"angle": a, "error": None})
            return out

    def _sens_news(self, angle: str) -> int | None:
        w = self.sens_wanted.get(angle)
        return w["v"] if w and not w["sent"] else None

    def trigger(self, angle: str) -> dict | None:
        """Phone `angle`'s strike trigger for the Start page: sensitivity, threshold, the room's noise,
        its strikes over the last half hour (how many, the softest, the middle one) and a sensitivity
        on its way to it. None for apps before 0.12."""
        hb = (self.phones.get(angle) or {}).get("hb", {})
        if "sensitivity" not in hb:
            return None
        strikes = sorted(x["level"] for x in self.sounds[angle].values() if x["result"] == "strike")
        w = self.sens_wanted.get(angle)
        return {"sensitivity": hb["sensitivity"], "threshold": hb.get("threshold"), "noise": hb.get("noise"),
                "strikes": len(strikes), "softest": strikes[0] if strikes else None,
                "middle": strikes[len(strikes) // 2] if strikes else None,
                "setting": w and w["v"]}

    def missed_check(self, times: list[float]) -> dict:
        """What each phone heard just before the missed Square shots (when each came, server s):
        {angle: {"heard": how many had a sound, "loudest": level, "why": the loudest one's result,
        "softest": the softest one too quiet for the trigger, "suggest": a sensitivity that would have
        caught them, or None}}. Phones with apps before 0.12 (no sounds reported) are left out."""
        out = {}
        with self.lock:
            for a in ANGLES:
                hb = (self.phones.get(a) or {}).get("hb", {})
                if "sensitivity" not in hb:
                    continue
                best = []
                for t in times:
                    near = [x for x in self.sounds[a].values()
                            if t - STRIKE_BEFORE_SHOT_S[1] <= x["t"] <= t - STRIKE_BEFORE_SHOT_S[0]]
                    if near:
                        best.append(max(near, key=lambda x: x["level"]))
                if not best:
                    out[a] = {"heard": 0, "loudest": None, "why": None, "softest": None, "suggest": None}
                    continue
                quiet = [x["level"] for x in best if x["result"] == "quiet"]
                top = max(best, key=lambda x: x["level"])
                suggest = None
                if quiet:
                    # Enough for the softest one heard as too quiet (the top if nothing is), only ever up.
                    want = sensitivity_for(min(quiet))
                    want = SENSITIVITY_MAX if want is None else want
                    suggest = want if want > hb["sensitivity"] else None
                out[a] = {"heard": len(best), "loudest": top["level"], "why": top["result"],
                          "softest": min(quiet) if quiet else None, "suggest": suggest}
        return out

    def missed_hint(self, times: list[float]) -> str | None:
        """What to do about missed shots, said by the speaking phone (None: the general advice)."""
        check = self.missed_check(times)
        ups = [f"{NAMES[a].lower()} to {c['suggest']}" for a, c in check.items() if c["suggest"]]
        if ups:
            return "They were too quiet for the sensitivity: on the Start page, set " + " and ".join(ups) + "."
        if check and all(c["heard"] == 0 for c in check.values()):
            return "The phones heard nothing sudden then: check they're near the mat and nothing covers them."
        return None

    def _start_if_wanted(self, angle: str, old: dict, now: float) -> None:
        """Starts phone `angle` if recording was asked for and it isn't: its app was closed or in the
        background when Start was pressed, or it has come back since. Stopped on the phone itself
        (recording, then not, with the app open): left alone. Call with the lock held."""
        hb = self.phones[angle]["hb"]
        if old.get("recording") and not hb.get("recording") and not old.get("closing") and not hb.get("closing"):
            self.want.pop(angle, None)
        w = self.want.get(angle)
        if w is None:
            return
        if now - max(w, self.last_recording) > WANT_S:
            self.want.pop(angle, None)
            return
        if hb.get("recording") or hb.get("closing") or hb.get("busy") or hb.get("cameraError"):
            return
        if now - self.auto_started.get(angle, 0.0) < AUTO_START_EVERY_S:
            return
        self._expire(now)
        if any(c["angle"] == angle and c["action"] == "start" and c["state"] in ("queued", "sent") for c in self.commands):
            return
        self.auto_started[angle] = now
        self.commands.append({"id": self._id(), "angle": angle, "action": "start", "made": now, "state": "queued",
                              "error": None, "sent": None, "answered": None, "auto": True})
        self.commands = self.commands[-COMMANDS_KEPT:]
        self.notes.append({"kind": "autostart", "angle": angle})

    def drain_events(self) -> list[dict]:
        """Session starts and each swing the health check looked at, since the last call (app.py logs them)."""
        with self.lock:
            out = self.notes + self.health.notes
            self.notes, self.health.notes = [], []
            return out

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

    def talked(self, angle: str, text: str) -> None:
        """A sentence went out to phone `angle` to say (its poll or the practice feed): the other
        phone stops listening for strikes (see TALK_*); has_mail wakes its poll to tell it."""
        with self.lock:
            self.talk[angle].update(sent=self.clock(), words=len(text.split()))

    def _quiet_until(self, angle: str, now: float) -> float:
        """Until when phone `angle` shouldn't listen for strikes: the other phone is talking."""
        out = 0.0
        for other in ANGLES:
            if other == angle:
                continue
            t = self.talk[other]
            p = self.phones.get(other)
            hb = p["hb"] if p and not p["hb"].get("closing") else {}
            if "speaking" in hb:
                out = max(out, t["sent"] + TALK_START_S + TALK_REPORT_S, t["stopped"] + TALK_TAIL_S)
                if hb["speaking"]:
                    out = max(out, p["seen"] + TALK_MAX_S)
            elif t["words"]:   # an older app: the whole sentence, estimated
                out = max(out, t["sent"] + TALK_START_S + TALK_S_PER_WORD * t["words"] + TALK_TAIL_S)
        return out

    def _quiet_news(self, angle: str, now: float) -> float | None:
        """A new quiet-until for phone `angle` that it hasn't been told (None if nothing new)."""
        q = self._quiet_until(angle, now)
        if abs(q - self.quiet_sent[angle]) > 0.01 and max(q, self.quiet_sent[angle]) > now:
            return q
        return None

    def set_pre(self, seconds: int) -> None:
        """How many seconds the phones should keep before the strike (drills.py); each is told on its poll."""
        with self.lock:
            if seconds != self.pre_wanted:
                self.pre_wanted = seconds
                self.pre_sent = {a: None for a in ANGLES}

    def _pre_news(self, angle: str) -> int | None:
        """The pre-strike seconds phone `angle` should switch to and hasn't been told (None if nothing)."""
        p = self.phones.get(angle)
        hb = p["hb"] if p else {}
        if "pre" in hb and hb["pre"] != self.pre_wanted and self.pre_sent[angle] != self.pre_wanted:
            return self.pre_wanted
        return None

    def has_mail(self, angle: str) -> bool:
        now = self.clock()
        with self.lock:
            self._expire(now)
            return any(c["angle"] == angle and c["state"] == "queued" for c in self.commands) or \
                any(now - x["made"] <= SAY_WITHIN_S for x in self.outbox[angle]) or \
                self._quiet_news(angle, now) is not None or self._pre_news(angle) is not None or \
                self._sens_news(angle) is not None

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
            out = {"commands": cmds, "say": say, "ms": int(now * 1000)}
            q = self._quiet_news(angle, now)
            if q is not None:
                # Seconds from now (the phones' clocks aren't the server's); 0 = listen again.
                self.quiet_sent[angle] = q
                out["quiet"] = round(max(0.0, q - now), 2)
            pre = self._pre_news(angle)
            if pre is not None:
                self.pre_sent[angle] = pre
                out["pre"] = pre
            sens = self._sens_news(angle)
            if sens is not None:
                self.sens_wanted[angle]["sent"] = True
                out["sensitivity"] = sens
            return out

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
            # Start asks for the session to record: phones not here yet start when they report in.
            for a in ([target] if target != "both" else ANGLES):
                if action == "start":
                    self.want[a] = now
                else:
                    self.want.pop(a, None)
            out = []
            for a in angles:
                c = {"id": self._id(), "angle": a, "action": action, "made": now, "state": "queued",
                     "error": None, "sent": None, "answered": None}
                hb = (self.phones.get(a) or {}).get("hb", {})
                if not self.connected(a, now):
                    c.update(state="failed", error="not connected: it starts when its app is open"
                             if action == "start" else "not connected (is the app open?)")
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

    # ---- The Square watcher, or the shot listener ----

    def relay_heartbeat(self, body: dict) -> dict:
        with self.lock:
            hb = clean(body, RELAY_FIELDS)
            self.relays[hb.get("source", "")] = {"hb": hb, "seen": self.clock()}
            return dict(hb)

    @property
    def relay(self) -> dict | None:
        """The laptop's relay in use: normally only one runs. If both do, the shot listener while
        the connector is connected to it, else the Square watcher; if none is heard from, the latest."""
        if not self.relays:
            return None
        now = self.clock()
        live = [r for r in self.relays.values() if now - r["seen"] <= RELAY_GONE_S]
        if not live:
            return max(self.relays.values(), key=lambda r: r["seen"])
        return max(live, key=lambda r: (r["hb"].get("source") == LISTENER and bool(r["hb"].get("monitorConnected")),
                                        r["hb"].get("source") != LISTENER, r["seen"]))

    def relay_ok(self, now: float) -> bool:
        return self.relay is not None and now - self.relay["seen"] <= RELAY_GONE_S

    # ---- The sim laptop launcher agent ----

    def agent_heartbeat(self, body: dict) -> dict:
        now = self.clock()
        with self.lock:
            hb = clean(body, AGENT_FIELDS)
            self.agent = {"hb": hb, "seen": now}
            self._expire_agent(now)
            if hb.get("lastAction"):
                for c in self.agent_commands:
                    if c["action"] == hb["lastAction"] and c["state"] == "sent":
                        c.update(state="completed", result=hb.get("lastResult"))
            return dict(hb)

    def has_agent_mail(self) -> bool:
        now = self.clock()
        with self.lock:
            self._expire_agent(now)
            return any(c["state"] == "queued" for c in self.agent_commands)

    def take_agent_mail(self) -> dict:
        now = self.clock()
        with self.lock:
            self._expire_agent(now)
            cmds = []
            for c in self.agent_commands:
                if c["state"] == "queued":
                    c["state"], c["sent"] = "sent", now
                    cmd_dict = {"id": c["id"], "action": c["action"]}
                    if c.get("params"):
                        cmd_dict.update(c["params"])
                    cmds.append(cmd_dict)
            return {"commands": cmds, "ms": int(now * 1000)}

    def agent_command(self, action: str, **params) -> dict:
        if action not in AGENT_ACTIONS:
            raise ValueError(f"Unknown or disallowed action: {action!r}")
        if action == "switch_source" and params.get("source"):
            if params["source"] not in ("square", "gspro"):
                raise ValueError(f"Invalid shot source: {params['source']!r}")
        now = self.clock()
        with self.lock:
            self._expire_agent(now)
            cid = str(self._id())
            c = {
                "id": cid,
                "action": action,
                "params": {k: v for k, v in params.items() if k in ("source",) and v is not None},
                "state": "queued",
                "made": now,
                "sent": None,
                "error": None,
            }
            for old in self.agent_commands:
                if old["state"] == "queued" and old["action"] == action:
                    old.update(state="superseded", error="replaced by newer command")
            self.agent_commands.append(c)
            self.agent_commands = self.agent_commands[-COMMANDS_KEPT:]
            return {"id": cid, "action": action, "state": "queued"}

    def _expire_agent(self, now: float) -> None:
        for c in self.agent_commands:
            if c["state"] in ("queued", "sent") and now - c["made"] > AGENT_COMMAND_TIMEOUT_S:
                c.update(state="failed", error="no answer from the launcher agent")

    def _agent_snapshot(self, now: float) -> dict:
        self._expire_agent(now)
        a = self.agent
        connected = bool(a and (now - a["seen"] <= AGENT_TIMEOUT_S))
        hb = dict(a["hb"]) if a else {}
        age = round(now - a["seen"], 1) if a else None
        cmds = [{k: c[k] for k in ("id", "action", "state", "error") if k in c} for c in self.agent_commands[-5:]]
        return {
            **hb,
            "connected": connected,
            "age": age,
            "commands": cmds,
        }

    def agent_snapshot(self, now: float) -> dict:
        with self.lock:
            return self._agent_snapshot(now)

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

    def health_step(self, swings: list[dict], shots: list[dict] | None = None) -> list[str]:
        """The session's swings (see Health.step) and Square shots (Health.shots_step); queues what to
        say for the speaking phone."""
        now = self.clock()
        with self.lock:
            recording = self._recording(now)
            expect_dtl = "dtl" in recording
            relay = self.relay
            said = self.health.step(swings, now, expect_dtl, self.relay_ok(now), relay_name(relay and relay["hb"]))
            if shots is not None:
                said += self.health.shots_step(shots, now, self.missed_hint)
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
        setup_status: setup.Setup.status(); pose: {"queued", "busy", "deepLeft", "held"}; last_shot: unix s of the last
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
                             "expected": a in expected, "speaks": a == speaker, "trigger": self.trigger(a),
                             "command": cmd and {k: cmd[k] for k in ("id", "action", "state", "error")}
                             | {"age": round(now - cmd["made"], 1)}}
                rows.append(self._phone_row(a, phones[a], now))
            rows.append(self._square_row(now, last_shot))
            rows.append(self._framing_row(setup_status, phones))
            if self.health.first:
                f = self.health.first
                rows.append({"key": "first", "label": "First swing", "level": "ok" if f["ok"] else "warn",
                             "text": f["text"]})
            if self.health.missed >= MISSED_TO_SAY:
                rows.append(self._missed_row())
            queued = pose.get("queued") or 0
            deep_left = pose.get("deepLeft") or 0
            if pose.get("held"):
                # SWINGCLIPS_DURING_SESSION=wait: clips waiting is how it should be until the session ends.
                text, level = f"Recording only: {queued} clip{'s' if queued != 1 else ''} to analyze after the session", "ok"
            elif queued:
                text = f"Pose: {queued} clip{'s' if queued != 1 else ''} waiting" + (" (working on one)" if pose.get("busy") else "")
                level = "ok" if queued < POSE_BEHIND else "warn"
            else:
                text, level = "Pose: up to date", "ok"
                if deep_left:
                    text += f"; deep pass: {deep_left} clip{'s' if deep_left != 1 else ''} to go"
            rows.append({"key": "server", "label": "Server", "level": level, "text": text})
            levels = [r["level"] for r in rows if r["level"] != "off"]
            level = "bad" if "bad" in levels else "warn" if "warn" in levels else "ok"
            first_bad = next((r for r in rows if r["level"] == "bad"), None) or next((r for r in rows if r["level"] == "warn"), None)
            return {
                "level": level,
                "headline": "Ready" if level == "ok" else f"{first_bad['label']}: {first_bad.get('problem') or first_bad['text']}",
                "rows": rows, "phones": phones, "speaker": speaker,
                "relay": (relay := self.relay) and {**relay["hb"], "age": round(now - relay["seen"], 1)},
                "agent": self._agent_snapshot(now),
                "combined": self.combined and {**self.combined, "age": round(now - self.combined["t"], 1)},
                "session": {"start": self.health.start, "first": self.health.first, "last": self.health.last,
                            "spoken": [{**s, "age": round(now - s["t"], 1)} for s in self.spoken]},
                "commands": [{k: c[k] for k in ("id", "angle", "action", "state", "error")} for c in self.commands[-6:]],
            }

    def _missed_row(self) -> dict:
        """Square shots the phones didn't record, and what each phone heard just before them."""
        n = self.health.missed
        check = self.missed_check(self.health.missed_times)
        bits = []
        for a, c in check.items():
            name = NAMES[a]
            if not c["heard"]:
                bits.append(f"{name} heard nothing sudden then")
            elif c["softest"] is not None:
                bits.append(f"{name} heard them at {c['softest']:g}, its trigger is at "
                            f"{threshold_for(self.phones[a]['hb']['sensitivity']):g}"
                            + (f": set it to {c['suggest']}" if c["suggest"] else ""))
            elif c["why"] == "strike":
                bits.append(f"{name} went off (its clip may not have reached the server)")
            else:
                bits.append(f"{name} heard a sound at {c['loudest']:g} but {SOUND_WHY[c['why']]}")
        text = f"{n} Square shots in a row with no swing recorded. " + (
            "; ".join(bits) + "." if bits else "Soft strikes may be too quiet: turn the sensitivity up.")
        return {"key": "missed", "label": "Missed shots", "level": "warn", "text": text,
                "suggest": {a: c["suggest"] for a, c in check.items() if c["suggest"]}}

    def _phone_row(self, a: str, p: dict, now: float) -> dict:
        row = {"key": a, "label": NAMES[a], "angle": a}
        if p["age"] is None:
            return {**row, "level": "off", "text": "not seen (open the SwingClips app on this phone)"}
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
        tr = p.get("trigger")
        if tr:
            bits.append(f"sensitivity {tr['sensitivity']}" + (f" (strikes from {tr['softest']:g}, trigger at "
                                                              f"{threshold_for(tr['sensitivity']):g})" if tr["strikes"] else ""))
        return {**row, "level": level, "text": " · ".join(bits), "problem": ", ".join(problems) or None}

    def _square_row(self, now: float, last_shot: float | None) -> dict:
        row = {"key": "square", "label": "Square"}
        relay = self.relay
        if not last_shot and relay and relay["hb"].get("lastShotAt"):
            try:   # the watcher's own record of it (Square's app, before the server got any)
                last_shot = datetime.fromisoformat(relay["hb"]["lastShotAt"]).timestamp()
            except ValueError:
                pass
        shot = f"last shot {ago(now - last_shot)}" if last_shot else "no shots yet"
        if relay is None:
            if self.agent and (now - self.agent["seen"] <= AGENT_TIMEOUT_S):
                ahb = self.agent["hb"]
                if not ahb.get("watcherRunning") and not ahb.get("listenerRunning"):
                    return {**row, "level": "bad", "text": f"launcher agent connected, watcher not started · {shot}",
                            "problem": "Square watcher not started"}
            return {**row, "level": "warn", "text": f"no heartbeat from the laptop yet · {shot}"}
        hb, age = relay["hb"], now - relay["seen"]
        if hb.get("source") == LISTENER:
            row["label"] = "Square (GSPro connector)"
            if age > RELAY_GONE_S:
                return {**row, "level": "bad", "text": f"shot listener stopped (last heard {ago(age)}) · {shot}"}
            if not hb.get("monitorConnected"):
                why = ": close Square Golf's app" if hb.get("squareRunning") else ": open SQG GSPro Connect"
                return {**row, "level": "bad", "text": f"listener running, connector not connected{why} · {shot}",
                        "problem": f"connector not connected{why}"}
            ball = "ball ready" if hb.get("monitorReady") else "waiting for a ball"
            return {**row, "level": "ok", "text": f"listener and connector running, {ball} · {shot}"}
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
