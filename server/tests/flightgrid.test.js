// server/tests/flightgrid.test.js
// Unit tests for Ball Flight Grid (static/flightgrid.js).
// Run with: node --test server/tests/flightgrid.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const FlightGrid = require("../static/flightgrid.js");

test("constants exported", () => {
  assert.equal(FlightGrid.START_DEG, 2);
  assert.equal(FlightGrid.CURVE_PCT, 0.025);
  assert.equal(FlightGrid.MIN_SHOTS, 10);
});

test("each of the nine classes for a right-handed golfer", () => {
  // carry = 100 yd -> thresh = 2.5 yd curve threshold
  // direction > 2 is right (push), < -2 is left (pull), [-2, 2] is straight
  // curveYd = offline - carry * tan(dir)

  // 1. Pull draw: start left (dir = -3°), curves left (offline far left)
  // carry = 100, tan(-3°) = -0.0524, carry*tan = -5.24.
  // curveYd = offline - (-5.24) = offline + 5.24.
  // We want curve left, so curveYd < -2.5 yd -> offline < -7.74 yd. Let offline = -10 yd -> curveYd = -4.76.
  const pullDraw = FlightGrid.classify({ carry: 100, offline: -10, direction: -3 });
  assert.ok(pullDraw);
  assert.equal(pullDraw.start, "left");
  assert.equal(pullDraw.curve, "left");
  assert.equal(pullDraw.key, "left_left");
  assert.equal(pullDraw.name, "Pull draw");

  // 2. Pull: start left, curve straight
  // curveYd between -2.5 and +2.5 -> offline ≈ -5.24.
  const pull = FlightGrid.classify({ carry: 100, offline: -5.24, direction: -3 });
  assert.ok(pull);
  assert.equal(pull.start, "left");
  assert.equal(pull.curve, "straight");
  assert.equal(pull.key, "left_straight");
  assert.equal(pull.name, "Pull");

  // 3. Pull fade: start left, curve right
  // curveYd > 2.5 -> offline > -2.74. Let offline = 0.
  const pullFade = FlightGrid.classify({ carry: 100, offline: 0, direction: -3 });
  assert.ok(pullFade);
  assert.equal(pullFade.start, "left");
  assert.equal(pullFade.curve, "right");
  assert.equal(pullFade.key, "left_right");
  assert.equal(pullFade.name, "Pull fade");

  // 4. Draw: start straight (dir = 0°), curve left (offline < -2.5 yd)
  const draw = FlightGrid.classify({ carry: 100, offline: -5, direction: 0 });
  assert.ok(draw);
  assert.equal(draw.start, "straight");
  assert.equal(draw.curve, "left");
  assert.equal(draw.key, "straight_left");
  assert.equal(draw.name, "Draw");

  // 5. Straight: start straight, curve straight
  const straight = FlightGrid.classify({ carry: 100, offline: 0, direction: 0 });
  assert.ok(straight);
  assert.equal(straight.start, "straight");
  assert.equal(straight.curve, "straight");
  assert.equal(straight.key, "straight_straight");
  assert.equal(straight.name, "Straight");

  // 6. Fade: start straight, curve right (offline > 2.5 yd)
  const fade = FlightGrid.classify({ carry: 100, offline: 5, direction: 0 });
  assert.ok(fade);
  assert.equal(fade.start, "straight");
  assert.equal(fade.curve, "right");
  assert.equal(fade.key, "straight_right");
  assert.equal(fade.name, "Fade");

  // 7. Push draw: start right (dir = +3°), curve left
  // tan(3°) = +0.0524, carry*tan = +5.24.
  // curveYd = offline - 5.24. We want curveYd < -2.5 -> offline < 2.74. Let offline = 0.
  const pushDraw = FlightGrid.classify({ carry: 100, offline: 0, direction: 3 });
  assert.ok(pushDraw);
  assert.equal(pushDraw.start, "right");
  assert.equal(pushDraw.curve, "left");
  assert.equal(pushDraw.key, "right_left");
  assert.equal(pushDraw.name, "Push draw");

  // 8. Push: start right, curve straight
  // curveYd ≈ 0 -> offline = 5.24.
  const push = FlightGrid.classify({ carry: 100, offline: 5.24, direction: 3 });
  assert.ok(push);
  assert.equal(push.start, "right");
  assert.equal(push.curve, "straight");
  assert.equal(push.key, "right_straight");
  assert.equal(push.name, "Push");

  // 9. Push fade: start right, curve right
  // curveYd > 2.5 -> offline > 7.74. Let offline = 10.
  const pushFade = FlightGrid.classify({ carry: 100, offline: 10, direction: 3 });
  assert.ok(pushFade);
  assert.equal(pushFade.start, "right");
  assert.equal(pushFade.curve, "right");
  assert.equal(pushFade.key, "right_right");
  assert.equal(pushFade.name, "Push fade");
});

