// Shoulder turn at the top past side-on (metrics.js turns): RTMPose-m swaps the two shoulders near the
// top, as for a golfer facing the camera, so a 115 degree turn's width reads as 65's.
//
//   cd server && node --test tests/shoulderturn.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../static/metrics.js");

const H = 0.1;   // half the shoulders' and hips' width at address, in picture heights
const ADDRESS = 15, TOP = 100, IMPACT = 140;

/** A face-on frame of a right-hander (target to the picture's right): lead = left shoulder / hip. */
function frame(t, sh, hip) {
  const lm = new Array(33 * 3).fill(0);
  const set = (i, x, y) => { lm[i * 3] = x; lm[i * 3 + 1] = y; lm[i * 3 + 2] = 1; };
  set(0, 0.5, 0.2); set(27, 0.45, 0.9); set(28, 0.55, 0.9);   // nose, ankles
  set(11, sh[0], 0.35); set(12, sh[1], 0.35);                 // lead, trail shoulder
  set(23, hip[0], 0.55); set(24, hip[1], 0.55);               // lead, trail hip
  set(15, 0.5, 0.5); set(16, 0.5, 0.5);                       // wrists
  return { t, lm };
}

/** Lead and trail x of a line turned by deg; swapped as the model labels them when flipped. */
const line = (deg, flipped = false) => {
  const c = Math.cos(deg * Math.PI / 180) * H;
  return flipped ? [0.5 - c, 0.5 + c] : [0.5 + c, 0.5 - c];
};

/**
 * 160 frames: still to ADDRESS + 5, turning back to the top at TOP, back to square at IMPACT.
 * shoulder(i) / hip(i): the turn at frame i; flip(i): the shoulders labelled the other way round.
 */
function swing({ shoulder, hip = i => 0.4 * shoulder(i), flip = () => false, width = null }) {
  const frames = [];
  for (let i = 0; i < 160; i++) {
    const sh = width ? [0.5 + width(i) * H, 0.5 - width(i) * H] : line(shoulder(i), flip(i));
    frames.push(frame(i / 240, sh, line(hip(i))));
  }
  return frames;
}
const ramp = top => i => i <= 20 ? 0 : i <= TOP ? top * (i - 20) / (TOP - 20) : i <= IMPACT ? top * (IMPACT - i) / (IMPACT - TOP) : 0;
const positions = (extra = {}) => Object.assign([
  { key: "p1", index: ADDRESS, t: ADDRESS / 240 }, { key: "p4", index: TOP, t: TOP / 240 },
  { key: "p7", index: IMPACT, t: IMPACT / 240 },
], extra);
const run = (frames, pos = positions()) => M.compute(frames, 1, "left", pos, null).values;
const near = (a, b, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

test("past side-on with the shoulders swapped reads the turn, not 180 minus it", () => {
  const turn = ramp(115);
  // Swapped from where the line goes side-on (90) to the top: the old reading was 65.
  const v = run(swing({ shoulder: turn, flip: i => i <= TOP && turn(i) > 90 }));
  near(v[TOP].shoulderTurn, 115);
  near(v[TOP].pelvisTurn, 46);
  near(v[TOP].separation, 69);
  // On the way back, before and after side-on.
  near(v[60].shoulderTurn, turn(60));
  near(v[90].shoulderTurn, turn(90));
});

test("the same turn with the shoulders in the right order is unchanged", () => {
  const v = run(swing({ shoulder: ramp(115) }));
  near(v[TOP].shoulderTurn, 115);
});

test("flips back and forth near the top, and a blended frame at 90, read the most turned so far", () => {
  const turn = ramp(115);
  const frames = swing({ shoulder: turn, flip: i => i >= 85 && i % 2 === 0 });
  // The pose smoothing blends a flipped frame with an unflipped one into a width near 0.
  frames[TOP] = frame(TOP / 240, [0.5, 0.5], line(0.4 * 115));
  const v = run(frames);
  near(v[TOP].shoulderTurn, turn(TOP - 1));
  near(v[TOP - 3].shoulderTurn, turn(TOP - 3));
});

test("a turn short of side-on is read as before", () => {
  const v = run(swing({ shoulder: ramp(65) }));
  near(v[TOP].shoulderTurn, 65);
  near(v[TOP].separation, 39);
});

test("a width that stops shrinking and widens again before the top: past side-on", () => {
  // Dim light: the model never lines the shoulders up, it holds them half as wide, then wider.
  const deg = r => Math.acos(r) * 180 / Math.PI;
  const width = i => i <= 20 ? 1 : i <= 60 ? 1 - 0.55 * (i - 20) / 40 : i <= TOP ? 0.45 + 0.17 * (i - 60) / 40 : 1;
  const v = run(swing({ shoulder: ramp(115), width }));
  near(v[TOP].shoulderTurn, 180 - deg(0.62));
  near(v[50].shoulderTurn, deg(width(50)));
  // Widening by less than SIDE_ON_WIDEN isn't enough to tell.
  const less = i => i <= 60 ? width(i) : i <= TOP ? 0.45 + 0.1 * (i - 60) / 40 : 1;
  near(run(swing({ shoulder: ramp(115), width: less }))[TOP].shoulderTurn, deg(0.55));
});

test("a pump drill reads its last backswing only", () => {
  // Back past side-on, down to a pump bottom at 50 degrees (frame 60), back to the top.
  const turn = i => i <= 20 ? 0 : i <= 40 ? 130 * (i - 20) / 20 : i <= 60 ? 130 - 80 * (i - 40) / 20
    : i <= TOP ? 50 + 65 * (i - 60) / 40 : ramp(115)(i);
  const frames = swing({ shoulder: turn });
  near(run(frames, positions({ pumps: [{ t: 60 / 240, index: 60 }] }))[TOP].shoulderTurn, 115);
  // Without the pump the first backswing's 130 counts.
  near(run(frames)[TOP].shoulderTurn, 130);
});

test("a frame nearly as wide as at address isn't past side-on", () => {
  const turn = ramp(115);
  const frames = swing({ shoulder: turn });
  frames[95] = frame(95 / 240, [0.5 + H, 0.5 - H], line(0.4 * turn(95)));
  const v = run(frames);
  near(v[95].shoulderTurn, 0);
  near(v[TOP].shoulderTurn, 115);
});

test("coming down, past side-on until the last frame in the right order", () => {
  const turn = ramp(115);
  // Right order to frame 106 (98 degrees), with one swapped frame in between; swapped after.
  const v = run(swing({ shoulder: turn, flip: i => i === 103 || (i > 106 && turn(i) > 90) }));
  near(v[103].shoulderTurn, turn(103));
  near(v[106].shoulderTurn, turn(106));
  // Past the last one in the right order the width reads as it looks (the swapped 92 as 88).
  near(v[108].shoulderTurn, 180 - turn(108));
  near(v[125].shoulderTurn, turn(125));
});

test("the hips never read past side-on", () => {
  const turn = ramp(115);
  const v = run(swing({ shoulder: turn, hip: i => 0.4 * turn(i), flip: i => i <= TOP && turn(i) > 90 }));
  for (const i of [60, TOP, 120]) near(v[i].pelvisTurn, 0.4 * turn(i));
});
