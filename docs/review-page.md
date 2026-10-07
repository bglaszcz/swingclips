# The review page and the swing analysis

What the server works out for each swing and what each part of the review page shows: trust per number, good-shot ranges, what helps / hurts, focus, practice mode and games, Trends, Progress, Compare. (Moved out of HOME-SETUP.md, which has the session checklist, setup and troubleshooting.)

## `server/` - the home server (Python, FastAPI)
- `D:\SwingClips\clips` (videos), `pose` (pose per clip, gzipped JSON, and its quality record), `shots.jsonl` (launch
  monitor shots), `clubs.json` (clubs corrected on the review page), `swings.json` (each swing's
  numbers), `noise.json` (the noise floor per number, for the trust rules), `journal.json` (handicap and session notes), `excluded.json` (swings left out),
  `practice.json` and `practice-log.jsonl` (practice mode's target and what was spoken), `goodshots.json`
  (which shots count as good, for your personal ranges), `trash` (deleted clips; emptied by hand, never automatically).
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
  A P6 crossing only counts 30-100 ms before impact (otherwise it's put 55 ms before, marked ~): in
  the downswing the tracker can latch onto the arms and "cross" right after the top.
  P1 (address) is 0.1 s before the shaft starts moving back (the takeaway: the first frame the
  shaft turns away from its angle at address). P3 / P5 are where the lead forearm passes level,
  P4 where the hands start down; they follow your hand labels (`docs/key-positions.md`, and
  `tune_positions.py` to score them again after labeling more). This assumes a face-on camera (see
  "Two angles" in [phones.md](phones.md) for the down-the-line one). Newer clips carry the heard strike's exact time, which
  narrows the impact search to ±0.15 s around it.
- Swing numbers (`static/metrics.js`), on the video (Angles) and in a table at address / top /
  P6 / impact: pelvis and shoulder turn, X-factor, lead arm, shaft, spine tilt, forward bend, hip and
  shoulder tilt, head sway / rise, hip sway, and tempo. Turns come from how much narrower the hips
  and shoulders look than at address; MediaPipe's 3D estimate (saved per frame as `w`) is only used
  for forward bend and for scale. Overlays: hand path, head position vs address, and pelvis vs ball
  at impact (Show > Impact, face-on). On the P7 impact frame and frames within ±2 of it, the Impact
  overlay draws a dotted vertical line through the ball, a marker (filled circle) at the pelvis's middle,
  and a translucent shaded target zone band calibrated from the owner's best low-point swings
  (green = in target zone, amber = within 1 in, gray = not met, never red; no band until calibrated),
  plus a one-line position and goal sentence near the bottom ("Pelvis ... in ... of the ball at impact. Target: ...").
  Under the scrubber (when Impact is on, face-on), a small trace shows pelvis vs ball from P1 to P8 with
  a faint zero line for the ball and the target zone band, showing at a glance whether the pelvis moved forward
  and stayed or drifted back. The hand path is
  the wrists and index fingers weighted by MediaPipe's confidence, smoothed over ±45 ms (a local
  curve fit that leans on confident frames and drops one-frame glitches), and ends once a wrist is
  lost behind the head in the finish. Night pass (`Show > Night pass`): draws the skeleton from the
  night pass (`/api/night/pose/<clip>`, RTMW-l on the gaming PC) alongside the server's, matched by
  timestamp and drawn in dashed sky blue without angle labels; works during playback and in labeling mode.
  A kinematic
  sequence isn't attempted: from face-on alone the turn speeds come out in the wrong order (with
  both phones calibrated, the 3D panel has one: see [3d.md](3d.md)).
- **Find** (the box above the swing list; `static/find.js`): paste times ("4:25 PM", "Fri Sep 25
  4:25:49 PM"), dates ("Sep 25", "9/25") or clip numbers (the 10 digits in a clip's name, either
  angle's), several at once: the list shows just those swings and newer / older steps through them;
  one match opens it. `?find=...` in the address fills it, so a link can point at a set of swings.
- **Session trends** (Trends on a session in the list; `static/summary.js`): each swing's numbers
  (tempo, turns and sway at the top / impact, and the down-the-line ones: hips and bend at impact,
  hands to plane at P6 and the top, hand height and depth) against Square's (path, face, face to
  path, carry, offline, strike and so on). A scatter chart of any two, with the straight-line fit
  and r; a list ranking every number on the other side by how closely it goes with the chosen one;
  and a table of every swing. One club at a time by default. A link "stands out" when |r| is past
  what chance gives with that many swings (p < 0.05); fewer than 5 swings, nothing is ranked. When
  one club is picked (or the session has one club), a small **Good vs bad this session** block
  (`static/sessiondiff.js`) compares the session's good shots against misses using your personal baseline
  (`static/goodshots.js`): body numbers that separate them are listed with their difference in plain
  words (Hedges' g; with ~20 numbers tested, only those with a Benjamini-Hochberg q under 0.05, as
  the What helps card: without it about half of all sessions would list one by chance), with coaching
  drills and swing thoughts from `static/coach.js` folded underneath; when nothing clearly separates
  them, one quiet line says so. A **Compare best and worst** button opens the session's straightest
  good shot and the miss furthest outside the good-shot box side by side in Compare (`#compare=best,worst`). It updates as swings arrive.
- **Swing numbers on the server** (`swings.py`): once a swing's clips are analyzed, a background
  worker runs the page's own JavaScript (phases.js, metrics.js, summary.js, trust.js) in an embedded
  V8 (`mini-racer`) and keeps each swing's body numbers, what could be measured (ball found, down the
  line, P6 estimated, the camera check with the impact item) and where the golfer stood in each
  picture, in `swings.json` (`/api/swings`); plus, for the noise table only, every number at P1, P4,
  P6 and P7 and each camera's noise floor at address (not sent to the page). The records carry a fingerprint of that JavaScript: after an update that
  changes it, every swing is worked out again (~0.2 s each). Right-handed only, for now.
