// Personal ranges from good shots (static/goodshots.js): which shots count as good, the ranges, the
// minimum count, the trust gating (trust.js), where a swing sits, and good vs the rest. Synthetic swings.
//
//   cd server && node --test tests/goodshots.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../static/summary.js");
const G = require("../static/goodshots.js");

/** A Square shot as the clip list has it. */
function shot({ carry = 150, side = 2, smash = 1.3, h = 0, v = 0, club = "I7" } = {}) {
  return { club, ball: { carry, side, speed: 110 }, clubData: { smash, faceImpactH: h, faceImpactV: v, speed: 85 } };
}
/** A swing record as swings.py keeps it. */
function record({ body = {}, face = [], dtl = [], p6 = false } = {}) {
  return { body: { tempo: 3.0, headSway: 0, hipSway: 1, earlyExt: 0.5, handsPlaneP6: 0.2, ...body },
           quality: { camera: { face, dtl }, p6Estimated: p6 } };
}
let T = 1_790_000_000;
function swing(opts = {}, rec = {}) {
  const s = { name: `swing_face_1920x1080_240fps_${T}_2000ms.mp4`, t: T++, club: opts.club || "I7",
              excluded: !!opts.excluded, shot: shot(opts), record: rec === null ? null : record(rec), light: null };
  return s;
}
const base = { n: 10, carry: 150, smash: 1.3, strikeH: 0, strikeV: 0 };
const nums = o => S.shotNumbers(shot(o));

test("clubs: woods, hybrids and the driver; irons and wedges; not the putter", () => {
  for (const c of ["DR", "W3", "H4", "3W"]) assert.equal(G.groupOf(c), "woods", c);
  for (const c of ["I7", "PW", "SW", "LW", "I3"]) assert.equal(G.groupOf(c), "irons", c);
  assert.equal(G.groupOf("PT"), null);
  assert.equal(G.groupOf(null), null);
});

test("good shot: offline within 5% of carry for irons, scaled to carry", () => {
  assert.equal(G.judgeShot(nums({ side: 7.5 }), base, "irons").good, true);     // exactly 5%
  const off = G.judgeShot(nums({ side: -7.6 }), base, "irons");
  assert.equal(off.good, false);
  assert.match(off.fails[0], /^offline 7.6 yd: more than 5% of carry \(7.5 yd\)/);
  // Woods: their own share (6%) of their own carry.
  const dr = { ...base, carry: 230 };
  assert.equal(G.judgeShot(nums({ carry: 230, side: 13.5 }), dr, "woods").good, true);
  assert.equal(G.judgeShot(nums({ carry: 230, side: 14.2 }), dr, "woods").good, false);
});

test("good shot: smash at or above my median, carry in my usual band", () => {
  assert.equal(G.judgeShot(nums({ smash: 1.3 }), base, "irons").good, true);
  assert.match(G.judgeShot(nums({ smash: 1.29 }), base, "irons").fails[0], /^smash 1.29: under your median 1.30/);
  // A tolerance can be set.
  assert.equal(G.judgeShot(nums({ smash: 1.29 }), base, "irons", { irons: { smashBelow: 0.02 } }).good, true);
  // Chunk (short), and a flyer past the band; the band is a share of my median carry.
  assert.match(G.judgeShot(nums({ carry: 120, side: 0 }), base, "irons").fails[0], /^carry 120 yd: short of your usual 135 to 168/);
  assert.match(G.judgeShot(nums({ carry: 170, side: 0 }), base, "irons").fails[0], /past your usual/);
  assert.equal(G.judgeShot(nums({ carry: 136, side: 0 }), base, "irons").good, true);
});

test("strike filter: near my usual spot on the face, when Square reports it; can be turned off", () => {
  const b = { ...base, strikeV: -15 };
  assert.equal(G.judgeShot(nums({ v: -30 }), b, "irons").good, true);            // 15 mm from my usual
  const bad = G.judgeShot(nums({ h: 25, v: -15 }), b, "irons");
  assert.equal(bad.good, false);
  assert.match(bad.fails[0], /strike 25 mm heel\/toe/);
  assert.equal(G.judgeShot(nums({ h: 25, v: -15 }), b, "irons", { strike: { on: false } }).good, true);
});

test("a number Square doesn't give is skipped, not held against the shot (the driver's smash, often)", () => {
  const s = S.shotNumbers({ club: "DR", ball: { carry: 230, side: 3 } });
  const b = G.baselineOf([s, s, s, s, s]);
  const v = G.judgeShot(s, b, "woods");
  assert.equal(v.good, true);
  assert.ok(v.skipped.some(x => x.startsWith("smash")));
  assert.ok(v.skipped.some(x => x.startsWith("strike")));
});

test("no good shots until the club's usual numbers are known", () => {
  const v = G.judgeShot(nums({}), null, "irons");
  assert.equal(v.good, false);
  const b = G.build([1, 2, 3, 4].map(() => swing({})), null, null);
  assert.equal(b.clubs.I7.good, 0);
  assert.equal(b.clubs.I7.baseline, null);
});

