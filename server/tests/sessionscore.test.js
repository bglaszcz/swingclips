// Progress over all clubs (static/sessionscore.js): session scores, last time against now, what to work on.
//
//   cd server && node --test tests/sessionscore.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const Coach = require("../static/coach.js");
const Score = require("../static/sessionscore.js");

const clubs = {
  I7: { baseline: { carry: 150, smash: 1.33 }, verdicts: {} },
  PW: { baseline: { carry: 110, smash: 1.2 }, verdicts: {} },
};
let id = 0;
// A shot: good (on line, usual carry, usual smash) or a miss (off line, short, thin).
function shot(club, good) {
  const b = clubs[club].baseline, name = `s${id++}`;
  clubs[club].verdicts[name] = { good, fails: good ? [] : ["offline"] };
  return good ? { name, club, carry: b.carry, offline: 1, smash: b.smash + 0.01 }
    : { name, club, carry: b.carry * 0.8, offline: 0.2 * b.carry, smash: b.smash - 0.1 };
}
const session = (start, nGood, nBad, club2) => ({ start, rows: [
  ...Array.from({ length: nGood }, (_, i) => shot(i % 2 && club2 ? club2 : "I7", true)),
  ...Array.from({ length: nBad }, (_, i) => shot(i % 2 && club2 ? club2 : "I7", false)),
] });
const ctx = { clubs, name: r => r.name };

test("a session's score pools clubs, each against its own usual", () => {
  const s = Score.score(session(0, 6, 4, "PW").rows, ctx);
  assert.equal(s.judged, 10);
  assert.equal(s.good, 6);
  assert.equal(s.onLine, 6);
  assert.equal(s.solid, 6);
  assert.deepEqual(Object.keys(s.clubs).sort(), ["I7", "PW"]);
  // Good shots at 100% of usual, misses at 80%: the median of 10 is 100.
  assert.equal(s.distance, 100);
});

test("clearly better than last time; a short warm-up doesn't count as last time", () => {
  const c = Score.compare([session(1, 4, 26), session(2, 1, 8), session(3, 18, 12, "PW")], ctx);
  assert.equal(c.last.start, 1);
  assert.equal(c.verdict, "better");
  assert.ok(c.items[0].clear);
  assert.match(c.headline, /^Better than last time: 60% good shots, against 13% last time\.$/);
});

test("a small gap is 'a little better', not a clear change; a tiny one 'about the same'", () => {
  const little = Score.compare([session(1, 6, 14), session(2, 8, 12)], ctx);
  assert.equal(little.verdict, "better");
  assert.ok(!little.items[0].clear);
  assert.match(little.headline, /^A little better than last time: .*not a clear change yet/);
  const same = Score.compare([session(1, 6, 14), session(2, 6, 15)], ctx);
  assert.equal(same.verdict, "same");
});

test("first session, and too few shots", () => {
  assert.equal(Score.compare([session(1, 10, 10)], ctx).verdict, "first");
  assert.equal(Score.compare([session(1, 10, 10), session(2, 3, 3)], ctx).verdict, "few");
  assert.equal(Score.compare([], ctx), null);
});

test("what to work on: weighted by what matters, never toward a fault, at most two", () => {
  // handsPlaneP6 against path: yours runs out-to-in (median -4), more hands-over-plane goes with more out-to-in,
  // so the aim is less (hands under the plane): not a fault.
  const L = (move, result, r, label = "confirmed", effect = r, median = -4) => ({ move, result, r, label, effect, median });
  const p = Score.priorities([
    L("handsPlaneP6", "path", -0.5),
    L("handsPlaneP6", "faceToPath", 0.37, "confirmed", 0.37, 3),
    L("spineTiltImpact", "attack", 0.54),         // attack: left out
    L("headRise", "absOffline", 0.1, "emerging", 0.1, 8),
  ]);
  assert.equal(p[0].move, "handsPlaneP6");
  assert.equal(p[0].aim, "less");
  assert.equal(p[0].fix.thought, Coach.MOVES.handsPlaneP6.less.thought);
  assert.equal(p.length, 1, "the second is much smaller: only one");
  assert.ok(!p.some(m => m.move === "spineTiltImpact"));
  // A link whose way back is a fault (hands over the plane, for an in-to-out path) gives nothing.
  assert.equal(Score.priorities([L("handsPlaneP6", "path", -0.5, "confirmed", -0.5, 4)]).length, 0);
  // Chance links are ignored.
  assert.equal(Score.priorities([L("earlyExt", "absOffline", 0.4, "chance")]).length, 0);
});

test("two near-equal priorities both show", () => {
  const L = (move, result, r, median) => ({ move, result, r, label: "confirmed", effect: r, median, helps: null });
  const p = Score.priorities([
    { move: "earlyExt", result: "smash", r: -0.4, effect: -0.4, label: "confirmed", helps: false },
    { move: "bendLoss", result: "smash", r: 0.38, effect: 0.38, label: "confirmed", helps: true },
    L("handsPlaneP6", "path", -0.05, -4),
  ]);
  assert.equal(p.length, 2);
});
