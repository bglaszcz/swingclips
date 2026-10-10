// drillsets.test.js: unit tests for SwingDrillSets (drillsets.js).
const test = require("node:test");
const assert = require("node:assert");
const DrillSets = require("../static/drillsets.js");

function makeClip(name, recorded, drill, club, angle = "face", partner = null, extra = {}) {
  return {
    name,
    recorded,
    drill: drill || null,
    angle,
    partner,
    shot: club ? { club } : null,
    quality: {
      p6Estimated: false,
      camera: { face: [], dtl: [] }
    },
    ...extra
  };
}

function makeRecord(handsPlaneP6, pumps = null, p6Estimated = false) {
  return {
    body: {
      handsPlaneP6
    },
    drill: pumps ? { kind: "pump", pumps } : null,
    quality: {
      swingFound: true,
      p6Estimated,
      camera: { face: [], dtl: [] }
    }
  };
}

test("carry-over: after swings move toward the pumps compared with before", () => {
  const clips = [];
  const records = {};

  // 5 normal I7 swings before: P6 around 5.0 in (far from pumps at -1.0 in)
  for (let i = 1; i <= 5; i++) {
    const name = `swing_face_before_${i}.mp4`;
    clips.push(makeClip(name, `2026-09-30T10:0${i}:00`, null, "I7"));
    records[name] = makeRecord(5.0 + i * 0.1);
  }

  // 5 pump drill I7 swings: pumps at -1.0 in, drill swings P6 1.0 in
  for (let i = 1; i <= 5; i++) {
    const name = `swing_face_drill_${i}.mp4`;
    clips.push(makeClip(name, `2026-09-30T10:1${i}:00`, "pump", "I7"));
    records[name] = makeRecord(1.0, [
      { t: 3.5, handsPlane: -1.0, lag: 60 },
      { t: 5.0, handsPlane: -1.0, lag: 60 }
    ]);
  }

  // 5 normal I7 swings after: P6 around 0.5 in (moved clearly toward pumps)
  for (let i = 1; i <= 5; i++) {
    const name = `swing_face_after_${i}.mp4`;
    clips.push(makeClip(name, `2026-09-30T10:2${i}:00`, null, "I7"));
    records[name] = makeRecord(0.5 + i * 0.1);
  }

  const sets = DrillSets.sets(clips, records);
  assert.strictEqual(sets.length, 1);
  const s = sets[0];
  assert.strictEqual(s.count, 5);
  assert.strictEqual(s.drill, "pump");
  assert.strictEqual(s.club, "I7");
  assert.strictEqual(s.pumps.handsPlane, -1.0);
  assert.strictEqual(s.before.count, 5);
  assert.strictEqual(s.after.count, 5);

  const verd = DrillSets.verdict(s);
  assert.strictEqual(verd.level, "clear");
  assert.ok(verd.text.includes("carry-over"));
});

test("no carry-over: after swings do not move toward the pumps", () => {
  const clips = [];
  const records = {};

  // 5 normal before: P6 around 4.4 in
  for (let i = 1; i <= 5; i++) {
    const name = `swing_face_b_${i}.mp4`;
    clips.push(makeClip(name, `2026-09-30T10:0${i}:00`, null, "I7"));
    records[name] = makeRecord(4.4);
  }

  // 5 pump drill: pumps at -1.0 in, drill swings P6 around 4.6 in
  for (let i = 1; i <= 5; i++) {
    const name = `swing_face_d_${i}.mp4`;
    clips.push(makeClip(name, `2026-09-30T10:1${i}:00`, "pump", "I7"));
    records[name] = makeRecord(4.6, [
      { t: 3.5, handsPlane: -1.0, lag: 55 },
      { t: 5.0, handsPlane: -1.0, lag: 55 }
    ]);
  }

  // 5 normal after: P6 around 4.7 in (still high, no carry-over)
  for (let i = 1; i <= 5; i++) {
    const name = `swing_face_a_${i}.mp4`;
    clips.push(makeClip(name, `2026-09-30T10:2${i}:00`, null, "I7"));
    records[name] = makeRecord(4.7);
  }

  const sets = DrillSets.sets(clips, records);
  assert.strictEqual(sets.length, 1);
  const s = sets[0];
  const verd = DrillSets.verdict(s);
  assert.strictEqual(verd.level, "none");
  assert.strictEqual(verd.text, "no carry-over yet");
});

test("too few swings below minimum", () => {
  const clips = [];
  const records = {};

  // Only 2 drill swings and 2 normal swings
  clips.push(makeClip("c1", "2026-09-30T10:01:00", "pump", "I7"));
  records["c1"] = makeRecord(4.5, [{ t: 3.5, handsPlane: -1.0, lag: 50 }]);
  clips.push(makeClip("c2", "2026-09-30T10:02:00", "pump", "I7"));
  records["c2"] = makeRecord(4.5, [{ t: 3.5, handsPlane: -1.0, lag: 50 }]);

  clips.push(makeClip("c3", "2026-09-30T10:05:00", null, "I7"));
  records["c3"] = makeRecord(4.5);
  clips.push(makeClip("c4", "2026-09-30T10:06:00", null, "I7"));
  records["c4"] = makeRecord(4.5);

  const sets = DrillSets.sets(clips, records);
  assert.strictEqual(sets.length, 1);
  assert.strictEqual(sets[0].count, 2);

  const verd = DrillSets.verdict(sets[0]);
  assert.strictEqual(verd.level, "few");
  assert.strictEqual(verd.text, "too few swings");
});

