// Trust per number (static/trust.js): the three levels and their reasons, practice mode's rule, the
// noise table, and summary.js's impact check that feeds them.
//
//   cd server && node --test tests/trust.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../static/summary.js");
const T = require("../static/trust.js");

/** A swing record as swings.py keeps it. */
function record({ body = {}, face = [], dtl = [], p6 = false } = {}) {
  return {
    body: { tempo: 3.1, backswing: 0.8, downswing: 0.26, headSway: -0.4, headRise: 0.3, earlyExt: 1.1,
            handsPlaneP6: 0.5, shaftPlaneP6: 2, handDepthTop: 3, spineTiltImpact: 30, ...body },
    quality: { camera: { face, dtl }, p6Estimated: p6 },
  };
}
const judge = (key, rec, light = null, table = null) => T.forSwing(rec, light, table)[key];

test("a plain number is ok", () => {
  const j = judge("headSway", record());
  assert.equal(j.level, "ok");
  assert.deepEqual(j.why, []);
});

test("no reading: a camera that couldn't see the golfer, or no number", () => {
  const rec = record({ face: ["out"] });
  assert.equal(judge("headSway", rec).level, "none");
  assert.equal(judge("tempo", rec).text, "camera check: out");
  assert.equal(judge("earlyExt", rec).level, "ok");              // the other camera's numbers stand
  const hands = record({ dtl: ["hands", "edge"] });
  assert.equal(judge("handDepthTop", hands).text, "camera check: hands");
  assert.equal(judge("tempo", hands).level, "ok");
  assert.equal(judge("headSway", record({ face: ["edge", "small"] })).level, "ok");
  assert.equal(judge("headSway", record({ body: { headSway: null } })).text, "not measured");
  assert.equal(judge("headSway", { error: "boom" }).level, "none");
  // No reading tells only why not.
  assert.deepEqual(judge("headRise", rec).why, ["camera check: out"]);
});

test("shaky: an estimated key position", () => {
  const j = judge("shaftPlaneP6", record({ p6: true }));
  assert.equal(j.level, "shaky");
  assert.equal(j.why[0], "P6 estimated");
  assert.equal(judge("earlyExt", record({ p6: true })).level, "ok");   // read at P7
});

test("shaky: noisy by definition (head rise, the plane numbers)", () => {
  for (const key of ["headRise", "handsPlaneP6", "shaftPlaneP6", "handsPlaneTop"]) {
    assert.equal(judge(key, record({ body: { handsPlaneTop: 1 } })).level, "shaky", key);
  }
  // By readout cell too, at any key position (not in the other camera's numbers).
  const facts = T.factsOf(record(), null);
  assert.equal(T.judge({ view: "dtl", value: "handsPlane", pos: "p1" }, facts, 0.2).level, "shaky");
  assert.equal(T.judge({ view: "face", value: "headRise", pos: "p4" }, facts, 0.2).level, "shaky");
  assert.equal(T.judge({ view: "face", value: "headSway", pos: "p4" }, facts, 0.2).level, "ok");
});

test("shaky: dark, or flicker that matters; mild flicker (Auto) and grain don't count", () => {
  const dark = { face: { warnings: ["dark"], brightness: 64 }, dtl: null };
  assert.equal(judge("headSway", record(), dark).text, "dark picture (brightness 64)");
  assert.equal(judge("earlyExt", record(), dark).level, "ok");
  const fixed = { face: null, dtl: { warnings: ["flicker"], flickerLevel: "matters" } };
  assert.equal(judge("earlyExt", record(), fixed).level, "shaky");
  const auto = { face: null, dtl: { warnings: ["flicker", "grainy"], flickerLevel: "mild" } };
  assert.equal(judge("earlyExt", record(), auto).level, "ok");
  // A record from before flickerLevel: treated as mattering.
  assert.equal(judge("earlyExt", record(), { dtl: { warnings: ["flicker"] } }).level, "shaky");
});

