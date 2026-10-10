// server/tests/indicators.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const indicators = require("../static/indicators.js");

const GOOD_RANGE = {
  enough: true,
  reliable: true,
  q10: 10,
  q25: 20,
  q75: 30,
  q90: 40,
  n: 25,
};

test("zone and side: inside middle half", () => {
  assert.equal(indicators.zone(25, GOOD_RANGE), "in");
  assert.equal(indicators.side(25, GOOD_RANGE), null);

  // Exact bounds
  assert.equal(indicators.zone(20, GOOD_RANGE), "in");
  assert.equal(indicators.side(20, GOOD_RANGE), null);

  assert.equal(indicators.zone(30, GOOD_RANGE), "in");
  assert.equal(indicators.side(30, GOOD_RANGE), null);
});

test("zone and side: near bounds (q10..q25 and q75..q90)", () => {
  // Low side
  assert.equal(indicators.zone(15, GOOD_RANGE), "near");
  assert.equal(indicators.side(15, GOOD_RANGE), "low");

  assert.equal(indicators.zone(10, GOOD_RANGE), "near");
  assert.equal(indicators.side(10, GOOD_RANGE), "low");

  // High side
  assert.equal(indicators.zone(35, GOOD_RANGE), "near");
  assert.equal(indicators.side(35, GOOD_RANGE), "high");

  assert.equal(indicators.zone(40, GOOD_RANGE), "near");
  assert.equal(indicators.side(40, GOOD_RANGE), "high");
});

test("zone and side: out bounds (< q10 and > q90)", () => {
  assert.equal(indicators.zone(5, GOOD_RANGE), "out");
  assert.equal(indicators.side(5, GOOD_RANGE), "low");

  assert.equal(indicators.zone(50, GOOD_RANGE), "out");
  assert.equal(indicators.side(50, GOOD_RANGE), "high");
});

test("no range and unreliable range treated as none", () => {
  assert.equal(indicators.zone(25, null), null);
  assert.equal(indicators.side(25, null), null);

  const notEnough = { ...GOOD_RANGE, enough: false };
  assert.equal(indicators.zone(25, notEnough), null);
  assert.equal(indicators.side(25, notEnough), null);

  const unreliable = { ...GOOD_RANGE, reliable: false };
  assert.equal(indicators.zone(25, unreliable), null);
  assert.equal(indicators.side(25, unreliable), null);

  assert.equal(indicators.zone(null, GOOD_RANGE), null);
  assert.equal(indicators.side(null, GOOD_RANGE), null);

  assert.equal(indicators.zone(NaN, GOOD_RANGE), null);
  assert.equal(indicators.side(NaN, GOOD_RANGE), null);
});

test("moments and pos mapping", () => {
  assert.equal(indicators.moment(null).tag, "RHYTHM");
  assert.equal(indicators.moment({}).tag, "RHYTHM");
  assert.equal(indicators.moment({ pos: undefined }).tag, "RHYTHM");
  assert.equal(indicators.moment({ pos: "p4" }).tag, "TOP");
  assert.equal(indicators.moment({ pos: "p4" }).name, "Top of the swing");
  assert.equal(indicators.moment({ pos: "p5" }).tag, "DOWNSWING");
  assert.equal(indicators.moment({ pos: "p6" }).tag, "DOWNSWING");
  assert.equal(indicators.moment({ pos: "p7" }).tag, "IMPACT");
  assert.equal(indicators.moment({ pos: "p7" }).name, "Impact");

  // String pos shorthand
  assert.equal(indicators.moment("p4").tag, "TOP");
  assert.equal(indicators.moment("p7").tag, "IMPACT");
});

test("favorites: default, toggle, and persistence", () => {
  const store = {};

  // Defaults
  const def = indicators.favs(store);
  assert.deepEqual(def, ["handsAhead", "hipSway", "earlyExt", "tempo"]);

  // Toggle remove existing
  const afterRemove = indicators.toggleFav("tempo", store);
  assert.deepEqual(afterRemove, ["handsAhead", "hipSway", "earlyExt"]);
  assert.equal(JSON.parse(store["indicator-favs"]).includes("tempo"), false);

  // Toggle add new
  const afterAdd = indicators.toggleFav("leadHipP6", store);
  assert.deepEqual(afterAdd, ["handsAhead", "hipSway", "earlyExt", "leadHipP6"]);
  assert.equal(JSON.parse(store["indicator-favs"]).includes("leadHipP6"), true);
});

