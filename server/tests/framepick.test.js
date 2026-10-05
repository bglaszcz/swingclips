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
