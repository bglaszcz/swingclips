// Unit tests for per-body-model TUNING in phases.js and summary.js.
// Run with: node --test server/tests/phases_tuning.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const Phases = require("../static/phases.js");
globalThis.SwingPhases = Phases;
globalThis.SwingMetrics = require("../static/metrics.js");
const Summary = require("../static/summary.js");

const REAL = path.join(__dirname, "fixtures", "real");
const clips = JSON.parse(fs.readFileSync(path.join(REAL, "clips.json"), "utf8"));
const face = clips.find(c => c.angle === "face" && c.name.includes("1790706208"));
const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(REAL, "pose-rtmpose-m", face.name + ".v6.json.gz"))));

test("TUNING holds per-body-model configurations", () => {
  assert.ok(Phases.TUNING["rtmpose-m"], "rtmpose-m tuning exists");
  assert.ok(Phases.TUNING["rtmw-l"], "rtmw-l tuning exists");
  assert.equal(Phases.TUNING["rtmpose-m"].p3Degrees, 0);
  assert.equal(Phases.TUNING["rtmw-l"].p3Degrees, -3);
  // Default top-level properties match RTMPose-m for backward compatibility
  assert.equal(Phases.TUNING.takeawayDegrees, 1);
  assert.equal(Phases.TUNING.onsetLead, 0.017);
  assert.equal(Phases.TUNING.p3Degrees, 0);
});

test("detect applies p3Degrees per bodyModel", () => {
  const window = [face.strike - 0.2, face.strike + 0.2];
  const posM = Phases.detect(doc.frames, 1.0, "left", window, doc.impact, { bodyModel: "rtmpose-m-256x192" });
  const posW = Phases.detect(doc.frames, 1.0, "left", window, doc.impact, { bodyModel: "rtmw-l-384x288" });

  const p3M = posM.find(p => p.key === "p3");
  const p3W = posW.find(p => p.key === "p3");

  assert.ok(p3M && p3W, "both models detected P3");
  // For RTMW-l, level target is -3 deg (rising), reached earlier than or equal to 0 deg
  assert.ok(p3W.t <= p3M.t, `RTMW-l P3 (${p3W.t}s) <= RTMPose-m P3 (${p3M.t}s)`);
});

test("Summary.analyze passes bodyModel to Phases.detect", () => {
  const clip = {
    name: face.name,
    strike: face.strike,
    angle: "face",
    aspect: 1.0,
    bodyModel: "rtmw-l-384x288",
    frames: doc.frames,
    impact: doc.impact,
  };
  const a = Summary.analyze(clip, null, "left");
  assert.ok(a);
  assert.ok(a.positions.length > 0);
  const p3 = a.positions.find(p => p.key === "p3");
  assert.ok(p3);
});
