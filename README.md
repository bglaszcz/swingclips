# SwingClips (home setup fork) ⛳️

A fork of Danny's [SwingClips](https://github.com/danny2p/swingclips) web app, grown into a home
golf-sim system. Phones record each swing when they hear the strike (face-on, plus optionally
down the line), a home server analyzes every
clip and serves a review page to any browser on the network, and each clip is tagged with the
Square Omni's numbers for that shot.

```
 Phones (capture app)         Home server (http://192.168.86.250:8000)       Sim laptop (Square Omni)
 face-on + down the line:     clips, pose, key positions, review page  <---  Square watcher: each new
 each hears the strike ->     (pairs the two angles of each swing)           shot from Square's app
 2 s + 2 s clip, uploads
```

## A session

1. **Server** - running (`server\Start server.cmd`).
2. **Laptop** - open Square Golf's app on the driving range, then run `Square watcher.cmd`.
3. **Phones** - open **SwingClips** on each, check the angle (Face-on / Down the line), sensitivity
   and mode. Stand at the ball: each phone says whether it can see all of you ("Down the line:
   good") and focuses on you; **Camera setup** on the review page shows both live. Then **Start
   recording** on both.
4. **Review** - `http://homeserver:8000` on a PC, or `http://192.168.86.250:8000` on a phone.

## What's in the repo

| Folder | Runs on | What it does |
| --- | --- | --- |
| `capture/` | Android phones (9+) | Kotlin/Camera2 app. Keeps the last few seconds of video in memory and cuts a clip 2 s either side of each strike (240/120/30 fps). Each phone is set to face-on or down the line. Uploads each clip to the server, retrying until it's confirmed. |
| `server/` | Home server (Windows) | Python/FastAPI. Stores clips, runs MediaPipe pose on every frame, and serves the review page: both angles of a swing side by side and in sync, skeleton overlay, spine angle, plane line down the line, key positions P1-P8, swing numbers from both angles, sessions with trends against the launch monitor, progress across sessions, comparing any two swings side by side, delete to trash with Undo, and each swing's shot numbers. |
| `relay/` | Sim laptop | `square-watcher.ps1` reads new shots from Square Golf's local shot database and posts them to the server, which pairs each one with its clip by time. `shot-listener.ps1` is an unused alternative that stands in for GSPro. |
| `src/` | Phone browser | The original web app (Next.js), plus this fork's pose overlay and key-position stills. Still works on its own, but a phone's browser can't record above 30 fps, which is why `capture/` exists. |

Setup, build, deploy and network details are in **[HOME-SETUP.md](HOME-SETUP.md)**.

## Common commands

On the **server** (Command Prompt; these work from any folder):

```bat
:: Stop the server, wherever it's running (see below)
"D:\SwingClips\app\server\Stop server.cmd"

:: Start it in a window (Ctrl+C or closing the window stops it; after Ctrl+C, answer Y to
:: Windows' "Terminate batch job (Y/N)?")
"D:\SwingClips\app\server\Start server.cmd"

:: Deploy the latest version: pull, then stop and start
git -C D:\SwingClips\app pull

:: Is the server up? (prints the server's clock if it is)
curl http://localhost:8000/api/time
```

After a reboot, the auto-start task runs the server **in the background**. It has no window and
nothing on the taskbar, and in Task Manager it only shows as `python.exe` on the Details tab. So:

- `Stop server.cmd` stops it anyway. It finds the server by the port it listens on (8000), not by
  a window. Starting a second copy while one is running fails with "only one usage of each socket
  address".
- To restart after a deploy, run `Stop server.cmd`, then `Start server.cmd`. The server then runs
  in that window until the next reboot, when the task takes over again.
- To check auto-start after a reboot, don't log in to the server. Open http://192.168.86.250:8000
  on your phone instead. If the page loads, the server started by itself.

How accurate the tracking is (after labeling some swings with **L** on the review page; see
"The scorecard" in HOME-SETUP.md):

```bat
cd /d D:\SwingClips\app\server
.venv\Scripts\python.exe eval.py
```

On the **sim laptop**: run `Square watcher.cmd` (in the Dropbox `SwingClips` folder) after
Square Golf's app is open.

On the **dev PC**:

- **Build and install the phone app:** in `capture/`, Gradle `assembleDebug` with JDK 21, then
  `adb install -r app/build/outputs/apk/debug/app-debug.apk` with the phone plugged in.
- **Run the original web app locally:** `npm install`, then `npm run dev` and open
  http://localhost:3000. Camera and microphone need HTTPS or localhost.

## Credits and license

The original SwingClips web app, including its sound-triggered strike detection, is by
[Danny](https://github.com/danny2p/swingclips) ([Garage Golf on YouTube](https://www.youtube.com/@garagegolfers)).
MIT License.
