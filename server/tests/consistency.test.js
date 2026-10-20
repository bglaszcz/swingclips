// server/tests/consistency.test.js
// Unit tests for Consistency view (server/static/consistency.js).
// Run with: node --test server/tests/consistency.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const Consistency = require("../static/consistency.js");

test("robustSpread: returns null for fewer than 2 values", () => {
  assert.equal(Consistency.robustSpread([]), null);
  assert.equal(Consistency.robustSpread([10]), null);
  assert.equal(Consistency.robustSpread([10, null]), null);
});

test("robustSpread: calculates 1.4826 x MAD", () => {
  // [10, 20, 30] -> med = 20, diffs = [10, 0, 10] -> sorted diffs = [0, 10, 10] -> mad = 10
  // robustSpread = 10 * 1.4826 = 14.826
  const s = Consistency.robustSpread([10, 20, 30]);
  assert.ok(s !== null);
  assert.ok(Math.abs(s - 14.826) < 1e-4);
});

test("ratioWords: formats ratios into plain English phrases", () => {
  assert.equal(Consistency.ratioWords(2.0), "wanders about twice as far as your good shots do");
  assert.equal(Consistency.ratioWords(1.5), "wanders about one and a half times as far as your good shots do");
  assert.equal(Consistency.ratioWords(1.0), "wanders about as far as your good shots do");
  assert.equal(Consistency.ratioWords(0.5), "wanders about half as far as your good shots do");
  assert.equal(Consistency.ratioWords(3.2), "wanders about 3 times as far as your good shots do");
});

test("analyze: excludes metrics with fewer than 8 good shots", () => {
  const sessions = [
    { key: "s1", rows: Array(10).fill({ club: "I7", body: { hipSway: 5.0 }, trust: { hipSway: { level: "ok" } } }) },
    { key: "s2", rows: Array(10).fill({ club: "I7", body: { hipSway: 5.2 }, trust: { hipSway: { level: "ok" } } }) },
    { key: "s3", rows: Array(10).fill({ club: "I7", body: { hipSway: 5.1 }, trust: { hipSway: { level: "ok" } } }) },
  ];
  const model = Consistency.analyze(sessions, {
    club: "I7",
    goodRange: () => ({ n: 5, enough: false }), // < 8 good shots
    bodyFields: [{ key: "hipSway", label: "Hip sway at impact", unit: "in" }]
  });
  assert.equal(model.ranked.length, 0);
  assert.equal(model.excluded.length, 1);
  assert.match(model.excluded[0].reason, /fewer than 8 good shots/);
});

test("analyze: excludes metrics with fewer than 20 readings over 3 sessions", () => {
  // Only 2 sessions
  const sessions = [
    { key: "s1", rows: Array(10).fill({ club: "I7", body: { hipSway: 5.0 }, trust: { hipSway: { level: "ok" } } }) },
    { key: "s2", rows: Array(10).fill({ club: "I7", body: { hipSway: 5.2 }, trust: { hipSway: { level: "ok" } } }) },
  ];
  const model = Consistency.analyze(sessions, {
    club: "I7",
    goodRange: () => ({ n: 20, enough: true, q25: 4.5, q75: 5.5 }),
    bodyFields: [{ key: "hipSway", label: "Hip sway at impact", unit: "in" }]
  });
  assert.equal(model.ranked.length, 0);
  assert.equal(model.excluded.length, 1);
  assert.match(model.excluded[0].reason, /fewer than 20 readings over 3 sessions/);
});

test("analyze: excludes metrics where most readings are shaky", () => {
  const sessions = [
    { key: "s1", rows: Array(10).fill({ club: "I7", body: { hipSway: 5.0 }, trust: { hipSway: { level: "shaky" } } }) },
    { key: "s2", rows: Array(10).fill({ club: "I7", body: { hipSway: 5.2 }, trust: { hipSway: { level: "shaky" } } }) },
    { key: "s3", rows: Array(10).fill({ club: "I7", body: { hipSway: 5.1 }, trust: { hipSway: { level: "ok" } } }) },
  ];
  const model = Consistency.analyze(sessions, {
    club: "I7",
    goodRange: () => ({ n: 20, enough: true, q25: 4.5, q75: 5.5 }),
    bodyFields: [{ key: "hipSway", label: "Hip sway at impact", unit: "in" }]
  });
  assert.equal(model.ranked.length, 0);
  assert.equal(model.excluded.length, 1);
  assert.match(model.excluded[0].reason, /most readings are shaky/);
});

