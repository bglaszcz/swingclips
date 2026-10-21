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

test("View3D.setupExplanation gives plain words without P-numbers", () => {
  global.SwingMetrics3D = M;
  require("../static/view3d.js");
  const V = global.View3D;
  assert.ok(V);

  // Single missing joint: lead shoulder
  const shoulderExp = V.setupExplanation(["lead shoulder"]);
  assert.equal(
    shoulderExp,
    "The lead shoulder wasn't seen by both cameras at setup, so shoulder turn, tilt and the chest can't be measured on this swing (the cameras' calibration is off by more than 15 px there). The swing order below is from the downswing and still holds."
  );
  assert.equal(/P[1-8]/i.test(shoulderExp), false, "no P-numbers in shoulder explanation");

  // Single missing joint: lead hip
  const hipExp = V.setupExplanation(["lead hip"]);
  assert.equal(
    hipExp,
    "The lead hip wasn't seen by both cameras at setup, so hip turn, tilt and slides can't be measured on this swing (the cameras' calibration is off by more than 15 px there). The swing order below is from the downswing and still holds."
  );
  assert.equal(/P[1-8]/i.test(hipExp), false, "no P-numbers in hip explanation");

  // All core joints missing (nothing at all seen before swing)
  const allCore = M.CORE_JOINTS.map(([, name]) => name);
  const noneExp = V.setupExplanation(allCore);
  assert.ok(noneExp.startsWith("No 3D at setup on this swing:"));
  assert.equal(/P[1-8]/i.test(noneExp), false, "no P-numbers in none explanation");

  // Empty missing returns null
  assert.equal(V.setupExplanation([]), null);
});

test("View3D.firstBodyTime finds first frame with triangulated bones", () => {
  global.SwingMetrics3D = M;
  require("../static/view3d.js");
  const V = global.View3D;

  const doc = makeDoc({ noPointsBeforeTakeaway: true });
  const t0 = V.firstBodyTime(doc);
  assert.ok(t0 > 1.2, `first body frame is after takeaway (got ${t0})`);
  assert.equal(typeof t0, "number");
});



test("smoothSpeeds: a one-frame glitch and the readings next to a tracking gap don't make a peak", () => {
  // 240 fps, a steady 500 deg/s with a one-frame 2000 glitch at frame 20, then the reading jumps to 1500
  // on the 2 frames before tracking is lost (frames 60-79), as the clubhead blurring away did on Oct 8.
  const ts = [], v = [];
  for (let i = 0; i < 120; i++) {
    ts.push(i / 240);
    v.push(i >= 60 && i < 80 ? null : i === 20 ? 2000 : i === 58 || i === 59 ? 1500 : 500);
  }
  const s = M.smoothSpeeds(v, ts);
  assert.ok(Math.max(...s.filter(x => x != null)) < 520, "no peak from the glitch or the gap edge");
  assert.equal(s[58], null);   // dropped next to the gap
  assert.equal(s[70], null);   // the gap isn't filled
  assert.ok(Math.abs(s[40] - 500) < 1);
});

test("address dropout: single frame missing hip at exact P1 does not blank pelvisTurn or pelvisSway", () => {
  const doc = makeDoc({});
  // Corrupt only the single frame nearest P1 (t = 1.0)
  const p1Frame = doc.frames.find(f => Math.abs(f.t - 1.0) < 0.01);
  assert.ok(p1Frame, "found p1 frame");
  p1Frame.p[23] = null; // drop lead hip at P1 only

  const r = M.compute(doc, POSITIONS);
  assert.ok(r, "compute returned result");
  // With robust address fallback, subsequent frames still have valid pelvisTurn and pelvisSway
  const laterFrames = r.values.filter(v => v.t > 1.2);
  const turns = laterFrames.map(v => v.pelvisTurn).filter(x => x != null);
  const sways = laterFrames.map(v => v.pelvisSway).filter(x => x != null);
  assert.ok(turns.length > 0, "pelvisTurn is not blanked for entire swing");
  assert.ok(sways.length > 0, "pelvisSway is not blanked for entire swing");
});

