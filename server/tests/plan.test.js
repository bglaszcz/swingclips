// plan.test.js: unit tests for SwingPlan.buildPlan and its practice session generation.
const test = require("node:test");
const assert = require("node:assert");
const Plan = require("../static/plan.js");

// Small realistic fixtures
const makeShot = (club, carry, offline, speed, extra = {}) => ({
  club,
  ball: { carry, side: offline, speed: speed ? speed * 1.3 : null },
  clubData: { speed, path: extra.path ?? 2.0, faceToTarget: extra.face ?? 1.5, angleOfAttack: -2.0, smash: 1.3 },
  ...extra
});

const makeClip = (name, club, carry, offline, speed, extra = {}) => ({
  name,
  recorded: "2026-09-29T14:00:00",
  shot: makeShot(club, carry, offline, speed, extra),
  body: extra.body ?? null,
  excluded: false
});

// Wedge shots across PW, GW, SW to build a wedge matrix with a hole
function makeWedgeClips() {
  const clips = [];
  const fullSpeed = 88;
  // 10 full GW shots to establish fullSpeed
  for (let i = 0; i < 10; i++) {
    clips.push(makeClip(`gw_full_${i}`, "GW", 100 + i, 2, fullSpeed));
  }
  // 3 three-quarter GW shots (80% speed) ~80 yd
  for (let i = 0; i < 3; i++) {
    clips.push(makeClip(`gw_3q_${i}`, "GW", 80 + i, 0, 0.85 * fullSpeed));
  }
  // 3 half GW shots (70% speed) ~60 yd
  for (let i = 0; i < 3; i++) {
    clips.push(makeClip(`gw_half_${i}`, "GW", 60 + i, 0, 0.70 * fullSpeed));
  }
  return clips;
}

test("empty history (brand-new owner)", () => {
  const plan = Plan.buildPlan({});
  assert.strictEqual(plan.blocks.length, 4);

  const [warmup, focus, scoring, finish] = plan.blocks;

  // 1. Warmup
  assert.strictEqual(warmup.id, "warmup");
  assert.strictEqual(warmup.minutes, 5);
  assert.strictEqual(warmup.balls, 10);
  assert.ok(warmup.why.includes("wedge"));

  // 2. Focus (none set)
  assert.strictEqual(focus.id, "focus");
  assert.strictEqual(focus.minutes, 0);
  assert.strictEqual(focus.balls, 0);
  assert.strictEqual(focus.button, null);
  assert.ok(focus.why.includes("No focus set yet"));

  // 3. Scoring (fallback to Wedge ladder)
  assert.strictEqual(scoring.id, "scoring");
  assert.strictEqual(scoring.balls, 13);
  assert.strictEqual(scoring.button.gameId, "wedges");

  // 4. Finish (Combine, no combine ever)
  assert.strictEqual(finish.id, "finish");
  assert.strictEqual(finish.balls, 27);
  assert.strictEqual(finish.button.gameId, "combine");
  assert.ok(finish.why.includes("No Combine on record yet"));

  assert.strictEqual(plan.totalMinutes, 5 + 0 + 12 + 20);
  assert.strictEqual(plan.totalBalls, 10 + 0 + 13 + 27);
});

test("focus block with active focus and enough swings sets practice range", () => {
  const focus = {
    move: "handsPlaneP6",
    aim: "less",
    club: "I7",
    results: ["path"],
    since: "2026-09-28"
  };

  // Provide 6 I7 swings with handsPlaneP6 readings
  const clips = [
    makeClip("c1", "I7", 150, 0, 85, { body: { handsPlaneP6: 2.0 } }),
    makeClip("c2", "I7", 152, 2, 85, { body: { handsPlaneP6: 2.2 } }),
    makeClip("c3", "I7", 149, -1, 85, { body: { handsPlaneP6: 2.4 } }),
    makeClip("c4", "I7", 151, 1, 85, { body: { handsPlaneP6: 2.1 } }),
    makeClip("c5", "I7", 153, 0, 85, { body: { handsPlaneP6: 2.3 } }),
    makeClip("c6", "I7", 150, -2, 85, { body: { handsPlaneP6: 2.5 } })
  ];

  const plan = Plan.buildPlan({ focus, clips });
  const fBlock = plan.blocks.find(b => b.id === "focus");
  // The move has a drill, so the block's 15 minutes and 20 balls are shared with the normal swings after it.
  const carry = plan.blocks.find(b => b.id === "carry");
  assert.strictEqual(fBlock.minutes + carry.minutes, 15);
  assert.strictEqual(fBlock.balls + carry.balls, 20);
  assert.ok(fBlock.title.includes("Focus:"));
  assert.ok(fBlock.drill);
  assert.ok(fBlock.thought);
  assert.ok(fBlock.button);
  assert.strictEqual(fBlock.button.disabled, false);
  assert.strictEqual(fBlock.button.params.metric, "handsPlaneP6");
  assert.strictEqual(fBlock.button.params.club, "I7");
  assert.ok(fBlock.button.params.min != null);
  assert.ok(fBlock.button.params.max != null);
  assert.strictEqual(fBlock.button.params.cue, fBlock.thought);
});

