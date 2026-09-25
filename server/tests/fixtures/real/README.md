# Real swings for the scorecard (no video)

Hand labels and the server's pose results for them, from the owner's own sessions, so `eval.py` can
score changes to `phases.js`, `summary.js` and `metrics.js` anywhere, without the clips or the server.
Refreshed from the server with `fixtures_export.py` whenever more swings are labeled.

- `labels/<clip>.json` (and `<clip>.pass2.json`): labeling mode's files (`static/labels.js`): key
  moments (clip seconds, the start of the frame), joints, club points (grip, hosel, head; `blur`,
  `hidden`), the ball. Left and right are the golfer's own (right-handed golfer).
- `pose/<clip>.v6.json.gz`: `pose.py` v6 output for each labeled clip and its other angle (MediaPipe
  landmarks per frame, smoothed; the club shaft angle; ball; impact).
- `pose-rtmpose-m/<clip>.v6.json.gz`: the same clips analyzed with `SWINGCLIPS_POSE_BACKEND=rtmpose-m`
  (RTMPose-m places the 2D body points; MediaPipe still gives the finger/foot points, world
  landmarks and the person mask). Made on the dev PC with `eval.py --rerun` (it needs the videos);
  likely what the server switches to. Score it with `SWINGCLIPS_POSE=tests/fixtures/real/pose-rtmpose-m`.
- `clips.json`: what the server's clip list says about each: angle, heard strike, partner, the
  camera's shutter/ISO (capture app 0.4+), clip quality, the paired Square launch-monitor shot.

Score (from `server/`; `--rerun` needs the videos, so not here):

    SWINGCLIPS_CLIPS=tests/fixtures/real/clips SWINGCLIPS_LABELS=tests/fixtures/real/labels \
    SWINGCLIPS_POSE=tests/fixtures/real/pose SWINGCLIPS_EVAL=/tmp/eval \
    python eval.py --no-noise --no-quality

Label definitions the owner used: takeaway = first frame the clubhead visibly moves back; P2/P6/P8
shaft parallel to the ground; P3/P5 lead arm parallel; P4 top; P7 impact = first frame the ball is
gone. Blur (Shift+click) only for motion streaks. The owner labels as a golfer, not a tracker: when
labels and the tracker disagree, look at why before assuming either is wrong.
