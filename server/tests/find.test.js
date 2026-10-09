// The Find box (find.js): clip numbers, times and dates, several at once.
//
//   cd server && node --test tests/find.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const Find = require("../static/find.js");

// Times in the machine's own zone, as the page shows them.
const at = (s, n) => ({ name: `swing_face_1920x1080_240fps_${n}_2007ms.mp4`, recorded: s });
const face = at("2026-09-25T21:25:49", 1790371549);
const dtl = { name: "swing_dtl_1920x1080_240fps_1790371548_2023ms.mp4", recorded: "2026-09-25T21:25:48" };
const other = at("2026-09-28T17:03:54", 1790615034);
const hit = (q, swing) => Find.matches(Find.parse(q), swing);

test("clip numbers: either angle's, within 2 s, many pasted at once", () => {
  assert.ok(hit("1790371549", [face, dtl]));
  assert.ok(hit("1790371548", [face]));            // the down-the-line number finds the swing
  assert.ok(!hit("1790371555", [face, dtl]));
  const q = "1790206507, 1790615034\n1790371549";
  assert.ok(hit(q, [face]) && hit(q, [other]));
  assert.deepEqual(Find.parse(q).ids, [1790206507, 1790615034, 1790371549]);
  // The first days' clips have no angle or length in the name.
  assert.ok(hit("1790206507", [{ name: "swing_1920x1080_240fps_1790206507.mp4", recorded: "2026-09-23T18:35:07" }]));
});

test("times: to the minute, or within 2 s with seconds; am/pm optional", () => {
  assert.ok(hit("9:25 PM", [face]));
  assert.ok(hit("9:25", [face]));                  // 9:25 am or pm
  assert.ok(hit("21:25", [face]));
  assert.ok(!hit("9:25 am", [face]));
  assert.ok(hit("9:25:49 pm", [face]));
  assert.ok(hit("9:25:51 pm", [face]));
  assert.ok(!hit("9:25:55 pm", [face]));
  assert.ok(!hit("9:26 PM", [face]));
});

test("dates alone or with a time", () => {
  assert.ok(hit("Sep 25", [face]) && !hit("Sep 25", [other]));
  assert.ok(hit("9/28", [other]));
  assert.ok(hit("Fri Sep 25  9:25:49 PM", [face]));
  assert.ok(!hit("Sep 24 9:25 PM", [face]));
  // A list of times as Claude writes them.
  const q = "Fri Sep 25  9:25:49 PM\nMon Sep 28  5:03:54 PM";
  assert.ok(hit(q, [face]) && hit(q, [other]));
});

test("nothing to find: everything shows; words alone find nothing", () => {
  assert.ok(Find.isEmpty(Find.parse("")));
  assert.ok(Find.isEmpty(Find.parse("the top")));
  assert.ok(hit("", [face]));
});

test("clipNumber extracts unix timestamp from clip names, edge cases", () => {
  // Standard naming with millisecond suffix
  assert.equal(Find.clipNumber("swing_face_1920x1080_240fps_1790353993_2007ms.mp4"), 1790353993);
  assert.equal(Find.clipNumber("swing_dtl_1920x1080_240fps_1790371548_2023ms.mp4"), 1790371548);

  // Early naming without angle/fps
  assert.equal(Find.clipNumber("swing_1920x1080_240fps_1790206507.mp4"), 1790206507);

  // Edge cases: null, undefined, empty, or string without timestamp
  assert.equal(Find.clipNumber(null), null);
  assert.equal(Find.clipNumber(undefined), null);
  assert.equal(Find.clipNumber(""), null);
  assert.equal(Find.clipNumber("video.mp4"), null);
  assert.equal(Find.clipNumber("swing_face_invalid.mp4"), null);
});

