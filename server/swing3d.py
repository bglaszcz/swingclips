"""The 3D side of the swing worker (app.py), when SWINGCLIPS_3D=on: for each swing filmed from both
angles, pick the calibration session that holds for it, triangulate (tri.py), save
<face clip>.3d.json beside the pose files, and work out its numbers (static/metrics3d.js).

Which session: the latest one made before the swing, as long as neither camera has moved since. A
camera counts as moved the way the trends decide it (summary.js cameraMoved): the golfer's place
and size in its picture at address in this swing, against the first swing after the session. The
golfer's own place varies ~0.004 picture heights from swing to swing, well inside the 0.02 that
counts as a move, so single swings are compared: a median over several would keep using a stale
calibration for a few swings after a move, and the reference must not take in swings after one.
"""
import gzip
import json
from pathlib import Path

import numpy as np

import calib
import tri


def framing_median(setups: list[dict]) -> dict | None:
    rows = [s for s in setups if s and all(s.get(k) is not None for k in ("x", "y", "h"))]
    if not rows:
        return None
    return {k: float(np.median([r[k] for r in rows])) for k in ("x", "y", "h")}


def session_for(name: str, times: dict, records: dict, all_sessions: list[dict], moved) -> tuple[dict | None, str]:
    """The session for swing `name`, or None and why not. times: swing -> unix time; records: swing
    -> its record ({setup: {face, dtl}}); moved(before, now) -> bool (summary.js cameraMoved)."""
    t = times.get(name)
    if t is None:
        return None, "no time"
    s = calib.session_before(t, all_sessions)
    if s is None:
        return None, "no calibration before this swing"
    after = sorted((ti, n) for n, ti in times.items()
                   if s["created"] <= ti and (records.get(n) or {}).get("setup"))
    names = [n for _, n in after]
    if name not in names:
        return None, "no framing for this swing yet"
    for cam in ("face", "dtl"):
        ref = framing_median([records[names[0]]["setup"].get(cam)])
        now = framing_median([records[name]["setup"].get(cam)])
        if ref is None or now is None:
            return None, f"no {cam} framing"
        if moved(ref, now):
            return None, f"the {'face-on' if cam == 'face' else 'down-the-line'} camera moved since calibration {s['id']}"
    return s, "ok"


def read_pose(path: Path) -> dict:
    return json.loads(gzip.decompress(path.read_bytes()))


def build(face_input: dict, dtl_input: dict, face_pose: dict, dtl_pose: dict, session: dict, summarizer,
          club: str | None, lead_side: str) -> tuple[dict, dict | None]:
    """(the 3D file, its numbers) for one swing. The inputs are swings.pose_input's; the poses the
    pose files themselves (with the clubhead, when the club model found it)."""
    offset = summarizer.call("syncOffset", {"impact": face_input.get("impact"), "strike": face_input.get("strike")},
                             {"impact": dtl_input.get("impact"), "strike": dtl_input.get("strike")})
    doc = tri.swing(face_pose, dtl_pose, session, offset, face_pose.get("impact"))
    doc.update(face=face_input["name"], dtl=dtl_input["name"], session=session["id"], club=club)
    numbers = summarizer.call("summarize3d", face_input, dtl_input, lead_side, doc, club, ns="SwingMetrics3D")
    return doc, numbers


def save(path: Path, doc: dict) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)
