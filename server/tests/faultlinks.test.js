// Tests for static/faultlinks.js (SwingFaultLinks):
// - Club confounding: A and B correlated only through club comes out NOT linked
// - Real within-club link comes out linked (Strong / Worth watching)
// - Shaky and missing numbers are ignored
// - Head dip and head lift are never paired
// - Fewer than enough swings yields nothing
// - Earlier phase (P6) is identified before impact (P7)
// - Real data evaluation
//
// Run from server: node --test tests/faultlinks.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const FaultLinks = require("../static/faultlinks.js");
const Faults = require("../static/faults.js");

test("Cochran-Mantel-Haenszel pure function matches expected odds ratio and p value", () => {
  // Classic 2x2 stratified table
  // Stratum 1: a=30, b=10, c=10, d=30, T=80 (OR = 9.0)
  // Stratum 2: a=25, b=5, c=10, d=40, T=80 (OR = 20.0)
  const strata = [
    { a: 30, b: 10, c: 10, d: 30, total: 80 },
    { a: 25, b: 5, c: 10, d: 40, total: 80 },
  ];
  const res = FaultLinks.cochranMantelHaenszel(strata);
  assert.equal(res.usedClubs, 2);
  assert.ok(res.or > 10);
  assert.ok(res.z > 5);
  assert.ok(res.p < 1e-6);
});

test("Club confounding: A and B correlated only through club comes out NOT linked", () => {
  // Made-up set where Driver has both earlyExt and bendLoss at high rates (80%),
  // while 7-iron has both at low rates (20%),
  // BUT within each club, earlyExt and bendLoss are completely independent!
  const rows = [];

  // Driver (DR): 50 swings.
  // P(earlyExt) = 40/50 = 80%, P(bendLoss) = 40/50 = 80%.
  // Independent within DR:
  // a = 32 (both earlyExt > 3 and bendLoss < -10)
  // b = 8 (earlyExt > 3, bendLoss = 0)
  // c = 8 (earlyExt = 1, bendLoss < -10)
  // d = 2 (earlyExt = 1, bendLoss = 0)
  for (let i = 0; i < 32; i++) rows.push({ club: "DR", earlyExt: 4.0, bendLoss: -15 });
  for (let i = 0; i < 8; i++) rows.push({ club: "DR", earlyExt: 4.0, bendLoss: 0 });
  for (let i = 0; i < 8; i++) rows.push({ club: "DR", earlyExt: 1.0, bendLoss: -15 });
  for (let i = 0; i < 2; i++) rows.push({ club: "DR", earlyExt: 1.0, bendLoss: 0 });

  // 7-Iron (I7): 50 swings.
  // P(earlyExt) = 10/50 = 20%, P(bendLoss) = 10/50 = 20%.
  // Independent within I7:
  // a = 2 (both)
  // b = 8 (earlyExt only)
  // c = 8 (bendLoss only)
  // d = 32 (neither)
  for (let i = 0; i < 2; i++) rows.push({ club: "I7", earlyExt: 4.0, bendLoss: -15 });
  for (let i = 0; i < 8; i++) rows.push({ club: "I7", earlyExt: 4.0, bendLoss: 0 });
  for (let i = 0; i < 8; i++) rows.push({ club: "I7", earlyExt: 1.0, bendLoss: -15 });
  for (let i = 0; i < 32; i++) rows.push({ club: "I7", earlyExt: 1.0, bendLoss: 0 });

  // Raw overall across 100 swings:
  // Both: 34, A only: 16, B only: 16, Neither: 34
  // Raw OR = (34*34)/(16*16) = 4.5! A raw test would call this linked.
  // BUT CMH stratifies by club:
  const results = FaultLinks.links(rows);
  const eeBl = results.find(l => 
    (l.a.name === "early extension" && l.b.name === "standing up") ||
    (l.b.name === "early extension" && l.a.name === "standing up")
  );

  // Must NOT be in the default returned links (not linked!)
  assert.equal(eeBl, undefined, "Confounded pair must not be returned as linked");

  // If inspecting with all: true
  const allResults = FaultLinks.links(rows, null, { all: true });
  const eeBlAll = allResults.find(l => 
    (l.a.name === "early extension" && l.b.name === "standing up") ||
    (l.b.name === "early extension" && l.a.name === "standing up")
  );
  assert.ok(eeBlAll);
  assert.equal(eeBlAll.label, null);
  assert.ok(Math.abs(eeBlAll.or - 1.0) < 0.05, `OR should be ~1.0, got ${eeBlAll.or}`);
  assert.ok(eeBlAll.p > 0.5, `p value should be high (null hypothesis holds), got ${eeBlAll.p}`);
});

test("Real within-club link comes out linked with Strong or Worth watching label", () => {
  // A real within-club link: casting (P6) and early extension (P7) go together within clubs
  const rows = [];
  // DR: 30 swings, strongly correlated
  for (let i = 0; i < 15; i++) rows.push({ club: "DR", releaseArm: -15, earlyExt: 4.0 }); // both
  for (let i = 0; i < 2; i++) rows.push({ club: "DR", releaseArm: -15, earlyExt: 1.0 });  // casting only
  for (let i = 0; i < 2; i++) rows.push({ club: "DR", releaseArm: -30, earlyExt: 4.0 });  // EE only
  for (let i = 0; i < 11; i++) rows.push({ club: "DR", releaseArm: -30, earlyExt: 1.0 }); // neither

  // I7: 30 swings, strongly correlated
  for (let i = 0; i < 15; i++) rows.push({ club: "I7", releaseArm: -15, earlyExt: 4.0 });
  for (let i = 0; i < 2; i++) rows.push({ club: "I7", releaseArm: -15, earlyExt: 1.0 });
  for (let i = 0; i < 2; i++) rows.push({ club: "I7", releaseArm: -30, earlyExt: 4.0 });
  for (let i = 0; i < 11; i++) rows.push({ club: "I7", releaseArm: -30, earlyExt: 1.0 });

  const results = FaultLinks.links(rows);
  const link = results.find(l => l.a.name === "casting" && l.b.name === "early extension");
  assert.ok(link, "Casting and early extension must come out linked");
  assert.ok(link.or > 5);
  assert.equal(link.label, "Strong");
  assert.equal(link.earlier.name, "casting");
  assert.ok(link.sentence.includes("Casting and early extension tend to come together"));
  assert.ok(link.sentence.includes("Casting comes first in the swing"));
});

