const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const History = require("../static/programhistory.js");

const fixturePath = path.join(__dirname, "fixtures", "program_state.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));

test("fixture runs: 4 runs of lowpoint, newest first with medians and state", () => {
  const runList = History.runs(fixture.log, fixture.programs);
  assert.equal(runList.length, 4);

  // Newest first
  assert.ok(runList[0].started > runList[1].started);
  assert.ok(runList[1].started > runList[2].started);
  assert.ok(runList[2].started > runList[3].started);

  const newest = runList[0];
  assert.equal(newest.how, "done");
  assert.equal(newest.cap, 40);
  assert.equal(newest.blocks.length, 4);

  // Newest run flush block passed with 7/10
  const newestFlush = newest.blocks.find(b => b.id === "flush");
  assert.equal(newestFlush.result, "passed");
  assert.equal(newestFlush.state.passes, 7);
  assert.equal(newestFlush.state.reps, 10);
  assert.equal(newestFlush.medians.attack, -2.8);
  assert.equal(newestFlush.medians.strikeV, 1.0);
  assert.equal(newestFlush.leftOut, 0);
  assert.equal(newestFlush.readCount, 10);

  // Oldest run (Day 1) flush block: 3/10 passed, 1 failed read, 1 mark behind
  const oldest = runList[3];
  assert.equal(oldest.how, "done");
  const oldestFlush = oldest.blocks.find(b => b.id === "flush");
  assert.equal(oldestFlush.result, "not passed");
  assert.equal(oldestFlush.state.passes, 3);
  assert.equal(oldestFlush.state.reps, 10);
  assert.equal(oldestFlush.medians.attack, -1.4);
  assert.equal(oldestFlush.medians.strikeV, 4.0);
  assert.equal(oldestFlush.leftOut, 1);
  assert.equal(oldestFlush.readCount, 10);

  // Oldest run transfer block was skipped
  const oldestTransfer = oldest.blocks.find(b => b.id === "transfer");
  assert.equal(oldestTransfer.result, "skipped");
  assert.equal(oldestTransfer.readCount, 0);

  // Trend over the 4 runs on flush block (ordered oldest first)
  const t = History.trend(runList, "lowpoint", "flush");
  assert.ok(t);
  assert.equal(t.runs.length, 4);
  assert.ok(t.runs[0].started < t.runs[3].started);

  const attackTrend = t.checks.find(c => c.key === "attack");
  assert.equal(attackTrend.firstMedian, -1.4);
  assert.equal(attackTrend.lastMedian, -2.8);
  assert.equal(attackTrend.movement, "now inside the gate");

  const strikeTrend = t.checks.find(c => c.key === "strikeV");
  assert.equal(strikeTrend.firstMedian, 4.0);
  assert.equal(strikeTrend.lastMedian, 1.0);
  assert.equal(strikeTrend.movement, "now inside the gate");

  // Plain-words lines output matching prompt requirement
  const summaryLines = History.lines(t);
  assert.equal(summaryLines.length, 1);
  assert.equal(
    summaryLines[0],
    "Flush line, 4 runs: passed 3/10 → 7/10 (gate 7). Attack -1.4 → -2.8° (now inside the gate). Strike 4 mm high → 1 mm high (now inside the gate)."
  );
});

test("run stopped early: preserves partial progress and stopped status", () => {
  const stoppedRun = {
    id: "lowpoint",
    name: "Low point forward",
    started: 1790000000,
    ended: 1790000500,
    how: "stopped",
    results: { toetap: "passed" },
    reps: [
      ...Array(10).fill({ block: "toetap", kind: "tap", pass: true }),
      { block: "stepthrough", kind: "tap", pass: true },
      { block: "stepthrough", kind: "tap", pass: false },
    ],
    blocks: [
      {
        id: "toetap",
        name: "Lead foot only",
        ball: false,
        result: "passed",
        state: { reps: 10, passes: 10, streak: 10, best: 10, passed: true, done: true },
        judged: Array(10).fill({ kind: "tap", gate: true }),
      },
      {
        id: "stepthrough",
        name: "Step through",
        ball: false,
        result: null,
        state: { reps: 2, passes: 1, streak: 0, best: 1, passed: false, done: false },
        judged: [{ kind: "tap", gate: true }, { kind: "tap", gate: false }],
      },
      {
        id: "flush",
        name: "Flush line",
        ball: true,
        gate: { checks: [{ key: "strikeV", max: 3 }, { key: "attack", max: -2 }] },
        result: null,
        state: { reps: 0, passes: 0, streak: 0, best: 0, passed: false, done: false },
        judged: [],
      },
    ],
  };

  const runList = History.runs([stoppedRun], fixture.programs);
  assert.equal(runList.length, 1);
  const r = runList[0];
  assert.equal(r.how, "stopped");
  assert.equal(r.swingsUsed, 12);
  assert.equal(r.blocks[0].result, "passed");
  assert.equal(r.blocks[1].result, null);
  assert.equal(r.blocks[1].state.passes, 1);
  assert.equal(r.blocks[2].result, null);
  assert.equal(r.blocks[2].readCount, 0);
});

test("skipped block: no trend when block has no read shots", () => {
  // Only runs 1 and 2 from fixture (both skipped transfer block)
  const runsWithSkipped = History.runs(fixture.log.slice(0, 2), fixture.programs);
  const t = History.trend(runsWithSkipped, "lowpoint", "transfer");
  assert.equal(t, null);
});

test("block with only failed reads: excluded from trend", () => {
  const failedReadsRun = {
    id: "lowpoint",
    started: 1790100000,
    how: "done",
    results: { flush: "not passed" },
    blocks: [
      {
        id: "flush",
        name: "Flush line",
        ball: true,
        gate: { checks: [{ key: "attack", max: -2 }, { key: "strikeV", max: 3 }] },
        result: "not passed",
        state: { reps: 0, passes: 0, streak: 0, best: 0, passed: false, done: false },
        judged: [
          { kind: "shot", noRead: "strike not read", numbers: { attack: -2.0, strikeV: 15.9, strikeH: 0.0 } },
          { kind: "shot", noRead: "no club speed", numbers: { attack: -2.0, strikeV: 2.0, clubSpeed: 0 } },
        ],
      },
    ],
  };

  const runList = History.runs([failedReadsRun], fixture.programs);
  assert.equal(runList[0].blocks[0].leftOut, 2);
  assert.equal(runList[0].blocks[0].readCount, 0);
  assert.equal(runList[0].blocks[0].medians.attack, null);
  assert.equal(runList[0].blocks[0].medians.strikeV, null);

  // Even if paired with 1 valid run, total runs with read shots is only 1 -> trend is null
  const validRun = History.runs(fixture.log.slice(0, 1), fixture.programs)[0];
  const t = History.trend([validRun, runList[0]], "lowpoint", "flush");
  assert.equal(t, null);
});

test("one run only: returns null (no trend) and lines returns empty array", () => {
  const singleRun = History.runs(fixture.log.slice(0, 1), fixture.programs);
  assert.equal(singleRun.length, 1);

  const t = History.trend(singleRun, "lowpoint", "flush");
  assert.equal(t, null);

  const emptyLines = History.lines(t);
  assert.deepEqual(emptyLines, []);
});

test("min-and-max check: face to path evaluates toward, away, and about the same", () => {
  const check = { key: "faceToPath", min: -2, max: 2 };

  // Moved toward gate: outside (+3.2) moving inside (+0.5)
  assert.equal(History.evaluateMovement(check, 3.2, 0.5), "now inside the gate");
  // Moved toward gate from negative side: outside (-3.0) moving inside (-0.5)
  assert.equal(History.evaluateMovement(check, -3.0, -0.5), "now inside the gate");
  // Moved away from gate: inside (+0.5) moving outside (+3.0)
  assert.equal(History.evaluateMovement(check, 0.5, 3.0), "moved away");
  // About the same: change <= 0.2 threshold
  assert.equal(History.evaluateMovement(check, 0.5, 0.6), "inside the gate");
  assert.equal(History.evaluateMovement(check, -1.0, -1.1), "inside the gate");

  // Trend and lines with faceToPath check
  const makeFaceRun = (t, date, med, streak) => ({
    id: "lowpoint",
    programId: "lowpoint",
    started: t,
    date,
    blocks: [
      {
        id: "transfer",
        name: "Transfer",
        ball: true,
        gate: { kind: "streak", need: 5, checks: [check] },
        state: { reps: 10, streak, best: streak, passes: streak, passed: streak >= 5 },
        readCount: 10,
        medians: { faceToPath: med },
      },
    ],
  });

  const runsToward = [
    makeFaceRun(1790100000, "2026-09-24", 3.2, 2),
    makeFaceRun(1790200000, "2026-09-26", 0.5, 5),
  ];
  const tToward = History.trend(runsToward, "lowpoint", "transfer");
  assert.ok(tToward);
  const lToward = History.lines(tToward);
  assert.equal(
    lToward[0],
    "Transfer, 2 runs: best streak 2 → 5 (gate 5 in a row). Face to path +3.2 → +0.5° (now inside the gate)."
  );

  const runsAway = [
    makeFaceRun(1790100000, "2026-09-24", 0.5, 5),
    makeFaceRun(1790200000, "2026-09-26", 3.5, 1),
  ];
  const tAway = History.trend(runsAway, "lowpoint", "transfer");
  const lAway = History.lines(tAway);
  assert.equal(
    lAway[0],
    "Transfer, 2 runs: best streak 5 → 1 (gate 5 in a row). Face to path +0.5 → +3.5° (away from ±2°)."
  );

  const runsSame = [
    makeFaceRun(1790100000, "2026-09-24", 0.5, 3),
    makeFaceRun(1790200000, "2026-09-26", 0.6, 4),
  ];
  const tSame = History.trend(runsSame, "lowpoint", "transfer");
  const lSame = History.lines(tSame);
  assert.equal(
    lSame[0],
    "Transfer, 2 runs: best streak 3 → 4 (gate 5 in a row). Face to path +0.5 → +0.6° (inside the gate)."
  );
});

test("braceturn runs: pelvis open goes 6 -> 12 (now inside the gate) and pelvis ahead 4.1 -> 3.9 (about the same)", () => {
  const braceturnProg = {
    id: "braceturn",
    name: "Brace and turn",
    blocks: [
      {
        id: "tier2",
        name: "Tier 2: 3/4 speed 7 iron",
        ball: true,
        gate: {
          kind: "count",
          need: 8,
          checks: [
            { key: "attack", min: -4.5, max: -3 },
            { key: "faceToPath", min: -2, max: 2 },
            { key: "pelvisOpen", min: 10 },
            { key: "pelvisBall", min: 3 },
          ],
        },
      },
    ],
  };

  const makeBraceRun = (started, date, medians, passes = 6) => ({
    id: "braceturn",
    programId: "braceturn",
    started,
    date,
    blocks: [
      {
        id: "tier2",
        name: "Tier 2: 3/4 speed 7 iron",
        ball: true,
        gate: braceturnProg.blocks[0].gate,
        state: { reps: 15, passes, streak: passes, best: passes, passed: passes >= 8 },
        readCount: 15,
        medians,
      },
    ],
  });

  const runs = [
    makeBraceRun(1790100000, "2026-10-06", { attack: -3.8, faceToPath: 0.5, pelvisOpen: 6, pelvisBall: 4.1 }, 6),
    makeBraceRun(1790200000, "2026-10-07", { attack: -3.5, faceToPath: 0.2, pelvisOpen: 12, pelvisBall: 3.9 }, 9),
  ];

  const t = History.trend(runs, "braceturn", "tier2");
  assert.ok(t);
  assert.equal(t.checks.length, 4);

  // Verifies gate order: attack, faceToPath, pelvisOpen, pelvisBall
  assert.deepEqual(t.checks.map(c => c.key), ["attack", "faceToPath", "pelvisOpen", "pelvisBall"]);

  const pelvisOpenCheck = t.checks.find(c => c.key === "pelvisOpen");
  assert.equal(pelvisOpenCheck.firstMedian, 6);
  assert.equal(pelvisOpenCheck.lastMedian, 12);
  assert.equal(pelvisOpenCheck.movement, "now inside the gate");

  const pelvisBallCheck = t.checks.find(c => c.key === "pelvisBall");
  assert.equal(pelvisBallCheck.firstMedian, 4.1);
  assert.equal(pelvisBallCheck.lastMedian, 3.9);
  assert.equal(pelvisBallCheck.movement, "about the same");

  const summary = History.lines(t);
  assert.equal(summary.length, 1);
  assert.equal(
    summary[0],
    "Tier 2: 3/4 speed 7 iron, 2 runs: passed 6/15 → 9/15 (gate 8). Attack -3.8 → -3.5° (inside the gate). Face to path +0.5 → +0.2° (inside the gate). Hips open 6 → 12° (now inside the gate). Hips ahead 4.1 → 3.9 in (about the same)."
  );
});

test("missing 3D swings on run: says (3D on n of m swings) when fewer than all had it", () => {
  const braceturnProg = {
    id: "braceturn",
    name: "Brace and turn",
    blocks: [
      {
        id: "tier2",
        name: "Tier 2: 3/4 speed 7 iron",
        ball: true,
        gate: {
          kind: "count",
          need: 8,
          checks: [
            { key: "pelvisOpen", min: 10 },
          ],
        },
      },
    ],
  };

  const reps1 = Array.from({ length: 10 }, () => ({
    block: "tier2",
    kind: "shot",
    numbers: { pelvisOpen: 7.0 },
    noRead: null,
  }));
  const run1 = {
    id: "braceturn",
    started: 1790100000,
    reps: reps1,
    blocks: [
      {
        id: "tier2",
        ball: true,
        gate: braceturnProg.blocks[0].gate,
        state: { reps: 10, passes: 5 },
        judged: reps1,
      },
    ],
  };

  const reps2 = Array.from({ length: 10 }, (_, i) => ({
    block: "tier2",
    kind: "shot",
    numbers: { pelvisOpen: i < 7 ? 11.0 : null },
    noRead: null,
  }));
  const run2 = {
    id: "braceturn",
    started: 1790200000,
    reps: reps2,
    blocks: [
      {
        id: "tier2",
        ball: true,
        gate: braceturnProg.blocks[0].gate,
        state: { reps: 10, passes: 7 },
        judged: reps2,
      },
    ],
  };

  const runList = History.runs([run1, run2], [braceturnProg]);
  assert.equal(runList[0].blocks[0].d3Notes.pelvisOpen, "(3D on 7 of 10 swings)");
  assert.equal(runList[1].blocks[0].d3Notes.pelvisOpen, undefined);

  const t = History.trend(runList, "braceturn", "tier2");
  assert.ok(t);
  const lines = History.lines(t);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("Hips open 7 → 11° (now inside the gate) (3D on 7 of 10 swings)."));
});

test("a one-sided check: toward it, then crossed in", () => {
  const c = { key: "pelvisOpen", min: 10 };
  assert.equal(History.evaluateMovement(c, 6, 8), "moved toward the gate");
  assert.equal(History.evaluateMovement(c, 6, 12), "now inside the gate");
  assert.equal(History.evaluateMovement(c, 12, 6), "moved away");
});
