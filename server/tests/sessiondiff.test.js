// sessiondiff.test.js: unit tests for SwingSessionDiff (sessiondiff.js).
const test = require("node:test");
const assert = require("node:assert");
const SessionDiff = require("../static/sessiondiff.js");

const BASELINE_7I = {
  n: 50,
  carry: 155.0,
  smash: 1.30,
  strikeH: 0,
  strikeV: 0,
};

const DEFAULT_SETTINGS = {
  minCount: 8,
  irons: { offlinePct: 5, carryBelowPct: 10, carryAbovePct: 12, smashBelow: 0 },
  woods: { offlinePct: 6, carryBelowPct: 10, carryAbovePct: 12, smashBelow: 0 },
  strike: { on: false },
};

function makeRow(name, club, shotData, bodyData, trustData = null, excluded = false) {
  const c = {
    name,
    angle: "face",
    partner: null,
    excluded,
    shot: shotData ? {
      club,
      ball: {
        carry: shotData.carry,
        side: shotData.offline,
        speed: shotData.ballSpeed ?? 110,
        vla: 20,
        hla: 0,
        spinAxis: 0,
        totalSpin: 6000,
      },
      clubData: {
        speed: shotData.clubSpeed ?? 85,
        smash: shotData.smash ?? 1.30,
        path: 0,
        faceToTarget: 0,
        loft: 30,
        angleOfAttack: -2,
        faceImpactH: shotData.strikeH ?? 0,
        faceImpactV: shotData.strikeV ?? 0,
      }
    } : null,
  };

  const rec = bodyData ? {
    body: { ...bodyData },
    quality: { swingFound: true, p6Estimated: false, camera: { face: [], dtl: [] } }
  } : null;

  const trust = {};
  if (bodyData) {
    for (const k in bodyData) {
      trust[k] = (trustData && trustData[k]) ? trustData[k] : { level: "ok", why: [] };
    }
  }

  return {
    c,
    name,
    club,
    rec,
    trust,
    body: bodyData ? { ...bodyData } : null,
    shown: bodyData ? { ...bodyData } : null,
    carry: shotData?.carry ?? null,
    offline: shotData?.offline ?? null,
    smash: shotData?.smash ?? null,
    strikeH: shotData?.strikeH ?? null,
    strikeV: shotData?.strikeV ?? null,
    ballSpeed: shotData?.ballSpeed ?? null,
    clubSpeed: shotData?.clubSpeed ?? null,
  };
}

test("clear difference: good shots have less hands to trail pocket at P6", () => {
  const rows = [];
  // 9 good 7-iron shots: carry 155, offline 1, handsPlaneP6 around -0.5 in
  for (let i = 1; i <= 9; i++) {
    rows.push(makeRow(
      `good_${i}.mp4`, "I7",
      { carry: 155, offline: 1.0, smash: 1.30 },
      { handsPlaneP6: -0.5 + (i % 3) * 0.1, earlyExt: 1.0 }
    ));
  }

  // 15 rest 7-iron shots: carry 135 (shortfall > 10%), handsPlaneP6 around +3.6 in
  for (let i = 1; i <= 15; i++) {
    rows.push(makeRow(
      `rest_${i}.mp4`, "I7",
      { carry: 135, offline: 3.0, smash: 1.20 },
      { handsPlaneP6: 3.6 + (i % 3) * 0.1, earlyExt: 1.0 }
    ));
  }

  const res = SessionDiff.diff(rows, {
    club: "I7",
    baseline: BASELINE_7I,
    settings: DEFAULT_SETTINGS,
  });

  assert.equal(res.nGood, 9);
  assert.equal(res.nRest, 15);
  assert.equal(res.total, 24);
  assert.equal(res.enough, true);
  assert.ok(res.separating.length >= 1);

  const top = res.separating[0];
  assert.equal(top.key, "handsPlaneP6");
  assert.equal(top.dir, "less");
  assert.equal(top.amount, "4.1 in");
  assert.equal(top.clear, true);
  assert.ok(top.coach);
  assert.equal(top.coach.thought, "Hands drop to the trail pocket.");

  assert.equal(res.lines.length, 1);
  assert.equal(res.lines[0], "Good 7 irons today (9 of 24): 4.1 in less hands to the trail pocket at P6 than your misses.");
});

