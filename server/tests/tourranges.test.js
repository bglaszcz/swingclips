// server/tests/tourranges.test.js
// Unit tests for SwingTourRanges (static/tourranges.js).
// Run with: node --test server/tests/tourranges.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const TourRanges = require("../static/tourranges.js");

test("every tour range entry has key, valid range, units, system, and published source", () => {
  const entries = TourRanges.all();
  assert.ok(entries.length > 0, "must have tour range entries");

  for (const entry of entries) {
    assert.ok(typeof entry.key === "string" && entry.key.length > 0, "key must be non-empty string");
    assert.ok(typeof entry.label === "string" && entry.label.length > 0, "label must be non-empty string");
    assert.ok(typeof entry.min === "number" && Number.isFinite(entry.min), "min must be finite number");
    assert.ok(typeof entry.max === "number" && Number.isFinite(entry.max), "max must be finite number");
    assert.ok(entry.max >= entry.min, `max (${entry.max}) must be >= min (${entry.min}) for ${entry.key}`);
    assert.ok(typeof entry.unit === "string" && entry.unit.length > 0, `unit must be non-empty string for ${entry.key}`);
    assert.ok(typeof entry.club === "string" && entry.club.length > 0, `club must be non-empty string for ${entry.key}`);
    assert.ok(typeof entry.system === "string" && entry.system.length > 0, `system must be non-empty string for ${entry.key}`);

    // Source validation
    assert.ok(entry.source && typeof entry.source === "object", `source must be an object for ${entry.key}`);
    assert.ok(typeof entry.source.title === "string" && entry.source.title.length > 0, `source.title required for ${entry.key}`);
    assert.ok(typeof entry.source.year === "number" && entry.source.year > 1900, `source.year required for ${entry.key}`);
    assert.ok(typeof entry.source.link === "string" && entry.source.link.startsWith("http"), `source.link required for ${entry.key}`);
  }
});

test("TourRanges.get retrieves by key and handles club fallback", () => {
  const tempo = TourRanges.get("tempo");
  assert.ok(tempo);
  assert.equal(tempo.key, "tempo");
  assert.equal(tempo.min, 2.8);
  assert.equal(tempo.max, 3.2);

  const pelvis = TourRanges.get("pelvisTop", "I7");
  assert.ok(pelvis);
  assert.equal(pelvis.min, 40);
  assert.equal(pelvis.max, 50);

  assert.equal(TourRanges.get("nonexistentKey"), null);
  assert.equal(TourRanges.get(null), null);
});

test("TourRanges.formatTourText formats clean text line for detail panel", () => {
  const text = TourRanges.formatTourText("pelvisTop");
  assert.match(text, /Tour players \(Cheetham 2008\): 40 to 50°/);

  const tempoText = TourRanges.formatTourText("tempo");
  assert.match(tempoText, /Tour players \(Tour Tempo 2004\): 2.8 to 3.2 :1/);

  assert.equal(TourRanges.formatTourText("unknownKey"), "");
});
