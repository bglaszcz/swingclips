# The night worker: a second opinion on every clip

Balls get hit once a day; the rest of the time the clips sit there. The gaming PC (RTX 5070 Ti)
spends that time analyzing every clip again with bigger models than the server can run, and the
server compares the two. (Server: `night.py` and `/api/night` in `app.py`; worker:
`server/night_worker.py`; launcher: `server/Night worker.cmd`.)

## What it runs

The server's deep pass (docs/performance.md), with the whole-body model **RTMW-l 384x288** in place
of RTMPose-m, on every frame, on the graphics card through CUDA. The club model is the server's own
`club-deep.onnx`: the worker downloads it (`/api/night/club`, saved as `public/models/club-night.onnx`)
whenever the server's changes. About 20 s a clip on the gaming PC with 8 workers (the server's deep
pass: ~57 s a clip with the smaller model).

The server decides what and how (`/api/night/next` returns the clip and `night.PROFILE`):

- Nothing while a session is on (a phone recording, or a clip in the last few minutes), so the
  phones' uploads and the server's own analysis always come first.
- Labeled clips first (they score the worker's models against the hand labels), then face-on before
  down the line, newest first.
- A clip handed out is not handed out again for 15 minutes (a worker that died mid-clip); one that
  failed, not until the server restarts.
- After `night.VERSION` goes up (a change to what the worker runs), every clip is sent out again.

The worker sends the pose file back (`POST /api/night/<clip>`); the server keeps it in
`D:\SwingClips\night\<clip>.json.gz`, the same format as a pose file with `"night": {version,
worker, at}` first. **Nothing on the review page's numbers comes from these files.**

## What it's for

1. **Where the two disagree, a label teaches most.** The swing worker works out the key positions
   from the night files (the page's own JavaScript, as for the server's pose files) and keeps how far
   each is from the server's, per angle (`night/compare.json`). The clubhead onset (the takeaway's
   anchor) is an idle step on the server, not in the night files, so the server's is used for both:
   the takeaway differs only by what the models see. The Labels view's **Where the two analyses
   disagree** card lists the unlabeled swings with the biggest gap (2 frames or more), worst first,
   with a progress line (`N picked so far · M left`). **Go** opens the swing at the server's frame for that
   position. **Compare** opens a side-by-side frame picker panel (`framepick.js`) showing the Server,
   Night pass, and takeaway onset frames with pose skeletons drawn on canvas (solid for server, dashed
   sky-blue for night pass). Single-frame stepping (`‹`/`›`, `[`/`]`), one-tap picking ("This one" or keys
   `1`-`4`), and custom adjustment ("Neither" / `N`) save directly to `/api/labels/<clip>?pass=1` with source
   attribution (`picked[event] = "server" | "night" | "onset" | "adjusted"`), protecting existing hand labels
   from overwrite with a confirmation dialog and dropping only the resolved `(clip, position)` pair from the list.
   To keep daily labeling manageable, the card presents a short daily session (`todaysSet`, default 20 swings): all
   big disagreements (|ms| >= 50 ms) first, then a balanced sample of small disagreements across different sessions
   and clubs before repeating, capped at 4 per position and skipping positions already picked 12+ times. Clips
   where night pass positions are out of swing order (`nightBroken`) are folded separately ("lost the swing: nothing
   to pick"). A folded **Who's winning** table tallies picks per position and angle across server, night pass, club
   onset, and adjusted frames, summarizing model performance in plain words (e.g. "P4: the night pass won 14 of 20.").
2. **Training data.** The night files are a second set of body points on every frame of every clip,
   from a stronger model: the start of training data for the next models without labeling by hand.
   Not used yet.
3. **Judging by eye on the frame (Night pass overlay).** The swing page's **Show** menu includes a
   **Night pass** toggle (`overlays.night`). When enabled, it fetches `/api/night/pose/<clip>` and draws
   the night pass skeleton matched by timestamp alongside the server's. The night skeleton is drawn in
   dashed sky blue without angle labels so the server's solid skeleton remains primary. This works in
   both regular playback and labeling mode (`L`), allowing the owner to judge disagreements by eye
   directly on the video.
4. **Nightly improve step and the Night report.** When there are new hand labels, the night worker
   trains a new club model on the GPU, scores it against the current baseline on validation swings it
   never saw (`eval.py`), and sends the server a candidate with before/after scores (`/api/improve`).
   The review page's **Tools > Night report** view (`static/nightreport-view.js`) shows the candidate
   comparison table, worker progress from `/api/night`, and past nights. Tapping **Use it** (or
   **Go back to this one**) adopts the model via `POST /api/improve/<id>/use`, queuing all clips to be
   analyzed again over idle hours.
5. **Club check feeds the club model.** The club model learns only from clicked club points
   (`grip`, `hosel`, `head`). **Tools > Club check** (`static/clubcheck.js`) gives the owner a
   fast queue of high-value frames (between P4 and P8 in the downswing and through, prioritized
   by missing or low-confidence detections and swings with no club points yet) for 1-tap confirmation
   or adjustment. It also queues backswing frames between takeaway and P3 (including a frame near P2)
   so nightly retraining receives enough backswing data to prevent P2 horizontal-shaft detection regressions.
   Confirmed frames save directly to `/api/labels/<clip>?pass=1`, providing the training
   points that the night worker's improve step consumes to retrain `club-deep.onnx` on the GPU.
   When the club extends out of frame (such as at the top of the backswing), "Club leaves the picture"
   (key O) preserves the grip point while marking the hosel and clubhead hidden.

## Getting better every night: the improve step

Once every clip is done, the worker runs the improve step once (`server/night_improve.py`; server
side `server/improve.py`, `/api/improve`):

1. **Only when there's a reason**: the club model learns only from club points (grip, hosel,
   clubhead), so a try needs at least 40 club-labeled frames (`improve.MIN_NEW_FRAMES`) new or moved
   since the last scored try (`improve.club_frames`, kept in `improve/club-frames.json`). Picks, key
   moments and body points don't count. Tools > Club check is the quick way to add them. A failed try
   is tried again the next night. Not with less than 50 minutes left before `--stop-at`. The Night
   report's line for the night says why it didn't train ("Nothing to train: 12 new club-labeled
   frames since the last try (needs 40)"). Club check and the Night report show progress toward the
   40 new frames needed for the next run. When a try was trained on fewer than 40 more frames than the try
   before it, the Night report warns that it trained on almost the same frames.
2. **Train**: the labels and labeled clips are copied to the gaming PC (`%USERPROFILE%\SwingClips-night`,
   only new clips download), `club_dataset.py` makes the dataset (validation = ~20% of swings by swing
   name, the same swings each time), and `train/club_train.py` trains a YOLO11s club model in
   `train\.venv` (~20 min on the 5070 Ti), **twice** (`improve.RUNS`, seeds 0 and 1): on Oct 6 two
   trainings on almost the same frames scored face-on P2 within one frame 25% and 75%, so one run's
   verdict was as much luck as model. The worker's own processes are stopped first: they hold ~15 GB of
   the card. A try now takes ~50-60 min (`night_improve.MINUTES` 75).
3. **Score**: `eval.py --rerun --deep --only-val` with the model in use (the server's,
   downloaded) and with each new one, the server's body model: the key positions, shaft and clubhead
   on the validation swings neither model trained on.
4. **Judge** (`improve.judge`, on the two runs' average: `improve.average_scores`): better when no key position is clearly worse (within one frame 10
   points lower, or 90th percentile 2 frames higher), the shaft and clubhead aren't found clearly less
   often in the downswing, and the key positions are better on average (90th percentile 1 ms lower or
   within one frame 3 points higher) or the club is found clearly more often. Club model v3 is the
   reason for the "no position clearly worse" rule: better on its training metric, worse at P2 and P8.
5. **Report**: the better of the two runs (`improve.best_run`) and the scorecards (the model in use,
   the average, and each run) go to the server as a candidate (`improve/candidates/<id>`).
   The Night report shows each run alongside the judged average, highlighting any key positions where the two trainings disagreed by 25 points or more.
   **Nothing changes until the owner taps Use it** on the Night report. Use it copies the model over
   the deep pass's `club-deep.onnx` (the old one goes to `trash\models` and stays as a "used before"
   candidate: going back is the same tap), and every clip gets the deep pass again when the server is
   idle.

