// One swing in plain words, for the coaching card at the top of the swing view: what the ball did
// (Square's numbers turned into a shot shape and its cause), whether it was a good shot for you with
// that club, why, and one thing to try. No P-numbers: positions are named as a golfer says them
// (top of swing, downswing, impact).
//
// Ball flight, right-handed golfer, Square's signs: path + = in-to-out, face + = open (right of the
// target), face to path = face - path (+ = open to the path: curves right), direction and offline
// + = right. The ball starts mostly where the face points and curves away from the path: path -4.5
// with face to path +2 is a face 2.5 closed to the target, so it starts left and curves right, a
// pull-fade (not a slice).
//
// Uses SwingCoach (coach.js) for drills and swing thoughts and SwingGoodShots (goodshots.js) for
// the good-shot rules, so the card says what the rest of the app says.
//
// Works in the browser (window.SwingShotStory) and in Node (module.exports).
(function (root) {
  const Coach = root.SwingCoach || (typeof require !== "undefined" && require("./coach.js"));
  const GoodShots = root.SwingGoodShots || (typeof require !== "undefined" && require("./goodshots.js"));

  // Start line: within this many degrees of the target counts as on line (~5 yd at 150).
  const START_STRAIGHT = 2;
  // Curve from face to path when there's no spin axis, degrees: within CURVE_STRAIGHT is straight,
  // past CURVE_BIG a slice/hook.
  const CURVE_STRAIGHT = 1.5, CURVE_BIG = 4;
  // The same from spin axis: each degree curved the owner's shots ~0.8% of carry, so 3 is ~2% (on
  // line) and past 10 ~10% of carry (15 yd at 150).
  const AXIS_STRAIGHT = 3, AXIS_BIG = 10;
  // Club path within this many degrees is neutral; face within FACE_SQUARE is square.
  const PATH_NEUTRAL = 2, FACE_SQUARE = 1.5;

  const finite = v => typeof v === "number" && Number.isFinite(v);
  const deg = v => `${Math.abs(v).toFixed(1)}°`;
  const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

  // Key positions as a golfer says them.
  const PHASES = {
    p1: "setup", takeaway: "takeaway", p2: "early backswing", p3: "backswing", p4: "top of swing",
    p5: "early downswing", p6: "downswing", p7: "impact", p8: "follow-through",
  };

  // Body numbers (summary.js BODY) without P-numbers or lab words.
  const LABELS = {
    tempo: "Tempo", backswing: "Backswing time", downswing: "Downswing time",
    shoulderTop: "Shoulder turn at the top of swing", pelvisTop: "Hip turn at the top of swing",
    xFactor: "Shoulders turned past the hips at the top of swing", hipSway: "Hip slide at impact",
    leadHipP6: "Lead hip in the downswing", trailHipTop: "Trail hip at the top of swing",
    handsAhead: "Hands ahead of the ball at impact", pelvisBall: "Hips vs the ball at impact",
    chestBall: "Chest vs the ball at impact", headSway: "Head slide at impact", headRise: "Head height at impact",
    spineTiltImpact: "Spine tilt at impact", lagP5: "Wrist hinge early in the downswing",
    releaseArm: "When the wrists let go in the downswing", earlyExt: "Hips toward the ball at impact",
    bendLoss: "Posture held through impact", headToBall: "Head toward the ball at impact",
    handsPlaneP6: "Hands to plane in the downswing", shaftPlaneP6: "Shaft to plane in the downswing",
    handsPlaneTop: "Hands to plane at the top of swing", handHeightTop: "Hand height at the top of swing",
    handDepthTop: "Hand depth at the top of swing",
  };

  // Fault names (faults.js) with what they mean, in a few words.
  const FAULT_WHY = {
    earlyExt: "your hips moved toward the ball at impact, so you had to stand up out of it",
    bendLoss: "you stood up through impact, losing the posture you set up with",
    handsPlaneP6: "your hands moved out over the plane in the downswing, so the club came across the ball",
    headToBall: "your head moved toward the ball at impact",
    hipSway: "your hips slid toward the target instead of turning",
    releaseArm: "the wrists let go of their hinge early in the downswing",
    armsLed: "your arms started down before your hips",
  };
  const HEAD_WHY = { "head dip": "your head dropped through impact", "head lift": "your head lifted through impact" };

  // What a body number inside your good-shot range means, best first: the first readable one is
  // what the card says worked.
  const WORKED = [
    ["handsAhead", "your hands were leading the clubhead at impact, like on your best shots: that's what compresses the ball"],
    ["earlyExt", "your hips kept their distance from the ball through impact, like on your best shots"],
    ["bendLoss", "you held your posture through impact, like on your best shots"],
    ["handsPlaneP6", "your hands dropped in on plane in the downswing, like on your best shots"],
    ["releaseArm", "you held the wrist hinge into the downswing, like on your best shots"],
    ["hipSway", "your hips turned instead of sliding, like on your best shots"],
    ["headRise", "your head stayed level through impact, like on your best shots"],
    ["shoulderTop", "your shoulder turn at the top of swing matched your best shots"],
    ["tempo", "your tempo matched your best swings"],
  ];

  /** Any P-number in a sentence (P1-P8) in golfer's words: "at P6" -> "in the downswing". */
  function plain(text) {
    if (!text) return text;
    const at = { p1: "at setup", p2: "in the early backswing", p3: "in the backswing", p4: "at the top of swing",
                 p5: "early in the downswing", p6: "in the downswing", p7: "at impact", p8: "in the follow-through" };
    return text
      .replace(/\b(?:at|by|in) P([1-8])\b/g, (_, n) => at["p" + n])
      .replace(/\bP([1-8])\b/g, (_, n) => PHASES["p" + n])
      .replace(/ \((?:shaft parallel in the downswing|lead arm parallel[^)]*)\)/g, "");
  }

  /** A body number's plain label (summary.js key), or the key. */
  function label(key) { return LABELS[key] || key; }

  /**
   * The shot's shape from Square's numbers (summary.js shotNumbers): {start: "left" | "straight" |
   * "right" | null, curve: "left" | "none" | "right" | null, big, shape ("pull-fade"), path, face,
   * text (one sentence: what the ball did), cause (why, from the club), null when there's nothing}.
   */
  function flight(s) {
    if (!s) return null;
    const startDeg = finite(s.direction) ? s.direction : finite(s.face) ? s.face : null;
    const start = startDeg == null ? null : Math.abs(startDeg) <= START_STRAIGHT ? "straight" : startDeg < 0 ? "left" : "right";
    // The curve from the ball's own spin axis when Square has it: on the owner's 501 shots it agreed
    // with the way the ball curved every time (face to path, worked out from the club, 98%).
    let curve = null, big = false;
    if (finite(s.spinAxis)) {
      curve = Math.abs(s.spinAxis) <= AXIS_STRAIGHT ? "none" : s.spinAxis > 0 ? "right" : "left";
      big = Math.abs(s.spinAxis) > AXIS_BIG;
    } else if (finite(s.faceToPath)) {
      curve = Math.abs(s.faceToPath) <= CURVE_STRAIGHT ? "none" : s.faceToPath > 0 ? "right" : "left";
      big = Math.abs(s.faceToPath) > CURVE_BIG;
    }
    if (start == null && curve == null) return null;

    // Started one way and curved back: a slice or hook only when it finished well off line on the
    // curve's side (5% of carry), else the pull-fade / push-draw golfers play on purpose.
    const back = (start === "left" && curve === "right") || (start === "right" && curve === "left");
    if (big && back && finite(s.offline) && finite(s.carry) && s.carry > 0) {
      big = (curve === "right" ? s.offline : -s.offline) > 0.05 * s.carry;
    }
    const bend = curve === "right" ? (big ? "slice" : "fade") : curve === "left" ? (big ? "hook" : "draw") : "";
    let shape;
    if (start === "straight" || start == null) shape = bend || "straight";
    else shape = (start === "left" ? "pull" : "push") + (bend ? "-" + bend : "");
    if (start == null && !bend) shape = null;

    const startText = start === "straight" ? "started on line" : start ? `started ${start} of the target` : "";
    const curveText = curve === "none" ? (start === "straight" ? "flew straight" : "held its line")
      : curve ? `curved ${big ? "hard " : ""}${curve === "right" ? (start === "right" ? "further right" : start === "left" ? "back to the right" : "to the right")
                                                               : (start === "left" ? "further left" : start === "right" ? "back to the left" : "to the left")}` : "";
    const what = [startText, curveText].filter(Boolean).join(" and ");
    const text = shape ? `${cap(shape)}: the ball ${what}.` : `The ball ${what}.`;
    return { start, curve, big, shape, path: finite(s.path) ? s.path : null, face: finite(s.face) ? s.face : null, text,
             cause: cause(s, curve) };
  }

  /** Why the ball did that, from the club: path, then the face to the target and to the path. */
  function cause(s, curve) {
    if (!finite(s.path) || !finite(s.face)) return null;
    const p = s.path, f = s.face, ftp = finite(s.faceToPath) ? s.faceToPath : f - p;
    const path = Math.abs(p) <= PATH_NEUTRAL ? "your club swung straight down the target line"
      : p < 0 ? `your club swung out-to-in (${deg(p)} across the ball)` : `your club swung in-to-out (${deg(p)} out to the right)`;
    const toTarget = Math.abs(f) <= FACE_SQUARE ? "the face was square to the target"
      : `the face pointed ${f < 0 ? "left" : "right"} of the target`;
    const toPath = Math.abs(ftp) <= CURVE_STRAIGHT ? "matched the path" : `${ftp > 0 ? "open" : "closed"} to the path`;
    // "but" when the two point different ways: closed to the target (left) but open to the path.
    const side = (v, band) => Math.abs(v) <= band ? 0 : Math.sign(v);
    const joint = side(f, FACE_SQUARE) === side(ftp, CURVE_STRAIGHT) ? " and " : " but ";
    // The rule of thumb only when the club's numbers agree with the curve the ball showed.
    const bent = curve === "right" ? 1 : curve === "left" ? -1 : 0;
    const rule = bent && side(ftp, CURVE_STRAIGHT) === bent ? " The ball starts where the face points and curves away from the path." : "";
    return `${cap(path)}, and ${toTarget}${joint}${toPath}.${rule}`;
  }

  /**
   * Good, playable or a miss, for you with this club: good = passes your good-shot rules
   * (goodshots.js judgeShot); playable = within twice the offline allowance and not more than 15%
   * short of your usual carry; else a miss. {level: "good" | "ok" | "miss", text, fails} or null
   * when there's no baseline for the club yet.
   */
  function verdict(s, judged, baseline, group, settings) {
    if (!s || !judged || !baseline) return null;
    if (judged.good) return { level: "good", text: "Good shot", fails: [] };
    if (!finite(s.carry) || !(s.carry > 0) || !finite(s.offline)) return null;
    const rules = GoodShots.withDefaults(settings)[group] || GoodShots.withDefaults(settings).irons;
    const offOk = Math.abs(s.offline) <= 2 * rules.offlinePct / 100 * s.carry;
    const carryOk = !finite(baseline.carry) || s.carry >= baseline.carry * 0.85;
    return offOk && carryOk ? { level: "ok", text: "Playable", fails: judged.fails }
      : { level: "miss", text: "Miss", fails: judged.fails };
  }

  /** What went wrong with the result, in a few words: off line (past the allowance, % of carry), short, off centre. */
  function missText(s, baseline, offlinePct) {
    const bits = [];
    if (finite(s.offline) && finite(s.carry) && s.carry > 0 && Math.abs(s.offline) > offlinePct / 100 * s.carry) {
      bits.push(`${Math.round(Math.abs(s.offline))} yd ${s.offline < 0 ? "left" : "right"}`);
    }
    if (baseline && finite(baseline.carry) && finite(s.carry) && s.carry < baseline.carry * 0.9) {
      bits.push(`${Math.round(baseline.carry - s.carry)} yd short of your usual carry`);
    }
    if (baseline && finite(baseline.smash) && finite(s.smash) && s.smash < baseline.smash - 0.05) {
      bits.push("off the centre of the face (less ball speed than usual)");
    }
    return bits.join(", ");
  }

  /**
   * The card: {verdict, what, why, tip: {thought, drill} | null, still: a fault on a good shot ({name,
   * thought, drill}) | null}; null when there's nothing to say.
   * @param input {shot: shotNumbers | null, judged (judgeShot) | null, baseline | null, group, settings,
   *   faults: scorecard faults (worst first; never from a shaky number), body: {key: number | null},
   *   trust: {key: trust.js judgement}, ranges: {key: goodshots range}}
   */
  function card(input) {
    const s = input.shot || null, fl = flight(s);
    const v = verdict(s, input.judged, input.baseline, input.group, input.settings);
    const fault = (input.faults || [])[0] || null;

    const rules = GoodShots.withDefaults(input.settings)[input.group] || GoodShots.withDefaults(input.settings).irons;
    let what = fl ? fl.text : "";
    if (v && v.level !== "good" && s) {
      const miss = missText(s, input.baseline, rules.offlinePct);
      if (miss) what = (what ? what.replace(/\.$/, "") + ": " : "") + miss + ".";
    }

    // What kind of miss: off line (past the good-shot offline allowance) or a strike off the centre.
    const offLine = !!s && finite(s.offline) && finite(s.carry) && s.carry > 0 && Math.abs(s.offline) > rules.offlinePct / 100 * s.carry;
    const b = input.baseline;
    const offCentre = !!s && !!b && finite(b.smash) && finite(s.smash) && s.smash < b.smash - 0.05;

    let why = "", tip = null, still = null;
    if (v && v.level === "good") {
      // A good shot: why it worked first; a fault that showed up anyway is a footnote, never the "why".
      const w = worked(input);
      why = w ? cap(w) + "." : (fl && fl.cause) || "";
      if (fault) still = { name: fault.name, thought: plain(fault.thought), drill: plain(fault.drill) };
    } else if (fault) {
      const f = fault.key === "headRise" ? HEAD_WHY[fault.name] : FAULT_WHY[fault.key];
      why = `${cap(fault.name)}: ${f || "the main thing on this swing"}.`;
      if (fault.thought || fault.drill) tip = { thought: plain(fault.thought), drill: plain(fault.drill) };
    } else if (v && !offLine && offCentre) {
      why = "Contact: you caught it off the centre of the face, so it lost ball speed and distance.";
    } else if (fl && fl.cause) {
      why = fl.cause;
    }
    // No body fault to work on and the ball went off line: a fix for the club's path, aimed at
    // neutral, never toward a fault.
    if (!tip && v && v.level !== "good" && offLine && fl && fl.path != null && fl.path < -PATH_NEUTRAL) {
      const m = Coach.MOVES.handsPlaneP6 && Coach.MOVES.handsPlaneP6.less;
      if (m && !m.fault) tip = { thought: plain(m.thought), drill: plain(m.drill) };
    }
    if (v && v.level === "good" && !tip) tip = { thought: "Same feel on the next one.", drill: "" };
    if (!what && !why && !tip && !v) return null;
    return { verdict: v, what, why, tip, still, shape: fl ? fl.shape : null };
  }

  /** The best thing that matched your good shots on this swing, as a sentence, or "". */
  function worked(input) {
    const inp = input || {};
    const body = inp.body || {}, trust = inp.trust || {}, ranges = inp.ranges || {};
    for (const [key, text] of WORKED) {
      const t = trust[key];
      if (!finite(body[key]) || (t && (t.level === "none" || t.level === "shaky"))) continue;
      const r = ranges[key];
      if (!r || !r.enough) continue;
      if (GoodShots.place(body[key], r).status === "in") return text;
    }
    return "";
  }

  const api = { flight, cause, verdict, card, worked, plain, label, PHASES, LABELS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingShotStory = api;
})(typeof window !== "undefined" ? window : globalThis);
