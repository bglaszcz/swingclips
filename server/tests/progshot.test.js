const test = require("node:test");
const assert = require("node:assert/strict");
const { lastShot, formatWant, formatMetricText } = require("../static/progshot.js");

function makeBraceTurnBlock(judged = []) {
  return {
    id: "tier2",
    name: "Tier 2: 3/4 speed 7 iron",
    ball: true,
    club: "I7",
    reps: 15,
    gate: {
      kind: "count",
      need: 8,
      checks: [
        { key: "attack", min: -4.5, max: -3 },
        { key: "faceToPath", min: -2, max: 2 },
        { key: "pelvisOpen", min: 10 },
        { key: "pelvisBall", min: 3 }
      ]
    },
    judged
  };
}

test("lastShot: a block with no ball reps returns null", () => {
  // Empty judged
  assert.equal(lastShot(makeBraceTurnBlock([])), null);

  // Non-ball block
  const noBallBlock = {
    id: "tier1",
    name: "Tier 1: no ball",
    ball: false,
    judged: [
      { kind: "tap", pass: true, gate: true }
    ]
  };
  assert.equal(lastShot(noBallBlock), null);

  // Ball block with only taps (e.g. before shots start)
  const onlyTapsBlock = {
    id: "tier2",
    ball: true,
    gate: { checks: [] },
    judged: [
      { kind: "tap", pass: true, gate: true }
    ]
  };
  assert.equal(lastShot(onlyTapsBlock), null);

  // Null block
  assert.equal(lastShot(null), null);
});

test("lastShot: a pass shot", () => {
  const block = makeBraceTurnBlock([
    {
      kind: "shot",
      numbers: {
        attack: -3.8,
        faceToPath: 0.5,
        pelvisOpen: 14,
        pelvisBall: 4.2,
        strikeV: -12,
        loft: 22.5,
        carry: 156,
        path: 1.2,
        face: 1.7,
        startDir: 1.0,
        ballSpeed: 114.8,
        smash: 1.36
      },
      gate: true
    }
  ]);

  const res = lastShot(block);
  assert.ok(res);
  assert.equal(res.verdict, "pass");
  assert.equal(res.why, null);

  // Checks in block order
  assert.equal(res.checks.length, 4);

  assert.equal(res.checks[0].key, "attack");
  assert.equal(res.checks[0].label, "Attack");
  assert.equal(res.checks[0].value, -3.8);
  assert.equal(res.checks[0].text, "-3.8°");
  assert.equal(res.checks[0].want, "-4.5 to -3");
  assert.equal(res.checks[0].ok, true);

  assert.equal(res.checks[1].key, "faceToPath");
  assert.equal(res.checks[1].label, "Face to path");
  assert.equal(res.checks[1].value, 0.5);
  assert.equal(res.checks[1].text, "+0.5°");
  assert.equal(res.checks[1].want, "within 2");
  assert.equal(res.checks[1].ok, true);

  assert.equal(res.checks[2].key, "pelvisOpen");
  assert.equal(res.checks[2].label, "Hips open");
  assert.equal(res.checks[2].value, 14);
  assert.equal(res.checks[2].text, "14°");
  assert.equal(res.checks[2].want, "10 or more");
  assert.equal(res.checks[2].ok, true);

  assert.equal(res.checks[3].key, "pelvisBall");
  assert.equal(res.checks[3].label, "Hips ahead of ball");
  assert.equal(res.checks[3].value, 4.2);
  assert.equal(res.checks[3].text, "+4.2 in");
  assert.equal(res.checks[3].want, "3 or more");
  assert.equal(res.checks[3].ok, true);

  // Extra reported-not-gated numbers present
  assert.deepEqual(res.extra, [
    { label: "Strike", text: "12 mm low" },
    { label: "Dynamic loft", text: "22.5°" },
    { label: "Carry", text: "156 yd" },
    { label: "Club path", text: "+1.2°" },
    { label: "Face to target", text: "+1.7°" },
    { label: "Start direction", text: "+1.0°" },
    { label: "Ball speed", text: "114.8 mph" },
    { label: "Smash", text: "1.36" }
  ]);
});

test("lastShot: a miss on two checks", () => {
  const block = makeBraceTurnBlock([
    {
      kind: "shot",
      numbers: {
        attack: -2.0, // too shallow (max is -3) -> fail
        faceToPath: 3.5, // too open (max is 2) -> fail
        pelvisOpen: 12, // >= 10 -> ok
        pelvisBall: 3.2, // >= 3 -> ok
        strikeV: -14,
        loft: 25.0
      },
      gate: false
    }
  ]);

  const res = lastShot(block);
  assert.ok(res);
  assert.equal(res.verdict, "miss");
  assert.match(res.why, /attack too shallow/);
  assert.match(res.why, /face open to path/);

  assert.equal(res.checks[0].key, "attack");
  assert.equal(res.checks[0].ok, false);
  assert.equal(res.checks[0].text, "-2.0°");

  assert.equal(res.checks[1].key, "faceToPath");
  assert.equal(res.checks[1].ok, false);
  assert.equal(res.checks[1].text, "+3.5°");

  assert.equal(res.checks[2].key, "pelvisOpen");
  assert.equal(res.checks[2].ok, true);
  assert.equal(res.checks[2].text, "12°");

  assert.equal(res.checks[3].key, "pelvisBall");
  assert.equal(res.checks[3].ok, true);
  assert.equal(res.checks[3].text, "+3.2 in");
});

