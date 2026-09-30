// The pump drill (drills.py): a real pump-drill swing (to the top, two pumps down to the trail pocket,
// then through) is found as a swing, its pumps as its own checkpoints, the P6 numbers measured at
// each pump's bottom, and no tempo (the pumps aren't a backswing).
//
//   cd server && node --test tests/pump.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), zlib = require("zlib");

globalThis.SwingPhases = require("../static/phases.js");
globalThis.SwingMetrics = require("../static/metrics.js");
const Summary = require("../static/summary.js");

const DIR = path.join(__dirname, "fixtures", "real", "pump");
const clips = JSON.parse(fs.readFileSync(path.join(DIR, "clips.json"), "utf8"));
const input = (c, drill) => {
  const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, c.name + ".json.gz"))));
  return { name: c.name, strike: c.strike, angle: c.angle, rotation: d.rotation || 0, frames: d.frames,
           impact: d.impact, ball: d.ball, drill };
};
const face = clips.find(c => c.angle === "face"), dtl = clips.find(c => c.angle === "dtl");

test("without the drill tag the pumps don't fit a swing", () => {
  const rec = Summary.summarize(input(face, null), input(dtl, null), "left");
  assert.equal(rec.quality.noSwing.reason, "timing");
  assert.equal(rec.drill, null);
});

test("as a pump drill: found, two pumps between the first top and the last", () => {
  const rec = Summary.summarize(input(face, "pump"), input(dtl, "pump"), "left");
  assert.equal(rec.quality.swingFound, true);
  assert.equal(rec.drill.kind, "pump");
  assert.equal(rec.drill.pumps.length, 2);
  // By the hands' height trace: bottoms at about 3.8 s and 5.1 s, the last top about 5.8 s, impact 6.05 s.
  assert.ok(Math.abs(rec.drill.pumps[0].t - 3.8) < 0.15, `first pump at ${rec.drill.pumps[0].t}`);
  assert.ok(Math.abs(rec.drill.pumps[1].t - 5.1) < 0.15, `second pump at ${rec.drill.pumps[1].t}`);
  for (const p of rec.drill.pumps) assert.ok(p.handsPlane != null && p.lag != null);
  assert.equal(rec.body.tempo, null);
  assert.equal(rec.body.backswing, null);
  assert.ok(rec.body.handsPlaneP6 != null);   // the real swing's P6, after the pumps
});

test("key positions: the backswing from address, the top the downswing starts from", () => {
  const f = input(face, "pump"), d = input(dtl, "pump");
  for (const c of [f, d]) c.aspect = Summary.aspectOf(c.name, c.rotation);
  const pos = Summary.analyze(f, d, "left").positions;
  const at = k => pos.find(p => p.key === k).t;
  assert.ok(at("p1") < 2.8 && at("p2") < at("p3") && at("p3") < 3.3, "P1-P3 in the first backswing");
  assert.ok(Math.abs(at("p4") - 5.8) < 0.15, `P4 at ${at("p4")}`);
  assert.ok(at("p4") < at("p5") && at("p5") < at("p6") && at("p6") < at("p7"));
  assert.ok(at("p7") - at("p4") < 0.6, "a real downswing");
});

test("an ordinary swing tagged as a drill by mistake is analyzed as usual", () => {
  const REAL = path.join(__dirname, "fixtures", "real");
  const all = JSON.parse(fs.readFileSync(path.join(REAL, "clips.json"), "utf8"));
  const c = all.find(x => x.angle === "face" && x.shot && x.shot.club === "I7");
  const pose = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(REAL, "pose", c.name + ".v6.json.gz"))));
  const plain = globalThis.SwingPhases.detect(pose.frames, 16 / 9, "left", null, null);
  const tagged = globalThis.SwingPhases.detect(pose.frames, 16 / 9, "left", null, null, { drill: "pump" });
  assert.deepEqual(tagged.map(p => [p.key, p.index]), plain.map(p => [p.key, p.index]));
  assert.equal(tagged.drill, undefined);
});