test("no hips anywhere in the setup: the turn is from the target line, and says so", () => {
  // Hips square to the target line at address (lead hip toward +x), then turning 30 degrees open.
  const hips = doc => {
    for (const f of doc.frames) {
      const a = f.t < 1.3 ? 0 : 30 * Math.PI / 180;
      if (f.p[23]) f.p[23] = [0.15 * Math.cos(a), 0.95, -0.15 * Math.sin(a)];
      if (f.p[24]) f.p[24] = [-0.15 * Math.cos(a), 0.95, 0.15 * Math.sin(a)];
    }
    return doc;
  };
  const ref = M.compute(hips(makeDoc({})), POSITIONS);
  const doc = hips(makeDoc({}));
  for (const f of doc.frames) if (f.t <= 1.21) f.p[23] = null;   // the lead hip lost through address
  const r = M.compute(doc, POSITIONS);
  assert.equal(ref.turnFrom.pelvis, "address");
  assert.equal(r.turnFrom.pelvis, "target line");
  const at = (res, t) => res.values.find(v => Math.abs(v.t - t) < 0.003).pelvisTurn;
  assert.ok(Math.abs(Math.abs(at(ref, 1.5)) - 30) < 0.5);
  assert.ok(Math.abs(at(r, 1.5) - at(ref, 1.5)) < 0.5);
});

test("thoraxTop search window: early noise spike or early P3 before P4 - 0.35s does not inflate thoraxTop", () => {
  const doc = makeDoc({});
  // Inject a tracking noise spike early in the backswing (e.g. t = 1.1s, > 0.35s before P4 at 1.6s)
  const earlyFrame = doc.frames.find(f => Math.abs(f.t - 1.1) < 0.01);
  assert.ok(earlyFrame);
  // 120 degree spike
  const rad120 = 120 * Math.PI / 180;
  earlyFrame.p[11] = [-0.2 * Math.cos(rad120), 1.4, -0.2 * Math.sin(rad120)];
  earlyFrame.p[12] = [0.2 * Math.cos(rad120), 1.4, 0.2 * Math.sin(rad120)];

  // At top of backswing near P4 (t = 1.5s), normal 90 deg turn
  const topFrame = doc.frames.find(f => Math.abs(f.t - 1.5) < 0.01);
  assert.ok(topFrame);
  const rad90 = 90 * Math.PI / 180;
  topFrame.p[11] = [-0.2 * Math.cos(rad90), 1.4, -0.2 * Math.sin(rad90)];
  topFrame.p[12] = [0.2 * Math.cos(rad90), 1.4, 0.2 * Math.sin(rad90)];

  // Even if P3 was detected way too early at t = 0.6s
  const positions = [
    { key: "p1", t: 1.0 },
    { key: "takeaway", t: 1.2 },
    { key: "p3", t: 0.6 },
    { key: "p4", t: 1.6 },
    { key: "p7", t: 1.8 },
  ];

  const r = M.compute(doc, positions);
  assert.ok(r && r.thoraxTop);
  // thoraxTop must be bounded to the window within 0.35s of P4 and ignore the 120 deg spike at t = 1.1s
  assert.ok(r.thoraxTop.thoraxTurn < 100, `thoraxTop (${r.thoraxTop.thoraxTurn}) must ignore early spike`);
});

test("separation at thoraxTop: uses synchronous pelvis turn from the peak moment", () => {
  const doc = makeDoc({});
  // Add rotation to thorax so it peaks before P4
  doc.frames.forEach(f => {
    if (f.t > 1.2 && f.t <= 1.6) {
      // Simulate shoulder turn peaking at t = 1.5 with 90 deg, pelvis at 30 deg
      const progress = (f.t - 1.2) / 0.4;
      const shTurn = 90 * Math.sin(progress * Math.PI / 2);
      const rad = shTurn * Math.PI / 180;
      f.p[11] = [-0.2 * Math.cos(rad), 1.4, -0.2 * Math.sin(rad)];
      f.p[12] = [0.2 * Math.cos(rad), 1.4, 0.2 * Math.sin(rad)];
      const pRad = (30 * progress) * Math.PI / 180;
      f.p[23] = [-0.15 * Math.cos(pRad), 0.95, -0.15 * Math.sin(pRad)];
      f.p[24] = [0.15 * Math.cos(pRad), 0.95, 0.15 * Math.sin(pRad)];
    }
  });

  const positions = [
    { key: "p1", t: 1.0 },
    { key: "takeaway", t: 1.2 },
    { key: "p3", t: 1.4 },
    { key: "p4", t: 1.6 },
    { key: "p7", t: 1.8 },
  ];

  const r = M.compute(doc, positions);
  assert.ok(r, "compute returned result");
  assert.ok(r.thoraxTop, "thoraxTop found");
  assert.ok(r.thoraxTop.thoraxTurn >= 85, `thoraxTop.thoraxTurn (${r.thoraxTop.thoraxTurn}) near 90 deg`);
  // Synchronous separation at peak thorax turn must equal peak thorax turn minus pelvis turn at that frame
  const expectedSep = r.thoraxTop.thoraxTurn - r.thoraxTop.pelvisTurn;
  assert.ok(Math.abs(r.thoraxTop.separation - expectedSep) < 1e-4,
    `r.thoraxTop.separation (${r.thoraxTop.separation}) matches synchronous difference (${expectedSep})`);

  const at = M.atPositions(r, doc, positions);
  // Simulate summarize3d separation logic
  if (at.p4 && r.thoraxTop) {
    at.p4 = Object.assign({}, at.p4, {
      thoraxTurn: r.thoraxTop.thoraxTurn,
      separation: r.thoraxTop.separation != null ? r.thoraxTop.separation : at.p4.separation,
    });
  }
  assert.ok(at.p4.separation <= 65, `separation at top (${at.p4.separation}) must not be inflated`);
});


