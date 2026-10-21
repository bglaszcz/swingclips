// Hands to plane's line down the line (metrics.js computeDTL): the shaft at address, the club model's look
// there ("clubAddr", pose.py SHAFT_AT_SPREAD_S) when the frame has one it's sure of, else the frame's shaft.
//
//   cd server && node --test tests/planeline.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../static/metrics.js");

const ASPECT = 9 / 16;

/** A down-the-line frame with the hands at (x, y) (picture units), shoulders above the ankles. */
function frame(t, x, y, extra = {}) {
  const lm = new Array(33 * 3).fill(0);
  const w = new Array(33 * 3).fill(0);
  const set = (i, px, py, wy) => {
    lm[i * 3] = px; lm[i * 3 + 1] = py; lm[i * 3 + 2] = 1;
    w[i * 3 + 1] = wy;
  };
  set(0, 0.5, 0.2, -0.6);                                 // nose
  set(11, 0.48, 0.3, -0.5); set(12, 0.52, 0.3, -0.5);    // shoulders
  set(23, 0.47, 0.55, 0); set(24, 0.53, 0.55, 0);        // hips
  set(27, 0.47, 0.9, 0.85); set(28, 0.53, 0.9, 0.85);    // ankles
  for (const i of [15, 16, 19, 20]) set(i, x, y, 0);     // wrists, index fingers: the hands
  return { t, lm, w, ...extra };
}

const handsPlaneAtTop = frames => M.computeDTL(frames, ASPECT, 0, { x: 0.7, y: 0.9 }).values[1].handsPlane;

test("the club model's shaft at address is the plane line when it's sure of it", () => {
  const top = frame(1.0, 0.45, 0.25);
  const ray = handsPlaneAtTop([frame(0, 0.55, 0.6, { club: [60, 0.9] }), top]);
  const model = handsPlaneAtTop([frame(0, 0.55, 0.6, { club: [64, 0.9] }), top]);
  assert.notEqual(Math.round(ray * 100), Math.round(model * 100));
  // The quick pass's frame: its own (ray-cast) shaft, and the club model's look at address.
  const both = handsPlaneAtTop([frame(0, 0.55, 0.6, { club: [60, 0.9], clubAddr: [64, 0.9] }), top]);
  assert.equal(both, model);
  // Not sure of it: the frame's own shaft.
  const unsure = handsPlaneAtTop([frame(0, 0.55, 0.6, { club: [60, 0.9], clubAddr: [64, 0.2] }), top]);
  assert.equal(unsure, ray);
  // The model's look alone (the ray-cast shaft not seen there) is enough.
  const alone = handsPlaneAtTop([frame(0, 0.55, 0.6, { club: null, clubAddr: [64, 0.9] }), top]);
  assert.equal(alone, model);
});
