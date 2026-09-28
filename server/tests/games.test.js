// games.js test suite: strokes gained baseline interpolation, shot scoring,
// session summaries, and practice game planning / stepping.
//
// Run with: node --test tests/games.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const Games = require("../static/games.js");

test("expectedPutts: table interpolation and clamping", () => {
  // Clamped under 2 ft: returns 1.0
  assert.equal(Games.expectedPutts(0), 1.0);
  assert.equal(Games.expectedPutts(1), 1.0);
  assert.equal(Games.expectedPutts(1.9), 1.0);

  // Exact rows
  assert.equal(Games.expectedPutts(2), 1.01);
  assert.equal(Games.expectedPutts(3), 1.04);
  assert.equal(Games.expectedPutts(4), 1.13);
  assert.equal(Games.expectedPutts(5), 1.23);
  assert.equal(Games.expectedPutts(6), 1.34);
  assert.equal(Games.expectedPutts(8), 1.50);
  assert.equal(Games.expectedPutts(10), 1.61);
  assert.equal(Games.expectedPutts(15), 1.78);
  assert.equal(Games.expectedPutts(20), 1.87);
  assert.equal(Games.expectedPutts(30), 1.98);
  assert.equal(Games.expectedPutts(40), 2.06);
  assert.equal(Games.expectedPutts(50), 2.14);
  assert.equal(Games.expectedPutts(60), 2.21);
  assert.equal(Games.expectedPutts(90), 2.40);

  // Linear interpolation between rows
  // 2.5 ft: halfway between 2 ft (1.01) and 3 ft (1.04) -> 1.025
  assert.ok(Math.abs(Games.expectedPutts(2.5) - 1.025) < 1e-9);
  // 12.5 ft: halfway between 10 ft (1.61) and 15 ft (1.78) -> 1.695
  assert.ok(Math.abs(Games.expectedPutts(12.5) - 1.695) < 1e-9);

  // Clamped at 90+ ft: returns 2.40
  assert.equal(Games.expectedPutts(90), 2.40);
  assert.equal(Games.expectedPutts(100), 2.40);
  assert.equal(Games.expectedPutts(150), 2.40);

  // Non-finite
  assert.equal(Games.expectedPutts(null), null);
  assert.equal(Games.expectedPutts(NaN), null);
});

test("expectedStrokes: table interpolation and clamping", () => {
  // Clamped under 20 yd: returns 2.40
  assert.equal(Games.expectedStrokes(0), 2.40);
  assert.equal(Games.expectedStrokes(10), 2.40);
  assert.equal(Games.expectedStrokes(20), 2.40);

  // Exact rows
  assert.equal(Games.expectedStrokes(40), 2.60);
  assert.equal(Games.expectedStrokes(60), 2.70);
  assert.equal(Games.expectedStrokes(80), 2.75);
  assert.equal(Games.expectedStrokes(100), 2.80);
  assert.equal(Games.expectedStrokes(120), 2.85);
  assert.equal(Games.expectedStrokes(140), 2.91);
  assert.equal(Games.expectedStrokes(160), 2.98);
  assert.equal(Games.expectedStrokes(180), 3.05);
  assert.equal(Games.expectedStrokes(200), 3.19);
  assert.equal(Games.expectedStrokes(220), 3.32);
  assert.equal(Games.expectedStrokes(240), 3.45);

  // Linear interpolation between rows
  // 30 yd: halfway between 20 yd (2.40) and 40 yd (2.60) -> 2.50
  assert.ok(Math.abs(Games.expectedStrokes(30) - 2.50) < 1e-9);
  // 70 yd: halfway between 60 yd (2.70) and 80 yd (2.75) -> 2.725
  assert.ok(Math.abs(Games.expectedStrokes(70) - 2.725) < 1e-9);

  // Clamped at 240+ yd: returns 3.45
  assert.equal(Games.expectedStrokes(240), 3.45);
  assert.equal(Games.expectedStrokes(250), 3.45);
  assert.equal(Games.expectedStrokes(350), 3.45);

  // Non-finite
  assert.equal(Games.expectedStrokes(null), null);
  assert.equal(Games.expectedStrokes(NaN), null);
});

