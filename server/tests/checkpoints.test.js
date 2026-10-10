// server/tests/checkpoints.test.js
// Unit tests for Swing checkpoints (static/checkpoints.js).
// Run with: node --test server/tests/checkpoints.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const Checkpoints = require("../static/checkpoints.js");

const FIELDS = [
  { key: "tempo", label: "Tempo", unit: ":1", dec: 1 }, // Rhythm
  { key: "backswing", label: "Backswing time", unit: "s", dec: 2 }, // Rhythm
  { key: "shoulderTop", label: "Shoulder turn at top", unit: "°", dec: 1, pos: "p4" }, // Top
  { key: "pelvisTop", label: "Pelvis turn at top", unit: "°", dec: 1, pos: "p4" }, // Top
  { key: "lagP5", label: "Wrist hinge at P5", unit: "°", dec: 1, pos: "p5" }, // Downswing
  { key: "leadHipP6", label: "Lead hip at P6", unit: "in", dec: 1, pos: "p6" }, // Downswing
  { key: "hipSway", label: "Hip sway at impact", unit: "in", dec: 1, pos: "p7" }, // Impact
  { key: "earlyExt", label: "Hips to ball at impact", unit: "in", dec: 1, pos: "p7" }, // Impact
];

test("groups and their order: Rhythm, Top of the swing, Downswing, Impact", () => {
  const sess = [{
    key: "s1",
    start: 1000,
    rows: [{
      tempo: 3.0, backswing: 0.75, shoulderTop: 110, pelvisTop: 45,
      lagP5: 65, leadHipP6: 3.5, hipSway: 4.0, earlyExt: 2.0,
    }],
  }];

  const a = Checkpoints.analyze(sess, { fields: FIELDS });
  assert.equal(a.groups.length, 4);
  assert.equal(a.groups[0].name, "Rhythm");
  assert.equal(a.groups[1].name, "Top of the swing");
  assert.equal(a.groups[2].name, "Downswing");
  assert.equal(a.groups[3].name, "Impact");

  assert.deepEqual(a.groups[0].items.map(i => i.key), ["tempo", "backswing"]);
  assert.deepEqual(a.groups[1].items.map(i => i.key), ["shoulderTop", "pelvisTop"]);
  assert.deepEqual(a.groups[2].items.map(i => i.key), ["lagP5", "leadHipP6"]);
  assert.deepEqual(a.groups[3].items.map(i => i.key), ["hipSway", "earlyExt"]);
});

test("inside, below, above range: gap calculation and words", () => {
  const range = { enough: true, reliable: true, q10: 10, q25: 20, q50: 30, q75: 40, q90: 50 };
  const ranges = {
    insideKey: range,
    lowKey: range,
    highKey: range,
  };
  const fields = [
    { key: "insideKey", label: "Inside Metric", unit: "", dec: 1 },
    { key: "lowKey", label: "Low Metric", unit: "", dec: 1 },
    { key: "highKey", label: "High Metric", unit: "", dec: 1 },
  ];

  // 10 swings in session: insideKey = 25 (inside 20..40), lowKey = 12 (below 20), highKey = 48 (above 40)
  const rows = Array.from({ length: 10 }, () => ({
    insideKey: 25,
    lowKey: 12,
    highKey: 48,
  }));
  const sess = [{ key: "s1", start: 1000, rows }];

  const a = Checkpoints.analyze(sess, { fields, ranges });

  const insideItem = a.allItems.find(i => i.key === "insideKey");
  assert.equal(insideItem.gap, 0);
  assert.equal(insideItem.latest.med, 25);

  const lowItem = a.allItems.find(i => i.key === "lowKey");
  assert.equal(lowItem.gap, 8); // 20 - 12
  assert.equal(lowItem.latest.med, 12);

  const highItem = a.allItems.find(i => i.key === "highKey");
  assert.equal(highItem.gap, 8); // 48 - 40
  assert.equal(highItem.latest.med, 48);
});

test("no range and unreliable range treated as none", () => {
  const fields = [
    { key: "noRangeKey", label: "No Range", unit: "" },
    { key: "unreliableKey", label: "Unreliable", unit: "" },
    { key: "notEnoughKey", label: "Not Enough", unit: "" },
  ];
  const ranges = {
    unreliableKey: { enough: true, reliable: false, q10: 10, q25: 20, q50: 30, q75: 40, q90: 50 },
    notEnoughKey: { enough: false, reliable: true, q10: 10, q25: 20, q50: 30, q75: 40, q90: 50 },
  };

  const rows = Array.from({ length: 10 }, () => ({
    noRangeKey: 25,
    unreliableKey: 25,
    notEnoughKey: 25,
  }));
  const sess = [{ key: "s1", start: 1000, rows }];

  const a = Checkpoints.analyze(sess, { fields, ranges });

  for (const item of a.allItems) {
    assert.equal(item.range, null);
    assert.equal(item.gap, null);
    assert.equal(item.inRange, null);
    assert.equal(item.outRows.length, 0);
  }
});

