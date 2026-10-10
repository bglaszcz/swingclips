// Review test suite (static/review.js): the swings marked "check" against each club's own usual.
//
// Run with: node --test tests/review.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const Review = require("../static/review.js");

const usual = (club, n, extra = {}) => Array.from({ length: n }, (_, i) =>
  ({ name: `${club}-${i}`, club, backswing: 0.9 + (i % 3) * 0.05, clubSpeed: 84 + (i % 5) - 2, carry: 153 + (i % 7) - 3, ...extra }));
const codes = (m, name) => (m.get(name) || []).map(f => f.code);

test("a backswing that took far longer than usual reads as a drill or rehearsal", () => {
  const rows = [...usual("I7", 20), { name: "pump", club: "I7", backswing: 1.8, clubSpeed: 84, carry: 150 },
                { name: "slowish", club: "I7", backswing: 1.25, clubSpeed: 84, carry: 150 }];
  const f = Review.flags(rows);
  assert.deepEqual(codes(f, "pump"), ["rehearsal"]);
  assert.match(f.get("pump")[0].text, /1\.8 s against your usual 1\.0/);
  assert.equal(f.has("slowish"), false);        // longer, but not half as long again
  assert.equal(f.size, 1);
});

test("club speed far under or over the usual; wedges' part swings are their job", () => {
  const rows = [...usual("I7", 20), ...usual("SW", 20, { clubSpeed: 70, carry: 80 }),
                { name: "half", club: "I7", backswing: 0.9, clubSpeed: 60, carry: 100 },
                { name: "hot", club: "I7", backswing: 0.9, clubSpeed: 100, carry: 160 },
                { name: "pitch", club: "SW", backswing: 0.8, clubSpeed: 40, carry: 30 }];
  const f = Review.flags(rows);
  assert.deepEqual(codes(f, "half"), ["part"]);
  assert.deepEqual(codes(f, "hot"), ["fast"]);
  assert.equal(f.has("pitch"), false);
});

test("a carry far past the usual reads as another club; a short one is a mishit and stays", () => {
  const rows = [...usual("I7", 20), { name: "long", club: "I7", backswing: 0.9, clubSpeed: 85, carry: 200 },
                { name: "topped", club: "I7", backswing: 0.9, clubSpeed: 85, carry: 12 }];
  const f = Review.flags(rows);
  assert.deepEqual(codes(f, "long"), ["long"]);
  assert.equal(f.has("topped"), false);
});

test("a swing can be marked for more than one thing; nothing is judged before a club has 10 swings", () => {
  const both = Review.flags([...usual("I7", 20), { name: "x", club: "I7", backswing: 2, clubSpeed: 100, carry: 210 }]);
  assert.deepEqual(codes(both, "x"), ["rehearsal", "fast", "long"]);
  const few = Review.flags([...usual("I5", 8), { name: "y", club: "I5", backswing: 2, clubSpeed: 120, carry: 260 }]);
  assert.equal(few.size, 0);
  assert.equal(Review.flags([]).size, 0);
  assert.equal(Review.flags([{ name: "z", club: null, backswing: 3 }]).size, 0);
});
