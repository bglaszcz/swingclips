# Key positions against the owner's labels

How the takeaway, P3, P4 and P5 are found (`server/static/phases.js`), the evidence from the hand
labels in `server/tests/fixtures/real/` behind each rule, and where labels and rules still
disagree. Impact, P2, P6 and P8 are unchanged (impact and P6 were already right).

Scored on the 37 labeled clips (20 swings: 20 face-on, 17 down the line; 7 iron, 9 iron, 5 iron,
PW, GW, 3 wood, driver) with both body models: RTMPose-m (`pose-rtmpose-m/`), which the server
runs and is the primary target, and MediaPipe alone (`pose/`). `python tune_positions.py` (in
`server/`) reproduces every number here.

**Five swings' labels are left out of the scoring for now** (takeaway and P2-P5 on 1790206528,
1790271783, 1790354525, 1790372037 and 1790372055, both angles; listed in
`tests/fixtures/real/labels-to-recheck.json`): they were taken from the labeling page's suggested
frames, so they measure the detector against itself (see "Labels taken from the suggested frames"
below). So each takeaway-to-P5 row is 15 swings face-on and 13 down the line. `python
tune_positions.py --all-labels` scores them too.

## What each key position now means

| | Rule |
|---|---|
| **Takeaway** | face-on after the deep pass: 17 ms after the camera sees the clubhead start to leave the ball (`clubOnset` in the pose file, `pose.club_onset`), moved at most 10 ms toward the shaft rule. Otherwise (during a session, no ball found) the shaft rule: where the shaft starts to turn away from its angle at address, the first frame from which the tracked angle stays off its address value (a 2° step) until P2, extended back to the address angle along the line through that step and the next one |
| **P3** lead arm parallel, back | the lead **forearm** (elbow to wrist) rising through level, face-on |
| **P4** top | half way between where the **hands start down** (the lead wrist's speed climbing into the downswing, extended back along a straight line to zero speed) and where the lead wrist is **slowest** (positions smoothed over ±50 ms) in the 0.2 s before that |
| **P5** lead arm parallel, down | the lead forearm falling through level |

P1 is still 0.1 s before the takeaway. P3, P4 and P5 use only the wrists and elbows, which both
models place: RTMPose moves the wrists but leaves MediaPipe's finger points where MediaPipe put
them, so a rule on the fingers would behave differently per model.

The tuned numbers are five, in `SwingPhases.TUNING`: `takeawayDegrees` 1 (i.e. any change),
`topSpeedShares` [0.1, 0.4], `topSmoothSeconds` 0.03, for the clubhead onset `onsetLead` 0.017
and `onsetPull` 0.01, and for the top's slowest moment `topSlowSeconds` 0.05 and `topRuleWeight` 0.5. The takeaway's extension back has no
number of its own: the tracked angle moves in 2° steps, so the first step marks about 1° of turn
and the next about 3°, and the line through them reaches 0° half the gap between them before the
first. P3 and P5 have none.

## Before and after

Each cell: median |error| / 90th percentile |error| / bias (mean; + = found late) in ms / share
within one frame. "Before" is phases.js as it was (the takeaway at the first shaft step). "Leave
one swing out" tunes on nineteen swings and scores the twentieth, twenty times over, so it says how
the rules do on a swing they haven't seen; "all swings" is what the page shows with the tuning in
phases.js. Down the line is the face-on clip's positions carried across by the impact sync, as the
page shows them, against the down-the-line labels. Only the takeaway changed; P3, P4 and P5 are
here for reference (identical before and after).

#### RTMPose-m

| Key position | Angle | n | Before, leave one swing out | After, leave one swing out | After, all swings |
|---|---|---|---|---|---|
| Takeaway | face-on | 15 | 25 / 63 / +39 / 27% | 21 / 51 / +19 / 33% | 21 / 51 / +19 / 33% |
| Takeaway | down the line | 13 | 12 / 64 / +35 / 23% | 21 / 39 / +15 / 0% | 21 / 39 / +15 / 0% |
| P3 | face-on | 15 | 8 / 23 / -8 / 47% | 8 / 23 / -8 / 47% | 8 / 23 / -8 / 47% |
| P3 | down the line | 13 | 12 / 29 / -14 / 23% | 12 / 29 / -14 / 23% | 12 / 29 / -14 / 23% |
| P4 | face-on | 15 | 21 / 67 / -3 / 40% | 21 / 67 / -3 / 40% | 21 / 43 / +4 / 47% |
| P4 | down the line | 13 | 29 / 67 / +0 / 15% | 29 / 67 / +0 / 15% | 25 / 47 / +8 / 15% |
| P5 | face-on | 15 | 4 / 8 / +4 / 80% | 4 / 8 / +4 / 80% | 4 / 8 / +4 / 80% |
| P5 | down the line | 13 | 4 / 8 / +4 / 77% | 4 / 8 / +4 / 77% | 4 / 8 / +4 / 77% |

#### MediaPipe

| Key position | Angle | n | Before, leave one swing out | After, leave one swing out | After, all swings |
|---|---|---|---|---|---|
| Takeaway | face-on | 15 | 21 / 80 / +32 / 27% | 21 / 107 / +9 / 40% | 21 / 107 / +9 / 40% |
| Takeaway | down the line | 13 | 12 / 67 / +27 / 31% | 21 / 109 / +3 / 8% | 21 / 109 / +3 / 8% |
| P3 | face-on | 15 | 12 / 25 / -1 / 47% | 12 / 25 / -1 / 47% | 12 / 25 / -1 / 47% |
| P3 | down the line | 13 | 17 / 28 / -4 / 23% | 17 / 28 / -4 / 23% | 17 / 28 / -4 / 23% |
| P4 | face-on | 15 | 29 / 52 / +25 / 20% | 29 / 52 / +25 / 20% | 38 / 59 / +12 / 7% |
| P4 | down the line | 13 | 29 / 58 / +29 / 0% | 29 / 58 / +29 / 0% | 46 / 62 / +13 / 8% |
| P5 | face-on | 15 | 4 / 8 / +3 / 67% | 4 / 8 / +3 / 67% | 4 / 8 / +3 / 67% |
| P5 | down the line | 13 | 4 / 12 / +5 / 62% | 4 / 12 / +5 / 62% | 4 / 12 / +5 / 62% |

With every label scored (`--all-labels`, leave one swing out), the takeaway goes from 48 / 100 / +54
to 21 / 81 / +32 face-on and from 42 / 100 / +50 to 21 / 77 / +27 down the line on RTMPose-m;
on MediaPipe from 48 / 100 / +49 to 21 / 102 / +24 and from 42 / 107 / +45 to 25 / 107 / +18.
Nothing else moves.

What the takeaway change does, honestly: it moves the takeaway back by half the gap between the
shaft's first two steps (17-25 ms on most swings). On RTMPose-m that pulls in the late swings (+50
to +67 ms become +21 to +29) and halves the bias; the swings that were already on the label become
~21 ms early. Mean |error| drops from 39 to 30 ms face-on and 36 to 31 ms down the line, and the
90th percentile on both angles; the down-the-line median is worse (12 to 21 ms). On MediaPipe the
bias drops to near zero but the 90th percentile gets worse, from one swing: on 1790371899
MediaPipe's tracked shaft settles a step off its address angle 62 ms before your label and toggles
there until the swing really starts, so the old rule was already 62 ms early and extending back
doubles it (-125 ms). RTMPose-m's shaft doesn't do that on this swing.

