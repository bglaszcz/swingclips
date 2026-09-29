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

test("scoreFor: dispatches to game-specific score or falls back to scoreShot", () => {
  // combine uses scoreShot
  const c = Games.scoreFor("combine", 100, { carry: 100, offline: 0 });
  assert.ok(c);
  assert.equal(c.verdict, "pin high, on line, on the green");

  // driving uses scoreDriving
  const d = Games.scoreFor("driving", 0, { carry: 240, offline: 5 });
  assert.ok(d);
  assert.equal(d.verdict, "fairway, 240");

  // shaping uses scoreShaping
  const s = Games.scoreFor("shaping", "draw", { carry: 150, offline: -5, spinAxis: -5 });
  assert.ok(s);
  assert.equal(s.verdict, "draw, good");

  // unknown falls back to scoreShot
  const u = Games.scoreFor("unknown", 100, { carry: 100, offline: 0 });
  assert.ok(u);
  assert.equal(u.verdict, "pin high, on line, on the green");
});

test("driving score: band edges at 15 and 30 yd, sg order fairway > rough > miss", () => {
  const carry = 240;
  // Par 4 (400 yd): rem = 160 yd -> expectedStrokes(160) = 2.98
  // Fairway sg: 3.99 - 2.98 - 1 = 0.01
  // Rough sg: 3.99 - (2.98 + 0.20) - 1 = -0.19
  // Miss sg: 3.99 - (2.98 + 0.60) - 1 = -0.59

  // Center: fairway
  const sCenter = Games.scoreFor("driving", 0, { carry, offline: 0 });
  assert.equal(sCenter.onGreen, true);
  assert.equal(sCenter.verdict, "fairway, 240");
  assert.ok(Math.abs(sCenter.sg - 0.01) < 1e-9);

  // Exact fairway edges at 15.0 yd
  const s15R = Games.scoreFor("driving", 0, { carry, offline: 15.0 });
  assert.equal(s15R.onGreen, true);
  assert.equal(s15R.verdict, "fairway, 240");
  assert.ok(Math.abs(s15R.sg - 0.01) < 1e-9);

  const s15L = Games.scoreFor("driving", 0, { carry, offline: -15.0 });
  assert.equal(s15L.onGreen, true);
  assert.equal(s15L.verdict, "fairway, 240");
  assert.ok(Math.abs(s15L.sg - 0.01) < 1e-9);

  // Just into rough at 15.1 yd
  const s151R = Games.scoreFor("driving", 0, { carry, offline: 15.1 });
  assert.equal(s151R.onGreen, false);
  assert.equal(s151R.verdict, "15 right, rough, 240");
  assert.ok(Math.abs(s151R.sg - -0.19) < 1e-9);

  const s151L = Games.scoreFor("driving", 0, { carry, offline: -15.1 });
  assert.equal(s151L.onGreen, false);
  assert.equal(s151L.verdict, "15 left, rough, 240");
  assert.ok(Math.abs(s151L.sg - -0.19) < 1e-9);

  // Prompt example: "18 right, rough, 231"
  const s18R = Games.scoreFor("driving", 0, { carry: 231, offline: 18 });
  assert.equal(s18R.onGreen, false);
  assert.equal(s18R.verdict, "18 right, rough, 231");

  // Exact rough edges at 30.0 yd
  const s30R = Games.scoreFor("driving", 0, { carry, offline: 30.0 });
  assert.equal(s30R.onGreen, false);
  assert.equal(s30R.verdict, "30 right, rough, 240");
  assert.ok(Math.abs(s30R.sg - -0.19) < 1e-9);

  const s30L = Games.scoreFor("driving", 0, { carry, offline: -30.0 });
  assert.equal(s30L.onGreen, false);
  assert.equal(s30L.verdict, "30 left, rough, 240");
  assert.ok(Math.abs(s30L.sg - -0.19) < 1e-9);

  // Just into miss at 30.1 yd
  const s301R = Games.scoreFor("driving", 0, { carry, offline: 30.1 });
  assert.equal(s301R.onGreen, false);
  assert.equal(s301R.verdict, "30 right, a miss, 240");
  assert.ok(Math.abs(s301R.sg - -0.59) < 1e-9);

  // Prompt example: "35 left, a miss, 220"
  const s35L = Games.scoreFor("driving", 0, { carry: 220, offline: -35 });
  assert.equal(s35L.onGreen, false);
  assert.equal(s35L.verdict, "35 left, a miss, 220");

  // SG order check: fairway > rough > miss
  assert.ok(sCenter.sg > s151R.sg);
  assert.ok(s151R.sg > s301R.sg);
  assert.ok(Math.abs((sCenter.sg - s151R.sg) - 0.20) < 1e-9);
  assert.ok(Math.abs((s151R.sg - s301R.sg) - 0.40) < 1e-9);
  assert.ok(Math.abs((sCenter.sg - s301R.sg) - 0.60) < 1e-9);

  // Mishits and invalid inputs
  assert.equal(Games.scoreFor("driving", 0, null), null);
  assert.equal(Games.scoreFor("driving", 0, { carry: 0, offline: 0 }), null);
  assert.equal(Games.scoreFor("driving", 0, { carry: -10, offline: 0 }), null);
  assert.equal(Games.scoreFor("driving", 0, { carry: 240, offline: null }), null);
  assert.equal(Games.scoreFor("driving", 0, { carry: 240, offline: NaN }), null);

  // Driving plan and next
  const dPlan = Games.GAMES.driving.plan();
  assert.equal(dPlan.length, 14);
  assert.ok(dPlan.every(t => t === 0));
  assert.equal(Games.GAMES.driving.next({}, []), 0);
  assert.equal(
    Games.GAMES.driving.next({}, Array(14).fill({ target: 0, onGreen: true })),
    null
  );
});