test("favorites: cap at 8 items", () => {
  const store = {
    "indicator-favs": JSON.stringify(["k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8"]),
  };

  const list = indicators.favs(store);
  assert.equal(list.length, 8);

  // Adding 9th does not exceed 8
  const afterOverflow = indicators.toggleFav("k9", store);
  assert.equal(afterOverflow.length, 8);
  assert.equal(afterOverflow.includes("k9"), false);

  // Removing one works
  const afterRem = indicators.toggleFav("k1", store);
  assert.equal(afterRem.length, 7);

  // Now we can add k9
  const afterReAdd = indicators.toggleFav("k9", store);
  assert.equal(afterReAdd.length, 8);
  assert.equal(afterReAdd.includes("k9"), true);
});

test("tile: basic DOM structure with mock document", () => {
  function makeMockDoc() {
    function createEl(tag) {
      return {
        tagName: tag.toUpperCase(),
        className: "",
        dataset: {},
        style: {},
        children: [],
        appendChild(child) { this.children.push(child); return child; },
        setAttribute(k, v) { this[k] = v; },
        getAttribute(k) { return this[k]; },
      };
    }
    return {
      createElement: createEl,
      createElementNS: (_ns, tag) => createEl(tag),
    };
  }

  const doc = makeMockDoc();
  const item = {
    key: "leadHipP6",
    field: { key: "leadHipP6", label: "Lead hip in downswing", pos: "p6", unit: "in", dec: 1 },
    value: 4.2,
    range: GOOD_RANGE,
    shaky: false,
  };

  const btn = indicators.tile(item, { document: doc, fav: true });
  assert.equal(btn.tagName, "BUTTON");
  assert.match(btn.className, /in-tile/);
  assert.match(btn.className, /in-zone-out/); // 4.2 is < q10 (10)
  assert.equal(btn.dataset.key, "leadHipP6");
});

test("renderThisSwing: hides without body numbers, renders strip with favorites and seeks", () => {
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
      };
    }
    return {
      createElement: createEl,
      createElementNS: (_ns, tag) => createEl(tag),
    };
  }

  const doc = makeMockDoc();
  const box = doc.createElement("div");

  // 1. Without body numbers -> hidden
  indicators.renderThisSwing(box, { body: null, document: doc });
  assert.equal(box.hidden, true);

  indicators.renderThisSwing(box, { body: { tempo: null, hipSway: undefined }, document: doc });
  assert.equal(box.hidden, true);

  // 2. With body numbers -> visible, contains "This swing" title and "Choose" button
  let jumpedIndex = null;
  let chose = false;
  const positions = [
    { key: "p4", index: 42, tag: "P4" },
    { key: "p7", index: 88, tag: "P7" },
  ];
  const body = {
    tempo: 3.1,
    hipSway: 3.8,
    earlyExt: 2.5,
    handsAhead: 4.0,
  };
  const store = { "indicator-favs": JSON.stringify(["tempo", "hipSway"]) };

  indicators.renderThisSwing(box, {
    body,
    ranges: { tempo: GOOD_RANGE, hipSway: GOOD_RANGE },
    positions,
    storage: store,
    document: doc,
    jumpTo: idx => { jumpedIndex = idx; },
    onChoose: () => { chose = true; },
  });

  assert.equal(box.hidden, false);
  assert.equal(box.children.length, 2); // head and strip

  const head = box.children[0];
  const title = head.children.find(c => c.tagName === "STRONG");
  assert.equal(title.textContent, "This swing");

  const chooseBtn = head.children.find(c => c.className.includes("in-choose-btn"));
  assert.ok(chooseBtn);
  chooseBtn.onclick();
  assert.equal(chose, true);

  const strip = box.children[1];
  assert.equal(strip.children.length, 2); // 2 favorites: tempo, hipSway

  // Tap tempo tile -> seeks to P4 (42)
  const tempoTile = strip.children[0];
  assert.equal(tempoTile.dataset.key, "tempo");
  tempoTile.onclick();
  assert.equal(jumpedIndex, 42);

  // Tap hipSway tile -> seeks to P7 (88)
  const hipTile = strip.children[1];
  assert.equal(hipTile.dataset.key, "hipSway");
  hipTile.onclick();
  assert.equal(jumpedIndex, 88);
});