test("shaky: impact that can't be believed, for what's timed from it only", () => {
  for (const code of ["noball", "impact"]) {
    const rec = record({ face: [code], dtl: [code] });
    for (const key of ["tempo", "downswing", "headSway", "spineTiltImpact", "earlyExt", "handsPlaneP6"]) {
      assert.equal(judge(key, rec).level, "shaky", `${code} ${key}`);
      assert.ok(judge(key, rec).codes.includes(code));
    }
    for (const key of ["backswing", "handDepthTop"]) assert.equal(judge(key, rec).level, "ok", `${code} ${key}`);
  }
  assert.match(judge("headSway", record({ face: ["noball"] })).text, /ball not found/);
  assert.match(judge("headSway", record({ face: ["impact"] })).text, /impact doubtful/);
});

test("shaky: the noise floor says it moves more at address than half its swing-to-swing spread", () => {
  const table = { keys: {
    "face.headSway.p7": { noise: 0.3, spread: 0.5, shaky: true },
    "dtl.hipDepth.p7": { noise: 0.1, spread: 0.9, shaky: false },
  } };
  const j = judge("headSway", record(), null, table);
  assert.equal(j.level, "shaky");
  assert.equal(j.text, "moves ±0.30 in standing still at address, against ±0.50 in swing to swing");
  assert.equal(judge("earlyExt", record(), null, table).level, "ok");
  assert.equal(judge("tempo", record(), null, table).level, "ok");         // timings have no noise floor
});

test("the worse of two, for a difference", () => {
  const a = judge("headSway", record()), b = judge("headSway", record({ face: ["out"] }));
  assert.equal(T.worse(a, b).level, "none");
  assert.equal(T.worse(a, judge("headRise", record())).level, "shaky");
});

test("practice mode's rule keeps its behavior", () => {
  const sp = (key, rec) => T.speakable(key, rec);
  assert.deepEqual(sp("tempo", record()), { value: 3.1, why: null });
  assert.deepEqual(sp("tempo", record({ face: ["out"] })), { value: null, why: "camera check: out" });
  assert.deepEqual(sp("earlyExt", record({ face: ["out"] })), { value: 1.1, why: null });
  assert.deepEqual(sp("earlyExt", record({ dtl: ["hands", "out"] })), { value: null, why: "camera check: hands, out" });
  assert.deepEqual(sp("handsPlaneP6", record({ p6: true })), { value: null, why: "P6 estimated" });
  assert.deepEqual(sp("handsPlaneP6", record({ p6: true, body: { handsPlaneP6: null } })), { value: null, why: "P6 estimated" });
  assert.deepEqual(sp("tempo", record({ body: { tempo: null } })), { value: null, why: "not measured" });
  assert.deepEqual(sp("tempo", null), { value: null, why: "not measured" });
  assert.deepEqual(sp("tempo", { error: "x" }), { value: null, why: "not measured" });
  // Shaky for other reasons is still spoken (noisy by definition, an impact from the hands).
  assert.deepEqual(sp("headRise", record()), { value: 0.3, why: null });
  assert.deepEqual(sp("headSway", record({ face: ["noball"] })), { value: -0.4, why: null });
});

// ---- The noise table ----

/** A session of n swings starting at t0 (s), each with value(i) for face headSway at P7 and noise sd. */
function session(t0, n, value, sd, extra = {}) {
  return Array.from({ length: n }, (_, i) => ({
    t: t0 + i * 60, club: "I7",
    record: {
      body: { headSway: value(i) },
      quality: { camera: { face: [], dtl: null } },
      at: { face: { p1: { headSway: 0, spineTilt: 30 + (i % 3) }, p7: { headSway: value(i), spineTilt: 32 + i } }, dtl: null },
      noise: { face: { headSway: sd, spineTilt: 0.2 }, dtl: null },
      ...extra,
    },
  }));
}

test("noise table: noisy when the address spread beats half the swing-to-swing spread", () => {
  const day = 86400;
  const swings = [...session(0, 6, i => (i % 2 ? 0.2 : -0.2), 0.3), ...session(day, 6, i => (i % 2 ? 0.1 : -0.1), 0.3)];
  const t = T.noiseTable(swings);
  assert.equal(t.swings, 12);
  assert.equal(t.sessions, 2);
  const row = t.keys["face.headSway.p7"];
  assert.ok(row.shaky, JSON.stringify(row));
  assert.equal(row.noise, 0.3);
  assert.equal(row.sessions, 2);
  // Same at address on every swing (0 by definition): nothing to judge.
  assert.equal(t.keys["face.headSway.p1"], undefined);
  // Spine tilt at impact varies by ~1.9° against 0.2° of noise.
  assert.equal(t.keys["face.spineTilt.p7"].shaky, false);
});