test("shaping score: draw/fade edges at 3 deg, 10% line rule, and missing spinAxis", () => {
  // 3 deg spinAxis edges: target "draw"
  // Carry 100: max offline 10 yd
  const dGood = Games.scoreFor("shaping", "draw", { carry: 100, offline: 0, spinAxis: -3.0 });
  assert.ok(dGood);
  assert.equal(dGood.onGreen, true);
  assert.equal(dGood.verdict, "draw, good");
  assert.equal(dGood.sg, 0);

  const dStraight = Games.scoreFor("shaping", "draw", { carry: 100, offline: 0, spinAxis: -2.9 });
  assert.ok(dStraight);
  assert.equal(dStraight.onGreen, false);
  assert.equal(dStraight.verdict, "straight, wanted a draw");
  assert.equal(dStraight.sg, -0.5);

  const dFade = Games.scoreFor("shaping", "draw", { carry: 100, offline: 0, spinAxis: 3.0 });
  assert.ok(dFade);
  assert.equal(dFade.onGreen, false);
  assert.equal(dFade.verdict, "fade, wanted a draw");
  assert.equal(dFade.sg, -0.5);

  // 3 deg spinAxis edges: target "fade"
  const fGood = Games.scoreFor("shaping", "fade", { carry: 100, offline: 0, spinAxis: 3.0 });
  assert.ok(fGood);
  assert.equal(fGood.onGreen, true);
  assert.equal(fGood.verdict, "fade, good");
  assert.equal(fGood.sg, 0);

  const fStraight = Games.scoreFor("shaping", "fade", { carry: 100, offline: 0, spinAxis: 2.9 });
  assert.ok(fStraight);
  assert.equal(fStraight.onGreen, false);
  assert.equal(fStraight.verdict, "straight, wanted a fade");
  assert.equal(fStraight.sg, -0.5);

  const fDraw = Games.scoreFor("shaping", "fade", { carry: 100, offline: 0, spinAxis: -3.0 });
  assert.ok(fDraw);
  assert.equal(fDraw.onGreen, false);
  assert.equal(fDraw.verdict, "draw, wanted a fade");
  assert.equal(fDraw.sg, -0.5);

  // 10% line rule: carry 100 -> max offline 10 yd
  // Offline exactly 10.0 yd -> good
  const dLine10 = Games.scoreFor("shaping", "draw", { carry: 100, offline: -10.0, spinAxis: -5 });
  assert.equal(dLine10.onGreen, true);
  assert.equal(dLine10.verdict, "draw, good");

  // Offline 10.1 yd -> outside line
  const dLine101 = Games.scoreFor("shaping", "draw", { carry: 100, offline: -10.1, spinAxis: -5 });
  assert.equal(dLine101.onGreen, false);
  assert.equal(dLine101.verdict, "draw, but 10 left");

  // Prompt example: "draw, but 14 left"
  const dPrompt = Games.scoreFor("shaping", "draw", { carry: 100, offline: -14, spinAxis: -5 });
  assert.equal(dPrompt.onGreen, false);
  assert.equal(dPrompt.verdict, "draw, but 14 left");

  // Fade with offline too far right
  const fLineRight = Games.scoreFor("shaping", "fade", { carry: 100, offline: 15, spinAxis: 5 });
  assert.equal(fLineRight.onGreen, false);
  assert.equal(fLineRight.verdict, "fade, but 15 right");

  // Missing spinAxis is mishit (null)
  assert.equal(Games.scoreFor("shaping", "draw", { carry: 100, offline: 0 }), null);
  assert.equal(Games.scoreFor("shaping", "draw", { carry: 100, offline: 0, spinAxis: null }), null);
  assert.equal(Games.scoreFor("shaping", "draw", { carry: 100, offline: 0, spinAxis: NaN }), null);
  assert.equal(Games.scoreFor("shaping", "draw", { carry: 0, offline: 0, spinAxis: -5 }), null);
  assert.equal(Games.scoreFor("shaping", "draw", { carry: 100, offline: null, spinAxis: -5 }), null);
  assert.equal(Games.scoreFor("shaping", "straight", { carry: 100, offline: 0, spinAxis: 0 }), null);
});

