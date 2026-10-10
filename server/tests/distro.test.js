// server/tests/distro.test.js
// Unit tests for Spread distribution (static/distro.js).
// Run with: node --test server/tests/distro.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const Distro = require("../static/distro.js");

test("stats: returns null for fewer than 3 values", () => {
  assert.equal(Distro.stats([]), null);
  assert.equal(Distro.stats([10]), null);
  assert.equal(Distro.stats([10, 20]), null);
  assert.equal(Distro.stats([10, null, 20]), null);
});

test("stats: calculates n, med, q1, q3, min, max, and sd", () => {
  // [10, 20, 30, 40, 50]
  const s = Distro.stats([10, 20, 30, 40, 50]);
  assert.ok(s);
  assert.equal(s.n, 5);
  assert.equal(s.min, 10);
  assert.equal(s.max, 50);
  assert.equal(s.med, 30);
  assert.equal(s.q1, 20);
  assert.equal(s.q3, 40);
  // mean = 30, variance = ((400 + 100 + 0 + 100 + 400) / 4) = 250, sd = sqrt(250) ≈ 15.811
  assert.ok(Math.abs(s.sd - Math.sqrt(250)) < 1e-4);
});

test("bins: round steps and 8 to 16 bars", () => {
  // 100 values spanning 100 to 200
  const vals = [];
  for (let i = 0; i <= 100; i++) {
    vals.push(100 + i);
  }
  const b = Distro.bins(vals);
  assert.ok(b);
  const numBars = b.edges.length - 1;
  assert.ok(numBars >= 8 && numBars <= 16, `expected 8..16 bars, got ${numBars}`);

  // Step must be of the form (1, 2 or 5) * 10^k
  const normalized = b.step / (10 ** Math.floor(Math.log10(b.step)));
  const roundedNorm = Math.round(normalized * 10) / 10;
  assert.ok([1, 2, 5, 10].includes(roundedNorm), `step was ${b.step}, normalized was ${roundedNorm}`);

  // Edges must be strictly increasing
  for (let i = 0; i < b.edges.length - 1; i++) {
    assert.ok(b.edges[i] < b.edges[i + 1]);
  }
});

test("bins: values beyond middle 98% land in outer bars", () => {
  // 50 regular values plus two extreme outliers (-500 and +500)
  const rows = [{ val: -500 }];
  for (let i = 0; i < 50; i++) {
    rows.push({ val: 140 + i });
  }
  rows.push({ val: 500 });

  const a = Distro.analyze([{ key: "s1", start: 1000, rows }], "val");
  assert.ok(a.bars.length >= 8);

  // Lowest outlier (-500) must land in bar 0
  const firstBar = a.bars[0];
  assert.ok(firstBar.latest.some(r => r.val === -500));

  // Highest outlier (+500) must land in last bar
  const lastBar = a.bars[a.bars.length - 1];
  assert.ok(lastBar.latest.some(r => r.val === 500));
});

test("analyze: shares sum to 1 per group", () => {
  const sessBefore = {
    key: "s1",
    start: 1000,
    rows: Array.from({ length: 40 }, (_, i) => ({ carry: 140 + i })),
  };
  const sessLatest = {
    key: "s2",
    start: 2000,
    rows: Array.from({ length: 20 }, (_, i) => ({ carry: 145 + i })),
  };

  const a = Distro.analyze([sessBefore, sessLatest], "carry");
  assert.equal(a.before.rows.length, 40);
  assert.equal(a.latest.rows.length, 20);

  let shareLatestSum = 0;
  let shareBeforeSum = 0;
  for (const b of a.bars) {
    shareLatestSum += b.latest.length / a.latest.rows.length;
    shareBeforeSum += b.before.length / a.before.rows.length;
  }
  assert.ok(Math.abs(shareLatestSum - 1) < 1e-6);
  assert.ok(Math.abs(shareBeforeSum - 1) < 1e-6);
});

test("tighter / wider / same verdict and minimum 8 values per side", () => {
  // Case 1: Under 8 values on latest side -> tighter is null
  const sessB7 = {
    key: "s1",
    start: 1000,
    rows: Array.from({ length: 10 }, (_, i) => ({ carry: 100 + i * 2 })),
  };
  const sessL7 = {
    key: "s2",
    start: 2000,
    rows: Array.from({ length: 7 }, (_, i) => ({ carry: 150 + i })),
  };
  assert.equal(Distro.analyze([sessB7, sessL7], "carry").tighter, null);

  // Case 2: Tighter (latest IQR at least 15% smaller)
  // Before: range 100 to 120 (IQR ≈ 10)
  // Latest: range 148 to 152 (IQR ≈ 2)
  const rowsB = [100, 102, 105, 108, 110, 112, 115, 118, 120, 122].map(c => ({ carry: c }));
  const rowsTighter = [148, 149, 149, 150, 150, 151, 151, 152].map(c => ({ carry: c }));
  const aTighter = Distro.analyze([{ key: "s1", start: 1, rows: rowsB }, { key: "s2", start: 2, rows: rowsTighter }], "carry");
  assert.equal(aTighter.tighter, "tighter");

  // Case 3: Wider (latest IQR at least 15% larger)
  const rowsWider = [130, 135, 140, 145, 155, 160, 165, 170].map(c => ({ carry: c }));
  const aWider = Distro.analyze([{ key: "s1", start: 1, rows: rowsB }, { key: "s2", start: 2, rows: rowsWider }], "carry");
  assert.equal(aWider.tighter, "wider");

  // Case 4: Same (within 15%)
  const rowsSame = [101, 103, 105, 108, 110, 112, 115, 118, 121, 122].map(c => ({ carry: c }));
  const aSame = Distro.analyze([{ key: "s1", start: 1, rows: rowsB }, { key: "s2", start: 2, rows: rowsSame }], "carry");
  assert.equal(aSame.tighter, "same");
});

test("sessions under 3 values are left out of sessions breakdown", () => {
  const sess2 = {
    key: "s1",
    start: 1000,
    rows: [{ carry: 150 }, { carry: 152 }], // 2 values
  };
  const sess3 = {
    key: "s2",
    start: 2000,
    rows: [{ carry: 150 }, { carry: 152 }, { carry: 155 }], // 3 values
  };

  const a = Distro.analyze([sess2, sess3], "carry");
  assert.equal(a.sessions.length, 1);
  assert.equal(a.sessions[0].key, "s2");
  assert.equal(a.sessions[0].n, 3);
});
