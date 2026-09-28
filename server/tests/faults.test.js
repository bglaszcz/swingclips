// Named swing faults (static/faults.js): pure functions faultsOf and sessionFaults.
//
//   cd server && node --test tests/faults.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const Coach = require("../static/coach.js");
const Faults = require("../static/faults.js");

test("names, drills and swing thoughts come from coach.js", () => {
  assert.equal(Faults.FAULTS.length, 7);

  const expected = [
    { key: "earlyExt", name: "early extension", move: "earlyExt", dir: "more" },
    { key: "bendLoss", name: "standing up", move: "bendLoss", dir: "less" },
    { key: "handsPlaneP6", name: "over the top", move: "handsPlaneP6", dir: "more" },
    { key: "headToBall", name: "head toward the ball", move: "headToBall", dir: "more" },
    { key: "hipSway", name: "hip slide", move: "hipSway", dir: "less" },
    { key: "headRise", name: "head dip", move: "headRise", dir: "less" },
    { key: "headRise", name: "head lift", move: "headRise", dir: "more" },
  ];

  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i];
    const f = Faults.FAULTS[i];
    assert.equal(f.key, exp.key);
    assert.equal(f.name, exp.name);
    assert.equal(f.move, exp.move);
    assert.equal(f.dir, exp.dir);

    const ce = Coach.MOVES[exp.move][exp.dir];
    assert.ok(ce, `${exp.move}.${exp.dir}`);
    assert.ok(ce.drill, `${exp.move}.${exp.dir} drill`);
    assert.ok(ce.thought, `${exp.move}.${exp.dir} thought`);

    // In a swing row with this fault
    const testVal = f.test(f.threshold + 1) ? f.threshold + 1 : f.threshold - 1;
    const testRow = { [exp.key]: testVal };
    const faults = Faults.faultsOf(testRow);
    const match = faults.find(item => item.name === exp.name);
    assert.ok(match, `fault ${exp.name} named`);
    assert.equal(match.drill, ce.drill);
    assert.equal(match.thought, ce.thought);
  }
});

test("each threshold's edge: just inside vs just past", () => {
  // Early extension: earlyExt > 3
  assert.equal(Faults.faultsOf({ earlyExt: 3 }).length, 0);
  assert.equal(Faults.faultsOf({ earlyExt: 2.99 }).length, 0);
  const ee = Faults.faultsOf({ earlyExt: 3.01 });
  assert.equal(ee.length, 1);
  assert.equal(ee[0].name, "early extension");
  assert.equal(ee[0].value, 3.01);

  // Standing up: bendLoss < -10
  assert.equal(Faults.faultsOf({ bendLoss: -10.0 }).length, 0);
  assert.equal(Faults.faultsOf({ bendLoss: -9.99 }).length, 0);
  const su = Faults.faultsOf({ bendLoss: -10.01 });
  assert.equal(su.length, 1);
  assert.equal(su[0].name, "standing up");
  assert.equal(su[0].value, -10.01);

  // Over the top: handsPlaneP6 > 5
  assert.equal(Faults.faultsOf({ handsPlaneP6: 5.0 }).length, 0);
  assert.equal(Faults.faultsOf({ handsPlaneP6: 4.99 }).length, 0);
  const ott = Faults.faultsOf({ handsPlaneP6: 5.01 });
  assert.equal(ott.length, 1);
  assert.equal(ott[0].name, "over the top");
  assert.equal(ott[0].value, 5.01);

  // Head toward the ball: headToBall > 1
  assert.equal(Faults.faultsOf({ headToBall: 1.0 }).length, 0);
  assert.equal(Faults.faultsOf({ headToBall: 0.99 }).length, 0);
  const htb = Faults.faultsOf({ headToBall: 1.01 });
  assert.equal(htb.length, 1);
  assert.equal(htb[0].name, "head toward the ball");
  assert.equal(htb[0].value, 1.01);

  // Hip slide: hipSway > 5.5
  assert.equal(Faults.faultsOf({ hipSway: 5.5 }).length, 0);
  assert.equal(Faults.faultsOf({ hipSway: 5.49 }).length, 0);
  const hs = Faults.faultsOf({ hipSway: 5.51 });
  assert.equal(hs.length, 1);
  assert.equal(hs[0].name, "hip slide");
  assert.equal(hs[0].value, 5.51);

  // Head dip: headRise < -1.5
  assert.equal(Faults.faultsOf({ headRise: -1.5 }).length, 0);
  assert.equal(Faults.faultsOf({ headRise: -1.49 }).length, 0);
  const hd = Faults.faultsOf({ headRise: -1.51 });
  assert.equal(hd.length, 1);
  assert.equal(hd[0].name, "head dip");
  assert.equal(hd[0].value, -1.51);

  // Head lift: headRise > 1.0
  assert.equal(Faults.faultsOf({ headRise: 1.0 }).length, 0);
  assert.equal(Faults.faultsOf({ headRise: 0.99 }).length, 0);
  const hl = Faults.faultsOf({ headRise: 1.01 });
  assert.equal(hl.length, 1);
  assert.equal(hl[0].name, "head lift");
  assert.equal(hl[0].value, 1.01);
});

