const test = require("node:test");
const assert = require("node:assert");

const Habits = require("../static/habits.js");
// Early extension is named from the 3D's pelvis thrust (faults.js from3d): a row's 3D numbers.
const t3 = thrust => ({ numbers: { pelvisThrustImpact: thrust } });

test("a 5-swing drift into early extension is flagged", () => {
  // Early extension is the 3D's pelvis thrust past 1 in. Thrust drifts 0.1 -> 2.0 (the down-the-line
  // number beside it doesn't count). 4 of 5 past 1 in, latest 2.0, slope positive.
  const rows = [
    { earlyExt: 2.1, body3d: t3(0.1), trust: { earlyExt: { level: "ok" } } },
    { earlyExt: 3.1, body3d: t3(1.1), trust: { earlyExt: { level: "ok" } } },
    { earlyExt: 3.4, body3d: t3(1.4), trust: { earlyExt: { level: "ok" } } },
    { earlyExt: 3.8, body3d: t3(1.8), trust: { earlyExt: { level: "ok" } } },
    { earlyExt: 4.0, body3d: t3(2), trust: { earlyExt: { level: "ok" } } },
  ];
  const res = Habits.watch(rows, { clubName: "7 iron" });
  assert.strictEqual(res.length, 1);
  const h = res[0];
  assert.strictEqual(h.key, "earlyExt");
  assert.strictEqual(h.fault, "early extension");
  assert.strictEqual(h.n, 5);
  assert.strictEqual(h.from, 0.1);
  assert.strictEqual(h.to, 2.0);
  assert.ok(h.slope > 0);
  assert.strictEqual(h.text, "Watch out, early extension is creeping in: over your last 5 swings with the 7 iron, your hips have been moving closer to the ball at impact.");
  assert.strictEqual(h.detail, "Hips toward the ball at impact: 0.1 in to 2.0 in over the last 5 swings");
  assert.ok(h.thought && h.thought.length > 0);
  assert.ok(h.drill && h.drill.length > 0);
});

test("a steady bad number (no trend) is not flagged", () => {
  // Constant bad values: earlyExt = 4.0 across all 5 swings.
  // Slope is 0 (not pointing toward the fault side).
  const rows = [
    { earlyExt: 4.0, body3d: t3(2), trust: { earlyExt: { level: "ok" } } },
    { earlyExt: 4.0, body3d: t3(2), trust: { earlyExt: { level: "ok" } } },
    { earlyExt: 4.0, body3d: t3(2), trust: { earlyExt: { level: "ok" } } },
    { earlyExt: 4.0, body3d: t3(2), trust: { earlyExt: { level: "ok" } } },
    { earlyExt: 4.0, body3d: t3(2), trust: { earlyExt: { level: "ok" } } },
  ];
  const res = Habits.watch(rows, { clubName: "7 iron" });
  assert.strictEqual(res.length, 0);
});

test("a trend toward the good side is not flagged", () => {
  // Improving values: earlyExt going down from 5.0 to 3.2.
  const rows = [
    { earlyExt: 5.0, body3d: t3(3), trust: { earlyExt: { level: "ok" } } },
    { earlyExt: 4.5, body3d: t3(2.5), trust: { earlyExt: { level: "ok" } } },
    { earlyExt: 4.0, body3d: t3(2), trust: { earlyExt: { level: "ok" } } },
    { earlyExt: 3.5, body3d: t3(1.5), trust: { earlyExt: { level: "ok" } } },
    { earlyExt: 3.2, body3d: t3(1.2), trust: { earlyExt: { level: "ok" } } },
  ];
  const res = Habits.watch(rows, { clubName: "7 iron" });
  assert.strictEqual(res.length, 0);
});

test("shaky / no-reading swings don't count (only 3 readable -> nothing)", () => {
  // 2 swings are shaky / none, so only 3 are readable (< 4 needed)
  const rows = [
    { earlyExt: 2.1, body3d: t3(0.1), trust: { earlyExt: { level: "ok" } } },
    { earlyExt: 3.1, body3d: t3(1.1), trust: { earlyExt: { level: "shaky" } } },
    { earlyExt: null, trust: { earlyExt: { level: "none" } } },
    { earlyExt: 3.8, body3d: t3(1.8), trust: { earlyExt: { level: "ok" } } },
    { earlyExt: 4.0, body3d: t3(2), trust: { earlyExt: { level: "ok" } } },
  ];
  const res = Habits.watch(rows, { clubName: "7 iron" });
  assert.strictEqual(res.length, 0);
});

