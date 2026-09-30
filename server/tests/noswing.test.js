// Why no swing was found in a clip (static/phases.js detect's `why`, summary.js quality.noSwing):
// each way detect gives up says so, with the numbers behind it, for the server's events log.
//
//   cd server && node --test tests/noswing.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), zlib = require("zlib");

globalThis.SwingPhases = require("../static/phases.js");
globalThis.SwingMetrics = require("../static/metrics.js");
const Summary = require("../static/summary.js");
const Phases = globalThis.SwingPhases;

const REAL = path.join(__dirname, "fixtures", "real");
const clips = JSON.parse(fs.readFileSync(path.join(REAL, "clips.json"), "utf8"));
// A real face-on 7 iron swing, its pose file as the server keeps it.
const clip = clips.find(c => c.angle === "face" && c.shot && c.shot.club === "I7");
const pose = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(REAL, "pose", clip.name + ".v6.json.gz"))));
const ASPECT = 16 / 9;

test("a real swing is found, with no reason attached", () => {
  const found = Phases.detect(pose.frames, ASPECT, "left", null, null);
  assert.ok(found.length >= 7);
  assert.equal(found.why, undefined);
});

test("nobody tracked: tracking", () => {
  const frames = pose.frames.map(f => ({ ...f, lm: null }));
  const none = Phases.detect(frames, ASPECT, "left", [1.9, 2.4], null);
  assert.equal(none.length, 0);
  assert.equal(none.why.reason, "tracking");
  assert.equal(none.why.bodyFrames, 0);
  assert.equal(none.why.frames, frames.length);
  assert.match(none.why.text, /tracked in only 0 of/);
});

test("the strike heard where nothing was tracked: window", () => {
  const none = Phases.detect(pose.frames, ASPECT, "left", [50, 50.3], null);
  assert.equal(none.why.reason, "window");
  assert.deepEqual(none.why.window, [50, 50.3]);
  assert.equal(none.why.windowFrom, "strike");
});

test("a swing played at half speed: timing, with its backswing and downswing", () => {
  const slow = pose.frames.map(f => ({ ...f, t: f.t * 2 }));
  const none = Phases.detect(slow, ASPECT, "left", null, null);
  assert.equal(none.length, 0);
  assert.equal(none.why.reason, "timing");
  assert.ok(none.why.backswing > 2 || none.why.downswing > 0.6);
  assert.ok(none.why.addressT < none.why.topT && none.why.topT < none.why.impactT);
  assert.equal(none.why.windowFrom, "whole clip");
});

test("the record says why, with the strike and ball it went by", () => {
  const input = { name: clip.name, strike: 30, angle: "face", rotation: 0, frames: pose.frames, impact: null, ball: null };
  const rec = Summary.summarize(input, null, "left");
  assert.equal(rec.quality.swingFound, false);
  assert.equal(rec.quality.noSwing.reason, "window");
  assert.equal(rec.quality.noSwing.strike, 30);
  assert.equal(rec.quality.noSwing.ballCheck, "noball");
  const ok = Summary.summarize({ ...input, strike: clip.strike }, null, "left");
  assert.equal(ok.quality.swingFound, true);
  assert.equal(ok.quality.noSwing, null);
});