test("scoreShot: holed shot gives E_off(T) - 1 - 1.0", () => {
  const target = 100;
  const res = Games.scoreShot(target, { carry: 100, offline: 0 });
  assert.ok(res);
  assert.equal(res.along, 0);
  assert.equal(res.side, 0);
  assert.equal(res.dist, 0);
  assert.equal(res.onGreen, true);
  // E_off(100) = 2.80, E_end = expectedPutts(0) = 1.0, sg = 2.80 - 1.0 - 1 = 0.80
  const expectedSg = Games.expectedStrokes(target) - 1 - 1.0;
  assert.equal(res.sg, expectedSg);
  assert.equal(res.verdict, "pin high, on line, on the green");
});

test("scoreShot: on/off the green at the 15 yd edge", () => {
  const target = 100;

  // Exactly 15 yd away -> on green (dist <= 15)
  const onEdge = Games.scoreShot(target, { carry: 115, offline: 0 });
  assert.ok(onEdge);
  assert.equal(onEdge.dist, 15);
  assert.equal(onEdge.onGreen, true);
  // 15 yd = 45 ft on green -> expectedPutts(45) = 2.10
  // sg = 2.80 - 2.10 - 1 = -0.30
  assert.ok(Math.abs(onEdge.sg - -0.30) < 1e-9);
  assert.equal(onEdge.verdict, "15 long, on line, on the green");

  // Just over 15 yd away (15.1 yd) -> off green
  const offEdge = Games.scoreShot(target, { carry: 115.1, offline: 0 });
  assert.ok(offEdge);
  assert.ok(Math.abs(offEdge.dist - 15.1) < 1e-9);
  assert.equal(offEdge.onGreen, false);
  // Off green at 15.1 yd -> expectedStrokes(15.1) = 2.40 (clamped at <= 20)
  // sg = 2.80 - 2.40 - 1 = -0.60
  assert.ok(Math.abs(offEdge.sg - -0.60) < 1e-9);
  assert.equal(offEdge.verdict, "15 long, on line");
});

test("scoreShot: sign of along/side and verdict wording", () => {
  // Prompt example: "8 short, 3 right, on the green"
  const s1 = Games.scoreShot(100, { carry: 92, offline: 3 });
  assert.ok(s1);
  assert.equal(s1.along, -8);
  assert.equal(s1.side, 3);
  assert.equal(s1.onGreen, true);
  assert.equal(s1.verdict, "8 short, 3 right, on the green");

  // Prompt example: "14 long, 11 left"
  const s2 = Games.scoreShot(100, { carry: 114, offline: -11 });
  assert.ok(s2);
  assert.equal(s2.along, 14);
  assert.equal(s2.side, -11);
  assert.equal(s2.onGreen, false);
  assert.equal(s2.verdict, "14 long, 11 left");

  // Pin high (|along| < 1) and on line (|side| < 1)
  const s3 = Games.scoreShot(100, { carry: 100.4, offline: -0.2 });
  assert.ok(s3);
  assert.equal(s3.verdict, "pin high, on line, on the green");

  // Pin high, 5 right
  const s4 = Games.scoreShot(100, { carry: 99.8, offline: 5.2 });
  assert.ok(s4);
  assert.equal(s4.verdict, "pin high, 5 right, on the green");

  // 12 short, on line
  const s5 = Games.scoreShot(100, { carry: 88.0, offline: 0.1 });
  assert.ok(s5);
  assert.equal(s5.verdict, "12 short, on line, on the green");
});

