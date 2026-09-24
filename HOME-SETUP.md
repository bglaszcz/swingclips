# SwingClips at home

This fork adds a home setup on top of the original phone web app ([danny2p/swingclips](https://github.com/danny2p/swingclips)):
a phone app records each swing when it hears the strike, a home server analyzes every clip and
serves a review page to any browser on the network, and each clip is tagged with the launch
monitor's numbers for that shot.

```
 Phone (capture app)          Home server (http://192.168.86.250:8000)       Sim laptop (Square Omni)
 hears strike -> 2 s + 2 s -> clips, pose, key positions, review page  <---  Square watcher: each new
 clip, uploads over Wi-Fi                                                     shot from Square's app
```

## A session

1. **Server** - running (see "Server" below for updates).
2. **Laptop** - open Square Golf's app on the driving range, then run `Square watcher.cmd`
   (in `Dropbox\SwingClips`).
3. **Phone** - open **SwingClips**, set sensitivity / mode, then **Start recording swings**.
4. **Review** - `http://homeserver:8000` on a PC, or `http://192.168.86.250:8000` on a phone.

## Pieces

### `capture/` - the phone app (Android, Kotlin, Camera2)
- Keeps the last few seconds of video in memory (hardware encoder, keyframe every 0.25 s) and cuts
  a clip 2 s either side of each strike. Strike detection is the web app's: 1 kHz high-pass, energy
  over the threshold and 2.5x the previous windows, 3 s cooldown, 0-100 sensitivity.
- Modes: 1080p/720p at 240, 120 or 30 fps. 240 fps drops ~30% of frames on the S23 Ultra, 120 fps
  ~2-7%.
- Opens **not recording**; settings are locked while recording. Clips wait in an outbox and upload
  to `POST /api/upload`, retrying until the server confirms. Named `swing_WxH_FPSfps_<unix>.mp4`,
  the unix time being the strike.
- Build: `JAVA_HOME=~/.jdks/jbr-21.0.11`, Gradle 8.9 `assembleDebug`, then `adb install -r`.

### `server/` - the home server (Python, FastAPI)
- `D:\SwingClips\clips` (videos), `pose` (pose per clip, gzipped JSON), `shots.jsonl` (launch
  monitor shots), `trash` (deleted clips; emptied by hand, never automatically).
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
  This assumes a face-on camera.
- Pose files are named by version (`<clip>.v3.json.gz`); when `pose.py` changes enough to bump
  `VERSION`, every clip is analyzed again on its own.
- Shots pair with clips by time: each source has a typical strike-to-report delay (Square's app
  ~14 s, GSPro connector ~1 s); each match records its gap.
- Deploy on the server: `git -C D:\SwingClips\app pull`, then restart `Start server.cmd`.

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
  192.168.86.250 for the server in the router so it can't change.
- The server needs inbound TCP 8000 allowed on private networks.
