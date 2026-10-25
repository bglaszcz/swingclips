// server/tests/menus.test.js: the Show button's count (static/menus.js showLabel)
const test = require("node:test");
const assert = require("node:assert/strict");
const { showLabel } = require("../static/menus.js");

const btn = (on, { hidden = false, shown = true } = {}) => ({
  hidden, shown, classList: { contains: c => c === "on" && on },
});
const displayed = b => b.shown;

test("counts the overlays that are on", () => {
  assert.equal(showLabel([btn(true), btn(false), btn(true)], displayed), "Show · 2 ▾");
});

test("nothing on reads plain Show", () => {
  assert.equal(showLabel([btn(false), btn(false)], displayed), "Show ▾");
  assert.equal(showLabel([], displayed), "Show ▾");
});

test("an overlay hidden by CSS doesn't count (Angles without Advanced data)", () => {
  // Angles is on by default but not in the list without Advanced data: the button read "Show · 1".
  assert.equal(showLabel([btn(true, { shown: false }), btn(false)], displayed), "Show ▾");
});

test("an overlay hidden by its hidden attribute doesn't count (Club arc on a swing without 3D)", () => {
  assert.equal(showLabel([btn(true, { hidden: true }), btn(true)], displayed), "Show · 1 ▾");
});
