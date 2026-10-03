# SwingClips at home

The operating manual: a session start to finish, setting up the phones, server and laptop, the
settings, and what to do when something's off. README.md has the one-time install, the review
page's tabs and the common commands; the details behind each part are in `docs/` (listed at the
end).

```
 Phones (capture app)         Home server (http://192.168.86.250:8000)       Sim laptop (Square Omni)
 face-on + down the line:     clips, pose, key positions, review page  <---  Square watcher: each new
 each hears the strike ->     (pairs the two angles of each swing)           shot from Square's app
 2 s + 2 s clip, uploads
```

## A session

**Before** (once per session, ~2 minutes)

1. **Phones**: open **SwingClips** on both (on their tripods, on the tape marks). Nothing to press.
2. **Laptop**: double-click the **Golf** icon on the desktop and press what you're doing (**Driving
   range**, **GSPro connector**, **Drills, no ball**). It starts only what that needs and opens the
   Start page. (First time: double-click `Golf launcher.cmd` in `Dropbox\SwingClips` and press "Put an
   icon on the desktop".) In Square's app, pick the **driving range**. (The server runs by itself; nothing to do there.)
3. **Start page, sections 1-2**: every check green, both camera pictures framed with the skeleton on
   you. Fix what it says if not.
4. **Section 3: Start recording.** Each phone says "Recording". (A phone that joins late starts by itself.)
5. **Hit one ball.** Section 4 lists it with "both" and its Square shot; about a minute later the
   phone says "First swing: both cameras saw you, Square paired" (or what's wrong).

**During**: pick ONE of these on the Start page (starting one turns the others off, so only one thing
talks after each swing):

| You want to... | Section | What you do |
|---|---|---|
| Do the coach's drills | **5 Coach program** | Pick it, **Start program**. Follow the block on screen: no-ball reps, tap **Pass / Miss**; ball shots, listen for the verdict (flush line: tap where the mark started). Blocks move on by themselves. |
| A session built from your data | **6 Today's plan** | **Start** on the first block, hit its balls, **Next**. |
| A game | **7 Play a game** | Pick it, **Start game**; the phone says each target. |
| Just hit | nothing | Hit. Everything is recorded and analyzed. |

**After**

1. **Coach program**: section 5, **Copy for coach**, paste into the coach chat (save the
   down-the-line picture if one shows). Older runs: **Past runs**, each has its own button.
2. **Stop** in section 3 (each phone says "Stopped"), or just close the apps.
3. Leave the server alone: about 10 minutes after the last swing it re-analyzes the session the
   careful way (the review page's Ready bar shows "deep pass: n clips to go").
4. Look back on the **review page** (`http://192.168.86.250:8000`): **Progress** (how did it go /
   what to work on / is it working) and each swing's video and numbers.

**Other ways** (still work): **Start both** in the review page's Ready bar; **Auto-start** on the
phones; `Start golf.cmd -StartCameras` starts both phones without the page; **Practice** on the review
page (one number spoken after each swing, or games); `Start golf (GSPro).cmd` instead of Square's app
(README, "Sim laptop"; details in [docs/relay.md](docs/relay.md)). `Start golf.cmd -Startup` adds it to
Windows sign-in; if Square's app isn't found, put its shortcut or .exe path in `square-app.txt` next to it.
What each Start page section does in detail: docs/review-page.md ("Coach program", "Today's practice
plan", "Plan steps", "Drill mode").

## Setting up the phones

- **Face-on**: portrait, facing the golfer, far enough back to fit the club at the top.
  **Down the line**: behind the golfer on the target line (through the hands or the
  ball), at about hand height, also portrait. In the app's **Settings**, set one to **Face-on** and
  the other to **Down the line**; the server address is `http://192.168.86.250:8000`.
- **Finding the spots**: the **Tripod setup** page (review page **Tools** menu, or the Start page) shows
  what each phone sees (the setup stills, while not recording) with a grid, your outline, and
  meters for size, room above and below, and centring. Its line tools check the phone is level
  side to side (tap an upright edge) and that the tripod is on an alignment stick's line (a stick
  pointing at the phone looks upright only from right on its line; it says which way to move and
  about how many inches). **Save this spot** keeps the picture; next time, **Saved spot** shows it
  over the live one and says when you're back on it.
- **Repeatable spots**: tape marks on the floor for each tripod foot (and a note of the height).
  Moving a phone shifts the body numbers; Progress notices ("camera moved") and only compares that
  camera's numbers since then. The first swing check tells you whether the framing is right.
- **Light**: plenty of light on the golfer and the ball. Dark clips lose the ball (impact then
  falls back to the heard strike) and the numbers go shaky. The barn's LED bulbs flicker at 120 Hz:
  stay on **Shutter: Auto** (a fixed 1/1000 s works but the ISO tops out and the picture is too dark
  for the ball search).
- **Focus**: when you've held still at the ball for two stills, the phone focuses and meters on
  you and holds it until you move somewhere else in the picture.
- **Mode**: 1080p 240 fps (the default). The phones drop some frames at 240 fps; that's expected
  and doesn't affect the sync.
- **Voices**: **Practice voice** on for the phone that should talk (face-on by default).
  **Setup voice: off** (the default from 0.11): the phones don't talk you into place; the Start
  page's live pictures are the camera check. **Combined** lets one phone say both cameras' setup;
  **this phone** gives a phone its own voice. Practice mode's result is only said when it's ready
  within 25 s of the swing (when the server is behind it's shown on the page instead), and never for
  drill swings. The phone that isn't talking stops listening for strikes while
  the other one talks (0.9), so a voice can't start a recording.
- **Sensitivity** (the strike trigger's slider, 0-100): higher triggers on quieter sounds; 100 by
  default. A clip needs a strike over the threshold and 2.5x louder than just before it, at most
  one every 3 s.
- **Auto-start** (off by default): starts recording once its own camera check has held good for
  two stills, once per opening of the app.
- **Install or update the app**: on the dev PC (README, "Dev PC"). `adb install -r` keeps the
  phone's settings. The down-the-line S21 also installs over Wi-Fi (`adb connect 192.168.86.17:5555`);
  the face-on S23 needs its USB cable.

How the app records, pairs the angles, and talks to the server: [docs/phones.md](docs/phones.md).

## What the phones say

Only one phone talks (the one with Practice voice on). What it can say:

- **Setup**, while not recording: how both cameras see you, when it changes.
- **"Recording"** / **"Stopped"** / **"Can't start: ..."** when started from the page or the phone.
- **First swing check**: "First swing: both cameras saw you, Square paired", or its problems:
  "you're out of the picture at the top" (the hands leave the picture at the top of the
  backswing), "partly out of the picture", "near the edge", "small in the picture", "ball not
  found", "too dark", "grainy", "flickering light", "no clip", "No Square shot", "the Square
  watcher isn't running".
- **After that, problems only**, once each until they clear: no Square shot on 2 swings in a row,
  a missing clip on 2 in a row, the same camera problem on 3 in a row, a phone that stops answering
  while recording, 3+ clips waiting on a phone, a battery under 10%.
- **No swing found**: when the key positions couldn't be found in a clip (see "Troubleshooting").
- **Practice mode**: each swing's number and whether it was in range ("Tempo 3.2, in range"), "no
  reading" when the number can't be trusted, and your focus cue after a miss.
- **Games**: the target, then where the ball landed and the next target.

## The server

- **Where things are**: the app in `D:\SwingClips\app`; data in `D:\SwingClips`: `clips` (videos),
  `pose` (pose per clip, and its quality record), `labels`, `eval`, `trash` (deleted clips; emptied
  by hand, never automatically), `shots.jsonl` (Square's shots), `swings.json` (each swing's
  numbers), `clubs.json` (clubs corrected on the page), `journal.json` (handicap, notes, focus),
  `excluded.json` (swings left out), `goodshots.json`, `practice.json` and `practice-log.jsonl`,
  `game.json` and `games-log.jsonl`, `noise.json`, and `events.jsonl` (what the phones were told to
  say, uploads, clips with no swing and why).
- **Deploy**: on the review page, **Tools > Update the server**. It lists what's new on GitHub, pulls
  it (fast-forward only: it never overwrites an edit made on the server) and restarts the server
  when the change needs it (Python, settings, or the scripts the server runs too, like
  `summary.js`); a change to the review page only just reloads the page. A change to
  `Start server.cmd` itself still needs a restart by hand. By hand: `git -C D:\SwingClips\app pull`,
  then `Stop server.cmd` and `Start server.cmd` (Stop also finds the background copy the auto-start
  task runs).
- **After a reboot** the auto-start task runs the server in the background, with no window (only
  `python.exe` in Task Manager's Details tab). Check it from a phone: http://192.168.86.250:8000.
- **During a session** new clips get a quick analysis, face-on first, so the spoken checks and
  practice numbers keep up (~9.5 s a clip with 8 workers). The careful deep pass runs after the
  session. Why and how it was measured: [docs/performance.md](docs/performance.md).
- **After an update** that changes the analysis, older clips are analyzed again in the background,
  newest first; new swings still go first.

### Settings (`server\settings.cmd`)
Not in git; `Start server.cmd` calls it. The server's own file has:

```
set SWINGCLIPS_POSE_BACKEND=rtmpose-m
set SWINGCLIPS_POSE_WORKERS=8
```

| Setting | Default | What it does |
|---|---|---|
| `SWINGCLIPS_PORT` | `8000` | Port the web server listens on. |
| `SWINGCLIPS_CLIPS` | `D:\SwingClips\clips` | Root folder for clips, pose files, shots and logs. |
| `SWINGCLIPS_TRASH` | `D:\SwingClips\trash` | Folder where deleted clips and shots are moved. |
| `SWINGCLIPS_MODELS` | `public\models` | Folder where downloaded ONNX models are stored. |
| `SWINGCLIPS_CALIB` | `D:\SwingClips\calib` | Calibration files for two-camera 3D. |
| `SWINGCLIPS_EVAL` | `D:\SwingClips\eval` | Output folder for `eval.py` scorecard runs. |
| `SWINGCLIPS_EVENTS` | `D:\SwingClips\events.jsonl` | Events log: what each phone was sent to say, uploads, clips with no swing and why. |
| `SWINGCLIPS_POSE_BACKEND` | `mediapipe` (`rtmpose-m` in `settings.cmd`) | Body pose model: `mediapipe`, `rtmpose-m`, `rtmpose-l` or `rtmw`. |
| `SWINGCLIPS_ORT_PROVIDER` | `cpu` | ONNX Runtime provider: `cpu`, `dml` (DirectX 12 / Intel GPU), `cuda` or `auto`. |
| `SWINGCLIPS_ORT_DEVICE` | `0` | GPU device index for `dml` or `cuda`. |
| `SWINGCLIPS_POSE_WORKERS` | half of logical CPUs, at most 6 (8 recommended on the server) | Background worker processes for clip analysis. |
| `SWINGCLIPS_BODY_STRIDE` | `2` on CPU (`1` on GPU) | Body model stride during session (1 = every frame, 2 = every other). |
| `SWINGCLIPS_DURING_SESSION` | `quick` | `quick` = quick analysis during a session, deep pass after; `wait` = pause analysis until 10 min after the session ends. |
| `SWINGCLIPS_DEEP` | `on` | Set to `off` to disable the background deep pass after a session. |
| `SWINGCLIPS_QUICK` | `on` | Set to `off` to disable quick pass optimizations during a session. |
| `SWINGCLIPS_3D` | off | Set to `1` or `on` to turn on 3D joint triangulation (needs calibrated phones). |
| `SWINGCLIPS_CLUB_BACKEND` | `raycast` | Club tracker: `raycast` (ray casting) or `yolo` (YOLO pose model). |

The speed settings that trade accuracy for time (`SWINGCLIPS_MP_STRIDE_AFTER`,
`SWINGCLIPS_FRAME_CONVERT`, `SWINGCLIPS_POSE_SPLIT`, `SWINGCLIPS_SHAFT_STRIDE`, ...) and the GPU
packages are in [docs/performance.md](docs/performance.md).

## The sim laptop

Runs the **Golf** launcher window (`Golf launcher.cmd`, the desktop icon) from `Dropbox\SwingClips`
(copies of `relay/`). Each time it opens, the launcher fetches any script there that differs from the
server's copy (so after **Update the server** there's nothing to copy by hand) and opens the new
version; if the server can't be reached it carries on with what it has. Its buttons start Square Golf and the watcher,
or the GSPro connector, or nothing; while it's open the launcher agent runs hidden so the Start page's
launcher buttons work. Nothing starts at Windows sign-in.

`Start golf.cmd` still works as before for manual one-click starting. The Square watcher reads each new
shot from Square Golf's own shot database and sends it to the server, which pairs it with the swing by
time (Square saves a shot ~11 s after the strike, 6-16 s seen). What the scripts do is logged in
`golf-launcher-log.txt`, `golf-agent-log.txt` and `start-golf-log.txt` next to them. The GSPro-connector option and how shots
are read: [docs/relay.md](docs/relay.md).

## Network

- Android can't resolve Windows PC names, so the phones use the server's IP. 192.168.86.250 is
  reserved for the server in the router.
- The server needs inbound TCP 8000 allowed on private networks.

## Troubleshooting

- **A phone shows "not connected"** in the Ready bar: is the app open, on the Wi-Fi, with the
  server address `http://192.168.86.250:8000`? A phone not heard from for 30 s shows as gone;
  closing the app shows it closed at once. Is the server up (`curl http://localhost:8000/api/time`
  on the server)?
- **"No Square shot"**: the Ready bar's Square row says whether the watcher is running and
  Square's app is open. The shot pairs by time (6-16 s after the strike for Square's app), and
  Square's app must be on the driving range. A swing with no ball (a practice swing) has no shot, rightly.
- **"Ball not found"**, or a down-the-line clip lined up badly: usually light (see "Setting up the
  phones"). Impact then falls back to the heard strike, and the
  numbers from the top on are marked shaky (~).
- **"No swing found"**: the swing page says why ("No swing found in this clip: ..."), and so does
  `D:\SwingClips\events.jsonl` (the server window prints `No swing: <clip>: <why>`): `tracking`
  (the body seen in under 20 frames: out of the picture, dark, or nobody there), `window` (nothing
  tracked around the strike), `no-backswing`, `impact-before-top`, `timing` (not a swing's
  timing).
- **A clip with nobody in it**: something loud set one phone off. A lone clip with no swing and no
  Square shot is a **phantom**: practice mode and the health check ignore it. Capture apps before
  0.9 let one phone's voice set the other one off; from 0.9 the other phone stops listening while
  it talks (`quiet` in `events.jsonl`). An upload marked `afterSpeech` there still means a voice
  got through.
- **Clips waiting on a phone** (amber from 3): the phone keeps them and retries until the server
  confirms; Wi-Fi or the server being down. They go up by themselves.
- **Clips waiting for analysis** (amber from 3): during a session the face-on clips go first and
  the down-the-line ones catch up between sets.
- **Wrong club** (not changed in Square's app): pick the right one on the swing's Club tile, or
  "Change club…" in Trends for all the swings shown.
- **Someone else hit** while the phones listened: **Leave out** on the swing (`⋯`) keeps it out
  of Trends and Progress.
- **A phone won't start from the page**: it refuses while one of its settings dialogs is open,
  while its camera is restarting, or after a camera error, and says why on the page and out loud.

## Where the details are

| File | What |
|---|---|
| [docs/phones.md](docs/phones.md) | The capture app, pairing the two angles, the shutter, clip quality (light, flicker, sharpness), the Ready panel and how the phones talk to the server. |
| [docs/review-page.md](docs/review-page.md) | How each swing is analyzed (pose, ball, shaft, key positions, numbers), trust per number, good-shot ranges, what helps / hurts, My focus, practice mode and games, Trends, Progress, Compare. |
| [docs/key-positions.md](docs/key-positions.md) | How P1-P8 and the takeaway are defined against the labels. |
| [docs/scorecard.md](docs/scorecard.md) | Labeling, `eval.py`, the body model, the ball search, trying other body models. |
| [docs/performance.md](docs/performance.md) | Keeping up during a session, the deep pass, benchmarks, GPUs. |
| [docs/club-model.md](docs/club-model.md) | Training the YOLO club model on the gaming PC, and its results so far. |
| [docs/3d.md](docs/3d.md) | 3D from both phones (off by default): boards, calibration, the checklist for the real setup. |
| [docs/relay.md](docs/relay.md) | The Square watcher, the GSPro-connector option, ball flight for connector shots. |

## Next

Toward a single-digit handicap (16.4 in Sept 2026). Open: **3D from both phones** is built but
untested on the real setup (after the tripods are placed: print the boards, calibrate each lens,
then the checklist in [docs/3d.md](docs/3d.md)); then decide whether the 3D turns replace the
face-on estimates in Trends and Progress.
