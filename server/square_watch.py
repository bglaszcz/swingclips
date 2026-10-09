"""The Square watcher inside the server: for when Square Golf's own Windows app runs on this same PC.

Does what relay/square-watcher.ps1 does on the sim laptop: Square's app saves every shot to a local
SQLite database (SQGDB.bytes); this reads new rows read-only whenever the file changes and hands each
one, as a shot, to the server (app.record_shot), the same as a POST /api/shots from the laptop. It
also reports the same heartbeat as the laptop's watcher (source "square-watcher"), so the Ready panel
shows it. Shots carry no time of their own in there, so each is stamped with the moment it appears;
shots saved while the server was down are skipped, since their time would pair them with the wrong
swings.

SWINGCLIPS_SQUARE_DB: unset = Square's usual place for this Windows user, used only if it's there
(so on a server without Square's app this does nothing); "off" = never; anything else = that file.
Don't also run square-watcher.ps1 on this PC (the server drops a shot number it already has anyway).

Square's units and signs (checked against its CSV export): speeds m/s, distances m; direction,
side, path and face negative = left; spin axis and side spin POSITIVE = left, so those two are
flipped here to match GSPro's convention (positive = right).
"""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

SOURCE = "square-app"
HEARTBEAT_SOURCE = "square-watcher"
POLL_S = 0.5
HEARTBEAT_S = 20.0

# Square's club numbers -> the codes the rest of SwingClips uses (as in square-watcher.ps1; 23, lob
# wedge, is inferred from the order and not yet seen).
CLUB_CODES = {0: "DR", 2: "W3", 9: "H4", 15: "I5", 16: "I6", 17: "I7", 18: "I8", 19: "I9",
              20: "PW", 21: "GW", 22: "SW", 23: "LW", 24: "PT"}

MPH, YD, FT = 2.23694, 1.09361, 3.28084

NEW_SHOTS_SQL = ("select l.ShotID, l.SessionID, l.ClubType, l.Mode, l.ShotData, l.ShotResult, l.ClubData, s.Name "
                 "from IVShotLog l left join IVSession s on s.SessionID = l.SessionID "
                 "where l.ShotID > ? order by l.ShotID")


def default_db() -> Path:
    return Path(os.environ.get("USERPROFILE", str(Path.home()))) / "AppData" / "LocalLow" / "Invant" / "Square Golf" / "SQGDB.bytes"


def configured_db(env: dict | None = None) -> Path | None:
    """The database to watch, or None when the watcher shouldn't run (see SWINGCLIPS_SQUARE_DB)."""
    setting = (os.environ if env is None else env).get("SWINGCLIPS_SQUARE_DB", "").strip()
    if setting.lower() == "off":
        return None
    if setting:
        return Path(setting)
    db = default_db()
    return db if db.is_file() else None


def _round(v: float, d: int = 2) -> float:
    return round(float(v), d)


def _value(obj: dict, name: str, scale: float = 1.0) -> float | None:
    """A reading, or None when Square marks it unreliable (IsValid<name> false) or it's missing."""
    if obj.get("IsValid" + name) is False or not isinstance(obj.get(name), (int, float)):
        return None
    return _round(obj[name] * scale)


def make_shot(row: tuple, received: datetime) -> dict[str, Any]:
    """One IVShotLog row (NEW_SHOTS_SQL's columns) -> a shot as POST /api/shots takes it."""
    shot_id, _session_id, club_type, mode, shot_json, result_json, club_json, session_name = row
    s = json.loads(shot_json)
    r = json.loads(result_json) if result_json else None
    c = json.loads(club_json) if club_json else None
    axis, side_spin = _value(s, "SpinAxis"), _value(s, "SideSpin")
    ball = {
        "speed": _value(s, "Speed", MPH), "vla": _value(s, "Angle"), "hla": _value(s, "Direction"),
        "totalSpin": _value(s, "SpinRate"), "backSpin": _value(s, "BackSpin"),
        "sideSpin": -side_spin if side_spin is not None else None,
        "spinAxis": -axis if axis is not None else None,
        "carry": _round(r["CarryDistance"] * YD, 1) if r else None,
        "total": _round(r["TotalDistance"] * YD, 1) if r else None,
        "side": _round(r["SideError"] * YD, 1) if r else None,
        "apexFt": _round(r["ApexHeight"] * FT, 0) if r else None,
        "landingAngle": _round(r["LandingAngle"], 1) if r else None,
    }
    club_data = None
    if c:
        club_data = {
            "speed": _value(c, "ClubSpeed", MPH), "smash": _value(c, "SmashFactor"),
            "angleOfAttack": _value(c, "AttackAngle"), "faceToTarget": _value(c, "FaceAngle"),
            "path": _value(c, "Path"), "loft": _value(c, "DynamicLoft"),
            "faceImpactH": _value(c, "ImpactHorizontal"), "faceImpactV": _value(c, "ImpactVertical"),
        }
    return {
        "received": received.isoformat(timespec="milliseconds"),
        "source": SOURCE,
        "device": "Square Golf app",
        "shotNumber": int(shot_id),
        "session": session_name,
        "mode": mode,
        "club": CLUB_CODES.get(int(club_type), f"club{club_type}"),
        "ball": ball,
        "clubData": club_data,
    }


