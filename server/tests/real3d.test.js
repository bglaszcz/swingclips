// Regression tests on the first session of real calibrated 3D swings (tests/fixtures/real3d).
// Ensures later changes do not degrade confirmed 3D kinematic findings.
//
//   cd server && node --test tests/real3d.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

global.SwingPhases = require("../static/phases.js");
global.SwingMetrics = require("../static/metrics.js");
global.SwingSummary = require("../static/summary.js");
const M = require("../static/metrics3d.js");

// Tolerances and bands based on the first session (2026-10-02) and owner video confirmation:
// Thorax turn at the top: today's 6 fixtures measured 90-118 deg (full shoulder turn).
const THORAX_TOP_MIN = 80;
const THORAX_TOP_MAX = 125;

// Pelvis open at impact: owner confirmed hips are square at impact on video (fixtures measured 0.3-2.9 deg).
const PELVIS_OPEN_IMPACT_MIN = -5;
const PELVIS_OPEN_IMPACT_MAX = 15;

// Lead arm peak speed timing: arms lead downswing, peaking 33-54 ms before impact across today's session.
const ARM_PEAK_BEFORE_IMPACT_MIN = 20;
const ARM_PEAK_BEFORE_IMPACT_MAX = 80;

const FIXTURES_DIR = path.join(__dirname, "fixtures", "real3d");
const FIXTURE_FILES = fs.readdirSync(FIXTURES_DIR)
  .filter(f => f.startsWith("swing_") && f.endsWith(".json.gz"))
  .sort();

test("real 3D swings regression: kinematic sequence, thorax turn and pelvis impact angle", () => {
  assert.equal(FIXTURE_FILES.length, 6, "Expected 6 real 3D fixture files");

  for (const file of FIXTURE_FILES) {
    const raw = fs.readFileSync(path.join(FIXTURES_DIR, file));
    const s = JSON.parse(zlib.gunzipSync(raw));
    const r = M.summarize3d(s.main, s.other, "left", s.tri, s.club);

    assert.ok(r, `${file}: summarize3d returned result`);
    assert.ok(r.numbers, `${file}: numbers present`);
    assert.ok(r.sequence, `${file}: sequence present`);

    // Thorax turn at top in band 80-125
    assert.ok(
      r.numbers.thoraxTop >= THORAX_TOP_MIN && r.numbers.thoraxTop <= THORAX_TOP_MAX,
      `${file}: thoraxTop (${r.numbers.thoraxTop}) outside [${THORAX_TOP_MIN}, ${THORAX_TOP_MAX}]`
    );

    // Pelvis open at impact in band -5 to 15 (hips square)
    assert.ok(
      r.numbers.pelvisOpenImpact >= PELVIS_OPEN_IMPACT_MIN && r.numbers.pelvisOpenImpact <= PELVIS_OPEN_IMPACT_MAX,
      `${file}: pelvisOpenImpact (${r.numbers.pelvisOpenImpact}) outside [${PELVIS_OPEN_IMPACT_MIN}, ${PELVIS_OPEN_IMPACT_MAX}]`
    );

    // Kinematic sequence findings
    assert.equal(r.sequence.bodyLate, true, `${file}: sequence.bodyLate must be true`);
    assert.equal(r.sequence.armsFirst, true, `${file}: sequence.armsFirst must be true`);

    // Lead arm peak before impact in band 20-80 ms
    const armSeg = r.sequence.segments.find(seg => seg.key === "arm");
    assert.ok(armSeg, `${file}: arm segment present in sequence`);
    assert.equal(armSeg.afterImpact, false, `${file}: arm must peak before impact`);
    assert.ok(
      armSeg.beforeImpact >= ARM_PEAK_BEFORE_IMPACT_MIN && armSeg.beforeImpact <= ARM_PEAK_BEFORE_IMPACT_MAX,
      `${file}: arm peak (${armSeg.beforeImpact} ms) outside [${ARM_PEAK_BEFORE_IMPACT_MIN}, ${ARM_PEAK_BEFORE_IMPACT_MAX}] ms`
    );
  }
});