test("a set with no normal swings around it", () => {
  const clips = [];
  const records = {};

  for (let i = 1; i <= 5; i++) {
    const name = `c_solo_${i}`;
    clips.push(makeClip(name, `2026-09-30T10:0${i}:00`, "pump", "I7"));
    records[name] = makeRecord(4.0, [{ t: 3.5, handsPlane: -1.0, lag: 55 }]);
  }

  const sets = DrillSets.sets(clips, records);
  assert.strictEqual(sets.length, 1);
  const s = sets[0];
  assert.strictEqual(s.before.count, 0);
  assert.strictEqual(s.after.count, 0);

  const verd = DrillSets.verdict(s);
  assert.strictEqual(verd.level, "few");
  assert.strictEqual(verd.text, "too few swings");
});

test("two sets in one day", () => {
  const clips = [];
  const records = {};

  // Set 1 (morning): 4 drill swings, 4 normal after
  for (let i = 1; i <= 4; i++) {
    const name = `set1_d_${i}`;
    clips.push(makeClip(name, `2026-09-30T09:0${i}:00`, "pump", "I7"));
    records[name] = makeRecord(4.0, [{ t: 3.5, handsPlane: -1.0, lag: 50 }]);
  }
  for (let i = 1; i <= 4; i++) {
    const name = `set1_a_${i}`;
    clips.push(makeClip(name, `2026-09-30T09:1${i}:00`, null, "I7"));
    records[name] = makeRecord(4.2);
  }

  // Set 2 (afternoon, 4 hours later): 4 drill swings, 4 normal after
  for (let i = 1; i <= 4; i++) {
    const name = `set2_d_${i}`;
    clips.push(makeClip(name, `2026-09-30T14:0${i}:00`, "pump", "I7"));
    records[name] = makeRecord(3.0, [{ t: 3.5, handsPlane: -1.2, lag: 55 }]);
  }
  for (let i = 1; i <= 4; i++) {
    const name = `set2_a_${i}`;
    clips.push(makeClip(name, `2026-09-30T14:1${i}:00`, null, "I7"));
    records[name] = makeRecord(2.5);
  }

  const sets = DrillSets.sets(clips, records);
  assert.strictEqual(sets.length, 2);
  // Newest first: sets[0] is afternoon set, sets[1] is morning set
  assert.strictEqual(sets[0].clips[0], "set2_d_1");
  assert.strictEqual(sets[1].clips[0], "set1_d_1");
  assert.strictEqual(sets[0].after.count, 4);
  assert.strictEqual(sets[1].after.count, 4);
});