test("null readings are left out of calculations", () => {
  const fields = [{ key: "val", label: "Value", unit: "" }];
  const rows = [
    { val: 10 },
    { val: null },
    { val: undefined },
    { val: NaN },
    { val: 20 },
    { val: 30 },
  ];
  const sess = [{ key: "s1", start: 1000, rows }];

  const a = Checkpoints.analyze(sess, { fields });
  const item = a.allItems[0];

  assert.equal(item.n, 3);
  assert.equal(item.med, 20);
  assert.equal(item.q1, 15);
  assert.equal(item.q3, 25);
  assert.equal(item.latest.n, 3);
  assert.equal(item.latest.med, 20);
});

test("inRange shares and outRows", () => {
  const fields = [{ key: "val", label: "Value", unit: "" }];
  const range = { enough: true, reliable: true, q10: 10, q25: 20, q50: 30, q75: 40, q90: 50 };
  const ranges = { val: range };

  // 10 swings: 2 below q10 (5, 8), 6 inside q10..q90 (15, 20, 25, 30, 35, 45), 2 above q90 (55, 60)
  const values = [5, 8, 15, 20, 25, 30, 35, 45, 55, 60];
  const rows = values.map((v, i) => ({ id: i, val: v }));
  const sess = [{ key: "s1", start: 1000, rows }];

  const a = Checkpoints.analyze(sess, { fields, ranges });
  const item = a.allItems[0];

  assert.equal(item.inRange, 0.6); // 6 of 10
  assert.equal(item.outRows.length, 4); // 5, 8, 55, 60
  assert.deepEqual(item.outRows.map(r => r.val), [5, 8, 55, 60]);
});

test("worst ordering and minimum 8 latest swings", () => {
  const range = { enough: true, reliable: true, q10: 0, q25: 10, q50: 20, q75: 30, q90: 40 }; // width = 20
  const wideRange = { enough: true, reliable: true, q10: 0, q25: 20, q50: 50, q75: 80, q90: 100 }; // width = 60

  const fields = [
    { key: "fUnder8", label: "Under 8 swings", unit: "" },
    { key: "fSmallRel", label: "Small relative gap", unit: "" },
    { key: "fLargeRel", label: "Large relative gap", unit: "" },
    { key: "fMedRel", label: "Medium relative gap", unit: "" },
    { key: "fInside", label: "Inside range", unit: "" },
  ];

  const ranges = {
    fUnder8: range,
    fSmallRel: wideRange, // gap = 10, rel = 10/60 ≈ 0.167
    fLargeRel: range,     // gap = 15, rel = 15/20 = 0.75
    fMedRel: range,       // gap = 10, rel = 10/20 = 0.50
    fInside: range,       // gap = 0
  };

  // 10 swings for latest session
  const rows = Array.from({ length: 10 }, (_, i) => ({
    fUnder8: i < 7 ? 50 : null, // only 7 readings -> excluded from worst
    fSmallRel: 90,              // 90 - 80 = 10 gap
    fLargeRel: 45,              // 45 - 30 = 15 gap
    fMedRel: 40,                // 40 - 30 = 10 gap
    fInside: 20,                // inside 10..30 -> gap 0
  }));

  const sess = [{ key: "s1", start: 1000, rows }];
  const a = Checkpoints.analyze(sess, { fields, ranges });

  assert.equal(a.worst.length, 3);
  assert.equal(a.worst[0].key, "fLargeRel");
  assert.equal(a.worst[1].key, "fMedRel");
  assert.equal(a.worst[2].key, "fSmallRel");
});

test("status line reflects club, swing counts and items inside range", () => {
  const range = { enough: true, reliable: true, q10: 10, q25: 20, q50: 30, q75: 40, q90: 50 };
  const fields = [
    { key: "k1", label: "K1" },
    { key: "k2", label: "K2" },
    { key: "kNoRange", label: "No Range" },
  ];
  const ranges = { k1: range, k2: range };

  // 10 swings: k1 inside (25), k2 high (45), kNoRange = 10
  const rows = Array.from({ length: 10 }, () => ({
    club: "I7",
    k1: 25,
    k2: 45,
    kNoRange: 10,
  }));
  const sess = [{ key: "s1", start: 1000, rows }];

  const a = Checkpoints.analyze(sess, { fields, ranges });
  assert.equal(a.status, "7 iron · 10 swings · 1 of 2 numbers inside your good-shot range last session");

  // Empty sessions -> "no swings"
  const aEmpty = Checkpoints.analyze([], { fields, ranges });
  assert.equal(aEmpty.status, "no swings");

  // No ranges -> "no good-shot ranges yet"
  const aNoRange = Checkpoints.analyze(sess, { fields, ranges: {} });
  assert.equal(aNoRange.status, "7 iron · 10 swings · no good-shot ranges yet");
});