test("atPositions extracts numbers at key positions P1 through P8", () => {
  const doc = makeDoc({});
  const positions = [
    { key: "p1", t: 1.0 },
    { key: "p2", t: 1.3 },
    { key: "p3", t: 1.45 },
    { key: "p4", t: 1.6 },
    { key: "p5", t: 1.675 },
    { key: "p6", t: 1.75 },
    { key: "p7", t: 1.8 },
    { key: "p8", t: 1.875 },
  ];
  const r = M.compute(doc, positions);
  assert.ok(r, "compute returned result");
  const at = M.atPositions(r, doc, positions);
  for (const pos of ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"]) {
    assert.ok(at[pos], `atPositions should contain ${pos}`);
    assert.equal(typeof at[pos].t, "number", `${pos} should have timestamp t`);
    assert.equal(typeof at[pos].pelvisTurn, "number", `${pos} should have pelvisTurn`);
  }
});

test("SUMMARY includes the 15 held-up numbers at P2, P3, P5, P8 and not the others", () => {
  const doc = makeDoc({});
  const positions = [
    { key: "p1", t: 1.0 },
    { key: "p2", t: 1.3 },
    { key: "p3", t: 1.45 },
    { key: "p4", t: 1.6 },
    { key: "p5", t: 1.675 },
    { key: "p6", t: 1.75 },
    { key: "p7", t: 1.8 },
    { key: "p8", t: 1.875 },
  ];
  const fi = { name: "test_face.mp4", frames: [], rotation: 0 };
  const di = { name: "test_dtl.mp4", frames: [], rotation: 0 };
  const mockSummary = {
    aspectOf: () => "landscape",
    analyze: () => ({ positions }),
  };
  global.SwingSummary = mockSummary;
  const s3d = M.summarize3d(fi, di, "left", doc, "I7");
  assert.ok(s3d && s3d.numbers, "summarize3d returned numbers");

  for (const k of ["thoraxSwayP2", "pelvisLiftP2"]) {
    assert.ok(k in s3d.numbers, `numbers should have P2 key ${k}`);
  }
  for (const k of ["thoraxSwayP3", "pelvisThrustP3", "pelvisLiftP3", "thoraxBendP3", "xFactorP3"]) {
    assert.ok(k in s3d.numbers, `numbers should have P3 key ${k}`);
  }
  for (const k of ["pelvisSwayP5", "thoraxSwayP5"]) {
    assert.ok(k in s3d.numbers, `numbers should have P5 key ${k}`);
  }
  for (const k of ["pelvisSwayP8", "thoraxSwayP8", "pelvisThrustP8", "pelvisLiftP8", "pelvisSideBendP8"]) {
    assert.ok(k in s3d.numbers, `numbers should have P8 key ${k}`);
  }
  // Dropped in review: the setup moved them by half their spread or more.
  for (const k of ["pelvisSwayP2", "pelvisThrustP2", "thoraxSideBendP2", "thoraxBendP2", "xFactorP2", "pelvisSwayP3", "pelvisLiftP5", "pelvisSideBendP5", "thoraxSideBendP5", "thoraxBendP5", "xFactorP5", "xFactorP8"]) {
    assert.ok(!(k in s3d.numbers), `numbers should not have ${k}`);
  }
});