test("real Sep 30 data: 10 pump drill swings, 14 normal after (1 null left out)", () => {
  // Fixture extracted from live devproxy Sep 30 session
  const realClips = [
    // 10 drill swings
    makeClip("face_d1", "2026-09-30T12:52:51", "pump", "I7"),
    makeClip("face_d2", "2026-09-30T12:53:10", "pump", "I7"),
    makeClip("face_d3", "2026-09-30T12:53:34", "pump", "I7"),
    makeClip("face_d4", "2026-09-30T12:53:54", "pump", "I7"),
    makeClip("face_d5", "2026-09-30T12:54:14", "pump", "I7"),
    makeClip("face_d6", "2026-09-30T12:54:33", "pump", "I7"),
    makeClip("face_d7", "2026-09-30T12:54:55", "pump", "I7"),
    makeClip("face_d8", "2026-09-30T12:55:15", "pump", "I7"),
    makeClip("face_d9", "2026-09-30T12:55:41", "pump", "I7"),
    makeClip("face_d10", "2026-09-30T12:56:04", "pump", "I7"),
    // 14 normal I7 swings
    makeClip("face_n1", "2026-09-30T12:57:00", null, "I7"),
    makeClip("face_n2", "2026-09-30T12:57:24", null, "I7"),
    makeClip("face_n3", "2026-09-30T12:57:44", null, "I7"),
    makeClip("face_n4", "2026-09-30T12:58:07", null, "I7"),
    makeClip("face_n5", "2026-09-30T12:58:48", null, "I7"),
    makeClip("face_n6", "2026-09-30T12:59:37", null, "I7"),
    makeClip("face_n7", "2026-09-30T13:00:02", null, "I7"),
    makeClip("face_n8", "2026-09-30T13:00:23", null, "I7"),
    makeClip("face_n9", "2026-09-30T13:00:55", null, "I7"),
    makeClip("face_n10", "2026-09-30T13:01:23", null, "I7"), // null handsPlaneP6
    makeClip("face_n11", "2026-09-30T13:01:43", null, "I7"),
    makeClip("face_n12", "2026-09-30T13:02:05", null, "I7"),
    makeClip("face_n13", "2026-09-30T13:02:25", null, "I7"),
    makeClip("face_n14", "2026-09-30T13:02:47", null, "I7"),
    // 3 I8 swings (should be ignored for I7 normal swings)
    makeClip("face_n15", "2026-09-30T13:03:29", null, "I8"),
    makeClip("face_n16", "2026-09-30T13:03:57", null, "I8"),
    makeClip("face_n17", "2026-09-30T13:04:19", null, "I8")
  ];

  const realSwings = {
    face_d1: makeRecord(6.03, [{ t: 3.8, handsPlane: 1.17, lag: 44.5 }, { t: 5.1, handsPlane: -0.39, lag: 45.0 }]),
    face_d2: makeRecord(3.47, [{ t: 3.6, handsPlane: -2.11, lag: 58.5 }, { t: 5.1, handsPlane: -0.88, lag: 65.0 }]),
    face_d3: makeRecord(4.73, [{ t: 3.9, handsPlane: -2.72, lag: 67.7 }, { t: 5.2, handsPlane: -1.15, lag: 70.5 }]),
    face_d4: makeRecord(4.83, [{ t: 3.8, handsPlane: -1.01, lag: 66.6 }, { t: 5.2, handsPlane: -2.93, lag: 54.2 }]),
    face_d5: makeRecord(3.79, [{ t: 3.6, handsPlane: -0.93, lag: 65.5 }, { t: 4.9, handsPlane: -0.11, lag: 62.5 }]),
    face_d6: makeRecord(5.07, [{ t: 3.8, handsPlane: -0.36, lag: 49.5 }, { t: 5.1, handsPlane: -0.29, lag: 50.1 }]),
    face_d7: makeRecord(5.40, [{ t: 3.8, handsPlane: -1.58, lag: 50.6 }, { t: 5.2, handsPlane: -0.93, lag: 53.4 }]),
    face_d8: makeRecord(4.76, [{ t: 3.6, handsPlane: 0.11, lag: 49.6 }, { t: 4.9, handsPlane: 1.47, lag: 53.4 }]),
    face_d9: makeRecord(4.46, [{ t: 3.9, handsPlane: 1.40, lag: 76.4 }, { t: 5.3, handsPlane: -1.04, lag: 66.5 }]),
    face_d10: makeRecord(2.69, [{ t: 4.0, handsPlane: 0.54, lag: 61.5 }, { t: 5.3, handsPlane: -1.16, lag: 46.5 }]),

    face_n1: makeRecord(4.02),
    face_n2: makeRecord(4.00),
    face_n3: makeRecord(5.46),
    face_n4: makeRecord(3.96),
    face_n5: makeRecord(4.01),
    face_n6: makeRecord(5.50),
    face_n7: makeRecord(4.58),
    face_n8: makeRecord(4.29),
    face_n9: makeRecord(4.07),
    face_n10: makeRecord(null), // missing P6
    face_n11: makeRecord(5.19),
    face_n12: makeRecord(5.49),
    face_n13: makeRecord(4.96),
    face_n14: makeRecord(4.15),

    face_n15: makeRecord(4.72),
    face_n16: makeRecord(5.09),
    face_n17: makeRecord(3.46)
  };

  const sets = DrillSets.sets(realClips, realSwings);
  assert.strictEqual(sets.length, 1);
  const s = sets[0];
  assert.strictEqual(s.drill, "pump");
  assert.strictEqual(s.club, "I7");
  assert.strictEqual(s.count, 10);
  assert.strictEqual(s.firstClip, "face_d1");

  // Pumps median around -0.9 in, lag around 56 deg
  assert.ok(Math.abs(s.pumps.handsPlane - (-0.9)) < 0.1);
  assert.ok(Math.abs(s.pumps.lag - 56.3) < 0.5);

  // Drill swings P6 median around 4.7 in
  assert.ok(Math.abs(s.drillP6 - 4.75) < 0.1);

  // Normal swings: 0 before, 13 after (1 of 14 left out)
  assert.strictEqual(s.before.count, 0);
  assert.strictEqual(s.after.count, 13);
  assert.strictEqual(s.leftOut, 1);
  assert.ok(Math.abs(s.after.median - 4.29) < 0.1);

  // Nothing to compare with (no normal 7 irons before, no earlier sessions): too few swings.
  assert.strictEqual(DrillSets.verdict(s).level, "few");

  // With earlier sessions' 7 irons (Sep 28, ~4.4 in), "before" is those: your usual.
  const usual = [4.1, 4.9, 3.8, 4.6, 4.4, 5.0, 4.2];
  const earlierClips = usual.map((v, i) => makeClip(`face_u${i}`, `2026-09-28T18:0${i}:00`, null, "I7"));
  const withUsual = { ...realSwings };
  usual.forEach((v, i) => { withUsual[`face_u${i}`] = makeRecord(v); });
  const s2 = DrillSets.sets([...earlierClips, ...realClips], withUsual)[0];
  assert.strictEqual(s2.before.earlier, true);
  assert.strictEqual(s2.before.count, usual.length);
  assert.strictEqual(s2.leftOut, 1);
  const verd = DrillSets.verdict(s2);
  assert.strictEqual(verd.level, "none");
  assert.strictEqual(verd.text, "no carry-over yet");

  // Formatted line
  const line = DrillSets.formatSet(s2, verd);
  assert.ok(line.includes("(your usual 4.4 in)"));
  assert.ok(line.includes("Pump drill, Sep 30 (10 swings, 7 iron)"));
  assert.ok(line.includes("pumps -0.9 in"));
  assert.ok(line.includes("drill swings' hands in the downswing 4.7 in"));
  assert.ok(line.includes("your swings after 4.3 in"));
  assert.ok(line.includes("no carry-over yet"));
  assert.ok(line.includes("(1 left out)"));
});

test("thoughtFor: retrieves thought for pump drill or focus move, edge cases", () => {
  // Pump drill set
  const pumpSet = { drill: "pump" };
  assert.equal(DrillSets.thoughtFor(pumpSet, null), "Hands drop to the trail pocket.");

  // Focus move with aim
  const focus = { move: "hipSway", aim: "less" };
  assert.equal(DrillSets.thoughtFor(null, focus), "Belt buckle to the target, not to the side.");

  // Focus move without aim or unknown move returns null
  assert.equal(DrillSets.thoughtFor(null, { move: "hipSway" }), null);
  assert.equal(DrillSets.thoughtFor(null, { move: "unknownMove", aim: "less" }), null);

  // Both null or empty returns null
  assert.equal(DrillSets.thoughtFor(null, null), null);
  assert.equal(DrillSets.thoughtFor({}, {}), null);
});

test("SHORT_LEAD_S is exported and is 4", () => {
  assert.strictEqual(DrillSets.SHORT_LEAD_S, 4);
});

