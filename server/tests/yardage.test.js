// server/tests/yardage.test.js
// Unit tests for SwingYardage (server/static/yardage.js)
const test = require("node:test");
const assert = require("node:assert/strict");
const Y = require("../static/yardage.js");

function makeShot(club, carry, offline, opts = {}) {
  const t = opts.t != null ? opts.t : Date.now();
  const dir = opts.direction != null ? opts.direction : 0;
  return {
    club,
    carry,
    offline,
    direction: dir,
    t,
    apexFt: opts.apexFt,
    landingAngle: opts.landingAngle,
    c: {
      recorded: new Date(t).toISOString(),
      shot: {
        club,
        ball: {
          carry,
          side: offline,
          hla: dir,
          apexFt: opts.apexFt,
          landingAngle: opts.landingAngle,
        },
      },
    },
  };
}

test("empty or invalid input returns empty model", () => {
  const model = Y.build([]);
  assert.equal(model.clubs.length, 0);
  assert.equal(model.totalShots, 0);
  assert.equal(model.overlaps.length, 0);

  const modelNull = Y.build(null);
  assert.equal(modelNull.clubs.length, 0);
});

test("filters unusable shots (carry <= 0 or missing offline)", () => {
  const rows = [
    makeShot("I7", 150, 2),
    makeShot("I7", 0, 5),     // zero carry -> drop
    makeShot("I7", -10, 0),   // negative carry -> drop
    { club: "I7", carry: 155, offline: NaN }, // NaN offline -> drop
  ];
  const model = Y.build(rows);
  assert.equal(model.totalShots, 1);
  assert.equal(model.clubs[0].n, 1);
  assert.equal(model.clubs[0].stockCarry, 150);
});

test("period filtering respects data's latest date", () => {
  const baseT = 1700000000000; // Reference timestamp
  const DAY = 86400000;
  const rows = [
    makeShot("I7", 150, 0, { t: baseT }),              // newest: day 0
    makeShot("I7", 152, 1, { t: baseT - 20 * DAY }),   // day -20: inside 30 & 90
    makeShot("I7", 148, -1, { t: baseT - 60 * DAY }),  // day -60: inside 90, outside 30
    makeShot("I7", 145, 2, { t: baseT - 120 * DAY }),  // day -120: outside 90, inside 365
  ];

  const m30 = Y.build(rows, { period: 30, now: baseT });
  assert.equal(m30.totalShots, 2);

  const m90 = Y.build(rows, { period: 90, now: baseT });
  assert.equal(m90.totalShots, 3);

  const mAll = Y.build(rows, { period: 0, now: baseT });
  assert.equal(mAll.totalShots, 4);
});

test("stock carry, carry window, left/right and centre calculations", () => {
  // 10 shots for 7-iron with known sorted carries and offlines
  const carries = [140, 142, 145, 148, 150, 152, 154, 156, 158, 160];
  const offlines = [-10, -8, -6, -4, -2, 0, 2, 4, 6, 8];
  const rows = carries.map((c, i) => makeShot("I7", c, offlines[i]));

  const model = Y.build(rows, { seed: 42 });
  assert.equal(model.clubs.length, 1);
  const club = model.clubs[0];
  assert.equal(club.club, "I7");
  assert.equal(club.n, 10);
  assert.equal(club.enough, true);

  // Median carry: (150 + 152) / 2 = 151
  assert.equal(club.stockCarry, 151);
  // Carry window middle 80%: 10th percentile to 90th percentile (141.8 to 158.2)
  assert.ok(club.carryLo >= 141 && club.carryLo <= 143);
  assert.ok(club.carryHi >= 157 && club.carryHi <= 159);

  // Centre: (-2 + 0) / 2 = -1 (1 yd left)
  assert.equal(club.centre, -1);
  // Offline window: -8.2 to 6.2
  assert.ok(club.offlineLo >= -9 && club.offlineLo <= -7);
  assert.ok(club.offlineHi >= 5 && club.offlineHi <= 7);
});

