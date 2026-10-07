// Coaching for "What helps, what hurts" (static/coach.js): every move has both ways, which way to
// aim, and faults never offered as a fix.
//
//   cd server && node --test tests/coach.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../static/summary.js");
const H = require("../static/helps.js");
const C = require("../static/coach.js");

test("every body move and every result has its golf words, drill and thought", () => {
  for (const f of S.BODY) {
    const m = C.MOVES[f.key];
    assert.ok(m, f.key);
    for (const way of ["more", "less"]) {
      for (const k of ["name", "how", "drill", "thought"]) assert.ok(m[way][k], `${f.key}.${way}.${k}`);
    }
  }
  for (const r of H.RESULTS) assert.ok(C.RESULTS[r.key] && C.RESULTS[r.key].more && C.RESULTS[r.key].less, r.key);
});

const link = o => ({ move: "hipSway", result: "carry", effect: 1, helps: null, median: null, ...o });

test("better-or-worse results: aim the way that helps", () => {
  // `helps` as helps.js sets it: more of the move takes the result the better way.
  const better = { carry: "up", absOffline: "down", smash: "up" };
  const hl = (result, effect) => link({ result, effect, helps: (better[result] === "up") === (effect > 0) });
  // More sway, longer carry: more sway; more sway, shorter carry: less.
  assert.equal(C.coach(hl("carry", 2), "I7").aim, "more");
  assert.equal(C.coach(hl("carry", -2), "I7").aim, "less");
  // More sway, further offline: less sway; more sway, closer to the line: more.
  assert.equal(C.coach(hl("absOffline", 2), "I7").aim, "less");
  assert.equal(C.coach(hl("absOffline", -2), "I7").aim, "more");
  // More sway, lower smash: less sway, and the goal says better contact (not worse).
  const c = C.coach(hl("smash", -2), "I7");
  assert.equal(c.aim, "less");
  assert.equal(c.fix.name, C.MOVES.hipSway.less.name);
  assert.equal(c.goal, C.RESULTS.smash.more);
});

test("helps.js and coach.js agree on real links: the aim always takes the result the better way", () => {
  // Synthetic swings: more sway, lower smash (within each session).
  const sessions = [0, 1, 2, 3].map(k => ({ key: `s${k}`, start: k, rows: Array.from({ length: 12 }, (_, i) => ({
    body: { hipSway: i }, smash: 1.4 - 0.01 * i + 0.002 * ((i * 7) % 3), carry: 150, shaky: {} })) }));
  const l = H.analyze(sessions).links.find(x => x.move === "hipSway" && x.result === "smash");
  assert.ok(l && l.effect < 0 && l.helps === false);
  assert.equal(C.coach(l, "I7").aim, "less");
});

test("results with a target: toward it from your usual; near it, no aim", () => {
  // Path out-to-in (-3°); more sway -> more out-to-in: less sway.
  let c = C.coach(link({ result: "path", effect: -1, median: -3 }), "I7");
  assert.equal(c.aim, "less");
  assert.match(c.goal, /^club path back toward neutral \(yours runs out-to-in: 3\.0°\)$/);
  // Path in-to-out (+3°): the same link says more sway.
  assert.equal(C.coach(link({ result: "path", effect: -1, median: 3 }), "I7").aim, "more");
  // Already near neutral: nothing to chase.
  c = C.coach(link({ result: "path", effect: -1, median: 0.4 }), "I7");
  assert.equal(c.aim, null);
  assert.match(c.why, /close to neutral/);
  // Attack angle: irons toward -4, the driver toward +2.
  assert.equal(C.targetOf("attack", "I7"), -4);
  assert.equal(C.targetOf("attack", "DR"), 2);
  assert.equal(C.targetOf("attack", "W3"), 0);
  assert.equal(C.coach(link({ result: "attack", effect: 1, median: -1 }), "I7").aim, "less");
  assert.equal(C.coach(link({ result: "attack", effect: 1, median: -1 }), "DR").aim, "more");
  // No target, no better way: explained, not coached.
  assert.equal(C.coach(link({ result: "spin", effect: 1, median: 5000 }), "I7").aim, null);
});

test("faults are never offered as a fix", () => {
  // Over the top would steepen an iron's shallow attack: not offered.
  const c = C.coach(link({ move: "handsPlaneP6", result: "attack", effect: -1, median: -1 }), "I7");
  assert.equal(c.aim, null);
  assert.equal(c.fix, undefined);
  assert.match(c.fault, /over the top/);
  // Standing up would straighten an out-to-in path: not offered either.
  assert.equal(C.coach(link({ move: "bendLoss", result: "path", effect: -1.2, median: -2 }), "I7").aim, null);
  // The good way round is.
  assert.equal(C.coach(link({ move: "handsPlaneP6", result: "path", effect: -1.4, median: -1.6 }), "I7").fix.name,
               C.MOVES.handsPlaneP6.less.name);
});

test("arms-led downswing coaching: fault name, drill, thought and ball effect", () => {
  const m = C.MOVES.armsLed;
  assert.ok(m, "armsLed move exists");
  assert.equal(m.more.fault, true);
  assert.equal(m.more.name, "an arms-led downswing");
  assert.ok(m.more.drill.includes("step the lead foot to the target"));
  assert.ok(m.more.drill.includes("belt buckle to the target"));
  assert.equal(m.more.thought, "Buckle to the target first.");
  assert.ok(m.more.how.includes("outside"));
  assert.ok(m.more.how.includes("steep"));
  assert.ok(m.more.how.includes("low point moves back"));
});

test("coaching text speaks golf: no P-numbers in any move's words", () => {
  for (const [k, m] of Object.entries(C.MOVES)) {
    assert.doesNotMatch(m.what || "", /\bP[1-8]\b/, `${k}.what`);
    for (const side of ["more", "less"]) {
      for (const field of ["name", "how", "drill", "thought"]) assert.doesNotMatch(m[side][field] || "", /\bP[1-8]\b/, `${k}.${side}.${field}`);
    }
  }
});