test("isNormal and isMatchingClub skip clip.excluded swings", () => {
  const clips = [];
  const records = {};

  // 4 normal swings before, but 2 are excluded
  for (let i = 1; i <= 4; i++) {
    const name = `b_${i}`;
    const excluded = i <= 2;
    clips.push(makeClip(name, `2026-10-09T10:0${i}:00`, null, "I7", "face", null, { excluded }));
    records[name] = makeRecord(5.0);
  }

  // 3 pump drill swings (marked afterwards, short)
  for (let i = 1; i <= 3; i++) {
    const name = `d_${i}`;
    clips.push(makeClip(name, `2026-10-09T10:1${i}:00`, "pump", "I7", "face", null, { strike: 2.0, drillMarked: true }));
    records[name] = { body: { handsPlaneP6: null }, drill: { kind: "pump", pumps: [] } };
  }

  // 4 normal swings after, but 2 are excluded
  for (let i = 1; i <= 4; i++) {
    const name = `a_${i}`;
    const excluded = i > 2;
    clips.push(makeClip(name, `2026-10-09T10:2${i}:00`, null, "I7", "face", null, { excluded }));
    records[name] = makeRecord(4.0);
  }

  const s = DrillSets.sets(clips, records)[0];
  // Since 2 swings before and 2 swings after were excluded, only 2 normal swings remain before and after!
  assert.strictEqual(s.before.count, 2);
  assert.strictEqual(s.after.count, 2);
});

test("marked and short counts, leftOut leaves out short swings with no reading", () => {
  const clips = [];
  const records = {};

  // 5 pump drill swings:
  // 3 are short (strike: 1.9, drillMarked: true, no P6 reading)
  // 1 is not short (strike: 4.0, drillMarked: false, valid P6 reading)
  // 1 is not short (strike: 6.1, drillMarked: false, null P6 reading -> shaky/missing -> left out)
  clips.push(makeClip("d1", "2026-10-09T10:11:00", "pump", "I7", "face", null, { strike: 1.9, drillMarked: true }));
  records["d1"] = { body: { handsPlaneP6: null }, drill: { kind: "pump", pumps: [] } };

  clips.push(makeClip("d2", "2026-10-09T10:12:00", "pump", "I7", "face", null, { strike: 1.9, drillMarked: true }));
  records["d2"] = { body: { handsPlaneP6: null }, drill: { kind: "pump", pumps: [] } };

  clips.push(makeClip("d3", "2026-10-09T10:13:00", "pump", "I7", "face", null, { strike: 1.9, drillMarked: true }));
  records["d3"] = { body: { handsPlaneP6: null }, drill: { kind: "pump", pumps: [] } };

  clips.push(makeClip("d4", "2026-10-09T10:14:00", "pump", "I7", "face", null, { strike: 4.0 }));
  records["d4"] = makeRecord(4.5);

  clips.push(makeClip("d5", "2026-10-09T10:15:00", "pump", "I7", "face", null, { strike: 6.1 }));
  records["d5"] = makeRecord(null); // non-short missing P6 -> counted in drillLeftOut

  const s = DrillSets.sets(clips, records)[0];
  assert.strictEqual(s.count, 5);
  assert.strictEqual(s.short, 3);
  assert.strictEqual(s.marked, 3);
  // Only d5 is left out; d1, d2, d3 are short so they are NOT in leftOut or leftOutDetail.drill
  assert.strictEqual(s.leftOut, 1);
  assert.strictEqual(s.leftOutDetail.drill, 1);
});

