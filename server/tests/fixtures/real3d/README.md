# Real 3D swings (first session with both phones calibrated, 2026-10-02)

Six swings filmed from both phones after the cameras were placed from the golfer's body
(`session.json`: the calibration session, both cameras' lens and place, `method: "body"`).
Each `swing_<unix>.json.gz` holds:

- `main`, `other`: the face-on and down-the-line pose inputs as `swings.pose_input` builds them
  (name, strike, angle, rotation, frames with `lm` 33 x [x, y, visibility], impact, ball).
- `tri`: the 3D file the server made from them (`tri.swing`, VERSION 2).
- `club`, `time`.

What the golfer confirmed on the video: hips square to the ball at impact (the 3D says 0-9 degrees
open). Known problem: the thorax (shoulder) track jumps 30-45 degrees within 50 ms near the top,
where the arms cross the shoulders in the down-the-line view. No video.
