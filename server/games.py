"""Practice games: the phone says a target ("110 yards"), the golfer hits, and once Square's shot
pairs with the swing the phone says how close it finished and the next target. A Combine (a fixed
27-shot test) scored against a tour baseline gives one number to follow over weeks.

Targets and scoring are the review page's static/games.js (SwingGames), run here in V8 as practice.py
runs trust.js, so the page and the server can't disagree. This file keeps the game in play
(game.json), finished games (games-log.jsonl), and the sentences for the speaking phone, which asks
for them together with practice mode's results (GET /api/practice/latest). Starting a game turns
practice mode off (app.py) so the phone doesn't talk over itself.

A swing counts once its shot pairs; a swing whose shot never comes is skipped (the same target is
asked again), since a net session without Square's number can't be scored. A shot Square marks
invalid, or with no carry, is a mishit and scores the worst (SwingGames MISHIT_SG).
"""
import json
import math
import threading
import time
from datetime import datetime
from pathlib import Path

from py_mini_racer import MiniRacer

import swings

STATIC_DIR = Path(__file__).parent / "static"
# A swing with no shot this long after the strike is skipped (practice.py SHOT_GIVE_UP_S).
SHOT_GIVE_UP_S = 25.0
# Two clips of one swing are at most this far apart (app.py PAIR_SLACK_S).
PAIR_SLACK_S = 2.0
# The phone doesn't speak sentences older than this (practice.py SPEAK_WITHIN_S).
SPEAK_WITHIN_S = 45.0
# A game with no swing for this long is ended and saved as it stands.
IDLE_END_S = 45 * 60