test("direction verdicts: clear, maybe, none, few with hand-calculated arithmetic", () => {
  // Arithmetic derivation:
  // Before group: 4 swings with values [4.0, 5.0, 5.0, 6.0].
  //   Mean = 5.0, Median mBefore = 5.0.
  //   SS_before = (4-5)^2 + (5-5)^2 + (5-5)^2 + (6-5)^2 = 1 + 0 + 0 + 1 = 2.
  //   df_before = 4 - 1 = 3.
  //
  // After group: 4 swings with values [mAfter - 1, mAfter, mAfter, mAfter + 1].
  //   Mean = mAfter, Median mAfter.
  //   SS_after = (-1)^2 + 0^2 + 0^2 + 1^2 = 2.
  //   df_after = 4 - 1 = 3.
  //
  // Pooled variance:
  //   within = sqrt((SS_before + SS_after) / (df_before + df_after))
  //          = sqrt((2 + 2) / (3 + 3)) = sqrt(4 / 6) = sqrt(2 / 3) approx 0.8164966.
  // Wobble:
  //   wobble = 1.25 * within * sqrt(1/4 + 1/4)
  //          = 1.25 * sqrt(2/3) * sqrt(1/2) = 1.25 * sqrt(1/3) = 1.25 / sqrt(3) approx 0.7216878.
  //
  // 1) CLEAR (size >= 2.0):
  //    Let mAfter = 3.0: values [2.0, 3.0, 3.0, 4.0].
  //    delta = mBefore - mAfter = 5.0 - 3.0 = 2.0.
  //    size = 2.0 / (1.25 / sqrt(3)) = 1.6 * sqrt(3) approx 2.77128 >= 2.0 -> "clear".
  {
    const setClear = {
      short: 4,
      pumps: { handsPlane: null },
      before: { count: 4, median: 5.0, swings: [4.0, 5.0, 5.0, 6.0] },
      after: { count: 4, median: 3.0, swings: [2.0, 3.0, 3.0, 4.0] }
    };
    const v = DrillSets.verdict(setClear);
    assert.strictEqual(v.basis, "direction");
    assert.strictEqual(v.level, "clear");
    assert.strictEqual(v.text, "the hands came down clearly lower in your swings after the drill");
    assert.ok(Math.abs(v.delta - 2.0) < 1e-6);
    assert.ok(Math.abs(v.wobble - (1.25 / Math.sqrt(3))) < 1e-6);
    assert.ok(Math.abs(v.size - (1.6 * Math.sqrt(3))) < 1e-6);
  }

  // 2) MAYBE (1.5 <= size < 2.0):
  //    Let mAfter = 3.8: values [2.8, 3.8, 3.8, 4.8].
  //    delta = 5.0 - 3.8 = 1.2.
  //    size = 1.2 / (1.25 / sqrt(3)) = 0.96 * sqrt(3) approx 1.66277 -> "maybe".
  {
    const setMaybe = {
      short: 4,
      pumps: { handsPlane: null },
      before: { count: 4, median: 5.0, swings: [4.0, 5.0, 5.0, 6.0] },
      after: { count: 4, median: 3.8, swings: [2.8, 3.8, 3.8, 4.8] }
    };
    const v = DrillSets.verdict(setMaybe);
    assert.strictEqual(v.basis, "direction");
    assert.strictEqual(v.level, "maybe");
    assert.strictEqual(v.text, "the hands maybe came down lower in your swings after the drill");
    assert.ok(Math.abs(v.delta - 1.2) < 1e-6);
    assert.ok(Math.abs(v.size - (0.96 * Math.sqrt(3))) < 1e-6);
  }

  // 3) NONE:
  //    3a) size < 1.5:
  //        Let mAfter = 4.5: values [3.5, 4.5, 4.5, 5.5].
  //        delta = 5.0 - 4.5 = 0.5.
  //        size = 0.5 / (1.25 / sqrt(3)) = 0.4 * sqrt(3) approx 0.6928 < 1.5 -> "none".
  {
    const setNone = {
      short: 4,
      pumps: { handsPlane: null },
      before: { count: 4, median: 5.0, swings: [4.0, 5.0, 5.0, 6.0] },
      after: { count: 4, median: 4.5, swings: [3.5, 4.5, 4.5, 5.5] }
    };
    const v = DrillSets.verdict(setNone);
    assert.strictEqual(v.basis, "direction");
    assert.strictEqual(v.level, "none");
    assert.strictEqual(v.text, "no change in your swings after the drill");
    assert.ok(Math.abs(v.delta - 0.5) < 1e-6);
  }
  //    3b) delta <= 0 (hands higher after):
  {
    const setHigher = {
      short: 4,
      pumps: { handsPlane: null },
      before: { count: 4, median: 5.0, swings: [4.0, 5.0, 5.0, 6.0] },
      after: { count: 4, median: 5.5, swings: [4.5, 5.5, 5.5, 6.5] }
    };
    const v = DrillSets.verdict(setHigher);
    assert.strictEqual(v.basis, "direction");
    assert.strictEqual(v.level, "none");
    assert.strictEqual(v.text, "no change in your swings after the drill");
    assert.ok(v.delta < 0);
  }

  // 4) FEW:
  //    4a) fewer than MIN_SWINGS after:
  {
    const setFewAfter = {
      short: 4,
      pumps: { handsPlane: null },
      before: { count: 4, median: 5.0, swings: [4.0, 5.0, 5.0, 6.0] },
      after: { count: 2, median: 3.0, swings: [2.5, 3.5] }
    };
    const v = DrillSets.verdict(setFewAfter);
    assert.strictEqual(v.basis, "direction");
    assert.strictEqual(v.level, "few");
    assert.strictEqual(v.text, "too few swings after the drill");
  }
  //    4b) fewer than MIN_SWINGS before:
  {
    const setFewBefore = {
      short: 4,
      pumps: { handsPlane: null },
      before: { count: 2, median: 5.0, swings: [4.5, 5.5] },
      after: { count: 4, median: 3.0, swings: [2.0, 3.0, 3.0, 4.0] }
    };
    const v = DrillSets.verdict(setFewBefore);
    assert.strictEqual(v.basis, "direction");
    assert.strictEqual(v.level, "few");
    assert.strictEqual(v.text, "too few swings");
  }

  // 5) No pumps and no short swings stays too few swings as before
  {
    const setNoShort = {
      short: 0,
      pumps: { handsPlane: null },
      before: { count: 4, median: 5.0, swings: [4.0, 5.0, 5.0, 6.0] },
      after: { count: 4, median: 3.0, swings: [2.0, 3.0, 3.0, 4.0] }
    };
    const v = DrillSets.verdict(setNoShort);
    assert.strictEqual(v.level, "few");
    assert.strictEqual(v.text, "too few swings");
    assert.strictEqual(v.basis, undefined);
  }
});

test("formatSet for direction sets, marked afterwards, mixed sets, and standard sets", () => {
  // Case 1: Direction set marked afterwards (all 12 swings marked and short, clear verdict)
  const set1 = {
    drill: "pump",
    dateFormatted: "Oct 9",
    count: 12,
    marked: 12,
    short: 12,
    club: "I7",
    clubName: "7 iron",
    leftOut: 0,
    pumps: { handsPlane: null },
    drillP6: null,
    before: { count: 15, median: 5.0, earlier: true },
    after: { count: 14, median: 4.0 }
  };
  const verd1 = { basis: "direction", level: "clear", text: "the hands came down clearly lower in your swings after the drill" };
  const line1 = DrillSets.formatSet(set1, verd1);
  assert.strictEqual(
    line1,
    "Pump drill, Oct 9 (12 swings, 7 iron, marked afterwards): the videos start after the pumps, so no pump numbers. Your swings after 4.0 in (your usual 5.0 in): the hands came down clearly lower in your swings after the drill."
  );

  // Case 2: Mixed set (3 of 10 short, has pump numbers)
  const set2 = {
    drill: "pump",
    dateFormatted: "Oct 9",
    count: 10,
    marked: 0,
    short: 3,
    club: "I7",
    clubName: "7 iron",
    leftOut: 0,
    pumps: { handsPlane: -0.9 },
    drillP6: 4.7,
    before: { count: 7, median: 4.4, earlier: false },
    after: { count: 10, median: 4.3 }
  };
  const verd2 = { basis: "pumps", level: "none", text: "no carry-over yet" };
  const line2 = DrillSets.formatSet(set2, verd2);
  assert.strictEqual(
    line2,
    "Pump drill, Oct 9 (10 swings, 7 iron): 3 of them start after the pumps. Pumps -0.9 in, drill swings' hands in the downswing 4.7 in, your swings after 4.3 in (before 4.4 in): no carry-over yet."
  );

  // Case 3: Direction set with too few swings after
  const set3 = {
    drill: "pump",
    dateFormatted: "Oct 9",
    count: 5,
    marked: 5,
    short: 5,
    club: "I7",
    clubName: "7 iron",
    leftOut: 0,
    pumps: { handsPlane: null },
    drillP6: null,
    before: { count: 5, median: 5.0, earlier: false },
    after: { count: 2, median: 4.0 }
  };
  const verd3 = { basis: "direction", level: "few", text: "too few swings after the drill" };
  const line3 = DrillSets.formatSet(set3, verd3);
  assert.strictEqual(
    line3,
    "Pump drill, Oct 9 (5 swings, 7 iron, marked afterwards): the videos start after the pumps, so no pump numbers. Your swings after 4.0 in (before 5.0 in): too few swings after the drill."
  );
});



