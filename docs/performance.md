# Keeping up: analysis speed, the deep pass, GPUs

How the server keeps up during a session, the benchmarks behind the settings, and the GPU experiments. (Moved out of HOME-SETUP.md, which has the session checklist, setup and troubleshooting.)

### Recording first, the deep pass after the session
During a session the server's first job is taking the clips in; the careful analysis comes after.
- **A session is on** while a phone is recording, and until 10 minutes after the last clip came in.
- **During it**, new clips are analyzed as they arrive, face-on first, the quick way below, so the
  spoken checks and Practice voice work. `set SWINGCLIPS_DURING_SESSION=wait` in `settings.cmd`
  leaves them all until the session is over (the Ready panel then says "Recording only: n clips to
  analyze after the session"; no spoken first-swing check or practice numbers).
- The pose workers always run **below normal priority**, so uploads and the pages come first
  whatever the server is doing.
- **After it**, the **deep pass**: every clip is analyzed again, newest first, the slow way: the body
  model on every frame (`SWINGCLIPS_DEEP_BODY_STRIDE`, default 1) and the club model when
  `public\models\club-deep.onnx` is there (or `SWINGCLIPS_DEEP_CLUB_MODEL` names one). Clips that
  arrive after a session go straight to it. Swing numbers, clip quality and 3D are worked out again
  from the deep result (their pose stamp ends in `+deep`). The Ready panel shows "deep pass: n clips
  to go". A session starting stops it between clips; it carries on after. `SWINGCLIPS_DEEP=off` turns
  it off.
- **The quick pass** (during a session, only when a deep pass will follow it): inside the swing,
  MediaPipe and the shaft search run only on every other frame (`SWINGCLIPS_QUICK_MP_STRIDE`, default
  2): the frames the body model runs on anyway at its CPU stride. The frames between get their
  landmarks in a straight line from their neighbours (4 ms apart) and the shaft from its tracking, as
  blurred frames do (a frame not searched, between searched ones, counts as sighted from them:
  `club.UNSEARCHED_GAP`). About a quarter less work a clip; the deep pass redoes every clip after
  the session. Its pose files say `"pass": "quick"`.
  Measured 2026-09-27 on the dev PC (Ryzen 5800X3D, 8 workers, RTMPose-m): 12.6-13.0 s -> 9.0-9.4 s
  a clip. On the 57 labeled clips (`eval.py --rerun --quick` against `--rerun`): every key position
  within half a frame of the full pass or better (takeaway 71 -> 50 ms, P8 face-on 17 -> 8 ms),
  impact and the ball the same, joints within 0.2% of height, the shaft found on 41% / 58% of frames
  (face-on / down the line) against 44% / 61%, its face-on angle 4.7° off against 3.5°. Check it on
  the server with `bench_models.py` (its verdict has a "During a session" line).
  `SWINGCLIPS_QUICK=off` analyzes during a session as before; `eval.py --rerun --quick` scores it.

### Keeping up during a session
A clip took ~35 s with RTMPose (a swing, two clips, comes every ~20 s), so a 40-swing session left
40+ clips waiting. Then: RTMPose runs on every other frame up to 0.9 s after the heard strike, with
the frames between filled in from their neighbours (4 ms apart; on the labeled swings the key
positions came out the same or better and joints within 0.3% of height), the club shaft is searched
over the same stretch, the ball search reads only +-0.6 s round the strike, RTMPose stays loaded
between clips, and the server uses half the logical CPUs (6 on the i5-12400). About 20 s a clip
(`bench_models.py`: 20.4 s; 16.1 s with no body model at all, so a GPU can't get it to 10 s).
New **face-on** clips go first, so the spoken checks and practice numbers keep up; the
down-the-line ones catch up between sets. `SWINGCLIPS_BODY_STRIDE=1` (settings.cmd) runs RTMPose on
every frame; `SWINGCLIPS_POSE_WORKERS=n` sets the workers.

**Less work a clip (2026-09-27).** The goal is 10 s a clip. Most of the rest was MediaPipe on every
frame, the club shaft search and turning each 1080p frame into pictures. What changed:

- **The same numbers, faster (always on).** Tested against the code before, to the last bit
  (`tests/test_speed.py`): the shaft search works out each pixel's difference from the empty scene
  with OpenCV instead of numpy (~7x faster for that step), and turns upright and masks only the
  square around the hands it looks in, not the whole picture (about half the shaft search's time
  went on those); the empty scene (the median of the keyframes, ~2 s while every worker waited) is
  found bit by bit on all the CPUs; the full-size picture is turned upright only on the frames the
  body model runs on; the ball search reuses the clip's last frame from the workers.
- **Settings that change the numbers a little** (`settings.cmd`; each has its own cache in
  `eval.py --rerun`, and the pose file records them as `"speed"` when any isn't as before):

| Setting | Default | As before | What it does |
|---|---|---|---|
| `SWINGCLIPS_MP_STRIDE_AFTER` | 4 | 1 | MediaPipe on every 4th frame after the swing (later than 0.9 s after the heard strike: ~1.1 s of each 4 s clip), the frames between filled in. Nothing is measured there: on the 37 labeled swings every number summary.js works out is the same with it (`tests/test_speed.py`). |
| `SWINGCLIPS_FRAME_CONVERT` | `full` | `full` | `planes`: MediaPipe's half-size picture straight from the decoded frame's brightness and colour planes, instead of converting the whole 1080p frame and halving it: ~2.5x less work, within ~1 level. Off by default: on the 37 labeled clips it moved the joints 1.1 px and the takeaway and face-on P4 by 4-8 ms (`--accuracy`). |
| `SWINGCLIPS_POSE_SPLIT` | `cost` | `even` | The clip is cut between the workers by what each part costs, not by the number of keyframes: the end of the clip (MediaPipe only, every 4th frame) is cheap, and an even cut left one worker idle while the others were still in the downswing. `frames` cuts at any frame, not only at keyframes (every 0.25 s, ~6 s of work in the swing, so `cost` still leaves workers idle up to 40% of the clip): the workers come out even, but each one decoding from the keyframe before its start eats most of it (12.6 -> 11.9 s a clip on the dev PC; nothing with the quick pass). |
| `SWINGCLIPS_SHAFT_STRIDE` | 1 | 1 | The shaft searched on every n-th frame of the swing, the tracking filling the rest as it does blurred frames. 2 halves the search; off by default, since the takeaway, P2, P6 and P8 come from the shaft. Try it with the check below. |
| `SWINGCLIPS_DECODE_THREADS` | FFmpeg's own | | Threads each worker decodes with. Doesn't change the numbers; FFmpeg's own choice was as fast as 1 or 2 in the cloud, so try it only with the benchmark. |

  In the cloud (4 CPUs, 3 workers, a 4 s 1080p 240 fps clip; MediaPipe is slower there, ~35 ms a
  frame): 37-39 s before, 26-27 s with the settings as before (the same numbers), 22 s with
  the defaults. The server's own run is what counts: see "Checking it" below.

**What reads frames outside the swing.** The swing here is from the takeaway to 0.9 s after the
heard strike. Before it, at address: P1 and the takeaway (the shaft still for 0.3 s before it, and
its angle at address), the noise floor (0.35 to 0.05 s before the takeaway, which the trust rules
read), everything "vs address" (turns, sway, rise, bend change: from P1), the setup and camera
check (at P1), the plane line down the line (the shaft at address), the club length to draw (the
first frame), the ball (looked for in the first frame) and, only when the shaft isn't tracked, P1
from the hands (0.2 s still before the top). After it: nothing measured; the skeleton and hand path
on the video, and the compare view's ghost.

So MediaPipe stays on every frame at address. On the labeled swings the takeaway comes 0.7-1.6 s
before the heard strike, and the capture app's clips start 2 s before it; everything above needs
from ~0.45 s before the takeaway. That leaves at most ~0.8 s of address (~0.4 s on average, about
a tenth of a clip) that nothing reads, and where it ends isn't known until the pose has run: a
first pass to find it would cost about what it saves. Also measured and left out: MediaPipe on a
smaller picture (its time doesn't change: it looks at a 256-pixel crop of the golfer either way).

**Checking it.** On the server (the server stopped: it would slow the run and be slowed):

```
cd /d D:\SwingClips\app\server
call settings.cmd
.venv\Scripts\python.exe bench_models.py --each --workers 6,8
```

The verdict starts with a line like:

```
  Keeping up, whole clip on the CPU (rtmpose-m every 2 frames, 6 worker(s)): 20.4 s with the speed settings as before -> xx s as set now (...)
    as before: ms a frame in each worker (frames it ran on, of 984): decode x, convert x, MediaPipe x, body x, shaft x
      6 worker(s) busy x-x s of the x s they took (loading MediaPipe x s in all)
      outside the workers: empty scene x s, ball search x s, smoothing x s, shaft tracking x s
    as set now: ...
    as set now, but SWINGCLIPS_FRAME_CONVERT=full: xx s
    as set now, and SWINGCLIPS_SHAFT_STRIDE=2: xx s
    as set now, and SWINGCLIPS_BODY_STRIDE=3: xx s
    as set now, 8 workers: xx s
```

`--each` puts each setting back on its own (what each one is worth) and tries two more that change
more (the shaft on every other frame, RTMPose on every third); `--workers 6,8` other worker counts:
with less to do a frame, 8 may use the i5-12400's 12 threads better than 6. Without them it's just
before and now (a few minutes).

Then the accuracy, on the dev PC (or the server) with the clips and labels, in one command:

```
.venv\Scripts\python.exe bench_models.py --accuracy
```

It runs `eval.py --rerun` with the speed settings as before (and `SWINGCLIPS_BODY_STRIDE` unset) and
as set now (both cached, ~25 min each the first time), then `tune_positions.py` on both, and ends
with **No worse: yes** or **NO** and why. No worse means, as set now against as before: every key
position's median error (per angle) within a frame (4.2 ms), none more missed; the tracked joints
within 1 px (median over the swings' frames, full-size picture); impact (the ball-gone frame) within
a frame and the ball found as often; the shaft found as often (within 2 points) and its angle
within 0.5 degrees; the key positions left out of the tuning (tune_positions.py) within a frame.
With **NO**, put the settings back one at a time (`set SWINGCLIPS_FRAME_CONVERT=full`, and so on)
and run it again to find the one. To try a setting that changes more, set it first
(`set SWINGCLIPS_SHAFT_STRIDE=2` or `set SWINGCLIPS_BODY_STRIDE=3`) and run the same command.

Clips already analyzed keep their results; the settings apply to new ones (the pose version is the
same, so nothing is analyzed again).

### Using a GPU (off by default)
Only the ONNX models can go on a GPU: RTMPose and the club model (`models.py`, through ONNX
Runtime's DirectML or CUDA). MediaPipe (~17 ms a frame), the club shaft search (~18 ms, less since
"Keeping up during a session" above) and decoding (~7 ms) stay on the CPU. Per frame in each worker, RTMPose is ~40 ms on every other frame, so ~20 of
~62 ms, and only up to 0.9 s after the strike. So even a GPU that ran RTMPose for free would take
well under a third off a clip; how much exactly is what `bench_models.py` measures, including that
floor. Freeing the cores may speed MediaPipe up a little too, which only a real run shows.

`SWINGCLIPS_ORT_PROVIDER` in `settings.cmd` picks where the models run: `cpu` (the default),
`dml` (DirectML: any DirectX 12 GPU on Windows, including the Intel graphics built into the CPU,
and AMD and NVIDIA cards), `cuda` (NVIDIA) or `auto` (the first of cuda, dml, cpu that's installed).
Each needs its own ONNX Runtime package **in place of** the CPU one (they all install the same
folder): `SWINGCLIPS_REQUIREMENTS=requirements-dml.txt` or `requirements-cuda.txt` in `settings.cmd`
makes `Start server.cmd` install that file instead of `requirements.txt`, and `ort_package.py`
takes the other package out first (it does the same going back). The window says where the models
ended up ("ONNX Runtime: rtmpose-m-256x192.onnx on DirectML"), and falls back to the CPU, saying
why, if the GPU isn't there or won't load them. On a GPU the body model runs on every frame by
default (`SWINGCLIPS_BODY_STRIDE=2` puts it back to every other); the 6 workers stay, since
MediaPipe and the shaft still need the cores, and they take turns on the GPU. `SWINGCLIPS_ORT_DEVICE=1`
picks the second GPU when there are two.

**1. Try the built-in graphics first (free).** The i5-12400 has Intel UHD Graphics 730; the
i5-12400**F** has none. Task Manager, Performance: an "Intel(R) UHD Graphics 730" GPU means it's
there. (Not listed: an F, or switched off in the BIOS.) Keep its driver current (Windows Update, or
Intel's driver page). Then, with the server stopped (it would slow the benchmark and be slowed):

```
cd /d D:\SwingClips\app\server
"Stop server.cmd"
echo set SWINGCLIPS_REQUIREMENTS=requirements-dml.txt>> settings.cmd
.venv\Scripts\python.exe ort_package.py requirements-dml.txt
.venv\Scripts\python.exe -m pip install -r requirements-dml.txt
call settings.cmd
.venv\Scripts\python.exe bench_models.py
```

(`>>` adds the line to `settings.cmd`; a single `>` would replace the RTMPose line.) It takes a few
minutes on the newest clip, or name one: `bench_models.py D:\SwingClips\clips\<clip>.mp4`.

**2. Reading the benchmark.** It ends with a verdict like:

```
Verdict: swing_face_..._2031ms.mp4, 6 worker(s)
  RTMPose-m: CPU xx ms, DirectML (Intel(R) UHD Graphics 730) xx ms (x.x x) a frame, one worker alone
  Whole clip (rtmpose-m): CPU xx s (every 2 frames) -> DirectML (...) xx s (every frame), DirectML (...) xx s (every 2 frames)
    CPU, every 2 frames: ms a frame in each worker: mediapipe xx, body xx
  Floor, no body model at all: xx s. No GPU gets the body model's clips below this; ...
  Keeping up (a swing, two clips, every ~20 s: 10 s a clip or less): yes/no, best xx s (...)
  Fastest: settings.cmd with SWINGCLIPS_REQUIREMENTS=requirements-dml.txt, SWINGCLIPS_ORT_PROVIDER=dml; ...
  DirectML (...) against the CPU, same frames: body points x.xx px apart (at most x.x px), ...
```

- The model lines are one worker alone. With 6 workers sharing a small GPU each one waits its turn,
  so the **whole clip** line is the one that counts: it's the server's own run, workers and all.
- **Floor**: the clip without RTMPose at all. The gap from the CPU's time down to the floor is all
  any GPU can win on the body model. A card only beats the built-in graphics where the built-in
  graphics' time is still well above the floor.
- **Every frame vs every 2 frames** on the GPU: every frame is the default there (the gap filling
  goes away); if every 2 frames is much faster, set `SWINGCLIPS_BODY_STRIDE=2` too. The verdict
  names the fastest settings.
- **Against the CPU**: a GPU's arithmetic isn't bit for bit the CPU's, so the points move a little
  (a fraction of a pixel typically; a point can jump a pixel or two where the model is unsure).
  That's why the next step is the scorecard, not just the timing.

**3. Check it against the labels, then switch.** `eval.py` keeps a GPU run's cached analyses apart
from the CPU's and names its result `..._dml.json`:

```
call settings.cmd
.venv\Scripts\python.exe eval.py --rerun
.venv\Scripts\python.exe eval.py --rerun --provider dml --compare D:\SwingClips\eval\<the result just saved>.json
```

The differences should be within the noise: key positions within a frame, joints within ~0.1% of
height. Then `echo set SWINGCLIPS_ORT_PROVIDER=dml>> settings.cmd` and start the server. Clips
already analyzed stay as they are (new pose files say `"provider": "dml"`). To go back, delete both
lines from `settings.cmd` and restart: the CPU package is put back. (With the DirectML package
installed but `SWINGCLIPS_ORT_PROVIDER` not set, the models run on the CPU through
onnxruntime-directml 1.24.4, the last DirectML release, rather than onnxruntime 1.30: fine for the
benchmark, but go back if the GPU isn't used.)

**4. A small card.** Only worth it if the built-in graphics leave a big gap above the floor. The
server's case decides the card:
- **NVIDIA RTX 3050 6 GB** (70 W, powered from the slot, low-profile versions exist): with
  `requirements-cuda.txt` and `SWINGCLIPS_ORT_PROVIDER=cuda` (CUDA 13 through pip, ~0.7 GB; needs
  NVIDIA driver 580 or newer), or with `dml` like any other card. Run the benchmark with both.
- **Any DirectX 12 card** with `dml`, e.g. a low-profile Intel Arc A310 or AMD Radeon RX 6400.
- Check before buying: **the case** (a slim case takes only low-profile cards, with the short
  bracket; look at the length and whether it's one or two slots thick), **the power supply**
  (a 70-75 W card needs no cable, but small OEM supplies can be 180-260 W: add the CPU's 65 W, up to
  ~117 W in bursts, and the card's), and **the slot** (a free PCIe x16-sized slot; the RTX 3050 6 GB
  runs at x8, fine here). With a card in, the BIOS may turn the built-in graphics off; that's fine.
- 6 workers each hold their own copy of the model on the card: a few hundred MB each with CUDA, so
  6 GB is plenty.
