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
  assert.strictEqual(fBlock.minutes, 15);
  assert.strictEqual(fBlock.balls, 20);
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

