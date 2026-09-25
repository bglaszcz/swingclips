"""The rules for which shots count as good, per club, from Square's numbers (goodshots.json): the review
page's personal ranges come from those shots (static/goodshots.js works the ranges out; this keeps the
settings and checks what the page sends).

{minCount, irons: {offlinePct, carryBelowPct, carryAbovePct, smashBelow}, woods: {...},
 strike: {on, heelToeMm, highLowMm}}. See goodshots.js for what each one does.
"""
import json
import math
from pathlib import Path

# Keep in step with goodshots.js DEFAULTS (tests/test_goodshots.py checks they agree).
DEFAULTS = {
    "minCount": 8,
    "irons": {"offlinePct": 5, "carryBelowPct": 10, "carryAbovePct": 12, "smashBelow": 0},
    "woods": {"offlinePct": 6, "carryBelowPct": 10, "carryAbovePct": 12, "smashBelow": 0},
    "strike": {"on": True, "heelToeMm": 20, "highLowMm": 20},
}
# What each number may be: (low, high). Outside them the page's rules would make no sense.
LIMITS = {
    "minCount": (3, 100),
    "offlinePct": (0.5, 30),
    "carryBelowPct": (1, 60),
    "carryAbovePct": (1, 60),
    "smashBelow": (0, 0.5),
    "heelToeMm": (2, 60),
    "highLowMm": (2, 60),
}


def _number(v, key: str) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise ValueError(f"{key} needs a number")
    lo, hi = LIMITS[key]
    if not lo <= v <= hi:
        raise ValueError(f"{key} must be from {lo} to {hi}")
    return v


def check_settings(s: dict) -> dict:
    """Settings from the review page, cleaned up (missing parts from DEFAULTS); ValueError when they
    don't make sense."""
    if not isinstance(s, dict):
        raise ValueError("Expected the good-shot settings")
    out = json.loads(json.dumps(DEFAULTS))
    if "minCount" in s:
        out["minCount"] = int(_number(s["minCount"], "minCount"))
    for group in ("irons", "woods"):
        part = s.get(group) or {}
        if not isinstance(part, dict):
            raise ValueError(f"{group} needs its rules")
        for key in out[group]:
            if key in part:
                out[group][key] = _number(part[key], key)
    strike = s.get("strike") or {}
    if not isinstance(strike, dict):
        raise ValueError("strike needs its rules")
    if "on" in strike:
        out["strike"]["on"] = bool(strike["on"])
    for key in ("heelToeMm", "highLowMm"):
        if key in strike:
            out["strike"][key] = _number(strike[key], key)
    return out


def load(path: Path) -> dict:
    """The saved settings, or the defaults (a missing or broken file, or one from an older version)."""
    try:
        return check_settings(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return json.loads(json.dumps(DEFAULTS))


def save(path: Path, s: dict) -> dict:
    s = check_settings(s)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(s, indent=1), encoding="utf-8")
    tmp.replace(path)
    return s