- **Progress, steps 1-3: every club at once** (`static/sessionscore.js`, 2026-10-07). No club to pick
  up top; the period and Leave out shaky stay.
  **1. Did <latest> go better than <last>?** One sentence on good shots (your good-shot rules, per
  club), then four tiles, each against the last session and the usual (median of up to 6 earlier):
  **Good shots**, **On line** (within the club's offline allowance), **Solid strikes** (smash at or
  above your median with that club), **Distance** (median carry as % of each club's usual). Every
  shot is taken against its own club's usual, so a wedge session and a long-iron one compare. "Last
  time" is the latest earlier session with 15+ judged shots (a 9-swing warm-up isn't it). "Better" /
  "worse" (coloured) only when a two-proportion test says it's unlikely to be luck (z 1.64); a gap of
  5+ points otherwise reads "a little better / worse". Then the session's most common fault with its
  swing thought.
  **2. What should I work on?** One thing: the focus if there is one; else the #1 move from what
  helps / what hurts worked out over every club (each session split by club, so each swing is against
  its own session-and-club usual), ranked by what matters to an everyday golfer (distance offline 1,
  smash 0.9, carry 0.8, path 0.8, curve 0.7, ball speed and face 0.6, strike 0.4-0.5, times |r|, half
  for "worth trying"; attack angle and loft left out, their target depends on the club). A second
  move only when it scores 70% of the first; with a focus, one line when the numbers now point
  elsewhere. A focus made here has no club (all clubs); older one-club focuses still work.
  **3. Is it working?** The chart pools every club (only numbers that mean the same with any club:
  body numbers, path, face, face to path); a one-club focus charts its own club.
  Body numbers are named in plain words everywhere in Trends and Progress (`SwingShotStory.LABELS`).
  **One club at a time** (the club picker): that club's last session tiles, shot pattern, sessions
  table and good shots, as before.
- **Progress** (button at the top): all sessions with one club over time. Tiles compare the latest
  session with the ones before it (median, or spread for consistency numbers), saying "better" /
  "worse" only when the change is bigger than the usual session-to-session difference; a chart of
  any number per session (swings, median, middle half); the shot pattern (carry vs offline, with
  a ring holding about two shots in three); the handicap index; and each session with a note
  (`journal.json`). When a phone is moved (the golfer's place in its picture shifts by 0.02
  picture heights or size by 6%; within a session it varies ~0.004 and ~2%), the chart marks
  "camera moved" and the tiles only compare that camera's numbers since then.
  A **Gapping** card maps your bag in the chosen period: each club's median carry and middle-50%
  spread, and the gaps between neighbouring clubs (flagging overlaps under 7 yd and big gaps over 20 yd).
  A **Wedge matrix** card shows each wedge's median carry with a half, 3/4 and full swing, sized by club
  speed against that wedge's full-swing speed (the 90th percentile of its club speeds): full 92%+, 3/4 80-92%,
  half 65-80%; and the biggest carry hole between them (`static/wedges.js`).
  The page reads top to bottom as three steps (how did the last session go, what to work on, is it
  working: the chart opens on the focus move; inside step 3, a short Drill sets block appears when
  drill sets exist, showing the latest set's pumps, drill swings' P6, and normal swings before (or "your usual": the last 15 same-club swings of earlier sessions, when the session starts with the drill) and
  after with a verdict on whether the rehearsal carried over against wobble, with older sets folded
  and tapping any set opening its first drill swing); step 1 also highlights the session's top faults under
  the headline sentence, along with any strong links between them (e.g. casting and early extension)
  tested within clubs using Cochran-Mantel-Haenszel odds ratios and Benjamini-Hochberg correction (`static/faultlinks.js`);
  shot pattern, sessions, good-shot rules, gapping,
  the wedge matrix and handicap are folded cards underneath.
- **Compare** (Compare… or C on a swing; `static/compare.js`): this swing against another one,
  usually one of your own better ones. The picker lists every other swing with its date, club and
  Square numbers, filtered to this club and the last 90 days by default, sorted by carry (or ball
  speed, club speed, smash, straightest, newest). A ✓ marks good shots (the rules in Progress);
  **Good shots only** keeps to them, and the period **Before my focus** (there while a focus is set)
  keeps to swings from before the day it started, to see what the focus has changed. The two then play side by side, one row per
  camera angle both have. **Key positions** (default) lines them up by P1-P8, stretching the time
  between each pair in a straight line, so the reference plays faster or slower between them;
  **Real time** lines them up at impact only, both at real speed, so tempo differences show.
  Play, scrub, frame steps (← →) and P1-P8 (keys 1-8) move both. **Ghost** (G) draws the
  reference's skeleton, dashed, over this swing's video, lined up at address by the feet and hips
  and scaled by body height. **Key positions** under the videos: both swings' scorecard tiles, a
  column per P1-P8 (this swing over the reference), each coloured against your good shots with this
  swing's club as on the swing page. Tapping a column (or keys 1-8) puts both swings there and
  shows that position's numbers for both, each on a bar against the middle 50% of your good shots
  (dark mark this swing, pink the reference) with the difference; then each swing's named faults.
  Below: tempo, the body numbers at address / top / P6 / impact for both
  swings and the difference, and Square's numbers side by side; numbers from a camera that couldn't
  see all of a swing (the camera check) are greyed out. The address bar holds
  `#compare=<clip>,<clip>`, so a comparison can be bookmarked or sent. Swap puts the reference
  on the left; Esc closes it. Body numbers from different sessions only compare if the phones
  stood in the same places.
- **Leave out**: a swing that isn't yours (a friend hitting while the phones listen) is left out of
  Trends and Progress with the swing's Leave out button (`excluded.json`).
- **Wrong club?** When the club wasn't changed in Square's app, pick the right one on the swing's
  Club tile, or use "Change club…" in Trends for all the swings shown. The correction is kept per
  swing in `clubs.json` (Square's own club stays in `shots.jsonl` and shows as "(Square)" in the
  list); picking Square's club again removes it.
- Pose files are named by version (`<clip>.v6.json.gz`); when `pose.py` changes enough to bump
  `VERSION`, every clip is analyzed again on its own.
- Shots pair with clips by time: each source has a typical strike-to-report delay (Square's app
  ~13 s from the clip's name time, 6-17 s seen, wedges quickest, driver slowest; GSPro connector ~1 s);
  each match records its gap. A clip only one phone recorded counts 3 s further off (`LONE_PENALTY_S`),
  so a sound one phone heard just after a swing doesn't take the swing's shot. `GET /api/events`
  (`since`, `kind`, `limit`) reads the events log from another PC.
- Night worker report: **Tools > Night report** (`static/nightreport-view.js`, `static/nightreport.js`):
  the gaming PC's nightly improve run. Shows the newest candidate model's score comparisons on validation
  swings (Before, After, Change table; green = better, amber = worse, muted = within noise, never red),
  worker progress from `/api/night`, folded earlier candidates, and past night lines. Tapping **Use it**
  (or **Go back to this one**) promotes the model via `POST /api/improve/<id>/use` to re-analyze clips over
  idle hours.
- Club check: **Tools > Club check** (`static/clubcheck.js`):
  rapidly checks and confirms or adjusts club points (grip end, hosel, clubhead) on high-value frames to feed the nightly club model retraining. Presents a balanced queue of frames (5 per swing, up to 40) from swings without club points, prioritizing swings with no backswing club points yet. Each swing includes 2 backswing frames between takeaway and P3 (one within ±0.03 s of P2) to give nightly retraining the backswing frames that P2 horizontal-shaft detection depends on, 2 downswing frames between P4 and P8 (preferring missing or low-confidence clubhead detections), and address. Displays upright stills with markers for grip, hosel, and head connected by a shaft line, accompanied by a 3.5× magnified zoom inset around the selected point for precision adjustment on mobile or desktop. Keyboard shortcuts and touch controls enable one-tap confirmation (Enter / Space), point cycling and dragging (1, 2, 3), streak blurring (B), marking can't see (X), or marking no club in picture (0). Saves directly to `/api/labels/<clip>?pass=1` without altering body landmarks or events.
- P4 check: **Tools > P4 check** (`static/p4check.js`):
  provides a quick, unbiased way to add hand labels for P4 (the top of the backswing) to decide whether the night pass's larger body model should set P4. Samples 2 of every 3 swings at random (seeded daily for stability) and 1 of 3 from swings where server and night P4 disagree (|ms| >= 12.5), spread across clubs and days, skipping swings with existing hand labels. Presents a single raw frame still (no skeleton or P4 marker from either model) and a ~60 px direction strip underneath (since Oct 6, the owner's ask: where the clubhead stops going back and changes direction): one bar per frame over the window (0.15 s before to 0.10 s after server P4, starting at the window's start), blue while the clubhead goes back, amber coming down, taller = faster, from the clubhead's angle round the shoulders' middle (`direction()`); a dashed line marks the turn (the last frame going back before 4 frames coming down) and **Go to the turn** (T) jumps there; a white line marks the current frame. On the 28 P4-check labels the turn sat a median 8 ms (2 frames) from the label, bias -3 ms, where the server's P4 was 17 ms off and 14 ms late. It shows an answer, so labels made with it lean toward it. Keyboard and touch controls offer 1-frame (`←`/`→`) and 4-frame (`Shift+←/→`) stepping with prefetching, marking the top ("This is the top", Enter), skipping ("Skip", S), and marking "Can't tell" (C, remembered for the day). Saves single-moment label docs (`quick: {p4: "p4check"}`) to `/api/labels/<clip>?pass=1` without nagging for other key positions or the other camera angle.
- Labels view and frame picker: **Tools > Labels** (`static/labelview.js`, `static/framepick.js`):
  tracks hand labels across clips and key positions. The **Where the two analyses disagree** card lists
  unlabeled positions where the server and night pass disagree by 2+ frames, sorted worst first, alongside
  a progress line (`N picked so far · M left`). Tapping **Compare** opens a side-by-side picker panel
  showing Server, Night pass, and takeaway onset stills with pose skeleton overlays (solid for server,
  dashed sky-blue for night pass). Single-frame stepping (`‹`/`›` or `[`/`]`), one-tap picking ("This one"
  or keys `1`-`4`), custom adjustment ("Neither, label it myself" / `N`), and skipping (`S`) let you resolve
  disagreements rapidly. One-tap saving writes to `POST /api/labels/<clip>?pass=1` with source attribution
  (`picked[event] = "server" | "night" | "onset" | "adjusted"`), prompts before overwriting any existing
  hand labels, automatically advances to the next disagreement, and drops only the resolved position.
- Deploy: **Tools > Update the server** (`static/update.js`, `update.py`): `GET /api/update` fetches
  and lists the new commits and whether a restart is needed; `POST /api/update` does
  `git pull --ff-only` and, when the change needs it, the server exits with code 3, which
  `Start server.cmd` takes as "run again" (pip first, for new requirements). Needs a restart: anything
  in `server/` except the review page's own files and the tests; the page files the server also runs
  (`swings.JS_FILES`, `metrics3d.js`, `games.js`) count as server code. A change to
  `Start server.cmd` needs a restart by hand (cmd reads a running batch file from disk).
  `POST /api/restart` restarts without updating. By hand: `git -C D:\SwingClips\app pull`, then
- Week for coach: **Tools > Week for coach** (`static/week-view.js`, `static/week.js`):
  provides a concise weekly summary designed for the owner to share with their coach in under two minutes. Covers sessions practiced (days, duration, swings by club, drills, and coach program runs), ball flight changes for clubs hit 15+ times where change exceeds weekly noise, progress on the journal focus move vs past weeks alongside coach thoughts, top 3 named faults vs the prior week, findings that held up in subsequent sessions (`holdup.js`), game scores vs all-time bests, and journal notes. Features a week picker (`‹`/`›`) starting on this week, phone-friendly calm card styling without red highlights, and a one-tap **Copy for coach** button that formats the report as plain text ready to paste directly into a coaching chat. Below the summary, the week's coach program runs, each folded with its full report (`/api/program/report`) and its own **Copy this run for coach**, so a run hit at the sim can be read and sent from the house. Openable via `/#week`. A "with the program runs" checkbox next to Copy for coach includes the week's full program run reports directly in the copied text, separated by run headers, and remembers its setting across visits.
- Lead wrist check: **Tools > Wrist check** (`static/wristcheck.js`):
  provides a fast pass over a session's coach program shots to judge the golfer's lead wrist at impact by eye (flat, slightly bowed, cupped, or can't tell), on the down-the-line or the face-on camera (a switch, remembered; the back of the lead hand is often clearer face-on). Each card shows a strip of 4 frames (-8, -4 ms, impact, +4 ms: one 240 fps frame is often a blur), each cropped and enlarged round the hands. "Can't tell" is an answer, not a call: the coach report counts it apart ("10 of 12 shots called; can't tell on 2"). There is no computed wrist number: on 165 7 irons (Oct 7) neither the camera's hands-ahead (r -0.01) nor the club model's shaft angle at impact (r +0.06) predicted Square's dynamic loft. The app crops (using pose landmark 15 lead wrist from `/api/pose/<clip>` when available, or the middle 60% of the frame). One card per ball shot in order with shot number, block, and verdict, four judgment buttons with keyboard shortcuts (keys 1-4) that highlight and auto-advance to the next shot, run picker defaulting to the newest finished run, and a header count ("12 shots · 7 called") with a link to Week for coach. Calls are saved via `POST /api/program/wrist` and included in the coach report (`/api/program/report`). Openable via `/#wristcheck`.

## Trust per number: ok, shaky, no reading
Every body number on the page (the swing numbers table and tempo line, the numbers over the video,
Compare, Trends, Progress, and practice mode) is judged by one rule set (`static/trust.js`; the
server runs the same file), so they all agree:
- **ok**: shown as it is.
- **Shaky**, greyed with a small **~** (hover for why): the key position it's read at was estimated
  (P6); the ball wasn't seen leaving, or left too far from the heard strike, so the key positions
  from the top on (P5-P7, tempo and downswing time) hang on a doubtful impact; the camera's light
  check says **dark**, or **flicker** that matters (a fixed shutter); the noise floor says it moves
  more while you stand still at address than half its usual swing-to-swing spread in a session;
  or it's noisy by definition (head rise, and the plane numbers: hands and shaft to plane).
- **No reading**, shown as **--** (hover for why): the camera check says part of you was out of
  the picture (`out`) or your hands left it at the top (`hands`), or there's no number.
- **The noise floor per number** comes from recent swings (the last 300): how much each number moves
  in the 0.35-0.05 s before the takeaway (the same spread as the scorecard's noise floor, kept per
  swing in `swings.json`), against its standard deviation within a session (a 45-minute gap starts
  a new one), one club at a time, in sessions of at least 5 swings and 10 swings over them. The
  server works it out whenever swings are analyzed (and every 10 minutes) and keeps it in
  `noise.json` next to the clips folder (`/api/noise`); the page doesn't recompute it. A number
  that's the same on every swing by definition (a turn at address) isn't judged.
- **Trends and Progress** leave out numbers with no reading everywhere (charts, the "what goes
  with" ranking, session medians). Shaky ones are hollow dots in the scatter and over-time charts
  and greyed in the tables; **Leave out shaky** (Trends and Progress, one setting) takes them out of
  the charts and correlations too. A Progress tile is greyed when most of the latest session's
  swings behind it are shaky.
- **Practice mode** speaks a number unless it has no reading, or was read at an estimated P6 (as
  before); the other shaky ones are still spoken.

## Personal ranges from my good shots
Instead of tour averages, each body number is shown against where it falls on **your own good
shots with that club** (`static/goodshots.js`; the rules are kept on the server).

- **What counts as a good shot**, per club, from Square's numbers (edit them in Progress, **What
  counts as a good shot**; saved in `goodshots.json` next to the clips folder, `GET` / `POST
  /api/goodshots`, **Back to the defaults** undoes your changes):
  - irons and wedges: offline within **5%** of carry; smash at or above **your median** with the
    club (a tolerance can be set, 0 by default); carry within your usual band, **10% short** to
    **12% long** of your median carry (no chunks, no thins or flyers);
  - woods, hybrids and driver: the same, offline within **6%** of carry;
  - strike (on by default): within **20 mm** heel/toe and **20 mm** high/low of your usual spot on
    the face (the median of Square's face-impact numbers with the club). Square reports where on the
    face, not a strike-quality score, and its high/low numbers aren't centered on 0 (your 7-iron
    median is about -10 mm), so it's measured from your own usual spot.
  "Your median" is over the club's latest 200 shots, good or not, and only once there are 5 of them;
  before that no shot with the club counts as good. A rule Square gives no number for (the driver
  often has no smash or strike) is skipped for that shot rather than held against it. Swings left
  out of the trends (`excluded.json`) don't count anywhere; nor does the putter.
- **The ranges**: for each body number and club, the middle 50% and 80% of the good shots, and
  how many shots they're from. A number with **no reading** under the trust rules (a camera that
  couldn't see all of you, or no number) is left out of its range. Below **8** good shots with a
  reading (settable) there is no range, only "not enough good shots yet (5 of 8)". When most of the
  numbers behind a range are **shaky** (trust rules: head rise and the plane numbers always are),
  it's marked **range not reliable**, with why.
- **Swing page, the coaching card** (`static/shotstory.js`), right under the videos: a verdict
  (**Good shot** = passes your good-shot rules with that club; **Playable** = within twice the
  offline allowance and no more than 15% short of your usual carry; **Miss**) and three lines in
  plain words, no P-numbers. **What happened**: the shot shape from Square's numbers (start line
  from the ball's direction, or the face; curve from the ball's spin axis, which matched the way
  the owner's 501 shots curved every time, or face to path; a pull that curves back near the
  target is a pull-fade, a slice only when it finishes past 5% of carry right), plus how far off
  line, short or off the centre of the face. **Why**: the swing's worst fault (scorecard severity,
  never from a shaky number); else on a good shot what matched your good shots (hands leading at
  impact first); else contact (off-centre, still on line) or the club's path and face ("out-to-in,
  the face pointed left of the target but open to the path"). **Try this**: the fault's swing
  thought and drill (coach.js); with no fault and an off-line out-to-in miss, the hands-drop-under-
  the-plane fix; never a move toward a fault, so no drill for an in-to-out miss.
- **Habit watch** (`static/habits.js`): a calm amber banner (`.cc-habit`, never red) at the top of the
  coaching card when a bad habit is forming during a session across your last 5 swings with that club.
  It watches body numbers that have a fault in `faults.js`: flagged when at least 4 of the last 5 swings
  have a readable number (neither missing nor shaky), its Theil-Sen slope over those swings points toward
  the fault side, at least 3 readable ones violate the fault's threshold, and the latest swing is past it.
  Ranked by how far the latest swing is past the threshold in units of the threshold's scale. Warns in plain
  English (e.g. "Watch out: your last 5 swings with the 7 iron are trending toward early extension (hips toward
  the ball at impact): 2.1 in -> 4.0 in.") with a swing thought and drill from `coach.js`.
- **Verdict dots on the swing list**: a small dot before the time on each swing row that has a launch monitor
  shot: green = good shot (passes your club rules in Progress), amber = playable (within twice the offline allowance
  and not more than 15% short of your usual carry), grey = miss (never red), from `SwingShotStory.verdict` with
  `goodShotData()`. Hovering shows "Good shot", "Playable" or "Miss".
- **Advanced data** (button under Square's numbers, remembered per browser): off by default.
  Without it the swing page shows the coaching card and five tiles (club, carry, offline, club
  speed, smash); with it, Square's other numbers, the scorecard, key positions, the swing numbers
  table, 3D and the clip names (`adv-only` class in `index.html`). Advanced data uses plain golfer's words
  everywhere instead of P-system jargon: scorecard phase tiles and table columns read "Setup", "Top of
  swing", "Downswing", "Impact", with P-tags kept only as small secondary hints or tooltips. Metric labels,
  the scorecard summary sentence, row labels and fault locations ("in the downswing", "at impact")
  use plain English from `SwingShotStory`.
- **Swing page**: a column **vs my good shots (club)** in the numbers table, and a faint band on the
  number itself: green inside the middle 50%, amber outside ("outside: 4° more than usual", and
  "inside the 80% range" when it's between the two). The tempo line gets the same under it. Numbers
  with no reading get no band. Named swing faults (early extension, standing up, etc.) appear in a line
  above the numbers with each fault's swing thought as its tooltip, only when present; the scorecard's
  fault list also shows a short "often comes with X" when that link is strong and the other fault is also
  on the swing.
  Casting comes from two face-on numbers (`metrics.js`): **Wrist hinge at P5**, the angle between the
  lead arm and the shaft (90 = an L) with the lead arm parallel coming down, and **Release point**,
  the lead arm's angle to horizontal when that hinge first drops under 70 degrees coming down (higher
  = an earlier release). Named casting when the release point is above -22 degrees.
  **Hands ahead of ball at impact** (face-on, `handsBall` in `metrics.js`, inches, + toward the target):
  the wrists' middle against where the ball sat, at P7. On 289 of the owner's swings (Sep 23 - Oct 1
  2026) more of it went with a steeper attack angle within each club (about 0.7 degrees per inch,
  r -0.42, the same way on 8 of 10 clubs; ball position held constant), but not with dynamic loft.
  Oct 1 (the low point drill day) read +2.0 in on 7 irons against about +0.6 before. Copy for coach
  reports its median per block. Shaft lean at impact was tried and isn't measured: at 240 fps the shaft
  turns ~8 degrees a frame near impact and is often a blur, and it showed no link to dynamic loft.
  **Lead hip at P6** and **Trail hip at top** (face-on, `leadHip` / `trailHip` in `metrics.js`, inches,
  + toward the target): the outside of each hip against its line at address. The edge is where
  MediaPipe's person outline ends beside the hip joint, over the belt-to-pocket rows (`pose.hip_edges`,
  saved per frame as `hip` when the server is idle). The lead hip should have moved toward the target by
  P6. On 41 labeled swings (Sep 2026): lead hip +2.0 to +4.7 in at P6 (median ~3.6), trail hip -0.3 to
  -2.1 at the top. No fault is named from them yet (no threshold from the owner's data).
  **Pelvis vs ball at impact** and **Chest vs ball at impact** (face-on, `pelvisBall` / `chestBall` in
  `metrics.js`, inches, + = ahead of the ball, toward the target): the hip joints' and the shoulders'
  middle against where the ball sat, at P7 (the coach's "pelvis shift" check; its change from address is
  Hip sway). From the camera, not the 3D: on the Oct 2 2026 3D swings the 3D stance came out ~1.35x too
  wide and the ball at the lead ankle (camera: mid-stance), so its `pelvisBallImpact` /
  `thoraxBallImpact` (metrics3d.js) are kept for comparison only. The target zone is to come from the
  owner's best low-point swings, not a book number. The ranges come
  from the trends' data (`/api/swings`), loaded when the first swing is opened and again when it's over a
  minute old.
- **Compare**: a **My good shots** table with each number's middle 50% and 80% for the open swing's
  club, and where this swing and the reference sit against them.
- **Progress**, **What sets my good shots apart** (for the club picked there): how many shots were
  good, and the most common reasons the others weren't; the body numbers that differ most between
  good shots and the rest, as the difference in means and the effect size (Hedges' g, bias-corrected,
  in standard deviations) with its 95% confidence interval, largest first ("clear" when the interval
  leaves out 0, "could be chance" otherwise). It needs 8 swings on each side (the same minimum as a
  range) and says "Not enough swings yet" until then. It describes your shots and says nothing about
  causes: a number can go with good shots because of something else, and with 20 numbers about one
  in twenty looks clear by chance. Below it, the ranges table, and the rules.
- **Practice mode**: **Use my good-shot range** (next to **Use middle half**) sets the range to the
  middle 50% of your good shots for the number, and the club to the one they're from (the club
  picked, if it has enough of them, else your most-hit club that does). Body numbers only: Square's
  numbers are what decide which shots are good.
- Tests: `node --test tests/goodshots.test.js` (synthetic swings: the rules, the ranges, the minimum
  count, the trust gating, the effect sizes) and `python -m unittest tests.test_goodshots` (the
  settings and endpoint, and the rules on your real shots in `tests/fixtures/real/clips.json` with
  their body numbers worked out from the pose files: 4 of the 7 seven-iron shots are good, too few
  for a range). Not tested on your live data: the real clips aren't reachable from the tests, so how
  many good shots each club gets, and whether the default rules are too strict or too loose, only
  shows on the server. The swing page, Compare and practice button were checked in a browser with
  synthetic swings, not real videos.

## What helps, what hurts
On **Progress**, below the good shots, for the club and period picked there (`static/helps.js`,
drawn by `renderHelps` in `trends.js`):
- Every body move (the 20 numbers) against every result: Square's numbers, plus distance offline
  and face to path either way (curve), where smaller is better. **Within sessions**: each swing's
  move and result are taken against that session's own mean, so warm-up, tiredness and where the
  cameras stood cancel out; the deviations are pooled over the sessions into one slope and a
  correlation, tested with a t test on n - sessions - 1 degrees of freedom. A session needs 3 swings
  with both numbers to take part, a link 15 pooled swings.
- The p values get a **Benjamini-Hochberg** correction over every link tested with the club (q, the
  false discovery rate). **Confirmed**: q < 0.05 and the same direction in at least 3 sessions, and
  3 in 4 of the sessions with 8+ swings. **Emerging**: q < 0.2 and not the other way in most
  sessions. The rest could be chance and isn't listed (the status line says how many were tested).
- Each link in words, per a round step near the move's usual swing-to-swing spread: "Each 1 in more
  hands to plane at P6 than your usual that day: club path 1.4° more out-to-in", with **Helps** /
  **Hurts** where the result has a better way (carry, smash, ball speed up; offline and curve
  down). **Between sessions** (from 5 sessions with 8+ swings): the session means' correlation; it
  doesn't count toward the label, since body numbers either side of a camera move don't compare.
  Tapping a link opens the latest session's Trends on that move and result.
- "Leave out shaky" applies; a link is greyed ~ when most of its move's numbers are shaky.
- **Coaching** (`static/coach.js`): each link in golf terms ("Hands higher and further out at P6 (over
  the top) → a more out-to-in path (pulls, fades, slices)"), and which way to take the move: for
  carry, smash, ball speed and distance offline the way that helps; for path, face, face to path,
  offline, strike and attack angle (irons -4°, woods 0°, driver +2°) the way that brings your usual
  number (the median) toward neutral, or nothing when it's already close (the link then only
  explains your spread). Each move has a golf name, what it means in the swing, a drill and a swing
  thought, both ways. Faults are never offered as a fix even when the numbers point that way (over
  the top, early extension, the head diving, standing up): the link then says so. On top, a
  **practice plan**: up to 3 moves to work on, each once with the results it goes with; a move that
  helps one result one way and another the other way is a trade-off, not a drill. General
  instruction for a right-hander: a coach watching the swing trumps it. Tests:
  `node --test tests/coach.test.js`.