test("dip and lift split for headRise", () => {
  // Head drop past -1.5 -> head dip only
  const dip = Faults.faultsOf({ headRise: -2.0 });
  assert.equal(dip.length, 1);
  assert.equal(dip[0].name, "head dip");
  assert.equal(dip[0].drill, Coach.MOVES.headRise.less.drill);
  assert.equal(dip[0].thought, Coach.MOVES.headRise.less.thought);

  // Head rise past 1.0 -> head lift only
  const lift = Faults.faultsOf({ headRise: 2.0 });
  assert.equal(lift.length, 1);
  assert.equal(lift[0].name, "head lift");
  assert.equal(lift[0].drill, Coach.MOVES.headRise.more.drill);
  assert.equal(lift[0].thought, Coach.MOVES.headRise.more.thought);

  // Neutral head rise (e.g. 0.0) -> neither
  assert.equal(Faults.faultsOf({ headRise: 0.0 }).length, 0);
});

test("shaky and missing numbers are never named", () => {
  // Missing / non-finite
  assert.deepEqual(Faults.faultsOf({}), []);
  assert.deepEqual(Faults.faultsOf({ earlyExt: null }), []);
  assert.deepEqual(Faults.faultsOf({ earlyExt: undefined }), []);
  assert.deepEqual(Faults.faultsOf({ earlyExt: NaN }), []);
  assert.deepEqual(Faults.faultsOf({ earlyExt: "3.5" }), []); // non-numeric type

  // trust level none
  const noReadRow = {
    earlyExt: 3.5,
    trust: { earlyExt: { level: "none", text: "partly out of picture" } },
  };
  assert.deepEqual(Faults.faultsOf(noReadRow), []);

  // Shaky via callback
  const faultRow = { earlyExt: 3.5, bendLoss: -11 };
  const shakyAll = () => true;
  assert.deepEqual(Faults.faultsOf(faultRow, shakyAll), []);

  const shakyEarlyExt = (r, k) => k === "earlyExt";
  const partial = Faults.faultsOf(faultRow, shakyEarlyExt);
  assert.equal(partial.length, 1);
  assert.equal(partial[0].name, "standing up");

  // Shaky via trust object on row without callback
  const shakyTrustRow = {
    earlyExt: 3.5,
    trust: { earlyExt: { level: "shaky", text: "noisy" } },
  };
  assert.deepEqual(Faults.faultsOf(shakyTrustRow), []);

  // Shaky in sessionFaults: not counted in total or count
  const rows = [
    { earlyExt: 3.5 }, // fault
    { earlyExt: 3.5 }, // fault
    { earlyExt: 3.5 }, // fault
    { earlyExt: 3.5 }, // shaky -> ignored
    { earlyExt: null }, // missing -> ignored
    { earlyExt: 1.0 }, // ok, no fault
  ];
  const isShaky = (r, k) => r === rows[3];
  const sf = Faults.sessionFaults(rows, isShaky);
  const ee = sf.find(f => f.key === "earlyExt");
  assert.equal(ee.count, 3);
  assert.equal(ee.total, 4); // 3 faults + 1 ok = 4 readable
  assert.equal(ee.readable, 4);
  assert.equal(ee.share, 3 / 4);
  assert.equal(ee.top, true);
});