test("render: builds sentence, chips, grid, detail panel on tap with actions", () => {
  function makeMockDoc() {
    function createEl(tag) {
      return {
        tagName: tag.toUpperCase(),
        className: "",
        dataset: {},
        style: {},
        children: [],
        hidden: false,
        appendChild(child) { this.children.push(child); return child; },
        replaceChildren(...kids) { this.children = [...kids]; },
        setAttribute(k, v) { this[k] = v; },
        getAttribute(k) { return this[k]; },
        querySelectorAll(sel) {
          const results = [];
          function walk(node) {
            if (sel === ".in-tile" && node.className && node.className.includes("in-tile")) results.push(node);
            for (const c of (node.children || [])) walk(c);
          }
          walk(this);
          return results;
        },
        classList: {
          toggle(cls, val) {
            const has = this._el.className.includes(cls);
            if (val === undefined) val = !has;
            if (val && !has) this._el.className += " " + cls;
            else if (!val && has) this._el.className = this._el.className.replace(new RegExp("\\b" + cls + "\\b", "g"), "").trim();
          },
          add(cls) { if (!this._el.className.includes(cls)) this._el.className += " " + cls; },
          remove(cls) { this._el.className = this._el.className.replace(new RegExp("\\b" + cls + "\\b", "g"), "").trim(); },
        },
      };
    }
    const doc = {
      createElement(tag) {
        const el = createEl(tag);
        el.classList._el = el;
        return el;
      },
      createElementNS(_ns, tag) {
        const el = createEl(tag);
        el.classList._el = el;
        return el;
      },
    };
    return doc;
  }

  // Set global document for render
  const originalDoc = globalThis.document;
  globalThis.document = makeMockDoc();

  const range = { enough: true, reliable: true, q10: 10, q25: 20, q50: 30, q75: 40, q90: 50 };
  const fields = [
    { key: "tempo", label: "Tempo", unit: ":1", dec: 1 },
    { key: "shoulderTop", label: "Shoulder turn", unit: "°", dec: 1, pos: "p4" },
    { key: "lagP5", label: "Wrist hinge", unit: "°", dec: 1, pos: "p5" },
    { key: "hipSway", label: "Hip sway", unit: "in", dec: 1, pos: "p7" },
  ];
  const ranges = { tempo: range, shoulderTop: range, lagP5: range, hipSway: range };

  // 10 swings: tempo = 25 (inside), shoulderTop = 45 (high -> aim less), lagP5 = 15 (low -> aim more), hipSway = 25 (inside)
  const rows = Array.from({ length: 10 }, () => ({
    tempo: 25,
    shoulderTop: 45,
    lagP5: 15,
    hipSway: 25,
  }));
  const sess = [{ key: "s1", start: 1000, rows }];

  const a = Checkpoints.analyze(sess, { fields, ranges });
  const box = globalThis.document.createElement("div");

  let pickedMetric = null;
  let goalKey = null, goalAim = null;

  Checkpoints.render(box, a, {
    onMetric: k => { pickedMetric = k; },
    onGoal: (k, aim) => { goalKey = k; goalAim = aim; },
  });

  // Verify structure: sentence, chips, grid, panel, fold
  assert.equal(box.children.length, 5);
  const sentence = box.children[0];
  assert.match(sentence.textContent, /Last session 2 of 4 body numbers/);

  const chips = box.children[1];
  assert.equal(chips.className, "cp-chips");
  const chipLabels = chips.children.map(c => c.textContent);
  assert.ok(chipLabels.includes("Favorites"));
  assert.ok(chipLabels.includes("All"));
  assert.ok(chipLabels.includes("Rhythm"));
  assert.ok(chipLabels.includes("Top of the swing"));
  assert.ok(chipLabels.includes("Downswing"));
  assert.ok(chipLabels.includes("Impact"));

  const grid = box.children[2];
  assert.equal(grid.className, "cp-grid");
  assert.equal(grid.children.length, 4); // All 4 items

  const panel = box.children[3];
  assert.equal(panel.className, "cp-panel");
  assert.equal(panel.hidden, true); // Hidden until tile tapped

  // Tap shoulderTop tile (index 1) -> outside range high (45 > 40)
  const shoulderTile = grid.children.find(c => c.dataset.key === "shoulderTop");
  assert.ok(shoulderTile);
  shoulderTile.onclick();

  assert.equal(panel.hidden, false);
  const actions = panel.children[1];
  assert.equal(actions.className, "cp-panel-actions");

  // "See it over time"
  const overTimeBtn = actions.children[0];
  assert.equal(overTimeBtn.textContent, "See it over time");
  overTimeBtn.onclick();
  assert.equal(pickedMetric, "shoulderTop");

  // "Make this my focus" is present because 45 > 40 (high -> aim less)
  const focusBtn = actions.children.find(c => c.className.includes("cp-btn-focus"));
  assert.ok(focusBtn);
  assert.equal(focusBtn.textContent, "Make this my focus");
  focusBtn.onclick();
  assert.equal(goalKey, "shoulderTop");
  assert.equal(goalAim, "less");

  // Tap tempo tile (index 0) -> inside range (25 in 20..40)
  const tempoTile = grid.children.find(c => c.dataset.key === "tempo");
  tempoTile.onclick();
  const tempoActions = panel.children[1];
  const tempoFocusBtn = tempoActions.children.find(c => c.className.includes("cp-btn-focus"));
  assert.equal(tempoFocusBtn, undefined); // Inside range -> no focus button

  // Restore global document
  globalThis.document = originalDoc;
});

