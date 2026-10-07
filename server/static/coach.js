// Coaching for "What helps, what hurts" (helps.js): each body move in golf terms, both ways, with a
// drill and a swing thought; and each result in golf terms (what the ball does). A right-handed
// golfer (the trends assume one, swings.py LEAD_SIDE).
//
// Signs, as metrics.js measures them (summary.js BODY):
//   face-on: hipSway / headSway + toward the target, handsAhead + hands toward the target of the
//     ball at impact, headRise + up, spineTiltImpact + tilted away
//     from the target (trail shoulder lower); turns + more turned; lagP5 + more wrist hinge (lead
//     arm to shaft, 90 = an L) with the lead arm parallel coming down; releaseArm + the lead arm
//     higher when the hinge goes (an earlier release: casting).
//   down the line: earlyExt + hips toward the ball, bendLoss - standing up (lost forward bend),
//     headToBall + head toward the ball, handsPlane + hands above the address shaft line (outside,
//     over the top), shaftPlane + steeper than at address, handHeight + hands above the shoulders,
//     handDepth + hands deeper (further from the ball than the shoulders).
//
// General instruction, not a lesson: a coach watching the swing trumps it.
//
// Works in the browser (window.SwingCoach) and in Node (module.exports).
(function (root) {
  // move key -> {what, more: {name, how, drill, thought, fault}, less: {...}}: `name` says the move
  // that way in golf terms ("over the top"), `how` what it means in the swing; `fault`: a swing fault
  // in its own right (over the top, early extension, diving, standing up), never offered as a fix
  // even when your numbers point that way.
  const MOVES = {
    tempo: {
      what: "tempo: backswing time over downswing time (tour players are near 3 : 1)",
      more: { name: "an unhurried backswing and a committed downswing",
        how: "The backswing takes longer against the downswing: more time to set the club at the top, then all the speed on the way down.",
        drill: "Tempo count: say \"one-two-three\" to the top and \"four\" at impact. Hit 10 balls at 70% with a mid iron, saying it out loud.",
        thought: "Smooth back, go through." },
      less: { name: "a brisker backswing into the downswing",
        how: "The backswing is quicker against the downswing: less time hanging at the top, so the swing flows as one motion.",
        drill: "Metronome tick-tock (~76 bpm): start back on \"tick\", reach the top on \"tock\", hit on the next \"tick\". 10 balls.",
        thought: "Keep it moving at the top." },
    },
    backswing: {
      what: "backswing time: takeaway to the top",
      more: { name: "a slower, fuller backswing",
        how: "More time going back: a longer, more complete turn before the club changes direction.",
        drill: "Slow-motion rehearsal: three 3-second backswings to a full turn, then hit one at normal speed keeping the same length. Repeat 5 times.",
        thought: "Finish the turn before you start down." },
      less: { name: "a shorter, snappier backswing",
        how: "Less time going back: a more compact swing that is easier to repeat.",
        drill: "9-to-3 drill: hands stop at shoulder height back and through. 10 balls, then 5 full swings keeping the feel.",
        thought: "Short and snappy." },
    },
    downswing: {
      what: "downswing time: the top to impact",
      more: { name: "a smoother, less rushed downswing",
        how: "The downswing takes longer: no lunge from the top, so the body can sequence and the face can square.",
        drill: "80% swings: hit 10 balls at 80% and hold a balanced finish for 3 seconds each time.",
        thought: "Smooth transition, hold the finish." },
      less: { name: "a faster downswing (more speed)",
        how: "The downswing takes less time: more clubhead speed through the ball.",
        drill: "Whoosh drill: hold the club by the head, swing the grip end and make the whoosh loudest past where the ball would be. 5 swings, then hit 5.",
        thought: "Whoosh after the ball." },
    },
    shoulderTop: {
      what: "shoulder turn at the top",
      more: { name: "a fuller shoulder turn",
        how: "The chest turns further away from the target at the top: a bigger coil and a longer arc.",
        drill: "Cross-arm turn: club across your chest, turn until the shaft points at the ball or past it. 5 turns, then hit 5 balls feeling your back face the target.",
        thought: "Back to the target." },
      less: { name: "a shorter, more controlled shoulder turn",
        how: "The chest turns less at the top: a compact backswing that is easier to square up.",
        drill: "Three-quarter swings: stop when your lead arm is parallel to the ground. 10 balls.",
        thought: "Wider, not longer." },
    },
    pelvisTop: {
      what: "hip turn at the top",
      more: { name: "a freer hip turn going back",
        how: "The hips turn more in the backswing, which lets the shoulders turn fully without straining.",
        drill: "Trail-pocket drill: in the backswing feel your trail back pocket move behind you; let the lead heel come up slightly if it wants. 10 balls.",
        thought: "Trail pocket back." },
      less: { name: "quieter hips going back",
        how: "The hips turn less in the backswing while the shoulders turn: more coil against the trail leg.",
        drill: "Trail-knee drill: set up with a ball under the outside of your trail foot; keep the trail knee flexed and still to the top. 10 balls.",
        thought: "Turn the shoulders over stable hips." },
    },
    xFactor: {
      what: "X-factor: how much more the shoulders turn than the hips at the top",
      more: { name: "more shoulder-hip separation",
        how: "The shoulders turn well past the hips at the top: more stretch to unwind.",
        drill: "Half-hip, full-shoulder rehearsals: feel the belt buckle turn half as far as the chest. 5 slow ones, then hit 5.",
        thought: "Coil against the trail leg." },
      less: { name: "the hips turning with the shoulders",
        how: "Less gap between shoulders and hips at the top: an easier, freer turn.",
        drill: "Flared-foot drill: flare the lead foot 30° at address and let the hips turn freely with the chest. 10 balls.",
        thought: "Turn together." },
    },
    hipSway: {
      what: "hip slide toward the target at impact (against address)",
      more: { name: "more of a hip bump toward the target",
        how: "The hips shift further toward the target by impact: weight gets onto the lead side and the low point moves ahead of the ball.",
        drill: "Bump drill: alignment stick in the ground a few inches outside your lead hip; start down by bumping the lead hip to the stick, then rotate. 10 balls.",
        thought: "Bump, then turn." },
      less: { name: "less hip slide, more rotation",
        how: "The hips slide less toward the target and turn more: the body stays centred and the club can swing out in front.",
        drill: "Stick-outside-lead-hip drill: stick 1-2 inches outside your lead hip at address; swing without touching it, turning the belt buckle to the target. 10 balls.",
        thought: "Belt buckle to the target, not to the side." },
    },
    pelvisBall: {
      what: "the pelvis's middle against the ball at impact (+ = ahead of it, toward the target)",
      more: { name: "the pelvis further ahead of the ball at impact",
        how: "By impact the pelvis has moved toward the target, to or past the ball: weight is on the lead side and the low point moves ahead of the ball.",
        drill: "Step-and-fire: feet together at the top of a slow backswing, step the lead foot toward the target and swing as it lands. 10 reps, then 10 balls.",
        thought: "Belt buckle past the ball." },
      less: { name: "the pelvis staying further behind the ball at impact",
        how: "The pelvis stays back of the ball through impact: the body stays behind it and the low point moves back.",
        drill: "Stick-outside-lead-hip drill: stick 1-2 inches outside your lead hip at address; turn through without bumping it. 10 balls.",
        thought: "Turn, don't slide." },
    },
    chestBall: {
      what: "the chest's middle (between the shoulders) against the ball at impact (+ = ahead of it)",
      more: { name: "the chest further over or ahead of the ball at impact",
        how: "The chest gets over the ball by impact: the low point follows it forward, for a more downward strike.",
        drill: "Lead-side drill: set up with 60% of your weight on the lead foot and keep it there; half swings, 10 balls.",
        thought: "Chest over the ball." },
      less: { name: "the chest staying further behind the ball at impact",
        how: "The chest stays behind the ball through impact: more upward strike, the low point further back.",
        drill: "Head-behind drill: put a tee in the ground just behind the ball's line opposite your nose; keep your nose behind it until after impact. 10 balls.",
        thought: "Stay behind it." },
    },
    leadHipP6: {
      what: "the outside of the lead hip in the downswing against its line at address (toward the target)",
      more: { name: "the lead hip getting to the target in the downswing",
        how: "In transition the lead hip moves toward the target, past its address line, before the arms come down: weight gets to the lead side and the low point moves ahead of the ball.",
        drill: "Hip-to-the-stick drill: alignment stick in the ground just outside your lead hip at address. From the top, bump the lead hip into the stick before the arms start down, then turn. 10 slow reps, then 10 balls.",
        thought: "Lead hip to the target first." },
      less: { name: "the lead hip hanging back in the downswing", fault: true,
        how: "The lead hip is still on (or behind) its address line when the hands reach hip height: the weight stays back and the arms do the work.",
        drill: "Step-and-fire: feet together at the top of a slow backswing, step the lead foot toward the target and swing as it lands. 10 reps, then 10 balls.",
        thought: "Step, then swing." },
    },
    trailHipTop: {
      what: "the outside of the trail hip at the top against its line at address (toward the target)",
      more: { name: "the trail hip staying inside its line at the top",
        how: "The trail hip turns back without sliding away from the target: the body coils over the trail leg instead of drifting off the ball.",
        drill: "Trail-hip wall drill: set up with the outside of your trail hip an inch from a wall (or a stick in the ground); turn to the top without touching it. 10 slow reps, then 10 balls.",
        thought: "Turn in a barrel." },
      less: { name: "swaying off the ball (trail hip past its line at the top)", fault: true,
        how: "The trail hip slides away from the target past its address line: the body has to slide back to get to the ball, and the low point moves around.",
        drill: "Trail-hip wall drill: stick or wall an inch outside your trail hip at address; turn to the top without touching it. 10 slow reps, then 10 balls.",
        thought: "Turn, don't slide." },
    },
    handsAhead: {
      what: "hands ahead of the ball at impact (toward the target)",
      more: { name: "hands further ahead of the ball at impact",
        how: "The hands lead the clubhead into the ball: the shaft leans toward the target and the club comes in on a more downward strike, the low point moving ahead of the ball.",
        drill: "Lead foot only: trail foot back on its toe, 3/4 swings brushing the mat at or ahead of the ball. 10 reps, then 10 balls the same way.",
        thought: "Hands to the lead thigh." },
      less: { name: "hands level with or behind the ball at impact (flipping)", fault: true,
        how: "The clubhead passes the hands before the ball: the wrists flip, adding loft and moving the low point back.",
        drill: "Impact bag or towel: half swings stopping at impact with the hands over the lead thigh and the shaft leaning forward. 10 reps, then 10 balls.",
        thought: "Handle first." },
    },
    headSway: {
      what: "head movement toward the target at impact",
      more: { name: "the head moving more toward the target",
        how: "The head drifts toward the target by impact: the chest gets more over the ball.",
        drill: "Lead-side drill: set up with 60% of your weight on the lead foot and keep it there; half swings, 10 balls.",
        thought: "Chest over the ball." },
      less: { name: "the head staying behind the ball",
        how: "The head stays back (or behind its address spot) through impact, so the body doesn't slide past the ball.",
        drill: "Head-behind drill: put a tee in the ground just behind the ball's line opposite your nose; keep your nose behind it until after impact. 10 balls.",
        thought: "Stay behind it." },
    },
    headRise: {
      what: "head height at impact against address",
      more: { name: "posting up through impact",
        how: "The head rises a little by impact as the lead leg straightens: room for the arms and more speed.",
        drill: "Lead-leg post drill: from the top, feel the lead leg straighten and push the ground as the club reaches the ball. Half swings, 10 balls.",
        thought: "Post up on the lead leg." },
      less: { name: "keeping your height",
        how: "The head stays at its address height through impact: the bottom of the swing stays where you set it.",
        drill: "Mirror-line drill: set up facing the camera or a mirror, put a piece of tape at the top of your head, and keep your head under it through impact. 10 balls.",
        thought: "Stay in your posture." },
    },
    spineTiltImpact: {
      what: "spine tilt away from the target at impact",
      more: { name: "more tilt away from the target (trail shoulder under)",
        how: "The upper body leans more away from the target at impact, trail shoulder lower: a shallower, more from-the-inside strike.",
        drill: "Trail-shoulder-under drill: at address let the hips shift slightly toward the target so the spine tilts away; hit half shots keeping that tilt through impact. 10 balls.",
        thought: "Trail shoulder under." },
      less: { name: "staying more on top of the ball",
        how: "Less lean away from the target at impact: the chest is over the ball, which helps a descending strike.",
        drill: "Chest-over-ball drill: half swings with 70% of your weight on the lead foot, chest over the ball at impact. 10 balls.",
        thought: "Chest over the ball." },
    },
    lagP5: {
      what: "wrist hinge (lead arm to shaft) with the lead arm parallel coming down",
      more: { name: "holding your wrist hinge longer (lag)",
        how: "The angle between the lead arm and the shaft stays near an L until the hands are past the trail hip: the clubhead comes in late and from above.",
        drill: "Pump drill: from the top, pull the hands down to the trail hip keeping the L between lead arm and shaft, pump twice, then swing through. 10 balls.",
        thought: "Hands to the hip, then let it go." },
      less: { name: "losing your wrist hinge early (casting)", fault: true,
        how: "The wrists unhinge from the top, throwing the clubhead out early: weak, high or thin shots and a flip at impact.",
        drill: "Towel drill: tuck a towel under the lead armpit and make half swings holding the hinge until the hands pass the trail thigh. 10 balls.",
        thought: "Butt of the club to the ball." },
    },
    releaseArm: {
      what: "how high the lead arm still is when the wrist hinge goes coming down (higher = earlier)",
      more: { name: "releasing early, with the arms still high (casting)", fault: true,
        how: "The club is let go from the top, before the hands get down: it reaches the bottom too early and comes up into the ball (shallow or upward strike).",
        drill: "Drag drill: start at the top, drag the grip down toward the ball with the hands leading to hip height before the clubhead passes them. Half speed, 10 balls.",
        thought: "Drag the handle." },
      less: { name: "a later release, with the hands down low first",
        how: "The wrists keep their hinge until the hands are around hip height, then release: a downward strike with the hands ahead at impact.",
        drill: "9-to-3 drill: half swings, hands at 9 o'clock back and 3 through, holding the hinge until the hands reach the trail thigh. 10 balls.",
        thought: "Hands first, club second." },
    },
    earlyExt: {
      what: "hips moving toward the ball by impact (early extension when they do)",
      more: { name: "the hips moving toward the ball (early extension)", fault: true,
        how: "The hips thrust in toward the ball through impact (early extension): the body stands up and the arms get crowded.",
        drill: "Ground-push drill: from the top, push the ground with both feet so you stand up through the finish. Half swings, 10 balls.",
        thought: "Push the ground." },
      less: { name: "keeping your hips back (no early extension)",
        how: "The hips stay back where they were at address through impact: room for the arms to swing through and the posture stays.",
        drill: "Chair drill: set up with your backside just touching a chair or your golf bag; keep the lead hip touching it until after impact. 10 balls.",
        thought: "Tush on the wall." },
    },
    bendLoss: {
      what: "forward bend at impact against address (lower = standing up)",
      more: { name: "keeping your forward bend",
        how: "Your chest stays down at the ball through impact instead of standing up: steadier contact and less room for a flip.",
        drill: "Chest-down drill: half shots feeling your chest point at the ball until the club is past your lead thigh. 10 balls.",
        thought: "Chest down, through." },
      less: { name: "standing up through impact", fault: true,
        how: "You come up out of your address bend by impact: the chest rises and the arms get room.",
        drill: "Post-and-rotate drill: through impact straighten the lead leg and turn your chest up to the target. Half swings, 10 balls.",
        thought: "Post and rotate." },
    },
    headToBall: {
      what: "head moving toward the ball by impact",
      more: { name: "the head moving toward the ball", fault: true,
        how: "The head dives toward the ball through impact: the body drops in.",
        drill: "Stay-down drill: hit half shots keeping your eyes on the back of the ball and your chest over it until well after impact. 10 balls.",
        thought: "Stay down through it." },
      less: { name: "the head staying out of the ball",
        how: "The head doesn't dive toward the ball: your posture holds and the club has room.",
        drill: "Headcover drill: have someone hold a headcover lightly against your forehead at address (or rest it on an alignment stick); don't push into it during the swing. 10 balls.",
        thought: "Head stays in its box." },
    },
    handsPlaneP6: {
      what: "hands against the address shaft line in the downswing (shaft parallel to the ground)",
      more: { name: "hands higher and further out in the downswing (over the top)", fault: true,
        how: "Coming down, the hands move out over the address shaft line instead of dropping under it: an out-to-in, steeper delivery.",
        drill: "Chest-leads drill: from the top, turn the chest harder toward the target so the hands come in front of you instead of getting stuck behind. 10 balls.",
        thought: "Chest leads, hands in front." },
      less: { name: "hands dropping to the trail pocket in the downswing",
        how: "Coming down, the hands drop inside and under the address shaft line: the club approaches from the inside, shallower.",
        drill: "Pump drill: go to the top, pump the hands down to your trail pocket twice with the shaft parallel to the ground, then swing through. Add a headcover just outside and behind the ball and miss it. 10 balls.",
        thought: "Hands drop to the trail pocket." },
    },
    shaftPlaneP6: {
      what: "shaft steepness in the downswing against address",
      more: { name: "a steeper shaft coming down",
        how: "The shaft is more upright than its address angle coming down: the clubhead is over the hands, not behind them.",
        drill: "Clubhead-over-hands drill: in slow motion, stop with the shaft parallel to the ground coming down and check the clubhead sits over your hands, not behind you. 5 slow, then 5 balls.",
        thought: "Clubhead over the hands." },
      less: { name: "a shallower shaft coming down",
        how: "The shaft flattens out below its address angle coming down: a shallow, from-the-inside delivery.",
        drill: "Shallowing drill: at the top, feel the trail elbow drop in front of the trail hip while the clubhead falls behind you. 5 slow rehearsals, then 5 balls.",
        thought: "Lay it down." },
    },
    handsPlaneTop: {
      what: "hands against the address shaft line at the top",
      more: { name: "hands higher above the plane at the top (more upright)",
        how: "At the top the hands sit higher above the address shaft line: a more upright, steeper backswing.",
        drill: "Tall-top drill: at the top feel your trail arm extend up and the hands high over the trail shoulder. 10 balls.",
        thought: "High hands." },
      less: { name: "a flatter backswing (hands nearer the plane)",
        how: "At the top the hands sit closer to the address shaft line: a flatter, more rounded backswing.",
        drill: "Plane-stick drill: lay an alignment stick against your trail hip along the shaft's address angle; swing back so the hands finish near it. 10 balls.",
        thought: "Turn, don't lift." },
    },
    handHeightTop: {
      what: "hand height at the top against the shoulders",
      more: { name: "higher hands at the top",
        how: "The hands finish higher above the shoulders at the top: more width and a longer arc.",
        drill: "Wide-and-tall drill: extend the lead arm and push the hands up at the top, trail elbow away from your side. 10 balls.",
        thought: "Width and height." },
      less: { name: "lower hands at the top",
        how: "The hands finish lower at the top: a flatter, more body-driven swing.",
        drill: "Towel drill: tuck a towel under your lead armpit and keep it there to the top. 10 balls.",
        thought: "Arm stays connected." },
    },
    handDepthTop: {
      what: "hand depth at the top (how far behind you)",
      more: { name: "deeper hands at the top",
        how: "At the top the hands sit further behind you, over the trail shoulder: room to drop the club inside.",
        drill: "Trail-shoulder drill: at the top, hands over the trail shoulder and the trail elbow pointing at the ground. 5 checks, then 5 balls.",
        thought: "Hands over the trail shoulder." },
      less: { name: "hands more in front of your chest at the top",
        how: "At the top the hands stay more in front of the chest: less chance to get stuck behind you coming down.",
        drill: "In-front drill: rehearse backswings keeping the grip in front of your sternum; stop and check, then hit 5.",
        thought: "Hands in front of the chest." },
    },
    armsLed: {
      what: "downswing sequence: arms leading the downswing before the body",
      more: { name: "an arms-led downswing", fault: true,
        how: "The arms start down before the lower body: the club comes from the outside, steep, and the low point moves back.",
        drill: "Step and fire (the coach's Sequence Tier 1): feet together, swing back, step the lead foot to the target and turn the belt buckle to the target as it lands, hands following. Or pause one second at the top and start down with the lead hip alone, the arms waiting. 10 reps, then 10 balls.",
        thought: "Buckle to the target first." },
      less: { name: "a body-led downswing (pelvis first)",
        how: "The pelvis turns toward the target before the arms start down, leading the downswing.",
        drill: "Step-through drill: step into the lead side as the downswing starts. 10 balls.",
        thought: "Buckle to the target first." },
    },
  };

  // result key -> {more, less}: what the ball does, that way, in golf terms; target: where the
  // number should be for a right-hander (null: no target, only better/worse), band: how close to
  // the target counts as there already.
  const RESULTS = {
    carry: { more: "longer carry", less: "shorter carry" },
    absOffline: { more: "further off the line", less: "closer to the line" },
    offline: { more: "further right (push/slice side)", less: "further left (pull/hook side)", target: 0, band: 3, unit: " yd",
               side: ["left", "right"] },
    smash: { more: "better contact (higher smash)", less: "worse contact (lower smash)" },
    ballSpeed: { more: "more ball speed", less: "less ball speed" },
    clubSpeed: { more: "more club speed", less: "less club speed" },
    path: { more: "a more in-to-out path (pushes, draws, hooks)", less: "a more out-to-in path (over the top: pulls, fades, slices)", target: 0, band: 1,
            unit: "°", side: ["out-to-in", "in-to-out"] },
    face: { more: "a more open face (starts right)", less: "a more closed face (starts left)", target: 0, band: 1, unit: "°",
            side: ["closed", "open"] },
    faceToPath: { more: "more fade/slice curve (face open to the path)", less: "more draw/hook curve (face closed to the path)", target: 0, band: 1,
                  unit: "°", side: ["closed to the path (draw)", "open to the path (fade)"] },
    absFaceToPath: { more: "more curve", less: "straighter flight (less curve)" },
    attack: { more: "a shallower, more upward strike (thin risk with irons)", less: "a steeper strike (deeper divots, fat risk)",
              target: { irons: -4, woods: 0, driver: 2 }, band: 1, unit: "°", side: ["steeper than that", "shallower than that"] },
    loft: { more: "more dynamic loft (higher, weaker flight)", less: "less dynamic loft (lower, more penetrating flight)" },
    launch: { more: "a higher launch", less: "a lower launch" },
    spin: { more: "more spin", less: "less spin" },
    strikeH: { more: "strike moving one way across the face", less: "strike moving the other way across the face", target: 0, band: 5,
               unit: " mm", side: ["off centre one way", "off centre the other way"] },
    strikeV: { more: "strike higher on the face", less: "strike lower on the face (thin side)", target: 0, band: 5, unit: " mm",
               side: ["low on the face", "high on the face"] },
  };

  const LABELS = { offline: "offline", path: "club path", face: "face to target", faceToPath: "face to path",
                   attack: "attack angle", strikeH: "strike toe/heel", strikeV: "strike high/low" };

  /** The target for a result with a club: a number, or null. */
  function targetOf(result, club) {
    const t = RESULTS[result] && RESULTS[result].target;
    if (t == null || typeof t === "number") return t ?? null;
    if (club === "DR") return t.driver;
    return /^(DR|[WH]\d|\d[WH])$/.test(club || "") ? t.woods : t.irons;
  }

  /**
   * Which way to take the move, for a link from helps.js: {aim: "more" | "less" | null, why}.
   * Better-or-worse results: the way that helps. Results with a target: the way that brings your
   * usual number (l.median) toward it; null when it's already within the band (the link then only
   * explains your spread). Others: null.
   */
  function aimOf(l, club) {
    const rs = RESULTS[l.result];
    if (!rs) return { aim: null, why: "" };
    // helps.js: `helps` = more of the move takes the result the better way (it already folds in
    // which way the result goes), so it alone says the aim.
    if (l.helps != null) return { aim: l.helps ? "more" : "less", why: "" };
    const target = targetOf(l.result, club);
    if (target == null || l.median == null) return { aim: null, why: "" };
    const need = target - l.median;
    if (Math.abs(need) <= rs.band) {
      return { aim: null, why: `your usual is already close to ${target === 0 ? "neutral" : "the target"}: this mostly explains your swing-to-swing spread, so keep the move steady` };
    }
    const usual = `${Math.abs(l.median) < 10 ? Math.abs(l.median).toFixed(1) : Math.abs(l.median).toFixed(0)}${rs.unit || ""}`;
    const aimAt = target === 0 ? "neutral" : `${target > 0 ? "+" : ""}${target}${rs.unit || ""}`;
    return { aim: (need > 0) === (l.effect > 0) ? "more" : "less", toward: aimAt,
             why: `yours runs ${rs.side[l.median - target < 0 ? 0 : 1]}: ${usual}${target === 0 ? "" : ` against ${aimAt}`}` };
  }

  /**
   * The coaching for a link: {what (the move), when (more of it, in golf terms), then (what the ball
   * does), aim, why, fix: {name, how, drill, thought} | null, fault (when the way that would help is
   * a fault: its name, and no fix)}.
   */
  function coach(l, club) {
    const mv = MOVES[l.move], rs = RESULTS[l.result];
    if (!mv || !rs) return null;
    const way = l.effect >= 0 ? rs.more : rs.less;
    const { aim, why, toward } = aimOf(l, club);
    if (aim && mv[aim].fault) {
      return { what: mv.what, when: mv.more.name, then: way, aim: null, fault: mv[aim].name,
               why: `the way that would help here is ${mv[aim].name}, a swing fault in its own right: not worth chasing; work on the plan's other moves` };
    }
    // What working on it does for this result: "club path back toward neutral", or "longer carry".
    const goal = !aim ? null : toward ? `${LABELS[l.result] || l.result} back toward ${toward} (${why})`
      : ((aim === "more") === (l.effect >= 0) ? rs.more : rs.less);
    return { what: mv.what, when: mv.more.name, then: way, aim, why, goal, fix: aim ? mv[aim] : null };
  }

  const api = { MOVES, RESULTS, targetOf, aimOf, coach };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingCoach = api;
})(typeof window !== "undefined" ? window : globalThis);
