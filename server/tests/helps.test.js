// What helps, what hurts (static/helps.js): the statistics, the within-session pooling, the false
// discovery correction and the labels. Synthetic sessions.
//
//   cd server && node --test tests/helps.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const H = require("../static/helps.js");

// A small seeded random source, so the tests are the same every run.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
function normal(rand) {
  const u = Math.max(1e-12, rand()), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Sessions of swings where hip sway moves path by `slope` degrees an inch within each session; each
 * session has its own offsets (sway `dayX`, path `dayY`), which the within-session view must cancel.
 */
function sessions({ n = 5, per = 20, slope = -1.5, noise = 1, seed = 1, dayX = i => i * 0.8, dayY = i => i * 3 } = {}) {
  const rand = rng(seed), out = [];
  for (let i = 0; i < n; i++) {
    const rows = [];
    for (let k = 0; k < per; k++) {
      const x = dayX(i) + normal(rand);
      const y = dayY(i) + slope * (x - dayX(i)) + noise * normal(rand);
      rows.push({ body: { hipSway: x, headSway: normal(rand) }, shaky: {}, path: y, carry: 150 + 5 * normal(rand), offline: normal(rand) * 5 });
    }
    out.push({ key: `s${i}`, rows });
  }
  return out;
}

test("t test: known two-sided p values", () => {
  assert.ok(Math.abs(H.tTwoSided(2.228, 10) - 0.05) < 1e-3);
  assert.ok(Math.abs(H.tTwoSided(1.96, 1e6) - 0.05) < 1e-3);
  assert.ok(Math.abs(H.tTwoSided(0, 5) - 1) < 1e-9);
  assert.ok(Math.abs(H.tTwoSided(-2.228, 10) - 0.05) < 1e-3);
  assert.equal(H.tTwoSided(1, 0), null);
});

test("Benjamini-Hochberg: q values, in order, monotone, nulls kept", () => {
  const q = H.bh([0.01, 0.04, null, 0.03, 0.2]);
  assert.equal(q[2], null);
  // Sorted p: 0.01, 0.03, 0.04, 0.2 (m = 4): 0.04, 0.0533, 0.0533, 0.2.
  assert.ok(Math.abs(q[0] - 0.04) < 1e-12);
  assert.ok(Math.abs(q[3] - 0.04 * 4 / 3) < 1e-12);
  assert.ok(Math.abs(q[1] - 0.04 * 4 / 3) < 1e-12);
  assert.ok(Math.abs(q[4] - 0.2) < 1e-12);
});

test("round steps: 1, 2 or 5 times a power of ten", () => {
  assert.equal(H.niceStep(0.8), 1);
  assert.equal(H.niceStep(0.3), 0.2);
  assert.equal(H.niceStep(4), 5);
  assert.ok(Math.abs(H.niceStep(0.06) - 0.05) < 1e-12);
  assert.equal(H.niceStep(0), 1);
});

test("within sessions: the link is found even when the day-to-day offsets point the other way", () => {
  // Across sessions, more sway goes with more path (+3.75 per inch); within each, -1.5.
  const a = H.analyze(sessions(), { moves: ["hipSway"], results: ["path"] });
  const l = a.links[0];
  assert.equal(a.tested, 1);
  assert.ok(l.slope < -1.3 && l.slope > -1.7, `slope ${l.slope}`);
  assert.equal(l.label, "confirmed");
  assert.equal(l.agree, 5);
  assert.equal(l.counted, 5);
  assert.equal(l.n, 100);
  // Between sessions: the other way, and shown as such.
  assert.ok(l.between && l.between.r > 0.9);
  assert.match(H.sentence(l), /^Each 1 in more hip sway at impact than your usual that day: club path 1\.\d° more out-to-in$/);
  assert.equal(H.support(l), "same way in 5 of 5 sessions");
});

test("noise alone: nothing confirmed over many pairs", () => {
  for (const seed of [2, 3, 4]) {
    const a = H.analyze(sessions({ slope: 0, seed }));
    assert.equal(a.tested, 8);   // 2 moves x carry, offline, distance offline, path
    assert.equal(a.links.filter(l => l.label === "confirmed").length, 0, `seed ${seed}`);
  }
});

test("a strong link in too few sessions is emerging, not confirmed", () => {
  const a = H.analyze(sessions({ n: 2, per: 25 }), { moves: ["hipSway"], results: ["path"] });
  assert.equal(a.links[0].label, "emerging");
  assert.equal(H.support(a.links[0]), "same way in 2 of 2 sessions");
});

test("sessions disagreeing: not confirmed", () => {
  // Two sessions one way, two the other: the pooled slope is small, and direction split.
  const s = [...sessions({ n: 2, slope: -2, seed: 5 }), ...sessions({ n: 2, slope: 1.5, seed: 6 })];
  const l = H.analyze(s, { moves: ["hipSway"], results: ["path"] }).links[0];
  assert.notEqual(l.label, "confirmed");
});

test("helps and hurts: only where the result has a better way", () => {
  const s = sessions({ slope: 0 }), rand = rng(7);
  // Carry falls with sway within each session: hurts.
  for (const ses of s) for (const r of ses.rows) r.carry = 150 - 4 * r.body.hipSway + (rand() - 0.5);
  const a = H.analyze(s, { moves: ["hipSway"], results: ["carry", "path"] });
  const carry = a.links.find(l => l.result === "carry"), path = a.links.find(l => l.result === "path");
  assert.equal(carry.helps, false);
  assert.match(H.sentence(carry), /carry 4(\.\d)? yd shorter$/);
  assert.equal(path.helps, null);
});

test("worked-out results: distance offline either way", () => {
  assert.deepEqual(
    [H.resultNumbers({ offline: -7 }).absOffline, H.resultNumbers({ offline: null }).absOffline, H.resultNumbers({ faceToPath: -2 }).absFaceToPath],
    [7, null, 2]);
});

test("too few swings: nothing tested; small sessions left out", () => {
  const a = H.analyze(sessions({ n: 3, per: 4 }), { moves: ["hipSway"], results: ["path"] });
  assert.equal(a.tested, 0);
  // Two swings a session: their means would be the swings themselves.
  const b = H.analyze(sessions({ n: 10, per: 2 }), { moves: ["hipSway"], results: ["path"] });
  assert.equal(b.tested, 0);
  assert.equal(b.sessions, 0);
});

test("swings without body numbers, or a missing number, are skipped", () => {
  const s = sessions({ n: 3 });
  s[0].rows[0].body = null;
  s[1].rows[0].body.hipSway = null;
  s[2].rows[0].path = null;
  const l = H.analyze(s, { moves: ["hipSway"], results: ["path"] }).links[0];
  assert.equal(l.n, 57);
});

test("shaky: marked when most of the move's numbers are", () => {
  const s = sessions({ n: 3 });
  for (const ses of s) ses.rows.forEach((r, i) => { r.shaky = { hipSway: i % 3 !== 0 }; });
  assert.equal(H.analyze(s, { moves: ["hipSway"], results: ["path"] }).links[0].shaky, true);
});