Leave-one-out picks the same tuning every time except `topSpeedShares`, where it picks [0.2, 0.5];
that tuning fits the swings it was picked on better (P4 face-on 90th percentile 43 ms) but does
worse on the swing left out (67 ms, on RTMPose-m), so phases.js keeps [0.1, 0.4]. The regression
test (`tests/test_fixtures.py`, `KeyPositionsTest`) holds each model, angle and key position to its
saved median and 90th percentile (`key-positions.json`) within a frame (4.2 ms).

## The evidence, per key position

### Top: half way to the slowest moment (2026-09-30)

20 of the 43 face-on top labels were exactly on the detector's frame (confirmed suggestions, which
can only agree with it). The owner relabeled them by stepping to the last frame before the club
starts down (some stayed). Against the relabeled set the speed rule alone scored 21 ms median, p90
46, +15 ms late, 19% within a frame: it extends the downswing's speed climb back to zero, so a
gentle start puts it late (1790353993: +62 ms). Two measures of the slowest moment at the top sit
on the labels instead: the camera (the picture round the hands and club, each crop normalized and
compared with the frame 1/60 s before so the lights' flicker cancels) at median 12.5 ms, -8 ms bias,
and the lead wrist's own slowest moment (RTMPose-m, smoothed over ±50 ms) at 12.5 ms, no bias. The
wrist needs no video, so phases.js takes half way between it and the speed rule. Leave one swing
out, RTMPose-m, median / p90 / bias / within one frame:

| | face-on (43) | down the line (39) |
|---|---|---|
| speed rule (before) | 17 / 45 / +9 ms / 26% | 17 / 47 / +14 ms / 23% |
| half way to the slowest wrist | 12.5 / 41 / +7 ms / 30% | 12.5 / 38 / +9 ms / 26% |

The worst tenth barely moves: the hands hang still for 30-80 ms at the top, and on those swings
neither measure pins one frame. Averaging in the camera's slowest moment would take the p90 to
~33 ms, but it needs another decode per clip; not done. MediaPipe alone is 33-38 ms median either way.

### Takeaway from the clubhead onset, in phases.js (2026-09-30)

The server now works out the camera onset once per face-on clip, after the deep pass (app.py
`add_club_onset`: ~1.5 s a clip, it decodes the window round the shaft rule's takeaway again), and
saves it in the pose file as `clubOnset`; phases.js takes the takeaway from it. 91 labels on 48
swings (the owner labeled seven more takeaway swings on Sep 30), RTMPose-m, leave one swing out,
median / p90 / bias / within one frame:

| | face-on (43) | down the line (39) |
|---|---|---|
| shaft rule (before) | 21 / 96 / +18 ms / 19% | 17 / 112 / +13 ms / 18% |
| clubhead onset + 17 ms, at most 10 ms toward the rule | 8 / 25 / +5 ms / 33% | 8 / 33 / +2 ms / 31% |

Every held-out swing picked the same `onsetLead` / `onsetPull`. The onset itself runs ~15 ms ahead
of the labels: on 1790706208 the clubhead has slid a fraction of a pixel from 0.804 s (optical flow
on the box), 1 px by 0.829 s where the label is. The labels mark "visibly moves back", and the
onset follows them. The two cameras agree on the owner's labels (median 4 ms apart after the sync)
better than on the onset (21 ms). The down-the-line onset isn't used: the clubhead moves straight
away from that camera, and averaging it in didn't help. Optical flow instead of the pixel change
was tried too: fine face-on, 40-60 ms late down the line.

### Takeaway: the camera's clubhead onset beats the shaft rule (2026-09-28)

After the takeaway was redefined as "the clubhead leaves the ball" and the nine swings with early
labels were relabeled against the Labels page's Clubhead motion trace (15 of the 17 labels moved
29-141 ms later), 76 labels on 41 swings, RTMPose-m, recheck list left out:

| | face-on (36) median / p90 / bias / within 1 frame | down the line (28) |
|---|---|---|
| shaft rule (phases.js) | 31 / 100 / +21 ms / 11% | 33 / 129 / +15 ms / 14% |
| camera onset (`pose.clubhead_motion`) | 15 / 54 / -4 ms / 36% | 12.5 / 104 / +2 ms / 25% |

The camera halves the typical error and has almost no bias; the tuner still keeps phases.js as it
is (nothing it can tune helps). Three swings have the camera 80-133 ms later than the label on both
angles, the same pattern as the nine that were relabeled: 1790353567, 1790354222, 1790371527 (Sep
25), likely early labels. The camera onset isn't in the pose files yet (it runs on video crops
behind the ball), so using it for the takeaway means computing it during analysis and letting
phases.js take it when present. Scored with the server's `/api/clubmotion/<clip>`, quiet from 0.35 s
before the label.