test("a normal swing or two between drill swings doesn't make two sets", () => {
  const clips = [], records = {};
  const add = (name, min, drill, hands, pumps) => {
    clips.push(makeClip(name, `2026-10-09T16:${String(min).padStart(2, "0")}:00`, drill, "I7"));
    records[name] = makeRecord(hands, pumps);
  };
  const pumps = [{ t: 3.5, handsPlane: -1.0, lag: 50 }];
  for (let i = 0; i < 4; i++) add(`b${i}`, i, null, 5.0);
  for (let i = 0; i < 5; i++) add(`d${i}`, 10 + i, "pump", 3.0, pumps);
  add("mid", 15, null, 5.1);                                   // one normal swing mid-drill
  for (let i = 5; i < 9; i++) add(`d${i}`, 11 + i, "pump", 3.0, pumps);
  for (let i = 0; i < 4; i++) add(`a${i}`, 30 + i, null, 4.0);

  const sets = DrillSets.sets(clips, records);
  assert.strictEqual(sets.length, 1);
  assert.strictEqual(sets[0].count, 9);
  // The swing in the middle is neither before nor after.
  assert.strictEqual(sets[0].before.count, 4);
  assert.strictEqual(sets[0].after.count, 4);
  assert.strictEqual(sets[0].after.median, 4.0);
});

test("more than SET_BREAK swings between them: two sets", () => {
  const clips = [], records = {};
  const add = (name, min, drill, hands) => {
    clips.push(makeClip(name, `2026-10-09T16:${String(min).padStart(2, "0")}:00`, drill, "I7"));
    records[name] = makeRecord(hands, drill ? [{ t: 3.5, handsPlane: -1.0, lag: 50 }] : null);
  };
  for (let i = 0; i < 3; i++) add(`d${i}`, i, "pump", 3.0);
  for (let i = 0; i <= DrillSets.SET_BREAK; i++) add(`n${i}`, 5 + i, null, 5.0);
  for (let i = 3; i < 6; i++) add(`d${i}`, 10 + i, "pump", 3.0);
  const sets = DrillSets.sets(clips, records);
  assert.strictEqual(sets.length, 2);
  assert.strictEqual(sets[1].after.count, DrillSets.SET_BREAK + 1);
});

// ---- Round 58: a set for every drill that trains a number (a focus's reps) ----

/** Clips and records of one session: normal swings, then reps of `drill`, then normal swings again. */
function repsSession({ drill, metric, before = [], reps = [], after = [], day = "2026-10-12", club = "I7", extra = {} }) {
  const clips = [], records = {};
  let min = 0;
  const add = (name, v, d, more) => {
    const mm = String(min++).padStart(2, "0");
    clips.push(makeClip(name, `${day}T16:${mm}:00`, d, club, "face", null, more));
    records[name] = { body: { [metric]: v }, drill: null, quality: { swingFound: true, p6Estimated: false, camera: { face: [], dtl: [] } } };
  };
  before.forEach((v, i) => add(`b${i}`, v, null));
  reps.forEach((v, i) => add(`r${i}`, v, drill, { excluded: true, strike: 2.1, ...extra }));
  after.forEach((v, i) => add(`a${i}`, v, null));
  return { clips, records };
}
const around = m => [m - 1, m, m, m + 1];   // four swings, median m, sum of squares 2

test("trained: the pump, a move either way, and nothing else", () => {
  assert.deepStrictEqual(DrillSets.trained("pump"), { metric: "handsPlaneP6", aim: "less" });
  assert.deepStrictEqual(DrillSets.trained("move:leadHipP6:more"), { metric: "leadHipP6", aim: "more" });
  assert.deepStrictEqual(DrillSets.trained("move:hipSway:less"), { metric: "hipSway", aim: "less" });
  assert.strictEqual(DrillSets.trained("move:nope:more"), null);          // not a move the coach knows
  assert.strictEqual(DrillSets.trained("move:leadHipP6:sideways"), null); // not a way
  assert.strictEqual(DrillSets.trained("flush"), null);                   // a coach program's block
  assert.strictEqual(DrillSets.trained(null), null);
});

