// My focus (static/focus.js): the move and its results since the focus started, against the sessions
// before, measured against the session-to-session wobble. Synthetic sessions.
//
//   cd server && node --test tests/focus.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../static/focus.js");

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** Sessions a day apart from Sep 1; `shift(i)` moves hands at P6 (and path the other way) from session i on. */
function sessions({ n = 8, per = 20, shift = () => 0, seed = 1, moved = {} } = {}) {
  const rand = rng(seed), out = [];
  for (let i = 0; i < n; i++) {
    const rows = [];
    for (let k = 0; k < per; k++) {
      const hands = 2 + shift(i) + (rand() - 0.5) * 2;
      rows.push({ handsPlaneP6: hands, path: -3 - 0.8 * (hands - 2) + (rand() - 0.5) * 2, carry: 150 + (rand() - 0.5) * 10 });
    }
    out.push({ key: `s${i}`, start: new Date(2026, 8, 1 + i, 18).getTime(), rows, moved: moved[i] || {} });
  }
  return out;
}
const focus = { move: "handsPlaneP6", aim: "less", club: "I7", results: ["path", "carry"], since: "2026-09-06" };

test("the move changed the right way, clearly; path followed toward neutral", () => {
  const c = F.compare(sessions({ shift: i => (i >= 5 ? -2 : 0) }), focus);
  assert.equal(c.before, 5);
  assert.equal(c.after, 3);
  assert.equal(c.move.level, "clear");
  assert.equal(c.move.good, true);
  assert.ok(Math.abs(c.move.change + 2) < 0.4, c.move.change);
  const path = c.results.find(r => r.key === "path");
  assert.equal(path.good, true);            // -3 -> about -1.4: toward 0
  assert.equal(F.verdict(c.move), "clearly the right way");
  assert.equal(c.cameraMoved, false);
});

test("the wrong way is said so", () => {
  const c = F.compare(sessions({ shift: i => (i >= 5 ? 2 : 0) }), focus);
  assert.equal(c.move.good, false);
  assert.match(F.verdict(c.move), /wrong way/);
});

test("no real change: within the wobble", () => {
  const c = F.compare(sessions(), focus);
  assert.equal(c.move.level, "none");
  assert.equal(F.verdict(c.move), "no change yet (within the usual wobble)");
  // Carry has no change built in either.
  assert.notEqual(c.results.find(r => r.key === "carry").level, "clear");
});

test("no sessions since yet, and a camera that moved", () => {
  const none = F.compare(sessions({ n: 4 }), focus);
  assert.equal(none.after, 0);
  assert.equal(none.move.level, "few");
  assert.equal(F.verdict(none.move), "not enough swings yet");
  const moved = F.compare(sessions({ moved: { 6: { dtl: true } } }), focus);
  assert.equal(moved.cameraMoved, true);
  // A face-on camera moving doesn't matter to a down-the-line move.
  assert.equal(F.compare(sessions({ moved: { 6: { face: true } } }), focus).cameraMoved, false);
});

test("only the latest sessions before count", () => {
  const c = F.compare(sessions({ n: 14 }), { ...focus, since: "2026-09-12" });
  assert.equal(c.before, F.BEFORE_SESSIONS);
});
