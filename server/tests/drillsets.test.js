// drillsets.test.js: unit tests for SwingDrillSets (drillsets.js).
const test = require("node:test");
const assert = require("node:assert");
const DrillSets = require("../static/drillsets.js");

function makeClip(name, recorded, drill, club, angle = "face", partner = null) {
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
    }
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
  assert.ok(line.includes("drill swings' P6 4.7 in"));
  assert.ok(line.includes("your swings after 4.3 in"));
  assert.ok(line.includes("no carry-over yet"));
  assert.ok(line.includes("(1 left out)"));
});