test("focus block with fewer than 5 swings disables Practice button", () => {
  const focus = {
    move: "handsPlaneP6",
    aim: "less",
    club: "I7",
    results: ["path"],
    since: "2026-09-28"
  };

  const clips = [
    makeClip("c1", "I7", 150, 0, 85, { body: { handsPlaneP6: 2.0 } }),
    makeClip("c2", "I7", 152, 2, 85, { body: { handsPlaneP6: 2.2 } })
  ];

  const plan = Plan.buildPlan({ focus, clips });
  const fBlock = plan.blocks.find(b => b.id === "focus");
  assert.ok(fBlock.button);
  assert.strictEqual(fBlock.button.disabled, true);
  assert.strictEqual(fBlock.button.params.min, null);
});

test("scoring-zone block uses Combine worst target when available", () => {
  // 3 combines with shots at target 65 having poor strokes gained
  const combineResults = [
    { target: 65, sg: -0.8, onGreen: false, dist: 18 },
    { target: 65, sg: -0.9, onGreen: false, dist: 22 },
    { target: 65, sg: -0.7, onGreen: false, dist: 20 },
    { target: 110, sg: 0.1, onGreen: true, dist: 6 },
    { target: 110, sg: 0.2, onGreen: true, dist: 5 },
    { target: 110, sg: 0.0, onGreen: true, dist: 7 }
  ];
  const gameLog = [
    { id: "combine", started: 1790000000, summary: { shots: 6, greens: 3 }, results: combineResults }
  ];

  const plan = Plan.buildPlan({ gameLog });
  const sBlock = plan.blocks.find(b => b.id === "scoring");
  assert.ok(sBlock.title.includes("65 yd"));
  assert.strictEqual(sBlock.button.gameId, "wedges");
  assert.ok(sBlock.why.includes("65 yards"));
});

test("scoring-zone block for worst target over 100 yd suggests Distance control", () => {
  const combineResults = [
    { target: 125, sg: -0.8, onGreen: false, dist: 25 },
    { target: 125, sg: -0.9, onGreen: false, dist: 22 },
    { target: 125, sg: -0.7, onGreen: false, dist: 20 }
  ];
  const gameLog = [
    { id: "combine", started: 1790000000, summary: { shots: 3, greens: 0 }, results: combineResults }
  ];

  const plan = Plan.buildPlan({ gameLog });
  const sBlock = plan.blocks.find(b => b.id === "scoring");
  assert.ok(sBlock.title.includes("125 yd"));
  assert.strictEqual(sBlock.button.gameId, "distance");
  assert.ok(sBlock.why.includes("125 yards"));
});

test("scoring-zone block falls back to wedge matrix biggest hole when no Combine", () => {
  const clips = makeWedgeClips();
  const plan = Plan.buildPlan({ gameLog: [], clips });
  const sBlock = plan.blocks.find(b => b.id === "scoring");
  assert.strictEqual(sBlock.id, "scoring");
  assert.strictEqual(sBlock.button.gameId, "wedges");
  assert.ok(sBlock.why.includes("with no stock shot"));
});

test("a wedge matrix hole past the Wedge ladder's 100 yd suggests Distance control", () => {
  const clips = [];
  for (let i = 0; i < 10; i++) clips.push(makeClip(`pw_full_${i}`, "PW", 115 + (i % 5), 0, 95));
  for (let i = 0; i < 3; i++) clips.push(makeClip(`pw_3q_${i}`, "PW", 103 + i, 0, 0.85 * 95));
  for (let i = 0; i < 10; i++) clips.push(makeClip(`gw_full_${i}`, "GW", 98 + (i % 3), 0, 90));
  const plan = Plan.buildPlan({ gameLog: [], clips });
  const sBlock = plan.blocks.find(b => b.id === "scoring");
  assert.strictEqual(sBlock.button.gameId, "distance");
  assert.ok(sBlock.title.includes("Distance control"));
});

