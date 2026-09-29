# SwingClips (home setup fork) ⛳️

A fork of Danny's [SwingClips](https://github.com/danny2p/swingclips) web app, grown into a home
golf-sim system. Two phones record each swing when they hear the strike (face-on and down the line),
a home server analyzes every clip and serves a review page to any browser on the network, and each
swing is tagged with the Square Omni's numbers for that shot.

```
 Phones (capture app)         Home server (http://192.168.86.250:8000)       Sim laptop (Square Omni)
 face-on + down the line:     clips, pose, key positions, review page  <---  Square watcher: each new
 each hears the strike ->     (pairs the two angles of each swing)           shot from Square's app
 2 s + 2 s clip, uploads      Ready bar: starts/stops both phones
```

## Getting going (once)

1. **Server** (the always-on Windows PC): clone this repo to `D:\SwingClips\app` and run
   `server\Start server.cmd`. The first run sets up Python by itself. To use the RTMPose body
   model (more accurate than MediaPipe; scored on hand-labeled swings), create
   `server\settings.cmd` containing `set SWINGCLIPS_POSE_BACKEND=rtmpose-m` and restart. The model
   downloads on the first start.
2. **Phones**: build the capture app on the dev PC and install it on both (see "Dev PC" below). In
   the app, set one phone to **Face-on** and the other to **Down the line**. The server address is
   `http://192.168.86.250:8000`.
3. **Sim laptop**: the `Dropbox\SwingClips` folder holds `Start golf.cmd`, `square-watcher.ps1`
   and `start-golf.ps1` (copies of `relay/`). Run `Start golf.cmd -Startup` once to have it start at
   every sign-in.
4. **Review page**: `http://homeserver:8000` on a PC, or `http://192.168.86.250:8000` on a phone.

Full setup, build, deploy and network details are in **[HOME-SETUP.md](HOME-SETUP.md)**.

## A session

1. **Phones**: open **SwingClips** on both and leave them on their stands. Stand at the ball: one
   phone says how both cameras see you ("Both cameras look good", or what to fix).
2. **Laptop**: `Start golf.cmd` (if it didn't start with Windows). It opens Square Golf's app, the
   watcher, and the **Start page** (`/start`) in the browser: checks, both cameras' pictures, and
   **Start recording** (each phone says "Recording"). `-StartCameras` starts the phones as soon as
   they connect instead (the old way).
3. **Square's app**: pick the driving range and hit balls. The Start page lists each swing and
   whether its Square shot paired. About a minute after the first swing, a phone says "First
   swing: both cameras saw you, Square paired", or what's wrong. After that it only speaks up about
   problems.
4. **Done**: **Stop both**.

## The review page

Tabs along the top (along the bottom on a phone): **Swings**, **Progress**, **Practice**,
**Cameras** and **Tools**. On a phone, "Add to Home screen" installs it like an app. **?** lists
the keyboard shortcuts.

- **Ready bar** (under the tabs): both phones, Square, framing and the server's queue at a glance,
  with Start and Stop for both phones or each one.
- **Swings**: the list by session (a club filter at the top, each swing with its club, carry and
  analysis state) and the open swing: its club and carry with newer / older buttons (K / J), both
  angles in sync, a scrubber with P1-P8 marked (or keys 1-8), play (Space), frame steps (← →),
  speeds and full screen (F). **Show ▾** picks the overlays (skeleton, angles, hand path, head,
  plane). **Compare…** puts it side by side with another swing. **Label** is for the scorecard.
  **⋯** has handedness, Leave out and Delete. Square's numbers lead with carry, then key
  positions and the swing numbers. Numbers that can't be trusted are greyed with a **~** (hover
  for why), and a "vs my good shots" column shows where each number sat.
- **Trends** (per session, in the list): body numbers against Square's numbers.
- **Progress**: how your numbers and results change across sessions, your good-shot ranges,
  which numbers separate good shots from the rest, and **what helps, what hurts**: each move against
  each result with a club, within sessions, labeled confirmed / emerging after a false-discovery
  correction.
