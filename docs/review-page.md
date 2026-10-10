# The review page and the swing analysis

What the server works out for each swing and what each part of the review page shows: trust per number, good-shot ranges, what helps / hurts, focus, practice mode and games, Trends, Progress, Compare. (Moved out of HOME-SETUP.md, which has the session checklist, setup and troubleshooting.)

## `server/` - the home server (Python, FastAPI)
- `D:\SwingClips\clips` (videos), `pose` (pose per clip, gzipped JSON, and its quality record), `shots.jsonl` (launch
  monitor shots), `clubs.json` (clubs corrected on the review page), `swings.json` (each swing's
  numbers), `noise.json` (the noise floor per number, for the trust rules), `journal.json` (handicap and session notes), `excluded.json` (swings left out), `reviewed.json` (swings marked "check" that you said are fine),
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
  the wrists and index fingers weighted by MediaPipe's confidence, smoothed over ±45 ms where the hands
  are fast and up to ±120 ms where they're slow (address, the top: about the same stretch of path either
  way; a local curve fit that leans on confident frames and drops one-frame glitches), and ends at P8, or
  earlier once a wrist is lost behind the head. Night pass (`Show > Night pass`): draws the skeleton from the
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
- **Progress's scoreboard** (`static/board.js`, `static/strokes.js`, drawn by `static/board-view.js`;
  Oct 9, the owner: strong measurements, packaged like a finished app). Irons or woods, as the switch at
  the top says; never the two together.
  - **Session score** (the ring in step 1, 0 to 100): the average of four pass rates, each one of the
    good-shot rules on its own and each against that club's own usual: **on line** (offline within the
    club's allowance), **distance control** (carry inside your usual window), **solid strike** (smash at or above
    your usual: about half pass by definition, so over 50% is a better day than usual) and **middle of the
    face** (within the strike allowance of your usual spot). A good shot passes all four at once. The tick
    on the ring is your usual (the middle of up to 6 earlier sessions with 15 judged shots); the pills say
    last time, usual and best. The session list has the score as a column (from 8 judged shots).
  - **Your game at a glance**: those four skills plus **swing match** (from the video: the share of the
    body numbers the cameras could read that sat inside the 10th-90th percentile of your good shots; it
    stays out of the score) as a radar (the latest session filled, your usual dashed) and as rows with the
    gap to usual in points. A gap is called out from 10 points with 8 shots behind it; one sentence names
    the skill down most and up most. Tap a skill to see its swings in Analysis.
  - **Against a tour player**: strokes gained per shot (`SwingStrokes`, on games.js's tour tables). A range
    shot has no flag, so each shot's target is the club's own usual carry on the target line; irons, wedges
    and hybrids are approach shots, the driver and fairway woods tee shots on a 400 yd par 4 (30 yd
    fairway). One bar per session (tap for the session), the latest against the usual ("better" / "worse"
    from 0.05 a shot), the same number per 10 shots in words, how far the middle shot finished from its
    target, what the period's misses cost (left-or-right against long-or-short: what each shot would have
    lost with that miss alone) and how the shots missed (beyond 5% of the distance), then club by club with
    the one furthest behind marked (tap a club for its swings). A net has no roll and the target is your own
    usual: a practice number to follow session to session, not a round's strokes gained.
  - **Personal bests** (all time): best session score, best session against a tour player, most good shots
    in a row, the longest carry that finished on line (the most-hit club; the driver with the woods), the
    fastest swing with the woods (a club speed whose smash is far under your usual is a misread, not a
    record), and the handicap index. "New" marks one set in the latest session. Tap for the swing or
    session; every club's carry and speed under **Every club**.
  - **Practice**: sessions and swings this week against a usual week (the middle of the 4 before), weeks
    in a row with a session, and a 12-week calendar (a day's color deepens with its swings; tap a day).
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
  helps / what hurts worked out **per club group**, irons and wedges apart from woods, hybrids and
  driver (each session split by club, so each swing is against its own session-and-club usual; the
  clubs of a group pool), ranked by what matters to an everyday golfer (distance offline 1, smash 0.9,
  carry 0.8, path 0.8, curve 0.7, ball speed and face 0.6, strike 0.4-0.5, irons' attack angle 0.8
  against -4, times |r|, half for "worth trying"). Never pooled across groups (2026-10-07): pooled, "the
  head staying behind the ball" came first from a smash link that was the driver's (woods r -0.39,
  irons -0.13), while on the irons head ahead went with a steeper strike (r -0.54; head 0.5 in or less
  ahead: attack 0.0, more than 1.5 in: -4.0) that their -1.9 median needs. A move that helps one result
  and hurts another, also when the way one result wants is a fault, is a trade-off and left out. Shown:
  the irons' first ("Your #1 priority with your irons"), then the woods' first ("With the driver and
  woods") or the irons' second. A focus made from one tracks the group's most-hit club (button
  tooltip).
  **One topic, in detail** (Oct 9, the owner: one thing visible, the rest available but not shown). The
  card shows only the focus (or, without one, the #1 priority): **Why this** (that move's own strong and
  worth-trying links in the latest numbers for its club group, `moveEvidence`, at most 3: what goes with
  what, how much per unit, in how many sessions; "the opposite of this move goes with worse results" when
  the aim is less, since a link describes more of the move; without links, what it was set for), **What
  it is** (coach.js `how`), **What to do** (drill and swing thought), a one-thing-at-a-time line (faults
  come in chains), the buttons, then **Is it working?** (below). Everything else waits in one closed fold,
  **More** (`data-fold="focus-more"`): the move the numbers now point to, with its evidence and Switch
  focus to this (named in the fold's title when it differs from the focus), other moves, earlier
  focuses, the program / combine / drill-set lines, **All the evidence** and **Pick my own focus**.
  Inside **More**: **Pick my own focus** (`static/focuspick.js`), letting the golfer
  pick any move from `coach.js` with a body number in `summary.js` (only sides without a fault, grouped
  by phase: Top of swing, Downswing, Impact, Tempo) for irons ("My irons", tracked with the most-hit iron),
  driver and woods, or any one club; previews the how, drill and thought before saving.
  Earlier focuses fold below it with **Go back to this**; the history stays clean (same-day slips are
  dropped, and reactivating an earlier focus removes its old history entry).
  **Is it working?** (in the focus card since Oct 9; it was step 3) One heading and what to do about it,
  from the focus's move and results since it started (`SwingFocus.working`, focus.js; the results are the
  ones it was set for plus the ones its evidence names now): "It's working" (move and a result the right way), "You're
  making the move; the results haven't followed yet", "The results are moving the right way" (the move
  not clearly), "Not working yet after N sessions" (4+ sessions, nothing moved: slower drill, or the
  coach), "Going the wrong way so far" (half speed), "Too early to tell". Then two lines, **Your swing** (the move itself,
  from the video and 3D) and **Your results** (each with its verdict), a camera-moved warning and the
  before / since numbers folded. Nothing without a focus. The chart is folded under **See it on a chart** (opens itself when a tile or chip
  picks a number); it pools every club (only numbers that mean the same with any club: body numbers,
  path, face, face to path); a one-club focus charts its own club.
  **One club at a time** (the club picker): the club's last session opens with the four story tiles
  (Good shots, On line, Solid strikes, Distance) comparing against earlier sessions, its headline verdict,
  and its top fault with swing thought and cross-session trend. One club's sessions are smaller, so it
  compares from 8 judged shots (`MIN_JUDGED_CLUB`; all clubs: 15); below that the tiles show last time and
  the usual with no verdict. The detailed club numbers (carry, spreads,
  body numbers) fold under **All numbers from this session**. Below: shot pattern, sessions table, and
  good-shot rules.
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
  working: the chart opens on the focus move; inside the focus card's More fold, a short Drill sets block appears when
  drill sets exist, showing the latest set's pumps, drill swings' P6, and normal swings before (or "your usual": the last 15 same-club swings of earlier sessions, when the session starts with the drill) and
  after with a verdict on whether the rehearsal carried over against wobble, with older sets folded
  and tapping any set opening its first drill swing); step 1 also highlights the session's top faults under
  the headline sentence, along with any strong links between them (e.g. casting and early extension)
  tested within clubs using Cochran-Mantel-Haenszel odds ratios and Benjamini-Hochberg correction (`static/faultlinks.js`);
  shot pattern, where on the face (strike heat map), sessions, good-shot rules, gapping,
  the wedge matrix and handicap are folded cards underneath.
