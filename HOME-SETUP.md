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
5. **Practice** (optional) - on the review page, **Practice**: pick one number and a range, **Start
   practice**, then **Voice check**. The face-on phone says each swing's number (see "Practice mode").

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
- Sharp video matters as much as framing: plenty of light on the golfer (on Auto the phones shoot
  about 1/240 s at 240 fps; see "Shutter" below for faster), and the phone focused on the golfer, not the wall behind (tap on the golfer in the
  camera preview before starting, if the phone allows it).

### Shutter: a sharper club and hands (capture app 0.4)
On **Auto** (the default, same as before 0.4) the phone picks its own exposure, which at 240 fps
is about 1/240 s: the club is a faint streak through the downswing. The **Shutter** button (next
to the server address; locked while recording, like the other settings) sets a fixed short
exposure instead: **1/500**, **1/1000** or **1/2000**.
- **What it does**: the camera meters in auto for about half a second, then locks the shutter and
  raises the ISO by as much as the shutter got shorter (auto at 1/240 s ISO 400 -> 1/1000 s ISO
  ~1670), capped at the sensor's maximum. The frame rate stays the same. It meters again when you
  press Start, so the ISO fits the light at that moment. To re-meter during setup (after turning
  the lights on), pick the same shutter again.
- **It needs light**: 1/1000 s lets in a quarter of the light of 1/240 s. With the room lights
  only, the ISO hits its maximum and the picture gets dark and grainy; the phone says so ("ISO is
  at its maximum, so the picture will be darker"). Two LED floods on the golfer (from the front
  and side, out of the camera's view) are what makes 1/1000 work. Start with 1/1000; try 1/2000
  only if the picture stays clean at that.
- **What the phone says**: once the shutter is locked it says what the camera **reports** it is
  using, not what was asked for: "Shutter one thousandth, ISO 1600", and shows it under the
  buttons (green). Some Samsung phones ignore a manual shutter in 240/120 fps (high-speed)
  sessions. Then it tries auto exposure turned all the way down and locked; if that gives a
  shorter shutter, it says "This phone won't allow a fixed shutter at 240 fps. Locked darker
  instead: shutter one five hundredth, ISO 800" (amber). If that doesn't either, it goes back to
  auto and says "This phone won't allow a fixed shutter at 240 fps". Where the phone can run a
  normal (not high-speed) session at 120 fps with a manual shutter, the mode list then offers
  "720p · 120 fps (fixed shutter)" (only while a shutter is set), and the phone suggests it.
- **On startup**, the line under the buttons also shows what the camera allows: manual exposure
  yes/no, the shutter range, ISO range and exposure compensation range. The same goes to the log
  (`adb logcat -s SwingClips`, lines starting "camera" and "shutter:").
- **Checking a clip's shutter**: each clip is uploaded with what the camera used at the strike.
  The server keeps it next to the clip (`<clip>.camera.json`) and lists it in `/api/clips` as
  `camera`: `{"shutter": "1/1000", "exposure": "manual", "exposureNs": 1000000, "iso": 1600,
  "frameNs": 4166666, "shutterSpeed": 1000}`. `shutter` is the setting, `exposure` what the
  camera did with it (`auto`, `manual`, `compensation`, `refused`), `shutterSpeed` the real
  shutter as 1/n s. Clips from older app versions have `camera: null`. The server's window also
  prints it on each upload ("manual 1/1000 s ISO 1600"). By eye: at 1/1000 the clubhead is a
  short smear near impact rather than a long faint streak.

### Clip quality: light, flicker and sharpness (the shutter test without labels)
Once a clip's pose is saved, the server's pose worker measures the clip itself (`quality.py`) and
keeps it beside the pose file as `<clip>.quality.v2.json` (listed in `/api/clips` as `quality`).
Older clips are measured too, newest first, whenever there's no new clip to analyze (about 1-2 s
each on a 320-pixel test clip; expect several seconds for a full-size 240 fps clip). Updating to
v2 measures every clip again.
- **Brightness**: the golfer's mean brightness (0-255) at address, in the box round the pose
  landmarks. Under 70 is **dark**.