- **Checked forward in time** (`static/holdup.js`, `SwingHoldUp.replay`): re-runs the finding search session by session from `minSessions` (3) up to the second-to-last session. For any link first labeled emerging or confirmed at session $k$, the sessions after $k$ alone are tested with `SwingHelps.link` (one-sided $p = p/2$ in the found direction). A verdict is assigned: **held up later** ($p < 0.05$ same sign), **reversed later** ($p < 0.05$ opposite sign), **not clear later** ($\ge 15$ later swings, but neither: with few sessions since, often too little to say rather than gone), or **too early to tell** ($< 15$ later swings). Each listed link shows a small muted tag with its forward verdict (none if only found in the latest session). A folded summary at the bottom of the card reports: "Checked forward: of $N$ findings, $H$ held up in later sessions, $F$ not clear since, $R$ reversed, $E$ too early to tell", with a line for each finding (move → result, when found, what the later sessions show) inside. Tests: `node --test tests/holdup.test.js`.

## My focus
On **Progress**, first card (`static/focus.js`, drawn by `renderFocus` in `trends.js`):
- **Make this my focus** on a practice-plan move saves it in the journal (`journal.json` `focus`:
  move, which way, club, the results it's for, the day it started; `POST /api/journal/focus`, with
  `{"move": null}` to end it; the one before goes to `focuses` with the day it ended).
