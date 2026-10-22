// The club at the top: backswing length face-on (metrics.js clubShort -> summary.js clubTop) and from the
// 3D (metrics3d.js clubShort / clubAcross -> clubShortTop / clubAcrossTop), shown at the top only (view3d.js).
//
//   cd server && node --test tests/clubtop.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../static/metrics.js");
const M3 = require("../static/metrics3d.js");
const S = require("../static/summary.js");

const ASPECT = 9 / 16;

/** A face-on frame (golfer facing the camera) with the club model's shaft direction `deg` (0 = right, 90 = down). */
function faceFrame(t, deg, conf = 0.9) {
  const lm = new Array(33 * 3).fill(0);
  const set = (i, x, y) => { lm[i * 3] = x; lm[i * 3 + 1] = y; lm[i * 3 + 2] = 1; };
  set(0, 0.5, 0.2); set(7, 0.48, 0.2); set(8, 0.52, 0.2);   // nose, ears
  set(11, 0.45, 0.3); set(12, 0.55, 0.3);                   // shoulders
  set(15, 0.47, 0.25); set(16, 0.48, 0.25);                 // wrists
  set(19, 0.47, 0.24); set(20, 0.48, 0.24);                 // index fingers
  set(23, 0.46, 0.55); set(24, 0.54, 0.55);                 // hips
  set(27, 0.46, 0.9); set(28, 0.54, 0.9);                   // ankles
  return { t, lm, club: [deg, conf] };
}

const shortOf = (deg, lead = "left", conf = 0.9) => M.compute([faceFrame(0, deg, conf)], ASPECT, lead, [], null).values[0].clubShort;

test("face-on: short of parallel toward the target, past parallel negative, past straight up keeps counting", () => {
  // Right-handed golfer: the target is to the picture's right.
  assert.ok(Math.abs(shortOf(342) - 18) < 1e-9, "pointing right and 18 deg up: 18 short");
  assert.ok(Math.abs(shortOf(10) + 10) < 1e-9, "pointing right and 10 deg down: 10 past");
  assert.ok(Math.abs(shortOf(270) - 90) < 1e-9, "straight up: 90");
  assert.ok(Math.abs(shortOf(240) - 120) < 1e-9, "up and away from the target: 120");
});

test("face-on: a left-handed golfer's target is to the picture's left", () => {
  assert.ok(Math.abs(shortOf(198, "right") - 18) < 1e-9);
});

test("face-on: no number when the club model isn't sure of the shaft", () => {
  assert.equal(shortOf(342, "left", 0.2), undefined);
});

test("summary.js: clubTop is the face-on clubShort at the top", () => {
  const f = S.BODY.find(b => b.key === "clubTop");
  assert.deepEqual([f.view, f.pos, f.value, f.unit], ["face", "p4", "clubShort", "°"]);
});

/** One 3D frame: hands (both index knuckles) at h, the clubhead at h + d (golf axes, metres). */
function frame3d(h, d) {
  const p = new Array(33).fill(null);
  p[19] = h; p[20] = h;
  return M3.frameValues(p, [h[0] + d[0], h[1] + d[1], h[2] + d[2]]);
}
const H = [-0.3, 1.6, -0.4];
const rad = Math.PI / 180;

test("3D: a shaft that points (past the grip) at the target line is neither across nor laid off", () => {
  // Toward a point on the target line, and level along it: both lie in the plane through the line and the hands.
  const toLine = frame3d(H, [1.8, -1.6, 0.4]);
  assert.ok(Math.abs(toLine.clubAcross) < 1e-9);
  const level = frame3d(H, [1, 0, 0]);
  assert.ok(Math.abs(level.clubAcross) < 1e-9);
  assert.ok(Math.abs(level.clubShort) < 1e-9, "level: not short of parallel");
});

test("3D: toward the ball side is across (+), toward the golfer laid off (-)", () => {
  const across = frame3d(H, [Math.cos(15 * rad), 0, Math.sin(15 * rad)]);
  const laid = frame3d(H, [Math.cos(15 * rad), 0, -Math.sin(15 * rad)]);
  const n = [0, 0.4, 1.6], nn = Math.hypot(...n);
  assert.ok(Math.abs(across.clubAcross - Math.asin(Math.sin(15 * rad) * 1.6 / nn) / rad) < 1e-9);
  assert.ok(across.clubAcross > 14 && laid.clubAcross < -14);
});

