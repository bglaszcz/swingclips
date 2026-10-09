// server/tests/labelview.test.js: unit tests for SwingLabelView pure helpers
const test = require("node:test");
const assert = require("node:assert/strict");

const { labeledSwings } = require("../static/labelview.js");

test("labeledSwings: lone DTL clip does not count as face-on or satisfy both angles", () => {
  const clips = [
    { name: "swing_dtl_1.mp4", angle: "dtl", partner: null, recorded: "2026-10-08T10:00:00Z" }
  ];
  const rows = [
    { clip: "swing_dtl_1.mp4", pass: 1, angle: "dtl", partner: null, events: 8, pointFrames: 10, issues: [] }
  ];

  const swings = labeledSwings(rows, clips);
  assert.equal(swings.length, 1);
  const s = swings[0];
  assert.equal(s.hasFace, false);
  assert.equal(s.face, null);
  assert.equal(s.hasDtl, true);
  assert.notEqual(s.dtl, null);
  assert.equal(s.dtl.clip, "swing_dtl_1.mp4");
  // Only 1 angle exists: cannot satisfy "both angles" goal
  assert.equal(s.moments, false);
  assert.equal(s.points, false);
});

test("labeledSwings: resolves DTL partner from clips when label doc partner is null", () => {
  const clips = [
    { name: "swing_face_2.mp4", angle: "face", partner: "swing_dtl_2.mp4", recorded: "2026-10-08T11:00:00Z" },
    { name: "swing_dtl_2.mp4", angle: "dtl", partner: "swing_face_2.mp4", recorded: "2026-10-08T11:00:00Z" }
  ];
  // Face labeled, doc partner is null
  const rows = [
    { clip: "swing_face_2.mp4", pass: 1, angle: "face", partner: null, events: 8, pointFrames: 10, issues: [] }
  ];

  const swings = labeledSwings(rows, clips);
  assert.equal(swings.length, 1);
  const s = swings[0];
  assert.equal(s.hasFace, true);
  assert.equal(s.hasDtl, true);
  assert.notEqual(s.face, null);
  assert.equal(s.dtl, null); // DTL not labeled yet
  // Both angles required: moments false until DTL is also labeled
  assert.equal(s.moments, false);
});
