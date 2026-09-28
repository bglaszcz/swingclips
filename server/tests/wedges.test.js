// wedges.js: swing size from club speed, the cells and the biggest hole.
const test = require("node:test");
const assert = require("node:assert");
const W = require("../static/wedges.js");

// A shot as /api/clips gives it: club, carry and club speed.
const shot = (club, carry, speed, extra = {}) => ({ shot: { club, ball: { carry }, clubData: { speed } }, ...extra });
// Ten full swings at 85-88.6 mph with carries 100-109.
const fulls = club => Array.from({ length: 10 }, (_, i) => shot(club, 100 + i, 85 + i * 0.4));

test("full speed is the 90th percentile, once there are 10 shots", () => {
  assert.strictEqual(W.fullSpeed([80, 81, 82, 83, 84, 85, 86, 87, 88]), null);
  assert.ok(Math.abs(W.fullSpeed([80, 81, 82, 83, 84, 85, 86, 87, 88, 89]) - 88.1) < 1e-9);
  assert.strictEqual(W.fullSpeed([80, 81, null, 83, 84, 85, 86, 87, 88, 89]), null);   // no speed: doesn't count
});

test("bucket edges", () => {
  assert.strictEqual(W.sizeOf(0.6499), null);
  assert.strictEqual(W.sizeOf(0.65), "half");
  assert.strictEqual(W.sizeOf(0.7999), "half");
  assert.strictEqual(W.sizeOf(0.80), "threeq");
  assert.strictEqual(W.sizeOf(0.9199), "threeq");
  assert.strictEqual(W.sizeOf(0.92), "full");
  assert.strictEqual(W.sizeOf(1.1), "full");
  assert.strictEqual(W.sizeOf(null), null);
});

test("cells: sizes by share of full speed, 3 shots each, mishits and chips left out", () => {
  const full = 88;
  const rows = [...fulls("GW"),
    shot("GW", 80, 0.85 * full), shot("GW", 82, 0.85 * full), shot("GW", 84, 0.85 * full),   // three quarter
    shot("GW", 60, 0.70 * full), shot("GW", 62, 0.70 * full),                                  // half: only 2
    shot("GW", 30, 0.50 * full),                                                                // a chip
    shot("GW", 0, 0.85 * full), shot("GW", 90, 0.85 * full, { excluded: true }),               // mishit, left out
    { shot: { club: "GW", ball: { carry: 95 }, clubData: { speed: 0.85 * full }, valid: false } }];
  const a = W.analyze(rows);
  const gw = a.wedges[0];
  assert.strictEqual(gw.club, "GW");
  assert.strictEqual(gw.cells.threeq.n, 3);
  assert.strictEqual(gw.cells.threeq.median, 82);
  assert.strictEqual(gw.cells.half.n, 2);
  assert.strictEqual(gw.cells.half.enough, false);
  assert.ok(gw.cells.full.enough);
});

test("a wedge without 10 speeds has no cells; bag order; not the irons", () => {
  const rows = [...fulls("GW"), ...fulls("PW"), shot("SW", 70, 70), shot("I9", 130, 90)];
  const a = W.analyze(rows);
  assert.deepStrictEqual(a.wedges.map(w => w.club), ["PW", "GW", "SW"]);
  assert.strictEqual(a.wedges[2].fullSpeed, null);
  assert.strictEqual(a.wedges[2].cells.full.n, 0);
});

test("the period limits the cells, not the full speed", () => {
  const old = fulls("PW").map(r => ({ ...r, t: 1000 }));
  const recent = [shot("PW", 120, 88, { t: 5000 }), shot("PW", 121, 88, { t: 5000 }), shot("PW", 122, 88, { t: 5000 })];
  const a = W.analyze([...old, ...recent], { since: 2000 });
  assert.ok(Math.abs(a.wedges[0].fullSpeed - 88) < 1);
  assert.strictEqual(a.wedges[0].cells.full.n, 3);
  assert.strictEqual(a.wedges[0].cells.full.median, 121);
});

test("biggest hole between the cells' medians", () => {
  const cell = (name, label, median, enough = true) => ({ name, label, median, enough });
  assert.strictEqual(W.biggestHole([cell("GW", "Half", 60), cell("GW", "Full", 100)]), null);
  const h = W.biggestHole([cell("GW", "Half", 60), cell("PW", "Half", 78), cell("GW", "Full", 100), cell("PW", "Full", 110),
                           cell("SW", "Full", 70, false)]);
  assert.strictEqual(h.gap, 22);
  assert.strictEqual(W.holeText(h), "Biggest hole: 78 yd (PW half) to 100 yd (GW full): 22 yd with no stock shot.");
});
