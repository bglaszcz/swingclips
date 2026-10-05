// Frame picker helper tests (server/static/framepick.js)
//
//   node --test tests/framepick.test.js

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  labelEvent,
  nightTime,
  newLabelDoc,
  mergePick,
  pickSource,
  frameDiff,
  filterDisagreements,
} = require("../static/framepick.js");

test("labelEvent: maps key position names to label event names, skips p1", () => {
  assert.equal(labelEvent("p7"), "impact");
  assert.equal(labelEvent("impact"), "impact");
  assert.equal(labelEvent("takeaway"), "takeaway");
  assert.equal(labelEvent("p2"), "p2");
  assert.equal(labelEvent("p3"), "p3");
  assert.equal(labelEvent("p4"), "p4");
  assert.equal(labelEvent("p5"), "p5");
  assert.equal(labelEvent("p6"), "p6");
  assert.equal(labelEvent("p8"), "p8");

  // Address (p1) is not in label files
  assert.equal(labelEvent("p1"), null);
  assert.equal(labelEvent("unknown"), null);
  assert.equal(labelEvent(""), null);
  assert.equal(labelEvent(null), null);
});

test("nightTime: calculates night pass time from server time and ms difference", () => {
  assert.equal(nightTime(1.5, 25), 1.525);
  assert.equal(nightTime(2.0, -12.5), 1.9875);
  assert.equal(nightTime(1.7136, 0), 1.7136);
  assert.equal(nightTime(1.0, null), 1.0);
});

test("newLabelDoc: creates standard schema 1 document structure", () => {
  const clip = { name: "swing_face.mp4", angle: "face", strike: 1.45, excluded: false };
  const partner = { name: "swing_dtl.mp4", angle: "dtl", strike: 1.45 };

  const doc = newLabelDoc(clip, partner);
  assert.equal(doc.schema, 1);
  assert.deepEqual(doc.clip, { name: "swing_face.mp4", angle: "face", strike: 1.45 });
  assert.deepEqual(doc.partner, { name: "swing_dtl.mp4", angle: "dtl", strike: 1.45 });
  assert.deepEqual(doc.events, {});
  assert.deepEqual(doc.picked, {});

  // Lone clip without partner
  const loneDoc = newLabelDoc(clip, null);
  assert.equal(loneDoc.partner, null);
});

test("mergePick: adds event time and source without touching other events or fields", () => {
  const existingDoc = {
    schema: 1,
    clip: { name: "swing.mp4", angle: "face", strike: null },
    partner: null,
    events: {
      takeaway: 0.986944,
      impact: 2.236244,
    },
    picked: {
      takeaway: "server",
    },
    ball: { x: 0.55, y: 0.88 },
    frames: {
      "0.000000": { l_shoulder: { x: 0.64, y: 0.48 } },
    },
    pass: 1,
  };

  const updated = mergePick(existingDoc, "p4", 1.71360012, "night");

  // Non-destructive: original object unchanged
  assert.equal(existingDoc.events.p4, undefined);
  assert.equal(existingDoc.picked.p4, undefined);

  // New values merged
  assert.equal(updated.events.p4, 1.7136);
  assert.equal(updated.picked.p4, "night");

  // Existing events preserved
  assert.equal(updated.events.takeaway, 0.986944);
  assert.equal(updated.events.impact, 2.236244);
  assert.equal(updated.picked.takeaway, "server");

  // Other fields intact
  assert.deepEqual(updated.ball, { x: 0.55, y: 0.88 });
  assert.ok(updated.frames["0.000000"]);
  assert.equal(updated.pass, 1);
});

test("pickSource: identifies server, night, onset, or adjusted", () => {
  const refs = { serverT: 1.7136, nightT: 1.7386, onsetT: 0.95 };

  // Exact or near matches
  assert.equal(pickSource(1.7136, refs), "server");
  assert.equal(pickSource(1.7136002, refs), "server");
  assert.equal(pickSource(1.7386, refs), "night");
  assert.equal(pickSource(0.95, refs), "onset");

  // Stepped away
  assert.equal(pickSource(1.717767, refs), "adjusted");
  assert.equal(pickSource(1.742767, refs), "adjusted");
  assert.equal(pickSource(1.0, refs), "adjusted");
});

test("frameDiff: formats difference in frames correctly", () => {
  assert.equal(frameDiff(1.0, 1.025, 240), "6 frames apart");
  assert.equal(frameDiff(1.0, 1.004166, 240), "1 frame apart");
  assert.equal(frameDiff(1.0, 1.0, 240), "0 frames apart");
  assert.equal(frameDiff(1.025, 1.0, 240), "6 frames apart");
});

test("filterDisagreements: drops only labeled (clip, position) pairs and skips p1", () => {
  const clips = [
    { name: "swing_face.mp4", angle: "face", partner: "swing_dtl.mp4" },
    { name: "swing_dtl.mp4", angle: "dtl", partner: "swing_face.mp4" },
    { name: "swing_exc.mp4", angle: "face", partner: null, excluded: true },
  ];

  const nightSwings = {
    "swing_face.mp4": {
      face: {
        ms: { p1: 20.0, takeaway: 30.0, p4: 40.0 },
        t: { p1: 0.5, takeaway: 1.0, p4: 1.5 },
      },
      dtl: {
        ms: { p7: 25.0 },
        t: { p7: 2.0 },
      },
    },
    "swing_exc.mp4": {
      face: {
        ms: { p4: 50.0 },
        t: { p4: 1.6 },
      },
    },
  };

  // Case 1: No labels yet -> p1 is skipped, p4 (40ms) is worse than takeaway (30ms)
  let rows = filterDisagreements(nightSwings, clips, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].c.name, "swing_face.mp4");
  assert.equal(rows[0].key, "p4");
  assert.equal(rows[0].ms, 40.0);

  // Case 2: p4 is labeled on face -> p4 dropped, next worst (takeaway 30ms) is listed
  const labelRows = [
    { clip: "swing_face.mp4", pass: 1, missing: ["takeaway", "p2", "p3", "p5", "p6", "impact", "p8"], events: 1 },
  ];
  rows = filterDisagreements(nightSwings, clips, labelRows);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, "takeaway");
  assert.equal(rows[0].ms, 30.0);

  // Case 3: takeaway also labeled on face -> only impact (p7) on dtl remains
  labelRows[0].missing = ["p2", "p3", "p5", "p6", "impact", "p8"]; // takeaway now labeled
  rows = filterDisagreements(nightSwings, clips, labelRows);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].angle, "dtl");
  assert.equal(rows[0].key, "p7");

  // Case 4: dtl clip also has impact labeled -> nothing left
  labelRows.push({ clip: "swing_dtl.mp4", pass: 1, missing: ["takeaway", "p2", "p3", "p4", "p5", "p6", "p8"], events: 1 });
  rows = filterDisagreements(nightSwings, clips, labelRows);
  assert.equal(rows.length, 0);
});