test("finish block: Combine 10 days ago picks Combine", () => {
  const now = 1791000000 * 1000;
  const tenDaysAgo = (1791000000 - 10 * 86400) * 1000;
  const gameLog = [
    { id: "combine", started: tenDaysAgo / 1000, summary: { shots: 27, greens: 15, sgPerShot: -0.2 } }
  ];

  const plan = Plan.buildPlan({ gameLog }, { now });
  const finish = plan.blocks.find(b => b.id === "finish");
  assert.strictEqual(finish.button.gameId, "combine");
  assert.ok(finish.why.includes("10 days ago"));
  assert.strictEqual(finish.balls, 27);
});

test("finish block: Combine yesterday picks Driving if driver fairway rate is low", () => {
  const now = 1791000000 * 1000;
  const yesterday = (1791000000 - 86400) * 1000;
  const gameLog = [
    { id: "combine", started: yesterday / 1000, summary: { shots: 27, greens: 15, sgPerShot: -0.2 } }
  ];

  // 10 Driver shots, only 3 hit fairway (offline <= 15)
  const clips = [
    makeClip("d1", "DR", 240, 5, 100),
    makeClip("d2", "DR", 235, -10, 99),
    makeClip("d3", "DR", 245, 12, 101),
    makeClip("d4", "DR", 230, 25, 98),
    makeClip("d5", "DR", 238, -30, 99),
    makeClip("d6", "DR", 242, 20, 100),
    makeClip("d7", "DR", 240, -18, 100),
    makeClip("d8", "DR", 235, 22, 99),
    makeClip("d9", "DR", 241, -25, 101),
    makeClip("d10", "DR", 244, 19, 102)
  ];

  const plan = Plan.buildPlan({ gameLog, clips }, { now });
  const finish = plan.blocks.find(b => b.id === "finish");
  assert.strictEqual(finish.button.gameId, "driving");
  assert.strictEqual(finish.balls, 14);
  assert.ok(finish.why.includes("fairway"));
});

test("finish block: Combine yesterday picks Distance control if iron carry spread is wide", () => {
  const now = 1791000000 * 1000;
  const yesterday = (1791000000 - 86400) * 1000;
  const gameLog = [
    { id: "combine", started: yesterday / 1000, summary: { shots: 27, greens: 15, sgPerShot: -0.2 } }
  ];

  // Good driver shots (100% fairways)
  const drClips = Array.from({ length: 6 }, (_, i) => makeClip(`d_${i}`, "DR", 240, 5, 100));
  // I7 shots with wide carry spread (135 to 165 yd, IQR ~20)
  const ironClips = [
    makeClip("i1", "I7", 135, 0, 85),
    makeClip("i2", "I7", 140, 0, 85),
    makeClip("i3", "I7", 148, 0, 85),
    makeClip("i4", "I7", 152, 0, 85),
    makeClip("i5", "I7", 160, 0, 85),
    makeClip("i6", "I7", 165, 0, 85)
  ];

  const plan = Plan.buildPlan({ gameLog, clips: [...drClips, ...ironClips] }, { now });
  const finish = plan.blocks.find(b => b.id === "finish");
  assert.strictEqual(finish.button.gameId, "distance");
  assert.strictEqual(finish.balls, 15);
  assert.ok(finish.why.includes("carry spread"));
});

test("total time and balls are in expected 45-min / 60-80 ball practice range", () => {
  const focus = { move: "tempo", aim: "more", club: "I7" };
  const clips = Array.from({ length: 10 }, (_, i) =>
    makeClip(`c_${i}`, "I7", 150, 0, 85, { body: { tempo: 3.0 + i * 0.1 } }));
  const plan = Plan.buildPlan({ focus, clips });
  assert.ok(plan.totalMinutes >= 40 && plan.totalMinutes <= 55, `totalMinutes=${plan.totalMinutes}`);
  assert.ok(plan.totalBalls >= 60 && plan.totalBalls <= 80, `totalBalls=${plan.totalBalls}`);
});

