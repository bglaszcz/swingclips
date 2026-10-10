// graduate.test.js: has a focus held? (static/graduate.js)
const test = require("node:test");
const assert = require("node:assert");
const G = require("../static/graduate.js");

const DAY = 24 * 3600 * 1000, T0 = new Date("2026-10-01T17:00:00").getTime();
/** A session since the focus began: on day `d` (hours `h` into it), k of n swings in the target. */
const s = (d, k, n = 10, extra = {}) => ({ key: `s${d}-${extra.h || 0}`, start: T0 + d * DAY + (extra.h || 0) * 3600 * 1000, since: true, n, k, rate: k / n, ...extra });
const check = (sessions, opts) => G.check({ sessions }, opts);

test("no scored session yet: new", () => {
  for (const sessions of [[], [s(0, 4, 4)], [{ ...s(0, 9), since: false }]]) {
    const r = check(sessions);
    assert.deepStrictEqual([r.state, r.run, r.need, r.sessions.length], ["new", 0, 3, 0]);
  }
  assert.strictEqual(check(undefined).state, "new");
  assert.strictEqual(G.words(check([])), "No session with 5 swings since you started yet. Three sessions in a row at 70% is the mark.");
});

test("three sessions in a row at the rate, on two days: held (exactly 70% counts)", () => {
  const r = check([s(0, 4), s(1, 7), s(2, 8), s(3, 7)]);
  assert.deepStrictEqual([r.state, r.run, r.need, r.oneDay], ["held", 3, 0, false]);
  assert.deepStrictEqual(r.sessions.map(x => x.rate), [0.7, 0.8, 0.7]);
  assert.strictEqual(G.words(r), "Held for three sessions in a row (70%, 80% and 70% of swings in your target). This one looks learned.");
  // Just under on one of them: not held, and the run starts after it.
  const under = check([s(1, 7), { ...s(2, 69, 100) }, s(3, 7)]);
  assert.deepStrictEqual([under.state, under.run, under.need], ["building", 1, 2]);
});

test("a longer run says how long, and shows the last three", () => {
  const r = check([s(0, 7), s(1, 8), s(2, 9), s(3, 8), s(4, 7)]);
  assert.deepStrictEqual([r.state, r.run, r.sessions.length], ["held", 5, 5]);
  assert.strictEqual(G.words(r), "Held for five sessions in a row (the last three: 90%, 80% and 70% of swings in your target). This one looks learned.");
});

test("three in a row on one day is one good day: close, one more on another day", () => {
  const r = check([s(2, 8), s(2, 8, 10, { h: 1 }), s(2, 9, 10, { h: 2 })]);
  assert.deepStrictEqual([r.state, r.run, r.need, r.oneDay], ["close", 3, 1, true]);
  assert.strictEqual(G.words(r), "Three sessions in a row over 70% of swings in your target, all on one day. One more on another day and it has held.");
  assert.strictEqual(check([s(2, 8), s(2, 8, 10, { h: 1 }), s(3, 9)]).state, "held");
});

test("two in a row: close, one more", () => {
  const r = check([s(0, 3), s(1, 8), s(2, 7)]);
  assert.deepStrictEqual([r.state, r.run, r.need], ["close", 2, 1]);
  assert.deepStrictEqual(r.sessions.map(x => x.rate), [0.8, 0.7]);
  assert.strictEqual(G.words(r), "Two sessions in a row over 70% of swings in your target. One more and it has held.");
});

test("a session with too few swings neither breaks nor extends a run", () => {
  assert.strictEqual(check([s(0, 8), s(1, 8), s(2, 0, 4), s(3, 8)]).state, "held");       // the thin one is skipped
  const r = check([s(0, 8), s(1, 4, 4), s(2, 8)]);                                       // 4 of 4 is not a third
  assert.deepStrictEqual([r.state, r.run], ["close", 2]);
});

test("building: sessions since, the latest under the rate", () => {
  const r = check([s(0, 8), s(1, 8), s(2, 5)]);
  assert.deepStrictEqual([r.state, r.run, r.need], ["building", 0, 3]);
  assert.strictEqual(r.sessions.length, 3);
  assert.strictEqual(G.words(r), "Latest session: 50% of swings in your target. Three sessions in a row at 70% is the mark.");
  // One good session after a poor one is a start, not close.
  assert.deepStrictEqual([check([s(0, 3), s(1, 8)]).state, check([s(0, 3), s(1, 8)]).run], ["building", 1]);
});

test("slipped needs an earlier hold and a latest session under half", () => {
  const heldThen = [s(0, 8), s(1, 8), s(2, 8)];
  const r = check([...heldThen, s(3, 4)]);
  assert.deepStrictEqual([r.state, r.run, r.need], ["slipped", 0, 3]);
  assert.strictEqual(G.words(r), "It held earlier, but the latest session was 40% in your target.");
  assert.strictEqual(check([...heldThen, s(3, 5)]).state, "building");          // 50% is not under half
  assert.strictEqual(check([s(0, 8), s(1, 8), s(2, 4)]).state, "building");     // it never held
  assert.strictEqual(check([...heldThen, s(3, 4), s(4, 8), s(5, 8)]).state, "close");   // and it comes back
});

test("a camera moved inside the run is said; before its first session is not", () => {
  const moved = check([s(0, 8), s(1, 8, 10, { moved: true }), s(2, 8)]);
  assert.strictEqual(moved.cameraInRun, true);
  assert.match(G.words(moved), /This one looks learned\. A camera moved during these sessions: scores either side may not compare\.$/);
  assert.strictEqual(check([s(0, 8, 10, { moved: true }), s(1, 8), s(2, 8)]).cameraInRun, false);
  assert.strictEqual(check([s(0, 3, 10, { moved: true }), s(1, 8), s(2, 8), s(3, 8)]).cameraInRun, false);
});

test("the mark can be set", () => {
  const sessions = [s(0, 6), s(1, 6)];
  assert.strictEqual(check(sessions).state, "building");
  const r = check(sessions, { rate: 0.6, sessions: 2 });
  assert.deepStrictEqual([r.state, r.rate, r.of], ["held", 0.6, 2]);
  assert.strictEqual(check([s(0, 9, 9)], { minSwings: 10 }).state, "new");
  assert.strictEqual(G.words(check([s(0, 3)], { rate: 0.6, sessions: 2 })), "Latest session: 30% of swings in your target. Two sessions in a row at 60% is the mark.");
  assert.match(G.HOW, /app's own mark/);
});