test("build: my medians per club, excluded swings and the putter left out", () => {
  const swings = [
    ...[148, 150, 150, 152, 150].map(carry => swing({ carry, side: 0 })),
    swing({ carry: 400, side: 0, excluded: true }),              // someone else's: not in the median
    swing({ carry: 100, side: 0 }),                               // chunk
    ...[230, 232, 228, 231, 229].map(carry => swing({ carry, side: 1, club: "DR" })),
    swing({ club: "PT", carry: 3, side: 0 }),
  ];
  const b = G.build(swings, null, null);
  assert.deepEqual(Object.keys(b.clubs).sort(), ["DR", "I7"]);
  assert.equal(b.clubs.I7.shots, 6);
  assert.equal(b.clubs.I7.baseline.carry, 150);
  assert.equal(b.clubs.I7.good, 5);
  assert.equal(b.clubs.DR.good, 5);
  assert.equal(b.settings.minCount, 8);
});

/** n good 7-iron swings with numbers vals[key](i), and `bad` chunks. */
function club(n, vals, { bad = 0, rec = () => ({}) } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const body = {};
    for (const k in vals) body[k] = vals[k](i);
    out.push(swing({ carry: 150, side: 0 }, { ...rec(i), body }));
  }
  for (let i = 0; i < bad; i++) out.push(swing({ carry: 100, side: 0 }, { body: { hipSway: -1 - 0.1 * i } }));
  return out;
}

test("ranges: middle 50% and 80% of the good shots, and how many they're from", () => {
  const b = G.build(club(11, { hipSway: i => i }, { bad: 3 }), null, null);   // 0..10 in
  const r = b.clubs.I7.ranges.hipSway;
  assert.equal(r.n, 11);
  assert.equal(r.enough, true);
  assert.equal(r.q25, 2.5);
  assert.equal(r.q50, 5);
  assert.equal(r.q75, 7.5);
  assert.equal(r.q10, 1);
  assert.equal(r.q90, 9);
  assert.equal(r.reliable, true);
});

test("minimum count: nothing below it (8 by default, or as set)", () => {
  const b7 = G.build(club(7, { hipSway: i => i }), null, null);
  assert.deepEqual(b7.clubs.I7.ranges.hipSway, { n: 7, enough: false, need: 8 });
  const b8 = G.build(club(8, { hipSway: i => i }), null, null);
  assert.equal(b8.clubs.I7.ranges.hipSway.enough, true);
  const set = G.build(club(8, { hipSway: i => i }), { minCount: 10 }, null);
  assert.equal(set.clubs.I7.ranges.hipSway.enough, false);
  assert.equal(set.clubs.I7.ranges.hipSway.need, 10);
});

test("trust gating: numbers with no reading are left out of the range", () => {
  // Three swings where the face-on camera couldn't see all of me: their face-on numbers don't count,
  // their down-the-line ones do.
  const b = G.build(club(10, { hipSway: i => i, earlyExt: () => 1 }, { rec: i => ({ face: i < 3 ? ["out"] : [] }) }), null, null);
  const r = b.clubs.I7.ranges;
  assert.equal(r.hipSway.n, 7);
  assert.equal(r.hipSway.enough, false);
  assert.equal(r.earlyExt.n, 10);
  // A swing without its numbers worked out yet still counts as a good shot, with no numbers.
  const late = G.build([...club(8, { hipSway: i => i }), swing({ carry: 150, side: 0 }, null)], null, null);
  assert.equal(late.clubs.I7.good, 9);
  assert.equal(late.clubs.I7.ranges.hipSway.n, 8);
});

test("trust gating: a range from mostly shaky numbers is 'not reliable', with why", () => {
  // Noisy by definition (trust.js NOISY): hands to plane.
  const b = G.build(club(9, { handsPlaneP6: i => i / 10, hipSway: i => i }), null, null);
  const r = b.clubs.I7.ranges.handsPlaneP6;
  assert.equal(r.enough, true);
  assert.equal(r.reliable, false);
  assert.match(r.why, /^9 of 9 shaky: plane number/);
  assert.equal(b.clubs.I7.ranges.hipSway.reliable, true);
  // The noise floor: shaky in the noise table.
  const table = { keys: { "face.hipSway.p7": { noise: 1, spread: 1, shaky: true } } };
  assert.equal(G.build(club(9, { hipSway: i => i }), null, table).clubs.I7.ranges.hipSway.reliable, false);
  // Estimated P6 on only some swings: reliable while at most half are shaky.
  const some = G.build(club(10, { shaftPlaneP6: i => i }, { rec: i => ({ p6: i < 5 }) }), null, null);
  assert.equal(some.clubs.I7.ranges.shaftPlaneP6.reliable, false);   // shaft plane is noisy by definition anyway
  const est = G.build(club(10, { earlyExt: i => i, hipSway: i => i }, { rec: i => ({ face: i < 6 ? ["noball"] : [] }) }), null, null);
  assert.equal(est.clubs.I7.ranges.hipSway.reliable, false);         // 6 of 10: impact doubtful
  assert.equal(est.clubs.I7.ranges.earlyExt.reliable, true);
});

