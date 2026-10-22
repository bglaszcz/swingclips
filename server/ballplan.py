"""The 4-week ball plan (ballplan.json): practise to Square's numbers, and see whether they move.

The owner, Oct 21 2026: every ball number was flat from August to October, and within a club none of the
camera's body numbers told the heavy and thin iron shots from the solid ones. So for four weeks the practice
is judged on Square alone, and so is the scoreboard:

- 7 iron solid: smash 1.25 or more (Square's club read needed). On the owner's 7 irons, smash 1.25+ came up
  more than 15% short 3-4% of the time, under 1.20 most of the time.
- Irons heavy or thin: carried more than 15% short of the club's usual carry (its median over the baseline,
  clubs with STOCK_MIN_SHOTS or more there). Irons and PW only: GW and SW are hit at part distances so often
  that their "usual" isn't a full swing (SW Sep 23 - Oct 21: 34 yd).
- Irons near the centre: Square's toe/heel reading within 10 mm (a failed read, null or exactly 0.0, left out).
- Drives in the fairway: within 15 yd of the line (games.js, the Driving game's 30 yd fairway). Drives under
  90 mph club speed are left out: not a full driver swing (Sep 24: 8 at 88 mph carrying ~150; the usual is
  ~103). Drives with no club read stay in.

Shots: every Square shot (shots.jsonl), counted the trends' way: drill swings, calibration clips, practice
games other than the usual full swing (games.STOCK_SWING_GAMES) and swings left out by hand don't count. A shot
no clip paired with counts unless a drill or such a game was on when it was struck (app.ballplan_rows).

Each number is a share of shots. It reads "better" or "worse" than the baseline (the four weeks before the
plan) only when a bootstrap over sessions (days resampled, 90%, seeded) says so; otherwise "can't tell yet".
The plan's sessions are the coach programs named in ballplan.json's days (programs.json): a day counts once a
run of its program has SESSION_MIN_SHOTS shots, or got through all its blocks.

The checks (check()): after a session, a week, or the plan so far, what went well and where it struggled.
Each iron miss gets one cause and each missed drive one direction (iron_miss, drive_miss):

- Off the heel / toe: struck more than OFF_CENTRE_MM from the centre. On the owner's 7 irons Sep 23 - Oct 21
  (Square's watcher logs, + = heel): 37% were more than 12 mm toward the heel, and only 36% of those were
  solid against 81% within 6 mm. Heel strikes were the biggest iron miss on every club but the 6 iron and 4H.
- Within a session (club and day, so the camera setup can't explain it), the hands to plane in the downswing
  (handsPlaneP6) went with the heel strike: r +0.31 over 320 iron swings, positive on 10 of 11 days (90% by
  day 0.24 to 0.38), about 6 mm toward the heel per inch the hands sit higher. So the check shows the hands on
  heel strikes against centred ones when the cameras have them.
- Short from a centred strike: by attack angle, shallow (bottom before the ball) or steep (digging).
- Drives that missed the fairway: started off line or curved off it (carry x tan(start direction) against
  the rest of the side). The owner's left misses Sep 23 - Oct 21 started on line (median 0.3) and curved
  left (spin axis -32): 12 of 15.

The practice day is tailored (emphasis()): its program follows the bigger kind of iron miss over the
EMPHASIS_DAYS before today, off-centre strikes (ballcentre: pump drill, then centred 7 irons) or low point
(ballpractice: no-ball low point rehearsals, then solid 7 irons).
"""
import json
import math
import random
import statistics
from datetime import date, datetime, timedelta
from pathlib import Path

PLAN_FILE = Path(__file__).parent / "ballplan.json"

