const test = require("node:test");
const assert = require("node:assert/strict");

const M = require("../static/metrics3d.js");

function makeDoc(options = {}) {
  const frames = [];
  // 60 frames from t = 0.5 to t = 1.975 (dt = 0.025 s)
  for (let i = 0; i < 60; i++) {
    const t = 0.5 + i * 0.025;
    const isSetup = t <= 1.2; // setup window up to takeaway=1.2
    const p = Array(33).fill(null);
    if (!(options.noPointsBeforeTakeaway && t <= 1.2)) {
      for (const [id] of M.CORE_JOINTS) {
        if (isSetup && options.missingAtSetup && options.missingAtSetup.includes(id)) {
          continue; // left missing during setup
        }
        p[id] = [0.0, 1.0, 0.0];
      }
      if (p[23] && p[24]) {
        p[23] = [-0.15, 0.95, 0.0];
        p[24] = [0.15, 0.95, 0.0];
      }
      if (p[11] && p[12]) {
        p[11] = [-0.2, 1.4, 0.0];
        p[12] = [0.2, 1.4, 0.0];
      }
    }
    frames.push({ t, p });
  }
  return {
    session: "test-session",
    reprojection: {
      face: { median: 1.5, p90: 3.0 },
      dtl: { median: 1.4, p90: 2.8 },
      address: { median: 2.1, p90: 5.4 },
    },
    boneSpreadPct: 3.5,
    offset: 0.05,
    offsetImpact: 0.05,
    frames,
  };
}

const POSITIONS = [
  { key: "p1", t: 1.0 },
  { key: "takeaway", t: 1.2 },
  { key: "p4", t: 1.6 },
  { key: "p7", t: 1.8 },
];

test("lead shoulder missing at setup but present later: missing has it and shoulder rows are named", () => {
  const doc = makeDoc({ missingAtSetup: [11] }); // 11 is lead shoulder
  const r = M.compute(doc, POSITIONS);
  assert.ok(r, "compute returned result");
  assert.ok(r.setup, "setup property returned");
  assert.deepEqual(r.setup.missing, ["lead shoulder"]);
  assert.ok(r.setup.frames > 0, "setup frames counted");

  // Blanked rows mapping check
  const blanked = M.blankedRows(r.setup.missing);
  assert.ok(blanked.includes("thoraxTurn"), "blanks thoraxTurn");
  assert.ok(blanked.includes("thoraxSideBend"), "blanks thoraxSideBend");
  assert.ok(blanked.includes("thoraxBend"), "blanks thoraxBend");
  assert.ok(blanked.includes("thoraxSway"), "blanks thoraxSway");
  assert.ok(blanked.includes("separation"), "blanks separation");
  assert.equal(blanked.includes("pelvisTurn"), false, "does not blank pelvisTurn");
  assert.equal(blanked.includes("pelvisSway"), false, "does not blank pelvisSway");

  // Labels also named
  const labels = M.blankedRowLabels(r.setup.missing);
  assert.ok(labels.includes("Shoulder turn"));
  assert.ok(labels.includes("Shoulder tilt"));
  assert.ok(labels.includes("Chest bend toward the ball"));
  assert.ok(labels.includes("Chest slide"));
  assert.ok(labels.includes("Shoulders turned past the hips"));
  assert.equal(labels.includes("Hip turn"), false);
});

test("nothing missing at setup: missing is empty", () => {
  const doc = makeDoc({});
  const r = M.compute(doc, POSITIONS);
  assert.ok(r, "compute returned result");
  assert.ok(r.setup, "setup property returned");
  assert.deepEqual(r.setup.missing, []);
  assert.ok(r.setup.frames > 0, "setup frames counted");
  assert.deepEqual(M.blankedRows(r.setup.missing), []);
});

test("no 3D before takeaway at all: every core joint listed", () => {
  const doc = makeDoc({ noPointsBeforeTakeaway: true });
  const r = M.compute(doc, POSITIONS);
  assert.ok(r, "compute returned result");
  assert.ok(r.setup, "setup property returned");
  assert.equal(r.setup.missing.length, M.CORE_JOINTS.length, "every core joint listed in missing");
  for (const [, name] of M.CORE_JOINTS) {
    assert.ok(r.setup.missing.includes(name), `missing includes ${name}`);
  }
});

test("no takeaway position in positions: setup window ends at p1 + 0.1 s", () => {
  const positionsNoTakeaway = [
    { key: "p1", t: 1.0 },
    { key: "p4", t: 1.6 },
    { key: "p7", t: 1.8 },
  ];
  const doc = makeDoc({ missingAtSetup: [12] }); // 12 is trail shoulder
  const r = M.compute(doc, positionsNoTakeaway);
  assert.ok(r);
  assert.deepEqual(r.setup.missing, ["trail shoulder"]);
});

test("blanked rows small table: hips blank hip rows, shoulders blank shoulder rows", () => {
  assert.ok(M.SETUP_BLANKS["lead shoulder"].includes("thoraxTurn"));
  assert.ok(M.SETUP_BLANKS["trail shoulder"].includes("thoraxSideBend"));
  assert.ok(M.SETUP_BLANKS["lead hip"].includes("pelvisTurn"));
  assert.ok(M.SETUP_BLANKS["trail hip"].includes("pelvisSway"));
  assert.ok(M.SETUP_BLANKS["lead hip"].includes("separation"));
  assert.ok(M.SETUP_BLANKS["lead shoulder"].includes("separation"));

  // Elbows, wrists, knees, ankles do not blank table rows
  assert.deepEqual(M.SETUP_BLANKS["lead elbow"], []);
  assert.deepEqual(M.SETUP_BLANKS["trail wrist"], []);
  assert.deepEqual(M.SETUP_BLANKS["lead knee"], []);
  assert.deepEqual(M.SETUP_BLANKS["trail ankle"], []);
});

test("summarize3d passes through setupMissing and addressError", () => {
  global.SwingSummary = require("../static/summary.js");
  const doc = makeDoc({ missingAtSetup: [11] });
  // Make synthetic pose inputs
  const faceInput = {
    name: "swing_face.mp4",
    aspect: 16 / 9,
    rotation: 0,
    frames: doc.frames.map(f => ({ t: f.t, lm: [[0, 0], [0, 0]] })),
    impact: 1.8,
    strike: 1.8,
  };
  const dtlInput = {
    name: "swing_dtl.mp4",
    aspect: 16 / 9,
    rotation: 0,
    frames: doc.frames.map(f => ({ t: f.t, lm: [[0, 0], [0, 0]] })),
    impact: 1.8,
    strike: 1.8,
  };
  const s = M.summarize3d(faceInput, dtlInput, "left", doc, "I7");
  assert.ok(s);
  assert.deepEqual(s.setupMissing, ["lead shoulder"]);
  assert.deepEqual(s.addressError, { median: 2.1, p90: 5.4 });
});

