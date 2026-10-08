// Tests for SwingStrikeMap (static/strikemap.js): grid, trend, compare.
//
//   cd server && node --test tests/strikemap.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const StrikeMap = require("../static/strikemap.js");

test("a synthetic cluster's centre and spread", () => {
  // Cluster around h = 5, v = -15
  // Generate 25 shots with h in [1, 9] (median 5, IQR 4)
  // and v in [-19, -11] (median -15, IQR 4)
  const shots = [];
  for (let i = 0; i < 25; i++) {
    const h = 1 + (i % 5) * 2; // 1, 3, 5, 7, 9
    const v = -19 + Math.floor(i / 5) * 2; // -19, -17, -15, -13, -11
    shots.push({ strikeH: h, strikeV: v });
  }

  const r = StrikeMap.grid(shots, { club: "I7" });
  assert.equal(r.n, 25);
  assert.equal(r.centre.h, 5);
  assert.equal(r.centre.v, -15);
  assert.equal(r.spread.h, 4);
  assert.equal(r.spread.v, 4);

  // Check cells 2D array dimensions and contents
  assert.ok(Array.isArray(r.cells));
  assert.equal(r.cells.length, r.bins.rows);
  assert.equal(r.cells[0].length, r.bins.cols);
  // Cells near the cluster (h=5, v=-15) should have the peak smoothed counts
  assert.ok(r.cells[2][16] > 1.0);
  assert.equal(r.cells[15][0], 0);
});

test("a session that moved 8 mm toward the toe says so (with + = toe and with - = toe)", () => {
  // Baseline sessions with centre at h = 0, v = -15
  const baseSessions = [
    { start: 1, centre: { h: 0, v: -15 }, spread: { h: 6, v: 6 }, n: 15 },
    { start: 2, centre: { h: 0.5, v: -15.5 }, spread: { h: 5.8, v: 6.2 }, n: 15 },
    { start: 3, centre: { h: -0.5, v: -14.5 }, spread: { h: 6.2, v: 5.8 }, n: 15 },
  ];

  // Case 1: default toeSign = +1 (+ = toe). Recent moved to h = 8, v = -15
  const recentPlus = { start: 4, centre: { h: 8, v: -15 }, spread: { h: 6, v: 6 }, n: 15 };
  const resPlus = StrikeMap.compare(recentPlus, baseSessions, { toeSign: 1 });
  assert.equal(resPlus.moved.h, 8);
  assert.match(resPlus.text, /moved 8 mm toward the toe/i);
  assert.match(resPlus.text, /stayed low \(15 mm below centre\)/i);

  // Case 2: toeSign = -1 (- = toe). Recent moved to h = -8, v = -15
  const recentMinus = { start: 4, centre: { h: -8, v: -15 }, spread: { h: 6, v: 6 }, n: 15 };
  const resMinus = StrikeMap.compare(recentMinus, baseSessions, { toeSign: -1 });
  assert.equal(resMinus.moved.h, -8);
  assert.match(resMinus.text, /moved 8 mm toward the toe/i);

  // Also verify that with toeSign = -1, positive h (+8) means toward the heel
  const resHeel = StrikeMap.compare(recentPlus, baseSessions, { toeSign: -1 });
  assert.match(resHeel.text, /moved 8 mm toward the heel/i);
});

test("too few shots -> no verdict", () => {
  const baseSessions = [
    { start: 1, centre: { h: 0, v: -15 }, spread: { h: 6, v: 6 }, n: 15 },
  ];
  // Recent with fewer than 5 shots
  const fewRecent = { start: 2, centre: { h: 8, v: -15 }, spread: { h: 6, v: 6 }, n: 3 };
  const resFew = StrikeMap.compare(fewRecent, baseSessions);
  assert.equal(resFew.text, null);
  assert.equal(resFew.moved, null);

  // No baseline sessions
  const normalRecent = { start: 2, centre: { h: 8, v: -15 }, spread: { h: 6, v: 6 }, n: 10 };
  const resNoBase = StrikeMap.compare(normalRecent, []);
  assert.equal(resNoBase.text, null);

  // Passing array with only 1 session with shots
  assert.equal(StrikeMap.compare([normalRecent]).text, null);
});

test("driver box bigger", () => {
  const shots = [{ strikeH: 0, strikeV: 0 }];
  const ironGrid = StrikeMap.grid(shots, { club: "I7" });
  const driverGrid = StrikeMap.grid(shots, { club: "DR" });

  assert.equal(ironGrid.bins.width, 70);
  assert.equal(ironGrid.bins.height, 40);
  assert.equal(driverGrid.bins.width, 90);
  assert.equal(driverGrid.bins.height, 50);

  assert.ok(driverGrid.bins.width > ironGrid.bins.width);
  assert.ok(driverGrid.bins.height > ironGrid.bins.height);
  assert.ok(driverGrid.bins.cols > ironGrid.bins.cols);
  assert.ok(driverGrid.bins.rows > ironGrid.bins.rows);

  // boxOf direct check
  assert.deepEqual(StrikeMap.boxOf("I7"), { width: 70, height: 40 });
  assert.deepEqual(StrikeMap.boxOf("PW"), { width: 70, height: 40 });
  assert.deepEqual(StrikeMap.boxOf("DR"), { width: 90, height: 50 });
  assert.deepEqual(StrikeMap.boxOf("3W"), { width: 90, height: 50 });
  assert.deepEqual(StrikeMap.boxOf("woods"), { width: 90, height: 50 });
});

test("trend extracts valid sessions and skips sessions under 5 strikes", () => {
  const sessions = [
    { start: 100, rows: Array.from({ length: 10 }, () => ({ strikeH: 2, strikeV: -10 })) },
    { start: 200, rows: Array.from({ length: 3 }, () => ({ strikeH: 2, strikeV: -10 })) }, // under 5
    { start: 300, rows: Array.from({ length: 8 }, () => ({ strikeH: 4, strikeV: -12 })) },
  ];
  const tr = StrikeMap.trend(sessions);
  assert.equal(tr.length, 2);
  assert.equal(tr[0].start, 100);
  assert.equal(tr[0].n, 10);
  assert.equal(tr[0].centre.h, 2);
  assert.equal(tr[1].start, 300);
  assert.equal(tr[1].n, 8);
  assert.equal(tr[1].centre.h, 4);
});

test("spotText formats positions in plain words", () => {
  assert.equal(StrikeMap.spotText({ h: -3, v: -17 }, { toeSign: 1 }), "3 mm toward the heel, 17 mm low");
  assert.equal(StrikeMap.spotText({ h: 6, v: 4 }, { toeSign: 1 }), "6 mm toward the toe, 4 mm high");
  assert.equal(StrikeMap.spotText({ h: 0, v: 0 }), "centered, mid-face");
  assert.equal(StrikeMap.spotText({ h: 3, v: -17 }, { toeSign: 1, short: true }), "3 mm toe, 17 mm low");
  assert.equal(StrikeMap.spotText({ h: -3, v: 12 }, { toeSign: 1, short: true }), "3 mm heel, 12 mm high");
});