test("scoreShot: null for mishits and invalid inputs", () => {
  assert.equal(Games.scoreShot(100, null), null);
  assert.equal(Games.scoreShot(100, {}), null);
  assert.equal(Games.scoreShot(100, { carry: 0, offline: 0 }), null);
  assert.equal(Games.scoreShot(100, { carry: -10, offline: 0 }), null);
  assert.equal(Games.scoreShot(100, { carry: null, offline: 0 }), null);
  assert.equal(Games.scoreShot(100, { carry: NaN, offline: 0 }), null);
  assert.equal(Games.scoreShot(100, { carry: 100, offline: null }), null);
  assert.equal(Games.scoreShot(100, { carry: 100, offline: NaN }), null);
  assert.equal(Games.scoreShot(0, { carry: 100, offline: 0 }), null);
  assert.equal(Games.scoreShot(-50, { carry: 100, offline: 0 }), null);
  assert.equal(Games.scoreShot(null, { carry: 100, offline: 0 }), null);
});

test("summarize: handles valid shots and mishits", () => {
  const results = [
    { target: 100, sg: 0.5, onGreen: true, dist: 6 },
    { target: 100, sg: -0.1, onGreen: true, dist: 14 },
    { target: 100, sg: null }, // mishit: counts as MISHIT_SG (-1.0)
    { target: 150, sg: 0.2, onGreen: true, dist: 10 },
    { target: 150, sg: -0.4, onGreen: false, dist: 22 },
  ];

  const s = Games.summarize(results);
  assert.equal(s.shots, 5);
  assert.equal(s.mishits, 1);
  // Total SG = 0.5 + (-0.1) + (-1.0) + 0.2 + (-0.4) = -0.8
  assert.ok(Math.abs(s.sgTotal - -0.8) < 1e-9);
  // SG per shot = -0.8 / 5 = -0.16
  assert.ok(Math.abs(s.sgPerShot - -0.16) < 1e-9);
  assert.equal(s.greens, 3);

  // byTarget sorted by target ascending
  assert.equal(s.byTarget.length, 2);
  assert.equal(s.byTarget[0].target, 100);
  assert.equal(s.byTarget[0].shots, 3);
  // Target 100 SG: (0.5 - 0.1 - 1.0) / 3 = -0.6 / 3 = -0.2
  assert.ok(Math.abs(s.byTarget[0].sgPerShot - -0.2) < 1e-9);
  // Target 100 avgDist: (6 + 14) / 2 = 10 (mishit excluded from dist)
  assert.equal(s.byTarget[0].avgDist, 10);

  assert.equal(s.byTarget[1].target, 150);
  assert.equal(s.byTarget[1].shots, 2);
  assert.ok(Math.abs(s.byTarget[1].sgPerShot - -0.1) < 1e-9);
  assert.equal(s.byTarget[1].avgDist, 16);

  // Empty summary
  const empty = Games.summarize([]);
  assert.deepEqual(empty, {
    shots: 0,
    mishits: 0,
    sgTotal: 0,
    sgPerShot: 0,
    greens: 0,
    byTarget: [],
  });
});

test("games plan: deterministic with same seed, different with different seed, correct length and targets", () => {
  // Combine
  const c1 = Games.GAMES.combine.plan({ seed: 42 });
  const c2 = Games.GAMES.combine.plan({ seed: 42 });
  const c3 = Games.GAMES.combine.plan({ seed: 99 });
  assert.deepEqual(c1, c2);
  assert.notDeepEqual(c1, c3);
  assert.equal(c1.length, 27);
  // Exactly 3 of each target in COMBINE_TARGETS
  for (const t of Games.COMBINE_TARGETS) {
    assert.equal(c1.filter(x => x === t).length, 3);
  }

  // Wedges: fixed list of 13 shots
  const w = Games.GAMES.wedges.plan();
  assert.equal(w.length, 13);
  assert.deepEqual(w, Games.WEDGE_TARGETS);

  // Random: deterministic per seed, correct length and targets
  const r1 = Games.GAMES.random.plan({ seed: 42, count: 20 });
  const r2 = Games.GAMES.random.plan({ seed: 42, count: 20 });
  const r3 = Games.GAMES.random.plan({ seed: 99, count: 20 });
  assert.deepEqual(r1, r2);
  assert.notDeepEqual(r1, r3);
  assert.equal(r1.length, 20);
  for (const t of r1) {
    assert.equal(t % 5, 0);
    assert.ok(t >= 40 && t <= 150);
  }

  // Custom random options
  const rCustom = Games.GAMES.random.plan({ seed: 10, count: 12, min: 60, max: 100 });
  assert.equal(rCustom.length, 12);
  for (const t of rCustom) {
    assert.equal(t % 5, 0);
    assert.ok(t >= 60 && t <= 100);
  }
});

