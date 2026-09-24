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
- Build: `JAVA_HOME=~/.jdks/jbr-21.0.11`, Gradle 8.9 `assembleDebug`, then `adb install -r`.

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