# The full-swing irons the iron numbers count (not GW / SW / LW: see above).
IRONS = {"I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9", "PW"}
SOLID_SMASH = 1.25
SHORT_SHARE = 0.85
CENTRED_MM = 10.0
FAIRWAY_YD = 15.0
DRIVER_MIN_MPH = 90.0
ATTACK_ZONE = (-5.0, -2.0)
STOCK_MIN_SHOTS = 8
SESSION_MIN_SHOTS = 5
BOOT_REPS = 1000
BOOT_SEED = 7
LEVEL = 0.90

# The plan's numbers, each with a target in ballplan.json ("better": which way is better).
NUMBERS = [
    {"key": "solid7", "label": "7 iron solid", "what": "smash 1.25 or more", "club": "7 iron", "better": "up"},
    {"key": "heavyThin", "label": "Irons heavy or thin", "what": "carried more than 15% short of the club's usual",
     "club": "irons and PW", "better": "down"},
    {"key": "centred", "label": "Irons near the centre", "what": "within 10 mm of the centre, toe to heel",
     "club": "irons and PW", "better": "up"},
    {"key": "fairway", "label": "Drives in the fairway", "what": "within 15 yd of the line",
     "club": "driver", "better": "up"},
]
# Shown beside them, with no target: why the 7 irons miss, and which way the drives do.
INFO = [
    {"key": "attack7", "label": "7 iron attack angle -2 to -5",
     "what": "your 7 irons were heavy or thin least often there (Aug to Oct: 9%; at -0.5 or shallower: 30%)",
     "club": "7 iron", "better": "up"},
    {"key": "left", "label": "Drives left of the line", "what": "your drives lean left", "club": "driver",
     "better": "down"},
]
KEYS = [n["key"] for n in NUMBERS + INFO]

# The checks: what each iron miss and missed drive was (see the module notes).
OFF_CENTRE_MM = 12.0
SHALLOW_ATTACK = -0.5
STEEP_ATTACK = -5.0
# Hands to plane on heel against centred strikes: shown with at least this many of each in the range.
HANDS_MIN = 4
# A difference in hands to plane (in) the check calls one.
HANDS_DIFF_IN = 0.15
# The practice day's emphasis: the iron misses over these days before today (at least EMPHASIS_MIN of them).
EMPHASIS_DAYS = 14
EMPHASIS_MIN = 10
# A number "going well" in a check: at least this many shots and at the target, or this many points better
# than at the start.
GOOD_MIN_SHOTS = 5
GOOD_POINTS = 10

# Each miss: what it was, and the drill and swing thought for it (coach.js wording where it has one).
CAUSES = {
    "heel": {"label": "Off the heel", "what": "struck more than 12 mm toward the heel",
             "why": "On your irons this goes with the hands moving out toward the ball coming down: about 6 mm "
                    "toward the heel for each inch they sit higher.",
             "drill": "Pump drill: go to the top, pump the hands down to your trail pocket twice, then hit. Then "
                      "set a headcover just outside the toe end of the club and hit the ball without touching it.",
             "thought": "Hands drop to the trail pocket."},
    "toe": {"label": "Off the toe", "what": "struck more than 12 mm toward the toe",
            "why": "The club came back to the ball closer to you than it started.",
            "drill": "Set a tee in the mat just inside the heel end of the club and miss it.",
            "thought": "Stay in your posture through the ball."},
    "shallow": {"label": "Heavy", "what": "short from a centred strike, attack angle shallower than −0.5°",
                "why": "The bottom of the swing came before the ball.",
                "drill": "Lead foot only (trail toe back, 3/4 swings), then step through: brush the mat after the ball spot.",
                "thought": "Ball, then turf."},
    "steep": {"label": "Digging", "what": "short from a centred strike, attack angle steeper than −5°",
              "why": "The club came down too steeply and dug.",
              "drill": "3/4 swings that brush the mat just after the ball, no divot.",
              "thought": "Brush the turf after the ball."},
    "short": {"label": "Short", "what": "more than 15% short from a centred strike, normal attack angle",
              "why": "Usually a thin or slightly heavy contact Square can't tell apart.",
              "drill": "Flush line: foot spray or a dry-erase line from the ball toward the target; the mark should "
                       "start at the ball or just after it.",
              "thought": "Ball, then turf."},
    "left-curve": {"label": "Curved left", "what": "started near the line and curved left (hook spin)",
                   "why": "The face was closed to the path at impact.",
                   "drill": "Hold-off finish: swing through to a finish with the chest at the target and the club "
                            "face looking at the sky. 10 balls.",
                   "thought": "Chest turns through, hold the face."},
    "left-start": {"label": "Started left", "what": "started left of the line",
                   "why": "The face pointed left at impact (often the aim).",
                   "drill": "Lay an alignment stick on your target line and check feet and shoulders against it; "
                            "pick a start point at the right edge of the fairway.",
                   "thought": "Start it at the right edge."},
    "right-curve": {"label": "Curved right", "what": "started near the line and curved right (slice spin)",
                    "why": "The face was open to the path at impact.",
                    "drill": "Split-hands swings: hands a few inches apart, let the trail hand roll over through the "
                             "ball. 5 slow, then 5 balls.",
                    "thought": "Let the toe pass the heel."},
    "right-start": {"label": "Started right", "what": "started right of the line",
                    "why": "The face pointed right at impact.",
                    "drill": "Lay an alignment stick on your target line and check the clubface and shoulders against it.",
                    "thought": "Start it at the left edge."},
}
IRON_CAUSES = ("heel", "toe", "shallow", "steep", "short")
DRIVE_CAUSES = ("left-curve", "left-start", "right-curve", "right-start")