test("focus block includes drill set from last 14 days, leaves out older sets", () => {
  const focus = { move: "handsPlaneP6", aim: "less", club: "I7" };
  const now = new Date("2026-09-30T12:00:00Z");

  const recentSet = {
    date: "2026-09-28",
    timestamp: new Date("2026-09-28T12:00:00Z").getTime(),
    drill: "pump",
    club: "I7",
    count: 10,
    pumps: { handsPlane: -0.9 },
    after: { count: 10, median: 4.3 },
    verdict: "no carry-over yet"
  };

  const planRecent = Plan.buildPlan({ focus, drillSet: recentSet }, { now });
  const fRecent = planRecent.blocks.find(b => b.id === "focus");
  assert.ok(fRecent.drillSet);
  assert.ok(fRecent.drillSet.includes("Pump drill"));
  assert.ok(fRecent.drillSet.includes("no carry-over yet"));

  // Set from 20 days ago (> 14 days)
  const oldSet = {
    date: "2026-09-10",
    timestamp: new Date("2026-09-10T12:00:00Z").getTime(),
    drill: "pump",
    club: "I7",
    count: 10,
    pumps: { handsPlane: -0.9 },
    after: { count: 10, median: 4.3 },
    verdict: "no carry-over yet"
  };

  const planOld = Plan.buildPlan({ focus, drillSet: oldSet }, { now });
  const fOld = planOld.blocks.find(b => b.id === "focus");
  assert.strictEqual(fOld.drillSet, null);
});


// ---- Part 4 tests: program block, block needs, armsLed fault ----

// Helper to build a minimal fake program state (as returned by /api/program)
function makeProgramState(id, blockIndex, blockDefs, cap = 40) {
  const blocks = blockDefs.map((b, i) => ({
    id: b.id,
    name: b.name,
    ball: b.ball !== false,
    how: b.how || `Do ${b.name}.`,
    gate: b.gate || { kind: "count", need: 10 },
    now: i === blockIndex,
    judged: [],
    result: i < blockIndex ? "passed" : undefined,
    ...(b.extra || {})
  }));
  return {
    id,
    name: `Test program ${id}`,
    cap,
    block: blockIndex,
    blocks,
    used: 0,
    waiting3d: 0
  };
}

test("coach program in progress comes first in the plan", () => {
  const progState = makeProgramState("sequence", 1, [
    { id: "pausetop", name: "Pause at the top", ball: false },
    { id: "blocked", name: "Blocked 3/4 7 irons", ball: true,
      gate: { kind: "count", need: 10, checks: [{ key: "pelvisPeakMs", max: 0 }, { key: "pelvisOpen", min: 15 }] } }
  ], 40);

  const plan = Plan.buildPlan({ program: progState });

  assert.strictEqual(plan.blocks[0].id, "program");
  assert.ok(plan.blocks[0].title.includes("Blocked 3/4 7 irons"));
  assert.strictEqual(plan.blocks[0].balls, 40);
  assert.strictEqual(plan.blocks[0].minutes, 30);
  assert.strictEqual(plan.blocks[1].id, "warmup");
  assert.strictEqual(plan.blocks.length, 5);
});

test("coach program block (no-ball) shows 0 balls and needs no phones/square", () => {
  const progState = makeProgramState("sequence", 0, [
    { id: "pausetop", name: "Pause at the top", ball: false }
  ], 20);

  const plan = Plan.buildPlan({ program: progState });

  const pb = plan.blocks[0];
  assert.strictEqual(pb.id, "program");
  assert.strictEqual(pb.balls, 0);
  assert.strictEqual(pb.needs.ball, false);
  assert.strictEqual(pb.needs.phones, false);
  assert.strictEqual(pb.needs.square, false);
});

test("no program present -> 4 standard blocks (no program block)", () => {
  const plan = Plan.buildPlan({});
  assert.strictEqual(plan.blocks.length, 4);
  assert.ok(plan.blocks.every(b => b.id !== "program"));
});

test("all blocks declare needs (phones, square, body3d, ball, noball keys)", () => {
  const focus = { move: "handsPlaneP6", aim: "less", club: "I7" };
  const clips = Array.from({ length: 6 }, (_, i) =>
    makeClip(`c${i}`, "I7", 150, 0, 85, { body: { handsPlaneP6: 2.0 + i * 0.1 } }));

  const plan = Plan.buildPlan({ focus, clips });
  for (const b of plan.blocks) {
    assert.ok(b.needs, `Block ${b.id} missing needs`);
    assert.ok("phones" in b.needs, `Block ${b.id} missing needs.phones`);
    assert.ok("square" in b.needs, `Block ${b.id} missing needs.square`);
    assert.ok("body3d" in b.needs, `Block ${b.id} missing needs.body3d`);
    assert.ok("ball" in b.needs, `Block ${b.id} missing needs.ball`);
    assert.ok("noball" in b.needs, `Block ${b.id} missing needs.noball`);
  }
});