test("shaping plan: 6 draws and 6 fades, never 3 in a row, deterministic by seed", () => {
  const seeds = [1, 2, 7, 42, 99, 100, 999, 12345, 999999];
  for (const seed of seeds) {
    const plan = Games.GAMES.shaping.plan({ seed });
    assert.equal(plan.length, 12, `Seed ${seed} length`);
    const draws = plan.filter(s => s === "draw").length;
    const fades = plan.filter(s => s === "fade").length;
    assert.equal(draws, 6, `Seed ${seed} draws`);
    assert.equal(fades, 6, `Seed ${seed} fades`);

    // Never 3 of the same in a row
    for (let i = 2; i < plan.length; i++) {
      assert.ok(
        !(plan[i] === plan[i - 1] && plan[i] === plan[i - 2]),
        `Seed ${seed} had 3 consecutive ${plan[i]} at index ${i}`
      );
    }
  }

  // Determinism
  const p1 = Games.GAMES.shaping.plan({ seed: 42 });
  const p2 = Games.GAMES.shaping.plan({ seed: 42 });
  const p3 = Games.GAMES.shaping.plan({ seed: 99 });
  assert.deepEqual(p1, p2);
  assert.notDeepEqual(p1, p3);

  // Next stops at 12 shots
  const hist = p1.map(t => ({ target: t, onGreen: true }));
  assert.equal(Games.GAMES.shaping.next({ seed: 42 }, hist), null);
});

test("every game has sayTarget returning expected phrasing", () => {
  for (const [id, game] of Object.entries(Games.GAMES)) {
    assert.equal(typeof game.sayTarget, "function", `Game ${id} has sayTarget`);
  }

  assert.equal(Games.GAMES.combine.sayTarget(110), "110 yards");
  assert.equal(Games.GAMES.wedges.sayTarget(40), "40 yards");
  assert.equal(Games.GAMES.random.sayTarget(75), "75 yards");
  assert.equal(Games.GAMES.ladder.sayTarget(100), "100 yards");
  assert.equal(Games.GAMES.driving.sayTarget(0), "the fairway");
  assert.equal(Games.GAMES.shaping.sayTarget("draw"), "a draw");
  assert.equal(Games.GAMES.shaping.sayTarget("fade"), "a fade");
});

test("game definitions have required metadata", () => {
  for (const [id, game] of Object.entries(Games.GAMES)) {
    assert.equal(game.id, id);
    assert.equal(typeof game.name, "string");
    assert.equal(typeof game.describe, "string");
    assert.ok(game.describe.length > 10);
    assert.equal(game.clubsHint, "any");
    assert.equal(typeof game.next, "function");
    assert.equal(typeof game.sayTarget, "function");
  }
});

test("combineBreakdown: empty log and non-combine games ignored", () => {
  assert.deepEqual(Games.combineBreakdown([]), { targets: [], byTarget: [], worst: [] });
  assert.deepEqual(Games.combineBreakdown(null), { targets: [], byTarget: [], worst: [] });

  const nonCombines = [
    { id: "wedges", results: [{ target: 50, sg: 0.2, onGreen: true }] },
    { id: "driving", results: [{ target: 0, sg: 0.1, onGreen: true }] },
  ];
  assert.deepEqual(Games.combineBreakdown(nonCombines), { targets: [], byTarget: [], worst: [] });
});