test("analyze: ranks metrics by spread / goodWidth ratio and subtracts noise", () => {
  const makeSession = (sKey, valA, valB) => ({
    key: sKey,
    rows: [
      { club: "I7", body: { moveA: valA - 1, moveB: valB - 0.2 }, trust: { moveA: { level: "ok" }, moveB: { level: "ok" } } },
      { club: "I7", body: { moveA: valA,     moveB: valB },       trust: { moveA: { level: "ok" }, moveB: { level: "ok" } } },
      { club: "I7", body: { moveA: valA + 1, moveB: valB + 0.2 }, trust: { moveA: { level: "ok" }, moveB: { level: "ok" } } },
      { club: "I7", body: { moveA: valA + 2, moveB: valB + 0.4 }, trust: { moveA: { level: "ok" }, moveB: { level: "ok" } } },
      { club: "I7", body: { moveA: valA - 2, moveB: valB - 0.4 }, trust: { moveA: { level: "ok" }, moveB: { level: "ok" } } },
      { club: "I7", body: { moveA: valA + 1, moveB: valB + 0.2 }, trust: { moveA: { level: "ok" }, moveB: { level: "ok" } } },
      { club: "I7", body: { moveA: valA - 1, moveB: valB - 0.2 }, trust: { moveA: { level: "ok" }, moveB: { level: "ok" } } },
    ]
  });

  const sessions = [
    makeSession("s1", 10, 5),
    makeSession("s2", 12, 5),
    makeSession("s3", 14, 5)
  ];

  const goodRanges = {
    moveA: { n: 20, enough: true, q25: 8, q75: 10 }, // width = 2
    moveB: { n: 20, enough: true, q25: 4, q75: 6 },  // width = 2
  };

  const model = Consistency.analyze(sessions, {
    club: "I7",
    goodRange: (club, key) => goodRanges[key],
    bodyFields: [
      { key: "moveA", label: "Movement A", unit: "°" },
      { key: "moveB", label: "Movement B", unit: "in" }
    ]
  });

  assert.equal(model.ranked.length, 2);
  assert.equal(model.ranked[0].key, "moveA");
  assert.ok(model.ranked[0].ratio > model.ranked[1].ratio);
  assert.equal(model.top5.length, 2);
  assert.equal(model.others.length, 0);
});

test("render: builds DOM with top rows, folds, and interactive click", () => {
  function fakeDoc() {
    function node(tag) {
      return {
        tagName: tag.toUpperCase(),
        children: [],
        style: {},
        className: "",
        textContent: "",
        innerHTML: "",
        onclick: null,
        appendChild(child) {
          if (child) this.children.push(child);
          return child;
        },
        append(...kids) {
          for (const k of kids) if (k) this.children.push(k);
        },
        replaceChildren(...kids) {
          this.children = [];
          if (kids) this.append(...kids);
        }
      };
    }
    return {
      createElement(tag) {
        return node(tag);
      }
    };
  }

  const prevDoc = globalThis.document;
  globalThis.document = fakeDoc();

  try {
    const box = globalThis.document.createElement("div");
    const model = {
      club: "I7",
      ranked: [
        { key: "m1", label: "Move 1", unit: "°", netSpread: 6.5, goodWidth: 3.2, ratio: 2.03, words: "wanders about twice as far as your good shots do", swings: 50, sessions: 5 },
        { key: "m2", label: "Move 2", unit: "in", netSpread: 0.8, goodWidth: 0.8, ratio: 1.0, words: "wanders about as far as your good shots do", swings: 45, sessions: 4 },
      ],
      top5: [
        { key: "m1", label: "Move 1", unit: "°", netSpread: 6.5, goodWidth: 3.2, ratio: 2.03, words: "wanders about twice as far as your good shots do", swings: 50, sessions: 5 },
        { key: "m2", label: "Move 2", unit: "in", netSpread: 0.8, goodWidth: 0.8, ratio: 1.0, words: "wanders about as far as your good shots do", swings: 45, sessions: 4 },
      ],
      others: [
        { key: "m3", label: "Move 3", unit: "in", netSpread: 0.3, goodWidth: 0.9, ratio: 0.33, words: "wanders about a third as far as your good shots do", swings: 40, sessions: 4 }
      ],
      excluded: [
        { key: "ex1", label: "Excluded 1", reason: "most readings are shaky" }
      ],
      status: "wanders outside good shots"
    };

    let pickedKey = null;
    Consistency.render(box, model, {
      onPick: k => { pickedKey = k; }
    });

    // Structure: container (top 5 rows), "Every number" fold, "How it's worked out" fold
    assert.equal(box.children.length, 3);
    const container = box.children[0];
    assert.equal(container.children.length, 2); // 2 rows in top5

    // Click on first row
    container.children[0].onclick();
    assert.equal(pickedKey, "m1");

    // Second child is Every number details
    const everyFold = box.children[1];
    assert.equal(everyFold.tagName, "DETAILS");

    // Third child is How it's worked out details
    const howFold = box.children[2];
    assert.equal(howFold.tagName, "DETAILS");
  } finally {
    globalThis.document = prevDoc;
  }
});
