const test = require("node:test");
const assert = require("node:assert");

// Mock dependencies
globalThis.SwingSummary = {
  BODY: [
    { key: "tempo", label: "Tempo", unit: ":1" },
    { key: "shoulderTop", label: "Shoulder turn", unit: "°" },
    { key: "earlyExt", label: "Hips to ball", unit: "in" },
    { key: "lagP5", label: "Lag at P5", unit: "°" }
  ]
};

globalThis.SwingFaults = {
  FAULTS: [
    { key: "earlyExt", threshold: 3, dir: "more" }
  ],
  faultsOf: (record, shaky) => {
    const out = [];
    if (record.body.earlyExt > 3 && !shaky({ shown: record.body }, "earlyExt")) {
      out.push({ key: "earlyExt", name: "early extension", value: record.body.earlyExt });
    }
    return out;
  }
};

globalThis.SwingGoodShots = {
  place: (val, range, unit) => {
    if (!range) return { status: "few" };
    if (val >= range.q10 && val <= range.q90) {
      if (val >= range.q25 && val <= range.q75) return { status: "in", wide: true };
      return { status: "above", wide: true }; // simplification for mock
    }
    return { status: "above", wide: false };
  }
};

globalThis.SwingTrust = {
  factsOf: () => ({ measured: true }),
  judge: (f, facts, val, table) => {
    if (val == null) return { level: "none" };
    if (val === -999) return { level: "shaky" };
    return { level: "ok" };
  }
};

const Scorecard = require("../static/scorecard.js");

test("buildScorecard - normal swing", () => {
  const swingData = {
    record: {
      body: {
        tempo: 3.1,
        shoulderTop: 90,
        lagP5: 60,
        earlyExt: 4
      }
    },
    positions: [
      { key: "p1", t: 1.0, index: 30 },
      { key: "p4", t: 1.5, index: 45 },
      { key: "p7", t: 1.8, index: 54 }
    ]
  };
  swingData.positions.takeaway = { t: 1.1 };

  const goodRanges = {
    tempo: { q10: 2.8, q25: 2.9, q50: 3.0, q75: 3.2, q90: 3.3, enough: true },
    shoulderTop: { q10: 80, q25: 85, q50: 88, q75: 92, q90: 95, enough: true },
    lagP5: { q10: 40, q25: 45, q50: 50, q75: 55, q90: 60, enough: true },
    earlyExt: { q10: 0, q25: 0.5, q50: 1.0, q75: 1.5, q90: 2.0, enough: true }
  };

  const res = Scorecard.buildScorecard(swingData, goodRanges, null);
  
  assert.strictEqual(res.nTotal, 3);
  assert.ok(res.nInside > 0);
  
  const impactPhase = res.phases.find(p => p.key === "p7");
  assert.ok(impactPhase);
  assert.strictEqual(impactPhase.color, "red"); // earlyExt is outside 90th percentile (4 vs 2)
  
  const fault = res.faults[0];
  assert.ok(fault);
  assert.strictEqual(fault.key, "earlyExt");
  assert.strictEqual(fault.phase, "p7");
});

test("buildScorecard - missing phases and shaky numbers", () => {
  const swingData = {
    record: {
      body: {
        tempo: -999, // shaky
      }
    },
    positions: [
      { key: "p1", t: 1.0, index: 30 }
    ]
  };

  const res = Scorecard.buildScorecard(swingData, {}, null);
  const p1 = res.phases.find(p => p.key === "p1");
  
  assert.strictEqual(p1.color, "grey"); // because tempo is shaky
  assert.strictEqual(res.nTotal, 0);
});
