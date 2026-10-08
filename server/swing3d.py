"""The 3D side of the swing worker (app.py), when SWINGCLIPS_3D=on: for each swing filmed from both
angles, pick the calibration session that holds for it, triangulate (tri.py), save
<face clip>.3d.json beside the pose files, and work out its numbers (static/metrics3d.js).

Which session: the latest one made before the swing. Whether a camera has moved since is told by
the swing's own fit: at address the core joints (tri.CORE) of a still-placed pair of phones land
within ~1-2 px of their rays in both pictures; after a tripod moves they miss by much more
(MOVED_PX). But a phone turned sideways is mostly taken up by the fit, so the ball is checked too:
it sits on the same spot whatever the club, so where it is in each picture is compared with the
first swings after the calibration (BALL_SWINGS). On the first real session it held within +-0.005
of the picture up and down and +-0.02 across (where the ball was put down), so a camera counts as
moved past BALL_MOVED. The golfer's place in the picture isn't used: it changes with the club (a 5
iron after 7 irons counted as "camera moved" there).
"""
import gzip
import json
from pathlib import Path

import numpy as np

import calib
import tri

# The core joints at address miss their rays by more than this (median px, both views): a camera
# moved since the calibration.
MOVED_PX = 5.0
# The same for cameras placed from the golfer's own swings (bodycalib.py): their swings land looser at
# address (5-7 px on the first real setup, Oct 6, with the cameras still: the ball hadn't moved in
# either picture), while a camera that really moved missed by 43-50 px.
MOVED_PX_BODY = 12.0
# In the 3D key (app.pass_3d): changing how "moved" is judged checks the swings again.
CHECK_VERSION = 3
# The ball's place in a picture (share of its width, height) moved more than this: that camera moved.
BALL_MOVED = (0.04, 0.015)
BALL_SWINGS = 5


def session_for(name: str, times: dict, all_sessions: list[dict]) -> tuple[dict | None, str]:
    """The session for swing `name` (the latest made before it), or None and why not. times: swing ->
    unix time."""
    t = times.get(name)
    if t is None:
        return None, "no time"
    s = calib.session_before(t, all_sessions)
    if s is None:
        return None, "no calibration before this swing"
    return s, "ok"


def moved(doc: dict, session: dict) -> str | None:
    """Why the swing's 3D doesn't hold (a camera moved since the calibration), or None."""
    at = (doc.get("reprojection") or {}).get("address") or {}
    limit = MOVED_PX_BODY if session.get("method") == "body" else MOVED_PX
    if at.get("median") is not None and at["median"] > limit:
        return (f"a camera seems to have moved since calibration {session.get('id')}: at address the joints miss "
                f"by {at['median']:.0f} px (want under {limit:g})")
    return None


def ball_reference(balls: list[tuple[dict | None, dict | None]]) -> dict | None:
    """Where the ball is in each picture on the first swings after a calibration: {face: (x, y),
    dtl: (x, y)} from [(face ball, dtl ball)] in time order, or None if too few have both."""
    both = [(f, d) for f, d in balls if f and d][:BALL_SWINGS]
    if len(both) < 3:
        return None
    return {a: (float(np.median([b[i]["x"] for b in both])), float(np.median([b[i]["y"] for b in both])))
            for i, a in ((0, "face"), (1, "dtl"))}


def ball_moved(ref: dict | None, face_ball: dict | None, dtl_ball: dict | None) -> str | None:
    """Which camera moved, judged by the ball's place in its picture, or None."""
    if not ref:
        return None
    for a, b in (("face", face_ball), ("dtl", dtl_ball)):
        if not b:
            continue
        dx, dy = abs(b["x"] - ref[a][0]), abs(b["y"] - ref[a][1])
        if dx > BALL_MOVED[0] or dy > BALL_MOVED[1]:
            return (f"the {'face-on' if a == 'face' else 'down-the-line'} camera seems to have moved since the "
                    f"calibration (the ball is {100 * max(dx, dy):.0f}% of the picture away from where it was)")
    return None


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