### Takeaway: why it got late, and the first thing that moves

**The rule didn't change** since this doc was first written: `phases.js` is the same, and with the
old fixtures it still scores 19 ms median face-on. **Your takeaway labels on the old swings didn't
move either**: face-on none changed; down the line only the three this doc flagged as disagreeing
with face-on (1790278981 +58 ms, 1790353476 -62, 1790353992 +54), which now agree with face-on to
within a frame. (Other relabels on the old swings: P4 on 1790271726 face-on -25 ms and 1790271802
face-on -42; P3 on 1790271802 face-on +12, 1790353476 down the line -21, 1790353497 down the
line -29.) The rule's errors on the old ten swings are the same as before.

**The new swings are what moved the numbers.** Five of them have the takeaway on exactly the
labeling page's suggested P1 frame, which is 0.1 s before the rule's takeaway by construction: +100
ms each, on 10 of the 37 labels (next section). The rest of the new swings: 1790354261 0 ms,
1790354545 +25, 1790371899 +58, 1790354288 +58, 1790206507 +67.

**What moves first at your label** (15 face-on swings, RTMPose-m, measured from the median over
0.1-0.35 s before your label):

- **The wrists: nothing.** The lead wrist is within 0.002 of the picture height of its address
  place at your label and for 50 ms after it, the same as its jitter while standing still. The
  hands move far less than the clubhead at the start (the club is a lever), so the body models
  can't see them start.
