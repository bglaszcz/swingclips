# Key positions against the owner's labels

How the takeaway, P3, P4 and P5 are found (`server/static/phases.js`), the evidence from the hand
labels in `server/tests/fixtures/real/` behind each rule, and where labels and rules still
disagree. Impact, P2, P6 and P8 are unchanged (impact and P6 were already right).

Scored on the 18 labeled clips (10 swings: 7 iron, pitching wedge, driver) with both body models:
MediaPipe (`pose/`) and RTMPose-m (`pose-rtmpose-m/`), which the server will probably switch to and
is the primary target. `python tune_positions.py` (in `server/`) reproduces every number here.

## What each key position now means

| | Before | Now |
|---|---|---|
| **Takeaway** | the end of a 0.3 s stretch with the shaft within 2° | the first frame from which the shaft stays off its angle at address (any change of the tracked angle, which moves in 2° steps) until P2 |
| **P3** lead arm parallel, back | lead shoulder to the hands most level in the picture | the lead **forearm** (elbow to wrist) rising through level, face-on |
| **P4** top | the end of the last 20 ms rise of the wrists and index fingers | where the **hands start down**: the lead wrist's speed climbing into the downswing, extended back along a straight line to zero speed |
| **P5** lead arm parallel, down | lead shoulder to the hands most level | the lead forearm falling through level |

P1 is still 0.1 s before the takeaway. All four use only the wrists and elbows, which both models
place: RTMPose moves the wrists but leaves MediaPipe's finger points where MediaPipe put them, so a
rule on the fingers would behave differently per model. (The old P4 used the index fingers.)

The tuned numbers are down to three, in `SwingPhases.TUNING`: `takeawayDegrees` 1 (i.e. any
change), `topSpeedShares` [0.1, 0.4] and `topSmoothSeconds` 0.03. P3 and P5 have none: no angle
offset, no window.

## Before and after

Each cell: median |error| / 90th percentile |error| / bias (mean; + = found late) in ms / share
within one frame. "Leave one swing out" tunes on nine swings and scores the tenth, ten times over,
so it says how the rules do on a swing they haven't seen; "all swings" is what the page shows with
the tuning picked on all ten. Down the line is the face-on clip's positions carried across by the
impact sync, as the page shows them, against the down-the-line labels.

#### RTMPose-m

| Key position | Angle | n | Before | After, leave one swing out | After, all swings |
|---|---|---|---|---|---|
| Takeaway | face-on | 10 | 48 / 100 / +54 / 0% | 19 / 63 / +37 / 30% | 19 / 63 / +37 / 30% |
| Takeaway | down the line | 7 | 46 / 100 / +63 / 0% | 17 / 111 / +48 / 14% | 17 / 111 / +48 / 14% |
| P3 | face-on | 10 | 31 / 51 / +32 / 10% | 12 / 23 / -9 / 30% | 12 / 23 / -9 / 30% |
| P3 | down the line | 6 | 23 / 42 / +23 / 17% | 27 / 35 / -15 / 17% | 27 / 35 / -15 / 17% |
| P4 | face-on | 9 | 33 / 97 / +17 / 11% | 25 / 57 / +5 / 11% | 21 / 52 / +3 / 33% |
| P4 | down the line | 6 | 19 / 71 / +14 / 17% | 31 / 48 / +20 / 0% | 31 / 54 / +22 / 0% |
| P5 | face-on | 9 | 12 / 22 / -12 / 22% | 4 / 8 / +3 / 78% | 4 / 8 / +3 / 78% |
| P5 | down the line | 6 | 6 / 33 / -1 / 50% | 6 / 33 / +13 / 50% | 6 / 33 / +13 / 50% |

#### MediaPipe

