// server/tests/wristcheck.test.js: unit tests for SwingWristCheck pure helpers
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  shotsFromRun,
  getWristPoint,
  cropBoxFromWrist
} = require("../static/wristcheck.js");

test("shotsFromRun: extracts ordered ball shots with DTL partner, skips taps and missing partners", () => {
  const run = {
    started: 1728250000,
    program: {
      blocks: [
        { id: "b1", name: "Tier 1: drill" },
        { id: "b2", name: "Tier 2: full swing" }
      ]
    },
    wrist: {
      "swing_face_1.mp4": "flat",
      "swing_face_3.mp4": "bowed"
    },
    reps: [
      { t: 10, block: "b1", kind: "tap", pass: true },
      { t: 30, block: "b2", kind: "shot", clip: "swing_face_2.mp4", partner: "swing_dtl_2.mp4", club: "7I", gate: false },
      { t: 20, block: "b2", kind: "shot", clip: "swing_face_1.mp4", partner: "swing_dtl_1.mp4", club: "7I", gate: true },
      { t: 40, block: "b2", kind: "shot", clip: "swing_face_solo.mp4", partner: null, club: "7I", gate: true }, // skipped (no DTL)
      { t: 50, block: "b2", kind: "shot", clip: "swing_face_3.mp4", partner: "swing_dtl_3.mp4", club: "7I", waiting3d: true },
      { t: 60, block: "b2", kind: "ball", clip: "swing_face_4.mp4", partner: "swing_dtl_4.mp4", club: "7I", noRead: "strike not read" }
    ]
  };

  const shots = shotsFromRun(run);
  assert.equal(shots.length, 4);

  // Sorted by t: t=20 first, t=30 second, t=50 third, t=60 fourth
  assert.equal(shots[0].index, 1);
  assert.equal(shots[0].clip, "swing_face_1.mp4");
  assert.equal(shots[0].partner, "swing_dtl_1.mp4");
  assert.equal(shots[0].block, "Tier 2: full swing");
  assert.equal(shots[0].verdict, "pass");
  assert.equal(shots[0].wrist, "flat");

  assert.equal(shots[1].index, 2);
  assert.equal(shots[1].clip, "swing_face_2.mp4");
  assert.equal(shots[1].verdict, "miss");
  assert.equal(shots[1].wrist, null);

  assert.equal(shots[2].index, 3);
  assert.equal(shots[2].clip, "swing_face_3.mp4");
  assert.equal(shots[2].verdict, "waiting for 3D");
  assert.equal(shots[2].wrist, "bowed");

  assert.equal(shots[3].index, 4);
  assert.equal(shots[3].clip, "swing_face_4.mp4");
  assert.equal(shots[3].verdict, "invalid read (strike not read)");
  assert.equal(shots[3].wrist, null);
});

test("shotsFromRun: includes lone DTL shots without partner when judging DTL", () => {
  const run = {
    started: 1728250000,
    reps: [
      { t: 10, block: "b1", kind: "shot", clip: "swing_dtl_solo.mp4", partner: null, club: "7I", gate: true },
      { t: 20, block: "b1", kind: "shot", clip: "swing_face_solo.mp4", partner: null, club: "7I", gate: true },
    ]
  };
  const dtlShots = shotsFromRun(run, null, "dtl");
  assert.equal(dtlShots.length, 1);
  assert.equal(dtlShots[0].clip, "swing_dtl_solo.mp4");

  const faceShots = shotsFromRun(run, null, "face");
  assert.equal(faceShots.length, 1);
  assert.equal(faceShots[0].clip, "swing_face_solo.mp4");
});

test("shotsFromRun: handles empty run or no ball reps", () => {
  assert.deepEqual(shotsFromRun(null), []);
  assert.deepEqual(shotsFromRun({}), []);
  assert.deepEqual(shotsFromRun({ reps: [] }), []);
  assert.deepEqual(shotsFromRun({ reps: [{ kind: "tap" }] }), []);
});