test("none: enough good and rest shots, but no body number clearly separates", () => {
  const rows = [];
  // 10 good shots and 10 rest shots with virtually identical distributions and high variance
  for (let i = 1; i <= 10; i++) {
    rows.push(makeRow(
      `good_${i}.mp4`, "I7",
      { carry: 155, offline: 1.0, smash: 1.30 },
      { handsPlaneP6: 2.0 + (i - 5) * 1.5, earlyExt: 1.0 }
    ));
    rows.push(makeRow(
      `rest_${i}.mp4`, "I7",
      { carry: 135, offline: 1.0, smash: 1.20 },
      { handsPlaneP6: 2.1 + (i - 5) * 1.5, earlyExt: 1.0 }
    ));
  }

  const res = SessionDiff.diff(rows, {
    club: "I7",
    baseline: BASELINE_7I,
    settings: DEFAULT_SETTINGS,
  });

  assert.equal(res.nGood, 10);
  assert.equal(res.nRest, 10);
  assert.equal(res.enough, true);
  assert.equal(res.separating.length, 0);
  assert.deepEqual(res.lines, ["Nothing separates today's good and bad 7 irons clearly yet."]);
});

test("too few: fewer than minimum swings per side", () => {
  const rows = [];
  // 2 good shots, 8 rest shots
  for (let i = 1; i <= 2; i++) {
    rows.push(makeRow(
      `good_${i}.mp4`, "I7",
      { carry: 155, offline: 1.0, smash: 1.30 },
      { handsPlaneP6: -1.0 }
    ));
  }
  for (let i = 1; i <= 8; i++) {
    rows.push(makeRow(
      `rest_${i}.mp4`, "I7",
      { carry: 130, offline: 3.0, smash: 1.20 },
      { handsPlaneP6: 4.0 }
    ));
  }

  const res = SessionDiff.diff(rows, {
    club: "I7",
    baseline: BASELINE_7I,
    settings: DEFAULT_SETTINGS,
    minPerSide: 3,
  });

  assert.equal(res.nGood, 2);
  assert.equal(res.nRest, 8);
  assert.equal(res.enough, false);
  assert.equal(res.separating.length, 0);
  assert.deepEqual(res.lines, ["Too few good 7 irons today to compare (2 of 10)."]);
});

test("no good shots: 0 good shots", () => {
  const rows = [];
  for (let i = 1; i <= 10; i++) {
    rows.push(makeRow(
      `rest_${i}.mp4`, "I7",
      { carry: 120, offline: 10.0, smash: 1.15 },
      { handsPlaneP6: 4.0 }
    ));
  }

  const res = SessionDiff.diff(rows, {
    club: "I7",
    baseline: BASELINE_7I,
    settings: DEFAULT_SETTINGS,
  });

  assert.equal(res.nGood, 0);
  assert.equal(res.nRest, 10);
  assert.deepEqual(res.lines, ["No good 7 irons today (0 of 10)."]);
});

test("all good: 0 rest shots", () => {
  const rows = [];
  for (let i = 1; i <= 10; i++) {
    rows.push(makeRow(
      `good_${i}.mp4`, "I7",
      { carry: 155, offline: 1.0, smash: 1.30 },
      { handsPlaneP6: 0.0 }
    ));
  }

  const res = SessionDiff.diff(rows, {
    club: "I7",
    baseline: BASELINE_7I,
    settings: DEFAULT_SETTINGS,
  });

  assert.equal(res.nGood, 10);
  assert.equal(res.nRest, 0);
  assert.deepEqual(res.lines, ["All 7 irons today were good (10 of 10)."]);
});

test("best and worst picks: smallest offline share and furthest outside box", () => {
  const rows = [];
  // 3 good shots:
  // shot1: carry 150, offline 5 -> offline share = 5/150 = 0.0333
  // shot2: carry 160, offline 0.8 -> offline share = 0.8/160 = 0.0050 (BEST)
  // shot3: carry 155, offline 2.0 -> offline share = 2.0/155 = 0.0129
  rows.push(makeRow("good_1.mp4", "I7", { carry: 150, offline: 5.0, smash: 1.30 }, { earlyExt: 1 }));
  rows.push(makeRow("good_2.mp4", "I7", { carry: 160, offline: 0.8, smash: 1.30 }, { earlyExt: 1 }));
  rows.push(makeRow("good_3.mp4", "I7", { carry: 155, offline: 2.0, smash: 1.30 }, { earlyExt: 1 }));

  // 3 rest shots:
  // Baseline carry is 155. Offline limit 5%, carryBelow limit 10%.
  // rest1: carry 145 (shortfall 10/155 = 0.0645 -> score 0.645), offline 10 (share 10/145 = 0.069 -> score 1.379) => outside 1.379
  // rest2: carry 100 (shortfall 55/155 = 0.3548 -> score 3.548), offline 1 (share 1/100 = 0.01) => outside 3.548 (WORST)
  // rest3: carry 150 (shortfall 5/155 = 0.032), offline 12 (share 12/150 = 0.08 -> score 1.60) => outside 1.60
  rows.push(makeRow("rest_1.mp4", "I7", { carry: 145, offline: 10.0, smash: 1.20 }, { earlyExt: 1 }));
  rows.push(makeRow("rest_2.mp4", "I7", { carry: 100, offline: 1.0, smash: 1.10 }, { earlyExt: 1 }));
  rows.push(makeRow("rest_3.mp4", "I7", { carry: 150, offline: 12.0, smash: 1.25 }, { earlyExt: 1 }));

  const res = SessionDiff.diff(rows, {
    club: "I7",
    baseline: BASELINE_7I,
    settings: DEFAULT_SETTINGS,
  });

  assert.equal(res.best.name, "good_2.mp4");
  assert.equal(res.worst.name, "rest_2.mp4");
});

