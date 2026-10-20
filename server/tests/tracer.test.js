// server/tests/tracer.test.js: the shot tracer (static/tracer.js)
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../static/tracer.js");

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ""} ${a} vs ${b}`);

test("flightPath matches server/ballflight.py's flight() (same model, same steps)", () => {
  // ballflight.flight(...) on the dev PC, Oct 20 2026.
  const want = [
    [[100.82, 19.93, 2.19, 7397, 13.87], { carry: 133.4, side: 20.5, apexFt: 73 }],
    [[150, 12.5, -1.5, 2700, -4], { carry: 243.6, side: -15.6, apexFt: 111 }],
    [[60, 30, 0, 9000, 0], { carry: 60.1, side: 0.0, apexFt: 39 }],
  ];
  for (const [args, w] of want) {
    const f = T.flightPath(...args);
    close(f.carry, w.carry, 0.051, "carry");
    close(f.side, w.side, 0.051, "side");
    close(Math.round(f.apexFt), w.apexFt, 0, "apex");
    assert.equal(f.points[0][0], 0);
    assert.ok(f.points.at(-1)[2] === 0 && f.seconds > 3, "ends on the ground");
    for (let i = 1; i < f.points.length; i++) assert.ok(f.points[i][0] > f.points[i - 1][0], "times go up");
  }
  assert.equal(T.flightPath(0, 20, 0, 5000, 0), null);
  assert.equal(T.flightPath(100, NaN, 0, 5000, 0), null);
});

// A down-the-line camera like the owner's: 2.9 m behind the ball, 0.92 m up, 0.6 m toward the golfer,
// looking along the target line (camera z = golf x, camera x = golf z, camera y = down).
const C = [-2.9, 0.92, -0.6];
const R = [[0, 0, 1], [0, -1, 0], [1, 0, 0]];
const t = R.map(row => -(row[0] * C[0] + row[1] * C[1] + row[2] * C[2]));
const CAM = { K: [[1450, 0, 540], [0, 1450, 960], [0, 0, 1]], dist: [[0.08, -0.12, 0, 0, 0.05]], R, t, imageSize: [1080, 1920] };

test("project and ballOnFloor undo each other, with the lens distortion", () => {
  const cam = T.camera(CAM);
  for (const X of [[0, T.RADIUS, 0], [0.05, T.RADIUS, 0.03], [-0.1, T.RADIUS, -0.08]]) {
    const [u, v] = T.project(cam, X);
    const B = T.ballOnFloor(cam, u, v);
    close(B[0], X[0], 1e-6); close(B[1], X[1], 1e-9); close(B[2], X[2], 1e-6);
  }
  // Behind the camera: nothing.
  assert.equal(T.project(cam, [-5, 1, 0]), null);
  // Far down the target line: near the middle of the picture across (the camera looks along it).
  const far = T.project(cam, [5000, 0.92, -0.6]);
  close(far[0], 540, 1); close(far[1], 960, 1);
});

test("build: a slice ends right of a straight shot, starts at the ball, carry is Square's", () => {
  const shot = (hla, axis) => ({ ball: { speed: 100.82, vla: 19.93, hla, totalSpin: 7397, spinAxis: axis, carry: 132 } });
  const ball = { x: 0, y: 0 };
  const cam = T.camera(CAM);
  const [bu, bv] = T.project(cam, [0.03, T.RADIUS, 0.02]);
  ball.x = bu / 1080; ball.y = bv / 1920;
  const straight = T.build(shot(0, 0), CAM, ball), slice = T.build(shot(2.19, 13.87), CAM, ball);
  assert.ok(straight.fromBall && slice.fromBall);
  close(slice.points[0][0], ball.x, 1e-6); close(slice.points[0][1], ball.y, 1e-6);
  assert.ok(slice.points.at(-1)[0] > straight.points.at(-1)[0] + 0.05, "the slice lands right of straight");
  assert.equal(slice.carry, 132);
  close(slice.modelCarry, 133.4, 0.051);
  // The ball rises above where it started, then comes down toward the horizon.
  const ys = slice.points.map(p => p[1]);
  assert.ok(Math.min(...ys) < ball.y - 0.2);
  // A ball spot far from the calibration's (a misread) is ignored: the calibration's ball is used.
  const off = T.build(shot(0, 0), CAM, { x: 0.05, y: 0.95 });
  assert.equal(off.fromBall, false);
  // No launch numbers, no tracer.
  assert.equal(T.build({ ball: { speed: 100 } }, CAM, null), null);
  assert.equal(T.build(shot(0, 0), null, null), null);
});

test("shown: grows over GROW_S after impact", () => {
  assert.equal(T.shown(1.0, 2.0), 0);
  close(T.shown(2.0 + T.GROW_S / 2, 2.0), 0.5, 1e-9);
  assert.equal(T.shown(5.0, 2.0), 1);
  assert.equal(T.shown(1.0, undefined), 1);
});

test("index.html loads tracer.js before the page's script and has the Show button", () => {
  const fs = require("node:fs");
  const html = fs.readFileSync(require("node:path").join(__dirname, "..", "static", "index.html"), "utf8");
  const tag = html.indexOf('<script src="/static/tracer.js"></script>');
  assert.ok(tag > 0 && tag < html.indexOf("SwingTracer.build("), "loaded before use");
  assert.ok(html.includes('<button id="tracer"'));
  assert.ok(/overlays = \{[^}]*tracer: true/.test(html), "on by default");
});
