// The compare view's time mapping (static/compare.js): which moments line up, and B's time for A's.
//
//   cd server && node --test tests/compare.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../static/compare.js");

const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg}: ${actual} != ${expected}`);

// Swing A: backswing 0.75 s, downswing 0.25 s. Swing B: slower back (1.0 s), same down, later in its clip.
const A = { p1: 1.0, p2: 1.2, p3: 1.4, p4: 1.75, p5: 1.85, p6: 1.95, p7: 2.0, p8: 2.07 };
const B = { p1: 1.5, p2: 1.8, p3: 2.1, p4: 2.5, p5: 2.6, p6: 2.7, p7: 2.75, p8: 2.85 };

test("key positions land on each other", () => {
  const anch = C.anchors(A, B, "keys");
  assert.equal(anch.length, 8);
  for (const k of C.KEYS) near(C.warp(anch, A[k]), B[k], k);
});

test("in between, time is stretched in a straight line", () => {
  const anch = C.anchors(A, B, "keys");
  // Halfway from P3 to P4 in A is halfway from P3 to P4 in B.
  near(C.warp(anch, (A.p3 + A.p4) / 2), (B.p3 + B.p4) / 2, "P3-P4 midpoint");
  // A quarter of the way from P1 to P2.
  near(C.warp(anch, A.p1 + 0.25 * (A.p2 - A.p1)), B.p1 + 0.25 * (B.p2 - B.p1), "P1-P2 quarter");
  // The rate is B's segment over A's.
  near(C.rate(anch, 1.1), (B.p2 - B.p1) / (A.p2 - A.p1), "rate P1-P2");
  near(C.rate(anch, 1.97), (B.p7 - B.p6) / (A.p7 - A.p6), "rate P6-P7");
});

test("before P1 and after P8 both run at real speed", () => {
  const anch = C.anchors(A, B, "keys");
  near(C.warp(anch, 0.4), B.p1 - 0.6, "before");
  near(C.warp(anch, 3.0), B.p8 + (3.0 - A.p8), "after");
  near(C.rate(anch, 0.4), 1, "rate before");
  near(C.rate(anch, 3.0), 1, "rate after");
});

test("the mapping only moves forward and unwarp undoes it", () => {
  const anch = C.anchors(A, B, "keys");
  let last = -Infinity;
  for (let t = 0; t <= 4; t += 0.001) {
    const u = C.warp(anch, t);
    assert.ok(u > last, `not increasing at ${t}`);
    last = u;
    near(C.unwarp(anch, u), t, `unwarp at ${t}`);
  }
});

test("real time lines up impact only", () => {
  const anch = C.anchors(A, B, "impact");
  assert.deepEqual(anch, [[A.p7, B.p7]]);
  near(C.warp(anch, A.p4), A.p4 + (B.p7 - A.p7), "top");
  near(C.rate(anch, A.p4), 1, "rate");
  // Both are the same time before impact: B's own top (0.25 s before its impact) is further back.
  near(B.p7 - C.warp(anch, A.p4), A.p7 - A.p4, "same time to impact");
});

test("missing positions are skipped; too few falls back to impact, then to the offset", () => {
  const partA = { ...A, p2: undefined, p6: null };
  const anch = C.anchors(partA, B, "keys");
  assert.deepEqual(anch.map(a => a[0]), [A.p1, A.p3, A.p4, A.p5, A.p7, A.p8]);
  // Only impact in common: lined up there.
  assert.deepEqual(C.anchors({ p7: 2 }, { p1: 1, p7: 2.3 }, "keys"), [[2, 2.3]]);
  // Nothing found: the offset between the clips (by the ball or the strike).
  const none = C.anchors({}, {}, "keys", 0.12);
  assert.deepEqual(none, [[0, 0.12]]);
  near(C.warp(none, 1.5), 1.62, "offset");
  assert.deepEqual(C.anchors(null, B, "impact", -0.5), [[0, -0.5]]);
});

test("a key position out of order in either swing is left out", () => {
  // B's P3 comes before its P2 (a bad detection): P3 is dropped rather than running time backwards.
  const bad = { ...B, p3: 1.7 };
  const anch = C.anchors(A, bad, "keys");
  assert.ok(!anch.some(([a]) => a === A.p3));
  for (let i = 1; i < anch.length; i++) assert.ok(anch[i][0] > anch[i - 1][0] && anch[i][1] > anch[i - 1][1]);
});

test("links", () => {
  const a = "swing_face_1920x1080_240fps_1789123456_2000ms.mp4", b = "cam0 1920x1080_240fps_hs_1789.mp4";
  const h = C.hashFor(a, b);
  assert.equal(h, "#compare=swing_face_1920x1080_240fps_1789123456_2000ms.mp4,cam0%201920x1080_240fps_hs_1789.mp4");
  assert.deepEqual(C.parseHash(h), [a, b]);
  assert.deepEqual(C.parseHash("compare=x"), ["x", null]);
  assert.equal(C.parseHash("#" + a), null);
  assert.equal(C.parseHash(""), null);
});

test("key position cards line up by position, in P1-P8 order", () => {
  const A = [{ key: "p4", color: "green" }, { key: "p1", color: "grey" }, { key: "p7", color: "red" }];
  const B = [{ key: "p1", color: "green" }, { key: "p7", color: "amber" }, { key: "p8", color: "grey" }];
  const cols = C.lineUp(A, B);
  assert.deepEqual(cols.map(c => c.key), ["p1", "p4", "p7", "p8"]);
  assert.equal(cols[1].b, null, "the reference has no top");
  assert.equal(cols[3].a, null, "this swing has no finish");
  assert.equal(cols[2].a.color, "red");
  assert.equal(cols[2].b.color, "amber");
  assert.deepEqual(C.lineUp(null, B).map(c => c.key), ["p1", "p7", "p8"], "one swing not analyzed");
  assert.deepEqual(C.lineUp(null, null), []);
});

test("the picker's periods", () => {
  const now = new Date("2026-09-29T12:00:00").getTime();
  assert.deepEqual(C.periodRange("0", null, now), [0, Infinity]);
  assert.deepEqual(C.periodRange("30", null, now), [now - 30 * 86400000, Infinity]);
  // Before my focus: everything up to the start of the local day it began.
  const [from, to] = C.periodRange("focus", { since: "2026-09-10" }, now);
  assert.equal(from, 0);
  assert.equal(to, new Date("2026-09-10T00:00:00").getTime());
  assert.ok(new Date("2026-09-09T23:59:00").getTime() < to && new Date("2026-09-10T07:00:00").getTime() >= to);
  // No focus: nothing is cut off.
  assert.deepEqual(C.periodRange("focus", null, now), [0, Infinity]);
});

test("POSITION_TAGS uses plain names without P[1-8] jargon", () => {
  assert.ok(C.POSITION_TAGS, "POSITION_TAGS should be exported");
  const expected = {
    p1: "Setup",
    p2: "Early backswing",
    p3: "Backswing",
    p4: "Top of swing",
    p5: "Early downswing",
    p6: "Downswing",
    p7: "Impact",
    p8: "Follow-through",
  };
  assert.deepEqual(C.POSITION_TAGS, expected);
  for (const [k, v] of Object.entries(C.POSITION_TAGS)) {
    assert.doesNotMatch(v, /\bP[1-8]\b/);
  }
});

test("no P[1-8] jargon in touched string tables", () => {
  const SD = require("../static/sessiondiff.js");
  const ShotStory = require("../static/shotstory.js");

  // Check compare POSITION_TAGS
  for (const [k, v] of Object.entries(C.POSITION_TAGS || {})) {
    assert.doesNotMatch(v, /\bP[1-8]\b/, `POSITION_TAGS[${k}] contains P-number`);
  }

  // Check sessiondiff FRIENDLY_NAMES
  for (const [k, v] of Object.entries(SD.FRIENDLY_NAMES || {})) {
    assert.doesNotMatch(v, /\bP[1-8]\b/, `sessiondiff FRIENDLY_NAMES[${k}] contains P-number`);
  }

  // Check ShotStory LABELS and PHASES
  for (const [k, v] of Object.entries(ShotStory.LABELS || {})) {
    assert.doesNotMatch(v, /\bP[1-8]\b/, `ShotStory LABELS[${k}] contains P-number`);
  }
  for (const [k, v] of Object.entries(ShotStory.PHASES || {})) {
    assert.doesNotMatch(v, /\bP[1-8]\b/, `ShotStory PHASES[${k}] contains P-number`);
  }
});

test("compare: diff clean up strips -0 and -0.0", () => {
  const cleanDiff = (a, b, d) => ((a - b > 0 ? "+" : "") + (a - b).toFixed(d)).replace(/^[+-]?0(\.0+)?$/, "0");
  assert.equal(cleanDiff(2.44, 2.45, 1), "0");
  assert.equal(cleanDiff(10.0, 10.03, 1), "0");
  assert.equal(cleanDiff(10.0, 9.5, 1), "+0.5");
  assert.equal(cleanDiff(9.5, 10.0, 1), "-0.5");
});