test("mishits with no Square shot are never worst", () => {
  const rows = [];
  // 3 good shots
  rows.push(makeRow("good_1.mp4", "I7", { carry: 155, offline: 1.0, smash: 1.30 }, { earlyExt: 1 }));
  rows.push(makeRow("good_2.mp4", "I7", { carry: 155, offline: 2.0, smash: 1.30 }, { earlyExt: 1 }));
  rows.push(makeRow("good_3.mp4", "I7", { carry: 155, offline: 1.5, smash: 1.30 }, { earlyExt: 1 }));

  // Rest shots:
  // rest_slice: sliced shot (carry 140, offline 15 -> offShare = 15/140 = 0.107, limit 0.05 -> score 2.14)
  // rest_mishit1: mishit with no shot object from Square
  // rest_mishit2: mishit with carry <= 0 or missing
  rows.push(makeRow("rest_slice.mp4", "I7", { carry: 140, offline: 15.0, smash: 1.20 }, { earlyExt: 1 }));
  rows.push(makeRow("rest_mishit1.mp4", "I7", null, { earlyExt: 1 }));
  rows.push(makeRow("rest_mishit2.mp4", "I7", { carry: 0, offline: 0, smash: 0 }, { earlyExt: 1 }));

  const res = SessionDiff.diff(rows, {
    club: "I7",
    baseline: BASELINE_7I,
    settings: DEFAULT_SETTINGS,
  });

  assert.equal(res.worst.name, "rest_slice.mp4");
  assert.notEqual(res.worst.name, "rest_mishit1.mp4");
  assert.notEqual(res.worst.name, "rest_mishit2.mp4");
  assert.equal(res.leftOutCount, 2);
});

test("real-looking rows: verifies full swingRow data structures with shaky markings", () => {
  const rows = [];
  for (let i = 1; i <= 5; i++) {
    rows.push(makeRow(
      `good_real_${i}.mp4`, "I7",
      { carry: 156, offline: 0.5, smash: 1.31 },
      { handsPlaneP6: -0.2 + (i % 3) * 0.1, headToBall: 0.5 + (i % 3) * 0.1, tempo: 3.1 + (i % 3) * 0.05 },
      { handsPlaneP6: { level: "shaky", why: ["noisy"] } }
    ));
  }
  for (let i = 1; i <= 10; i++) {
    rows.push(makeRow(
      `rest_real_${i}.mp4`, "I7",
      { carry: 132, offline: 4.5, smash: 1.22 },
      { handsPlaneP6: 3.8 + (i % 3) * 0.1, headToBall: 1.8 + (i % 3) * 0.1, tempo: 2.8 + (i % 3) * 0.05 },
      { handsPlaneP6: { level: "shaky", why: ["noisy"] } }
    ));
  }

  const res = SessionDiff.diff(rows, {
    club: "I7",
    baseline: BASELINE_7I,
    settings: DEFAULT_SETTINGS,
  });

  assert.equal(res.nGood, 5);
  assert.equal(res.nRest, 10);
  assert.equal(res.total, 15);
  assert.ok(res.separating.length >= 1);
  const p6 = res.separating.find(s => s.key === "handsPlaneP6");
  assert.ok(p6);
  assert.equal(p6.shaky, true);
  assert.equal(p6.amount, "4.0 in");
  assert.equal(p6.dir, "less");
  assert.ok(res.best);
  assert.ok(res.worst);
});
