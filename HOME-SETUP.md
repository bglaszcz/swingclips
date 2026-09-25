# SwingClips at home

This fork adds a home setup on top of the original phone web app ([danny2p/swingclips](https://github.com/danny2p/swingclips)):
a phone app records each swing when it hears the strike (one phone face-on, optionally a second
down the line), a home server analyzes every clip and
serves a review page to any browser on the network, and each clip is tagged with the launch
monitor's numbers for that shot.

```
 Phones (capture app)         Home server (http://192.168.86.250:8000)       Sim laptop (Square Omni)
 face-on + down the line:     clips, pose, key positions, review page  <---  Square watcher: each new
 each hears the strike ->     (pairs the two angles of each swing)           shot from Square's app
 2 s + 2 s clip, uploads
```

## A session

1. **Server** - running (see "Server" below for updates).
2. **Laptop** - open Square Golf's app on the driving range, then run `Square watcher.cmd`
   (in `Dropbox\SwingClips`).
3. **Phones** - open **SwingClips** on each, check the angle (Face-on / Down the line),
   sensitivity and mode, then **Start recording** on both.
4. **Review** - `http://homeserver:8000` on a PC, or `http://192.168.86.250:8000` on a phone.

## Pieces

### `capture/` - the phone app (Android, Kotlin, Camera2)
- Keeps the last few seconds of video in memory (hardware encoder, keyframe every 0.25 s) and cuts
  a clip 2 s either side of each strike. Strike detection is the web app's: 1 kHz high-pass, energy
  over the threshold and 2.5x the previous windows, 3 s cooldown, 0-100 sensitivity.
- Modes: 1080p/720p at 240, 120 or 30 fps. 240 fps drops ~30% of frames on the S23 Ultra, 120 fps
  ~2-7%.
- Opens **not recording**; settings are locked while recording. Clips wait in an outbox and upload
  to `POST /api/upload`, retrying until the server confirms. Named
  `swing_<angle>_WxH_FPSfps_<unix>_<strike>ms.mp4`: angle `face` or `dtl`, the unix time of the
  strike on the **server's** clock (each phone reads it from `/api/time` at launch and at Start), and
  how many ms into the clip the strike was heard. Older clips, `swing_WxH_FPSfps_<unix>.mp4`, are
  face-on.
- Runs on Android 9+ (minSdk 28), so an old Galaxy S8 works as the second camera. Its modes are
  whatever its camera offers (the list is built per phone). If an encoder refuses the frame rate as
  an operating rate, the app retries without it.
- **Camera setup** (`CameraSetup.kt`): while not recording, a still of the preview (PixelCopy,
  upright, ~960 px) goes to `POST /api/setup/<angle>` about once a second. The server finds the
  golfer (MediaPipe on the still, ~25 ms) and judges it with `setupAdvice` in summary.js; the phone
  says the verdict out loud (Android text-to-speech) once it holds for two stills, repeats a problem
  every 12 s, and shows it under the status line. When the golfer has held still for two stills, the
  phone focuses and meters on them (AF regions + trigger, mapped from the upright picture to the
  sensor's 16:9 band) and holds that focus (AF mode AUTO) until they're somewhere else in the
  picture. Tested on the S21: "focused and locked" about 0.6 s after the trigger. The review page's
  **Camera setup** shows the latest still from each phone with the skeleton and the verdict.
- Build: `JAVA_HOME=~/.jdks/jbr-21.0.11`, Gradle 8.9 `assembleDebug`, then `adb install -r`
  (`%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe install -r capture\app\build\outputs\apk\debug\app-debug.apk`,
  one phone plugged in at a time; `-r` keeps the phone's settings).

### Two angles
- Each phone listens for the strike on its own; they don't talk to each other. The server pairs a
  face-on and a down-the-line clip whose strikes are within 2 s (strikes are at least 3 s apart).
- The review page lists one row per swing ("2 angles") and plays both side by side. The
  down-the-line video follows the face-on one: exactly when paused or stepping frames, and nudged
  back if it drifts while playing. They're lined up on impact: the frame the ball is gone in each
  clip when the server found the ball in both, else the strike each phone heard.
- Key-position cards show both angles; P1-P8 come from the face-on clip and are carried across by
  the sync. Down the line shows the skeleton, shaft, hand path, and the **plane line**: the shaft's
  line at address, across the picture (P). Deleting a swing moves both clips to the trash.
- Down-the-line numbers (`computeDTL` in `static/metrics.js`), on that video (Angles) and in their
  own section of the swing-numbers table, read at the face-on clip's P1 / P4 / P6 / P7: forward
  bend and its change from address, hips and head toward (+) or away from the ball (hips + at impact
  = early extension), hand height above and depth behind the middle of the shoulders, hands above (+)
  or below the plane line, and the shaft's angle vs the plane line (+ = steeper). The shaft is
  usually a blur in the downswing, so that last one is often blank; the hands are always tracked.
- A down-the-line clip with no face-on partner shows on its own, with only the down-the-line numbers.
- Placing the down-the-line phone: behind the golfer on the target line (through the hands or the
  ball), at about hand height, far enough back to fit the club at the top. Portrait, like face-on.
- **Camera check**: after each swing the review page says if a camera didn't see you well: partly
  out of the picture, near an edge, too small, or hands leaving the picture at the top
  (`cameraCheck` in summary.js). A camera that had you partly out of the picture or lost the hands
  has its body numbers left out of Trends and Progress for that swing. Without fixed spots for the
  phones, tape marks on the floor for each tripod foot (and a note of the height) make the setup
  repeatable; the first swing of a session tells you whether it's right.
- Sharp video matters as much as framing: plenty of light on the golfer (the phones shoot 1/240 s
  or faster), and the phone focused on the golfer, not the wall behind (tap on the golfer in the
  camera preview before starting, if the phone allows it).

### `server/` - the home server (Python, FastAPI)
- `D:\SwingClips\clips` (videos), `pose` (pose per clip, gzipped JSON), `shots.jsonl` (launch
  monitor shots), `clubs.json` (clubs corrected on the review page), `swings.json` (each swing's
  numbers), `journal.json` (handicap and session notes), `excluded.json` (swings left out), `trash` (deleted clips; emptied by hand, never automatically).
- A background worker runs MediaPipe pose on every frame of each new clip (4 processes, split at
  keyframes), then smooths it over the whole clip (median, then a local curve fit, so it doesn't lag
  fast hands). It also finds the ball on the mat near the golfer's feet and the first frame it's
  gone: that's impact, exact to the frame.
- It tracks the club shaft too (`club.py`): in each frame, the thin line running out from the hands
  that isn't part of the golfer (MediaPipe's person mask) or the empty scene. Where the shaft blurs
  out in the downswing, its angle is filled in between clear sightings.
- The page draws the skeleton, shaft and spine angle, finds P1-P8 (`static/phases.js`, anchored on
  that impact, or on the heard strike ~2 s into capture clips if the ball wasn't found), groups
  clips into sessions, deletes to the trash with Undo, and shows each clip's shot numbers. P2, P6
  and P8 are when the shaft passes horizontal; marked ~ when the shaft wasn't clearly seen then.
  A P6 crossing only counts 30-100 ms before impact (otherwise it's put 55 ms before, marked ~): in
  the downswing the tracker can latch onto the arms and "cross" right after the top.
  P1 (address) is 0.1 s before the shaft starts moving back. This assumes a face-on camera (see
  "Two angles" for the down-the-line one). Newer clips carry the heard strike's exact time, which
  narrows the impact search to ±0.15 s around it.
- Swing numbers (`static/metrics.js`), on the video (Angles) and in a table at address / top /
  P6 / impact: pelvis and shoulder turn, X-factor, lead arm, shaft, spine tilt, forward bend, hip and
  shoulder tilt, head sway / rise, hip sway, and tempo. Turns come from how much narrower the hips
  and shoulders look than at address; MediaPipe's 3D estimate (saved per frame as `w`) is only used
  for forward bend and for scale. Overlays: hand path, head position vs address. The hand path is
  the wrists and index fingers weighted by MediaPipe's confidence, smoothed over ±45 ms (a local
  curve fit that leans on confident frames and drops one-frame glitches), and ends once a wrist is
  lost behind the head in the finish. A kinematic
  sequence isn't attempted: from face-on alone the turn speeds come out in the wrong order.
- **Session trends** (Trends on a session in the list; `static/summary.js`): each swing's numbers
  (tempo, turns and sway at the top / impact, and the down-the-line ones: hips and bend at impact,
  hands to plane at P6 and the top, hand height and depth) against Square's (path, face, face to
  path, carry, offline, strike and so on). A scatter chart of any two, with the straight-line fit
  and r; a list ranking every number on the other side by how closely it goes with the chosen one;
  and a table of every swing. One club at a time by default. A link "stands out" when |r| is past
  what chance gives with that many swings (p < 0.05); fewer than 5 swings, nothing is ranked. It
  updates as swings arrive.
- **Swing numbers on the server** (`swings.py`): once a swing's clips are analyzed, a background
  worker runs the page's own JavaScript (phases.js, metrics.js, summary.js) in an embedded V8
  (`mini-racer`) and keeps each swing's body numbers, what could be measured (ball found, down the
  line, P6 estimated) and where the golfer stood in each picture, in `swings.json`
  (`/api/swings`). The records carry a fingerprint of that JavaScript: after an update that
  changes it, every swing is worked out again (~0.2 s each). Right-handed only, for now.
- **Progress** (button at the top): all sessions with one club over time. Tiles compare the latest
  session with the ones before it (median, or spread for consistency numbers), saying "better" /
  "worse" only when the change is bigger than the usual session-to-session difference; a chart of
  any number per session (swings, median, middle half); the shot pattern (carry vs offline, with
  a ring holding about two shots in three); the handicap index; and each session with a note
  (`journal.json`). When a phone is moved (the golfer's place in its picture shifts by 0.02
  picture heights or size by 6%; within a session it varies ~0.004 and ~2%), the chart marks
  "camera moved" and the tiles only compare that camera's numbers since then.
- **Compare** (Compare… or C on a swing; `static/compare.js`): this swing against another one,
  usually one of your own better ones. The picker lists every other swing with its date, club and
  Square numbers, filtered to this club and the last 90 days by default, sorted by carry (or ball
  speed, club speed, smash, straightest, newest). The two then play side by side, one row per
  camera angle both have. **Key positions** (default) lines them up by P1-P8, stretching the time
  between each pair in a straight line, so the reference plays faster or slower between them;
  **Real time** lines them up at impact only, both at real speed, so tempo differences show.
  Play, scrub, frame steps (← →) and P1-P8 (keys 1-8) move both. **Ghost** (G) draws the
  reference's skeleton, dashed, over this swing's video, lined up at address by the feet and hips
  and scaled by body height. Below: tempo, the body numbers at address / top / P6 / impact for both
  swings and the difference, and Square's numbers side by side; numbers from a camera that couldn't
  see all of a swing (the camera check) are greyed out. The address bar holds
  `#compare=<clip>,<clip>`, so a comparison can be bookmarked or sent. Swap puts the reference
  on the left; Esc closes it. Body numbers from different sessions only compare if the phones
  stood in the same places.
- **Leave out**: a swing that isn't yours (a friend hitting while the phones listen) is left out of
  Trends and Progress with the swing's Leave out button (`excluded.json`).
- **Wrong club?** When the club wasn't changed in Square's app, pick the right one on the swing's
  Club tile, or use "Change club…" in Trends for all the swings shown. The correction is kept per
  swing in `clubs.json` (Square's own club stays in `shots.jsonl` and shows as "(Square)" in the
  list); picking Square's club again removes it.
- Pose files are named by version (`<clip>.v6.json.gz`); when `pose.py` changes enough to bump
  `VERSION`, every clip is analyzed again on its own.
- Shots pair with clips by time: each source has a typical strike-to-report delay (Square's app
  ~14 s, GSPro connector ~1 s); each match records its gap.
- Deploy on the server: `git -C D:\SwingClips\app pull`, then `Stop server.cmd` and
  `Start server.cmd` (Stop also finds the background copy the auto-start task runs).

### The scorecard: how accurate is the tracking?
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
  the ball; your own consistency; and the **noise floor**, how much each number moves while you
  stand still at address, over every analyzed clip (no labels needed). Results go to
  `D:\SwingClips\eval\<date>_v<pose version>_<JavaScript fingerprint>.json`.
  - `--rerun`: analyze the labeled clips again with `pose.py` as it is now (cached per version of
    `pose.py`, `club.py` and the model), to try a change before deploying it.
  - `--compare <an earlier .json>`: every headline number, before and after.
  - `--no-noise`: skip the noise floor.
- Tests (no clips needed; a made-up swing): `cd server` then `python -m unittest discover tests`;
  the compare view's time mapping: `node --test tests/compare.test.js`.

#### Trying another body model
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

### `relay/` - launch monitor to server (runs on the sim laptop, nothing to install)
- **`square-watcher.ps1`** (used): Square Golf's Windows app saves every shot to a plain SQLite
  file, `%USERPROFILE%\AppData\LocalLow\Invant\Square Golf\SQGDB.bytes` (`IVShotLog`: ball data,
  flight result, club data as JSON). The watcher reads new rows read-only via Windows'
  `winsqlite3.dll` and posts them to `/api/shots`. Units: m/s and m (converted to mph and yd);
  spin axis and side spin are positive-left in Square's data and flipped to positive-right.
- **`shot-listener.ps1`** (alternative): stands in for GSPro on 127.0.0.1:921 so Square's
  official **SQG GSPro Connect** can be used instead of Square's app. Sends GSPro's player info
  and "ready" so the Omni arms. Square's connector sends each shot as a ball message then a club
  message, both flagged as heartbeats; no carry or club speed. If GSPro itself is ever used, set
  `<OpenAPIUseAltPort>true</OpenAPIUseAltPort>` in `C:\GSPro\GSPC\GSPconnect.exe.config` and relay
  to port 922.
- Not used, on purpose: the unofficial Bluetooth connector `brentyates/squaregolf-connector` was
  taken down by a DMCA notice (Sept 2026) alleging code taken from Square's private systems.

### The original web app (`src/`)
Danny's phone web app plus this fork's pose overlay and key-position stills, all on the phone.
The phone's browser can't record above 30 fps, which is why the capture app exists.

## Network notes
- Android can't resolve Windows PC names, so the phone app uses the server's IP. Reserve
  192.168.86.250 for the server in the router (done).
- The server needs inbound TCP 8000 allowed on private networks.

## Planned
Toward a single-digit handicap (16.4 in Sept 2026): see how the swing changes and which changes
help. Done so far: swing numbers on the server, Progress, Leave out, handicap log and notes.

1. **What helps, what hurts** (next): pool swings across sessions with one club and relate each
   move to each result. Within-session first ("on swings where I extended more than my usual that
   day, what did path do?"), which cancels day-to-day differences (warm-up, fatigue, camera
   placement); then between sessions. With ~18 moves x ~16 results, some links look strong by luck,
   so: a false-discovery correction, and a label per link: confirmed (same direction in most
   sessions), emerging, or could be chance; in plain words with the size of the effect ("each inch
   of early extension ≈ 0.8° more out-to-in path, 6 of 7 sessions"). Needs ~5-10 sessions of 20+
   swings with one club to say much.
2. **Focus tracking**: set a focus (a move, which way, optional target, start date) and see how the
   move and the results changed since, against the usual session-to-session variation.
3. **Compare two swings**: a reference swing (a good one, or one from before a focus) next to the
   current one, synced on impact, key-position cards lined up (the two-angle sync code carries
   over).
4. **Later, maybe: 3D from both cameras.** With the two phones' positions calibrated once,
   triangulate real 3D joint positions. That would replace the estimated face-on turns and could
   make a kinematic sequence possible. A much bigger project; only worth it if the estimated
   turns stop being good enough.
