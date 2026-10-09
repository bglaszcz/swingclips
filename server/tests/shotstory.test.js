// The swing view's coaching card (static/shotstory.js): ball flight in plain words, the verdict,
// why and what to try.
//
//   cd server && node --test tests/shotstory.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const Coach = require("../static/coach.js");
const Story = require("../static/shotstory.js");

test("out-to-in path with the face open to it but closed to the target is a pull-fade, not a slice", () => {
  const f = Story.flight({ path: -4.5, faceToPath: 2, face: -2.5, direction: -2.3 });
  assert.equal(f.shape, "pull-fade");
  assert.equal(f.start, "left");
  assert.equal(f.curve, "right");
  assert.match(f.text, /^Pull-fade: the ball started left of the target and curved back to the right\.$/);
  assert.match(f.cause, /out-to-in \(4\.5° across the ball\)/);
  assert.match(f.cause, /pointed left of the target but open to the path/);
  assert.match(f.cause, /starts where the face points and curves away from the path/);
});

test("shot shapes from start line and curve", () => {
  const shape = s => Story.flight(s).shape;
  assert.equal(shape({ direction: 0.5, faceToPath: 0.3 }), "straight");
  assert.equal(shape({ direction: 0, faceToPath: 3 }), "fade");
  assert.equal(shape({ direction: 0, faceToPath: 6 }), "slice");
  assert.equal(shape({ direction: 0, faceToPath: -3 }), "draw");
  assert.equal(shape({ direction: 0, faceToPath: -6 }), "hook");
  assert.equal(shape({ direction: 4, faceToPath: 0 }), "push");
  assert.equal(shape({ direction: -4, faceToPath: 0 }), "pull");
  assert.equal(shape({ direction: 4, faceToPath: 5 }), "push-slice");
  assert.equal(shape({ direction: 4, faceToPath: -2 }), "push-draw");
  assert.equal(shape({ direction: -4, faceToPath: -5 }), "pull-hook");
  // No club data: spin axis gives the curve, the face (missing) can't give the start; direction does.
  assert.equal(shape({ direction: 0, spinAxis: 12 }), "slice");
  assert.equal(Story.flight({}), null);
  assert.equal(Story.flight(null), null);
});

test("the ball's spin axis says the curve over face to path; the rule of thumb only when they agree", () => {
  // Square's real shot: face to path 5.3 (a slice by the club) but spin axis 1.4 and 0.6 yd right: straight.
  const f = Story.flight({ direction: -0.2, face: 0.8, path: -4.5, faceToPath: 5.3, spinAxis: 1.4 });
  assert.equal(f.shape, "straight");
  assert.doesNotMatch(f.cause, /curves away from the path/);
  assert.equal(Story.flight({ direction: -3, face: -2.5, path: -4.5, faceToPath: 2, spinAxis: 6 }).shape, "pull-fade");
});

test("the start line falls back to the face when Square sent no direction", () => {
  assert.equal(Story.flight({ face: -3, path: -1, faceToPath: -2 }).start, "left");
});

const baseline = { n: 40, carry: 150, smash: 1.33 };

test("verdict: good from the good-shot rules, else playable or a miss", () => {
  assert.equal(Story.verdict({ carry: 150, offline: 2 }, { good: true, fails: [] }, baseline, "irons").level, "good");
  // 12 yd right at 150: past 5% (7.5) but inside twice that (15): playable.
  assert.equal(Story.verdict({ carry: 148, offline: 12 }, { good: false, fails: ["offline"] }, baseline, "irons").level, "ok");
  assert.equal(Story.verdict({ carry: 148, offline: 25 }, { good: false, fails: ["offline"] }, baseline, "irons").level, "miss");
  // 20% short: a miss even on line.
  assert.equal(Story.verdict({ carry: 120, offline: 0 }, { good: false, fails: ["carry"] }, baseline, "irons").level, "miss");
  // No baseline for the club yet: no verdict.
  assert.equal(Story.verdict({ carry: 150, offline: 0 }, { good: false, fails: [] }, null, "irons"), null);
});

test("card with a body fault: the fault says why, its drill and thought say what to try", () => {
  const fault = { key: "earlyExt", name: "early extension", value: 4, ...pick(Coach.MOVES.earlyExt.more) };
  const c = Story.card({ shot: { carry: 130, offline: -20, path: -4.5, face: -2.5, faceToPath: 2, direction: -2.3, smash: 1.25 },
    judged: { good: false, fails: ["offline"] }, baseline, group: "irons", faults: [fault] });
  assert.equal(c.verdict.level, "miss");
  assert.match(c.what, /^Pull-fade: .*: 20 yd left, 20 yd short of your usual carry, off the centre of the face/);
  assert.match(c.why, /^Early extension: your hips moved toward the ball/);
  assert.equal(c.tip.thought, Coach.MOVES.earlyExt.more.thought);
});

test("card on a good shot says what worked, from a number inside the good-shot range", () => {
  const ranges = { handsAhead: { enough: true, n: 20, q10: 1, q25: 2, q50: 3, q75: 4, q90: 5 } };
  const c = Story.card({ shot: { carry: 151, offline: 1, direction: 0.5, faceToPath: 0.4 },
    judged: { good: true, fails: [] }, baseline, group: "irons", faults: [], body: { handsAhead: 3 }, trust: {}, ranges });
  assert.equal(c.verdict.level, "good");
  assert.match(c.why, /hands were leading the clubhead at impact/);
  // A shaky reading isn't praised.
  const shaky = Story.card({ shot: { carry: 151, offline: 1, direction: 0.5, faceToPath: 0.4 },
    judged: { good: true, fails: [] }, baseline, group: "irons", faults: [], body: { handsAhead: 3 },
    trust: { handsAhead: { level: "shaky" } }, ranges });
  assert.doesNotMatch(shaky.why, /hands were leading/);
});

