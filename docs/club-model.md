# Training the club model

The YOLO club model: labels, dataset, training on the gaming PC, results so far, scoring. (Moved out of HOME-SETUP.md, which has the session checklist, setup and troubleshooting.)

### Training the club model
The shaft tracker (`club.py`) casts rays from the hands and looks for a thin line that isn't the
golfer or the empty scene. It loses the club in the fast part of the downswing, where the shaft is a
faint blur. The plan is a learned model instead: YOLO11 pose with three keypoints, **grip end,
hosel, clubhead**, trained on your own club labels (blurred clubhead included), with `club.py`'s
tracking kept on top as the filter. Like the other body models, it's for the scorecard until it
scores better: `SWINGCLIPS_CLUB_BACKEND=raycast` (default, output unchanged) or `yolo`.

**1. Labels.** Start with the frames already labeled (the club points in labeling mode, [scorecard.md](scorecard.md)).
Aim for **500 to 1,500 frames with the club labeled**, about half of them in the downswing and
follow-through: that's ~40-100 swings at ~12 frames each (the suggested frames lean that way
already). Mix both angles, clubs (driver, irons, wedge), day and night light. Put a blurred
clubhead in the middle of the streak with **Shift+click**; press **X** for a point you can't see.
Below ~300 frames the model will mostly learn these particular swings; past ~1,500 the gains are small.

**2. The dataset**, on a PC with the clips and labels: the server (its own `.venv` has everything),
or another PC with `SWINGCLIPS_CLIPS` (and `SWINGCLIPS_LABELS`, if not next to it) pointing at them:

```
cd /d D:\SwingClips\app\server
.venv\Scripts\python.exe club_dataset.py --out D:\SwingClips\club-dataset
```