- The card: what to work on, the drill and the swing thought, then for the move and each result:
  the median of the session medians before (the latest 6 sessions with the club) and since, the
  change, and a verdict against the session-to-session wobble (the larger of the spread of the
  session medians before, with 3+ sessions of 3+ swings, and what the swing counts alone allow):
  "clearly" at 2 wobbles or more, "maybe" from 1.5, else "no change yet". Which way is right: the
  move's aim; a result's better way or toward its target (path, face, curve toward 0; attack toward
  the club's). With no real change, 200 simulated tries said "maybe" 12% of the time and "clearly"
  4%. A camera the move is measured from moving since is flagged.
- **Practice this**: practice mode on the move with the club, in range = better than your usual
  (from the median of your latest 30 swings with it toward the aim), and the swing thought as a
  **cue** the phone says after a swing out of range ("Hands at P6 2.4, too far over. Hands drop to
  the trail pocket."). The cue shows in the practice panel and is dropped when you pick another
  number there.
- Tests: `node --test tests/focus.test.js`, `python -m unittest tests.test_practice` (the cue, the
  focus endpoint).
- First look on the live data (2026-09-27, 50 seven-iron swings in 4 sessions): 5 emerging, none
  confirmed, all about the same pattern: hands further out at P6 and losing forward bend at impact
  going with a more out-to-in path and more face open to the path. It takes 5-10 sessions of 20+
  swings with one club before anything can be confirmed.
- Tests: `node --test tests/helps.test.js` (the t test and q values, a link found within sessions
  when the day-to-day offsets point the other way, noise giving nothing confirmed, too few sessions,
  split sessions, helps/hurts, missing and shaky numbers).

## Practice mode: the phone says the number (capture app 0.5)
Pick one thing to work on and a range; after each swing the phone says the number and whether it
was in range: "Tempo 3.2, in range", "Club path minus 4, too far left", "Early extension 2, too far
toward the ball". The phones face away from you, so voice is the channel.
- **Practice my #1 priority** (first card, 2026-10-07): the focus, else Progress's first move over every
  club (`topPriority()` in `trends.js`), with its swing thought and drill and one button, **Start practicing
  this**: the number, the range ("better than my usual" from the median of the latest 30 swings, as the
  focus's Practice this), every club (or the focus's club) and the swing thought as the cue after a swing
  out of range. A move the phone can't speak swing by swing says so. Games come next; the number picker is
  folded under **Pick a number yourself**. Spoken and shown names are plain: "Hands coming down 2.4, too
  far over" (was "Hands at P6").
- **The videos** draw the skeleton, shaft and plane line; the angle readouts are Advanced data (the
  Angles button shows with it). The scrubber names Setup, Top, Impact and Finish; the other positions are
  ticks named on hover. The **habit banner** only fires when the first readable swing of the five was
  clean (a fault creeping in); Oct 7: 7 banners in 63 swings (was 15).

- **Setting it up** (review page, **Practice** at the top): pick the number, the club, and the
  range. **Use middle half** sets the range to the middle 50% of your last 30 swings with that club
  (it fills in by itself when you pick a number; edit it to taste, e.g. narrower to push a change).
  **Use my good-shot range** sets it to the middle 50% of your good shots instead, and the club with
  it (see Personal ranges above).
  **Start practice** saves it on the server (`practice.json`); only swings struck after that are
  spoken. Changing the number or range while on (**Save range**) starts over from the next swing.
  **Stop practice**: nothing is spoken. **Say "3 in a row"** adds the streak to an in-range swing
  from the third one on ("Tempo 3.1, in range, 3 in a row"); a "no reading" doesn't break it, an
  out-of-range swing, a new range or a new session does.
- **What can be practiced**: body numbers (tempo, backswing and downswing time, head and hip sway,
  head rise, spine tilt at impact; down the line: early extension, bend vs address, head to ball,
  hands and shaft to plane, hand height and depth at the top) and Square's (club path, face to path,
  face, attack angle, carry, offline, smash, club and ball speed, launch). Face-on turns (shoulder,
  pelvis, X-factor) aren't offered: from one camera they're estimated from how narrow the body
  looks, not good enough to judge one swing by. Marked **(noisy)** in the list, with why: head rise
  (close to the tracking noise), hands to plane at P6 and at the top and shaft to plane at P6 (they
  need the shaft seen at address, and P6 is often estimated). They work, but judge them over
  several swings, not one.
- **Only numbers that can be trusted are spoken** (the trust rules above, `static/trust.js`, which
  the server runs). A body number from a camera whose camera check says you were partly out of the
  picture or your hands left it at the top (`quality.camera`: `out`, `hands`), a P6 number where P6
  was only estimated, or a number that couldn't be measured is **"no reading"** instead. Square's
  numbers don't depend on the cameras.
- **When it speaks**: body numbers once the swing is analyzed (the upload settles for 15 s, then
  pose and the numbers: usually 30-60 s after the strike; given up after 4 minutes as "no
  reading"). A down-the-line number waits up to 90 s for the down-the-line clip if it hasn't come
  in. Square's numbers once the shot pairs, about 15 s after the strike; with no shot by 25 s it
  says "Club path, no shot". Each swing is spoken once, even if its face-on clip arrives after the
  down-the-line one.
- **Which phone speaks**: a setting on each phone, **Practice voice: on / off**. Until changed by
  hand, the face-on phone speaks and the down-the-line one doesn't (it follows the angle setting).
  It stays usable while recording, and changes nothing about recording. **Voice check** on the phone
  says a sample sentence and shows the media volume (what speech uses), with a warning when it's
  muted or below half. **Voice check** on the review page makes the speaking phone say "Practice
  voice check", which tests the whole path: the server, the Wi-Fi, the phone, its volume. The
  panel's top line says which phone is listening.
- **How it gets to the phone**: the server makes each sentence (`practice.py`, a worker checking
  the new swings every second while practice is on) and keeps it in `practice-log.jsonl`. The
  phone asks `GET /api/practice/latest?since=<id>&angle=face&wait=20`; the server holds the request
  until there's a result or 20 s pass (a long poll), so results come within about a quarter of a
  second. The first request (no `since`) only returns the latest id, so a phone that starts
  listening doesn't read out old swings. Ids are the server's milliseconds, so they survive a
  server restart. After a Wi-Fi drop the phone retries (1, 2, 4, 8, then every 10 s) and skips
  results older than 45 s: by then you've hit again.
- **The log** (bottom of the panel): per session, each spoken swing (time, number, in range / out /
  no reading, and why) and the share in range for each range used ("Tempo 2.8 to 3.4: 14 of 20 in
  range (70%), 2 no reading"). No readings don't count toward the share. Tap a row to open the swing.
- Endpoints: `GET /api/practice` (target, the list of numbers, the log, which phones listened),
  `POST /api/practice` (`{on, metric, min, max, club, streak}`), `POST /api/practice/test`,
  `GET /api/practice/latest`, `GET /api/game` (game in play, state, finished games),
  `POST /api/game` (`{game, options}`), `POST /api/game/stop`.
- **Practice games** (Games card at the top of Practice): pick Combine, Wedge ladder, Random pick, Ladder,
  Driving, Shot shaping, Distance control or Hole builder and press Start game. The speaking phone says the target; once Square's shot pairs
  (~15 s) it says where the ball landed ("8 short, 3 right, on the green") and the next target. A swing whose
  shot never comes is skipped (same target again); a Square mishit scores the worst. Scoring is strokes against
  a tour baseline from where the ball lands (no roll into a net; within 15 yd counts as the green); Driving
  scores 14 tee shots against a 30-yard fairway par-4 baseline, Shot shaping scores 12 called draws and
  fades by spin axis, Distance control tests 15 random carries (50-130 yd) scored on carry alone against a 5-yard window, and Hole builder plays 6 par 4s (340 to 440 yd) where a tee shot at the fairway determines your approach yardage. Targets and scoring are `static/games.js`, the game in play `game.json` and finished
  games `games-log.jsonl` next to the clips folder (`server/games.py`). Starting a game turns the practice number
  off, and turning that on stops the game. The Combine is always the same 27 shots (9 targets, 50-170 yd,
  shuffled), so its score is comparable across weeks. Under the Combine scores table, "Where you lose strokes" breaks down strokes gained by target distance over the last 3 Combines to pinpoint the weakest yardages. The Past games table lets you pick any game to view past sessions with that game's own hit wording (on the green, in the fairway, shaped as called, or within 5 yards). No phone update needed.
- **Coach program** (`programs.py`, `programs.json`, `/api/program*`, Start page "Coach program"): a coach's drill
  ladder as data: blocks in order, each with its drill (drill mode, so rehearsals stay out of the trends;
  a block without one, like the transfer block, counts as normal swings), ball or no ball, reps, and a gate
  (`count`: need of reps, or `streak`: need in a row) of checks on Square's numbers (`strikeV`, `attack`,
  `faceToPath`, `loft`, ...: min/max) and 3D kinematic numbers (`pelvisPeakMs`, `pelvisOpen`, `armAfterPelvis`, `pelvisStartMs`), plus `mark` for the golfer's tap on what they saw. A gate can also check the block's
  medians (`medians`: e.g. median attack -3 or steeper, the retention check). Square's strike height is
  spoken as the number it gives ("strike minus 12"): its 0 isn't the owner's sweet spot (7 iron median
  about -13, best carry at -20..-8), so gates use the owner's own band. Square's strike frame has jumped as a whole (about
  -14 mm on every club between Sep 16 and Sep 23 2026, and on Aug 21 alone), so a program's `calibration`
  (strike, 7 iron, usual -13 within 4, 10 shots) checks the median of the session's first 10 readable 7
  irons: outside it, the phone says "Calibration shifted" and strike stops gating for that run (attack and
  loft still gate). Invalid reads (Square's null, or the CSV's H0.0 / club speed 0) are checked before any
  comparison and left out of both sides of the count ("invalid read, not counted"). For 3D blocks (like Tier 2
  and Tier 3 of `sequence`), 3D kinematics arrive after both phone angles are analyzed; until then a rep is
  marked "waiting for 3D (n)" on the Start page, never counted as a miss. If 3D fails to arrive within 90 s
  (`BODY3D_GIVE_UP_S`) or is flagged invalid ("camera moved"), it is left out of the gate as an invalid read.
  **Moving Tier 3 pelvis stages:** In the `sequence` program, Tier 3's pelvis peak check starts at `max: -30`
  (peaking at least 30 ms before impact). The coach progresses this in stages:
  1. After impact: `{"key": "pelvisPeakMs", "max": 30}` (peaking within 30 ms after impact)
  2. At impact: `{"key": "pelvisPeakMs", "max": 0}` (peaking at or before impact)
  3. Before impact (initial): `{"key": "pelvisPeakMs", "max": -30}` (peaking at least 30 ms before impact)
  4. Final target: `{"key": "pelvisPeakMs", "max": -100}` (peaking 100 ms before impact).
  To advance the stage, edit the `pelvisPeakMs` check's `max` in `server/programs.json` under program `sequence`, block `tier3`.
  **Brace and turn** (`braceturn`, Oct 6 coach plan): Tier 1 no-ball brace-and-turn reps (tapped: no-ball
  reps make no clips, so the coach's 3D gate can't apply there); Tier 2 3/4-speed 7 irons, 8 of 15 with attack
  -3 to -4.5, face to path within 2, pelvis open 10+ (3D) and the pelvis 3+ in ahead of the ball (the face-on
  camera's `pelvisBall`, `programs.CAMERA_KEYS`: the 3D's distances aren't trusted for it); Tier 3 full speed,
  5 in a row on the same. Strike height is reported, not gated. Every program's shot order now also gives club
  path, face to target, start direction, ball speed, smash and carry per shot.
  **Setup notes** (Omni
  moved, mat changed, an update) are saved on the run in play or the last one and go into Copy for coach. No-ball reps are
  tapped Pass/Miss on the page, one at a time or the whole block at once after doing them (**All N passed**,
  or how many passed: one walk off the mat; misses are entered first, so on a streak gate the passes are the
  run in a row) (clips the phones record during them are ignored). Ball shots are judged
  once the shot pairs; a shot Square didn't read (club speed 0, or strike across the face exactly 0.0, whose
  up-down number is filler) is left out of the gate. Face to path = face minus path. The phone says each
  shot's verdict short, without numbers (they're on the screen): "Pass." (with "3 in a row" on a streak
  gate) or "Miss:" and which way, e.g. "face open to path" (`programs.CUES`), through the practice feed (practice voice and games are turned off; one voice at a time).
  On the Start page, a dedicated last-shot panel under the block gate displays the latest ball rep readable from 3 m on the mat: the verdict in 40 px, each gate check with its value, target band, and ✓ or ✗ in 28 px, and extra launch numbers in a summary row. Calm styling highlights passes in the accent colour and misses in muted text with ✗, never red.
  A block ends when its reps are in or its streak is made, then the next starts (`requires`: skipped unless
  that block passed); the program ends after the last block, at its cap (every swing counts, taps too), or
  45 minutes idle, and is logged to `programs-log.jsonl`. **Program history and trends**
  (`static/programhistory.js`, `SwingProgramHistory`, Start page "Coach program", Progress step 3): under the
  program picker on the Start page, **Past runs** lists up to 5 finished runs (newest first: date, swings used
  out of cap, and for each block its passed / not passed / skipped tag and gate count) with a **Copy for coach**
  button per run (`/api/program/report?started=<run.started>`). Folded under `<details>` "Past runs" when more
  than 2 runs exist. For ball blocks with 2+ runs with read shots, trend lines show gate progression and launch
  monitor medians moving toward the gate, away, or about the same; every check is covered in the gate's order (including 3D angles, timings, and camera distances), noting missing 3D swings when fewer than all had them. In Progress step 3 ("Is it working?"),
  each program with 2+ runs gets a folded trend line. **Copy for coach** (`/api/program/report`): per
  block the gate result and medians (range) of attack angle, dynamic loft and face to path for shots 1-10
  and 11 on, the club order, every shot in order with its verdict and bring-back metrics (pelvis peak ms,
  arm peak ms, pelvis open at impact, pelvis turn start vs top; pelvis and chest vs ball at impact from
  the face-on camera when the swing has them), and the impact frame
  (`/api/still/{clip}`) of the first ball swing hit in a no-ball block (the toe-tap swing). Block medians also include club path, face to target, ball speed, and smash alongside 3D pelvis open, pelvis peak, and arm peak medians when recorded on the block's read shots. Tested in
  `tests/test_programs.py` and `tests/programhistory.test.js`.
- **Today's practice plan** (`static/plan.js`, `SwingPlan.buildPlan`): built on the Start page ("Today's plan")
  for quick setup in the barn. Lays out an ordered 45-minute practice session (60-80 balls) across 4 blocks:
  (1) Warm-up wedge shots, (2) Focus block with the active focus move, its coach.js drill and swing thought,
  the latest drill set line if recorded in the last 14 days, and a "Practice this" button that configures
  voice practice mode, (3) Scoring-zone block targeting the
  weakest Combine yardage or the wedge matrix's biggest gap with a game suggestion, and (4) Finish with
  a game (Combine if due for weekly benchmark >= 7 days, else a game targeting the weakest area like Driving
  for low fairway percentage or Distance control for wide carry spread). Pure logic in `static/plan.js`, tested
  in `tests/plan.test.js`.
- **Plan steps** (`/api/plan/step`, `plan-step.json`): the plan is done one block at a time. Start on a
  block (or Next on the one being practiced) turns practice voice off, the block's drill on (any other
  off) and its game on (any other stopped), and remembers the block for 4 hours, so the laptop and a
  phone's browser both show which block is **Now**. End the plan turns everything off.