test("combineBreakdown: only combines counted and latest N used", () => {
  const log = [
    { id: "combine", results: [{ target: 50, sg: 0.5, onGreen: true, dist: 5 }] }, // 1st (too old for last: 2)
    { id: "wedges", results: [{ target: 50, sg: -0.9, onGreen: false, dist: 20 }] }, // ignored
    { id: "combine", results: [{ target: 50, sg: 0.1, onGreen: true, dist: 8 }] },  // 2nd
    { id: "combine", results: [{ target: 50, sg: -0.3, onGreen: false, dist: 12 }] }, // 3rd
  ];

  // Default last 3: includes 1st, 2nd, 3rd combines (not wedges)
  const b3 = Games.combineBreakdown(log);
  assert.equal(b3.targets.length, 1);
  assert.equal(b3.targets[0].target, 50);
  assert.equal(b3.targets[0].shots, 3);
  // (0.5 + 0.1 - 0.3) / 3 = 0.1
  assert.ok(Math.abs(b3.targets[0].sgPerShot - 0.1) < 1e-9);
  assert.equal(b3.targets[0].greens, 2);
  assert.equal(b3.targets[0].avgDist, (5 + 8 + 12) / 3);

  // Custom last 2: only 2nd and 3rd combines
  const b2 = Games.combineBreakdown(log, { last: 2 });
  assert.equal(b2.targets.length, 1);
  assert.equal(b2.targets[0].shots, 2);
  // (0.1 - 0.3) / 2 = -0.1
  assert.ok(Math.abs(b2.targets[0].sgPerShot - -0.1) < 1e-9);
  assert.equal(b2.targets[0].greens, 1);
  assert.equal(b2.targets[0].avgDist, (8 + 12) / 2);
});

test("combineBreakdown: mishits count as MISHIT_SG", () => {
  const log = [
    {
      id: "combine",
      results: [
        { target: 100, sg: 0.5, onGreen: true, dist: 6 },
        { target: 100, sg: null }, // mishit: -1.0, dist excluded
        { target: 100, sg: -0.1, onGreen: true, dist: 12 },
      ],
    },
  ];
  const b = Games.combineBreakdown(log);
  assert.equal(b.targets.length, 1);
  assert.equal(b.targets[0].shots, 3);
  // (0.5 - 1.0 - 0.1) / 3 = -0.6 / 3 = -0.2
  assert.ok(Math.abs(b.targets[0].sgPerShot - -0.2) < 1e-9);
  assert.equal(b.targets[0].greens, 2);
  assert.equal(b.targets[0].avgDist, (6 + 12) / 2);
});

test("combineBreakdown: sorting by target ascending and 3-shot rule for worst", () => {
  const log = [
    {
      id: "combine",
      results: [
        // Target 140: 3 shots, avg SG -0.42
        { target: 140, sg: -0.40, onGreen: false },
        { target: 140, sg: -0.44, onGreen: false },
        { target: 140, sg: -0.42, onGreen: false },
        // Target 50: 3 shots, avg SG +0.20
        { target: 50, sg: 0.20, onGreen: true },
        { target: 50, sg: 0.20, onGreen: true },
        { target: 50, sg: 0.20, onGreen: true },
        // Target 95: only 2 shots, avg SG -0.90 (ineligible for worst despite lowest SG)
        { target: 95, sg: -0.90, onGreen: false },
        { target: 95, sg: -0.90, onGreen: false },
        // Target 155: 3 shots, avg SG -0.38
        { target: 155, sg: -0.38, onGreen: false },
        { target: 155, sg: -0.38, onGreen: false },
        { target: 155, sg: -0.38, onGreen: false },
        // Target 110: 3 shots, avg SG -0.10
        { target: 110, sg: -0.10, onGreen: true },
        { target: 110, sg: -0.10, onGreen: true },
        { target: 110, sg: -0.10, onGreen: true },
      ],
    },
  ];

  const b = Games.combineBreakdown(log);

  // Targets sorted ascending by target: 50, 95, 110, 140, 155
  assert.deepEqual(
    b.targets.map(t => t.target),
    [50, 95, 110, 140, 155]
  );

  // Worst: 2 targets with lowest sgPerShot having at least 3 shots
  // Target 95 is excluded (only 2 shots).
  // Remaining: 140 (-0.42), 155 (-0.38), 110 (-0.10), 50 (+0.20)
  // Two lowest: 140 and 155
  assert.equal(b.worst.length, 2);
  assert.equal(b.worst[0].target, 140);
  assert.ok(Math.abs(b.worst[0].sgPerShot - -0.42) < 1e-9);
  assert.equal(b.worst[1].target, 155);
  assert.ok(Math.abs(b.worst[1].sgPerShot - -0.38) < 1e-9);
});