| Key position | Angle | n | Before | After, leave one swing out | After, all swings |
|---|---|---|---|---|---|
| Takeaway | face-on | 10 | 48 / 100 / +54 / 0% | 19 / 63 / +37 / 30% | 19 / 63 / +37 / 30% |
| Takeaway | down the line | 7 | 46 / 100 / +63 / 0% | 17 / 108 / +48 / 14% | 17 / 108 / +48 / 14% |
| P3 | face-on | 10 | 56 / 72 / +52 / 0% | 8 / 27 / -0 / 40% | 8 / 27 / -0 / 40% |
| P3 | down the line | 6 | 35 / 69 / +42 / 0% | 23 / 37 / -11 / 17% | 23 / 37 / -11 / 17% |
| P4 | face-on | 9 | 87 / 104 / +60 / 22% | 42 / 67 / +28 / 22% | 33 / 64 / -10 / 11% |
| P4 | down the line | 6 | 75 / 121 / +68 / 0% | 52 / 75 / +52 / 0% | 46 / 94 / +14 / 0% |
| P5 | face-on | 9 | 17 / 22 / -15 / 22% | 4 / 8 / +3 / 67% | 4 / 8 / +3 / 67% |
| P5 | down the line | 6 | 17 / 33 / -5 / 33% | 6 / 33 / +13 / 50% | 6 / 33 / +13 / 50% |

Everything face-on got better on both models, and MediaPipe got better everywhere. Two cells got
worse: RTMPose's P3 and P4 **down the line** medians (23 to 27 ms, 19 to 31 ms; their 90th
percentiles improved). That is the labels, not the rules: on the same swings the down-the-line
labels sit away from the face-on ones by about as much (next section), and one swing's sync is off
by 50 ms. A rule that matches the face-on labels better moves away from those. The takeaway's mean
(+37) is pulled up by one swing (1790353497, +183 ms; +21 without it); its median error is 19 ms.

Leave-one-out picks the same takeaway setting every time; for the top it picks [0.1, 0.4] or
[0.2, 0.5] and 0.02 or 0.03 s, and the scores barely move between them, so the rule isn't balanced
on a knife edge. The regression test (`tests/test_fixtures.py`, `KeyPositionsTest`) holds each
model, angle and key position to its saved median and 90th percentile (`key-positions.json`) within
a frame (4.2 ms).

## The evidence, per key position

### Takeaway: the first shaft motion

Your takeaway label is the first frame the clubhead visibly moves. At that frame the tracked shaft
angle is still at its address value or one 2° step off, on all clips but one; it is 2° off about 25 ms
later and 4° off about 50 ms later. The old rule waited for the shaft to leave a 2° band, which is
why it was ~48 ms late on every clip. The first frame from which the shaft stays off its address
angle at all is 19 ms late (median). Tried and dropped: a threshold of 3° or more (54 ms and up),
and extending the shaft's early motion back to zero (21-32 ms, no better, and noisier).

It's about a frame and a half later than your eye because the shaft angle is measured in 2°
steps: the clubhead moves ~1.5 cm per degree, which you see before the tracker's angle changes.

### P3 and P5: the lead forearm, not shoulder to hands

At your P3 label, the line from the lead shoulder point to the lead wrist is 7-13° below level
(face-on) on every swing; it reaches level 35-50 ms later (median). The forearm (elbow to wrist) is level
right at your label: median error 8 ms (MediaPipe) and 12 ms (RTMPose), bias 0 and -9. The same at
P5: the forearm is level within 4 ms of your label on both models. The reason the shoulder line
reads steep: both models put the shoulder point at the top of the shoulder, above the joint the arm
swings from. An angle offset of ~10° on the shoulder line fits about as well, but it's a tuned
constant; the forearm needs none. (The upper arm, shoulder to elbow, is the worst: 27-85 ms.)

### P4: where the hands start down

For each swing, around your P4 label: the hands' height stays within 1-2% of body height of their
highest for 100-250 ms (a plateau), and down the line they only drop noticeably 75-150 ms after
your label. So:

| Candidate for your "top" (face-on) | RTMPose median / 90th (ms) | MediaPipe median / 90th |
|---|---|---|
| hands highest (wrists) | 42 / 58 | 8 / 137 |
| hands stop rising (old rule, wrists and fingers) | 33 / 97 | 87 / 104 |
| lead arm stops (its highest angle) | 46 / 75 | 46 / 133 |
| club changes direction (shaft angle turns back) | 50 / 158 | 25 / 87 |
| lead wrist slowest | 17 / 79 | 21 / 196 |
| **hands start down (new rule)** | **21 / 52** | **33 / 64** |

