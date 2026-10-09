const test = require("node:test");
const assert = require("node:assert");

const Scorecard = require("../static/scorecard.js");
const Summary = require("../static/summary.js");
const Faults = require("../static/faults.js");

// Mock global objects that scorecard.js might need via root if not running with require
globalThis.SwingSummary = Summary;
globalThis.SwingFaults = Faults;

test("buildScorecard handles missing ranges and empty faults", () => {
  const positions = [
    { key: "p1", tag: "address", label: "Address", index: 0, t: 0, estimated: false },
    { key: "p4", tag: "top", label: "Top", index: 10, t: 0.5, estimated: false },
  ];
  const body = { shoulderTop: 90, tempo: 3.0 };
  const trust = { shoulderTop: { level: "ok" }, tempo: { level: "ok" } };
  const goodRanges = {};
  const swingFaults = [];

  const res = Scorecard.buildScorecard(positions, body, trust, goodRanges, swingFaults);
  
  assert.strictEqual(res.phases.length, 2);
  assert.strictEqual(res.phases[0].key, "p1");
  assert.strictEqual(res.phases[0].color, "grey"); // no metrics for p1
  
  assert.strictEqual(res.phases[1].key, "p4");
  assert.strictEqual(res.phases[1].color, "grey"); // no ranges -> grey
  
  assert.strictEqual(res.faults.length, 0);
  assert.strictEqual(res.summarySentence, "Not enough good shots yet to show a trend.");
});

test("buildScorecard maps metrics and sets colors based on ranges", () => {
  const positions = [
    { key: "p4", index: 10, t: 0.5 }
  ];
  const body = { shoulderTop: 90 };
  const trust = { shoulderTop: { level: "ok" } };
  const goodRanges = {
    shoulderTop: { q10: 80, q25: 85, q75: 95, q90: 100, reliable: true, enough: true }
  };
  const swingFaults = [];

  // Should be 'in' -> green
  const res1 = Scorecard.buildScorecard(positions, body, trust, goodRanges, swingFaults);
  assert.strictEqual(res1.phases[0].color, "green");
  assert.strictEqual(res1.nInside, 1);
  assert.strictEqual(res1.nTotal, 1);
  assert.match(res1.summarySentence, /shoulder turn at the top of swing is in your good range/i);

  // Amber (wide)
  const body2 = { shoulderTop: 98 };
  const res2 = Scorecard.buildScorecard(positions, body2, trust, goodRanges, swingFaults);
  assert.strictEqual(res2.phases[0].color, "amber");

  // Red (outside)
  const body3 = { shoulderTop: 105 };
  const res3 = Scorecard.buildScorecard(positions, body3, trust, goodRanges, swingFaults);
  assert.strictEqual(res3.phases[0].color, "red");
  
  // Grey (shaky)
  const trustShaky = { shoulderTop: { level: "shaky" } };
  const res4 = Scorecard.buildScorecard(positions, body, trustShaky, goodRanges, swingFaults);
  assert.strictEqual(res4.phases[0].color, "grey");
});

test("buildScorecard sets faults correctly", () => {
  const positions = [{ key: "p7", index: 20, t: 1.0 }];
  const body = { earlyExt: 5 };
  const trust = { earlyExt: { level: "ok" } };
  const goodRanges = {};
  const swingFaults = [{
    key: "earlyExt",
    name: "early extension",
    value: 5,
    drill: "Wall drill",
    thought: "Keep back"
  }];

  const res = Scorecard.buildScorecard(positions, body, trust, goodRanges, swingFaults);
  
  assert.strictEqual(res.faults.length, 1);
  assert.strictEqual(res.faults[0].phase, "p7");
  
  assert.strictEqual(res.faults[0].severity, 2);
  
  assert.match(res.summarySentence, /Main thing: early extension/i);
});

const range = (q25, q75) => ({ q10: q25 - 5, q25, q75, q90: q75 + 5, reliable: true, enough: true });

test("summary: names the best number with its capitals, and only says solid when most numbers are inside", () => {
  const positions = [{ key: "p4", index: 10, t: 0.5 }, { key: "p5", index: 12, t: 0.6 }];
  const ok = { level: "ok" };
  // One number inside, one well outside: not "a very solid swing".
  let res = Scorecard.buildScorecard(positions, { shoulderTop: 90, lagP5: 10 }, { shoulderTop: ok, lagP5: ok },
    { shoulderTop: range(85, 95), lagP5: range(60, 70) }, []);
  assert.strictEqual(res.nInside, 1);
  assert.strictEqual(res.summarySentence, "Best: shoulder turn at the top of swing is in your good range.");
  // Both inside: solid, and downswing keeps its wording.
  res = Scorecard.buildScorecard(positions, { shoulderTop: 90, lagP5: 65 }, { shoulderTop: ok, lagP5: ok },
    { shoulderTop: range(85, 95), lagP5: range(60, 70) }, []);
  assert.strictEqual(res.summarySentence, "Best: shoulder turn at the top of swing is in your good range. A very solid swing.");
  res = Scorecard.buildScorecard([{ key: "p5", index: 12, t: 0.6 }], { lagP5: 65 }, { lagP5: ok }, { lagP5: range(60, 70) }, []);
  assert.match(res.summarySentence, /wrist hinge early in the downswing/);
});