- **Practice**: pick one number and a range, and after each swing the face-on phone says it. Or play a
  **game** (Combine, Wedge ladder, Random pick, Ladder, Driving, Shot shaping, Distance control, Hole builder): the phone says each target, then where the ball
  landed and the next one; shots are scored in strokes against a tour baseline, Driving tests 14 tee shots at a fairway,
  Shot shaping tests 12 called curves, Distance control tests 15 random carries against a tight 5-yard window (carry only), Hole builder plays 6 par 4s with a tee shot and an approach from where your drive ended, and the Combine (the same 27 shots every time) gives one score to follow week to week.
- **Cameras**: live pictures from both phones.
- **Tools**: **Labels** (labeling progress, and a worklist of what to fix, with Go) and
  **Shutter test** (light, grain, flicker and sharpness by shutter setting).

**Capture app (0.8)**: the camera fills the screen with which angle and mode it is and whether
it's recording; below it the status, the server, one big Start / Stop, and the strike trigger
(level bar and sensitivity). Everything else (angle, mode, shutter, server, voices, auto-start)
is under **Settings**; the camera ones are locked while recording.

## Common commands

### Server (Command Prompt; these work from any folder)

```bat
:: Deploy the latest version: pull, then stop and start
git -C D:\SwingClips\app pull
"D:\SwingClips\app\server\Stop server.cmd"
"D:\SwingClips\app\server\Start server.cmd"

:: Is the server up? (prints the server's clock if it is)
curl http://localhost:8000/api/time

:: Use RTMPose (delete the file to go back to MediaPipe); restart afterwards
echo set SWINGCLIPS_POSE_BACKEND=rtmpose-m> D:\SwingClips\app\server\settings.cmd

:: How accurate the tracking is, against your hand labels
cd /d D:\SwingClips\app\server
.venv\Scripts\python.exe eval.py

:: How long a clip takes and where the time goes, with the speed settings as before and as set
:: now; RTMPose and the club model on the CPU vs a GPU, if one is installed
:: (HOME-SETUP.md, "Keeping up during a session" and "Using a GPU")
.venv\Scripts\python.exe bench_models.py

:: Do the speed settings score no worse on the labeled clips? (dev PC or server, with the clips)
.venv\Scripts\python.exe bench_models.py --accuracy
```

- `settings.cmd` can also put the ONNX models on a GPU (`SWINGCLIPS_ORT_PROVIDER=dml` or `cuda`,
  with `SWINGCLIPS_REQUIREMENTS` naming the matching package file); off by default, see
  HOME-SETUP.md, "Using a GPU".
- Less work a clip, so the server keeps up with a swing every ~20 s: MediaPipe on every 4th frame
  after the swing, a cheaper picture for it, the clip split between the workers by cost (on by
  default; `settings.cmd` can put each back), and a faster shaft search and empty scene (the same
  numbers). See HOME-SETUP.md, "Keeping up during a session".
- `Start server.cmd` runs the server in its window. Ctrl+C or closing the window stops it (answer
  Y to "Terminate batch job"). After a change of body model or of the analysis, the server
  analyzes older clips again in the background, newest first, while new swings go first.
- After a reboot the auto-start task runs the server **in the background**, with no window. It
  only shows as `python.exe` on Task Manager's Details tab. `Stop server.cmd` stops it anyway (it
  finds the server by port 8000), and starting a second copy fails with "only one usage of each
  socket address". To check auto-start after a reboot, open http://192.168.86.250:8000 on your
  phone without logging in to the server.

### Sim laptop

```bat
:: Square Golf's app + the Square watcher (each only if it isn't running already)
"%USERPROFILE%\Dropbox\SwingClips\Start golf.cmd"

:: ...and at every Windows sign-in from now on (delete the Startup shortcut to undo)
"%USERPROFILE%\Dropbox\SwingClips\Start golf.cmd" -Startup
```