test("a reps set: its fields, the reps' own number, before and after on that number", () => {
  const { clips, records } = repsSession({
    drill: "move:leadHipP6:more", metric: "leadHipP6",
    before: [1.8, 1.9, 2.0, 1.9, 1.9], reps: [2.5, 2.6, 2.7, 2.6, 2.6], after: [2.2, 2.3, 2.4, 2.3, 2.3] });
  const [s] = DrillSets.sets(clips, records);
  assert.strictEqual(s.drill, "move:leadHipP6:more");
  assert.strictEqual(s.metric, "leadHipP6");
  assert.strictEqual(s.aim, "more");
  assert.strictEqual(s.count, 5);
  assert.deepStrictEqual({ n: s.reps.count, m: s.reps.median }, { n: 5, m: 2.6 });
  assert.deepStrictEqual({ n: s.before.count, m: s.before.median, earlier: s.before.earlier }, { n: 5, m: 1.9, earlier: false });
  assert.deepStrictEqual({ n: s.after.count, m: s.after.median }, { n: 5, m: 2.3 });
  // Reps are ordinary swings, whole in a 2 s video: never "short", and no pump fields.
  assert.strictEqual(s.short, 0);
  assert.strictEqual(s.pumps, undefined);
  // Each group: deviations -0.1, 0, 0.1, 0, 0 -> sum of squares 0.02; pooled sqrt(0.06 / 12) = 0.0707.
  // Wobble 1.25 * 0.0707 * sqrt(1/5 + 1/5) = 0.0559. Reps +0.7 (size 12.5), after +0.4 (size 7.2): both clear.
  const v = DrillSets.verdict(s);
  assert.strictEqual(v.basis, "reps");
  assert.strictEqual(v.repsMoved, "clear");
  assert.strictEqual(v.afterMoved, "clear");
  assert.strictEqual(v.text, "clear carry-over into your swings");
  assert.ok(Math.abs(v.afterWobble - 0.0559) < 0.0005);
  assert.strictEqual(DrillSets.nameOf(s), "Reps: the lead hip getting to the target in the downswing");
  assert.strictEqual(DrillSets.formatSet(s),
    "Reps: the lead hip getting to the target in the downswing, Oct 12 (5 reps, 7 iron): reps 2.6 in, your swings after 2.3 in (before 1.9 in): clear carry-over into your swings.");
  assert.strictEqual(DrillSets.thoughtFor(s), require("../static/coach.js").MOVES.leadHipP6.more.thought);
});

// Three groups of four with deviations -1, 0, 0, 1 (sum of squares 2 each): pooled sqrt(6 / 9) = 0.8165,
// wobble 1.25 * 0.8165 * sqrt(1/4 + 1/4) = 0.7217. So a move of 2 is clear (size 2.77), 1.2 maybe (1.66),
// 0.5 none (0.69). Aim "more": up is the aimed way.
const repsVerdict = (o) => {
  const { clips, records } = repsSession({ drill: "move:shoulderTop:more", metric: "shoulderTop", ...o });
  const [s] = DrillSets.sets(clips, records);
  return { s, v: DrillSets.verdict(s) };
};

test("reps verdicts, aim more: each wording", () => {
  let r = repsVerdict({ before: around(90), reps: around(92), after: around(91.2) });
  assert.deepStrictEqual([r.v.repsMoved, r.v.afterMoved, r.v.text], ["clear", "maybe", "maybe carrying over"]);
  assert.strictEqual(DrillSets.formatSet(r.s),
    "Reps: a fuller shoulder turn, Oct 12 (4 reps, 7 iron): reps 92.0°, your swings after 91.2° (before 90.0°): maybe carrying over.");

  r = repsVerdict({ before: around(90), reps: around(92), after: around(90.5) });
  assert.deepStrictEqual([r.v.repsMoved, r.v.afterMoved, r.v.text], ["clear", "none", "there in the reps, but no carry-over yet"]);

  r = repsVerdict({ before: around(90), reps: around(91.2), after: around(90.5) });
  assert.deepStrictEqual([r.v.repsMoved, r.v.afterMoved, r.v.text], ["maybe", "none", "there in the reps, but no carry-over yet"]);

  r = repsVerdict({ before: around(90), reps: around(90.5), after: around(90.3) });
  assert.deepStrictEqual([r.v.repsMoved, r.v.afterMoved, r.v.text], ["none", "none", "no change in the reps or after"]);

  // The wrong way is no change, however far.
  r = repsVerdict({ before: around(90), reps: around(86), after: around(87) });
  assert.deepStrictEqual([r.v.repsMoved, r.v.afterMoved, r.v.text], ["none", "none", "no change in the reps or after"]);

  // Two swings after ([90, 90], sum of squares 0): pooled sqrt(4 / 7) = 0.756, wobble for 4 against 4 = 0.668.
  // Reps +2 = size 2.99 clear; +1.2 = size 1.80 maybe.
  r = repsVerdict({ before: around(90), reps: around(92), after: [90, 90] });
  assert.deepStrictEqual([r.v.repsMoved, r.v.afterMoved, r.v.text], ["clear", "few", "clearly there in the reps, too few swings after"]);
  r = repsVerdict({ before: around(90), reps: around(91.2), after: [90, 90] });
  assert.deepStrictEqual([r.v.repsMoved, r.v.afterMoved, r.v.text], ["maybe", "few", "maybe there in the reps, too few swings after"]);
  r = repsVerdict({ before: around(90), reps: around(90.5), after: [90, 90] });
  assert.strictEqual(r.v.text, "too few swings");

  // Nothing to set them against: two swings before.
  r = repsVerdict({ before: [90, 90], reps: around(92), after: around(92) });
  assert.deepStrictEqual([r.v.repsMoved, r.v.afterMoved, r.v.text, r.v.level], ["few", "few", "too few swings", "few"]);
});

