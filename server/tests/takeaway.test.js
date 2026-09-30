// The takeaway from the clubhead onset (pose.py club_onset, saved in face-on pose files after the
// deep pass): taken TUNING.onsetLead after it, moved toward the shaft rule's by at most onsetPull;
// without one, the shaft rule as before. P1 follows the takeaway.
//
//   cd server && node --test tests/takeaway.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), zlib = require("zlib");

const Phases = require("../static/phases.js");
globalThis.SwingPhases = Phases;
globalThis.SwingMetrics = require("../static/metrics.js");
const Summary = require("../static/summary.js");

const REAL = path.join(__dirname, "fixtures", "real");
const clips = JSON.parse(fs.readFileSync(path.join(REAL, "clips.json"), "utf8"));
const face = clips.find(c => c.angle === "face" && c.name.includes("1790706208"));
const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(REAL, "pose-rtmpose-m", face.name + ".v6.json.gz"))));
const input = clubOnset => ({ name: face.name, strike: face.strike, angle: "face", rotation: doc.rotation || 0,
                              frames: doc.frames, impact: doc.impact, ball: doc.ball, clubOnset });
const takeaway = clubOnset => Summary.positionTimes(input(clubOnset), null, "left").main.times;

test("the fixture has an onset", () => assert.equal(typeof doc.clubOnset, "number"));

test("with the onset: onsetLead after it, at most onsetPull toward the shaft rule", () => {
  const { onsetLead, onsetPull } = Phases.TUNING;
  const rule = takeaway(null).takeaway, got = takeaway(doc.clubOnset);
  const t = doc.clubOnset + onsetLead;
  assert.ok(Math.abs(got.takeaway - (t + Math.max(-onsetPull, Math.min(onsetPull, rule - t)))) <= 0.0025);
  // P1 sits the same way before it.
  assert.ok(Math.abs((got.takeaway - got.p1) - 0.1) <= 0.0025);
});

test("an onset far from the shaft rule still decides (it's the better one)", () => {
  const rule = takeaway(null).takeaway;
  const got = takeaway(rule - 0.15).takeaway;
  assert.ok(Math.abs(got - (rule - 0.15 + Phases.TUNING.onsetLead + Phases.TUNING.onsetPull)) <= 0.0025);
});

test("the takeaway says where it came from", () => {
  const p = Phases.detect(doc.frames, 1080 / 1920, "left", null, doc.impact, { clubOnset: doc.clubOnset });
  assert.equal(p.takeaway.fromClubhead, true);
  const q = Phases.detect(doc.frames, 1080 / 1920, "left", null, doc.impact, {});
  assert.equal(q.takeaway.fromClubhead, false);
});