test("warmup block declares no phones/square/3d needed", () => {
  const plan = Plan.buildPlan({});
  const wu = plan.blocks.find(b => b.id === "warmup");
  assert.ok(wu);
  assert.strictEqual(wu.needs.phones, false);
  assert.strictEqual(wu.needs.square, false);
  assert.strictEqual(wu.needs.body3d, false);
  assert.strictEqual(wu.needs.ball, true);
});

test("scoring and finish blocks declare phones + square needed", () => {
  const plan = Plan.buildPlan({});
  const scoring = plan.blocks.find(b => b.id === "scoring");
  const finish = plan.blocks.find(b => b.id === "finish");
  assert.ok(scoring.needs.phones && scoring.needs.square);
  assert.ok(finish.needs.phones && finish.needs.square);
});

test("getBlockNeeds: 3D gate check sets body3d=true", () => {
  const block = {
    id: "tier2",
    name: "Tier 2",
    ball: true,
    gate: { kind: "count", need: 10, checks: [{ key: "pelvisPeakMs", max: 0 }, { key: "pelvisOpen", min: 15 }] }
  };
  const needs = Plan.getBlockNeeds(block);
  assert.strictEqual(needs.body3d, true);
  assert.strictEqual(needs["3d"], true);
  assert.strictEqual(needs.phones, true);
  assert.strictEqual(needs.ball, true);
});

test("getBlockNeeds: no-ball block with no 3D gate -> phones=false, ball=false, noball=true", () => {
  const block = {
    id: "pausetop",
    name: "Pause at the top",
    ball: false,
    gate: { kind: "streak", need: 10 }
  };
  const needs = Plan.getBlockNeeds(block);
  assert.strictEqual(needs.phones, false);
  assert.strictEqual(needs.square, false);
  assert.strictEqual(needs.body3d, false);
  assert.strictEqual(needs.ball, false);
  assert.strictEqual(needs.noball, true);
});

test("armsLed fault feeds focus block when no focus is set and it is the top fault", () => {
  const makeArmsLedClip = (name, pelvisOpen) => ({
    name,
    recorded: "2026-09-29T14:00:00",
    shot: makeShot("I7", 150, 0, 85),
    body: null,
    excluded: false,
    body3d: {
      numbers: { pelvisOpenImpact: pelvisOpen },
      sequence: {
        bodyLate: true,
        segments: [
          { key: "pelvis", beforeImpact: 33, t: 1.06 },
          { key: "arm",    beforeImpact: 50, t: 1.0 }
        ]
      }
    }
  });

  const clips = [
    makeArmsLedClip("s1",  5),
    makeArmsLedClip("s2",  8),
    makeArmsLedClip("s3",  3),
    makeArmsLedClip("s4", 12),
    makeArmsLedClip("s5",  7)
  ];

  // As on the page: /api/clips (face-on) and the swing records (/api/swings) that carry body3d.
  const swings = Object.fromEntries(clips.map(c => [c.name, { body3d: c.body3d }]));
  const plan = Plan.buildPlan({ clips: clips.map(c => ({ ...c, angle: "face", body3d: undefined })), swings });
  const fBlock = plan.blocks.find(b => b.id === "focus");

  assert.ok(fBlock, "focus block not found");
  assert.ok(
    fBlock.title.toLowerCase().includes("arms") || fBlock.title.toLowerCase().includes("downswing"),
    `Focus title should mention arms-led, got: "${fBlock.title}"`
  );
  assert.ok(fBlock.drill, "focus block should have a drill from coach.js armsLed");
  assert.ok(fBlock.thought, "focus block should have a thought from coach.js armsLed");
  assert.ok(
    fBlock.why.includes("arms") || fBlock.why.includes("3D"),
    `Focus why should mention arms or 3D, got: "${fBlock.why}"`
  );
  assert.ok(
    fBlock.drill.includes("Step and fire") || fBlock.drill.includes("step") || fBlock.drill.includes("Pause"),
    `Focus drill should be the sequence drill, got: "${fBlock.drill}"`
  );
});