- **The shaft angle** is at its address value or one 2° step off at your label on every swing;
  the first step comes a median 25 ms after it and the next (about 3° of turn) ~58 ms after.
- **The clubhead from the club** (the hands plus the club's length along the shaft angle) is the
  same measurement: with the hands still, it moves only when the shaft angle steps, ~1.5 cm per
  degree for a 7 iron.

So the shaft is the first tracked signal to move, and it moves in 2° steps. You see the clubhead
start before the first step. On four swings the tracked shaft doesn't leave its address values
(including the one-step flicker some swings have while standing still) until 46-67 ms after your
label (1790206507, 1790354067, 1790354288, 1790371899): there the tracker sees nothing until well
into the takeaway, and no rule on this data can do better. Extending the first two steps
back to 0° is the one thing the steps themselves say about when the turn began. Tried and dropped:
extending from the 3° and 5° steps (worse: 27 / 102 ms face-on on RTMPose-m) and a constant
acceleration from rest (1.37 times the gap back instead of half: biased early, 32 / 66 ms).

**1790353497 (PW)**: both of your labels (face-on and down the line agree) are 180 ms before the
shaft angle changes at all. Either the clubhead really moves with the shaft keeping its angle (a
one-piece takeaway: hands and club moving together), or both labels are early.

### P3 and P5: the lead forearm, not shoulder to hands

At your P3 label, the line from the lead shoulder point to the lead wrist is 7-13° below level
(face-on) on every swing; it reaches level 35-50 ms later (median). The forearm (elbow to wrist) is
level right at your label: median error 8 ms (RTMPose-m) and 12 ms (MediaPipe). The same at P5:
the forearm is level within 4 ms of your label on both models. The reason the shoulder line reads
steep: both models put the shoulder point at the top of the shoulder, above the joint the arm
swings from. An angle offset of ~10° on the shoulder line fits about as well, but it's a tuned
constant; the forearm needs none. (The upper arm, shoulder to elbow, is the worst: 27-85 ms.)

### P4: the last frame before the club starts down

Your new definition (the last frame before the club starts down) asks whether the club itself
should find the top. The candidates, face-on, on the 15 swings scored:

| Candidate for P4 (face-on) | RTMPose-m median / 90th (ms) | MediaPipe median / 90th |
|---|---|---|
| **hands start down (the rule)** | **21 / 43** | **38 / 59** |
| club turns back: the last frame at the shaft angle's backswing peak | 12 / 145 | 25 / 102 |
| club starts down: the shaft's turning speed extended back to zero (the hands rule's method on the shaft) | 21 / 69 | 23 / 81 |