- **Drill mode** (`drills.py`, `/api/drill`): when the focus drill is the pump drill, the plan's focus
  block turns it on (and a coach program's drill blocks turn theirs on). Drill sets (`drillsets.js`) are the
  pump drill's only. While it's on the phones (capture app 0.10) keep 6 s before the strike
  instead of 2, so the pumps are in the clip, and every swing recorded is tagged with the drill (by time,
  `drills.json`) and left out of the trends, good-shot ranges, noise table and labeling worklist: a
  rehearsal isn't the usual swing. The swing list says "pump drill · left out of trends". It ends when
  turned off, or 30 minutes after the phones stop recording. A pump-drill swing's key positions are found
  as in docs/key-positions.md "Pump drill", and the swing page shows a **Pump drill** card: each pump's
  bottom (the P6 the drill rehearses: hands to plane, wrist hinge) against the good-shot P6 range, the
  real swing's P6 after the pumps, and whether the rehearsal carried into the swing (within 1 in), with
  the focus's swing thought. Each "Pump n" button jumps the video there. Tempo isn't given for these swings.
- **Drill pelvis check** (Start page): while a drill or coach program is running, a card shows the latest swing's
  pelvis vs ball at impact (one large number in inches, + = ahead), colored green/amber/gray from the target zone
  calibration (`static/pelviszone.js`, never red), with the one-line position and target sentence below. Shows
  "Analyzing…" while the clip is processed (~10-15 s) so the previous rep's number is never shown for a new swing.
- **Start page morning check ("Since last time")** (`static/sincelast.js`, `SwingSinceLast`, `start.html` in step 1 Get ready `#sec-ready`):
  before each session, summarizes the last ended session (ended >= 30 min ago) and the night worker run after it.
  Shows headline ("Last session (<date>, <n> swings): <k> things to check" or "... all good"), with warnings open
  (e.g. face-on or DTL misses >= 3% with phone setup todo, Square pairings < 90% with watcher todo, camera moved with calibrate link,
  >= 5 false triggers) and confirmations folded behind "Show all" (both angles, Square paired, cameras in place).
  Displays overnight worker sentence (`improve.nights[0]`), candidate model waiting notifications (`Tools > Night report`),
  and club model retraining progress (`Tools > Club check`). The club model progress line states how many new frames toward the retraining target are collected (linking to Club check), or confirms that enough new frames were gathered to train tonight. Loads once on page open and manual refresh, never while recording.
