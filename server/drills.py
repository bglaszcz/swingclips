"""Drill mode: a set of drill swings, such as the pump drill (to the top, pump the hands down to the
trail pocket twice, then swing through). While a drill is on, the phones keep more video before the
strike (the pumps come seconds before it; see status.py pre), and the swings recorded are tagged with
the drill: app.py leaves them out of the trends, good-shot ranges and noise table, since a rehearsal
swing isn't the golfer's usual swing.

This file keeps the drill that's on and the stretches of time each drill was on (drills.json), so a
clip is tagged by when it was recorded, whenever it's listed. A drill ends when turned off, or after
IDLE_END_S without the phones recording (a drill left on after the session shouldn't tag the next one).

The golfer can also say it after the fact, clip by clip (marks): these swings were the pump drill (it
wasn't switched on), or these were no drill (it was left on). A mark beats the time. A swing marked
afterwards was recorded with the usual lead-in, so a long drill may have started before its video does.
"""
import json
import threading
import time
from pathlib import Path

# id -> name and the seconds each phone keeps before the strike while it's on.
DRILLS = {
    "pump": {"name": "Pump drill", "pre": 6},
    # The coach program's drill blocks (programs.py): rehearsals too, with the usual lead-in.
    "toetap": {"name": "Lead foot only", "pre": 2},
    "stepthrough": {"name": "Step through", "pre": 2},
    "flush": {"name": "Flush line", "pre": 2},
    # Sequence Tier 1 (no ball: nothing should record, but a stray clip stays out of the trends).
    "stepfire": {"name": "Step and fire", "pre": 2},
    "pausetop": {"name": "Pause at the top", "pre": 2},
    # Brace and turn (Oct 6): Tier 1 no ball, Tier 2 at 3/4 speed.
    "braceturn": {"name": "Brace and turn", "pre": 2},
}
# The phones' usual seconds before the strike (capture app MainActivity PRE_S).
PRE_S = 2
IDLE_END_S = 30 * 60
# A mark saying a clip was no drill, though one was on when it was recorded.
NOT_A_DRILL = "none"


class Drills:
    def __init__(self, path: Path, clock=time.time):
        self.path = Path(path)
        self.clock = clock
        self.lock = threading.Lock()
        try:
            doc = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            doc = {}
        cur = doc.get("current")
        self.current: dict | None = cur if isinstance(cur, dict) and cur.get("drill") in DRILLS else None
        self.periods: list[dict] = [p for p in doc.get("periods") or [] if isinstance(p, dict) and p.get("drill") in DRILLS]
        marks = doc.get("marks")
        # clip name -> drill id or NOT_A_DRILL, as said afterwards.
        self.marks: dict[str, str] = {k: v for k, v in (marks if isinstance(marks, dict) else {}).items()
                                      if v == NOT_A_DRILL or v in DRILLS}

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"current": self.current, "periods": self.periods, "marks": self.marks}, indent=1),
                       encoding="utf-8")
        tmp.replace(self.path)

    def _end(self, until: float) -> None:
        if self.current:
            self.periods.append({**self.current, "until": round(until, 3)})
            self.current = None
            self._save()

    def check(self, last_recording: float) -> None:
        """Ends a drill left on: no recording for IDLE_END_S since it started or the phones last recorded."""
        with self.lock:
            if self.current and self.clock() - max(self.current["from"], last_recording) > IDLE_END_S:
                self._end(max(self.current["from"], last_recording))

    def set(self, drill: str | None) -> dict | None:
        """Turns a drill on (ending any other) or off (None). Returns the drill now on."""
        if drill is not None and drill not in DRILLS:
            raise ValueError("Unknown drill")
        with self.lock:
            now = self.clock()
            if self.current and self.current["drill"] == drill:
                return self.current
            self._end(now)
            if drill:
                self.current = {"drill": drill, "from": round(now, 3)}
                self._save()
            return self.current

    def pre(self) -> int:
        """Seconds the phones should keep before the strike now."""
        with self.lock:
            return DRILLS[self.current["drill"]]["pre"] if self.current else PRE_S

    def drill_at(self, t: float) -> str | None:
        """The drill that was on at time t (s), or None."""
        with self.lock:
            if self.current and t >= self.current["from"]:
                return self.current["drill"]
            for p in self.periods:
                if p["from"] <= t <= p["until"]:
                    return p["drill"]
            return None

    def mark(self, names: list[str], drill: str | None) -> dict[str, str | None]:
        """Says afterwards which drill these clips were (an id), that they were no drill (NOT_A_DRILL),
        or takes that back (None: by the time again). Returns what each was marked before, for an undo."""
        if drill is not None and drill != NOT_A_DRILL and drill not in DRILLS:
            raise ValueError("Unknown drill")
        with self.lock:
            before = {n: self.marks.get(n) for n in names}
            for n in names:
                if drill is None:
                    self.marks.pop(n, None)
                else:
                    self.marks[n] = drill
            self._save()
            return before

    def drill_of(self, name: str, partner: str | None, t: float) -> tuple[str | None, bool]:
        """A clip's drill, and whether that was said afterwards (a mark on it or on its other angle)."""
        with self.lock:
            mark = self.marks.get(name) or (partner and self.marks.get(partner))
        if mark:
            return (None if mark == NOT_A_DRILL else mark), True
        return self.drill_at(t), False

    def state(self) -> dict:
        with self.lock:
            return {"current": self.current, "drills": [{"id": k, **v} for k, v in DRILLS.items()],
                    "periods": self.periods[-20:]}