def square_running() -> bool:
    """Whether a process with "square" in its name is running (as the laptop's watcher checks)."""
    try:
        out = subprocess.run(["tasklist", "/FO", "CSV", "/NH"], capture_output=True, text=True, timeout=10,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return any("square" in line.split(",")[0].lower() for line in out.splitlines())


class SquareWatcher:
    """Hands each shot Square's app saves after start() to on_shot; on_beat gets the heartbeat."""

    def __init__(self, db: Path, on_shot: Callable[[dict], Any], on_beat: Callable[[dict], Any],
                 is_running: Callable[[], bool] = square_running, now: Callable[[], datetime] | None = None,
                 log: Callable[[str], Any] = lambda text: print(text, flush=True)):
        self.db = Path(db)
        self.on_shot, self.on_beat, self.is_running, self.log = on_shot, on_beat, is_running, log
        self.now = now or (lambda: datetime.now().astimezone())
        self.last_id: int | None = None
        self.last_shot_at: str | None = None
        self.seen: tuple = ()
        self.last_beat = 0.0

    def _query(self, sql: str, args: tuple = ()) -> list[tuple]:
        # Read-only, and wait a little if Square is mid-write rather than fail.
        con = sqlite3.connect(f"{self.db.as_uri()}?mode=ro", uri=True, timeout=2)
        try:
            return con.execute(sql, args).fetchall()
        finally:
            con.close()

    def _stamp(self) -> tuple:
        out = []
        for f in (self.db, Path(str(self.db) + "-journal"), Path(str(self.db) + "-wal")):
            try:
                out.append(f.stat().st_mtime_ns)
            except OSError:
                out.append(None)
        return tuple(out)

    def start(self) -> bool:
        """Notes the newest shot already saved (only later ones are sent). False if unreadable."""
        try:
            self.last_id = int(self._query("select ifnull(max(ShotID), 0) from IVShotLog")[0][0])
        except (sqlite3.Error, OSError) as e:
            self.log(f"Square watcher: can't read {self.db} ({e})")
            return False
        self.seen = self._stamp()
        self.log(f"Square watcher: watching {self.db}; newest shot already saved #{self.last_id}, only later ones are taken")
        return True

    def beat(self, force: bool = False) -> None:
        if not force and time.monotonic() - self.last_beat < HEARTBEAT_S:
            return
        self.last_beat = time.monotonic()
        self.on_beat({"source": HEARTBEAT_SOURCE, "squareRunning": bool(self.is_running()),
                      "lastShotAt": self.last_shot_at, "version": "server"})

    def poll(self) -> list[dict]:
        """One look: the new shots handed on (none if the files haven't changed)."""
        if self.last_id is None and not self.start():
            return []
        stamp = self._stamp()
        if stamp == self.seen:
            return []
        received = self.now()
        try:
            rows = self._query(NEW_SHOTS_SQL, (self.last_id,))
        except (sqlite3.Error, OSError) as e:
            self.log(f"Square watcher: couldn't read Square's database just now ({e}); will try again")
            return []  # self.seen not updated, so the next look tries again
        self.seen = stamp
        sent = []
        for row in rows:
            self.last_id = int(row[0])
            try:
                shot = make_shot(row, received)
            except (ValueError, TypeError, KeyError) as e:
                self.log(f"Square watcher: skipped shot #{self.last_id} (unreadable: {e})")
                continue
            self.last_shot_at = shot["received"]
            self.on_shot(shot)
            sent.append(shot)
        return sent

    def run(self, stop: threading.Event) -> None:
        while not stop.is_set():
            try:
                self.beat(force=bool(self.poll()))  # at once after a shot, so the Ready bar shows it
            except Exception as e:  # keep watching whatever happens to one shot
                self.log(f"Square watcher: {e!r}")
            stop.wait(POLL_S)
