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
   disagree** card lists the unlabeled swings with the biggest gap (2 frames or more), worst first;
   **Go** opens the swing at the server's frame for that position.
2. **Training data.** The night files are a second set of body points on every frame of every clip,
   from a stronger model: the start of training data for the next models without labeling by hand.
   Not used yet.

## Setting it up (gaming PC)

1. The repo checked out (this is the dev PC: `D:\SwingClips-dev\swingclips`).
2. Double-click `server\Night worker.cmd`. The first run makes `.venv-gpu` (onnxruntime-gpu with
   CUDA through pip, ~1 GB; needs NVIDIA driver 580 or newer) and downloads RTMW (~220 MB).
3. It runs until the window is closed, below normal priority. To keep it to the night (the PC is
   used for games): `"Night worker.cmd" --hours 23-7`. Other options: `--workers N` (default half
   the cores), `--server URL`, `--once`.

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

Next with the files (not built): the night body points as training data for the server's body
model (hips and wrists especially), and retuning phases.js on them if the server ever runs RTMW.