- Each labeled frame becomes an upright picture in `images\train` or `images\val` and a line in
  `labels\...` (YOLO pose: the club's box, then x, y, visibility for grip, hosel, head).
  Can't-see (X) or skipped points get visibility 0; blurred ones stay visible. A frame with all
  three marked can't-see is kept with no club in it.
- Train and validation are split **by swing** (both angles of a swing go together), ~20% for
  validation (`--val 0.3` for more), picked the same way on every run. Frames of one swing never
  land on both sides, so the validation numbers aren't flattered by near-duplicate frames.
- It prints how many frames, blurred clubheads and swings went each way; `dataset.json` lists them.
  Running it again rebuilds the folder. Copy the whole folder to the gaming PC (`data.yaml` points
  to its own folder, so it works from anywhere).

**3. Training**, on the gaming PC (RTX 5070 Ti). A Blackwell card (sm_120) needs PyTorch built
for **CUDA 12.8 or newer**: the plain `pip install torch` on Windows is CPU-only, and builds for
CUDA 12.6 and older can't run on it. Needs a current NVIDIA driver (570 or newer) and 64-bit
Python 3.12 or 3.13 from python.org (3.13 with PyTorch 2.11 + cu128 works). In a Command Prompt, with the
repository cloned to `C:\swingclips` (on the dev PC it's `D:\SwingClips-dev\swingclips`, the same PC):

```
cd /d C:\swingclips\train
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -c "import torch; print(torch.__version__, torch.cuda.get_device_name(0), torch.cuda.get_arch_list())"
.venv\Scripts\python.exe club_train.py --data D:\club-dataset\data.yaml
```

- The check line should name the RTX 5070 Ti and list `sm_120`. `club_train.py` checks this too
  and stops with a hint if the build can't use the card.
- Defaults: `yolo11s-pose` from Ultralytics' COCO weights (downloaded the first time), 150 epochs
  at 640 px, batch 16, stopping early when validation hasn't improved in 40. For ~1,000 frames
  that should be well under an hour on a 5070 Ti (not yet timed). `--model yolo11n-pose.pt` is the small one, about 3x cheaper on the
  server's CPU; try it if `s` turns out slow (the scorecard prints the club model's ms per frame).
- Augmentation: left-right flips (the three points have no side, so each keeps its place:
  `flip_idx: [0, 1, 2]`), brightness (`hsv_v`, brightness/contrast, gamma), motion blur (up to
  21 px, any direction) and JPEG artefacts, on top of Ultralytics' mosaic, scaling and shifts.
- The run goes to `train\runs\club` (`results.png`, validation pictures, `weights\best.pt`),
  and the ONNX model to `public\models\club-yolo-pose.onnx`. Copy that file to the server's
  `D:\SwingClips\app\public\models` (not in git).
- Optional first pass on the public Roboflow **golf_club_pose** set (export it as "YOLOv8 Pose",
  unzip): `club_train.py --data ... --pretrain D:\golf_club_pose\data.yaml`. Its keypoints may not be
  grip, hosel, head in that order: run it once without `--pretrain-points` and it prints the set's
  classes and keypoints, then give their order, e.g. `--pretrain-points 0,-1,1` (-1 for one it
  doesn't have). If its keypoints aren't these points at all (say, only the shaft's ends), skip it.
  Compare the scorecard with and without it; the pretraining only helps if it helps there.

**First results (2026-09-26, 20 labeled swings: 482 club frames, 16 swings to train, 4 to score).**
Training takes ~10 minutes (150 epochs) for any size on the 5070 Ti. Scored on the 4 swings it never
saw, RTMPose-m on, against the ray casting (ms a frame on one CPU thread, as each server worker runs it):

| | CPU ms a frame | downswing found, face / DTL | downswing angle error, face / DTL |
|---|---|---|---|
| ray casting (default) | ~18 | 10% / 0% | 5.4° / - |
| `yolo11n-pose --imgsz 416` | 29-38 | 80% / 100% | 3.1° / 10.3° |
| `yolo11n-pose` (640) | 71-95 | 70% / 67% | 1.9° / 5.7° |
| `yolo11s-pose` (640, the default) | 200-290 | 80% / 100% | 3.1° / 4.3° |

The model replaces the ray casting (it isn't run as well), so the small one costs the server ~20 ms a
frame more; the default `s` would triple a clip's time. P6 and P8 get better with any of them
(P6 within a frame on all 4 swings; P8 8 ms against 15-29), but the takeaway and P2 get worse: their
rules read the ray casting's 2 degree steps (docs/key-positions.md), which the model's smooth angle
doesn't have. Four swings is too few to choose between the models, so: `yolo11n-pose --imgsz 416`
for now, not on the server until the takeaway and P2 rules read the model's angle and more swings
are labeled (40+ swings for a real score).

**Second round (2026-09-27, 31 swings: 721 club frames, 25 to train, 6 to score), in the deep pass**
(`eval.py --rerun --deep`, median / 90th percentile ms). The club model's angle wobbles a degree
or two at address, which put the takeaway 17-33 ms later; so with the club model the deep pass also
runs the ray casting (`clubRay` in the pose file) and address and the takeaway come from that:

| | takeaway face / DTL | P2 face / DTL | P5 face / DTL | P6 face / DTL | P8 face / DTL | downswing shaft found, face |
|---|---|---|---|---|---|---|
| quick (the server during a session) | 21/50, 17/52 | 0/29, 17/23 | 2/102, 8/121 | 8/17, 13/19 | 15/40, 29/37 | 25% |
| deep, no club model | 21/50, 17/54 | 0/21, 8/17 | 0/6, 4/7 | 8/17, 8/18 | 8/42, 8/40 | 25% |
| deep, `yolo11s-pose` 640 | 21/50, 17/54 | 4/19, 4/22 | 0/6, 4/7 | 2/4, 0/4 | 6/13, 8/13 | 88% |
| deep, `yolo11n-pose` 416 | 21/50, 17/54 | 23/54, 21/67 | 0/6, 4/7 | 4/4, 4/4 | 4/6, 8/11 | 81% |

So the deep pass uses `yolo11s-pose` at 640 (`public\models\club-deep.onnx` on the server); ~270 ms a
frame on the CPU doesn't matter after a session. The small one loses P2.

**4. Scoring it**, on the server (or any PC with the clips, labels and the model file):

```
cd /d D:\SwingClips\app\server
.venv\Scripts\python.exe eval.py --rerun --only-val D:\SwingClips\club-dataset\dataset.json
set SWINGCLIPS_CLUB_BACKEND=yolo
.venv\Scripts\python.exe eval.py --rerun --compare --only-val D:\SwingClips\club-dataset\dataset.json
```

- `--only-val` scores only the dataset's validation swings, which the model never trained on.
  Without it, most of the labeled frames were in the training set and the numbers look better
  than they'll be on new swings. (Drop it to see everything, on both runs.) Even better, now and
  then: label a few new swings after training and score them.
- The first run, without the setting, is the ray-casting baseline (skip it if you have one from
  this `pose.py` over the same validation swings: `--compare` on its own picks the newest
  baseline over the same clips). `--compare` then shows every headline number before and after: the club table's
  **% found** and **angle error by phase** (downswing is the one to watch), and P2 / P6 / P8 timing,
  which hangs on the shaft.
- A new table, **Clubhead**, only with the model: the clubhead's distance from your label as a %
  of nose-to-ankle height by phase, with blurred frames on their own. The page doesn't use the
  clubhead yet; it's saved per frame in the pose file (`clubhead`: x, y, confidence).
- The pose files and results carry the model's name and a hash of the file
  (`club-yolo-pose@1a2b3c4d`), so every retraining gets its own `--rerun` cache and result file.
  `SWINGCLIPS_CLUB_MODEL` points at another file to compare two models. `set SWINGCLIPS_CLUB_BACKEND=`
  goes back to the ray casting in that window.
- Using it on the server for real: set `SWINGCLIPS_CLUB_BACKEND=yolo` for the server itself, and
  bump `VERSION` in `pose.py` so every clip is analyzed again. Only once the scorecard says it's better.