def _finite(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


def load_plan(path: Path | None = None) -> dict | None:
    try:
        return json.loads(Path(path or PLAN_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def row_of(shot: dict, t: float, out: bool = False, game: str | None = None,
           hands: float | None = None) -> dict | None:
    """One Square shot as the plan reads it (None without a carry). `t`: the strike (unix s); `out`: left out
    of the trends (a drill, a practice game, by hand); `hands`: its swing's hands to plane in the downswing
    (handsPlaneP6, in; None without the cameras)."""
    b, c = shot.get("ball") or {}, shot.get("clubData") or {}
    carry = _finite(b.get("carry"))
    if carry is None:
        return None
    speed = _finite(c.get("speed"))
    read = speed is not None and speed > 0
    h = _finite(c.get("faceImpactH"))
    return {"t": t, "day": datetime.fromtimestamp(t).date().isoformat(), "club": shot.get("club"),
            "carry": carry, "side": _finite(b.get("side")), "speed": speed if read else None,
            "smash": _finite(c.get("smash")) if read else None,
            "attack": _finite(c.get("angleOfAttack")) if read else None,
            "strikeH": None if h is None or h == 0.0 else h, "start": _finite(b.get("hla")),
            "hands": _finite(hands), "out": bool(out), "game": game}


def stock_carry(rows: list[dict], frm: str, to: str) -> dict:
    """Each club's usual carry: its median over the counted shots from `frm` to `to` (ISO days, inclusive)."""
    by = {}
    for r in rows:
        if not r["out"] and frm <= r["day"] <= to and r["club"]:
            by.setdefault(r["club"], []).append(r["carry"])
    return {c: round(statistics.median(v), 1) for c, v in by.items() if len(v) >= STOCK_MIN_SHOTS}


def tally(key: str, r: dict, stock: dict) -> bool | None:
    """Whether a shot counts for a number (True / False), or None: not one of its shots."""
    if r["out"]:
        return None
    club = r["club"]
    if key == "solid7":
        return None if club != "I7" or r["smash"] is None else r["smash"] >= SOLID_SMASH
    if key == "attack7":
        return None if club != "I7" or r["attack"] is None else ATTACK_ZONE[0] <= r["attack"] <= ATTACK_ZONE[1]
    if key == "heavyThin":
        s = stock.get(club)
        return None if club not in IRONS or not s else r["carry"] < SHORT_SHARE * s
    if key == "centred":
        return None if club not in IRONS or r["strikeH"] is None else abs(r["strikeH"]) <= CENTRED_MM
    if key in ("fairway", "left"):
        if club != "DR" or r["side"] is None or (r["speed"] is not None and r["speed"] < DRIVER_MIN_MPH):
            return None
        return abs(r["side"]) <= FAIRWAY_YD if key == "fairway" else r["side"] < 0
    raise KeyError(key)


def iron_miss(r: dict, stock: dict) -> str | None:
    """A counted iron shot: "good" (centred and not short) or its miss (IRON_CAUSES); None when it isn't one
    or can't be judged (no strike read and no usual carry for the club)."""
    if r["out"] or r["club"] not in IRONS:
        return None
    s, h = stock.get(r["club"]), r["strikeH"]
    if h is None and not s:
        return None
    if h is not None and abs(h) > OFF_CENTRE_MM:
        return "heel" if h > 0 else "toe"
    if not (s and r["carry"] < SHORT_SHARE * s):
        return "good"
    a = r["attack"]
    return "shallow" if a is not None and a > SHALLOW_ATTACK else "steep" if a is not None and a < STEEP_ATTACK else "short"


def drive_miss(r: dict) -> str | None:
    """A counted full drive: "fairway", or where it went (DRIVE_CAUSES; "left" / "right" without a start
    direction); None when it isn't one."""
    if r["out"] or r["club"] != "DR" or r["side"] is None or (r["speed"] is not None and r["speed"] < DRIVER_MIN_MPH):
        return None
    if abs(r["side"]) <= FAIRWAY_YD:
        return "fairway"
    way = "left" if r["side"] < 0 else "right"
    if r["start"] is None:
        return way
    start = r["carry"] * math.tan(math.radians(r["start"]))
    return f"{way}-start" if abs(start) >= abs(r["side"] - start) else f"{way}-curve"


def _plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else many or one + 's'}"


def check(rows: list[dict], stock: dict, frm: str, to: str, start: dict | None = None,
          targets: dict | None = None) -> dict:
    """What went well and where it struggled from `frm` to `to` (ISO days): {from, to, days, irons {n, good,
    causes, heelPct}, drives {n, fairway, causes}, solid7 {hits, n}, hands, good [lines], struggle [{key,
    label, n, of, what, why, drill, thought, hands?}]}. `start`: the numbers at the start ({key: share}),
    `targets`: the plan's, for the "going well" lines."""
    got = [r for r in rows if frm <= r["day"] <= to and not r["out"]]
    # Hands to plane against the median of the same club that day: the camera setup moves the number from
    # day to day, so only a difference within a day says anything (see the module notes).
    by_day = {}
    for r in got:
        if r["hands"] is not None:
            by_day.setdefault((r["club"], r["day"]), []).append(r["hands"])
    day_med = {k: statistics.median(v) for k, v in by_day.items() if len(v) >= 2 * HANDS_MIN}
    irons = {c: 0 for c in ("good",) + IRON_CAUSES}
    drives = {c: 0 for c in ("fairway", "left", "right") + DRIVE_CAUSES}
    solid = [0, 0]
    hands = {"heel": [], "centre": []}
    for r in got:
        m = iron_miss(r, stock)
        if m:
            irons[m] += 1
            med = day_med.get((r["club"], r["day"]))
            if r["hands"] is not None and med is not None and r["strikeH"] is not None:
                if m == "heel":
                    hands["heel"].append(r["hands"] - med)
                elif abs(r["strikeH"]) <= CENTRED_MM:
                    hands["centre"].append(r["hands"] - med)
        d = drive_miss(r)
        if d:
            drives[d] += 1
        if r["club"] == "I7" and r["smash"] is not None:
            solid[0] += r["smash"] >= SOLID_SMASH
            solid[1] += 1
    n_iron, n_drive = sum(irons.values()), sum(drives.values())
    hands_out = None
    if len(hands["heel"]) >= HANDS_MIN and len(hands["centre"]) >= HANDS_MIN:
        hh, hc = statistics.median(hands["heel"]), statistics.median(hands["centre"])
        hands_out = {"heel": round(hh, 2), "centre": round(hc, 2), "nHeel": len(hands["heel"]),
                     "nCentre": len(hands["centre"]), "diff": round(hh - hc, 2)}

    # Going well: each plan number in the range at its target, or well up on where it started.
    good = []
    struck = [r for r in got if r["strikeH"] is not None and iron_miss(r, stock)]
    shares = {
        "solid7": (solid[0], solid[1], "7 irons solid"),
        "centred": (sum(abs(r["strikeH"]) <= CENTRED_MM for r in struck), len(struck), "iron strikes near the centre"),
        "fairway": (drives["fairway"], n_drive, "drives in the fairway"),
    }
    for key, (hits, n, words) in shares.items():
        if n < GOOD_MIN_SHOTS:
            continue
        pct = 100 * hits / n
        tgt = (targets or {}).get(key)
        was = (start or {}).get(key)
        if tgt is not None and pct >= tgt:
            good.append(f"{hits} of {n} {words} ({round(pct)}%): at the target of {tgt}%.")
        elif was is not None and pct >= was + GOOD_POINTS:
            good.append(f"{hits} of {n} {words} ({round(pct)}%), up from {round(was)}% at the start.")
    if n_iron >= GOOD_MIN_SHOTS and not (irons["shallow"] + irons["steep"] + irons["short"]):
        good.append(f"None of {n_iron} irons came up heavy or thin.")

    # Struggling: the biggest iron miss and the biggest drive miss.
    struggle = []
    for pool, causes, n in ((irons, IRON_CAUSES, n_iron), (drives, DRIVE_CAUSES, n_drive)):
        top = max(causes, key=lambda c: pool[c])
        if pool[top] >= 2 and pool[top] >= 0.15 * n:
            item = {"key": top, **CAUSES[top], "n": pool[top], "of": n}
            if top == "heel" and hands_out:
                item["hands"] = hands_out
            struggle.append(item)
    heel_pct = round(100 * irons["heel"] / n_iron, 1) if n_iron else None
    return {"from": frm, "to": to, "days": sorted({r["day"] for r in got}),
            "irons": {"n": n_iron, "good": irons["good"], "causes": {c: irons[c] for c in IRON_CAUSES},
                      "heelPct": heel_pct},
            "drives": {"n": n_drive, "fairway": drives["fairway"],
                       "causes": {c: drives[c] for c in DRIVE_CAUSES + ("left", "right")}},
            "solid7": {"hits": solid[0], "n": solid[1]}, "hands": hands_out, "good": good, "struggle": struggle}


def emphasis(rows: list[dict], stock: dict, today: str) -> dict:
    """What the practice day works on, from the iron misses over the EMPHASIS_DAYS before today: {key:
    "centre" (off-centre strikes led) / "lowpoint" (short from the centre led) / None (too few to say),
    offCentre, lowPoint (shots), from, to, why}."""
    end = date.fromisoformat(today) - timedelta(days=1)
    frm, to = (end - timedelta(days=EMPHASIS_DAYS - 1)).isoformat(), end.isoformat()
    off = low = 0
    for r in rows:
        if frm <= r["day"] <= to:
            m = iron_miss(r, stock)
            off += m in ("heel", "toe")
            low += m in ("shallow", "steep", "short")
    out = {"from": frm, "to": to, "offCentre": off, "lowPoint": low}
    if off + low < EMPHASIS_MIN:
        return {**out, "key": None, "why": f"Too few iron misses in the last {EMPHASIS_DAYS} days to tailor the day "
                                          f"({off + low}); it works on low point."}
    if off >= low:
        return {**out, "key": "centre",
                "why": f"In the last {EMPHASIS_DAYS} days {_plural(off, 'iron miss', 'iron misses')} came off the heel "
                       f"or toe and {low} came up short from the centre, so today works on a centred strike."}
    return {**out, "key": "lowpoint",
            "why": f"In the last {EMPHASIS_DAYS} days {_plural(low, 'iron', 'irons')} came up short from the centre "
                   f"and {off} came off the heel or toe, so today works on low point."}


def day_tallies(rows: list[dict], stock: dict) -> dict:
    """{day: {key: [hits, shots]}} over every number."""
    days = {}
    for r in rows:
        d = days.setdefault(r["day"], {k: [0, 0] for k in KEYS})
        for k in KEYS:
            v = tally(k, r, stock)
            if v is not None:
                d[k][0] += int(v)
                d[k][1] += 1
    return days


def _within(days: dict, key: str, frm: str, to: str) -> list[list[int]]:
    return [v[key] for d, v in sorted(days.items()) if frm <= d <= to and v[key][1]]


def share(days: dict, key: str, frm: str, to: str) -> dict:
    """{value (% of shots, None without any), n (shots), sessions (days)} from `frm` to `to`."""
    got = _within(days, key, frm, to)
    hits, n = sum(x[0] for x in got), sum(x[1] for x in got)
    return {"value": round(100 * hits / n, 1) if n else None, "n": n, "sessions": len(got)}


def verdict(days: dict, key: str, base: tuple[str, str], plan: tuple[str, str], better: str) -> dict:
    """The plan against the baseline: {verdict: better / worse / same (can't tell yet) / early (under two
    sessions), interval: the 90% interval of the difference in percentage points}."""
    b, p = _within(days, key, *base), _within(days, key, *plan)
    if len(b) < 2 or len(p) < 2:
        return {"verdict": "early", "interval": None}
    rnd = random.Random(BOOT_SEED)
    diffs = []
    for _ in range(BOOT_REPS):
        bs = [b[rnd.randrange(len(b))] for _ in b]
        ps = [p[rnd.randrange(len(p))] for _ in p]
        diffs.append(100 * sum(x[0] for x in ps) / sum(x[1] for x in ps)
                     - 100 * sum(x[0] for x in bs) / sum(x[1] for x in bs))
    diffs.sort()
    lo = diffs[int((1 - LEVEL) / 2 * BOOT_REPS)]
    hi = diffs[int((1 + LEVEL) / 2 * BOOT_REPS) - 1]
    up, down = lo > 0, hi < 0
    v = ("better" if (up and better == "up") or (down and better == "down")
         else "worse" if up or down else "same")
    return {"verdict": v, "interval": [round(lo, 1), round(hi, 1)]}


def _day(ts: float) -> str:
    return datetime.fromtimestamp(ts).date().isoformat()


def plan_programs(plan: dict) -> dict:
    """{program id: day kind ("practice" / "test")} from the plan's days, each step's tailored ones too."""
    out = {}
    for kind, d in plan.get("days", {}).items():
        for s in d.get("steps", []):
            for v in [s] + list((s.get("emphasis") or {}).values()):
                if v.get("program"):
                    out[v["program"]] = kind
    return out


def tailored(step: dict, key: str | None, ran: set) -> dict:
    """A step as today does it: the variant for the emphasis `key` (step["emphasis"][key]), unless one of
    the step's programs already ran or runs today (`ran`), which keeps it."""
    variants = [step] + list((step.get("emphasis") or {}).values())
    for v in variants:
        if v.get("program") in ran:
            return v
    return (step.get("emphasis") or {}).get(key) or step


def session_days(plan: dict, runs: list[dict], frm: str, to: str) -> dict:
    """{kind: [days]}: the days a plan program was done (SESSION_MIN_SHOTS shots, or all its blocks)."""
    kinds = plan_programs(plan)
    out = {k: set() for k in plan.get("days", {})}
    for r in runs:
        kind = kinds.get(r.get("id"))
        day = _day(r["started"])
        if kind and frm <= day <= to and (r.get("shots", 0) >= SESSION_MIN_SHOTS or r.get("how") == "done"):
            out[kind].add(day)
    return {k: sorted(v) for k, v in out.items()}


def combines(games: list[dict]) -> list[dict]:
    """Finished Combines, oldest first: {day, sgPerShot, greens, shots}."""
    out = []
    for g in games:
        s = g.get("summary") or {}
        if g.get("id") == "combine" and g.get("how") == "done" and _finite(s.get("sgPerShot")) is not None:
            out.append({"day": _day(g["started"]), "sgPerShot": round(s["sgPerShot"], 3),
                        "greens": s.get("greens"), "shots": s.get("shots")})
    return sorted(out, key=lambda x: x["day"])


def weeks_of(plan: dict) -> list[tuple[str, str]]:
    start, end = date.fromisoformat(plan["start"]), date.fromisoformat(plan["end"])
    out, d = [], start
    while d <= end:
        out.append((d.isoformat(), min(d + timedelta(days=6), end).isoformat()))
        d += timedelta(days=7)
    return out


def today_session(plan: dict, week: tuple[str, str], runs: list[dict], games: list[dict], today: str,
                  program_now: str | None, game_now: str | None, focus: dict | None = None) -> dict:
    """Which session today is (practice / test, or "extra" once the week's are done), its steps, and each
    step's done / running. A plan session already started today decides it. `focus`: emphasis(), which
    picks a tailored step's variant."""
    kinds = plan_programs(plan)
    need = plan.get("week", {})
    done = session_days(plan, runs, *week)
    today_kinds = [kinds[r["id"]] for r in sorted(runs, key=lambda r: r["started"])
                   if r.get("id") in kinds and _day(r["started"]) == today]
    if program_now in kinds:
        kind = kinds[program_now]
    elif today_kinds:
        kind = today_kinds[-1]
    else:
        practice_left = need.get("practice", 0) - len([d for d in done.get("practice", []) if d != today])
        test_left = need.get("test", 0) - len([d for d in done.get("test", []) if d != today])
        days_left = (date.fromisoformat(week[1]) - date.fromisoformat(today)).days + 1
        # The test once the practice days are in, or as soon as the week has no day to spare (the test, the
        # week's measure, is never the one squeezed out).
        if test_left > 0 and (practice_left <= 0 or days_left <= practice_left + test_left):
            kind = "test"
        elif practice_left > 0:
            kind = "practice"
        else:
            kind = "extra"
    day = plan["days"]["practice" if kind == "extra" else kind]
    ran = {r.get("id") for r in runs if _day(r["started"]) == today} | {program_now}
    key = (focus or {}).get("key")
    steps = []
    for s in day["steps"]:
        tailor = bool(s.get("emphasis"))
        s = tailored(s, key, ran)
        step = {"text": s["text"]}
        if tailor:
            step["why"] = (focus or {}).get("why")
        if s.get("program"):
            ran = [r for r in runs if r.get("id") == s["program"] and _day(r["started"]) == today]
            step.update(program=s["program"], running=program_now == s["program"],
                        done=any(not r.get("running") and (r.get("shots", 0) >= SESSION_MIN_SHOTS or r.get("how") == "done")
                                 for r in ran))
        elif s.get("game"):
            step.update(game=s["game"], running=game_now == s["game"],
                        done=any(g.get("id") == s["game"] and g.get("how") == "done" and _day(g["started"]) == today
                                 for g in games))
        steps.append(step)
    return {"kind": kind, "title": "Extra practice day" if kind == "extra" else day["title"], "steps": steps,
            "emphasis": key if kind != "test" else None}


def build(plan: dict, rows: list[dict], runs: list[dict], games: list[dict], now: float,
          program_now: str | None = None, game_now: str | None = None,
          frm: str | None = None, to: str | None = None) -> dict:
    """Everything the Start page, Progress and the Week brief show of the plan. `runs`: coach program runs
    ({id, started, shots, how, running}); `games`: finished games (games.py log); `frm`/`to`: a range of
    days (the Week brief's week) to sum as well."""
    today = _day(now)
    base = (plan["baseline"]["from"], plan["baseline"]["to"])
    stock = stock_carry(rows, *base)
    days = day_tallies(rows, stock)
    started = today >= plan["start"]
    so_far = (plan["start"], min(today, plan["end"]))
    weeks = weeks_of(plan)
    week_i = next((i for i, (a, b) in enumerate(weeks) if a <= today <= b), None)

    numbers = []
    for spec in NUMBERS + INFO:
        k = spec["key"]
        item = {**spec, "target": plan.get("targets", {}).get(k), "start": share(days, k, *base),
                "plan": share(days, k, *so_far) if started else None,
                "week": share(days, k, *weeks[week_i]) if week_i is not None else None}
        item.update(verdict(days, k, base, so_far, spec["better"]) if started else {"verdict": "early", "interval": None})
        numbers.append(item)

    games_done = combines(games)
    before = [g for g in games_done if g["day"] < plan["start"]]
    during = [g for g in games_done if plan["start"] <= g["day"] <= plan["end"]]
    combine = {"before": before, "plan": during,
               "best": max((g["sgPerShot"] for g in before), default=None),
               "bestPlan": max((g["sgPerShot"] for g in during), default=None)}

    start_shares = {n["key"]: n["start"]["value"] for n in numbers}
    targets = plan.get("targets", {})

    def check_of(a: str, b: str) -> dict:
        return check(rows, stock, a, b, start_shares, targets)

    week_rows = []
    for i, (a, b) in enumerate(weeks):
        sess = session_days(plan, runs, a, b)
        week_rows.append({"n": i + 1, "from": a, "to": b, "practice": len(sess.get("practice", [])),
                          "test": len(sess.get("test", [])), "combine": [g for g in during if a <= g["day"] <= b],
                          "numbers": {k: share(days, k, a, b) for k in KEYS},
                          "check": check_of(a, b) if a <= today else None})
    # The last session: the latest day up to today with counted shots.
    shot_days = sorted({r["day"] for r in rows if not r["out"] and r["day"] <= today})
    last = shot_days[-1] if shot_days else None
    focus = emphasis(rows, stock, today)

    out = {
        "plan": {"id": plan["id"], "name": plan["name"], "start": plan["start"], "end": plan["end"],
                 "baseline": plan["baseline"], "why": plan.get("why", ""), "need": plan.get("week", {}),
                 "programs": sorted(plan_programs(plan)),
                 "active": plan["start"] <= today <= plan["end"], "started": started, "ended": today > plan["end"],
                 "week": week_i + 1 if week_i is not None else None, "weeks": len(weeks), "today": today},
        "numbers": numbers, "combine": combine, "weeks": week_rows, "stock": stock,
        "today": (today_session(plan, weeks[week_i], runs, games, today, program_now, game_now, focus)
                  if week_i is not None else None),
        "emphasis": focus,
        "checks": {"last": check_of(last, last) if last else None,
                   "plan": check_of(*so_far) if started else None},
    }
    if frm and to:
        sess = session_days(plan, runs, frm, to)
        out["range"] = {"from": frm, "to": to, "numbers": {k: share(days, k, frm, to) for k in KEYS},
                        "practice": len(sess.get("practice", [])), "test": len(sess.get("test", [])),
                        "combine": [g for g in games_done if frm <= g["day"] <= to], "check": check_of(frm, to)}
    return out