test("armsLed focus block needs body3d=true", () => {
  const makeArmsLedClip = (name) => ({
    name,
    recorded: "2026-09-29T14:00:00",
    shot: makeShot("I7", 150, 0, 85),
    excluded: false,
    body3d: {
      numbers: { pelvisOpenImpact: 5 },
      sequence: { bodyLate: true, segments: [
        { key: "pelvis", beforeImpact: 33, t: 1.06 },
        { key: "arm",    beforeImpact: 50, t: 1.0 }
      ]}
    }
  });
  const clips = Array.from({ length: 4 }, (_, i) => makeArmsLedClip(`s${i}`));
  // As on the page: /api/clips (face-on) and the swing records (/api/swings) that carry body3d.
  const swings = Object.fromEntries(clips.map(c => [c.name, { body3d: c.body3d }]));
  const plan = Plan.buildPlan({ clips: clips.map(c => ({ ...c, angle: "face", body3d: undefined })), swings });
  const fBlock = plan.blocks.find(b => b.id === "focus");
  assert.ok(fBlock && fBlock.needs && fBlock.needs.body3d,
    "armsLed focus block should declare body3d needed");
});

test("explicit focus overrides auto-fault detection", () => {
  const focus = { move: "handsPlaneP6", aim: "less", club: "I7" };
  const clips = Array.from({ length: 5 }, (_, i) => ({
    name: `s${i}`,
    recorded: "2026-09-29T14:00:00",
    shot: makeShot("I7", 150, 0, 85),
    excluded: false,
    body3d: {
      numbers: { pelvisOpenImpact: 5 },
      sequence: { bodyLate: true, segments: [] }
    }
  }));

  const plan = Plan.buildPlan({ focus, clips });
  const fBlock = plan.blocks.find(b => b.id === "focus");
  assert.ok(
    !fBlock.title.toLowerCase().includes("arms-led"),
    `Explicit focus should win over auto-fault. Title: "${fBlock.title}"`
  );
});

// ---- Round 59: the focus's reps, then normal swings (the guided part of the session) ----

const focusOf = (move, aim) => ({ move, aim, club: "I7", results: ["carry"], since: "2026-09-28" });
const ids = plan => plan.blocks.map(b => b.id);

test("a focus with a drill: a reps block, then normal swings, in that order", () => {
  const plan = Plan.buildPlan({ focus: focusOf("leadHipP6", "more"), clips: [] });
  assert.deepStrictEqual(ids(plan), ["warmup", "focus", "carry", "scoring", "finish"]);
  const reps = plan.blocks[1], carry = plan.blocks[2];
  assert.deepStrictEqual([reps.kind, reps.drillMode, reps.balls, reps.minutes], ["reps", "move:leadHipP6:more", 10, 8]);
  assert.deepStrictEqual([carry.kind, carry.after, carry.balls, carry.minutes, carry.drillMode], ["swings", "move:leadHipP6:more", 10, 7, undefined]);
  assert.strictEqual(carry.title, "Normal swings: do they keep it?");
  assert.strictEqual(carry.thought, reps.thought);
  assert.ok(reps.drill);
  // Practice this works on the normal swings too.
  assert.strictEqual(carry.button, reps.button);
  assert.strictEqual(carry.button.params.metric, "leadHipP6");
});

test("the reps are recorded as the move's own drill: the pump only for the move it is the drill of", () => {
  const mode = (move, aim) => Plan.buildPlan({ focus: focusOf(move, aim), clips: [] }).blocks.find(b => b.id === "focus").drillMode;
  assert.strictEqual(mode("handsPlaneP6", "less"), "pump");
  // Its drill's words also begin "Pump drill", but it is another move: reps of that move.
  assert.strictEqual(mode("lagP5", "more"), "move:lagP5:more");
  assert.strictEqual(mode("shoulderTop", "more"), "move:shoulderTop:more");
});

test("the split keeps the plan's totals", () => {
  const plan = Plan.buildPlan({ focus: focusOf("leadHipP6", "more"), clips: [] });
  const two = plan.blocks.filter(b => b.id === "focus" || b.id === "carry");
  assert.strictEqual(two.reduce((n, b) => n + b.balls, 0), 20);
  assert.strictEqual(two.reduce((n, b) => n + b.minutes, 0), 15);
  assert.strictEqual(plan.totalBalls, plan.blocks.reduce((n, b) => n + b.balls, 0));
  assert.strictEqual(plan.totalMinutes, plan.blocks.reduce((n, b) => n + b.minutes, 0));
  assert.ok(plan.totalBalls >= 60 && plan.totalBalls <= 80);
});

test("no focus: one focus block as before, and no normal-swings block", () => {
  const plan = Plan.buildPlan({ clips: [] });
  assert.deepStrictEqual(ids(plan), ["warmup", "focus", "scoring", "finish"]);
  assert.strictEqual(plan.blocks[1].drillMode, undefined);
  assert.strictEqual(plan.blocks[1].kind, undefined);
});
