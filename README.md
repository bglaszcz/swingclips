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
2. **Laptop**: `Start golf.cmd` (if it didn't start with Windows). It opens Square Golf's app and
   the watcher, then starts both phones once they're connected (each says "Recording"); pick the
   driving range. `-NoCameras` leaves the phones to the review page.
3. **Review page** (or skip it if the laptop started the phones): **Start both** in the Ready bar.
   Hit balls once the bar is green. About a minute after the first swing, a phone says "First
   swing: both cameras saw you, Square paired", or what's wrong. After that it only speaks up about
   problems.
4. **Done**: **Stop both**.

## The review page

- **Ready bar** (top): both phones, Square, framing and the server's queue at a glance, with Start
  and Stop for both phones or each one.
- **A swing**: both angles in sync. **Show ▾** picks the overlays (skeleton, angles, hand path,
  head, plane). **Compare…** puts it side by side with another swing. **Label** is for the
  scorecard. **⋯** has handedness, Leave out and Delete. Numbers that can't be trusted are greyed
  with a **~** (hover for why), and a "vs my good shots" column shows where each number sat.
- **Camera setup**: live pictures from both phones.
- **Progress**: how your numbers and results change across sessions, your good-shot ranges, and
  which numbers separate good shots from the rest.
- **Practice**: pick one number and a range, and after each swing the face-on phone says it.
- **Tools ▾**: **Labels** (labeling progress, and a worklist of what to fix, with Go) and
  **Shutter test** (light, grain, flicker and sharpness by shutter setting).
- **Trends** (per session, in the list): body numbers against Square's numbers.

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

:: Would a GPU help? RTMPose and the club model on the CPU vs the GPU, and whole clips
:: (install requirements-dml.txt first: HOME-SETUP.md, "Using a GPU")
.venv\Scripts\python.exe bench_models.py
```

- `settings.cmd` can also put the ONNX models on a GPU (`SWINGCLIPS_ORT_PROVIDER=dml` or `cuda`,
  with `SWINGCLIPS_REQUIREMENTS` naming the matching package file); off by default, see
  HOME-SETUP.md, "Using a GPU".
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
| `relay/` | Sim laptop | `square-watcher.ps1` reads new shots from Square Golf's local shot database and posts them to the server, which pairs each with its swing by time; `Start golf.cmd` starts Square's app and the watcher. `shot-listener.ps1` is an unused alternative that stands in for GSPro. |
| `train/` | Gaming PC (GPU) | Trains the club keypoint model (YOLO-pose) from labeled frames. |
| `docs/` | | Reports, such as how the key positions are defined against the labels. |
| `src/` | Phone browser | The original web app (Next.js), plus this fork's pose overlay and key-position stills. |

## Credits and license

The original SwingClips web app, including its sound-triggered strike detection, is by
[Danny](https://github.com/danny2p/swingclips) ([Garage Golf on YouTube](https://www.youtube.com/@garagegolfers)).
MIT License.
