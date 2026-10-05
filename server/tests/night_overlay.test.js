// Night pass overlay on the swing page (index.html)
// Tests:
//   node --test tests/night_overlay.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const htmlPath = path.resolve(__dirname, "../static/index.html");
const html = fs.readFileSync(htmlPath, "utf-8");

test("index.html contains Night pass toggle, CSS variables, and legend", () => {
  assert.ok(html.includes("--night: #0284c7;"), "defines light theme --night");
  assert.ok(html.includes("--night: #38bdf8;"), "defines dark theme --night");
  assert.ok(html.includes('id="night"'), "defines Show menu night button");
  assert.ok(html.includes('id="night-legend"'), "defines night-legend under stages");
  assert.ok(html.includes("night: false"), "overlays.night is off by default");
});

test("frameAtTime matches nearest frame within half a frame duration", () => {
  // Extract frameAtTime function from index.html
  const match = html.match(/function frameAtTime\(t, p\) \{[\s\S]*?\n\}/);
  assert.ok(match, "found frameAtTime in index.html");
  const frameAtTime = new Function(`return (${match[0]})`)();

  const dt = 1 / 240; // 0.0041666... s
  const frames = [
    { t: 0.0, lm: [{ x: 0.1, y: 0.1 }] },
    { t: dt, lm: [{ x: 0.2, y: 0.2 }] },
    { t: dt * 2, lm: [{ x: 0.3, y: 0.3 }] },
    { t: dt * 3, lm: [{ x: 0.4, y: 0.4 }] },
  ];
  const p = { frames };

  // Exact match
  assert.equal(frameAtTime(0.0, p), frames[0]);
  assert.equal(frameAtTime(dt, p), frames[1]);

  // Very close to frame 1
  assert.equal(frameAtTime(dt + 0.0005, p), frames[1]);
  assert.equal(frameAtTime(dt - 0.0005, p), frames[1]);

  // Outside half a frame (e.g. 10 frames away)
  assert.equal(frameAtTime(dt * 10, p), null);
  assert.equal(frameAtTime(-0.1, p), null);

  // Empty frames
  assert.equal(frameAtTime(0.0, null), null);
  assert.equal(frameAtTime(0.0, { frames: [] }), null);
});

test("drawPose uses dashed strokes, night color, and no angle labels when isNight is true", () => {
  // Extract drawPose and helpers from index.html
  const code = `
    const BONE_COLOR = "rgba(255, 255, 255, 0.85)", JOINT_COLOR = "#22c55e";
    const SKELETON = [[11, 12], [11, 13], [13, 15]];
    const JOINTS = [11, 12, 13, 15];
    const L_INDEX = 19, R_INDEX = 20;
    const SHAFT_COLOR = "#000", SHAFT_GUESS_COLOR = "#111", SHAFT_CONFIDENT = 0.5;
    const REF_SPINE_COLOR = "#222", SPINE_COLOR = "#333";
    function point(lm, i) { return lm[i] || null; }
    function spineLine(lm, v) { return { hip: { x: 0.5, y: 0.5 }, shoulder: { x: 0.5, y: 0.2 }, angle: 45 }; }
    function getNightColor() { return "#38bdf8"; }
    function drawLabel() { throw new Error("drawLabel should not be called when isNight"); }
    function drawSpine(ctx, spine, toPx, lineWidth, isReference, isNight) {
      if (isNight) {
        ctx.strokeStyle = getNightColor();
        ctx.setLineDash([lineWidth * 2.5, lineWidth * 1.8]);
      }
    }
    function drawShaft() {}
    ${html.match(/function drawPose\(ctx, frame, r, withLabel, p = pose\) \{[\s\S]*?\n\}/)[0]}
    return drawPose;
  `;
  const drawPose = new Function(code)();

  const strokes = [];
  const dashes = [];
  const ctx = {
    lineWidth: 1,
    lineCap: "butt",
    strokeStyle: "",
    fillStyle: "",
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() { strokes.push(this.strokeStyle); },
    fill() {},
    arc() {},
    setLineDash(d) { dashes.push([...d]); }
  };

  const frame = {
    t: 0.1,
    lm: {
      11: { x: 0.4, y: 0.3 },
      12: { x: 0.6, y: 0.3 },
      13: { x: 0.3, y: 0.4 },
      15: { x: 0.2, y: 0.5 },
    }
  };
  const r = { x: 0, y: 0, w: 400, h: 400 };

  // Draw night pose with withLabel=true
  drawPose(ctx, frame, r, true, { isNight: true, video: {} });

  assert.ok(dashes.length > 0, "setLineDash was called for dashed skeleton");
  assert.equal(dashes[0][0], 2.2 * 2.5, "dashed pattern configured");
  assert.equal(dashes[0][1], 2.2 * 1.8, "dashed pattern configured");
  assert.ok(strokes.every(s => s === "#38bdf8"), "all bones drawn in night color");
});