test("noise table: too few swings, a session under 5, or a camera that couldn't see don't count", () => {
  const few = T.noiseTable(session(0, 7, i => i, 0.3));
  assert.deepEqual(few.keys, {});                                   // one session of 7 < 10 swings
  const small = T.noiseTable([...session(0, 6, i => i, 0.3), ...session(86400, 4, i => i, 0.3)]);
  assert.deepEqual(small.keys, {});                                 // the session of 4 is left out
  const hidden = session(0, 12, i => i, 0.3, { quality: { camera: { face: ["out"], dtl: null } } });
  assert.deepEqual(T.noiseTable(hidden).keys, {});
  // Clubs apart: two clubs in one session are two groups.
  const mixed = session(0, 12, i => (i % 2 ? 5 : -5), 0.3).map((s, i) => ({ ...s, club: i % 2 ? "DR" : "I7" }));
  const row = T.noiseTable(mixed).keys["face.headSway.p7"];
  assert.equal(row, undefined);                                     // each club's swings are all the same
});

// ---- summary.js: the impact check the camera check carries ----

test("impactCheck: the ball found, from 60 ms before to 10 ms after the heard strike", () => {
  assert.equal(S.impactCheck({ impact: null, strike: 2.0 }), "noball");
  assert.equal(S.impactCheck({ impact: 1.97, strike: 2.0 }), null);
  assert.equal(S.impactCheck({ impact: 1.94, strike: 2.0 }), null);
  assert.equal(S.impactCheck({ impact: 2.01, strike: 2.0 }), null);
  assert.equal(S.impactCheck({ impact: 2.024, strike: 2.0 }), "impact");   // 24 ms after
  assert.equal(S.impactCheck({ impact: 2.1, strike: 2.0 }), "impact");     // 100 ms late
  assert.equal(S.impactCheck({ impact: 1.93, strike: 2.0 }), "impact");
  // No strike in the name: the capture app's 2.0-2.25 s.
  assert.equal(S.impactCheck({ impact: 2.2, strike: null }), null);
  assert.equal(S.impactCheck({ impact: 2.3, strike: null }), "impact");
});

test("cameras() adds the impact codes: the face-on clip's for both, a down-the-line one's own when it synced them", () => {
  // Everyone in the picture, from the nose (0.1) down to the ankles (~0.8).
  const lm = Array.from({ length: 33 }, (_, i) => [0.5, 0.1 + 0.8 * i / 32, 0.9]).flat();
  const clip = (angle, impact, strike) => ({ angle, impact, strike, frames: [{ t: 0, lm }, { t: 1, lm }] });
  const analysis = (main, dtl) => ({
    positions: [{ key: "p1", index: 0 }, { key: "p4", index: 1 }], metrics: { address: 0 }, dtl,
    dtlIndex: key => (key === "p1" ? 0 : 1),
  });
  let main = clip("face", 1.97, 2.0), dtl = clip("dtl", 2.1, 2.0);
  let cams = S.cameras(analysis(main, dtl), main);
  assert.deepEqual([cams.face, cams.dtl], [[], ["impact"]]);
  main = clip("face", null, 2.0);
  cams = S.cameras(analysis(main, clip("dtl", 1.98, 2.0)), main);
  assert.deepEqual([cams.face, cams.dtl], [["noball"], ["noball"]]);
  // The down-the-line clip's ball not seen: it's synced by the strikes, its positions stand.
  main = clip("face", 1.97, 2.0);
  cams = S.cameras(analysis(main, clip("dtl", null, 2.0)), main);
  assert.deepEqual([cams.face, cams.dtl], [[], []]);
  // A lone down-the-line clip: its own.
  main = clip("dtl", null, 2.0);
  cams = S.cameras(analysis(main, main), main);
  assert.deepEqual([cams.face, cams.dtl], [null, ["noball"]]);
});