test("sessionFaults top rule: at least 3 swings and 25% of readable ones", () => {
  // Exactly 3 swings out of 12 (25%) -> top
  const rows12 = [];
  for (let i = 0; i < 3; i++) rows12.push({ earlyExt: 3.5 });
  for (let i = 0; i < 9; i++) rows12.push({ earlyExt: 1.0 });
  const sf12 = Faults.sessionFaults(rows12);
  const ee12 = sf12.find(f => f.name === "early extension");
  assert.equal(ee12.count, 3);
  assert.equal(ee12.total, 12);
  assert.equal(ee12.share, 0.25);
  assert.equal(ee12.top, true);

  // 2 swings out of 4 (50%) -> share >= 25%, but count < 3 -> not top
  const rows4 = [{ earlyExt: 3.5 }, { earlyExt: 3.5 }, { earlyExt: 1.0 }, { earlyExt: 1.0 }];
  const sf4 = Faults.sessionFaults(rows4);
  const ee4 = sf4.find(f => f.name === "early extension");
  assert.equal(ee4.count, 2);
  assert.equal(ee4.total, 4);
  assert.equal(ee4.share, 0.5);
  assert.equal(ee4.top, false);

  // 3 swings out of 13 (23.08%) -> count >= 3, but share < 25% -> not top
  const rows13 = [];
  for (let i = 0; i < 3; i++) rows13.push({ earlyExt: 3.5 });
  for (let i = 0; i < 10; i++) rows13.push({ earlyExt: 1.0 });
  const sf13 = Faults.sessionFaults(rows13);
  const ee13 = sf13.find(f => f.name === "early extension");
  assert.equal(ee13.count, 3);
  assert.equal(ee13.total, 13);
  assert.ok(ee13.share < 0.25);
  assert.equal(ee13.top, false);

  // Sorted by share descending
  const mixedRows = [];
  // 12 of 21 early extension (57.1%)
  for (let i = 0; i < 12; i++) mixedRows.push({ earlyExt: 3.5, bendLoss: -11 });
  // 9 of 21 standing up (42.9%)
  // remaining 9 swings have no standing up
  for (let i = 0; i < 9; i++) mixedRows.push({ earlyExt: 1.0, bendLoss: 0 });

  const mixedSf = Faults.sessionFaults(mixedRows);
  const topList = mixedSf.filter(f => f.top);
  assert.equal(topList.length, 2);
  assert.equal(topList[0].name, "early extension");
  assert.equal(topList[0].count, 12);
  assert.equal(topList[0].total, 21);
  assert.equal(topList[1].name, "standing up");
  assert.equal(topList[1].count, 12); // from the first 12
  assert.equal(topList[1].total, 21);
});

test("faultsOf returns multiple faults with thought and drill", () => {
  const row = {
    earlyExt: 3.2,
    bendLoss: -11,
    handsPlaneP6: 6.5,
    headToBall: 1.5,
    hipSway: 6.0,
    headRise: -2.0,
  };
  const list = Faults.faultsOf(row);
  assert.equal(list.length, 6);
  assert.deepEqual(list.map(f => f.name), [
    "early extension",
    "standing up",
    "over the top",
    "head toward the ball",
    "hip slide",
    "head dip",
  ]);
  for (const f of list) {
    assert.ok(f.key);
    assert.ok(f.name);
    assert.ok(typeof f.value === "number");
    assert.ok(f.drill.length > 0);
    assert.ok(f.thought.length > 0);
  }
});