- **Analysis** (tab; `static/analysis.js`, numbers in `static/explore.js`): the full numbers, one club at a
  time. A rail on the left picks one view; the club, the period and "Leave out shaky" are at the top. The
  one-club cards that used to be folded under Progress live here (last session, shot pattern, where on the
  face, every session, good-shot ranges, gapping, wedge matrix, handicap), plus:
  - **What goes with what**: any number against any other, one dot per swing over every session in the
    period; tap a dot to open the swing. Chips pick the result you want (distance, solid strikes, straighter,
    shot shape, middle of the face); quick looks pick classic pairs (club speed into ball speed with smash
    lines, face against path with the no-curve line, strike and smash). Dots are colored by good shot or by
    newest session; hollow = a shaky number. Two ways to take the numbers: **as measured**, or **against that
    day's usual** (each swing less the average of its own session and club, which cancels warm-up, tiredness
    and where the cameras stood; one degree of freedom is spent per session). Both r values are shown, with a
    warning when a link seen as measured fades inside sessions (it comes from days differing, not the swing).
    "All irons and wedges" (or "Driver, woods and hybrids") pools the club type, always against each
    session-and-club usual; irons and woods are never pooled together. Under the chart: the result in the
    lowest, middle and highest third of the bottom number (median, middle half, share of good shots; tap a
    row to list its swings), and every number on the other side ranked by how closely it goes with the
    result inside sessions (tap one to chart it). A few far-off swings don't set the scale: it comes from
    the middle 96% and a margin, and the rest are drawn at the edge.
  - **Links at a glance**: every body move against 11 results as a grid (`SwingHelps.analyze`, the same
    within-session test and labels as Progress's evidence). Deeper color = closer link; green ▲ = more of
    the move went with a better result, amber ▼ = a worse one, grey + / - = a link with no better or worse
    way; outlined = strong evidence; no number = could be chance. Tap a square to see its swings on the
    explorer. The three clearest links are written out underneath.
  - **Over time**: any number per session with this club (median and middle half, a spread, or the session's
    good shots / on line / solid strikes); tap a session to open it.
  - **One session** (from Over time or Every session): the session's tiles against the usual of the other
    sessions in the period (a verdict from 8 swings), where its shots finished, one number shot by shot with
    the middle of the last 7 swings as a line (warming up, tiring, a change that took), and every swing in a
    sortable table. Older / Newer step through the club's sessions; **Session story** opens the session's
    Trends. Tapping a swing anywhere in Analysis opens it with **Back to Analysis** above the video, which
    returns to the same view.
  - **Around the target** (`static/strokes.js`): where each shot finished around its target (the club's
    usual carry, on the line), the same yards both ways, with a 15 yd circle (about a green); strokes per
    shot against a tour player, the middle shot's distance from the target, on target / short / long /
    left / right, and what the misses cost (direction against distance). The driver and fairway woods show
    carry against offline with the 30 yd fairway and the rough either side instead. Strokes gained and
    distance from the target are also numbers on the explorer ("Scoring" chip), Over time and One session.
  - **Every club**: each club in the period as a sortable table (shots, carry and its middle half, smash,
    offline spread, good shots, score, strokes per shot); tap a row to pick that club for the other views.
  - **Ball flight** (`static/flightgrid.js`): the nine ball flights from start line (left, straight, right beyond 2°)
    against sideways curve (left, straight, right beyond 2.5% of carry). A plain sentence describes your usual flight
    and how the latest session compared; a 3x3 grid of buttons displays each flight's name, share, count, and miniature
    trajectory curve (tap any cell to pick its swings); a top-down view plots every shot as a curve bending to its landing spot
    (latest session in accent, earlier sessions in faint grey, hover for details, tap to open the swing); and stacked bars
    show start line and curve shares session by session. The top-down chart is at most 640 px wide: across is
    stretched against up, and wider makes a spray of a tight pattern.
  - **Spread** (`static/distro.js`): how spread out any launch monitor or body number is with this club, and whether the
    latest session was tighter. A summary sentence reports the middle half (interquartile range) of the latest session versus
    earlier sessions (tighter, wider, or same within 15%); a histogram compares the share of each group across rounded bins (8 to 16 over the middle 94% of the values; the
    outer bars take everything beyond, so a topped shot doesn't set the scale),
    with an optional good-shot range band and median ticks; and session-by-session box plots (newest on top) show the 10th-90th
    percentile whiskers, middle-half box, and median tick on a shared scale. Tap a bin to pick its swings or tap a session row
    to view that session.
  - **Swing checkpoints** (`static/checkpoints.js`, `static/indicators.js`): every body number against its own good-shot range as an interactive tile board.
    - **Filter chips**: Favorites (shown when any favorites are saved), All, Rhythm, Top of the swing, Downswing, Impact (remembered in `localStorage["checkpoint-filter"]`).
    - **Indicator tiles**: auto-fill grid of tiles. Each tile shows its plain name, moment tag (Rhythm, Top, Downswing, Impact), value big and colored (accent for in-range, amber for near/wobble, red for out), verbal status ("in range", "a little low", "high": color is never the only cue), a track with q10..q90 span faint, q25..q75 solid, middle-half ends labeled with numbers, a marker clamped with arrows when off the track, and a favorite star.
    - **Detail panel**: tap any tile to open a panel below the grid showing that number's row with SVG range bar, share in range, and three actions: **See it over time** (opens Analysis Over time for that metric), **Swings outside** (picks swings outside the good-shot range), and **Make this my focus** (opens Progress's focus picker on that move when the latest median is outside the middle half).
    - **How it's worked out**: expandable fold explaining how ranges describe your own good shots (not a tour model), shaky tracking, and camera shifts.
- **Where on the face** (Analysis card, `data-fold="strike"`; `static/strikemap.js`):
  heat map of impact locations on the club face (from Square's `faceImpactH` and `faceImpactV`) for the chosen club and period.
  The picture (`SwingStrikeMap.faceSvg`, Oct 9, the owner's ask: like FlightScope's): a club face seen from the front, toe on the
  left and the hosel on the right (an iron with grooves, or a wood face for the driver, woods and hybrids), an inch grid (half-inch
  lines, labelled every inch, "← Toe" / "Heel →"), a smooth heat map of every strike in the period (`density`: each strike a
  Gaussian of 5 mm, 7 mm for woods; `heatColor`: clear below 6% of the busiest spot, then green, yellow, red where most land),
  the latest session's strikes as small blue dots and its last one as the big dot, the usual spot as a dashed ring, and the face
  centre as a small cross. The heat isn't cut to the face (a strike off it would vanish). Heights are re-centred by the
  server (Square read about 14 mm low on every club from mid-September; `app.recentre_strike`), and a note says so. The swing view's strike tile uses the same
  drawing, cropped to the face (`tile: true`): this shot's dot and the usual ring.
  Below the face: a comparison summary line comparing the latest session's strike centre and spread against the median of up to
  6 earlier baseline sessions ("Strikes moved 5 mm toward the toe and 4 mm lower on the face. Your usual: 2 mm toward the heel, 3 mm low").
  When low strikes are typical with irons (median strikeV below -6 mm, the floor of the programs' strike band, re-centred heights), a coaching line checks the irons' what-helps-what-hurts
  (`pooledHelps(...).irons.a.links`, confirmed or emerging) coached with `SwingCoach.coach(l, "I7")` for its swing thought and drill;
  if no link exists yet, it states the fact without inventing a drill.
  A compact trend chart underneath plots each session's centre over time across two tracks (Toe/heel drift and Height on face).
  Strike numbers across the review and Start pages are shown as heel/toe and high/low words (+ = heel in Square Omni data, - = toe, and values under 1 mm as centre); raw signed mm remain in tooltips for Advanced data.
- **Compare** (Compare… or C on a swing; `static/compare.js`): this swing against another one,
  usually one of your own better ones. The picker lists every other swing with its date, club and
  Square numbers, filtered to this club and the last 90 days by default, sorted by carry (or ball
  speed, club speed, smash, straightest, newest). A ✓ marks good shots (the rules in Progress);
  **Good shots only** keeps to them, and the period **Before my focus** (there while a focus is set)
  keeps to swings from before the day it started, to see what the focus has changed. The two then play side by side, one row per
  camera angle both have. **Key positions** (default) lines them up by key positions (Setup, Early backswing,
  Backswing, Top of swing, Early downswing, Downswing, Impact, Follow-through; P-tags only in hover tooltips),
  stretching the time between each pair in a straight line, so the reference plays faster or slower between them;
  **Real time** lines them up at impact only, both at real speed, so tempo differences show.
  Play, scrub, frame steps (← →) and positions (keys 1-8) move both. **Ghost** (G) draws the
  reference's skeleton, dashed, over this swing's video, lined up at address by the feet and hips
  and scaled by body height. **Key positions** under the videos: both swings' scorecard tiles, a
  column per position (this swing over the reference), each coloured against your good shots with this
  swing's club as on the swing page. Tapping a column (or keys 1-8) puts both swings there and
  shows that position's numbers for both, each on a bar against the middle 50% of your good shots
  (dark mark this swing, pink the reference) with the difference; then each swing's named faults.
  Body number labels everywhere in Compare use plain English via `SwingShotStory.LABELS` (e.g. "hip slide", "spine tilt").
  Below: tempo, the body numbers at address / top / downswing / impact for both
  swings and the difference, and Square's numbers side by side; numbers from a camera that couldn't
  see all of a swing (the camera check) are greyed out. The address bar holds
  `#compare=<clip>,<clip>`, so a comparison can be bookmarked or sent. Swap puts the reference
  on the left; Esc closes it. Body numbers from different sessions only compare if the phones
  stood in the same places.
- **Leave out**: a swing that isn't yours (a friend hitting while the phones listen) is left out of
  Trends and Progress with the swing's Leave out button (`excluded.json`).
- **Swings to check, and leaving out many at once** (`static/review.js`; Oct 10, the owner: a drill hit
  without the drill switched on skewed a whole session). A swing far from that club's own usual is marked
  **check** on the list (hover for why): a backswing 1.5 times as long and at least 0.4 s longer (the pump
  drill and a paused top read like this), club speed under 80% of the usual (not wedges: part swings are
  their job) or over 112% (another club, or a misread), a carry over 125% of the usual (another club than
  Square was set to). A short carry on its own is a mishit and a real swing: not marked. Nothing is thrown
  out for you. A session with marked swings shows **N to check** under its name: one tap ticks them all;
  then **Leave out** (out of the trends, progress and ranges; the clips stay; Undo on the toast), **Put
  back**, or **Looks fine** (kept and no longer marked: `POST /api/reviewed`, `reviewed.json`). **Select**
  works the same for any swings (a session's box ticks all of it), so leaving out is as bulk as deleting.
  The open swing says why it is marked, with **Leave out** and **It's fine**. A club needs 10 swings before
  anything is judged against its usual; swings already left out don't shift it.
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
  rapidly checks and confirms or adjusts club points (grip end, hosel, clubhead) on high-value frames to feed the nightly club model retraining. Presents a balanced queue of frames (5 per clip, up to 40) from clips without club points, prioritizing clips with no backswing club points yet; each camera's clip counts on its own and the queue alternates face-on and down the line (since Oct 8: before, the down-the-line clip, listed first, always won and a labeled down-the-line clip sent its face-on partner to the back, so 45 face-on clips had points against 111). Each swing includes 2 backswing frames between takeaway and P3 (one within ±0.03 s of P2) to give nightly retraining the backswing frames that P2 horizontal-shaft detection depends on, 2 downswing frames between P4 and P8 (preferring missing or low-confidence clubhead detections), and address. Displays upright stills with markers for grip, hosel, and head connected by a shaft line, accompanied by a 3.5× magnified zoom inset around the selected point for precision adjustment on mobile or desktop. Keyboard shortcuts and touch controls enable one-tap confirmation (Enter / Space), point cycling and dragging (1, 2, 3), streak blurring (B), marking can't see (X), or marking no club in picture (0). Saves directly to `/api/labels/<clip>?pass=1` without altering body landmarks or events.
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
  provides a concise weekly summary designed for the owner to share with their coach in under two minutes. Covers sessions practiced (days, duration, swings by club, drills, and coach program runs), ball flight changes for clubs hit 15+ times where change exceeds weekly noise, progress on the journal focus move vs past weeks alongside coach thoughts, top 3 named faults vs the prior week, findings that held up in subsequent sessions (`holdup.js`), game scores vs all-time bests, and journal notes. Features a week picker (`‹`/`›`) starting on this week, phone-friendly calm card styling without red highlights, and a one-tap **Copy for coach** button that formats the report as plain text ready to paste directly into a coaching chat. Below the summary, the week's coach program runs, each folded with its full report (`/api/program/report`) and its own **Copy this run for coach**, so a run hit at the sim can be read and sent from the house. Under the summary and runs, **Coach's review of the week** offers an AI review of the week's text (at most 200 words: The week, Your focus, Next week), folded when a kept review exists with "Ask again", or with an "Ask the coach" button when one hasn't been requested yet. It sends the same text the page compiles for the human coach and is never called automatically. Openable via `/#week`. A "with the program runs" checkbox next to Copy for coach includes the week's full program run reports directly in the copied text, separated by run headers, and remembers its setting across visits.
- AI coach: **Tools > AI coach** (`aicoach.py`, `static/aicoach.js`, `static/aicoach-view.js`):
  an AI coach that reads what your practice showed together with your current focus and gives plain-spoken, grounded coaching. Any of the big providers (Oct 9, the owner: "AI agnostic"): Anthropic (Claude, official SDK; default model Claude Opus 5.5 at medium effort, with the server-side fallback on a declined request), OpenAI (chat completions), Google (Gemini `generateContent`), or any other OpenAI-compatible service by its base URL. The provider and model are picked on Tools > AI coach (`ai-coach.json` next to `shots.jsonl`); the models offered come from the provider's own list (`/api/coach/models`), so names never go stale. Keys: pasted on the page (saved to `anthropic-key.txt`, `openai-key.txt`, `gemini-key.txt` or `other-ai-key.txt` next to `shots.jsonl`; `POST /api/coach/settings` never returns them) or `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) / `AICOACH_OTHER_API_KEY`. Without a pick, the provider is the first with a key. Errors are said in words (key wrong, model not available, rate limited or out of credit, no internet). The coach serves three uses:
  1. **Session take**: given right after a session on the Start page's end-of-session card and folded on Progress step 1 (under 150 words: How it went, Your focus, Next session with drill and thought). One call per session, cached by session key with "Ask again".
  2. **Weekly review**: in **Week for coach**, reviews the week's text (under 200 words: The week, Your focus, Next week). One per week, cached by week start with "Ask again".
  3. **Question box**: on **Tools > AI coach**, an **Ask the coach a question** box (up to 500 characters) answers questions ("Why do my 7 irons go right?", "Is my driver strike getting better?") in under 150 words, grounded in a 30-day brief (latest session brief + 30-day per-club medians in bag order + active focus move). Answers render under the box; questions stand alone and are never re-used.
  Only text briefs go out: no video, no pictures, no names. All uses share a 10-call daily cap. Kept notes on Tools > AI coach show each note's kind (session / week / question with the question asked). Openable via `/#aicoach`.
- Lead wrist check: **Tools > Wrist check** (`static/wristcheck.js`):
  provides a fast pass over a session's coach program shots to judge the golfer's lead wrist at impact by eye (flat, slightly bowed, cupped, or can't tell), on the down-the-line or the face-on camera (a switch, remembered; the back of the lead hand is often clearer face-on). Each card shows a strip of 4 frames (-8, -4 ms, impact, +4 ms: one 240 fps frame is often a blur), each cropped and enlarged round the hands. "Can't tell" is an answer, not a call: the coach report counts it apart ("10 of 12 shots called; can't tell on 2"). There is no computed wrist number: on 165 7 irons (Oct 7) neither the camera's hands-ahead (r -0.01) nor the club model's shaft angle at impact (r +0.06) predicted Square's dynamic loft. The app crops (using pose landmark 15 lead wrist from `/api/pose/<clip>` when available, or the middle 60% of the frame). One card per ball shot in order with shot number, block, and verdict, four judgment buttons with keyboard shortcuts (keys 1-4) that highlight and auto-advance to the next shot, run picker defaulting to the newest finished run, and a header count ("12 shots · 7 called") with a link to Week for coach. Calls are saved via `POST /api/program/wrist` and included in the coach report (`/api/program/report`). Openable via `/#wristcheck`.
- **Tools menu grouping**: organizes the 13 tools into two clean groups. Daily practice essentials appear first: **Start a session**, **Tripod setup**, **Week for coach**, **AI coach**, **Update the server**, and **Shortcuts & help**. A divider and small uppercase heading **Tracking and setup checks** separates diagnostic utilities: 3D calibration, Labels, Club check, P4 check, Wrist check, Night report, and Shutter test.

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
    face, not a strike-quality score; heights are re-centred on 0 by the server (+14 mm; your 7-iron
    median is near 0 mm, ~-14 mm raw), and strike tolerance is measured from your own usual spot.
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
  **Focus on this swing**: at the bottom of the coaching card (`.cc-focus`), when there is an active focus
  and the open swing is within its club or group scope: "Your focus, <plain move name>: <this swing's number>
  (<better / about the same / further> than your usual <median of the 30 swings before it in scope>)".
  No line when the swing has no reading or is shaky (tracking noise, bad camera, estimated position).
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
- **Session story card and folded Advanced data in Trends** (`static/sessionstory.js`): opening a session's Trends
  view presents a plain story card (`#t-story`) at the top before any charts or tables: a headline sentence comparing
  the session against prior ones (`SwingSessionScore.compare`), best and worst club notes in plain words ("your best
  club today: 27% good with the 7 iron", "the 4 hybrid struggled: 1 good of 11"), the session's top fault with its
  swing thought and drill from `coach.js`, and a "Watch my best swing" button that opens the session's good shot with the
  most body numbers inside your personal good-shot ranges. The filters, scatter chart, correlation ranking, and full
  swings table are cleanly folded inside a single `<details class="t-card p-fold">` "Advanced data" section, closed
  by default and remembered per browser (`data-fold="trends-advanced"`). The chart automatically re-renders to fill the
  full width when the fold is toggled open.
- **Session header on the swing list**: each session group in the list displays a short second line once trend data is
  loaded (e.g. "27% good shots · best: 7 iron"), computed cheaply from `SwingSessionScore.score` and cached per session
  clip count. It shows overall good-shot rate over judged shots and highlights the best-performing club among those with
  5+ judged shots. Detailed club breakdown counts ("75 swings · 5i 22 · 4h 14 …") are preserved in the session header's
  tooltip title on hover.
- **Advanced data** (button under Square's numbers, remembered per browser): off by default.
  Without it the swing page shows the coaching card and simple tiles (club, carry, offline, club
  speed, smash, and, when the shot has a strike recorded, a mini **Strike** tile with a ~44 px face
  outline showing this shot's strike and the club's usual centre; tooltip title:
  e.g. "Strike: 6 mm toward the toe, 12 mm low (your usual with the 7 iron: 3 mm toe, 17 mm low)").
  With it, Square's other numbers, the scorecard, key positions, the swing numbers
  table, 3D and the clip names (`adv-only` class in `index.html`) become visible. Advanced data uses plain golfer's words
  everywhere instead of P-system jargon: scorecard phase tiles and table columns read "Setup", "Top of
  swing", "Downswing", "Impact", with P-tags kept only as small secondary hints or tooltips. Metric labels,
  the scorecard summary sentence, row labels and fault locations ("in the downswing", "at impact")
  use plain English from `SwingShotStory`.
- **This swing under the video** (`#indicators`, `static/indicators.js`):
  Sitting right under the video above the scorecard, a summary card titled "This swing" displays your favorite indicator tiles for the swing on screen against the club's good-shot range. Tapping any tile seeks the video directly to that number's key moment. A "Choose" link opens Analysis on Swing checkpoints to manage favorites or explore other numbers. Hidden when the swing has no body numbers; not hidden behind Advanced data.
- **Swing page**: a column **vs my good shots (club)** in the numbers table, and a faint band on the
  number itself: green inside the middle 50%, amber outside ("outside: 4° more than usual", and
  "inside the 80% range" when it's between the two). The tempo line gets the same under it. Numbers
  with no reading get no band. Named swing faults (early extension, standing up, etc.) appear in a line
  above the numbers with each fault's swing thought as its tooltip, only when present; the scorecard's
  fault list also shows a short "often comes with X" when that link is strong and the other fault is also
  on the swing.
  **Arms-led downswing** (3D) is a *standing pattern*, not a per-swing fault (2026-10-07, `standing` in
  `faults.js`): it named 76 of the owner's 79 judged 3D swings; the 3D under-reads hip turn (32° at the top
  against 42° face-on; X-factor 71°), hips read -9° to +9° open at impact, and good shots were as common at
  either end. The swing view, scorecard, Compare, Progress and the session story leave it out;
  `faultsOf` / `sessionFaults(rows, shaky, {standing: true})` ask for it, as Today's plan (its Practice
  sequence block) and Week for coach do. Progress's most common fault also says how it compares with
  last session ("Up from 66% of swings on Oct 4"; both sessions need 10+ readable swings).
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
- **The focus as a goal: target and progress score** (`static/goal.js`, drawn by `goalHead` and
  `renderGoalStrip` in `board-view.js`; Oct 10, the owner: pick the focus, then see progress on it, as
  Sportsbox does). The **target** is what "better" looks like in the move's own number: your own bound
  (`focus.target`, **Set my own** on the card), else your usual before you started (the middle value of the
  move over the swings of the up-to-6 sessions before the focus began, on the side you aim for; with nothing
  before, the first session since). The **progress score** is the share of a session's swings with a reading
  on the right side of the target (the bound counts). Against your old usual it is 50% before you start by
  construction, so over 50% means more swings than not now beat it. The focus card opens with the score ring
  (the latest session since), what it counts, before / since / best in one line, and one bar per session
  (before grey, since green, a dashed line at the before share; tap a bar for the session), then **Practice
  this** (in range = in the target, so the phone's voice and the score count the same swings), **Change
  focus** (opens Pick my own focus) and **End this focus**. A camera that moved since the focus began is
  marked on the bars with a warning: the move reads differently from a new spot, so scores either side
  don't compare. A strip at the top of Progress shows the same score with Practice this and View progress
  (or, with no focus, what the numbers point to and a way to pick one). "Is it working?" (session medians
  against the wobble, below) stays the judge of whether a change is real; the score is the count to follow.
- **Swing by swing, live** (`static/goal-live.js`, numbers from `SwingGoal.live`): under the session bars
  on the focus card, and as a card on **Practice** that redraws as each swing's numbers arrive (the page's
  10 s refresh): the last swing's number big with where it sat ("in your target", "just outside": a miss
  under a quarter of how much the move usually varies, "outside your target"), the swing thought after one
  that wasn't in, the session's swings, the share in the target and the minutes so far, and every swing as
  a dot against the target's band (tap a dot to open the swing). Only swings in the target count toward the
  score; "just outside" is a color and a word, not a pass.
- **Make this my focus** on a suggested priority or through **Pick my own focus** saves it in the journal
  (`journal.json` `focus`: move, which way, club, scope: "irons" | "woods" | null, the results it's for, the day it started;
  `POST /api/journal/focus`, with `{"move": null}` to end it; normal switches go to `focuses` with `until`).
  Clean history rules: slips ended the same day are omitted from `focuses`, and reactivating a past focus via
  **Go back to this** removes its previous entry from history.
- **Pick my own focus** (`static/focuspick.js`): under step 2, allows choosing any move in `coach.js MOVES` with a
  body number in `summary.js BODY` (only non-fault sides, grouped by where it happens: Top of swing, Downswing,
  Impact, Tempo) with plain golf names, for irons ("My irons", tracked with the group's most-hit iron), driver and woods,
  or any individual club. Previews how, drill, and swing thought, and switches via confirmation.
- **Swing view coaching card**: displays your focus move on every swing within scope at the bottom of the card,
  comparing that swing's number to the median of the 30 preceding swings in scope ("better / about the same / further than your usual").
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
  Angles button shows with it). The scrubber names Setup, Top and Impact; the other positions are
  ticks named on hover. The **habit banner** only fires when the first readable swing of the five was
  clean (a fault creeping in); Oct 7: 7 banners in 63 swings (was 15).
- **Swing order strip** (under the video's controls, swings with 3D; `view3d.js showStrip`, Show >
  **Swing order**, on by default, remembered): how fast the hips, chest, lead arm and club turn from 0.08 s
  before the top to 0.12 s after impact, each line against its own top speed in that window (on one scale
  the hips and chest lay flat under the club), peaks dotted, lines broken where tracking stops, the order in
  one line ("Order: lead arm, club, hips,
  chest (best: hips, chest, arm, club)"). A playhead follows the video, frame steps included, and reads the
  four speeds there ("47 ms before impact: hips 32 · chest 261 · lead arm 855 · club 1324 °/s"); a tap or
  drag on the strip moves the video to that moment. The full chart and its notes stay in the 3D panel
  (Advanced data).

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
- **Practice games** (Games card in Practice): pick Combine, Wedge ladder, Random pick, Ladder,
  Driving, Shot shaping, Distance control or Hole builder. The picker shows a single-line description for the
  game, with a **Start game** button. While in play, the current target is shown in large text (readable from 2 m:
  28 px desktop, 20 px at 390 px), with the shot count and running score in plain words (e.g. "+0.4: a bit better
  than a tour player so far" or "-1.2: a little over a stroke behind"). The speaking phone says each target; once
  Square's shot pairs (~15 s) it says where the ball landed and the next target. Scoring explanation and the Past games
  history picker fold under **How games are scored and past games** (closed by default, remembered). After a game
  ends, it gives one sentence comparing the result to your last game of the same kind (e.g. "Combine: -3.1, better than
  last time (-5.4)") and the best and worst target of the game. Under the Combine scores table, "Where you lose strokes"
  breaks down strokes gained by target distance over the last 3 Combines. Starting a game turns the practice number off.
- **Coach program** (`programs.py`, `programs.json`, `/api/program*`, Start page "Coach program"): a coach's drill
  ladder as data: blocks in order, each with its drill (drill mode, so rehearsals stay out of the trends;
  a block without one, like the transfer block, counts as normal swings), ball or no ball, reps, and a gate
  (`count`: need of reps, or `streak`: need in a row) of checks on Square's numbers (`strikeV`, `attack`,
  `faceToPath`, `loft`, ...: min/max) and 3D kinematic numbers (`pelvisPeakMs`, `pelvisOpen`, `armAfterPelvis`, `pelvisStartMs`), plus `mark` for the golfer's tap on what they saw. A gate can also check the block's
  medians (`medians`: e.g. median attack -3 or steeper, the retention check). Square's strike height is
  spoken and shown in words ("strike 8 millimetres low"), re-centred on the face since Oct 9 (`app.recentre_strike`: Square's
  reading + 14 mm for shots from Sep 17 2026; it had read about 14 mm low on every club, 7 iron median -13 as sent); the
  gates are in those units (the band -20..-8 as sent is -6..+6, the calibration centre -14 is 0). Square's strike frame has jumped as a whole (about
  -14 mm on every club between Sep 16 and Sep 23 2026, and on Aug 21 alone), so a program's `calibration`
  (strike, 7 iron, usual 0 within 8 since Oct 9, 10 shots) checks the median of the session's first 10 readable 7
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
  (`static/programhistory.js`, `SwingProgramHistory`, Start page "Coach program", Progress step 2's More fold): under the
  program picker on the Start page, **Past runs** lists up to 5 finished runs (newest first: date, swings used
  out of cap, and for each block its passed / not passed / skipped tag and gate count) with a **Copy for coach**
  button per run (`/api/program/report?started=<run.started>`). Folded under `<details>` "Past runs" when more
  than 2 runs exist. For ball blocks with 2+ runs with read shots, trend lines show gate progression and launch
  monitor medians moving toward the gate, away, or about the same; every check is covered in the gate's order (including 3D angles, timings, and camera distances), noting missing 3D swings when fewer than all had them. In Progress step 2's More fold,
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
- **Start page bay feedback ("Last swing" and "End of session")** (`start.html`, `static/swingrow.js`, `static/shotstory.js`, `static/sessionstory.js`):
  At the top of the swings area during normal recording (any mode except running a coach program), the bay screen shows a golfer-friendly "Last swing" card (`#bay-card`) built from the coach's findings: verdict chip (Good shot / Playable / Miss), What happened (flight in plain English), Why (why it worked on a good shot, or the top body fault), Try this (the coach's swing thought in large type and drill in smaller type), and Still there when another fault showed up. Font sizes are kept large for viewing across the bay (>= 22 px desktop, >= 18 px at 390 px) and a link opens the swing on the review page (`/#<name>`). Swings and good-shot data are rate-limited to at most every 20 seconds.
  When the owner presses Stop and the session had 10+ swings with a shot, an end-of-session card appears at the top of the swings area with `SwingSessionStory.story`: headline comparing good shots against previous sessions, best and worst clubs, the session's top fault with its swing thought, and a "Watch my best swing" link (`/#<name>`). The card stays visible until the next Start. Plain words only, calm colors, never red.
- **Start page focus card** (`start.html`, `static/goal.js`, `#focus-card`):
  Positioned near the top of the hitting screen (above `#bay-card`), the focus card keeps your current goal in view while hitting:
  - Focus move name and club or club group in plain words (e.g. "Work on the lead hip getting to the target in the downswing · 7 iron").
  - **Today's progress score**: `k of n swings in your target today` with a miniature SVG score ring, calculated from the session's swings via `SwingGoal.score(todayRows, focus, target)`.
  - **Last swing feedback**: the latest swing's number on the move, an "in target" or "out of target" badge in plain words and calm colors, and the focus's swing thought when out of target. Says "waiting for the swing's numbers" while processing.
  - **Target in words**: target value and baseline source (e.g. "Target: over 2.0 in, your usual before you started") and the share in target before you started.
  - When no focus is set: a quiet line "No focus set: pick one on Progress" linking to `/`.