What each night did (clips, the improve step's sentence) goes to `improve/nights.json` as it goes.
The fuel is labels: each swing labeled from the **Where the two analyses disagree** list gives the next
night something to learn. Trying the step out without the GPU: `SWINGCLIPS_IMPROVE_EPOCHS=1`,
`SWINGCLIPS_IMPROVE_DEVICE=cpu`, `SWINGCLIPS_IMPROVE_PROVIDER=cpu`, then
`.venv-gpu\Scripts\python.exe night_improve.py --server <url> [--force]`.

## Setting it up (gaming PC)

1. The repo checked out (this is the dev PC: `D:\SwingClips-dev\swingclips`).
2. Double-click `server\Night worker.cmd`. The first run makes `.venv-gpu` (onnxruntime-gpu with
   CUDA through pip, ~1 GB; needs NVIDIA driver 580 or newer) and downloads RTMW (~220 MB).
3. It runs until the window is closed, below normal priority. To keep it to the night (the PC is
   used for games): `"Night worker.cmd" --hours 23-7`. Other options: `--workers N` (default half
   the cores), `--server URL`, `--once`, `--stop-at 7` (exit at 7:00, after the clip it's on).
4. Every night: a Task Scheduler task **SwingClips night worker** (on the gaming PC) starts
   `Night worker.cmd --stop-at 7` at 2:00 and wakes the PC for it (Power Options must allow wake
   timers). It doesn't start late if the PC was off at 2:00. Only one worker runs on a PC at a time:
   a second one (the task while one started by hand is still going) says so and exits.

The Labels view shows how far it has got ("N of M clips done · worker last asked ...").

## Results on the labels (2026-10-05, 91 labeled clips / 48 swings)

The server's own deep-pass pose files (RTMPose-m) against the night pass (RTMW-l), both scored by
`eval.py` with the server's clubhead onsets:

- **Body points: the night pass is better.** Distance from the labels (median, % of height), server
  -> night: face-on hips downswing 2.4 -> 1.6, through 3.8 -> 2.5; wrists downswing 1.8 -> 1.5 (dtl
  1.8 -> 1.3); elbows a little closer on both angles. Left/right swaps face-on: shoulders 11 -> 6,
  wrists 6 -> 0. Down-the-line hips in the downswing slightly worse (3.1 -> 3.4).
- **Key positions: not better.** phases.js is tuned to the server's model, so the night pass's
  points move some rules by a steady amount: P3 within one frame 73% -> 29% face-on (bias -5 -> +7
  ms), P2 54% -> 40%; takeaway, P5 and impact about the same. P4's worst cases do improve (90th
  percentile 39 -> 35 ms face-on, 38 -> 29 dtl).

So the Labels card ranks swings by how far a position is from the **usual** difference between the
two at that position (the median over all swings compared), not by the raw gap, and lists it only
from 3 frames (12.5 ms). First case found: Sep 25 swing 1790353993, where the night pass puts P4 79
ms before the server's, the swing whose P4 the server finds 62 ms late against the label.

To decide whether the night pass's larger body model should set P4 (55 face-on hand labels were too few to decide), **Tools > P4 check** (`static/p4check.js`) collects quick, unbiased hand labels for the top of the backswing without showing either analysis's answer. The owner steps through frames around the top (0.15 s before to 0.10 s after server P4) and marks the last moment before motion starts down; saved labels (`quick: {p4: "p4check"}`) expand the evaluation sample to measure whether the larger model's P4 timestamps beat the server's.

Next with the files (not built): the night body points as training data for the server's body
model (hips and wrists especially), and retuning phases.js on them if the server ever runs RTMW.
