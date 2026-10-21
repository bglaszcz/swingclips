// server/tests/spreadtrend.test.js
// Tests for SwingSpreadTrend (server/static/spreadtrend.js):
// - a made-up club that tightens must read tighter
// - one that doesn't change must read the same in at least 95 of 100 seeded runs
// - sessions with fewer than 8 shots are left out
// - render builds small multiples with SVG lines and points

const test = require("node:test");
const assert = require("node:assert/strict");
const ST = require("../static/spreadtrend.js");

function rng(seed) {
  let s = (seed >>> 0) || 42;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function normal(r) {
  let u = 0, v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function makeShot(club, carry, offline) {
  return {
    club,
    carry,
    offline,
    c: { shot: { club, ball: { carry, side: offline } } },
  };
}

function makeSession(key, start, club, nShots, carryMean, carrySd, offMean, offSd, r) {
  const rows = [];
  for (let i = 0; i < nShots; i++) {
    const c = carryMean + carrySd * normal(r);
    const o = offMean + offSd * normal(r);
    rows.push(makeShot(club, c, o));
  }
  return { key, start, rows };
}

test("sessions with fewer than 8 shots are left out of trend points", () => {
  const r = rng(101);
  const sessions = [
    makeSession("s1", 1000, "I7", 5, 150, 4, 0, 8, r), // 5 shots -> skipped
    makeSession("s2", 2000, "I7", 10, 150, 4, 0, 8, r), // 10 shots -> kept
    makeSession("s3", 3000, "I7", 7, 150, 4, 0, 8, r), // 7 shots -> skipped
    makeSession("s4", 4000, "I7", 12, 150, 4, 0, 8, r), // 12 shots -> kept
  ];

  const m = ST.analyze(sessions, { club: "I7" });
  assert.equal(m.sessions.length, 2, "Only 2 sessions qualify with >= 8 shots");
  assert.equal(m.skippedSessions, 2, "2 sessions skipped with < 8 shots");
  assert.equal(m.totalShots, 22, "22 total shots in qualifying sessions");
});

test("a made-up club that tightens must read tighter", () => {
  const r = rng(42);
  const sessions = [];
  // Earlier 3 sessions (wide: offline SD = 14 yd, 15 shots each = 45 shots)
  for (let i = 0; i < 3; i++) {
    sessions.push(makeSession(`s${i}`, 1000 * (i + 1), "I7", 15, 150, 5, 0, 14, r));
  }
  // Latest 3 sessions (tight: offline SD = 4 yd, 15 shots each = 45 shots)
  for (let i = 3; i < 6; i++) {
    sessions.push(makeSession(`s${i}`, 1000 * (i + 1), "I7", 15, 150, 5, 0, 4, r));
  }

  const m = ST.analyze(sessions, { club: "I7", seed: 99 });
  assert.equal(m.verdict, "tighter", `expected 'tighter', got '${m.verdict}'`);
  assert.ok(m.test.p < 0.05, `p-value ${m.test.p} should be < 0.05`);
  assert.ok(m.test.deltaObs < 0, `deltaObs ${m.test.deltaObs} should be negative`);
  assert.ok(m.verdictText.startsWith("Tighter:"), `verdict text '${m.verdictText}' should start with Tighter:`);
});

test("a made-up club that doesn't change must read the same in at least 95 of 100 seeded runs", () => {
  let sameCount = 0;
  for (let run = 1; run <= 100; run++) {
    const r = rng(run * 1000 + 13);
    const sessions = [];
    // 6 sessions all from identical distribution (offline SD = 10 yd, 15 shots each)
    for (let i = 0; i < 6; i++) {
      sessions.push(makeSession(`s${i}`, 1000 * (i + 1), "I7", 15, 150, 5, 0, 10, r));
    }
    const m = ST.analyze(sessions, { club: "I7", seed: run * 333 + 7 });
    if (m.verdict === "about the same") sameCount++;
  }

  assert.ok(sameCount >= 95, `Expected >= 95 of 100 runs to be 'about the same', got ${sameCount}`);
});

test("a club with fewer than 20 shots per side reads 'not enough shots yet'", () => {
  const r = rng(77);
  const sessions = [];
  // 6 sessions with only 8 shots each -> 3 sessions = 24 shots >= 20. But if 6 shots each -> 18 shots < 20
  // Here let's make earlier 3 have 6 shots? But <8 shots are skipped!
  // If we have 5 qualifying sessions of 15 shots:
  for (let i = 0; i < 5; i++) {
    sessions.push(makeSession(`s${i}`, 1000 * (i + 1), "I7", 12, 150, 5, 0, 10, r));
  }
  const m = ST.analyze(sessions, { club: "I7" });
  assert.equal(m.verdict, "not enough shots yet");
  assert.ok(m.verdictText.includes("5 of 6 needed"), `explanation indicates session count: ${m.verdictText}`);
});

test("multi-club analyze and render builds cards, SVGs, polylines, and elements", () => {
  function makeMockDoc() {
    function createEl(tag) {
      return {
        tagName: tag.toUpperCase(),
        attributes: {},
        children: [],
        textContent: "",
        style: {
          setProperty(k, v) { this[k] = v; },
        },
        setAttribute(k, v) { this.attributes[k] = v; },
        getAttribute(k) { return this.attributes[k]; },
        append(...kids) {
          for (const k of kids) {
            if (typeof k === "string") this.children.push({ nodeType: 3, textContent: k });
            else this.children.push(k);
          }
        },
        appendChild(c) { this.children.push(c); return c; },
        replaceChildren(...kids) { this.children = [...kids]; },
      };
    }
    return {
      createElement(tag) { return createEl(tag); },
      createElementNS(ns, tag) { return createEl(tag); },
      createTextNode(txt) { return { nodeType: 3, textContent: txt }; },
    };
  }

  const origDoc = global.document;
  global.document = makeMockDoc();

  const r = rng(88);
  const clubSessions = {
    I7: [
      makeSession("s1", 1000, "I7", 10, 150, 4, 0, 10, r),
      makeSession("s2", 2000, "I7", 10, 150, 4, 0, 8, r),
    ],
    DR: [
      makeSession("s1", 1000, "DR", 4, 240, 8, 0, 15, r), // < 8 shots
    ],
  };

  const model = ST.analyze(clubSessions, { nameOf: c => (c === "I7" ? "7 iron" : "Driver") });
  assert.equal(model.clubs.length, 2);
  const i7 = model.clubs.find(c => c.club === "I7");
  const dr = model.clubs.find(c => c.club === "DR");
  assert.ok(i7 && i7.enough);
  assert.ok(dr && !dr.enough);

  const container = global.document.createElement("div");
  ST.render(container, model, {
    colors: { I7: { slot: 5, alt: false }, DR: { slot: 0, alt: false } },
    hidden: new Set(),
  });

  // Verify elements rendered
  // container has: [head, legend, grid, explain]
  assert.equal(container.children.length, 4, "4 top-level sections in container");
  const grid = container.children[2];
  assert.equal(grid.children.length, 1, "Only I7 has enough shots to render a card");
  const card = grid.children[0];
  assert.equal(card.attributes["data-club"], "I7");

  // Inside card: [chead, verd, svg]
  const cardChildren = card.children;
  assert.ok(cardChildren.length >= 3);
  const svg = cardChildren.find(el => el.tagName === "SVG");
  assert.ok(svg, "SVG chart element rendered");
  assert.equal(svg.attributes["class"], "st-svg");

  // In SVG: grid lines, text labels, polyline, dots
  const polylines = svg.children.filter(el => el.tagName === "POLYLINE");
  assert.equal(polylines.length, 2, "Width line and depth line rendered");
  const circles = svg.children.filter(el => el.tagName === "CIRCLE");
  assert.equal(circles.length, 2, "2 circles for 2 session width points");
  const rects = svg.children.filter(el => el.tagName === "RECT");
  assert.equal(rects.length, 2, "2 rects for 2 session depth points");

  global.document = origDoc;
});