def _finite(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


# The calls this file makes, on top of games.js's GAMES table.
ADAPTER = """
SwingGames.list = () => Object.values(SwingGames.GAMES).map(g =>
  ({id: g.id, name: g.name, describe: g.describe, clubsHint: g.clubsHint}));
SwingGames.nextTarget = (id, options, history) => SwingGames.GAMES[id].next(options, history);
SwingGames.sayTarget = (id, target) => SwingGames.GAMES[id].sayTarget(target);
"""


class Rules:
    """games.js in a V8 of its own, made on first use, one call at a time."""

    def __init__(self, static_dir: Path = STATIC_DIR):
        self.source = (static_dir / "games.js").read_text(encoding="utf-8")
        self.ctx: MiniRacer | None = None
        self.lock = threading.Lock()

    def call(self, expr: str, *args):
        """SwingGames.<expr>(*args), with arguments and result passed as JSON."""
        with self.lock:
            if self.ctx is None:
                with swings.START_LOCK:
                    self.ctx = MiniRacer()
                self.ctx.eval(self.source)
                self.ctx.eval(ADAPTER)
            a = json.dumps(list(args), separators=(",", ":"))
            return json.loads(self.ctx.eval(f"JSON.stringify(SwingGames.{expr}(...{a}) ?? null)"))

    def close(self) -> None:
        with self.lock:
            if self.ctx is not None:
                self.ctx.close()
                self.ctx = None


def shot_of(shot: dict | None) -> dict:
    """{carry, offline, club, spinAxis, hla, path, faceToPath} for games.js; carry None for a mishit."""
    b = (shot or {}).get("ball") or {}
    c = (shot or {}).get("clubData") or {}
    bad = any(d.get("valid") is False or d.get("isValid") is False or d.get("invalid") is True
              for d in (shot or {}, b))
    carry = _finite(b.get("carry"))
    path = _finite(c.get("path"))
    face_to_target = _finite(c.get("faceToTarget"))
    face_to_path = _finite(face_to_target - path) if face_to_target is not None and path is not None else None
    return {
        "carry": None if bad or carry is None or carry <= 0 else carry,
        "offline": _finite(b.get("side")),
        "club": (shot or {}).get("club"),
        "spinAxis": _finite(b.get("spinAxis")),
        "hla": _finite(b.get("hla")),
        "path": path,
        "faceToPath": face_to_path,
    }


# What a game's "green" is, for the summary: a fairway, or the shape that was called.
HIT_WORDS = {"driving": "in the fairway", "shaping": "shaped as called", "distance": "within 5 yards"}


class Games:
    """The game in play, finished games, and what the phone should say. Thread-safe."""

    def __init__(self, state_file: Path, log_file: Path, new_id, clock=time.time, rules: Rules | None = None):
        self.state_file, self.log_file, self.new_id, self.clock = state_file, log_file, new_id, clock
        self.rules = rules or Rules()
        self.lock = threading.Lock()
        self.game: dict | None = swings.load(state_file) or None
        self.said: list[dict] = []

    # ---- Starting and stopping ----

    def catalog(self) -> list[dict]:
        return self.rules.call("list")

    def say_target(self, game_id: str, target) -> str:
        return self.rules.call("sayTarget", game_id, target)

    def start(self, game_id: str, options: dict | None = None) -> dict:
        games = {g["id"]: g for g in self.catalog()}
        if game_id not in games:
            raise ValueError("Unknown game")
        options = {k: v for k, v in (options or {}).items() if _finite(v) is not None}
        now = self.clock()
        options.setdefault("seed", int(now))
        first = self.rules.call("nextTarget", game_id, options, [])
        if first is None:
            raise ValueError("That game has no targets")
        with self.lock:
            if self.game:
                self._finish("stopped")
            self.game = {"id": game_id, "name": games[game_id]["name"], "options": options, "started": now,
                         "results": [], "target": first}
            self._save()
            self._say(f"{games[game_id]['describe']} First target: {self.say_target(game_id, first)}.")
            return dict(self.game)

    def stop(self) -> dict | None:
        with self.lock:
            if not self.game:
                return None
            done = self._finish("stopped")
            self._say("Game stopped. " + done["spoken"])
            return done

    # ---- Swings ----

    def step(self, swings_now: list[dict]) -> list[dict]:
        """Scores each new swing of the game once its shot is in. `swings_now`: listed swings with "t"
        (strike, unix s), "name" and "shot". Returns the results made."""
        with self.lock:
            g = self.game
            if not g:
                return []
            now = self.clock()
            done_times = [r["t"] for r in g["results"]]
            last = max(done_times + [g["started"] - PAIR_SLACK_S])
            made = []
            for s in sorted(swings_now, key=lambda s: s["t"]):
                t = s["t"]
                if t <= last or any(abs(t - d) <= PAIR_SLACK_S for d in done_times):
                    continue
                if not s.get("shot"):
                    if now - t < SHOT_GIVE_UP_S:
                        break  # Square's shots come in order: wait for this one before later ones
                    continue  # never came: the same target is asked again
                shot = s["shot"]
                target = g["target"]
                scored = self.rules.call("scoreFor", g["id"], target, shot_of(shot))
                r = {"t": t, "clip": s["name"], "target": target, "club": shot.get("club"),
                     "carry": _finite((shot.get("ball") or {}).get("carry")),
                     "offline": _finite((shot.get("ball") or {}).get("side")),
                     "sg": scored["sg"] if scored else None, "dist": scored["dist"] if scored else None,
                     "onGreen": bool(scored and scored["onGreen"]), "verdict": scored["verdict"] if scored else "mishit"}
                g["results"].append(r)
                done_times.append(t)
                made.append(r)
                verdict = scored["verdict"] if scored else "Mishit"
                history = [{"target": x["target"], "onGreen": x["onGreen"], "sg": x["sg"]} for x in g["results"]]
                nxt = self.rules.call("nextTarget", g["id"], g["options"], history)
                if nxt is None:
                    done = self._finish("done")
                    self._say(f"{verdict}. {g['name']} done. {done['spoken']}")
                    break
                g["target"] = nxt
                self._say(f"{verdict}. Next: {self.say_target(g['id'], nxt)}.")
            if made and self.game:
                self._save()
            elif self.game and now - max(done_times + [g["started"]]) > IDLE_END_S:
                self._finish("idle")
            return made

    # ---- For the phone and the page ----

    def latest(self, since: int) -> list[dict]:
        with self.lock:
            now = self.clock()
            return [e for e in self.said if e["id"] > since and now - e["made"] <= SPEAK_WITHIN_S]

    def state(self, log_limit: int = 200) -> dict:
        with self.lock:
            g = dict(self.game) if self.game else None
            if g:
                g["summary"] = self.rules.call("summarize", g["results"])
                g["hitWord"] = HIT_WORDS.get(g["id"], "on the green")
                if g.get("target") is not None:
                    g["sayTarget"] = self.say_target(g["id"], g["target"])
            return {"game": g, "games": self.catalog(), "log": self._log()[-log_limit:]}

    # ---- Inside (lock held) ----

    def _say(self, text: str) -> None:
        now = self.clock()
        self.said = [e for e in self.said if now - e["made"] <= SPEAK_WITHIN_S]
        self.said.append({"id": self.new_id(), "made": now, "text": text, "game": True})

    def _finish(self, how: str) -> dict:
        g = self.game
        summary = self.rules.call("summarize", g["results"])
        per = summary.get("sgPerShot")
        hit = HIT_WORDS.get(g["id"])
        spoken = (f"{summary['shots']} shots, {summary['greens']} {hit or 'on the green'}"
                  + (f", {abs(per):.2f} strokes a shot {'better' if per >= 0 else 'worse'} than tour"
                     if per is not None and g["id"] != "shaping" else "")
                  + ".")
        done = {**g, "ended": self.clock(), "how": how, "summary": summary, "spoken": spoken,
                "day": datetime.fromtimestamp(g["started"]).isoformat(timespec="seconds")}
        done.pop("target", None)
        if g["results"]:
            self.log_file.parent.mkdir(parents=True, exist_ok=True)
            with open(self.log_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(done, separators=(",", ":")) + "\n")
        self.game = None
        self._save()
        return done

    def _save(self) -> None:
        swings.save(self.state_file, self.game or {})

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
