// Lead hip line geometry: address lead and trail hip lines, current frame marker and inches.
//
//   cd server && node --test tests/hipline.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const SwingMetrics = require("../static/metrics.js");

function makeFrame(hip, lmY = 0.5) {
  const f = {};
  if (hip !== undefined) f.hip = hip;
  if (lmY != null) {
    // 33 landmarks, each 3 numbers [x, y, z]. Hip landmarks are indices 23 (left) and 24 (right).
    const lm = new Array(33 * 3).fill(0);
    lm[23 * 3 + 1] = lmY - 0.02;
    lm[24 * 3 + 1] = lmY + 0.02;
    f.lm = lm;
  }
  return f;
}

test("no hip at address -> null", () => {
  // Empty frames or missing address
  assert.equal(SwingMetrics.hipLine([], 0, 0, "left"), null);
  assert.equal(SwingMetrics.hipLine(null, 0, 0, "left"), null);
  assert.equal(SwingMetrics.hipLine([makeFrame()], -1, 0, "left"), null);
  assert.equal(SwingMetrics.hipLine([makeFrame()], 1, 0, "left"), null);

  // Address frame has no hip property
  const framesNoHip = [makeFrame(undefined), makeFrame([0.35, 0.65])];
  assert.equal(SwingMetrics.hipLine(framesNoHip, 0, 1, "left"), null);

  // Address frame has hip = null
  const framesNullHip = [makeFrame(null), makeFrame([0.35, 0.65])];
  assert.equal(SwingMetrics.hipLine(framesNullHip, 0, 1, "left"), null);

  // Address frame has null for the lead edge
  const framesNullLead = [makeFrame([0.35, null]), makeFrame([0.35, 0.65])];
  assert.equal(SwingMetrics.hipLine(framesNullLead, 0, 1, "left"), null);
});

test("lead side right vs left", () => {
  // Right-handed golfer (leadSide: "left"): target is picture right (m = +1).
  // hip: [leftEdge, rightEdge]. Lead is right (index 1), trail is left (index 0).
  const framesR = [
    makeFrame([0.35, 0.65], 0.50), // address
    makeFrame([0.38, 0.72], 0.52), // current frame (moved +0.07 toward target)
  ];
  const scale = 0.02; // metres per picture height
  const aspect = 1.0;
  const resLeft = SwingMetrics.hipLine(framesR, 0, 1, "left", scale, aspect);
  assert.ok(resLeft);
  assert.equal(resLeft.lineX, 0.65);
  assert.equal(resLeft.trailX, 0.35);
  assert.equal(resLeft.nowX, 0.72);
  assert.equal(resLeft.y, 0.52);
  // (0.72 - 0.65) * 1.0 * 0.02 * 39.37 = 0.055118
  assert.ok(Math.abs(resLeft.inches - 0.07 * 0.02 * 39.37) < 1e-4);

  // Left-handed golfer (leadSide: "right"): target is picture left (m = -1).
  // Lead is left (index 0), trail is right (index 1).
  const framesL = [
    makeFrame([0.35, 0.65], 0.50), // address
    makeFrame([0.28, 0.62], 0.51), // current frame (moved +0.07 toward target, picture-left)
  ];
  const resRight = SwingMetrics.hipLine(framesL, 0, 1, "right", scale, aspect);
  assert.ok(resRight);
  assert.equal(resRight.lineX, 0.35);
  assert.equal(resRight.trailX, 0.65);
  assert.equal(resRight.nowX, 0.28);
  assert.equal(resRight.y, 0.51);
  // m * (nowX - lineX) = -1 * (0.28 - 0.35) = +0.07 toward target
  assert.ok(Math.abs(resRight.inches - 0.07 * 0.02 * 39.37) < 1e-4);
});

test("a null edge on the current frame -> no tick but still the line", () => {
  const frames = [
    makeFrame([0.35, 0.65], 0.50),
    makeFrame([0.37, null], 0.51), // current frame lead edge is null
  ];
  const res = SwingMetrics.hipLine(frames, 0, 1, "left");
  assert.ok(res);
  assert.equal(res.lineX, 0.65);
  assert.equal(res.trailX, 0.35);
  assert.equal(res.nowX, null);
  assert.equal(res.inches, null);
  assert.equal(res.y, 0.51);

  // Current frame completely missing hip (e.g. outside P1-P8)
  const framesNoHipCur = [
    makeFrame([0.35, 0.65], 0.50),
    makeFrame(undefined, 0.52),
  ];
  const res2 = SwingMetrics.hipLine(framesNoHipCur, 0, 1, "left");
  assert.ok(res2);
  assert.equal(res2.lineX, 0.65);
  assert.equal(res2.nowX, null);
  assert.equal(res2.inches, null);
});