test("no body fault but an out-to-in miss: the fix aims the path back to neutral, never toward a fault", () => {
  const c = Story.card({ shot: { carry: 140, offline: 22, path: -5, face: 2, faceToPath: 7, direction: 1 },
    judged: { good: false, fails: ["offline"] }, baseline, group: "irons", faults: [] });
  assert.equal(c.verdict.level, "miss");
  assert.match(c.why, /out-to-in/);
  assert.equal(c.tip.thought, Coach.MOVES.handsPlaneP6.less.thought);
  // In-to-out: the way back would be the over-the-top move (a fault), so no drill is offered.
  const io = Story.card({ shot: { carry: 140, offline: -22, path: 5, face: -2, faceToPath: -7, direction: -1 },
    judged: { good: false, fails: ["offline"] }, baseline, group: "irons", faults: [] });
  assert.equal(io.tip, null);
});

test("no P-numbers reach the golfer", () => {
  assert.equal(Story.plain("Hands to plane at P6"), "Hands to plane in the downswing");
  assert.equal(Story.plain("Pump the hands down at P6 (shaft parallel in the downswing)"), "Pump the hands down in the downswing");
  assert.equal(Story.plain("P4 and P7"), "top of swing and impact");
  for (const [k, v] of Object.entries(Story.LABELS)) assert.doesNotMatch(v, /\bP[1-8]\b|X-factor/, k);
  // Every drill and thought the card can show.
  for (const [k, m] of Object.entries(Coach.MOVES)) {
    for (const side of ["more", "less"]) {
      for (const field of ["drill", "thought"]) assert.doesNotMatch(Story.plain(m[side][field]) || "", /\bP[1-8]\b/, `${k}.${side}.${field}`);
    }
  }
});

function pick(m) { return { drill: m.drill, thought: m.thought }; }

test("started one way and curved back near the target: a pull-fade, not a pull-slice", () => {
  assert.equal(Story.flight({ direction: -4, spinAxis: 14, carry: 120, offline: 2 }).shape, "pull-fade");
  // Finished well right (past 5% of carry): a pull-slice.
  assert.equal(Story.flight({ direction: -4, spinAxis: 14, carry: 120, offline: 15 }).shape, "pull-slice");
});

test("a short, off-centre shot that stayed on line blames the contact, not the path", () => {
  const c = Story.card({ shot: { carry: 128, offline: 1, smash: 1.2, path: -4.5, face: 0.8, faceToPath: 5.3, direction: -0.2, spinAxis: 1.4 },
    judged: { good: false, fails: ["carry", "smash"] }, baseline, group: "irons", faults: [] });
  assert.match(c.why, /^Contact: you caught it off the centre of the face/);
  assert.equal(c.tip, null);
});

test("a good shot with a fault: the why is what worked; the fault is only 'still there'", () => {
  const ranges = { handsAhead: { enough: true, n: 20, q10: 1, q25: 2, q50: 3, q75: 4, q90: 5 } };
  const fault = { key: "releaseArm", name: "casting", value: -10, ...pick(Coach.MOVES.releaseArm.more) };
  const c = Story.card({ shot: { carry: 151, offline: 1, direction: 0.5, spinAxis: 1 }, judged: { good: true, fails: [] },
    baseline, group: "irons", faults: [fault], body: { handsAhead: 3 }, trust: {}, ranges });
  assert.match(c.why, /hands were leading the clubhead/);
  assert.doesNotMatch(c.why, /asting/);
  assert.equal(c.still.name, "casting");
  assert.equal(c.tip.thought, "Same feel on the next one.");
});

test("worked: selects what worked from good ranges, edge cases with null/missing data", () => {
  const ranges = {
    handsAhead: { enough: true, n: 20, q10: 1, q25: 2, q50: 3, q75: 4, q90: 5 },
    bendLoss: { enough: true, n: 20, q10: -5, q25: -2, q50: 0, q75: 2, q90: 5 },
  };

  // Normal: in-range metric
  const res = Story.worked({ body: { handsAhead: 3 }, trust: {}, ranges });
  assert.match(res, /hands were leading the clubhead/);

  // Shaky trust is skipped
  const shaky = Story.worked({ body: { handsAhead: 3 }, trust: { handsAhead: { level: "shaky" } }, ranges });
  assert.equal(shaky, "");

  // Missing metric or not enough shots in range returns empty string
  const notEnough = Story.worked({ body: { handsAhead: 3 }, trust: {}, ranges: { handsAhead: { enough: false } } });
  assert.equal(notEnough, "");

  // Edge cases: null or undefined input safely returns empty string
  assert.equal(Story.worked(null), "");
  assert.equal(Story.worked(undefined), "");
  assert.equal(Story.worked({}), "");

  // Story.label helper
  assert.equal(Story.label("tempo"), "Tempo");
  assert.equal(Story.label("handsAhead"), "Hands ahead of the ball at impact");
  assert.equal(Story.label("customMetric"), "customMetric");
});