(Scored on all 15 swings with phases.js's tuning; the club rules need none of their own.)

- **The shaft's turn at the top** fits well on eight swings (within 12 ms), is 25-54 ms off on
  two, and doesn't fit at all on five (79-167 ms early on 1790206444, 1790271665, 1790278981, 1790353497, 1790371899). Face-on at the
  top the shaft points toward the camera and the tracker's angle wanders: only ~40% of frames within
  50 ms of your label have a confident sighting (86% at address), and the angle jumps 20-40° between
  frames on several swings. Using only the confident sightings doesn't help.
- **Down the line** the shaft is side-on at the top, but the tracker has no confident sighting
  within 50 ms of your P4 on 16 of 17 swings: the angle there is filled in between sightings, a
  straight ramp. So the club can't be read at the top from either angle.
- **The shaft's turning speed** in the downswing is well measured, like the hands', and extending it
  back works about as well as the hands on the median but has a worse tail on RTMPose-m (90th
  percentile 69 vs 43 ms).

So P4 stays on the hands. It is the only candidate with a steady tail on RTMPose-m; a club-based
top would need a club tracker that sees the shaft at the top (the YOLO backend in `club.py` might).

**Swings with a pause at the top.** On seven swings the lead wrist stays under a tenth of its
downswing peak speed for 75-117 ms at the top (1790206444, 1790206507, 1790271665, 1790271802,
1790279635, 1790354261, 1790371899). The rule lands near the end of that stretch, where the hands
leave, which is what "the last frame before the club starts down" means for a pause. It fits your
label on four of them (within 21 ms) and is 33 ms early on 1790354261 (your label at the very end
of the pause). On two your label sits in the middle of the pause and looks early by the new
definition: **1790279635** (label 37 ms into a 100 ms pause; the hands leave 50 ms after your
label, and the shaft's turn also comes 54 ms after it) and **1790271802** (label 62 ms into a
117 ms pause, rule +29 ms). Worth a look. The other way round, **1790353993** (driver): the hands
only leave 58 ms after your label, but the face-on shaft angle turns back 12 ms before it (on
RTMPose-m's track; the face-on shaft at the top is the least reliable reading), so there your label
may follow the club while the rule follows the hands.

### Takeaway from the camera: the clubhead leaving the ball (2026-09-28)

The takeaway label means the first frame the clubhead leaves the ball (confirmed by the owner). The
tracked shaft sees that in 2° steps and the wrists not at all, so a second, independent measure:
the pixels round the clubhead at address (`pose.clubhead_motion`: a box round the ball, 6 ball radii
either side, from 2 above its middle to 4 below so the shaft stays out; each frame taken to zero
mean and unit spread against the lights' flicker; compared with the box while still; the change's
start walked back from half way up to 5 spreads over the level just before it).

On the 47 labels not listed for recheck, RTMPose-m (median / p90 / bias, ms):

| Labels | Shaft rule | Camera |
|---|---|---|
| Sep 23-24 swings (22) | 19 / 83 / +10 | 21 / 97 / -4 |
| Sep 25 swings (25) | 71 / 102 / +71 | 50 / 117 / +42 |

On the Sep 25 swings both measures put the clubhead leaving the ball 40-140 ms after the label, and
the frames agree (on 1790371549 the clubhead is still behind the ball 100 ms after it): those labels
are early, not the rule late. Their takeaways (9 swings) are in `labels-to-recheck.json`; without
them the takeaway scores 21 ms face-on and 17 ms down the line (leave one swing out). The camera
doesn't beat the rule on the older labels, so phases.js is unchanged; it's on the Labels page as
the **Clubhead motion** trace (flat while still, rising as the clubhead leaves), to label against.
Once those swings are relabeled with it, score the camera against the rule again.

## Where labels and rules still disagree

### Labels taken from the suggested frames (please redo these)

On five swings the takeaway label is on exactly the frame the labeling page suggests for P1 (the
first "Suggested frames" chip, `[` / `]`), on both angles, and P2-P5 are mostly on the suggested
frames too, to the frame:

| Swing | Takeaway (ms from the rule, as it was) | P2-P5 on the suggested frame |
|---|---|---|
| 1790206528 (7 iron, face-on only) | +100 | P2, P3, P5 |
| 1790271783 (7 iron) | +100 / +100 | all four, both angles |
| 1790354525 (3 wood) | +100 / +100 | all four face-on, P4 and P5 down the line |
| 1790372037 (GW) | +100 / +100 | P3-P5 face-on, all four down the line |
| 1790372055 (GW) | +100 / +100 | all four, both angles |

P1 is put 0.1 s before the takeaway the rule finds, where the club is by design still at rest; on
these swings the tracked shaft doesn't move for the whole 100 ms after your label. A takeaway on
exactly that frame on five swings, both angles, can't be a coincidence, so these labels were most
likely confirmed on the suggested frames rather than stepped to. They're left out of the scoring
(`labels-to-recheck.json`) because a label copied from the detector can only agree with it: they
made the takeaway look 48 ms late, and they hold P4 exactly where the current rule is. Please
relabel them stepping frame by frame, without the suggested frames, then take them out of that
file and run `python tune_positions.py --baseline`.

Three more swings have P4 exactly on the rule's frame: 1790354545 and 1790371899 on both angles,
1790206507 face-on (no down-the-line labels). For the top, where the hands hang still for up to
0.1 s, that's unlikely by chance. They're kept, since their takeaways and some other labels differ
from the suggestions, but they're worth a second look.

### Labels where the two angles disagree

Face-on against down the line on the same swing, synced on your two impact labels (ms; + = the
down-the-line label is later), where they differ by more than 2 frames (8.3 ms):

| Swing | Takeaway | P2 | P3 | P4 | P5 |
|---|---|---|---|---|---|
| 1790271665 (7 iron) | | | | +9 | |
| 1790278981 (7 iron) | +14 | +13 | | | |
| 1790353476 (PW) | | | | +13 | |
| 1790353497 (PW) | | +13 | | -16 | -17 |
| 1790353993 (driver) | | | +17 | -12 | |
| 1790354067 (driver) | | | +9 | | |
| 1790354261 (5 iron) | | | | -16 | |
| 1790354288 (5 iron) | | +17 | +9 | | |
| 1790354525 (3 wood) * | -20 | | | -16 | -17 |
| 1790354545 (3 wood) | +9 | | | | +8 |
| 1790372037 (GW) * | | +13 | | | |

\* also on the list above. P6 and P8 agree within 2 frames on every swing. The same moment
shouldn't differ by more than a frame or two between the angles; P4 (six swings, 9-16 ms) and P2
(four swings, 13-17 ms) are the most common. These are much closer than before the relabel (the
old list had differences up to 64 ms).

### Not the rules: one swing's sync

On 1790353476 the down-the-line clip's ball-gone frame used to be 50 ms after your impact label,
which put that swing's down-the-line positions ~50 ms off. Since the sync uses a ball-gone frame
only when it fits the heard strike (`summary.js` `syncOffset`), the down-the-line impact on this
swing is on your label and P5 within a frame.

## Pump drill

A swing recorded in drill mode for the pump drill (`drills.py`: to the top, the hands pumped down to
the trail pocket and back up, twice, then through) has three tops. `detect(..., {drill: "pump"})`
follows the hands' height as a zigzag (a turn counts once they've come back half a torso length,
shoulders to hips; the owner's pumps travel ~1.2): P1-P3 and the takeaway come from the first move
up from address, P4 is the highest the hands get in the last second before impact (then refined
by where they start down, as usual), P5-P8 as for any swing, and `pumps` are the low points between
the first top and the last. The backswing timing check uses the first backswing. On the 10 pump
swings of Sep 30 all were found (before: all "timing"), with bottoms ~1.3 s apart and a 0.25 s
downswing. With fewer than two tops (no pumps after all) the swing is read as an ordinary one.
`tests/pump.test.js` holds one of them (`fixtures/real/pump`).

## Refreshing

After labeling more swings and refreshing the fixtures (`fixtures_export.py`):

    python tune_positions.py              # before/after, leave one swing out, and the tuning to use
    python tune_positions.py --all-labels # the same with the labels to recheck scored too
    python tune_positions.py --baseline   # once the numbers are better: save them for the test

If the tuning it picks on all swings differs from `SwingPhases.TUNING` and does better leave one
swing out, put it there. After relabeling a swing listed in `labels-to-recheck.json`, take it out
of that file.