- **Noise**: grain in the background at address (outside the golfer and the club's reach): the
  spread of the difference between consecutive frames, with any change of brightness taken out
  first, in the same 0-255 units. **Grainy** from 5% of the golfer's brightness (about 5 at a
  brightness of 100; never under 2.5).
- **Flicker**: LED and fluorescent lights pulse at 100 or 120 Hz, which a short shutter catches.
  The background's brightness per frame is fitted with a sine at each frequency, against the
  clip's real frame times (phones drop frames); a swing of 2% or more that stands out from the
  frame-to-frame noise is **flicker**, with the light's frequency when it matches 100 or 120 Hz at
  the clip's frame rate. Banding (a rolling shutter catching the pulse partway down the sensor) is
  measured apart, along the sensor's lines; 1% or more also counts as flicker. At 120 fps a 120 Hz
  light pulses exactly once per frame and can't be seen from frame to frame (banding still shows).
  How much it matters depends on the shutter (`flickerLevel`): on **Auto** it's **mild** (the
  longer exposure evens most of each pulse out, and the numbers aren't affected) unless it's strong
  (8% or more, or banding of 4%); at a **fixed shutter** it **matters**.
- **Sharpness**: detail of the forearms and hands (variance of the Laplacian, after a light blur
  so grain doesn't count, inside a band along each forearm and hand from the pose points, over the
  variance of the brightness in that band) at address (P1) and at P5, P6 and P7 from the swing's
  key positions (a down-the-line clip's come from its face-on clip). Only the band is measured, and
  against its own contrast, so what's behind the arms (a busy wall at P6, a plain mat at address)
  counts little. P5-P7 are given as a share of the same clip's address, so clips in different light
  compare fairly: near 1 means the hands stay as sharp through the downswing as when still; a long
  shutter's streak brings it well down.
- **Only with a believable impact**: the key positions from the top on are placed from impact,
  which comes from the ball leaving the mat. Sharpness is only worked out when the ball was seen
  leaving 60 ms before to 10 ms after the strike the phone heard (from the clip's name; on good
  clips it's 20-35 ms before), in this clip and, for a down-the-line clip, in the face-on clip its
  positions come from. Otherwise `sharpnessSkipped` says why ("ball not found (down the line)",
  "impact doubtful (face-on): 24 ms after the heard strike") and `impact` has each clip's numbers.
  A wrong impact moves P5-P7 off the downswing, and the ratio then comes out backwards.
- **Review page**: the camera check above the videos adds **dark**, **flicker** (worded by
  shutter: mild on Auto, something to fix at a fixed shutter) and **grainy** with what to do, the
  ball-not-found / impact-doubtful item, and (grey) the shutter setting and what each camera
  really used, from `camera.json`. Clips from before capture app 0.4 simply don't show that line.
- **Shutter test** (button at the top): every analyzed clip grouped by camera and shutter setting
  (Auto, 1/500, 1/1000, 1/2000; "unknown" before app 0.4; "1/1000 (compensation)" where the phone
  locked darker instead), over all clips and per session, with the real shutter, ISO, brightness,
  noise, flicker (and how many were mild), how many clips sharpness could be measured on, and
  sharpness side by side; green marks the best setting for each camera. To run the test: one
  session, same lights, 10 or so swings on Auto, then 10 at 1/1000 (and 1/2000 if the picture stays
  clean). A fixed shutter is working when P5-P7 / address is clearly higher than on Auto, measured
  on most of its clips, with the golfer not dark and no flicker that matters.
- The same table is in the scorecard (`eval.py`, below), next to the noise floor.
- **Tuned on real clips** (v2): down-the-line clips from a Galaxy S21, 1080p at 240 fps, in a barn
  with standard LED bulbs, as v1 measured them. Auto (1/250 s, ISO ~2,800-3,000): brightness
  102-109, noise 2.7-3.75, 120 Hz flicker of 2.9-3.8%, banding 1.4-1.5%; they look normal by eye,
  and v1's grainy (2.5) was too strict. Fixed 1/1000 s (ISO capped at 3,200): brightness 63-65
  (dark, rightly), noise 2.1-2.35 (the phone denoises, so grain stays near a fixed share of the
  brightness), flicker 3.7-4.2%, banding 2.0%. On the dark 1/1000 clips pose.py's ball-gone impact
  failed (no ball, or the wrong spot: impact 100 ms late, or 24 ms after the heard strike), and v1's
  sharpness came out backwards (0.8 at 1/1000 against 1.3 on Auto) though the 1/1000 frames are
  clearly sharper by eye. What v2 changes isn't tried on real clips yet (it can't be here): check
  a few clips by eye, and adjust the constants at the top of `quality.py` (bump its `VERSION` so
  every clip is measured again). The real fix for the dark clips is light on the ball and golfer.

### Trust per number: ok, shaky, no reading
Every body number on the page (the swing numbers table and tempo line, the numbers over the video,
Compare, Trends, Progress, and practice mode) is judged by one rule set (`static/trust.js`; the
server runs the same file), so they all agree:
- **ok**: shown as it is.
- **Shaky**, greyed with a small **~** (hover for why): the key position it's read at was estimated
  (P6); the ball wasn't seen leaving, or left too far from the heard strike, so the key positions
  from the top on (P5-P7, tempo and downswing time) hang on a doubtful impact; the camera's light
  check says **dark**, or **flicker** that matters (a fixed shutter); the noise floor says it moves
  more while you stand still at address than half its usual swing-to-swing spread in a session;
  or it's noisy by definition (head rise, and the plane numbers: hands and shaft to plane).
- **No reading**, shown as **--** (hover for why): the camera check says part of you was out of
  the picture (`out`) or your hands left it at the top (`hands`), or there's no number.
- **The noise floor per number** comes from recent swings (the last 300): how much each number moves
  in the 0.35-0.05 s before the takeaway (the same spread as the scorecard's noise floor, kept per
  swing in `swings.json`), against its standard deviation within a session (a 45-minute gap starts
  a new one), one club at a time, in sessions of at least 5 swings and 10 swings over them. The
  server works it out whenever swings are analyzed (and every 10 minutes) and keeps it in
  `noise.json` next to the clips folder (`/api/noise`); the page doesn't recompute it. A number
  that's the same on every swing by definition (a turn at address) isn't judged.
- **Trends and Progress** leave out numbers with no reading everywhere (charts, the "what goes
  with" ranking, session medians). Shaky ones are hollow dots in the scatter and over-time charts
  and greyed in the tables; **Leave out shaky** (Trends and Progress, one setting) takes them out of
  the charts and correlations too. A Progress tile is greyed when most of the latest session's
  swings behind it are shaky.
- **Practice mode** speaks a number unless it has no reading, or was read at an estimated P6 (as
  before); the other shaky ones are still spoken.

### Practice mode: the phone says the number (capture app 0.5)
Pick one thing to work on and a range; after each swing the phone says the number and whether it
was in range: "Tempo 3.2, in range", "Club path minus 4, too far left", "Early extension 2, too far
toward the ball". The phones face away from you, so voice is the channel.

- **Setting it up** (review page, **Practice** at the top): pick the number, the club, and the
  range. **Use middle half** sets the range to the middle 50% of your last 30 swings with that club
  (it fills in by itself when you pick a number; edit it to taste, e.g. narrower to push a change).
  **Start practice** saves it on the server (`practice.json`); only swings struck after that are
  spoken. Changing the number or range while on (**Save range**) starts over from the next swing.
  **Stop practice**: nothing is spoken. **Say "3 in a row"** adds the streak to an in-range swing
  from the third one on ("Tempo 3.1, in range, 3 in a row"); a "no reading" doesn't break it, an
  out-of-range swing, a new range or a new session does.
- **What can be practiced**: body numbers (tempo, backswing and downswing time, head and hip sway,
  head rise, spine tilt at impact; down the line: early extension, bend vs address, head to ball,
  hands and shaft to plane, hand height and depth at the top) and Square's (club path, face to path,
  face, attack angle, carry, offline, smash, club and ball speed, launch). Face-on turns (shoulder,
  pelvis, X-factor) aren't offered: from one camera they're estimated from how narrow the body
  looks, not good enough to judge one swing by. Marked **(noisy)** in the list, with why: head rise
  (close to the tracking noise), hands to plane at P6 and at the top and shaft to plane at P6 (they
  need the shaft seen at address, and P6 is often estimated). They work, but judge them over
  several swings, not one.
- **Only numbers that can be trusted are spoken** (the trust rules above, `static/trust.js`, which
  the server runs). A body number from a camera whose camera check says you were partly out of the
  picture or your hands left it at the top (`quality.camera`: `out`, `hands`), a P6 number where P6
  was only estimated, or a number that couldn't be measured is **"no reading"** instead. Square's
  numbers don't depend on the cameras.
- **When it speaks**: body numbers once the swing is analyzed (the upload settles for 15 s, then
  pose and the numbers: usually 30-60 s after the strike; given up after 4 minutes as "no
  reading"). A down-the-line number waits up to 90 s for the down-the-line clip if it hasn't come
  in. Square's numbers once the shot pairs, about 15 s after the strike; with no shot by 25 s it
  says "Club path, no shot". Each swing is spoken once, even if its face-on clip arrives after the
  down-the-line one.
- **Which phone speaks**: a setting on each phone, **Practice voice: on / off**. Until changed by
  hand, the face-on phone speaks and the down-the-line one doesn't (it follows the angle setting).
  It stays usable while recording, and changes nothing about recording. **Voice check** on the phone
  says a sample sentence and shows the media volume (what speech uses), with a warning when it's
  muted or below half. **Voice check** on the review page makes the speaking phone say "Practice
  voice check", which tests the whole path: the server, the Wi-Fi, the phone, its volume. The
  panel's top line says which phone is listening.
- **How it gets to the phone**: the server makes each sentence (`practice.py`, a worker checking
  the new swings every second while practice is on) and keeps it in `practice-log.jsonl`. The
  phone asks `GET /api/practice/latest?since=<id>&angle=face&wait=20`; the server holds the request
  until there's a result or 20 s pass (a long poll), so results come within about a quarter of a
  second. The first request (no `since`) only returns the latest id, so a phone that starts
  listening doesn't read out old swings. Ids are the server's milliseconds, so they survive a
  server restart. After a Wi-Fi drop the phone retries (1, 2, 4, 8, then every 10 s) and skips
  results older than 45 s: by then you've hit again.
- **The log** (bottom of the panel): per session, each spoken swing (time, number, in range / out /
  no reading, and why) and the share in range for each range used ("Tempo 2.8 to 3.4: 14 of 20 in
  range (70%), 2 no reading"). No readings don't count toward the share. Tap a row to open the swing.
- Endpoints: `GET /api/practice` (target, the list of numbers, the log, which phones listened),
  `POST /api/practice` (`{on, metric, min, max, club, streak}`), `POST /api/practice/test`,
  `GET /api/practice/latest`.

### `server/` - the home server (Python, FastAPI)
- `D:\SwingClips\clips` (videos), `pose` (pose per clip, gzipped JSON, and its quality record), `shots.jsonl` (launch
  monitor shots), `clubs.json` (clubs corrected on the review page), `swings.json` (each swing's
  numbers), `noise.json` (the noise floor per number, for the trust rules), `journal.json` (handicap and session notes), `excluded.json` (swings left out),
  `practice.json` and `practice-log.jsonl` (practice mode's target and what was spoken), `trash` (deleted clips; emptied by hand, never automatically).
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
  P1 (address) is 0.1 s before the shaft starts moving back (the takeaway: the first frame the
  shaft turns away from its angle at address). P3 / P5 are where the lead forearm passes level,
  P4 where the hands start down; they follow your hand labels (`docs/key-positions.md`, and
  `tune_positions.py` to score them again after labeling more). This assumes a face-on camera (see
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
  worker runs the page's own JavaScript (phases.js, metrics.js, summary.js, trust.js) in an embedded
  V8 (`mini-racer`) and keeps each swing's body numbers, what could be measured (ball found, down the
  line, P6 estimated, the camera check with the impact item) and where the golfer stood in each
  picture, in `swings.json` (`/api/swings`); plus, for the noise table only, every number at P1, P4,
  P6 and P7 and each camera's noise floor at address (not sent to the page). The records carry a fingerprint of that JavaScript: after an update that
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
  the server's quality records; see "Clip quality" above). Results go to
  `D:\SwingClips\eval\<date>_v<pose version>_<JavaScript fingerprint>.json`.
  - `--rerun`: analyze the labeled clips again with `pose.py` as it is now (cached per version of
    `pose.py`, `club.py` and the model), to try a change before deploying it.
  - `--compare <an earlier .json>`: every headline number, before and after.
  - `--no-noise`: skip the noise floor.
  - `--no-quality`: skip the clip quality table.
  - With the club model (see "Training the club model"), a clubhead table too: its distance
    from the labeled clubhead, by phase.
- Tests (no clips needed; a made-up swing): `cd server` then `python -m unittest discover tests`;
  the compare view's time mapping and the trust rules: `node --test tests/compare.test.js
  tests/trust.test.js`. Practice mode's sentences,
  camera gating and waits (synthetic swings and shots): `python -m unittest tests.test_practice`;
  the phone's side of it (JVM, no phone): `gradlew :app:testDebugUnitTest` in `capture`.

#### The server's body model: RTMPose-m (from 2026-09-25)
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

#### Training the club model
The shaft tracker (`club.py`) casts rays from the hands and looks for a thin line that isn't the
golfer or the empty scene. It loses the club in the fast part of the downswing, where the shaft is a
faint blur. The plan is a learned model instead: YOLO11 pose with three keypoints, **grip end,
hosel, clubhead**, trained on your own club labels (blurred clubhead included), with `club.py`'s
tracking kept on top as the filter. Like the other body models, it's for the scorecard until it
scores better: `SWINGCLIPS_CLUB_BACKEND=raycast` (default, output unchanged) or `yolo`.

**1. Labels.** Start with the frames already labeled (the club points in labeling mode, above).
Aim for **500 to 1,500 frames with the club labeled**, about half of them in the downswing and
follow-through: that's ~40-100 swings at ~12 frames each (the suggested frames lean that way
already). Mix both angles, clubs (driver, irons, wedge), day and night light. Put a blurred
clubhead in the middle of the streak with **Shift+click**; press **X** for a point you can't see.
Below ~300 frames the model will mostly learn these particular swings; past ~1,500 the gains are small.

**2. The dataset**, on a PC with the clips and labels: the server (its own `.venv` has everything),
or another PC with `SWINGCLIPS_CLIPS` (and `SWINGCLIPS_LABELS`, if not next to it) pointing at them:

```
cd /d D:\SwingClips\app\server
.venv\Scripts\python.exe club_dataset.py --out D:\SwingClips\club-dataset
```

- Each labeled frame becomes an upright picture in `images\train` or `images\val` and a line in
  `labels\...` (YOLO pose: the club's box, then x, y, visibility for grip, hosel, head).
  Can't-see (X) or skipped points get visibility 0; blurred ones stay visible. A frame with all
  three marked can't-see is kept with no club in it.
- Train and validation are split **by swing** (both angles of a swing go together), ~20% for
  validation (`--val 0.3` for more), picked the same way on every run. Frames of one swing never
  land on both sides, so the validation numbers aren't flattered by near-duplicate frames.
- It prints how many frames, blurred clubheads and swings went each way; `dataset.json` lists them.
  Running it again rebuilds the folder. Copy the whole folder to the gaming PC (`data.yaml` points
  to its own folder, so it works from anywhere).

**3. Training**, on the gaming PC (RTX 5070 Ti). A Blackwell card (sm_120) needs PyTorch built
for **CUDA 12.8 or newer**: the plain `pip install torch` on Windows is CPU-only, and builds for
CUDA 12.6 and older can't run on it. Needs a current NVIDIA driver (570 or newer) and 64-bit
Python 3.12 from python.org. In a Command Prompt, with the repository cloned to `C:\swingclips`:

```
cd /d C:\swingclips\train
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -c "import torch; print(torch.__version__, torch.cuda.get_device_name(0), torch.cuda.get_arch_list())"
.venv\Scripts\python.exe club_train.py --data D:\club-dataset\data.yaml
```

- The check line should name the RTX 5070 Ti and list `sm_120`. `club_train.py` checks this too
  and stops with a hint if the build can't use the card.
- Defaults: `yolo11s-pose` from Ultralytics' COCO weights (downloaded the first time), 150 epochs
  at 640 px, batch 16, stopping early when validation hasn't improved in 40. For ~1,000 frames
  that should be well under an hour on a 5070 Ti (not yet timed). `--model yolo11n-pose.pt` is the small one, about 3x cheaper on the
  server's CPU; try it if `s` turns out slow (the scorecard prints the club model's ms per frame).
- Augmentation: left-right flips (the three points have no side, so each keeps its place:
  `flip_idx: [0, 1, 2]`), brightness (`hsv_v`, brightness/contrast, gamma), motion blur (up to
  21 px, any direction) and JPEG artefacts, on top of Ultralytics' mosaic, scaling and shifts.
- The run goes to `train\runs\club` (`results.png`, validation pictures, `weights\best.pt`),
  and the ONNX model to `public\models\club-yolo-pose.onnx`. Copy that file to the server's
  `D:\SwingClips\app\public\models` (not in git).
- Optional first pass on the public Roboflow **golf_club_pose** set (export it as "YOLOv8 Pose",
  unzip): `club_train.py --data ... --pretrain D:\golf_club_pose\data.yaml`. Its keypoints may not be
  grip, hosel, head in that order: run it once without `--pretrain-points` and it prints the set's
  classes and keypoints, then give their order, e.g. `--pretrain-points 0,-1,1` (-1 for one it
  doesn't have). If its keypoints aren't these points at all (say, only the shaft's ends), skip it.
  Compare the scorecard with and without it; the pretraining only helps if it helps there.

**4. Scoring it**, on the server (or any PC with the clips, labels and the model file):

```
cd /d D:\SwingClips\app\server
.venv\Scripts\python.exe eval.py --rerun --only-val D:\SwingClips\club-dataset\dataset.json
set SWINGCLIPS_CLUB_BACKEND=yolo
.venv\Scripts\python.exe eval.py --rerun --compare --only-val D:\SwingClips\club-dataset\dataset.json
```

- `--only-val` scores only the dataset's validation swings, which the model never trained on.
  Without it, most of the labeled frames were in the training set and the numbers look better
  than they'll be on new swings. (Drop it to see everything, on both runs.) Even better, now and
  then: label a few new swings after training and score them.
- The first run, without the setting, is the ray-casting baseline (skip it if you have one from
  this `pose.py` over the same validation swings: `--compare` on its own picks the newest
  baseline over the same clips). `--compare` then shows every headline number before and after: the club table's
  **% found** and **angle error by phase** (downswing is the one to watch), and P2 / P6 / P8 timing,
  which hangs on the shaft.
- A new table, **Clubhead**, only with the model: the clubhead's distance from your label as a %
  of nose-to-ankle height by phase, with blurred frames on their own. The page doesn't use the
  clubhead yet; it's saved per frame in the pose file (`clubhead`: x, y, confidence).
- The pose files and results carry the model's name and a hash of the file
  (`club-yolo-pose@1a2b3c4d`), so every retraining gets its own `--rerun` cache and result file.
  `SWINGCLIPS_CLUB_MODEL` points at another file to compare two models. `set SWINGCLIPS_CLUB_BACKEND=`
  goes back to the ray casting in that window.
- Using it on the server for real: set `SWINGCLIPS_CLUB_BACKEND=yolo` for the server itself, and
  bump `VERSION` in `pose.py` so every clip is analyzed again. Only once the scorecard says it's better.

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
help. Done so far: swing numbers on the server, Progress, Leave out, handicap log and notes,
practice mode (one number, spoken after each swing).

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