test("reps verdicts, aim less: down is the aimed way", () => {
  const less = o => {
    const { clips, records } = repsSession({ drill: "move:hipSway:less", metric: "hipSway", ...o });
    const [s] = DrillSets.sets(clips, records);
    return { s, v: DrillSets.verdict(s) };
  };
  // Same sizes as above with the sign turned: 10 -> 8 in the reps (clear), 8.8 after (1.2 less: maybe).
  let r = less({ before: around(10), reps: around(8), after: around(8.8) });
  assert.strictEqual(r.s.aim, "less");
  assert.deepStrictEqual([r.v.repsMoved, r.v.afterMoved, r.v.text], ["clear", "maybe", "maybe carrying over"]);
  assert.ok(r.v.repsDelta > 0 && r.v.afterDelta > 0);
  assert.match(DrillSets.formatSet(r.s), /^Reps: less hip slide, more rotation, Oct 12 \(4 reps, 7 iron\): reps 8\.0 in, your swings after 8\.8 in \(before 10\.0 in\): maybe carrying over\.$/);
  // More of it is the wrong way for "less".
  r = less({ before: around(10), reps: around(12), after: around(11.2) });
  assert.deepStrictEqual([r.v.repsMoved, r.v.afterMoved, r.v.text], ["none", "none", "no change in the reps or after"]);
  assert.ok(r.v.repsDelta < 0);
});

test("reps at the start of a session are set against the usual of earlier sessions", () => {
  const earlier = repsSession({ drill: "move:shoulderTop:more", metric: "shoulderTop", day: "2026-10-10", before: around(90) });
  const today = repsSession({ drill: "move:shoulderTop:more", metric: "shoulderTop", reps: around(92), after: around(92) });
  const clips = [...earlier.clips.map(c => ({ ...c, name: "e_" + c.name })), ...today.clips];
  const records = { ...today.records };
  for (const [k, v] of Object.entries(earlier.records)) records["e_" + k] = v;
  const [s] = DrillSets.sets(clips, records);
  assert.strictEqual(s.before.earlier, true);
  assert.strictEqual(s.before.median, 90);
  assert.match(DrillSets.formatSet(s), /your swings after 92\.0° \(your usual 90\.0°\): clear carry-over into your swings\.$/);
});

test("a swing left out by hand never counts before or after a reps set", () => {
  const { clips, records } = repsSession({ drill: "move:shoulderTop:more", metric: "shoulderTop",
    before: around(90), reps: around(92), after: [...around(92), 60] });
  clips[clips.length - 1].excluded = true;   // someone else's swing
  const [s] = DrillSets.sets(clips, records);
  assert.strictEqual(s.after.count, 4);
  assert.strictEqual(s.after.median, 92);
});

test("reps marked afterwards say so; a number with no reading is left out and counted", () => {
  const { clips, records } = repsSession({ drill: "move:shoulderTop:more", metric: "shoulderTop",
    before: around(90), reps: [...around(92), null], after: around(92), extra: { drillMarked: true } });
  const [s] = DrillSets.sets(clips, records);
  assert.strictEqual(s.count, 5);
  assert.strictEqual(s.marked, 5);
  assert.strictEqual(s.reps.count, 4);
  assert.strictEqual(s.leftOut, 1);
  assert.match(DrillSets.formatSet(s), /\(5 reps, 7 iron, marked afterwards\): reps 92\.0°.*\(1 left out\)$/);
});

test("values carry the number's own unit and decimals", () => {
  assert.strictEqual(DrillSets.formatValue(91.23, "shoulderTop"), "91.2°");
  assert.strictEqual(DrillSets.formatValue(2.64, "leadHipP6"), "2.6 in");
  assert.strictEqual(DrillSets.formatValue(0.791, "backswing"), "0.79 s");
  assert.strictEqual(DrillSets.formatValue(4.26, "notANumberWeKnow"), "4.3");
  assert.strictEqual(DrillSets.formatValue(null, "leadHipP6"), "–");
});

test("the pump keeps its set as it was, with its number and way added", () => {
  const clips = [], records = {};
  for (let i = 0; i < 4; i++) { clips.push(makeClip(`b${i}`, `2026-09-30T09:0${i}:00`, null, "I7")); records[`b${i}`] = makeRecord(4.4); }
  for (let i = 0; i < 4; i++) { clips.push(makeClip(`d${i}`, `2026-09-30T09:1${i}:00`, "pump", "I7")); records[`d${i}`] = makeRecord(3.0, [{ t: 3.5, handsPlane: -1.0, lag: 50 }]); }
  const [s] = DrillSets.sets(clips, records);
  assert.deepStrictEqual([s.metric, s.aim, s.reps], ["handsPlaneP6", "less", undefined]);
  assert.strictEqual(s.drillP6, 3.0);
  assert.strictEqual(s.pumps.handsPlane, -1.0);
  assert.strictEqual(DrillSets.nameOf(s), "Pump drill");
  assert.strictEqual(DrillSets.verdict(s).basis, "pumps");
  assert.match(DrillSets.formatSet(s), /^Pump drill, Sep 30 \(4 swings, 7 iron\): pumps -1\.0 in, drill swings' hands in the downswing 3\.0 in/);
});

test("the two sets of a session, a pump set and a reps set, are told apart", () => {
  const a = repsSession({ drill: "move:shoulderTop:more", metric: "shoulderTop", before: around(90), reps: around(92), after: around(92) });
  const clips = [...a.clips], records = { ...a.records };
  for (let i = 0; i < 3; i++) { clips.push(makeClip(`p${i}`, `2026-10-12T16:4${i}:00`, "pump", "I7")); records[`p${i}`] = makeRecord(3.0, [{ t: 3.5, handsPlane: -1.0, lag: 50 }]); }
  const sets = DrillSets.sets(clips, records);
  assert.deepStrictEqual(sets.map(s => s.drill), ["pump", "move:shoulderTop:more"]);
  // The pump swings are drill swings: not among the reps set's "after".
  assert.strictEqual(sets[1].after.count, 4);
});