test("getWristPoint: finds landmark 15 at impact frame from flat array", () => {
  const lm = new Array(33 * 3).fill(0);
  // Landmark 15 = index 45 (x), 46 (y), 47 (z)
  lm[45] = 0.52;
  lm[46] = 0.68;

  const poseData = {
    impact: 2.1,
    frames: [
      { t: 1.0, lm: new Array(99).fill(0.1) },
      { t: 2.1, lm: lm },
      { t: 3.0, lm: new Array(99).fill(0.9) }
    ]
  };

  const pt = getWristPoint(poseData);
  assert.ok(pt);
  assert.equal(pt.x, 0.52);
  assert.equal(pt.y, 0.68);
});

test("getWristPoint: finds landmark 15 from object array format", () => {
  const lmObjects = [];
  for (let i = 0; i < 33; i++) {
    lmObjects.push({ x: 0.1, y: 0.2 });
  }
  lmObjects[15] = { x: 0.44, y: 0.59 };

  const poseData = {
    strike: 1.5,
    frames: [
      { t: 1.5, lm: lmObjects }
    ]
  };

  const pt = getWristPoint(poseData);
  assert.ok(pt);
  assert.equal(pt.x, 0.44);
  assert.equal(pt.y, 0.59);
});

test("getWristPoint: returns null when pose has no frames or missing landmark", () => {
  assert.equal(getWristPoint(null), null);
  assert.equal(getWristPoint({}), null);
  assert.equal(getWristPoint({ frames: [] }), null);
  assert.equal(getWristPoint({ frames: [{ t: 1.0, lm: [] }] }), null);
});

test("cropBoxFromWrist: returns middle 60% when wristPoint is null", () => {
  const crop = cropBoxFromWrist(null, 1920, 1080);
  assert.equal(crop.width, Math.round(1920 * 0.60)); // 1152
  assert.equal(crop.height, Math.round(1080 * 0.60)); // 648
  assert.equal(crop.x, Math.round(1920 * 0.20)); // 384
  assert.equal(crop.y, Math.round(1080 * 0.20)); // 216
});

test("cropBoxFromWrist: centers crop box around wrist point", () => {
  // Center of image: (0.5, 0.5)
  const crop = cropBoxFromWrist({ x: 0.5, y: 0.5 }, 1000, 1000, { size: 0.35 });
  assert.equal(crop.width, 350);
  assert.equal(crop.height, 350);
  // Center is at 500, box is 350 -> starts at 500 - 175 = 325
  assert.equal(crop.x, 325);
  assert.equal(crop.y, 325);
});

test("cropBoxFromWrist: clamps to image boundaries near edges", () => {
  // Near top-left (0.05, 0.05)
  const cropTL = cropBoxFromWrist({ x: 0.05, y: 0.05 }, 1000, 1000, { size: 0.35 });
  assert.equal(cropTL.width, 350);
  assert.equal(cropTL.height, 350);
  assert.equal(cropTL.x, 0); // clamped to 0
  assert.equal(cropTL.y, 0); // clamped to 0

  // Near bottom-right (0.95, 0.95)
  const cropBR = cropBoxFromWrist({ x: 0.95, y: 0.95 }, 1000, 1000, { size: 0.35 });
  assert.equal(cropBR.width, 350);
  assert.equal(cropBR.height, 350);
  assert.equal(cropBR.x, 650); // clamped to 1000 - 350
  assert.equal(cropBR.y, 650); // clamped to 1000 - 350
});

test("cropBoxFromWrist: handles pixel coordinate inputs", () => {
  const crop = cropBoxFromWrist({ x: 500, y: 500 }, 1000, 1000, { size: 0.35 });
  assert.equal(crop.width, 350);
  assert.equal(crop.height, 350);
  assert.equal(crop.x, 325);
  assert.equal(crop.y, 325);
});

test("index.html contains Wrist check tools button, section, and script tag", () => {
  const html = fs.readFileSync(path.join(__dirname, "../static/index.html"), "utf8");
  assert.ok(html.includes('id="wristcheck-btn"'));
  assert.ok(html.includes('id="wristcheck"'));
  assert.ok(html.includes('src="/static/wristcheck.js"'));
  assert.ok(html.includes('wristcheck: "wristcheck-btn"'));
});
