# The phones: capture app, two angles, shutter, clip quality, Ready panel

How the capture app records, how the two angles pair, the shutter and clip quality checks, and how the phones talk to the server. (Moved out of HOME-SETUP.md, which has the session checklist, setup and troubleshooting.)

## `capture/` - the phone app (Android, Kotlin, Camera2)
- Keeps the last few seconds of video in memory (hardware encoder, keyframe every 0.25 s) and cuts
  a clip 2 s either side of each strike. Strike detection is the web app's: 1 kHz high-pass, energy
  over the threshold and 2.5x the previous windows, 3 s cooldown, 0-120 sensitivity (`Trigger.kt`:
  0-100 = a window's energy over 150 down to over 10, 110 / 120 = over 6 / 2; `status.threshold_for`
  is the same scale). From 0.12 the sensitivity also changes while recording, from the phone or the
  Start page (`POST /api/phones/sensitivity {value, angle}`; the phone gets `sensitivity` in its next
  poll reply, and the server drops the request once the phone reports it, or after 60 s). Each poll
  reports `sensitivity`, `threshold`, `noise` (the level 9 windows in 10 stay under, last ~5 s) and
  `sounds`: the loud, sudden sounds of the last 2 minutes (level >= 2 and 1.5x louder than just
  before, the loudest per second) on the server's clock, each with what came of it: `strike`,
  `quiet` (under the threshold), `notSudden` (under 2.5x), `cooldown`, `ownVoice`, `otherTalking`.
  The server keeps 30 minutes of them (`Status.sounds`) for the Start page's strike levels and the
  Missed shots check (`Status.missed_check`: the loudest sound 3-20 s before each missed Square shot,
  and the lowest sensitivity, in steps of 5, whose threshold is at most 80% of the softest one).
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
  shows it under the status line. Who says it: from 0.11 nobody by default (**Setup voice: off**; the
  Start page's live stills are the check, and the stills still go to the server). With **combined** the
  server combines both phones' verdicts and one phone says them (see "Ready panel" below); with
  **Setup voice: this phone** the
  phone says its own verdict out loud (Android text-to-speech) once it holds for two stills and
  repeats a problem every 12 s, as before 0.6. A phone set to "combined" that can't reach a 0.6
  server speaks for itself too. When the golfer has held still for two stills, the
  phone focuses and meters on them (AF regions + trigger, mapped from the upright picture to the
  sensor's 16:9 band) and holds that focus (AF mode AUTO) until they're somewhere else in the
  picture. Tested on the S21: "focused and locked" about 0.6 s after the trigger. The review page's
  **Camera setup** shows the latest still from each phone with the skeleton and the verdict.
- Build: `JAVA_HOME=~/.jdks/jbr-21.0.11`, Gradle 8.9 `assembleDebug`, then `adb install -r`
  (`%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe install -r capture\app\build\outputs\apk\debug\app-debug.apk`,
  one phone plugged in at a time; `-r` keeps the phone's settings).

## Two angles
- Each phone listens for the strike on its own; they don't talk to each other. The server pairs a
  face-on and a down-the-line clip whose strikes are within 2 s (strikes are at least 3 s apart).
- The review page lists one row per swing ("2 angles") and plays both side by side. The swing view features a phase scorecard that details how each part of the swing went (Address to Finish), tagging faults and comparing numbers to the golfer's personal good-shot range. The
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

## Shutter: a sharper club and hands (capture app 0.4)
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

## Clip quality: light, flicker and sharpness (the shutter test without labels)
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
- **Review page**: the camera check (a camera icon at the end of the swing's header, amber when something
  changes the numbers; hover or tap for the notes) adds **dark**, **flicker** (worded by
  shutter: mild on Auto, something to fix at a fixed shutter) and **grainy** with what to do, the
  ball-not-found / impact-doubtful item, and (grey) the shutter setting and what each camera
  really used, from `camera.json`. Clips from before capture app 0.4 have no icon unless there's a note.
- **Shutter test** (button at the top): every analyzed clip grouped by camera and shutter setting
  (Auto, 1/500, 1/1000, 1/2000; "unknown" before app 0.4; "1/1000 (compensation)" where the phone
  locked darker instead), over all clips and per session, with the real shutter, ISO, brightness,
  noise, flicker (and how many were mild), how many clips sharpness could be measured on, and
  sharpness side by side; green marks the best setting for each camera. To run the test: one
  session, same lights, 10 or so swings on Auto, then 10 at 1/1000 (and 1/2000 if the picture stays
  clean). A fixed shutter is working when P5-P7 / address is clearly higher than on Auto, measured
  on most of its clips, with the golfer not dark and no flicker that matters.
- The same table is in the scorecard (`eval.py`, [scorecard.md](scorecard.md)), next to the noise floor.
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

## Ready panel: both phones from the review page (capture app 0.6)
One place to see "ready", and fewer walks to the phones. The phones face away from you, so the
review page starts them and one of them does the talking.

- **The Ready bar** (top of the review page, `static/status.js`): a dot and a line (green "Ready",
  or the first problem), a dot per part, and **Start both** / **Stop both**. Tap the line for a row
  each (it remembers open or closed):
  - **each phone**: connected, recording, mode, shutter setting and what the camera really used,
    battery (amber under 20% when not charging), clips waiting to upload (amber from 3), free
    storage, which phone speaks, and its **Start** / **Stop** with how the last command went
    ("Starting...", "Started", "Couldn't start: the camera isn't running yet", "no answer from the
    phone"). A phone seen in the last 12 hours is expected: Ready needs it recording.
  - **Square**: the laptop's heartbeat (the watcher), whether Square's app is running, the last shot.
    No heartbeat yet is amber (an older watcher), a stopped watcher or a closed Square app is red.
    With the GSPro connector it reads **Square (GSPro connector)**: the shot listener's heartbeat,
    whether the connector is connected to it and has a ball ready; red when the listener stopped or
    the connector isn't connected (with "close Square Golf's app" when that's open).
  - **Framing**: the latest camera setup verdict per phone. Only a live one (while the phone is in
    setup) can turn it red: the last still before recording is often you walking away from the ball.
  - **First swing**: the session's first swing check (below), once there is one.
  - **Server**: clips waiting for pose (amber from 3).
- **Start / Stop from the page**: the phone does exactly what its own Start/Stop button does, with
  its saved settings, and says "Recording" or "Stopped". It refuses to start while one of its
  settings dialogs is open or its camera is restarting (a setting just changed), or after a camera
  error, and says why ("Can't start: ..."); the page shows the same. A command not answered in 20 s
  is "no answer" and isn't carried out later. **Auto-start** (a phone setting, off by default):
  "Start recording when the camera check is good": once per opening of the app, when its own camera
  check has held good for two stills. After a Stop it doesn't start again by itself until the app is
  opened again. **Start recording asks for the session to record** (`status.py want`): a phone that
  wasn't connected when it was pressed (its app closed or in the background) is started by the server
  when it reports in, and again when it comes back from the background, until Stop on the page,
  Stop on the phone itself, or an hour without recording (logged as `autostart`).
- **One voice for camera setup**: the server combines the verdicts of the phones in setup (not
  recording) and set to **Setup voice: combined** (off by default from 0.11), and the speaking phone says them,
  only when they change (held for 1.5 s, never repeated): "Both cameras look good", "Face-on good.
  Down the line: you're at the left edge: aim the phone more toward you." A phone starting to record
  isn't announced. The speaking phone is the one with **Practice voice** on (face-on first); with
  none, any connected phone. **Setup voice: this phone** gives a phone its own voice back (and
  leaves it out of the combined one).
- **First swing check**: a session starts when a phone starts recording while none was. After its
  first swing is analyzed (both clips, the Square shot paired or 25 s gone by, the clip quality
  measured or 2 minutes gone by), the speaking phone says one line from the camera check
  (summary.js `cameraCheck`/`impactCheck`), quality.py's warnings and the shot pairing: "First swing:
  both cameras saw you, Square paired", or the problems: "First swing. Down the line: ball not
  found. No Square shot." ("you're out of the picture at the top" is the hands leaving the picture at
  the top of the backswing; also "partly out of the picture", "near the edge", "small in the
  picture", "too dark", "grainy", "flickering light" (only at a fixed shutter or when strong),
  "no clip", "the Square watcher isn't running"). After that only problems, once each until they
  clear: no Square shot on 2 swings in a row, a missing clip on 2 in a row, the same camera problem
  on 3 in a row, a phone that stops answering while recording, 3+ clips waiting on a phone, a
  battery under 10%.
- **No swing found**: said when key positions couldn't be found in a clip (phases.js). Why is on
  the swing page ("No swing found in this clip: ...") and in the **events log**
  (`D:\SwingClips\events.jsonl`, one JSON object per line), with the server window printing
  `No swing: <clip>: <why>` for new ones. The reasons: `tracking` (shoulders and hips seen in under
  20 frames: out of the picture, dark, or nobody there), `window` (nothing tracked around when the
  strike was heard), `no-backswing`, `impact-before-top`, `timing` (backswing outside 0.3-2 s or
  downswing outside 0.15-0.6 s: not a swing), each with the numbers behind it. The log also has
  each sentence sent to a phone to say (`say`), each upload, and `afterSpeech` on an upload heard
  while the **other** phone was probably saying something: capture apps before 0.9 muted only the
  phone that speaks, so its voice could set the other one off, recording a lone clip with nobody
  swinging. An upload with `afterSpeech` and then a `noswing` with `lone: true` is that. From 0.9
  the other phone doesn't listen either: the server tells it as it sends the sentence (before the
  voice starts), the speaking phone reports `speaking` and when it stops, and the other phone
  listens again 1.5 s after (`status.py TALK_*`; logged as `quiet`, seconds not to listen). With
  an older speaking phone the whole sentence is estimated (0.4 s a word). From 0.10 a phone reports
  `pre`, the seconds it keeps before the strike (2), and the poll's answer carries a new `pre` while a
  drill is on (6 for the pump drill, `drills.py`; logged as `pre`); the phone buffers 8 s before the
  strike so it can switch at once, and goes back to 2 when the drill ends. Older apps are left at 2. Such a **phantom**
  (one phone alone, no swing found, no Square shot: `status.py phantom`) isn't treated as a swing:
  practice mode doesn't say "no reading" about it and the health check doesn't count it (logged as
  `check` with `ignored`). Before, each did speak, and that set off the next phantom: a loop that
  said "Square: no shot on the last 2 swings" over and over. The log also has each swing the health
  check looked at (`check`: its problems, the streaks, what was said) and each session start. Every clip with no
  swing is logged again (`again: true`) when the swing numbers are worked out again, e.g. after an
  update, so older clips get their reasons too.
- **How**: each phone (while the app is open) posts `POST /api/phones/<angle>/poll?wait=10` with
  its state as JSON (recording, mode, shutter, shutterUsed, exposure, battery, charging, freeMb,
  version, pending, saved, practiceVoice, setupVoice, autoStart, busy, cameraError) and its answers
  to commands (`acks`). The server keeps the latest per phone and holds the request (a long poll)
  until it has a command or a sentence for that phone, or 10 s pass: so the phone reports in about
  every 10 s and a command arrives within a quarter of a second. A phone not heard from for 30 s is
  gone; closing the app sends a last report, so it shows closed at once. Pressing Start/Stop or
  changing a setting on the phone reports right away. The laptop posts
  `POST /api/relay/heartbeat` (`{source, squareRunning, lastShotAt, version}`); gone after 90 s.
  `POST /api/phones/command` (`{action: "start" | "stop", angle: "face" | "dtl" | "both"}`),
  `GET /api/status` (the panel). All in `server/status.py`; tests in `server/tests/test_status.py`
  and `capture/app/src/test/.../PhoneControlTest.kt`.