test("View3D.table renders only held-up numbers at new positions and muted dot for others", () => {
  function makeMockDoc() {
    function createEl(tag) {
      return {
        tagName: tag.toUpperCase(),
        attributes: {},
        children: [],
        textContent: "",
        setAttribute(k, v) { this.attributes[k] = v; },
        getAttribute(k) { return this.attributes[k]; },
        append(...kids) {
          for (const k of kids) {
            if (typeof k === "string") {
              this.children.push({ nodeType: 3, textContent: k });
            } else {
              this.children.push(k);
            }
          }
        },
      };
    }
    return {
      createElement(tag) { return createEl(tag); },
      createTextNode(text) { return { nodeType: 3, textContent: text }; },
    };
  }

  const origDoc = global.document;
  global.document = makeMockDoc();
  global.SwingShotStory = require("../static/shotstory.js");
  global.SwingMetrics3D = M;
  require("../static/view3d.js");
  const V = global.View3D;

  const doc = makeDoc({});
  const positions = [
    { key: "p1", t: 1.0, label: "Setup" },
    { key: "p2", t: 1.3, label: "Early backswing" },
    { key: "p3", t: 1.45, label: "Backswing" },
    { key: "p4", t: 1.6, label: "Top of swing" },
    { key: "p5", t: 1.675, label: "Early downswing" },
    { key: "p6", t: 1.75, label: "Downswing" },
    { key: "p7", t: 1.8, label: "Impact" },
    { key: "p8", t: 1.875, label: "Follow-through" },
  ];
  const r = M.compute(doc, positions);
  const tbl = V.table(r, doc, positions, null, null);
  assert.ok(tbl, "table returned element");
  assert.equal(tbl.tagName, "TABLE");

  // Check headers: first th is blank corner, then all 8 phase headers
  const headerRow = tbl.children[0];
  assert.equal(headerRow.children.length, 9, "9 columns (1 label + 8 positions)");
  const headerTexts = headerRow.children.slice(1).map(th => th.textContent);
  assert.deepEqual(headerTexts, [
    "Setup", "Early backswing", "Backswing", "Top of swing",
    "Early downswing", "Downswing", "Impact", "Follow-through",
  ]);

  // Check rows: for each row, index 2 corresponds to P2 column (col index 1 is p1, 2 is p2)
  // Rows:
  // 0: Hip turn ("pelvisTurn") -> NOT held up at P2 -> should be muted dot "·"
  // 1: Shoulder turn ("thoraxTurn") -> NOT held up at P2 -> muted dot "·"
  // 2: Shoulders turned past hips ("separation") -> NOT held up at P2 -> muted dot
  // 3: Chest bend toward ball ("thoraxBend") -> NOT held up at P2 -> muted dot
  // 4: Shoulder tilt ("thoraxSideBend") -> NOT held up at P2 -> muted dot
  // 5: Hip tilt ("pelvisSideBend") -> NOT held up at P2 -> muted dot "·"
  // 6: Hip slide ("pelvisSway") -> NOT held up at P2 -> muted dot
  // 7: Hips toward ball ("pelvisThrust") -> NOT held up at P2 -> muted dot
  // 8: Hip lift ("pelvisLift") -> HELD UP at P2 -> formatted number
  // 9: Chest slide ("thoraxSway") -> HELD UP at P2 -> formatted number
  const dataRows = tbl.children.slice(1);
  assert.equal(dataRows.length, 10, "10 rows of metrics");

  // Row 0: Hip turn
  const p2HipTurnTd = dataRows[0].children[2];
  assert.equal(p2HipTurnTd.children[0].textContent, "·", "Hip turn at P2 should be muted dot");
  assert.equal(p2HipTurnTd.children[0].attributes["class"], "muted");

  // Row 1: Shoulder turn
  const p2ShoulderTurnTd = dataRows[1].children[2];
  assert.equal(p2ShoulderTurnTd.children[0].textContent, "·", "Shoulder turn at P2 should be muted dot");

  // Row 2: Separation
  const p2SepTd = dataRows[2].children[2];
  assert.equal(p2SepTd.children[0].textContent, "·", "Separation at P2 should be muted dot");

  // Row 3: Chest bend
  const p2ChestBendTd = dataRows[3].children[2];
  assert.equal(p2ChestBendTd.children[0].textContent, "·", "Chest bend at P2 should be muted dot");

  // Rows 8 and 9: hip lift and chest slide held up at P2
  assert.notEqual(dataRows[8].children[2].children[0] && dataRows[8].children[2].children[0].textContent, "·", "Hip lift at P2 is shown");
  assert.notEqual(dataRows[9].children[2].children[0] && dataRows[9].children[2].children[0].textContent, "·", "Chest slide at P2 is shown");

  // Row 5: Hip tilt at P2
  const p2HipTiltTd = dataRows[5].children[2];
  assert.equal(p2HipTiltTd.children[0].textContent, "·", "Hip tilt at P2 should be muted dot");

  // Check column suppression when no numbers held up
  // If a position has no held-up metrics, it should not have a column
  const posWithEmpty = [
    { key: "p1", t: 1.0 },
    { key: "p9", t: 1.9 }, // Unknown position not in HELD_UP
  ];
  const tblSuppressed = V.table(r, doc, posWithEmpty, null, null);
  // Only p1 should be in the columns
  assert.equal(tblSuppressed.children[0].children.length, 2, "Only label + P1 column");

  global.document = origDoc;
});
