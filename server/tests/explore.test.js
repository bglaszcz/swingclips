// Explorer test suite (static/explore.js): points, each swing against its group's usual, the fits both
// ways, the thirds, the rolling middle and the links grid; and summary.js's face to path with no club data.
//
// Run with: node --test tests/explore.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../static/explore.js");
const Summary = require("../static/summary.js");

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);

test("derive: offline either side, strike distance from the middle, face to path either way", () => {
  const d = E.derive({ offline: -7, strikeH: 3, strikeV: -4, faceToPath: -2.5 });
  assert.equal(d.absOffline, 7);
  assert.equal(d.strikeOff, 5);
  assert.equal(d.absFaceToPath, 2.5);
  const none = E.derive({ offline: null, strikeH: 3, strikeV: null });
  assert.equal(none.absOffline, null);
  assert.equal(none.strikeOff, null);
  assert.equal(none.absFaceToPath, null);
});

test("points: only swings with both numbers, each with its group", () => {
  const rows = [{ a: 1, b: 2, s: "x" }, { a: null, b: 2, s: "x" }, { a: 3, b: NaN, s: "y" }, { a: 4, b: 5, s: "y" }];
  const pts = E.points(rows, "a", "b", r => r.s);
  assert.deepEqual(pts.map(p => [p.x, p.y, p.g]), [[1, 2, "x"], [4, 5, "y"]]);
  assert.equal(pts[1].row, rows[3]);
});

test("centered: each point less its group's mean; small groups left out", () => {
  const pts = [
    ...[[1, 10], [2, 20], [3, 30]].map(([x, y]) => ({ x, y, g: "a", row: {} })),
    ...[[11, 5], [12, 6], [13, 7]].map(([x, y]) => ({ x, y, g: "b", row: {} })),
    { x: 100, y: 100, g: "c", row: {} }, { x: 101, y: 90, g: "c", row: {} },
  ];
  const c = E.centered(pts);
  assert.equal(c.length, 6);
  assert.deepEqual(c.map(p => p.x), [-1, 0, 1, -1, 0, 1]);
  assert.deepEqual(c.map(p => p.y), [-10, 0, 10, -1, 0, 1]);
});

test("fit: r, slope and what it takes to stand out", () => {
  const pts = Array.from({ length: 30 }, (_, i) => ({ x: i, y: 2 * i + (i % 2 ? 1 : -1) }));
  const f = E.fit(pts);
  assert.equal(f.n, 30);
  assert.ok(f.r > 0.99);
  near(f.slope, 2, 0.01);
  assert.ok(f.clear);
  assert.ok(f.needed > 0.3 && f.needed < 0.4);
  assert.ok(f.p < 0.001);
  // Too few points, or no spread: nothing said.
  assert.equal(E.fit(pts.slice(0, 2)).r, null);
  assert.equal(E.fit(pts.map(p => ({ x: 1, y: p.y }))).r, null);
});

test("a link that is only days differing fades against each day's usual", () => {
  // Two sessions: the second has more of both numbers, but inside a session there is no link.
  const wobble = [0.3, -0.3, 0.1, -0.1, 0.2, -0.2, 0.25, -0.25, 0.05, -0.05];
  const pts = [];
  wobble.forEach((w, i) => pts.push({ x: 1 + w, y: 100 + wobble[(i * 3 + 1) % 10] * 4, g: "mon", row: {} }));
  wobble.forEach((w, i) => pts.push({ x: 5 + w, y: 120 + wobble[(i * 7 + 2) % 10] * 4, g: "tue", row: {} }));
  const measured = E.fit(pts), day = E.fitWithin(pts);
  assert.ok(measured.r > 0.9 && measured.clear);
  assert.equal(day.groups, 2);
  assert.ok(Math.abs(day.r) < 0.5);
  assert.ok(!day.clear);
  // One degree of freedom spent per group: it takes more to stand out than as measured.
  assert.ok(day.needed > measured.needed);
});