test("aim advice: at target when centre is <= 3 yd off line", () => {
  // Centre is +2 yd (right of line, but <= 3 yd)
  const rows = [1, 2, 2, 3, 2, 2, 3].map(off => makeShot("I7", 150, off));
  const model = Y.build(rows, { seed: 42 });
  assert.equal(model.clubs[0].aim.text, "at the target");
  assert.equal(model.clubs[0].aim.leavesOutZero, false);
});

test("aim advice: aims opposite side when centre > 3 yd and CI leaves out zero", () => {
  // Consistent miss left: centre = -6 yd, all shots negative
  const leftOfflines = [-9, -8, -7, -6, -6, -5, -5, -4];
  const rowsLeft = leftOfflines.map(off => makeShot("I7", 150, off));
  const modelLeft = Y.build(rowsLeft, { seed: 1234 });
  const aimLeft = modelLeft.clubs[0].aim;
  assert.equal(aimLeft.leavesOutZero, true);
  assert.equal(aimLeft.direction, "right");
  assert.equal(aimLeft.yards, 6);
  assert.equal(aimLeft.text, "aim 6 yd right");

  // Consistent miss right: centre = +7.5 yd (rounds to 8)
  const rightOfflines = [5, 6, 7, 7, 8, 8, 9, 10];
  const rowsRight = rightOfflines.map(off => makeShot("I8", 140, off));
  const modelRight = Y.build(rowsRight, { seed: 5678 });
  const aimRight = modelRight.clubs[0].aim;
  assert.equal(aimRight.leavesOutZero, true);
  assert.equal(aimRight.direction, "left");
  assert.equal(aimRight.yards, 8);
  assert.equal(aimRight.text, "aim 8 yd left");
});

test("aim advice: at target when variance is wide so 90% CI spans zero", () => {
  // Centre is -4 yd (which is > 3), but high variance spans zero
  const mixedOfflines = [-18, -12, -7, -5, -3, 2, 8, 14];
  const rows = mixedOfflines.map(off => makeShot("I7", 150, off));
  const model = Y.build(rows, { seed: 999 });
  const aim = model.clubs[0].aim;
  assert.equal(aim.leavesOutZero, false);
  assert.equal(aim.text, "at the target");
});

test("usual flight shape requires at least 10 shots", () => {
  // 8 draw shots (< 10 total)
  const rows8 = Array.from({ length: 8 }, () =>
    makeShot("I7", 150, -10, { direction: 0 }) // starts straight (0°), curves left (-10 yd) -> Draw
  );
  const m8 = Y.build(rows8);
  assert.equal(m8.clubs[0].usualShape.text, "");

  // 12 shots: 9 draws and 3 fades
  const rows12 = [
    ...Array.from({ length: 9 }, () => makeShot("I7", 150, -10, { direction: 0 })), // Draw
    ...Array.from({ length: 3 }, () => makeShot("I7", 150, 10, { direction: 0 })),  // Fade
  ];
  const m12 = Y.build(rows12);
  assert.equal(m12.clubs[0].usualShape.name, "Draw");
  assert.equal(m12.clubs[0].usualShape.pct, 75);
  assert.equal(m12.clubs[0].usualShape.text, "Draw (75%)");
});

test("apex and landing angle medians", () => {
  const rows = [
    makeShot("I7", 150, 0, { apexFt: 80, landingAngle: 45 }),
    makeShot("I7", 152, 0, { apexFt: 84, landingAngle: 46 }),
    makeShot("I7", 148, 0, { apexFt: 82, landingAngle: 44 }),
  ];
  const model = Y.build(rows);
  assert.equal(model.clubs[0].apexFt, 82);
  assert.equal(model.clubs[0].landingAngle, 45);

  // Missing apex/landing angle stays null
  const rowsMissing = [
    makeShot("I8", 140, 0),
    makeShot("I8", 142, 0),
  ];
  const modelMissing = Y.build(rowsMissing);
  assert.equal(modelMissing.clubs[0].apexFt, null);
  assert.equal(modelMissing.clubs[0].landingAngle, null);
});