- **Where the hands stop rising**: the highest point can land anywhere on the plateau, and MediaPipe
  loses the hands behind the head at the top on several swings (its wrist height jumps 10-15% of
  body height), so it's the least stable on MediaPipe.
- **Where the lead arm stops**: no; it turns round 30-75 ms before your label on six of nine swings,
  20-55 ms after it on the rest.
- **Where the club changes direction**: the face-on shaft angle at the top is the tracker's least
  reliable (the shaft points at the camera), so this can't be told from the data either way.
- **Where the hands turn round (start down)** fits best and is steady on both models: the
  downswing's acceleration is measured on well-tracked hands moving fast, not on the plateau.

So the rule your labels imply, for most swings: **the top is where the hands (and club) stop going
back and the downswing starts**, the transition. Two swings are the exception (next section).

## Where labels and rules still disagree

### Labels that contradict each other (please look at these)

Face-on against down the line on the same swing, synced on your two impact labels (ms; + = the
down-the-line label is later):

| Swing | Takeaway | P3 | P4 | P5 |
|---|---|---|---|---|
| 1790278981 (7 iron) | **-40** | | | |
| 1790353476 (PW) | **+64** | **+21** | +13 | 0 |
| 1790353993 (driver) | **-57** | +17 | -12 | +4 |
| 1790353497 (PW) | -3 | **+30** | -16 | -17 |
| 1790271726 (7 iron) | +5 | -4 | **-25** | 0 |
| 1790271802 (7 iron) | +1 | +13 | **-37** | +4 |
| 1790271665 (7 iron) | -3 | -4 | +9 | -8 |

The same moment shouldn't differ by more than a frame or two between the angles. The bold ones are
worth relabeling: the takeaway on 1790278981, 1790353476 and 1790353993; P3 on 1790353476 and
1790353497; P4 on 1790271726 and 1790271802. A pattern: down the line, P3 is labeled 13-30 ms
later than face-on on four of seven swings (lead arm parallel is harder to judge from behind), and
P4 12-37 ms earlier on four of six.

### Labels that don't fit the rule

- **P4 on 1790279635 (7 iron) and 1790353993 (driver)**: your top is 50-58 ms before the hands start
  down (RTMPose), and these two have long labeled downswings (291 and 313 ms; 221-283 on the
  others, except 1790278981 at 321 ms, where the rule fits). Down the line on 1790353993 the hands arrive at the top right at your label and
  sit there ~120 ms before starting down. A pause at the top: you labeled the arrival, the rule
  finds the departure. If "top" should mean the arrival, say so: that rule ("the hands stop rising")
  works on RTMPose (about 25 ms median) but not on MediaPipe, which loses the hands at the top.
  1790271726 goes the other way (the rule is 50 ms early).
- **Takeaway on 1790353497 (PW)**: both of your labels (face-on and down the line agree) are 180 ms
  before the shaft angle changes at all. Either the clubhead really moves with the shaft keeping its
  angle (a one-piece takeaway: hands and club moving together), or both labels are early. Also 46-50
  ms late on 1790279635 and 1790354067.

### Not the rules: one swing's sync

On 1790353476, `pose.py` found the ball gone 50 ms after your impact label in the down-the-line
clip (face-on it agrees with your label), so the page's sync puts every down-the-line position of that swing
~50 ms off. That's most of the down-the-line P5 90th percentile (33 ms). Impact detection wasn't
touched here.

## Refreshing

After labeling more swings and refreshing the fixtures (`fixtures_export.py`):

    python tune_positions.py              # before/after, leave one swing out, and the tuning to use
    python tune_positions.py --baseline   # once the numbers are better: save them for the test

If the tuning it picks on all swings differs from `SwingPhases.TUNING`, put it there.