test("a link inside every session shows against each day's usual even when the days hide it", () => {
  const pts = [];
  for (const [g, base] of [["a", 0], ["b", -30], ["c", 30]]) {
    for (let i = 0; i < 10; i++) pts.push({ x: i + (g === "b" ? 20 : 0), y: base + 2 * i + (i % 2 ? 0.5 : -0.5), g, row: {} });
  }
  const day = E.fitWithin(pts);
  assert.ok(day.r > 0.95 && day.clear);
  near(day.slope, 2, 0.05);
  const eff = E.effect(day);
  assert.ok(eff.step > 0);
  near(eff.change, day.slope * eff.step);
});

test("parts: thirds by the bottom number, with the result and the good shots in each", () => {
  const pts = Array.from({ length: 30 }, (_, i) => ({ x: i, y: 100 + i, row: { name: "s" + i, good: i >= 20 ? true : i >= 10 ? false : null } }));
  const parts = E.parts(pts, 3);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map(p => p.n), [10, 10, 10]);
  assert.deepEqual(parts.map(p => [p.lo, p.hi]), [[0, 9], [10, 19], [20, 29]]);
  near(parts[0].med, 104.5);
  assert.deepEqual(parts.map(p => [p.judged, p.good]), [[0, 0], [10, 0], [10, 10]]);
  assert.equal(parts[2].rows[0].name, "s20");
  // Equal values stay in one part; too few points: no parts.
  const tied = E.parts(Array.from({ length: 12 }, (_, i) => ({ x: i < 8 ? 1 : 2, y: i, row: {} })), 3);
  assert.deepEqual(tied.map(p => p.n), [8, 4]);
  assert.deepEqual(E.parts(pts.slice(0, 5), 3), []);
});

test("words: weak links are called no real link", () => {
  assert.equal(E.words({ r: 0.1 }, "Tempo", "Carry"), "no real link");
  assert.equal(E.words({ r: 0.4 }, "Tempo", "Carry"), "more tempo goes with more carry");
  assert.equal(E.words({ r: -0.4 }, "Tempo", "Carry"), "more tempo goes with less carry");
  assert.equal(E.words({ r: null }, "Tempo", "Carry"), "");
});

test("rolling: the middle of the last few, nothing until there are three", () => {
  assert.deepEqual(E.rolling([1, 5, 3, 100, 4], 3), [null, null, 3, 5, 4]);
  assert.deepEqual(E.rolling([1, null, 3, 2], 7), [null, null, null, 2]);
});

test("grid: one row per move, one cell per result, null where nothing was tested", () => {
  const links = [{ move: "tempo", result: "carry", r: 0.3 }, { move: "hipSway", result: "smash", r: -0.2 }];
  const g = E.grid(links, ["tempo", "hipSway"], ["carry", "smash"]);
  assert.deepEqual(g.map(r => r.move), ["tempo", "hipSway"]);
  assert.equal(g[0].cells[0].r, 0.3);
  assert.equal(g[0].cells[1], null);
  assert.equal(g[1].cells[1].r, -0.2);
});

test("outcomes name numbers that exist", () => {
  const keys = new Set([...Summary.SHOT.map(f => f.key), ...E.EXTRA.map(f => f.key)]);
  for (const o of E.OUTCOMES) assert.ok(keys.has(o.key), o.key);
});

test("summary.js: a shot with no club data has no face to path (not 0)", () => {
  const ballOnly = Summary.shotNumbers({ ball: { carry: 150, side: 2 }, clubData: { faceToTarget: null, path: null } });
  assert.equal(ballOnly.faceToPath, null);
  assert.equal(Summary.shotNumbers({ ball: { carry: 150 } }).faceToPath, null);
  near(Summary.shotNumbers({ ball: {}, clubData: { faceToTarget: -2, path: 1.5 } }).faceToPath, -3.5);
});