It finds Square's app in the Start menu's app list (Microsoft Store apps too); if it can't, put the
path of its shortcut or .exe, or its app ID, in `square-app.txt` next to `Start golf.cmd`. What it
did each time is in `start-golf-log.txt` there. `Square watcher.cmd` still runs the watcher alone.

**Shots through Square's GSPro connector (optional).** Instead of Square's app, Square's official
SQG GSPro Connect can send each shot about a second after the strike (instead of ~11 s):

```bat
:: Close Square Golf's app first: the Omni takes one Bluetooth connection.
"%USERPROFILE%\Dropbox\SwingClips\Start golf (GSPro).cmd"
```

It starts the shot listener (which stands in for GSPro; type a club code such as `I7` in its window
and press Enter to change club) and opens the connector. The connector sends no carry or club
speed: the server works out carry, total, offline and apex from the ball (within ~2 yd of Square's
carry, marked "calc." on the review page), and club speed and smash stay empty. `Start golf.cmd`
is still the usual setup; to make the connector the default, put `gspro` in `shot-source.txt` next
to it. Copy `Start golf (GSPro).cmd`, `Shot listener.cmd` and `shot-listener.ps1` to
`Dropbox\SwingClips` along with the updated `start-golf.ps1`.

### Dev PC

```bash
# Build the phone app (JDK 21 + Gradle 8.9), then install on a phone (USB, or Wi-Fi adb)
cd capture
JAVA_HOME=~/.jdks/jbr-21.0.11 ~/.gradle/wrapper/dists/gradle-8.9-bin/*/gradle-8.9/bin/gradle assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb connect 192.168.86.17:5555          # the down-the-line phone over Wi-Fi (after adb tcpip 5555)

# Server tests (Python + the page's JavaScript)
cd server
.venv/Scripts/python.exe -m unittest discover tests
node --test tests/compare.test.js tests/trust.test.js tests/goodshots.test.js

# Refresh the labeled swings in the repo from the server, then tune key positions on them
.venv/Scripts/python.exe fixtures_export.py
.venv/Scripts/python.exe tune_positions.py
```

- `adb` is in `%LOCALAPPDATA%\Android\Sdk\platform-tools`.
- **The original web app:** `npm install`, then `npm run dev` and open http://localhost:3000.
  Camera and microphone need HTTPS or localhost.

## What's in the repo

| Folder | Runs on | What it does |
| --- | --- | --- |
| `capture/` | Android phones (9+) | Kotlin/Camera2 app. Keeps the last few seconds of video in memory and cuts a clip 2 s either side of each strike (240/120/30 fps; shutter Auto or fixed). Each phone is face-on or down the line. Uploads each clip, reports in to the server (start/stop from the review page), speaks camera setup, first-swing and practice results. |
| `server/` | Home server (Windows) | Python/FastAPI. Stores clips; runs pose on every frame (MediaPipe, or RTMPose through ONNX, on the CPU or a GPU), finds the ball, impact and club shaft; works out key positions P1-P8 and swing numbers from both angles; clip quality; trust per number; good-shot ranges; practice mode; the labeling mode and scorecard (`eval.py`); two-camera 3D (off until calibrated). Serves the review page. |
| `relay/` | Sim laptop | `square-watcher.ps1` reads new shots from Square Golf's local shot database and posts them to the server, which pairs each with its swing by time; `Start golf.cmd` starts Square's app and the watcher. `Start golf (GSPro).cmd` uses `shot-listener.ps1` instead, which stands in for GSPro so Square's GSPro connector sends shots (optional; carry worked out by `server/ballflight.py`). |
| `train/` | Gaming PC (GPU) | Trains the club keypoint model (YOLO-pose) from labeled frames. |
| `docs/` | | Reports, such as how the key positions are defined against the labels. |
| `src/` | Phone browser | The original web app (Next.js), plus this fork's pose overlay and key-position stills. |

## Credits and license

The original SwingClips web app, including its sound-triggered strike detection, is by
[Danny](https://github.com/danny2p/swingclips) ([Garage Golf on YouTube](https://www.youtube.com/@garagegolfers)).
MIT License.