test("Shaky and missing numbers are ignored", () => {
  const rows = [];
  // 20 valid swings
  for (let i = 0; i < 10; i++) rows.push({ club: "I7", releaseArm: -15, earlyExt: 4.0 });
  for (let i = 0; i < 10; i++) rows.push({ club: "I7", releaseArm: -30, earlyExt: 1.0 });

  // Add rows with trust level none or shaky
  rows.push({ club: "I7", releaseArm: -15, earlyExt: 4.0, trust: { releaseArm: { level: "none" } } });
  rows.push({ club: "I7", releaseArm: -15, earlyExt: 4.0, trust: { earlyExt: { level: "shaky" } } });
  rows.push({ club: "I7", releaseArm: null, earlyExt: 4.0 });
  rows.push({ club: "I7", releaseArm: -15, earlyExt: undefined });

  const all = FaultLinks.links(rows, null, { all: true });
  const link = all.find(l => l.a.name === "casting" && l.b.name === "early extension");
  assert.ok(link);
  assert.equal(link.n, 20, "Should only count the 20 readable non-shaky swings");
});

test("Head dip and head lift are never paired", () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ club: "I7", headRise: -2.0, earlyExt: 4.0 });
  for (let i = 0; i < 20; i++) rows.push({ club: "I7", headRise: 2.0, earlyExt: 1.0 });

  const all = FaultLinks.links(rows, null, { all: true });
  const dipLift = all.find(l => 
    (l.a.name === "head dip" && l.b.name === "head lift") ||
    (l.a.name === "head lift" && l.b.name === "head dip")
  );
  assert.equal(dipLift, undefined, "Head dip and head lift must never be paired");
});

test("Fewer than enough swings yields nothing", () => {
  const rows = [
    { club: "I7", releaseArm: -15, earlyExt: 4.0 },
    { club: "I7", releaseArm: -15, earlyExt: 4.0 },
    { club: "I7", releaseArm: -30, earlyExt: 1.0 },
  ];
  const results = FaultLinks.links(rows);
  assert.deepEqual(results, [], "Fewer than enough swings must return empty array");
});

test("Scorecard note helper generates note when other fault is on the swing", () => {
  const strongLinks = [
    {
      a: { name: "casting" },
      b: { name: "early extension" },
      label: "Strong"
    }
  ];

  // Swing with both casting and early extension
  const swingFaultsBoth = [{ name: "casting" }, { name: "early extension" }];
  const note1 = FaultLinks.scorecardNote({ name: "casting" }, strongLinks, swingFaultsBoth);
  assert.equal(note1, "Often comes with early extension");

  const note2 = FaultLinks.scorecardNote({ name: "early extension" }, strongLinks, swingFaultsBoth);
  assert.equal(note2, "Often comes with casting");

  // Swing with casting only
  const swingFaultsOne = [{ name: "casting" }];
  const note3 = FaultLinks.scorecardNote({ name: "casting" }, strongLinks, swingFaultsOne);
  assert.equal(note3, null, "Should return null if the other linked fault is not on this swing");
});

test("Run on real data from scratch dir", () => {
  const swingsPath = "C:/Users/bglas/AppData/Local/Temp/gemini-scratch/swings.json";
  const clipsPath = "C:/Users/bglas/AppData/Local/Temp/gemini-scratch/clips.json";
  if (!fs.existsSync(swingsPath) || !fs.existsSync(clipsPath)) {
    return; // skip if scratch data not available
  }
  const swingsData = JSON.parse(fs.readFileSync(swingsPath, "utf8"));
  const clips = JSON.parse(fs.readFileSync(clipsPath, "utf8"));
  const noiseTable = swingsData.noise || null;
  const Trust = require("../static/trust.js");

  const rows = [];
  for (const c of clips) {
    if (c.excluded) continue;
    const rec = swingsData.swings[c.name];
    if (!rec || !rec.body) continue;
    const trust = Trust.forSwing ? Trust.forSwing(rec, null, noiseTable) : null;
    const club = (c.shot && c.shot.club) || (rec.shot && rec.shot.club) || null;
    rows.push({
      c,
      name: c.name,
      club,
      trust,
      body: rec.body,
      shown: rec.body,
      ...rec.body,
    });
  }

  assert.ok(rows.length > 100);
  const realLinks = FaultLinks.links(rows);
  console.log("Real data discovered links:", realLinks.map(l => `${l.a.name} & ${l.b.name} (${l.label}, OR=${l.or.toFixed(2)}, q=${l.q.toFixed(3)})`));
  for (const l of realLinks) {
    assert.ok(l.label === "Strong" || l.label === "Worth watching");
    assert.ok(l.sentence.length > 20);
  }
});
