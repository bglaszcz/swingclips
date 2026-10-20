// server/tests/optimize.test.js
// Unit tests for SwingOptimize (static/optimize.js).
// Run with: node --test server/tests/optimize.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const Tracer = require("../static/tracer.js");
const Optimize = require("../static/optimize.js");

// Planted shots: Driver at 148 mph ball speed, launch around 11°, spin around 3100 rpm.
// Carries from Tracer at 148 mph, 11 deg, 3100 rpm is ~223.8 yd.
function makePlantedDriverShots() {
  const baseSpeed = 148;
  const baseLaunch = 11;
  const baseSpin = 3100;
  const shots = [];

  // Generate 12 shots with slight variations
  const variations = [
    { dL: 0, dS: 0 },
    { dL: -0.5, dS: 100 },
    { dL: +0.5, dS: -100 },
    { dL: -1.0, dS: 150 },
    { dL: +1.0, dS: -150 },
    { dL: +0.2, dS: 50 },
    { dL: -0.2, dS: -50 },
    { dL: +0.8, dS: 200 },
    { dL: -0.8, dS: -200 },
    { dL: 0, dS: 50 },
    { dL: +0.4, dS: -80 },
    { dL: -0.4, dS: +80 },
  ];

  for (const v of variations) {
    const launch = baseLaunch + v.dL;
    const spin = baseSpin + v.dS;
    const fl = Tracer.flightPath(baseSpeed, launch, 0, spin, 0);
    // Square carry matches model within 1.0 yd
    const squareCarry = fl.carry + 0.5;
    shots.push({
      ballSpeed: baseSpeed,
      launch,
      spin,
      carry: squareCarry,
      club: "DR",
    });
  }

  return shots;
}

test("Optimize rejects non-wood clubs (irons, hybrids)", () => {
  const shots = makePlantedDriverShots();
  const resI7 = Optimize.optimize(shots, "I7", { tracer: Tracer });
  assert.equal(resI7.supported, false);
  assert.match(resI7.reason, /driver and fairway woods only/);

  const resH4 = Optimize.optimize(shots, "H4", { tracer: Tracer });
  assert.equal(resH4.supported, false);
  assert.match(resH4.reason, /driver and fairway woods only/);
});

test("Optimize rejects club when calibration error exceeds 4 yd at median", () => {
  const shots = makePlantedDriverShots().map(s => ({
    ...s,
    // Add artificial 8 yd discrepancy
    carry: s.carry - 8.0,
  }));

  const res = Optimize.optimize(shots, "DR", { tracer: Tracer });
  assert.equal(res.supported, false);
  assert.match(res.reason, /more than 4 yd at the median/);
  assert.ok(res.check);
  assert.equal(res.check.ok, false);
});

test("Optimize finds known optimal cell and calculates distance gain on planted shots", () => {
  const shots = makePlantedDriverShots();
  const res = Optimize.optimize(shots, "DR", { tracer: Tracer });

  assert.equal(res.supported, true);
  assert.equal(res.club, "DR");
  assert.equal(res.n, 12);
  assert.ok(res.check.ok);

  // Median values
  assert.equal(Math.round(res.medSpeed), 148);
  assert.equal(Math.round(res.medLaunch), 11);
  assert.ok(Math.abs(res.medSpin - 3100) <= 50);

  // Allowed bounds: the middle 80% of launch and spin, widened by 1 degree and 250 rpm
  assert.ok(res.bestCell.launch <= res.allowed.launchMax && res.bestCell.launch >= res.allowed.launchMin);
  assert.ok(res.bestCell.spin >= res.allowed.spinMin && res.bestCell.spin <= res.allowed.spinMax);
  assert.ok(res.allowed.launchMax <= 13 + 1e-9, "no further than 1 degree past the planted shots' 90th percentile");
  assert.ok(res.allowed.spinMin >= 2900 - 250 - 1e-9, "no further than 250 rpm below their 10th percentile");

  // Higher launch with less spin than the usual 11 degrees and 3,100 rpm carries further, within those bounds.
  assert.ok(res.gain > 2, `Expected gain > 2 yd, got ${res.gain} yd`);
  assert.ok(res.bestCell.carry > res.usualCarry);

  // Check summary wording
  assert.match(res.summary, /With your 148 mph ball speed/);
  assert.match(res.summary, /would carry about \d+ yd more than your usual/);
});

test("Optimize respects physically achievable boundary constraints (middle 80%, widened by 1 deg and 250 rpm)", () => {
  const shots = makePlantedDriverShots();
  const res = Optimize.optimize(shots, "DR", { tracer: Tracer });

  // Unconstrained optimal might be e.g. 17 deg with 2000 rpm, but that is outside
  // the golfer's hit range (max launch hit = 12 -> allowed max = 14; min spin hit = 2900 -> allowed min = 2400)
  assert.ok(res.bestCell.launch <= res.allowed.launchMax, `best launch ${res.bestCell.launch} <= ${res.allowed.launchMax}`);
  assert.ok(res.bestCell.spin >= res.allowed.spinMin, `best spin ${res.bestCell.spin} >= ${res.allowed.spinMin}`);
});

test("Optimize.render builds card structure with summary, SVG heat grid, and explain fold", () => {
  function makeMockDoc() {
    function createEl(tag) {
      return {
        tagName: tag.toUpperCase(),
        className: "",
        textContent: "",
        innerHTML: "",
        children: [],
        hidden: false,
        appendChild(c) { this.children.push(c); return c; },
        replaceChildren(...kids) { this.children = [...kids]; },
        setAttribute(k, v) { this[k] = v; },
        getAttribute(k) { return this[k]; },
      };
    }
    return {
      createElement(tag) { return createEl(tag); },
      createElementNS(ns, tag) { return createEl(tag); },
    };
  }

  const originalDoc = globalThis.document;
  globalThis.document = makeMockDoc();

  const container = globalThis.document.createElement("div");
  const shots = makePlantedDriverShots();

  Optimize.render(container, shots, "DR", { tracer: Tracer });

  assert.equal(container.hidden, false);
  const card = container.children[0];
  assert.ok(card);
  assert.equal(card.className, "opt-card");

  // Title
  const head = card.children.find(c => c.className === "opt-head");
  assert.ok(head);
  assert.match(head.children[0].textContent, /The distance you're leaving/);

  // Summary
  const summary = card.children.find(c => c.className === "opt-summary");
  assert.ok(summary);
  assert.match(summary.textContent, /With your 148 mph ball speed/);

  // Grid box
  const gridBox = card.children.find(c => c.className === "opt-grid-box");
  assert.ok(gridBox);
  assert.equal(gridBox.children[0].tagName, "SVG");

  // Legend
  const legend = card.children.find(c => c.className && c.className.includes("opt-legend"));
  assert.ok(legend);

  // Explain details fold
  const fold = card.children.find(c => c.className === "explain");
  assert.ok(fold);
  assert.match(fold.innerHTML, /Aerodynamic check/);
  assert.match(fold.innerHTML, /Achievable delivery/);

  // Non-wood club hides container
  Optimize.render(container, shots, "I7", { tracer: Tracer });
  assert.equal(container.hidden, true);

  globalThis.document = originalDoc;
});