test("shaky and unreadable numbers are grey and never count as inside or outside", () => {
  const positions = [{ key: "p7", index: 20, t: 0.9 }];
  const res = Scorecard.buildScorecard(positions, { earlyExt: 9, hipSway: null },
    { earlyExt: { level: "shaky" }, hipSway: { level: "none" } }, { earlyExt: range(0, 2) }, []);
  assert.strictEqual(res.phases[0].color, "grey");
  assert.strictEqual(res.nTotal, 0);
  assert.strictEqual(res.nInside, 0);
});

test("faults get a phase, a severity from the distance past the threshold, and are sorted worst first", () => {
  const positions = [{ key: "p6", index: 15, t: 0.8 }, { key: "p7", index: 20, t: 0.9 }];
  const faults = Faults.faultsOf({ earlyExt: 3.5, handsPlaneP6: 12, trust: {} });
  const res = Scorecard.buildScorecard(positions, {}, {}, {}, faults);
  assert.deepStrictEqual(res.faults.map(f => f.key), ["handsPlaneP6", "earlyExt"]);
  assert.strictEqual(res.faults[0].phase, "p6");
  assert.strictEqual(res.faults[1].phase, "p7");
  assert.ok(res.faults[0].severity > res.faults[1].severity);
  assert.ok(res.faults.every(f => f.severity >= 1 && f.severity <= 3));
});

test("faults receive linkNote when a strong link matches another fault on this swing", () => {
  const positions = [{ key: "p6", index: 15, t: 0.8 }, { key: "p7", index: 20, t: 0.9 }];
  const faults = [
    { key: "releaseArm", name: "casting", value: -15 },
    { key: "earlyExt", name: "early extension", value: 4.5 },
  ];
  const strongLinks = [
    { a: { name: "casting" }, b: { name: "early extension" }, label: "Strong" },
  ];
  const res = Scorecard.buildScorecard(positions, {}, {}, {}, faults, strongLinks);
  const casting = res.faults.find(f => f.name === "casting");
  const ee = res.faults.find(f => f.name === "early extension");
  assert.strictEqual(casting.linkNote, "Often comes with early extension");
  assert.strictEqual(ee.linkNote, "Often comes with casting");
});

test("faultSeverity: normal severity tiers (1, 2, 3) and edge cases with null/missing values", () => {
  const fDef = { threshold: 10 };
  // Normal tiers
  assert.strictEqual(Scorecard.faultSeverity(fDef, 12), 1); // diff = 2 <= 5 -> 1
  assert.strictEqual(Scorecard.faultSeverity(fDef, 16), 2); // diff = 6 > 5 -> 2
  assert.strictEqual(Scorecard.faultSeverity(fDef, 25), 3); // diff = 15 > 10 -> 3

  // Zero threshold falls back to scale 10
  const zeroDef = { threshold: 0 };
  assert.strictEqual(Scorecard.faultSeverity(zeroDef, 2), 1);  // diff = 2 <= 5 -> 1
  assert.strictEqual(Scorecard.faultSeverity(zeroDef, 6), 2);  // diff = 6 > 5 -> 2
  assert.strictEqual(Scorecard.faultSeverity(zeroDef, 12), 3); // diff = 12 > 10 -> 3

  // Edge cases: null, undefined, NaN, non-number value safely return 1
  assert.strictEqual(Scorecard.faultSeverity(fDef, null), 1);
  assert.strictEqual(Scorecard.faultSeverity(fDef, undefined), 1);
  assert.strictEqual(Scorecard.faultSeverity(fDef, NaN), 1);
  assert.strictEqual(Scorecard.faultSeverity(fDef, "15"), 1);

  // Missing or invalid faultDef returns 1
  assert.strictEqual(Scorecard.faultSeverity(null, 15), 1);
  assert.strictEqual(Scorecard.faultSeverity({}, 15), 1);
  assert.strictEqual(Scorecard.faultSeverity({ threshold: null }, 15), 1);
});