test("fewer than 5 swings -> nothing", () => {
  const rows = [
    { earlyExt: 3.1, body3d: t3(1.1), trust: { earlyExt: { level: "ok" } } },
    { earlyExt: 3.4, body3d: t3(1.4), trust: { earlyExt: { level: "ok" } } },
    { earlyExt: 3.8, body3d: t3(1.8), trust: { earlyExt: { level: "ok" } } },
    { earlyExt: 4.0, body3d: t3(2), trust: { earlyExt: { level: "ok" } } },
  ];
  const res = Habits.watch(rows, { clubName: "7 iron" });
  assert.strictEqual(res.length, 0);
});

test("the text has no P[1-8]", () => {
  // Over the top (handsPlaneP6): in summary.js BODY it is Hands plane at P6.
  // In SwingShotStory.LABELS it is "Hands to plane in the downswing".
  // Ensure the text generated contains no P1-P8.
  const rows = [
    { handsPlaneP6: 3.5, trust: { handsPlaneP6: { level: "ok" } } },
    { handsPlaneP6: 5.2, trust: { handsPlaneP6: { level: "ok" } } },
    { handsPlaneP6: 5.8, trust: { handsPlaneP6: { level: "ok" } } },
    { handsPlaneP6: 6.2, trust: { handsPlaneP6: { level: "ok" } } },
    { handsPlaneP6: 6.8, trust: { handsPlaneP6: { level: "ok" } } },
  ];
  const res = Habits.watch(rows, { clubName: "driver" });
  assert.strictEqual(res.length, 1);
  const h = res[0];
  assert.strictEqual(h.key, "handsPlaneP6");
  assert.strictEqual(h.fault, "over the top");
  assert.doesNotMatch(h.text, /\bP[1-8]\b/);
  assert.doesNotMatch(h.thought, /\bP[1-8]\b/);
  assert.doesNotMatch(h.drill, /\bP[1-8]\b/);
  assert.match(h.text, /downswing/);
});

test("worst fault is picked when multiple faults trend", () => {
  // Both earlyExt and headToBall trend:
  // earlyExt (3D thrust, threshold 1): latest 1.5 -> diff = 0.5, scale = 1, dist = 0.5
  // headToBall (threshold 1): latest 2.0 -> diff = 1.0, scale = 1, dist = 1.0 / 1 = 1.0
  // headToBall has higher severity distance -> picked.
  const rows = [
    { earlyExt: 2.1, body3d: t3(0.1), headToBall: 0.5, trust: { earlyExt: { level: "ok" }, headToBall: { level: "ok" } } },
    { earlyExt: 3.1, body3d: t3(1.1), headToBall: 1.1, trust: { earlyExt: { level: "ok" }, headToBall: { level: "ok" } } },
    { earlyExt: 3.4, body3d: t3(1.2), headToBall: 1.3, trust: { earlyExt: { level: "ok" }, headToBall: { level: "ok" } } },
    { earlyExt: 3.8, body3d: t3(1.3), headToBall: 1.6, trust: { earlyExt: { level: "ok" }, headToBall: { level: "ok" } } },
    { earlyExt: 4.0, body3d: t3(1.5), headToBall: 2.0, trust: { earlyExt: { level: "ok" }, headToBall: { level: "ok" } } },
  ];
  const res = Habits.watch(rows, { clubName: "7 iron" });
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].key, "headToBall");
});

test("a fault there from the first swing is not 'creeping in', even when it gets worse", () => {
  const rows = [1.2, 1.4, 1.6, 1.9, 2.3].map(v => ({ body3d: t3(v), trust: { earlyExt: { level: "ok" } } }));
  assert.strictEqual(Habits.watch(rows, { clubName: "7 iron" }).length, 0);
});
