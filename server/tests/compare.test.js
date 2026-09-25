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