test("thresholds' edges: 2° start line and 2.5% curvature", () => {
  const carry = 100;
  // Edge of start line: 2.0° is straight; 2.01° is right; -2.0° is straight; -2.01° is left
  const at2 = FlightGrid.classify({ carry, offline: 0, direction: 2.0 });
  assert.equal(at2.start, "straight");

  const over2 = FlightGrid.classify({ carry, offline: 0, direction: 2.01 });
  assert.equal(over2.start, "right");

  const atNeg2 = FlightGrid.classify({ carry, offline: 0, direction: -2.0 });
  assert.equal(atNeg2.start, "straight");

  const underNeg2 = FlightGrid.classify({ carry, offline: 0, direction: -2.01 });
  assert.equal(underNeg2.start, "left");

  // Edge of curve: direction = 0 -> curveYd = offline. Thresh = 100 * 0.025 = 2.5 yd.
  const atThreshRight = FlightGrid.classify({ carry, offline: 2.5, direction: 0 });
  assert.equal(atThreshRight.curve, "straight");

  const overThreshRight = FlightGrid.classify({ carry, offline: 2.51, direction: 0 });
  assert.equal(overThreshRight.curve, "right");

  const atThreshLeft = FlightGrid.classify({ carry, offline: -2.5, direction: 0 });
  assert.equal(atThreshLeft.curve, "straight");

  const underThreshLeft = FlightGrid.classify({ carry, offline: -2.51, direction: 0 });
  assert.equal(underThreshLeft.curve, "left");
});

test("left-handed names are mirrored", () => {
  const opts = { leftHanded: true };
  // For a lefty:
  // start right is pull, start left is push.
  // curve right is draw, curve left is fade.

  // start right (+3°), curve right (offline = 10 -> curveYd > 2.5): Pull draw
  const pullDraw = FlightGrid.classify({ carry: 100, offline: 10, direction: 3 }, opts);
  assert.equal(pullDraw.name, "Pull draw");

  // start right (+3°), curve straight: Pull
  const pull = FlightGrid.classify({ carry: 100, offline: 5.24, direction: 3 }, opts);
  assert.equal(pull.name, "Pull");

  // start right (+3°), curve left (offline = 0 -> curveYd < -2.5): Pull fade
  const pullFade = FlightGrid.classify({ carry: 100, offline: 0, direction: 3 }, opts);
  assert.equal(pullFade.name, "Pull fade");

  // start straight (0°), curve right: Draw
  const draw = FlightGrid.classify({ carry: 100, offline: 5, direction: 0 }, opts);
  assert.equal(draw.name, "Draw");

  // start straight (0°), curve straight: Straight
  const straight = FlightGrid.classify({ carry: 100, offline: 0, direction: 0 }, opts);
  assert.equal(straight.name, "Straight");

  // start straight (0°), curve left: Fade
  const fade = FlightGrid.classify({ carry: 100, offline: -5, direction: 0 }, opts);
  assert.equal(fade.name, "Fade");

  // start left (-3°), curve right (offline = 0 -> curveYd > 2.5): Push draw
  const pushDraw = FlightGrid.classify({ carry: 100, offline: 0, direction: -3 }, opts);
  assert.equal(pushDraw.name, "Push draw");

  // start left (-3°), curve straight: Push
  const push = FlightGrid.classify({ carry: 100, offline: -5.24, direction: -3 }, opts);
  assert.equal(push.name, "Push");

  // start left (-3°), curve left (offline = -10 -> curveYd < -2.5): Push fade
  const pushFade = FlightGrid.classify({ carry: 100, offline: -10, direction: -3 }, opts);
  assert.equal(pushFade.name, "Push fade");
});

