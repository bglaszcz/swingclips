# SwingClips (home setup fork) ⛳️

A fork of Danny's [SwingClips](https://github.com/danny2p/swingclips) web app, grown into a home
golf-sim system. A phone records each swing when it hears the strike, a home server analyzes every
clip and serves a review page to any browser on the network, and each clip is tagged with the
Square Omni's numbers for that shot.

```
 Phone (capture app)          Home server (http://192.168.86.250:8000)       Sim laptop (Square Omni)
 hears strike -> 2 s + 2 s -> clips, pose, key positions, review page  <---  Square watcher: each new
 clip, uploads over Wi-Fi                                                     shot from Square's app
```

## A session

1. **Server** - running (`server\Start server.cmd`).
2. **Laptop** - open Square Golf's app on the driving range, then run `Square watcher.cmd`.
3. **Phone** - open **SwingClips**, set sensitivity and mode, then **Start recording swings**.
4. **Review** - `http://homeserver:8000` on a PC, or `http://192.168.86.250:8000` on a phone.

## What's in the repo

| Folder | Runs on | What it does |
| --- | --- | --- |
| `capture/` | Android phone | Kotlin/Camera2 app. Keeps the last few seconds of video in memory and cuts a clip 2 s either side of each strike (240/120/30 fps). Uploads each clip to the server, retrying until it's confirmed. |
| `server/` | Home server (Windows) | Python/FastAPI. Stores clips, runs MediaPipe pose on every frame, and serves the review page: skeleton overlay, spine angle, key positions P1-P8, sessions, delete to trash with Undo, and each clip's shot numbers. |
| `relay/` | Sim laptop | `square-watcher.ps1` reads new shots from Square Golf's local shot database and posts them to the server, which pairs each one with its clip by time. `shot-listener.ps1` is an unused alternative that stands in for GSPro. |
| `src/` | Phone browser | The original web app (Next.js), plus this fork's pose overlay and key-position stills. Still works on its own, but a phone's browser can't record above 30 fps, which is why `capture/` exists. |

Setup, build, deploy and network details are in **[HOME-SETUP.md](HOME-SETUP.md)**.

## Quick reference

- **Deploy the server:** on the server, `git -C D:\SwingClips\app pull`, then restart
  `Start server.cmd` (it creates its Python environment and installs `requirements.txt` on first run).
- **Build the phone app:** in `capture/`, Gradle `assembleDebug` with JDK 21, then
  `adb install -r app/build/outputs/apk/debug/app-debug.apk`.
- **Run the web app locally:** `npm install`, then `npm run dev` and open http://localhost:3000.
  Camera and microphone need HTTPS or localhost.

## Credits and license

The original SwingClips web app, including its sound-triggered strike detection, is by
[Danny](https://github.com/danny2p/swingclips) ([Garage Golf on YouTube](https://www.youtube.com/@garagegolfers)).
MIT License.
