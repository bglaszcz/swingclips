# The scorecard: labels and tracking accuracy

Labeling, `eval.py`, the body model, the ball search, and trying other body models. (Moved out of HOME-SETUP.md, which has the session checklist, setup and troubleshooting.)

## The scorecard: how accurate is the tracking?
Hand labels on a set of clips, and a script that measures the pipeline against them, so a change
to `pose.py`, `club.py` or `phases.js` can be shown to help (or not) instead of judged by eye.

- **Labeling** (`static/labels.js`): open a swing, press **L** (or Label). The tracker's skeleton
  and numbers are hidden meanwhile so they don't sway you. On the frame on screen: **T** takeaway
  (the first frame the club moves), **2-6** and **8** for P2-P6 and P8, **7** or **I** impact (the
  first frame the ball is gone); again on the same frame to clear. Then click the points in the
  order shown (shoulders, elbows, wrists, hips, then the club's grip end, hosel and clubhead):
  **Shift+click** when it's a blur (put the clubhead in the middle of the streak), **X** when it
  can't be seen, **Tab** to skip, **Backspace** to undo. **B** then a click places the ball (at
  address). **[ ]** step through about a dozen suggested frames, most of them in the downswing.
  **D** switches between the two angles (the arrow keys then step that angle's own frames). Left
  and right are the golfer's own: face-on, their left is on the picture's right.
- **Where to click**: each joint's centre, not the outline of the body. The hip is where the thigh
  bone meets the pelvis, well inside the hips' outline; the shoulder is the top of the arm bone.
  A joint covered by an arm or the club is still clicked where it must be (a normal click); **X**
  only when it can't be placed at all.
- **Labels** (button at the top; `static/labelview.js`, checks in `labelcheck.py`): progress toward
  the goals (key moments on both angles of 20 swings, points on 10), which clubs, light, shutter
  settings and days the labeled swings cover, each labeled swing with what's done per angle, and
  what to check: moments out of order, left/right that look swapped against the tracker, the ball
  far from the tracker's, impact away from the ball-gone frame, joints all marked blurry, the other
  angle not labeled. "Label next" suggests unlabeled swings from what's least covered. Tap a swing
  to open it in labeling mode.
- Saved as you go, one file per clip, in `D:\SwingClips\labels` (`<clip>.json`). **Pass 2** is a
  second labeling, done days later without looking at the first (`<clip>.pass2.json`): the
  difference is how consistent the labels themselves are, the finest any tracker can be scored.
  Labels stay when a clip goes to the trash (the scorecard looks for it there too).
- What to label: about 20 swings with both angles (driver, 7 iron, wedge; some misses; day and
  night light). Moments on all of them (~2 minutes a clip); points on about half (~15 minutes a clip).
- **Scorecard** (`eval.py`), on the server or any PC with the clips and pose files:
  `.venv\Scripts\python.exe eval.py`. It runs the page's own JavaScript (as `swings.py` does)
  and prints: key-position error in ms and frames (and pose.py's own ball-gone impact); joint
  error as a share of nose-to-ankle height by swing phase; left/right swaps; shaft found and its
  angle error; the one-frame angles (tilts, lead arm, forward bend) from tracked vs labeled joints;
  the ball; your own consistency; the **noise floor**, how much each number moves while you
  stand still at address, over every analyzed clip (no labels needed); and **clip quality by
  shutter** (brightness, noise, flicker and sharpness grouped by camera and shutter setting, from
  the server's quality records; see "Clip quality" in [phones.md](phones.md)). Results go to
  `D:\SwingClips\eval\<date>_v<pose version>_<JavaScript fingerprint>.json`.
  - `--rerun`: analyze the labeled clips again with `pose.py` as it is now (cached per version of
    `pose.py`, `club.py` and the model), to try a change before deploying it.
  - `--compare <an earlier .json>`: every headline number, before and after.
  - `--no-noise`: skip the noise floor.
  - `--no-quality`: skip the clip quality table.
  - With the club model (see [club-model.md](club-model.md)), a clubhead table too: its distance
    from the labeled clubhead, by phase.
- Tests (no clips needed; a made-up swing): `cd server` then `python -m unittest discover tests`;
  the compare view's time mapping and the trust rules: `node --test tests/compare.test.js
  tests/trust.test.js`. Practice mode's sentences,
  camera gating and waits (synthetic swings and shots): `python -m unittest tests.test_practice`;
  the phone's side of it (JVM, no phone): `gradlew :app:testDebugUnitTest` in `capture`.

### The server's body model: RTMPose-m (from 2026-09-25)
Scored on 18 hand-labeled clips, RTMPose-m beat MediaPipe on nearly everything: face-on downswing
wrists 4.7% -> 1.7% of height, P4 (top) 87 -> 33 ms face-on and 75 -> 19 ms down the line, shoulder
tilt 6.3 -> 2.6 degrees. It costs ~45 ms per frame per worker on top of MediaPipe (~10-15 s more a clip).

The server's own settings live in `server\settings.cmd` (not in git), which `Start server.cmd` calls:

```
set SWINGCLIPS_POSE_BACKEND=rtmpose-m
```

- On start the server downloads the model if it's missing (~50 MB into `public\models`); if it can't,
  it says so and uses MediaPipe until the next start.
- Every pose file records which model made it. When nothing new is waiting, the server analyzes
  again, newest first, each clip made by another model (~30 s a clip), and its quality and swing
  numbers follow. A clip that fails keeps its old result. Delete the line (or the file) to go back:
  the clips are then analyzed again with MediaPipe the same way.

### The ball search (pose.py, `BALL_VERSION` 4)
Impact is the first frame the ball is gone. A spot only counts as the ball if it's a ball's size
(1-3% of nose-to-feet height), where a ball sits for the camera's angle (face-on below the feet;
down the line level with them or a little above) and leaves between 80 ms before and 10 ms after
the strike the phone heard: sound arrives after the ball goes, never before. (Wrong spots once left
~105 ms after the strike and put a swing's two angles 110 ms apart.) When only the ball search
changes, the server checks each analyzed clip again in the background, a few seconds a clip: a
saved ball that passes is kept, others are found again, and the swing's numbers follow
("Ball: <clip>: impact 2.19 s -> 2.06 s" in the window).

### Trying another body model
`models.py` can put the 2D joints from RTMPose or RTMW instead of MediaPipe, for the scorecard
only: the server itself keeps using MediaPipe unless the setting below is made in *its* window, and
MediaPipe still runs alongside either way (the person mask for the club, the 3D estimate for forward
bend and scale, and any point the other model doesn't have). `SWINGCLIPS_POSE_BACKEND` picks it:
`mediapipe` (default), `rtmpose-m` (256x192, 17 points), `rtmpose-l` (384x288, 17 points) or `rtmw`
(RTMW-l 384x288, 133 points: adds heels, toes and the index fingers, which the club's grip uses).
Each crop is around the golfer: the previous frame's points plus 25%, or MediaPipe's on the first
frame and after the model loses them.

In a Command Prompt on the server:

```
cd /d D:\SwingClips\app\server
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe fetch_models.py
.venv\Scripts\python.exe eval.py --rerun
set SWINGCLIPS_POSE_BACKEND=rtmpose-m
.venv\Scripts\python.exe eval.py --rerun --compare
```

(With a GPU package picked in `settings.cmd`, install `requirements-dml.txt` or
`requirements-cuda.txt` instead of `requirements.txt`: see "Using a GPU" in [performance.md](performance.md).)

- `fetch_models.py` downloads the three models (~400 MB, from MMPose's releases) into
  `public\models` (not in git); `fetch_models.py rtmpose-m` for just one.
- The first `eval.py --rerun`, without the setting, is the MediaPipe baseline. `--compare` on its
  own compares with the newest MediaPipe result; give it a file to compare with that instead.
- Each model's reruns are cached apart (`D:\SwingClips\eval\pose\<fingerprint>`), and results are
  saved with the model in the name (`..._rtmpose-m-256x192.json`). `set SWINGCLIPS_POSE_BACKEND=`
  goes back to MediaPipe in that window.
- It prints the cost per frame for each clip (`pose: <clip>: <n> frames, MediaPipe <ms> ms/frame,
  rtmpose-m-256x192 <ms> ms/frame (in each of 4 worker(s))`), and the pose files keep it
  (`msPerFrame`). Each worker runs the model on one thread; `set SWINGCLIPS_ORT_THREADS=2` to try two.
- Confidence isn't on the same scale as MediaPipe's visibility (the model's peak score, 0-1), and
  the page weighs the hands by it. Worth keeping in mind if hand numbers shift.