test("mishits and missing numbers skipped", () => {
  assert.equal(FlightGrid.classify(null), null);
  assert.equal(FlightGrid.classify({}), null);
  assert.equal(FlightGrid.classify({ carry: 0, offline: 0, direction: 0 }), null);
  assert.equal(FlightGrid.classify({ carry: -10, offline: 0, direction: 0 }), null);
  assert.equal(FlightGrid.classify({ carry: NaN, offline: 0, direction: 0 }), null);
  assert.equal(FlightGrid.classify({ carry: 100, offline: null, direction: 0 }), null);
  assert.equal(FlightGrid.classify({ carry: 100, offline: 5, direction: null }), null);
  assert.equal(FlightGrid.classify({ carry: 100, offline: NaN, direction: 0 }), null);
});

test("analyze: counts, shares, and grid order", () => {
  const sess1 = {
    key: "2031-03-24",
    start: 1932470000000,
    rows: [
      { carry: 150, offline: -5, direction: 0, club: "7i", good: true },
      { carry: 150, offline: 0, direction: 0, club: "7i", good: true },
      { carry: 150, offline: 5, direction: 0, club: "7i", good: false },
      { carry: 0, offline: 0, direction: 0, club: "7i" }, // mishit: skipped
    ],
  };
  const sess2 = {
    key: "2031-03-28",
    start: 1932810000000,
    rows: [
      { carry: 150, offline: 0, direction: 0, club: "7i", good: true },
      { carry: 150, offline: 0, direction: 0, club: "7i", good: true },
      { carry: 150, offline: 10, direction: 3, club: "7i", good: false }, // push fade
      { carry: 150, offline: 0, direction: 0, club: "DR", good: true }, // other club: skipped
    ],
  };

  const a = FlightGrid.analyze([sess1, sess2], { club: "7i" });
  assert.equal(a.n, 6);
  assert.equal(a.cells.length, 9);

  // Shares must sum to 1
  const sumShares = a.cells.reduce((sum, c) => sum + c.share, 0);
  assert.ok(Math.abs(sumShares - 1) < 1e-6);

  // Straight shots: 1 in sess1, 2 in sess2 = 3 total out of 6 (50%)
  const straightCell = a.cells.find(c => c.key === "straight_straight");
  assert.ok(straightCell);
  assert.equal(straightCell.n, 3);
  assert.equal(straightCell.share, 0.5);
  assert.equal(straightCell.good, 3);
  assert.equal(straightCell.judged, 3);

  // Total n < 10 -> usual is null
  assert.equal(a.usual, null);
  assert.ok(a.status.includes("7 iron"));
  assert.ok(a.status.includes("6 shots"));
});

test("usual cell requires at least MIN_SHOTS = 10", () => {
  // 9 shots in straight cell: usual is still null
  const rows9 = [];
  for (let i = 0; i < 9; i++) {
    rows9.push({ carry: 150, offline: 0, direction: 0 });
  }
  const a9 = FlightGrid.analyze([{ key: "s1", start: 1000, rows: rows9 }]);
  assert.equal(a9.n, 9);
  assert.equal(a9.usual, null);

  // 10th shot added: usual is now Straight
  rows9.push({ carry: 150, offline: 0, direction: 0 });
  const a10 = FlightGrid.analyze([{ key: "s1", start: 1000, rows: rows9 }]);
  assert.equal(a10.n, 10);
  assert.ok(a10.usual);
  assert.equal(a10.usual.key, "straight_straight");
  assert.equal(a10.usual.n, 10);
  assert.equal(a10.latest.usualN, 10);
});

test("per-session breakdown in analyze", () => {
  const sess1 = {
    key: "s1",
    start: 1000,
    rows: [
      { carry: 100, offline: -10, direction: -3 }, // left, left
      { carry: 100, offline: 0, direction: 0 },     // straight, straight
      { carry: 100, offline: 10, direction: 3 },    // right, right
    ],
  };
  const a = FlightGrid.analyze([sess1]);
  assert.equal(a.sessions.length, 1);
  const s = a.sessions[0];
  assert.equal(s.n, 3);
  assert.deepEqual(s.starts, { left: 1, straight: 1, right: 1 });
  assert.deepEqual(s.curves, { left: 1, straight: 1, right: 1 });
});
