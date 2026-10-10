// Goal test suite (static/goal.js): the focus's target (your own, your usual before, the first session
// since), swings in the target, the progress score per session and so far, and the practice range.
//
// Run with: node --test tests/goal.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const Goal = require("../static/goal.js");

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);
const day = (m, d) => new Date(2026, m, d, 10).getTime();
const sess = (key, start, vals) => ({ key, start, rows: vals.map(v => ({ handsPlaneP6: v })) });
const focus = (extra = {}) => ({ move: "handsPlaneP6", aim: "less", since: "2026-10-01", ...extra });

const SESSIONS = [
  sess("a", day(8, 20), [5, 6, 4, 5, null, 7]),          // before: 5 readings
  sess("b", day(8, 25), [3, 5, 6]),                      // before: with a, the usual is the middle of 8 readings = 5
  sess("c", day(9, 2), [4, 4.5, 6, 5, 3, 7]),            // since: 4 of 6 at or under 5
  sess("d", day(9, 5), [2, 3, 4, 6, 4.9, 5.1, 3, 2]),    // since: 6 of 8
  sess("e", day(9, 6), [1, 9]),                          // since: too few for "best"
];

test("target: your usual before you started, on the side you aim for", () => {
  const t = Goal.target(SESSIONS, focus());
  assert.equal(t.from, "before");
  assert.equal(t.side, "below");
  near(t.bound, 5);
  assert.equal(t.n, 8);
  assert.equal(Goal.target(SESSIONS, focus({ aim: "more" })).side, "above");
});

test("target: your own bound wins; with nothing before, the first session since stands in", () => {
  const own = Goal.target(SESSIONS, focus({ target: 3.5 }));
  assert.deepEqual([own.bound, own.from, own.side], [3.5, "own", "below"]);
  const first = Goal.target(SESSIONS.slice(2), focus());
  assert.equal(first.from, "first");
  near(first.bound, 4.75);
  // Under 5 readings anywhere: no target yet.
  assert.equal(Goal.target([sess("x", day(9, 2), [1, 2, 3])], focus()), null);
  assert.equal(Goal.target([], focus()), null);
});

test("inTarget: the bound itself counts, each way", () => {
  const below = { bound: 5, side: "below" }, above = { bound: 5, side: "above" };
  assert.ok(Goal.inTarget(5, below) && Goal.inTarget(4, below) && !Goal.inTarget(5.1, below));
  assert.ok(Goal.inTarget(5, above) && Goal.inTarget(6, above) && !Goal.inTarget(4.9, above));
  assert.ok(!Goal.inTarget(null, below) && !Goal.inTarget(4, null));
});

test("progress: each session's score, before and since, the latest and the best", () => {
  const p = Goal.progress(SESSIONS, focus(), day(9, 9));
  assert.deepEqual(p.sessions.map(s => [s.key, s.since, s.n, s.k]),
    [["a", false, 5, 3], ["b", false, 3, 2], ["c", true, 6, 4], ["d", true, 8, 6], ["e", true, 2, 1]]);
  near(p.before.rate, 5 / 8);
  assert.deepEqual([p.after.n, p.after.k, p.after.sessions], [16, 11, 3]);
  assert.equal(p.after.days, 8);
  assert.equal(p.latest.key, "e");
  near(p.latest.rate, 0.5);
  assert.equal(p.best.key, "d");            // e has too few swings to be a best
  near(p.best.rate, 0.75);
  assert.equal(Goal.progress([], focus()), null);
});

test("progress: nothing since yet", () => {
  const p = Goal.progress(SESSIONS.slice(0, 2), focus(), day(9, 1));
  assert.equal(p.latest, null);
  assert.equal(p.best, null);
  assert.equal(p.after.n, 0);
  assert.equal(p.after.rate, null);
});

test("progress: only the sessions that set the usual count as before", () => {
  const many = [...Array.from({ length: 8 }, (_, i) => sess("old" + i, day(8, 1 + i), [5, 5, 5])), sess("new", day(9, 2), [4, 6, 4, 4, 4])];
  const p = Goal.progress(many, focus(), day(9, 3));
  assert.equal(p.sessions.filter(s => !s.since).length, Goal.BEFORE_SESSIONS);
  near(p.latest.rate, 0.8);
});

test("practiceRange: in range means in the target", () => {
  const recent = [2, 3, 4, 5, 6, 7];
  const less = Goal.practiceRange({ bound: 5, side: "below" }, recent);
  assert.equal(less.max, 5);
  assert.ok(less.min < 2);
  const more = Goal.practiceRange({ bound: 5, side: "above" }, recent);
  assert.equal(more.min, 5);
  assert.ok(more.max > 7);
  assert.equal(Goal.practiceRange({ bound: 5, side: "below" }, [1, 2]), null);
  assert.equal(Goal.practiceRange(null, recent), null);
});