test("place: in the range, or how far outside it", () => {
  const r = G.rangeOf([10, 12, 14, 16, 18, 20, 22, 24, 26], 0, {}, 8);   // q25 14, q75 22, q10 11.6, q90 24.4
  assert.deepEqual([G.place(14, r, "°").status, G.place(22, r, "°").text], ["in", "in my good-shot range"]);
  assert.equal(G.place(26, r, "°").text, "outside: 4° more than usual");
  assert.equal(G.place(24, r, "°").text, "outside: 2° more than usual (inside the 80% range)");
  assert.equal(G.place(13.5, r, "°").text, "outside: 0.5° less than usual (inside the 80% range)");
  assert.equal(G.place(10, r, "in").status, "below");
  assert.match(G.place(10, r, "in").text, /4.0 in less/);
  assert.equal(G.place(null, r, "°").status, "none");
  assert.equal(G.place(15, G.rangeOf([1, 2], 0, {}, 8), "°").text, "not enough good shots yet (2 of 8)");
  const shaky = G.rangeOf([10, 12, 14, 16, 18, 20, 22, 24, 26], 9, { "P6 estimated": 9 }, 8);
  assert.equal(G.place(15, shaky, "°").text, "in my good-shot range (range not reliable)");
  assert.equal(G.rangeText(-1.25, 2, "in"), "-1.3 to +2.0 in");
  assert.equal(G.rangeText(2.84, 3.2, ":1"), "2.8 to 3.2 : 1");
});

test("separation: effect size with a confidence interval, largest first", () => {
  // Good shots: hip sway ~ +2; the rest ~ 0. Tempo the same on both.
  const swings = [];
  for (let i = 0; i < 12; i++) swings.push(swing({ carry: 150, side: 0 }, { body: { hipSway: 2 + (i % 4) * 0.2, tempo: 3 + (i % 3) * 0.1 } }));
  for (let i = 0; i < 12; i++) swings.push(swing({ carry: 150, side: 30 }, { body: { hipSway: (i % 4) * 0.2, tempo: 3 + (i % 3) * 0.1 } }));
  const b = G.build(swings, null, null);
  assert.equal(b.clubs.I7.good, 12);
  const sep = G.separation(b.clubs.I7, 8);
  assert.equal(sep[0].key, "hipSway");
  assert.equal(sep[0].nGood, 12);
  assert.equal(sep[0].nRest, 12);
  assert.ok(Math.abs(sep[0].diff - 2) < 1e-9);
  assert.ok(sep[0].g > 5 && sep[0].lo > 0 && sep[0].clear);
  const tempo = sep.find(x => x.key === "tempo");
  assert.ok(Math.abs(tempo.g) < 1e-9 && tempo.lo < 0 && tempo.hi > 0 && !tempo.clear);
  // Numbers only one side has, or too few swings: "not enough", at the end.
  // The same on every swing (0.5): no spread, nothing to say.
  const flat = sep.find(x => x.key === "earlyExt");
  assert.equal(flat.nGood, 12);
  assert.equal(flat.enough, false);
  const none = sep.find(x => x.key === "handDepthTop");
  assert.equal(none.enough, false);
  assert.equal(none.nGood, 0);
});

test("separation: Hedges' g matches a hand calculation", () => {
  const h = G.hedges([1, 2, 3, 4, 5], [3, 4, 5, 6, 7]);
  // Pooled sd = sqrt(2.5); d = -2 / 1.5811 = -1.2649; J = 1 - 3 / 31 = 0.90323.
  assert.ok(Math.abs(h.g - (-1.2649111 * 0.9032258)) < 1e-6);
  const se = Math.sqrt(10 / 25 + h.g ** 2 / 20);
  assert.ok(Math.abs(h.lo - (h.g - 1.96 * se)) < 1e-9);
  assert.equal(G.hedges([1, 1, 1], [1, 1, 1]).g, null);
});

test("separation: not enough swings yet", () => {
  const b = G.build([...club(5, { hipSway: i => i }), ...club(0, {}, { bad: 3 })], null, null);
  const sep = G.separation(b.clubs.I7, 8);
  assert.ok(sep.every(x => !x.enough));
  assert.equal(sep.find(x => x.key === "hipSway").nGood, 5);
  assert.equal(G.separation(null).length, S.BODY.length);
});

test("settings: missing parts from the defaults", () => {
  const s = G.withDefaults({ irons: { offlinePct: 4 } });
  assert.equal(s.irons.offlinePct, 4);
  assert.equal(s.irons.carryBelowPct, G.DEFAULTS.irons.carryBelowPct);
  assert.deepEqual(s.woods, G.DEFAULTS.woods);
  assert.equal(G.withDefaults(null).minCount, 8);
});