test("lastShot: a not-counted shot (noRead)", () => {
  const block = makeBraceTurnBlock([
    {
      kind: "shot",
      numbers: {
        attack: -4.0,
        faceToPath: 0.0,
        clubSpeed: 0,
        strikeV: null,
        strikeH: null
      },
      gate: null,
      noRead: "strike not read"
    }
  ]);

  const res = lastShot(block);
  assert.ok(res);
  assert.equal(res.verdict, "not counted");
  assert.equal(res.why, "strike not read");

  assert.equal(res.checks[0].key, "attack");
  assert.equal(res.checks[0].ok, true);
  assert.equal(res.checks[0].text, "-4.0°");

  // Missing values (e.g. pelvis numbers not present)
  assert.equal(res.checks[2].key, "pelvisOpen");
  assert.equal(res.checks[2].value, null);
  assert.equal(res.checks[2].ok, null);
  assert.equal(res.checks[2].text, "–");
});

test("lastShot: one waiting for 3D", () => {
  const block = makeBraceTurnBlock([
    {
      kind: "shot",
      numbers: {
        attack: -3.5,
        faceToPath: 1.0,
        strikeV: -10,
        pelvisOpen: null,
        pelvisBall: null
      },
      gate: null,
      waiting3d: true
    }
  ]);

  const res = lastShot(block);
  assert.ok(res);
  assert.equal(res.verdict, "waiting");
  assert.equal(res.why, "waiting for 3D");

  assert.equal(res.checks[0].ok, true);
  assert.equal(res.checks[1].ok, true);

  // 3D checks not in yet
  assert.equal(res.checks[2].key, "pelvisOpen");
  assert.equal(res.checks[2].value, null);
  assert.equal(res.checks[2].text, "–");
  assert.equal(res.checks[2].ok, null);

  assert.equal(res.checks[3].key, "pelvisBall");
  assert.equal(res.checks[3].value, null);
  assert.equal(res.checks[3].text, "–");
  assert.equal(res.checks[3].ok, null);
});

test("lastShot: picks latest ball rep when multiple reps exist", () => {
  const block = makeBraceTurnBlock([
    {
      kind: "shot",
      t: 1000,
      numbers: { attack: -2.0, faceToPath: 4.0 },
      gate: false
    },
    {
      kind: "shot",
      t: 1030,
      numbers: { attack: -3.8, faceToPath: 0.5, pelvisOpen: 15, pelvisBall: 3.5 },
      gate: true
    }
  ]);

  const res = lastShot(block);
  assert.ok(res);
  assert.equal(res.verdict, "pass");
  assert.equal(res.checks[0].value, -3.8);
});

test("formatWant helper covers band formats", () => {
  assert.equal(formatWant({ min: -4.5, max: -3 }), "-4.5 to -3");
  assert.equal(formatWant({ min: -2, max: 2 }), "within 2");
  assert.equal(formatWant({ min: 10 }), "10 or more");
  assert.equal(formatWant({ min: 3 }), "3 or more");
  assert.equal(formatWant({ max: -3 }), "-3 or less");
  assert.equal(formatWant({ min: -20, max: -8 }), "-20 to -8");
});

test("formatMetricText helper handles zero, negative, positive, units", () => {
  assert.equal(formatMetricText("attack", -4.2), "-4.2°");
  assert.equal(formatMetricText("attack", 1.0), "+1.0°");
  assert.equal(formatMetricText("attack", 0.0), "0.0°");
  assert.equal(formatMetricText("pelvisBall", 3.1), "+3.1 in");
  assert.equal(formatMetricText("strikeV", -12), "12 mm low");
  assert.equal(formatMetricText("strikeV", 4), "4 mm high");
  assert.equal(formatMetricText("strikeV", 0), "centre");
  assert.equal(formatMetricText("strikeH", 8), "8 mm heel");
  assert.equal(formatMetricText("strikeH", -3), "3 mm toe");
  assert.equal(formatMetricText("strikeH", 0), "centre");
  assert.equal(formatMetricText("carry", 160), "160 yd");
  assert.equal(formatMetricText("smash", 1.45), "1.45");
  assert.equal(formatMetricText("attack", null), "–");
});

test("start.html includes progshot.js script, last shot CSS, and removes old last shot string", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const html = fs.readFileSync(path.join(__dirname, "../static/start.html"), "utf-8");

  assert.ok(html.includes('<script src="/static/progshot.js"></script>'), "includes progshot.js");
  assert.ok(html.includes(".prog-last-shot"), "includes .prog-last-shot CSS");
  assert.ok(html.includes(".prog-shot-verdict"), "includes .prog-shot-verdict CSS");
  assert.ok(html.includes(".prog-shot-row"), "includes .prog-shot-row CSS");
  assert.ok(html.includes(".prog-shot-extra"), "includes .prog-shot-extra CSS");
  assert.ok(!html.includes("Last shot: attack"), "old one-line last shot string removed");
});
