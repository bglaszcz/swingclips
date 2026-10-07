// swingrow.test.js: unit tests for SwingRow (swingrow.js).
const test = require("node:test");
const assert = require("node:assert");
const SwingRow = require("../static/swingrow.js");
const SwingSummary = require("../static/summary.js");

test("SwingRow.row populates shot numbers and timestamp without body", () => {
  const clip = {
    name: "swing_face_100.mp4",
    recorded: "2026-10-07T14:30:00Z",
    angle: "face",
    partner: "swing_dtl_100.mp4",
    shot: {
      club: "I7",
      ball: { carry: 155.2, side: 1.5, speed: 110 },
      clubData: { smash: 1.32, path: -1.2, faceToTarget: 0.5 }
    }
  };

  const r = SwingRow.row(clip, {}, []);
  assert.equal(r.name, "swing_face_100.mp4");
  assert.equal(r.club, "I7");
  assert.equal(r.carry, 155.2);
  assert.equal(r.smash, 1.32);
  assert.equal(r.body, null);
  assert.equal(r.trust, null);
});

test("SwingRow.row populates body and trust with record", () => {
  const clip = {
    name: "swing_face_101.mp4",
    recorded: "2026-10-07T14:35:00Z",
    angle: "face",
    partner: null,
    shot: { club: "I7", ball: { carry: 150, side: 0 } }
  };
  const records = {
    "swing_face_101.mp4": {
      body: { earlyExt: 1.2, handsAhead: 3.5, tempo: 3.0 },
      quality: { swingFound: true, camera: { face: [], dtl: [] } }
    }
  };

  const r = SwingRow.row(clip, records, [clip]);
  assert.ok(r.body);
  assert.ok(r.trust);
  assert.equal(r.earlyExt, 1.2);
  assert.equal(r.body.earlyExt, 1.2);
  assert.equal(r.shown.earlyExt, 1.2);
  assert.equal(SwingRow.isShaky(r, "earlyExt"), false);
});

test("SwingRow.row handles leaveOutShaky", () => {
  const clip = {
    name: "swing_face_102.mp4",
    recorded: "2026-10-07T14:40:00Z",
    angle: "face",
    partner: null,
    shot: { club: "I7" }
  };
  // handsPlaneP6 is noisy by definition so trust marks it shaky
  const records = {
    "swing_face_102.mp4": {
      body: { earlyExt: 1.5, handsPlaneP6: 2.5 },
      quality: { swingFound: true, camera: { face: [], dtl: [] } }
    }
  };

  const rWithShaky = SwingRow.row(clip, records, [clip], null, false);
  assert.equal(rWithShaky.body.handsPlaneP6, 2.5);
  assert.equal(SwingRow.isShaky(rWithShaky, "handsPlaneP6"), true);

  const rWithoutShaky = SwingRow.row(clip, records, [clip], null, true);
  assert.equal(rWithoutShaky.body.handsPlaneP6, null);
  assert.equal(rWithoutShaky.shown.handsPlaneP6, 2.5);
});

test("SwingRow.coachBody ranks faults worst first by severity", () => {
  const clip = {
    name: "swing_face_103.mp4",
    recorded: "2026-10-07T14:45:00Z",
    angle: "face",
    shot: { club: "I7" }
  };
  const records = {
    "swing_face_103.mp4": {
      // earlyExt threshold is 3 (diff = 4 - 3 = 1 -> severity 1)
      // bendLoss threshold is -10 (diff = -25 - -10 = 15 -> scale 10 -> diff > scale -> severity 3)
      body: { earlyExt: 4.0, bendLoss: -25 },
      quality: { swingFound: true, camera: { face: [], dtl: [] } }
    }
  };

  const r = SwingRow.row(clip, records, [clip]);
  const cb = SwingRow.coachBody(r, {});
  assert.ok(cb);
  assert.ok(cb.faults.length >= 2);
  assert.equal(cb.faults[0].name, "standing up");
  assert.equal(cb.faults[1].name, "early extension");
});

test("SwingRow.goodShotData builds ranges for clubs", () => {
  const clips = [];
  const records = {};
  for (let i = 0; i < 10; i++) {
    const name = `swing_${i}.mp4`;
    clips.push({
      name,
      recorded: `2026-10-07T14:${String(i).padStart(2, "0")}:00Z`,
      angle: "face",
      shot: { club: "I7", ball: { carry: 155, side: 1, speed: 110 }, clubData: { smash: 1.30 } }
    });
    records[name] = {
      body: { earlyExt: 1.0, handsAhead: 2.0 },
      quality: { swingFound: true, camera: { face: [], dtl: [] } }
    };
  }

  const data = SwingRow.goodShotData(clips, records, null, null, clips);
  assert.ok(data);
  assert.ok(data.clubs.I7);
  assert.equal(data.clubs.I7.shots, 10);
  assert.equal(data.clubs.I7.good, 10);
  assert.ok(data.clubs.I7.ranges.earlyExt);
  assert.equal(data.clubs.I7.ranges.earlyExt.enough, true);
});

test("SwingRow.sessionsOf groups clips by 45-minute gap", () => {
  const clips = [
    { name: "s3.mp4", recorded: "2026-10-07T16:00:00Z" },
    { name: "s2.mp4", recorded: "2026-10-07T14:10:00Z" },
    { name: "s1.mp4", recorded: "2026-10-07T14:00:00Z" }
  ];
  const sessions = SwingRow.sessionsOf(clips);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].clips.length, 1);
  assert.equal(sessions[0].key, "s3.mp4");
  assert.equal(sessions[1].clips.length, 2);
  assert.equal(sessions[1].key, "s1.mp4");
});
