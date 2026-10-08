// Did the findings hold up? (static/holdup.js)
// Forward-in-time check of "What helps, what hurts" links.
//
//   cd server && node --test tests/holdup.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const Helps = require("../static/helps.js");
const HoldUp = require("../static/holdup.js");

// Seeded pseudo-random number generator for reproducible tests
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function normal(rand) {
  const u = Math.max(1e-12, rand()), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function makeSessions({
  n = 6,
  per = 20,
  slope = -1.5,
  noise = 1,
  seed = 1,
  dayX = i => i * 0.8,
  dayY = i => i * 3
} = {}) {
  const rand = rng(seed), out = [];
  for (let i = 0; i < n; i++) {
    const rows = [];
    const sl = typeof slope === "function" ? slope(i) : slope;
    const count = typeof per === "function" ? per(i) : per;
    for (let k = 0; k < count; k++) {
      const x = dayX(i) + normal(rand);
      const y = dayY(i) + sl * (x - dayX(i)) + noise * normal(rand);
      rows.push({
        body: { hipSway: x, headSway: normal(rand) },
        shaky: {},
        path: y,
        carry: 150 + 5 * normal(rand),
        offline: normal(rand) * 5
      });
    }
    out.push({ key: `2026-09-${String(20 + i).padStart(2, "0")}`, rows });
  }
  return out;
}

test("a real link planted in every session -> found, then held", () => {
  const sessions = makeSessions({ n: 6, per: 20, slope: -1.5, noise: 0.5, seed: 1 });
  const replayed = HoldUp.replay(sessions, { moves: ["hipSway"], results: ["path"] });
  assert.equal(replayed.length, 1);

  const r0 = replayed[0];
  assert.equal(r0.move, "hipSway");
  assert.equal(r0.result, "path");
  assert.equal(r0.foundAt, "2026-09-22"); // 3rd session (k = 3)
  assert.equal(r0.foundSign, -1);
  assert.equal(r0.verdict, "held");
  assert.equal(r0.later.sessions, 3);
  assert.equal(r0.later.n, 60);
  assert.ok(r0.later.r < -0.7, `expected negative r, got ${r0.later.r}`);
  assert.ok(r0.later.p < 0.05, `expected small p, got ${r0.later.p}`);

  const t = HoldUp.tally(replayed);
  assert.deepEqual(t, { found: 1, held: 1, faded: 0, reversed: 0, early: 0 });

  const s = HoldUp.sentence(r0);
  assert.match(s, /^Found Sep 22; held up in the 3 sessions since \(a (strong|clear|weak) link, 60 swings\)\.$/);
});

test("a link planted only in early sessions -> found, then faded", () => {
  // First 3 sessions have strong link; next 3 sessions have pure noise (slope 0)
  const sessions = makeSessions({
    n: 6,
    per: 20,
    slope: i => (i < 3 ? -1.5 : 0),
    noise: 0.5,
    seed: 1
  });
  const replayed = HoldUp.replay(sessions, { moves: ["hipSway"], results: ["path"] });
  assert.equal(replayed.length, 1);

  const r0 = replayed[0];
  assert.equal(r0.verdict, "faded");
  assert.equal(r0.later.sessions, 3);
  assert.equal(r0.later.n, 60);

  const t = HoldUp.tally(replayed);
  assert.deepEqual(t, { found: 1, held: 0, faded: 1, reversed: 0, early: 0 });

  const s = HoldUp.sentence(r0);
  assert.match(s, /^Found Sep 22; not clear in the 3 sessions since \(\d+ swings\)\.$/);
});

test("a link planted opposite in later sessions -> found, then reversed", () => {
  // First 3 sessions have slope -1.5; next 3 sessions have slope +1.5
  const sessions = makeSessions({
    n: 6,
    per: 20,
    slope: i => (i < 3 ? -1.5 : 1.5),
    noise: 0.5,
    seed: 1
  });
  const replayed = HoldUp.replay(sessions, { moves: ["hipSway"], results: ["path"] });
  assert.equal(replayed.length, 1);

  const r0 = replayed[0];
  assert.equal(r0.foundSign, -1);
  assert.ok(r0.later.r > 0.7, `expected positive r later, got ${r0.later.r}`);
  assert.equal(r0.verdict, "reversed");

  const t = HoldUp.tally(replayed);
  assert.deepEqual(t, { found: 1, held: 0, faded: 0, reversed: 1, early: 0 });

  const s = HoldUp.sentence(r0);
  assert.match(s, /^Found Sep 22; reversed in the 3 sessions since: it now goes the other way \(60 swings\)\.$/);
});

test("found in the last session -> too early", () => {
  // 4 sessions: first 3 have link, but 4th has only 5 swings (< MIN_PAIRS 15)
  const sessions = makeSessions({
    n: 4,
    per: i => (i < 3 ? 20 : 5),
    slope: -1.5,
    noise: 0.5,
    seed: 1
  });
  const replayed = HoldUp.replay(sessions, { moves: ["hipSway"], results: ["path"] });
  assert.equal(replayed.length, 1);

  const r0 = replayed[0];
  assert.equal(r0.verdict, "too early");
  assert.equal(r0.later.sessions, 1);
  assert.equal(r0.later.n, 5);

  const t = HoldUp.tally(replayed);
  assert.deepEqual(t, { found: 1, held: 0, faded: 0, reversed: 0, early: 1 });

  const s = HoldUp.sentence(r0);
  assert.equal(s, "Found Sep 22; too early to tell (1 session since).");
});

test("no links at all -> nothing found (or very few)", () => {
  // 6 sessions with slope 0 across all moves and results
  for (const seed of [10, 20, 30]) {
    const sessions = makeSessions({ n: 6, per: 20, slope: 0, noise: 1, seed });
    const replayed = HoldUp.replay(sessions);
    assert.ok(replayed.length <= 1, `expected at most 1 false discovery, got ${replayed.length}`);
  }
});

test("the later check never uses a session at or before foundAt", () => {
  const sessions = makeSessions({ n: 6, per: 20, slope: -1.5, noise: 0.5, seed: 1 });
  const originalLink = Helps.link;
  const calls = [];
  Helps.link = function (pts) {
    calls.push(pts);
    return originalLink.apply(this, arguments);
  };

  try {
    const replayed = HoldUp.replay(sessions, { moves: ["hipSway"], results: ["path"] });
    assert.equal(replayed.length, 1);
    assert.equal(calls.length, 1);

    // Later sessions were sessions 3, 4, 5 (3 sessions)
    const pts = calls[0];
    assert.equal(pts.length, 3);

    // Verify point counts match later sessions (each had 20 swings)
    assert.equal(pts[0].length, 20);
    assert.equal(pts[1].length, 20);
    assert.equal(pts[2].length, 20);

    // Verify the points match sessions[3..5], not sessions[0..2]
    // Day offset was i * 0.8, so session 0 mx ~ 0, session 3 mx ~ 2.4
    const s0Mean = sessions[0].rows.reduce((s, r) => s + r.body.hipSway, 0) / 20;
    const s3Mean = sessions[3].rows.reduce((s, r) => s + r.body.hipSway, 0) / 20;
    const pts0Mean = pts[0].reduce((s, p) => s + p.x, 0) / pts[0].length;

    assert.ok(Math.abs(pts0Mean - s3Mean) < 1e-6, "first session passed to link must be session 3");
    assert.ok(Math.abs(pts0Mean - s0Mean) > 1.0, "session 0 must not be in later check");
  } finally {
    Helps.link = originalLink;
  }
});

test("formatDate: converts ISO dates and leaves plain strings intact", () => {
  assert.equal(HoldUp.formatDate("2026-09-28"), "Sep 28");
  assert.equal(HoldUp.formatDate("2026-10-03"), "Oct 3");
  assert.equal(HoldUp.formatDate("s0"), "s0");
  assert.equal(HoldUp.formatDate(""), "");
});

test("the date comes from the session's start when its key is a clip name", () => {
  const x = { foundAt: "swing_face_1920x1080_240fps_1790278981_2308ms.mp4", foundStart: new Date(2026, 8, 25, 14).getTime(),
              verdict: "too early", later: { sessions: 1, n: 3 } };
  assert.equal(HoldUp.sentence(x), "Found Sep 25; too early to tell (1 session since).");
});