test("3D: short of parallel matches the face-on sense (up toward the target +, past vertical keeps counting)", () => {
  assert.ok(Math.abs(frame3d(H, [Math.cos(12 * rad), Math.sin(12 * rad), 0]).clubShort - 12) < 1e-9);
  assert.ok(Math.abs(frame3d(H, [Math.cos(10 * rad), -Math.sin(10 * rad), 0]).clubShort + 10) < 1e-9);
  assert.ok(frame3d(H, [-0.3, 1, 0]).clubShort > 90);
});

test("3D: compute() carries the club numbers through, and atPositions reads them at the top", () => {
  const frames = [];
  for (let i = 0; i < 60; i++) {
    const p = new Array(33).fill(null);
    for (const [id, pt] of [[11, [-0.2, 1.45, -0.45]], [12, [-0.45, 1.45, -0.45]], [13, [-0.15, 1.2, -0.4]], [14, [-0.5, 1.2, -0.4]],
                            [15, [-0.25, 1.0, -0.3]], [16, [-0.3, 1.0, -0.3]], [23, [-0.2, 0.95, -0.45]], [24, [-0.4, 0.95, -0.45]],
                            [25, [-0.15, 0.5, -0.4]], [26, [-0.45, 0.5, -0.4]], [27, [-0.1, 0.05, -0.45]], [28, [-0.5, 0.05, -0.45]]]) p[id] = pt;
    p[19] = H; p[20] = H;
    frames.push({ t: 1 + i * 0.01, p, club: [H[0] + Math.cos(15 * rad), H[1], H[2] + Math.sin(15 * rad)] });
  }
  const doc = { frames };
  const positions = [{ key: "p1", t: 1.0 }, { key: "takeaway", t: 1.1 }, { key: "p4", t: 1.3 }, { key: "p7", t: 1.5 }];
  const r = M3.compute(doc, positions, "left", null);
  assert.ok(r, "compute ran");
  const at = M3.atPositions(r, doc, positions);
  assert.ok(Math.abs(at.p4.clubShort) < 1e-6, "level: 0 short of parallel");
  assert.ok(at.p4.clubAcross > 14, `across at the top, got ${at.p4.clubAcross}`);
});

test("view3d: the club rows show at the top only", () => {
  const origDoc = global.document;
  const mk = tag => ({ tag, children: [], attrs: {}, textContent: "",
    setAttribute(k, v) { this.attrs[k] = v; }, append(...c) { for (const x of c) this.children.push(typeof x === "string" ? { textContent: x } : x); } });
  global.document = { createElement: mk, createTextNode: t => ({ textContent: t }) };
  global.SwingMetrics3D = M3;
  require("../static/view3d.js");
  const V = global.View3D;
  const frames = [];
  for (let i = 0; i < 40; i++) {
    const p = new Array(33).fill(null);
    p[19] = H; p[20] = H;
    frames.push({ t: 1 + i * 0.01, p, club: [H[0] + 1, H[1] + 0.2, H[2] + 0.2] });
  }
  const doc = { frames };
  const result = { values: frames.map(f => Object.assign({ t: f.t }, M3.frameValues(f.p, f.club))) };
  const positions = [{ key: "p1", t: 1.0, index: 0 }, { key: "p4", t: 1.2, index: 20 }, { key: "p7", t: 1.3, index: 30 }];
  const tbl = V.table(result, doc, positions, null, null);
  const rows = tbl.children.slice(1);
  const across = rows.find(r => r.children[0].textContent.startsWith("Club across"));
  assert.ok(across, "the across row is there");
  const cell = i => across.children[i + 1].children.map(c => c.textContent).join("");
  assert.equal(cell(0), "·", "not at address");
  assert.notEqual(cell(1), "·", "shown at the top");
  assert.ok(/^\+\d+°$/.test(cell(1)), `a signed angle at the top, got ${cell(1)}`);
  assert.equal(cell(2), "·", "not at impact");
  global.document = origDoc;
});