test("combine plan has no back-to-back repeats across multiple seeds", () => {
  const testSeeds = [1, 2, 7, 42, 100, 999, 12345, 999999];
  for (const seed of testSeeds) {
    const plan = Games.GAMES.combine.plan({ seed });
    assert.equal(plan.length, 27);
    for (let i = 1; i < plan.length; i++) {
      assert.notEqual(
        plan[i],
        plan[i - 1],
        `Seed ${seed} had back-to-back duplicate ${plan[i]} at index ${i}`
      );
    }
  }
});

test("ladder next: steps up only after green, stops at max and at count", () => {
  const ladder = Games.GAMES.ladder;

  // Starts at min (default 50)
  assert.equal(ladder.next({}, []), 50);

  // Miss green: target stays 50
  assert.equal(ladder.next({}, [{ target: 50, onGreen: false }]), 50);

  // Hit green: target steps up to 60
  assert.equal(
    ladder.next({}, [
      { target: 50, onGreen: false },
      { target: 50, onGreen: true },
    ]),
    60
  );

  // Simulate climb up to max (150)
  const history = [];
  for (let t = 50; t < 150; t += 10) {
    history.push({ target: t, onGreen: true });
  }
  // At this point we hit greens at 50, 60, 70, 80, 90, 100, 110, 120, 130, 140
  // Next target should be 150
  assert.equal(ladder.next({}, history), 150);

  // Miss green at 150 -> target stays 150
  history.push({ target: 150, onGreen: false });
  assert.equal(ladder.next({}, history), 150);

  // Hit green at 150 -> game is over (returns null)
  history.push({ target: 150, onGreen: true });
  assert.equal(ladder.next({}, history), null);

  // Stops at count limit even if max green not reached
  const countHistory = Array.from({ length: 10 }, () => ({ target: 50, onGreen: false }));
  assert.equal(ladder.next({ count: 10 }, countHistory), null);
});

test("fixed games next: returns null at the end", () => {
  // Combine: 27 shots
  const cPlan = Games.GAMES.combine.plan({ seed: 1 });
  const cHist = cPlan.map(t => ({ target: t, onGreen: true }));
  assert.equal(Games.GAMES.combine.next({ seed: 1 }, cHist), null);

  // Wedges: 13 shots
  const wPlan = Games.GAMES.wedges.plan();
  const wHist = wPlan.map(t => ({ target: t, onGreen: true }));
  assert.equal(Games.GAMES.wedges.next({}, wHist), null);

  // Random: 20 shots
  const rPlan = Games.GAMES.random.plan({ seed: 1, count: 20 });
  const rHist = rPlan.map(t => ({ target: t, onGreen: true }));
  assert.equal(Games.GAMES.random.next({ seed: 1, count: 20 }, rHist), null);
});

test("game definitions have required metadata", () => {
  for (const [id, game] of Object.entries(Games.GAMES)) {
    assert.equal(game.id, id);
    assert.equal(typeof game.name, "string");
    assert.equal(typeof game.describe, "string");
    assert.ok(game.describe.length > 10);
    assert.equal(game.clubsHint, "any");
    assert.equal(typeof game.next, "function");
  }
});
