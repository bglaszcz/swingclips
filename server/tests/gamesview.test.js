const test = require("node:test");
const assert = require("node:assert/strict");
const { runningScoreWords, formatTargetName, lastGameSummary } = require("../static/gamesview.js");

test("runningScoreWords: formats strokes gained in plain words", () => {
  assert.equal(runningScoreWords(null), "");
  assert.equal(runningScoreWords(undefined), "");
  assert.equal(runningScoreWords(NaN), "");

  // Zero / near even
  assert.equal(runningScoreWords(0), "+0.0: about even with a tour player so far");
  assert.equal(runningScoreWords(0.1), "+0.1: about even with a tour player so far");
  assert.equal(runningScoreWords(-0.1), "-0.1: about even with a tour player so far");

  // Positive (better than tour player)
  assert.equal(runningScoreWords(0.4), "+0.4: a bit better than a tour player so far");
  assert.equal(runningScoreWords(1.0), "+1.0: about a stroke better than a tour player so far");
  assert.equal(runningScoreWords(1.5), "+1.5: a little over a stroke better than a tour player so far");
  assert.equal(runningScoreWords(2.0), "+2.0: about two strokes better than a tour player so far");
  assert.equal(runningScoreWords(3.2), "+3.2: 3.2 strokes better than a tour player so far");

  // Negative (behind tour player)
  assert.equal(runningScoreWords(-0.4), "-0.4: a bit behind a tour player so far");
  assert.equal(runningScoreWords(-0.9), "-0.9: about a stroke behind");
  assert.equal(runningScoreWords(-1.2), "-1.2: a little over a stroke behind");
  assert.equal(runningScoreWords(-2.0), "-2.0: about two strokes behind");
  assert.equal(runningScoreWords(-3.5), "-3.5: 3.5 strokes behind");
});

test("formatTargetName: formats targets into yards or shape", () => {
  assert.equal(formatTargetName(0), "fairway");
  assert.equal(formatTargetName("fairway"), "fairway");
  assert.equal(formatTargetName(110), "110 yd");
  assert.equal(formatTargetName("draw"), "draw");
  assert.equal(formatTargetName({ hole: 1, shot: 1, yards: 400 }), "hole 1 fairway");
  assert.equal(formatTargetName({ hole: 1, shot: 2, yards: 150 }), "hole 1 (150 yd)");
});

test("lastGameSummary: post-game comparison and best/worst target", () => {
  assert.equal(lastGameSummary(null), "No game in play.");

  // Combine: better than last time
  const combineNow = {
    id: "combine",
    name: "Combine",
    summary: {
      sgTotal: -3.1,
      shots: 27,
      byTarget: [
        { target: 110, shots: 3, sgPerShot: 0.3 },
        { target: 80, shots: 3, sgPerShot: 0.1 },
        { target: 155, shots: 3, sgPerShot: -0.5 },
      ],
    },
  };
  const combinePrev = {
    id: "combine",
    name: "Combine",
    summary: { sgTotal: -5.4, shots: 27 },
  };
  assert.equal(
    lastGameSummary(combineNow, combinePrev),
    "Combine: -3.1, better than last time (-5.4). Best target 110 yd, worst 155 yd."
  );

  // Combine: worse than last time
  const combineWorse = {
    id: "combine",
    name: "Combine",
    summary: {
      sgTotal: -5.4,
      shots: 27,
      byTarget: [
        { target: 110, shots: 3, sgPerShot: 0.3 },
        { target: 155, shots: 3, sgPerShot: -0.5 },
      ],
    },
  };
  assert.equal(
    lastGameSummary(combineWorse, combineNow),
    "Combine: -5.4, worse than last time (-3.1). Best target 110 yd, worst 155 yd."
  );

  // Combine: about the same
  const combineSame = {
    id: "combine",
    name: "Combine",
    summary: {
      sgTotal: -3.1,
      shots: 27,
      byTarget: [
        { target: 110, shots: 3, sgPerShot: 0.3 },
        { target: 155, shots: 3, sgPerShot: -0.5 },
      ],
    },
  };
  const combineSamePrev = {
    id: "combine",
    name: "Combine",
    summary: { sgTotal: -3.0, shots: 27 },
  };
  assert.equal(
    lastGameSummary(combineSame, combineSamePrev),
    "Combine: -3.1, about the same as last time (-3.0). Best target 110 yd, worst 155 yd."
  );

  // First game (no previous)
  assert.equal(
    lastGameSummary(combineNow, null),
    "Combine: -3.1. Best target 110 yd, worst 155 yd."
  );

  // Single target game (e.g. driving)
  const driveNow = {
    id: "driving",
    name: "Driving",
    summary: {
      sgTotal: -0.4,
      shots: 14,
      byTarget: [{ target: "fairway", shots: 14, sgPerShot: -0.4 }],
    },
  };
  const drivePrev = {
    id: "driving",
    name: "Driving",
    summary: { sgTotal: -1.2, shots: 14 },
  };
  assert.equal(
    lastGameSummary(driveNow, drivePrev),
    "Driving: -0.4, better than last time (-1.2)."
  );

  // Shaping game
  const shapeNow = {
    id: "shaping",
    name: "Shot shaping",
    summary: {
      greens: 9,
      shots: 12,
      byTarget: [
        { target: "draw", shots: 6, sgPerShot: 1.0 },
        { target: "fade", shots: 6, sgPerShot: 0.5 },
      ],
    },
  };
  const shapePrev = {
    id: "shaping",
    name: "Shot shaping",
    summary: { greens: 6, shots: 12 },
  };
  assert.equal(
    lastGameSummary(shapeNow, shapePrev),
    "Shot shaping: 9 of 12 shaped as called, better than last time (6/12). Best target draw, worst fade."
  );
});