test("overlap detection for neighbouring clubs", () => {
  // Middle halves (25th to 75th percentile, 11 shots: indexes 2.5 and 7.5): 5 iron 140-187, 6 iron 132-177 yd.
  // Overlap: 140 to 177 = 37 yd (> 0.5 * 45 = 22.5 yd) -> overlap flagged.
  const rows5 = [125, 131, 135, 145, 160, 165, 175, 185, 188, 190, 195].map(c => makeShot("I5", c, 0));
  const rows6 = [120, 123, 128, 135, 150, 155, 165, 175, 178, 180, 185].map(c => makeShot("I6", c, 0));
  // 7-iron: cleanly separated window 100 to 110 yd
  const rows7 = [98, 100, 102, 104, 105, 106, 108, 109, 110, 110, 112].map(c => makeShot("I7", c, 0));

  const model = Y.build([...rows5, ...rows6, ...rows7], {
    nameOf: c => (c === "I5" ? "5 iron" : (c === "I6" ? "6 iron" : "7 iron")),
  });

  assert.equal(model.overlaps.length, 1);
  const ov = model.overlaps[0];
  assert.equal(ov.clubA, "I5");
  assert.equal(ov.clubB, "I6");
  assert.match(ov.text, /^Your 5 iron and 6 iron usually land in the same window:/);
  assert.match(ov.text, /140-187/);
  assert.match(ov.text, /132-177 yd/);
});

test("neighbours whose 80% windows overlap but whose middle halves don't aren't flagged", () => {
  // 7 iron 140-170 with its middle half 150-160; 8 iron 130-160 with its middle half 138-146: the 80% windows
  // share 20 yd, the middle halves nothing.
  const rows7 = [138, 141, 149, 151, 154, 155, 156, 159, 161, 169, 172].map(c => makeShot("I7", c, 0));
  const rows8 = [128, 131, 137, 139, 141, 142, 143, 145, 147, 159, 162].map(c => makeShot("I8", c, 0));
  assert.equal(Y.build([...rows7, ...rows8]).overlaps.length, 0);
});

test("DOM rendering creates toolbar, table, rows, overlaps and fold", () => {
  // Minimal DOM mock
  function createMockElement(tag, cls = "") {
    return {
      tagName: tag.toUpperCase(),
      className: cls,
      children: [],
      childNodes: [],
      textContent: "",
      style: {
        setProperty(k, v) { this[k] = v; },
      },
      appendChild(child) {
        this.children.push(child);
        this.childNodes.push(child);
        return child;
      },
      append(...items) {
        for (const item of items) {
          if (typeof item === "string") this.appendChild({ textContent: item, nodeType: 3 });
          else this.appendChild(item);
        }
      },
      replaceChildren(...items) {
        this.children = [];
        this.childNodes = [];
        this.append(...items);
      },
      addEventListener() {},
    };
  }

  global.document = {
    createElement: (tag) => createMockElement(tag),
    createTextNode: (txt) => ({ textContent: txt, nodeType: 3 }),
  };

  const rows = [
    ...[131, 135, 145, 160, 165, 175, 185, 190].map(c => makeShot("I5", c, 0)),
    ...[123, 128, 135, 150, 155, 165, 175, 180].map(c => makeShot("I6", c, 0)),
  ];

  const model = Y.build(rows, {
    nameOf: c => (c === "I5" ? "5 iron" : "6 iron"),
  });

  const box = createMockElement("div");
  Y.render(box, model);

  // Verify structure
  const toolbar = box.children.find(c => c.className === "y-toolbar");
  assert.ok(toolbar, "Toolbar should exist");

  const tableWrap = box.children.find(c => c.className === "y-table-wrap");
  assert.ok(tableWrap, "Table wrap should exist");

  const table = tableWrap.children.find(c => c.tagName === "TABLE");
  assert.ok(table, "Table should exist");

  const thead = table.children.find(c => c.tagName === "THEAD");
  assert.ok(thead, "Table header should exist");
  const ths = thead.children[0].children;
  assert.equal(ths.length, 10, "Should have 10 table headers");

  const tbody = table.children.find(c => c.tagName === "TBODY");
  assert.equal(tbody.children.length, 2, "Should have 2 club rows");

  const overlaps = box.children.find(c => c.className === "y-overlaps");
  assert.ok(overlaps, "Overlaps container should exist");
  assert.equal(overlaps.children.length, 1, "Should have 1 overlap item");

  const fold = box.children.find(c => c.tagName === "DETAILS");
  assert.ok(fold, "Fold details should exist");
});
