// drillnudge.test.js: unit tests for SwingDrillNudge (drillnudge.js)
const test = require("node:test");
const assert = require("node:assert");
const DrillNudge = require("../static/drillnudge.js");

function makeRow(name, tMs, club, backswing, extra = {}) {
  return {
    name,
    t: tMs,
    club,
    backswing,
    clubSpeed: extra.clubSpeed ?? 80,
    carry: extra.carry ?? 150,
    drill: extra.drill || null,
    excluded: Boolean(extra.excluded),
    reviewed: Boolean(extra.reviewed)
  };
}

// Helper to build 10 baseline swings for club "I7"
function baselineSwings(startTime = 1000000, count = 10, club = "I7", backswing = 0.9) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push(makeRow(`base_${club}_${i}`, startTime + i * 60000, club, backswing));
  }
  return rows;
}

test("no nudge on one long backswing", () => {
  const base = baselineSwings();
  const lastT = base[base.length - 1].t;
  const rows = [
    ...base,
    makeRow("long_1", lastT + 60000, "I7", 1.8) // single long backswing (1.8s >= 1.5 * 0.9)
  ];
  const res = DrillNudge.check(rows);
  assert.strictEqual(res, null);
});

test("a nudge on two consecutive rehearsal swings", () => {
  const base = baselineSwings();
  const lastT = base[base.length - 1].t;
  const rows = [
    ...base,
    makeRow("long_1", lastT + 60000, "I7", 1.8),
    makeRow("long_2", lastT + 120000, "I7", 1.8)
  ];
  const res = DrillNudge.check(rows);
  assert.notStrictEqual(res, null);
  assert.deepStrictEqual(res.names, ["long_1", "long_2"]); // oldest first
  assert.strictEqual(res.club, "I7");
  assert.strictEqual(res.backswing, 1.8);
  assert.strictEqual(res.usual, 0.9);
});

test("a normal swing after them clears it", () => {
  const base = baselineSwings();
  const lastT = base[base.length - 1].t;
  const rows = [
    ...base,
    makeRow("long_1", lastT + 60000, "I7", 1.8),
    makeRow("long_2", lastT + 120000, "I7", 1.8),
    makeRow("norm_1", lastT + 180000, "I7", 0.9) // normal swing clears the run
  ];
  const res = DrillNudge.check(rows);
  assert.strictEqual(res, null);
});

test("a pending newest swing doesn't hide the two before it", () => {
  const base = baselineSwings();
  const lastT = base[base.length - 1].t;
  const rows = [
    ...base,
    makeRow("long_1", lastT + 60000, "I7", 1.8),
    makeRow("long_2", lastT + 120000, "I7", 1.8),
    makeRow("pending_1", lastT + 180000, "I7", null) // pending swing skipped
  ];
  const res = DrillNudge.check(rows);
  assert.notStrictEqual(res, null);
  assert.deepStrictEqual(res.names, ["long_1", "long_2"]);
  assert.strictEqual(res.backswing, 1.8);
  assert.strictEqual(res.usual, 0.9);
});

test("drill and left-out swings are neither counted nor shift the usual", () => {
  const base = baselineSwings();
  const lastT = base[base.length - 1].t;
  const rows = [
    ...base,
    makeRow("drill_1", lastT + 30000, "I7", 2.2, { drill: "pump" }),
    makeRow("excl_1", lastT + 60000, "I7", 2.2, { excluded: true }),
    makeRow("long_1", lastT + 90000, "I7", 1.8),
    makeRow("long_2", lastT + 120000, "I7", 1.8)
  ];
  const res = DrillNudge.check(rows);
  assert.notStrictEqual(res, null);
  // Only long_1 and long_2 are in names
  assert.deepStrictEqual(res.names, ["long_1", "long_2"]);
  // usual is still 0.9 (unaffected by 2.2s drill or excluded swings)
  assert.strictEqual(res.usual, 0.9);

  // If there is only one normal long swing with a left-out long swing, no nudge
  const rowsSingle = [
    ...base,
    makeRow("excl_1", lastT + 60000, "I7", 1.8, { excluded: true }),
    makeRow("long_1", lastT + 90000, "I7", 1.8)
  ];
  assert.strictEqual(DrillNudge.check(rowsSingle), null);
});

test("a club with under 10 swings never nudges (review.js rule)", () => {
  // Only 5 swings total with 7 iron, all with long backswing
  const rows = [];
  const startT = 1000000;
  for (let i = 0; i < 5; i++) {
    rows.push(makeRow(`i7_${i}`, startT + i * 60000, "I7", 1.8));
  }
  assert.strictEqual(DrillNudge.check(rows), null);
});

test("another session's swings don't count", () => {
  const base = baselineSwings(1000000);
  const lastT = base[base.length - 1].t;
  const rows = [
    ...base,
    makeRow("session1_long", lastT + 60000, "I7", 1.8),
    // Gap of 60 minutes (> 45 min session gap)
    makeRow("session2_long", lastT + 60000 + 3600000, "I7", 1.8)
  ];
  // Since session2 only has 1 long backswing, it should not nudge
  const res = DrillNudge.check(rows);
  assert.strictEqual(res, null);
});

test("a swing already reviewed ends the run", () => {
  const base = baselineSwings();
  const lastT = base[base.length - 1].t;
  const rows = [
    ...base,
    makeRow("long_1", lastT + 60000, "I7", 1.8),
    makeRow("long_2", lastT + 120000, "I7", 1.8, { reviewed: true })
  ];
  // long_2 is reviewed, so run breaks at long_2 -> run has 0 items
  assert.strictEqual(DrillNudge.check(rows), null);
});
