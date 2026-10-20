// server/tests/draw.test.js: drawing on the videos (static/draw.js)
const test = require("node:test");
const assert = require("node:assert/strict");
const draw = require("../static/draw.js");

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test("lineAngle: level, upright and 45 degrees in picture pixels", () => {
  close(draw.lineAngle([0.1, 0.5], [0.9, 0.5], 1080, 1920), 0);
  close(draw.lineAngle([0.5, 0.1], [0.5, 0.9], 1080, 1920), 90);
  // 0.1 of 1080 across, 0.05625 of 1920 down = 108 px each: 45 degrees.
  close(draw.lineAngle([0.2, 0.2], [0.3, 0.25625], 1080, 1920), 45);
  // Either way round, sloping up or down, it reads the angle to level.
  close(draw.lineAngle([0.3, 0.25625], [0.2, 0.2], 1080, 1920), 45);
  close(draw.lineAngle([0.2, 0.25625], [0.3, 0.2], 1080, 1920), 45);
  assert.equal(draw.lineAngle([0.2, 0.2], [0.2, 0.2], 1080, 1920), null);
});

test("jointAngle: the angle at the vertex, in picture pixels", () => {
  close(draw.jointAngle([0, 0.5], [0.5, 0.5], [0.5, 0], 1000, 1000), 90);
  close(draw.jointAngle([0, 0.5], [0.5, 0.5], [1, 0.5], 1000, 1000), 180);
  // A picture taller than wide: the same normalized arms are a different real angle.
  close(draw.jointAngle([0.4, 0.5], [0.5, 0.5], [0.5, 0.4], 1080, 1920), 90);
  const a = draw.jointAngle([0.4, 0.4], [0.5, 0.5], [0.6, 0.4], 1080, 1920);
  close(a, 2 * Math.atan2(108, 192) * 180 / Math.PI, 1e-9);
  assert.equal(draw.jointAngle([0.5, 0.5], [0.5, 0.5], [0.6, 0.4], 1080, 1920), null);
});

test("thin: drops points too close together, keeps the ends", () => {
  const pts = [[0, 0], [0.001, 0], [0.002, 0], [0.01, 0], [0.0105, 0], [0.02, 0]];
  assert.deepEqual(draw.thin(pts, 0.005), [[0, 0], [0.01, 0], [0.02, 0]]);
  assert.deepEqual(draw.thin([[0, 0], [0.001, 0]], 0.005), [[0, 0], [0.001, 0]]);
});

test("valid: only shapes it can draw", () => {
  assert.ok(draw.valid({ type: "line", pts: [[0, 0], [1, 1]] }));
  assert.ok(draw.valid({ type: "angle", pts: [[0, 0], [0.5, 0.5], [1, 0]] }));
  assert.ok(!draw.valid({ type: "angle", pts: [[0, 0], [0.5, 0.5]] }));
  assert.ok(!draw.valid({ type: "star", pts: [[0, 0], [1, 1]] }));
  assert.ok(!draw.valid({ type: "line", pts: [[0, 0], [1, NaN]] }));
  assert.ok(!draw.valid(null));
});

function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m };
}

test("save / load: per clip, bad entries dropped, empty removes the key", () => {
  const st = memoryStorage();
  const shapes = [{ type: "line", pts: [[0, 0], [1, 1]], color: "#fff" }, { type: "circle", pts: [[0.5, 0.5], [0.6, 0.5]] }];
  draw.save(st, "a.mp4", shapes);
  assert.deepEqual(draw.load(st, "a.mp4"), shapes);
  assert.deepEqual(draw.load(st, "b.mp4"), []);
  st.setItem(draw.KEY_PREFIX + "c.mp4", JSON.stringify([shapes[0], { type: "nope" }, 5]));
  assert.deepEqual(draw.load(st, "c.mp4"), [shapes[0]]);
  st.setItem(draw.KEY_PREFIX + "d.mp4", "{not json");
  assert.deepEqual(draw.load(st, "d.mp4"), []);
  draw.save(st, "a.mp4", []);
  assert.equal(st.getItem(draw.KEY_PREFIX + "a.mp4"), null);
  assert.deepEqual(draw.load(null, "a.mp4"), []);
});

test("index.html loads draw.js before the page's script and has the button and bar", () => {
  const fs = require("node:fs");
  const html = fs.readFileSync(require("node:path").join(__dirname, "..", "static", "index.html"), "utf8");
  const tag = html.indexOf('<script src="/static/draw.js"></script>');
  assert.ok(tag > 0, "script tag");
  assert.ok(tag < html.indexOf("SwingDraw.attach("), "loaded before it is attached");
  assert.ok(html.includes('id="draw-btn"') && html.includes('id="draw-bar"'));
});
