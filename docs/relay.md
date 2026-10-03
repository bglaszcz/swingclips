# The sim laptop: shots from Square

The Square watcher, the GSPro-connector option, and the ball-flight fill-in. (Moved out of HOME-SETUP.md, which has the session checklist, setup and troubleshooting.)

## `relay/` - launch monitor to server (runs on the sim laptop, nothing to install)
- **`golf-launcher.ps1`** (+ **`Golf launcher.cmd`**): the golf launcher window, the owner's way in: a
  **Golf** icon on the desktop (the window's "Put an icon on the desktop" makes it) opens four buttons:
  **Driving range** (Square Golf's app + the watcher), **GSPro connector** (closes Square's app, starts
  the connector + the shot listener), **Drills, no ball** (nothing), **Close everything**. Each then
  opens the Start page. While the window is open it runs `golf-agent.ps1` hidden, so the Start page's
  launcher buttons work; closing the window stops it. Nothing starts at Windows sign-in. `-DryRun`
  logs instead of acting; `-SelfTest` presses every button in dry run and closes. On opening it
  brings the folder's scripts up to date from the server (`Update-RelayFiles` in `golf-common.ps1`:
  `GET /api/relay/files` lists the server's `relay/*.ps1` and `*.cmd` with SHA-256; each one that
  differs or is missing is fetched from `/api/relay/files/<name>`, checked and swapped in; other
  files, such as `square-app.txt`, are left alone), then opens the new launcher with `-NoUpdate`.
- **`golf-agent.ps1`** (+ **`Golf agent.cmd`**): the launcher agent the window runs (it can also run on
  its own, and `-Startup` would add it to Windows sign-in, which the owner doesn't want). It polls the server
  (`POST /api/relay/agent`), reports what is running (Square app, watcher, connector, listener, shot source),
  and executes named actions sent from the browser Start page (start/stop Square, start/stop watcher,
  switch shot source, start/stop GSPro connector stack, open Start page). Supports `-DryRun` for testing.
- **`golf-common.ps1`**: shared helper functions for `golf-agent.ps1` and `start-golf.ps1` (process checks,
  Start menu app resolution, shortcut creation, shot source toggling). Compatible with Windows PowerShell 5.1.
- **`start-golf.ps1`** (+ **`Start golf.cmd`**, **`Start golf (GSPro).cmd`**): the manual one-click launcher
  script. Still works as before for launching Square Golf or GSPro without running the background agent.
- **`square-watcher.ps1`** (used): Square Golf's Windows app saves every shot to a plain SQLite
  file, `%USERPROFILE%\AppData\LocalLow\Invant\Square Golf\SQGDB.bytes` (`IVShotLog`: ball data,
  flight result, club data as JSON). The watcher reads new rows read-only via Windows'
  `winsqlite3.dll` and posts them to `/api/shots`. The laptop's launcher also posts a heartbeat,
  `POST /api/relay/heartbeat`, which the review page's Ready bar shows. Units: m/s and m (converted to mph and yd);
  spin axis and side spin are positive-left in Square's data and flipped to positive-right.
- **`shot-listener.ps1`** (the option, `Start golf (GSPro).cmd`): stands in for GSPro on
  127.0.0.1:921 so Square's official **SQG GSPro Connect** can be used instead of Square's app.
  Sends GSPro's player info and "ready" so the Omni arms. Square's connector sends each shot as a
  ball message then a club message, both flagged as heartbeats; no carry or club speed (0). The
  listener posts each shot as source `gspro-connect` with those left out, and a heartbeat
  (`source: shot-listener`, `monitorConnected`, `monitorReady`, `squareRunning`). If GSPro itself
  is ever used, set `<OpenAPIUseAltPort>true</OpenAPIUseAltPort>` in
  `C:\GSPro\GSPC\GSPconnect.exe.config` and relay to port 922.
- **`start-golf.ps1 -Source square|gspro`** picks between the two (default `square`; the first line
  of `shot-source.txt` next to it can change the default). `gspro` doesn't open Square's app or the
  watcher: it warns if Square's app is open, starts the listener in its own window (type a club
  code there to change club) and opens SQG GSPro Connect (found in the Start menu, or from
  `connector-app.txt`).
- **`server/ballflight.py`**: carry, total, offline, apex and landing angle for a shot that has no
  carry (the connector's), from ball speed, launch, direction, spin and spin axis: drag and Magnus
  lift integrated over the flight, roll from a linear fit. Fit to Square's own numbers on 126 saved
  driving-range shots: carry within 2.1 yd on average (90% within 4.2), 2-3.6 yd on a day left out
  of the fit, wedges ~3 yd short; offline 0.8 yd, apex 2 ft. Filled in as shots arrive and listed
  in the shot's `ball.computed`; the review page marks those numbers "(calc.)". Square's own
  numbers are never replaced. Club speed and smash stay missing: good-shot rules skip smash, and
  practice says "not in the shot" for them.
- Not used, on purpose: the unofficial Bluetooth connector `brentyates/squaregolf-connector` was
  taken down by a DMCA notice (Sept 2026) alleging code taken from Square's private systems.

## Checking Square's CSV export against the database

`python tools/square_compare.py <Square CSV export> <Dropbox\SwingClips\square-shots-DATE.jsonl>` matches
the same session's shots (by club and order, confirmed on carry and ball speed) and prints new (database)
minus old (CSV) for impact height and toe/heel, attack, face to path and dynamic loft, with a straight-line
fit (offset, scale, r), and every failed impact read in either source (CSV: `H0.0` with a filler height;
database: null, from Square's `IsValidImpact*` flags).
