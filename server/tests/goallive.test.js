// Practice mode swing by swing (static/goal-live.js fromLog): the latest session from the practice log, in the
// order hit, one entry per swing, coloured as the phone's tone was.
//
// Run with: node --test tests/goallive.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../static/goal-live.js");

const GAP = 45 * 60 * 1000;
const cfg = { metric: "tempo", min: 2.8, max: 3.2 };
const e = (t, value, extra = {}) => ({ clip: `c${t}`, t, made: t + 30, metric: "tempo", min: 2.8, max: 3.2, value,
  status: value == null ? "none" : value < 2.8 ? "low" : value > 3.2 ? "high" : "in", ...extra });

test("the latest session only, in the order hit, with the zones the phone played", () => {
  const log = [e(1000, 3.0), e(1060, 3.5),                              // an earlier session
               e(9000, 3.0, { tone: "in" }), e(9060, 3.25, { tone: "near" }), e(9120, 3.9, { tone: "out" }),
               e(9030, 2.9, { made: 9500 })];                           // spoken late, hit second
  const m = G.fromLog(log, cfg, GAP);
  assert.deepEqual(m.points.map(p => p.v), [3.0, 2.9, 3.25, 3.9]);
  assert.deepEqual(m.points.map(p => p.zone), ["in", "in", "near", "out"]);
  assert.equal(m.n, 4);
  assert.equal(m.k, 2);
  assert.equal(m.last.v, 3.9);
  assert.equal(m.minutes, 2);
  assert.equal(m.current, true);
  assert.deepEqual([m.target.lo, m.target.hi], [2.8, 3.2]);
});

test("older entries without a tone get the server's rule: near within a quarter of the range's width", () => {
  const m = G.fromLog([e(100, 3.29), e(110, 3.31), e(120, 2.7)], cfg, GAP);
  assert.deepEqual(m.points.map(p => p.zone), ["near", "out", "near"]);
});

test("swings with no reading are counted apart; a repeated clip counts once", () => {
  const m = G.fromLog([e(100, 3.0), e(110, null, { why: "no shot" }), e(120, 3.1), { ...e(120, 3.1), made: 999 }], cfg, GAP);
  assert.equal(m.n, 2);
  assert.equal(m.skipped, 1);
});

test("switched to another number since: the one practised last in the session, not marked current", () => {
  const hp = (t, v) => ({ ...e(t, v), metric: "handsPlaneP6", min: 1.4, max: 4.5, status: "in" });
  const log = [hp(100, 3.0), { ...hp(160, 3.2), min: 1.0 }];   // the range changed mid-session: the last one used
  const m = G.fromLog(log, cfg, GAP);
  assert.equal(m.metric, "handsPlaneP6");
  assert.equal(m.min, 1.0);
  assert.equal(m.current, false);
  assert.equal(m.n, 1);
  assert.equal(G.fromLog([], cfg, GAP), null);
});
