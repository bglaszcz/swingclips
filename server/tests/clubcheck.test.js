// Tests for Club Check pure helpers (server/static/clubcheck.js)
//
//   node --test tests/clubcheck.test.js

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HOSEL_SHARE,
  guess,
  queue,
  merge,
} = require("../static/clubcheck.js");

test("HOSEL_SHARE is 0.93", () => {
  assert.equal(HOSEL_SHARE, 0.93);
});

test("guess: confident clubhead computes grip, hosel (at 0.93), and head", () => {
  // Landmark array with index knuckles at 19 and 20:
  // 19: (0.50, 0.60), 20: (0.60, 0.60) -> midpoint: (0.55, 0.60)
  const lm = new Array(33 * 3).fill(0);
  lm[19 * 3] = 0.50; lm[19 * 3 + 1] = 0.60; lm[19 * 3 + 2] = 0.9;
  lm[20 * 3] = 0.60; lm[20 * 3 + 1] = 0.60; lm[20 * 3 + 2] = 0.9;

  const frame = {
    t: 1.5,
    lm,
    clubhead: [0.55, 0.90, 0.85], // conf 0.85 >= 0.25
  };

  const res = guess(frame, {});
  assert.notEqual(res.head, null);
  assert.equal(res.head.x, 0.55);
  assert.equal(res.head.y, 0.90);

  assert.notEqual(res.grip, null);
  assert.equal(res.grip.x, 0.55);
  assert.equal(res.grip.y, 0.60);

  // Hosel at 0.93 between grip (0.55, 0.60) and head (0.55, 0.90)
  // dy = 0.30, 0.60 + 0.30 * 0.93 = 0.60 + 0.279 = 0.879
  assert.notEqual(res.hosel, null);
  assert.equal(res.hosel.x, 0.55);
  assert.equal(res.hosel.y, 0.879);
});

test("guess: falls back to wrists when index knuckles are missing", () => {
  const lm = new Array(33 * 3).fill(0);
  // Wrists 15 and 16
  lm[15 * 3] = 0.40; lm[15 * 3 + 1] = 0.50;
  lm[16 * 3] = 0.50; lm[16 * 3 + 1] = 0.50;

  const frame = {
    t: 1.5,
    lm,
    clubhead: [0.45, 0.80, 0.5],
  };

  const res = guess(frame, {});
  assert.equal(res.grip.x, 0.45);
  assert.equal(res.grip.y, 0.50);
  assert.equal(res.head.x, 0.45);
  assert.equal(res.head.y, 0.80);
});

test("guess: returns all three null when clubhead is unconfident (< 0.25) or null", () => {
  const lm = new Array(33 * 3).fill(0);
  lm[19 * 3] = 0.5; lm[19 * 3 + 1] = 0.6;
  lm[20 * 3] = 0.5; lm[20 * 3 + 1] = 0.6;

  // Unconfident (0.15 < 0.25)
  const lowConf = {
    t: 1.5,
    lm,
    clubhead: [0.55, 0.90, 0.15],
  };
  assert.deepEqual(guess(lowConf, {}), { grip: null, hosel: null, head: null });

  // Missing clubhead
  const noHead = {
    t: 1.5,
    lm,
    clubhead: null,
  };
  assert.deepEqual(guess(noHead, {}), { grip: null, hosel: null, head: null });

  // Null frame
  assert.deepEqual(guess(null, {}), { grip: null, hosel: null, head: null });
});

test("queue: swings without club points first, low-confidence frames first, spacing >= 0.03s", () => {
  const clips = [
    { name: "clip_with_club.mp4", recorded: "2026-10-01T10:00:00", club: "7I" },
    { name: "clip_no_club_1.mp4", recorded: "2026-10-01T11:00:00", club: "7I" },
    { name: "clip_no_club_2.mp4", recorded: "2026-10-02T10:00:00", club: "DR" },
  ];

  const mkFrames = () => [
    { t: 1.0, lm: [], clubhead: [0.5, 0.8, 0.9] }, // Address near P1
    { t: 1.8, lm: [], clubhead: [0.5, 0.6, 0.8] }, // P4
    { t: 1.81, lm: [], clubhead: null },            // Downswing (very close to 1.8: < 0.03s)
    { t: 1.85, lm: [], clubhead: null },            // Downswing: missing clubhead (conf 0)
    { t: 1.90, lm: [], clubhead: [0.5, 0.7, 0.2] }, // Downswing: low conf 0.2
    { t: 1.95, lm: [], clubhead: [0.5, 0.8, 0.8] }, // Downswing: confident 0.8
    { t: 2.1, lm: [], clubhead: [0.5, 0.9, 0.9] }, // P8
  ];

  const poses = {
    "clip_with_club.mp4": { positions: { p1: 1.0, p4: 1.8, p8: 2.1 }, frames: mkFrames() },
    "clip_no_club_1.mp4": { positions: { p1: 1.0, p4: 1.8, p8: 2.1 }, frames: mkFrames() },
    "clip_no_club_2.mp4": { positions: { p1: 1.0, p4: 1.8, p8: 2.1 }, frames: mkFrames() },
  };

  const labeled = {
    "clip_with_club.mp4": {
      frames: {
        "1.850000": { grip: { x: 0.5, y: 0.6 }, head: { x: 0.5, y: 0.8 } },
      },
    },
  };

  const q = queue(clips, poses, labeled, { perSwing: 4, max: 20 });
  assert.ok(q.length > 0);

  // Unlabeled swings come first
  assert.equal(q[0].clip.startsWith("clip_no_club"), true);

  // Frames from clip_no_club_1:
  const fromFirst = q.filter(item => item.clip === q[0].clip);
  assert.equal(fromFirst.length, 4);

  // Spacing >= 0.03s for all consecutive frames in the swing
  for (let i = 0; i < fromFirst.length - 1; i++) {
    const diff = Math.abs(fromFirst[i + 1].t - fromFirst[i].t);
    assert.ok(diff >= 0.029, `Spacing between ${fromFirst[i].t} and ${fromFirst[i + 1].t} was ${diff}`);
  }

  // Address frame (1.0) is included
  assert.ok(fromFirst.some(f => Math.abs(f.t - 1.0) < 0.01));

  // The swing with existing club points skips its already-labeled frame (1.85)
  const fromLabeled = q.filter(item => item.clip === "clip_with_club.mp4");
  assert.ok(fromLabeled.every(item => Math.abs(item.t - 1.85) > 0.001));
});

test("queue: respects max cap", () => {
  const clips = Array.from({ length: 10 }, (_, i) => ({
    name: `c_${i}.mp4`,
    recorded: "2026-10-01",
    club: "7I",
  }));
  const poses = Object.fromEntries(clips.map(c => [
    c.name,
    {
      positions: { p1: 1.0, p4: 1.8, p8: 2.1 },
      frames: [
        { t: 1.0, lm: [] },
        { t: 1.85, lm: [] },
        { t: 1.95, lm: [] },
        { t: 2.05, lm: [] },
      ],
    },
  ]));

  const q = queue(clips, poses, {}, { max: 7, perSwing: 4 });
  assert.equal(q.length, 7);
});

test("merge: preserves existing body points and updates club points with 6-decimal key", () => {
  const doc = {
    schema: 1,
    clip: { name: "test.mp4", angle: "face" },
    events: { impact: 2.1 },
    picked: { impact: "server" },
    frames: {
      "1.500000": {
        l_shoulder: { x: 0.4, y: 0.5 },
        r_shoulder: { x: 0.6, y: 0.5 },
      },
      "2.000000": {
        l_shoulder: { x: 0.42, y: 0.52 },
      },
    },
  };

  const points = {
    grip: { x: 0.55, y: 0.65 },
    hosel: { x: 0.54, y: 0.85 },
    head: { x: 0.53, y: 0.88, blur: true },
  };

  const res = merge(doc, 1.5, points);

  // Key is 6 decimals
  assert.ok(res.frames["1.500000"]);

  // Body points preserved
  assert.deepEqual(res.frames["1.500000"].l_shoulder, { x: 0.4, y: 0.5 });
  assert.deepEqual(res.frames["1.500000"].r_shoulder, { x: 0.6, y: 0.5 });

  // Club points added
  assert.deepEqual(res.frames["1.500000"].grip, { x: 0.55, y: 0.65 });
  assert.deepEqual(res.frames["1.500000"].hosel, { x: 0.54, y: 0.85 });
  assert.deepEqual(res.frames["1.500000"].head, { x: 0.53, y: 0.88, blur: true });

  // Other frame untouched
  assert.deepEqual(res.frames["2.000000"], { l_shoulder: { x: 0.42, y: 0.52 } });

  // Events, picked, clip untouched
  assert.deepEqual(res.events, { impact: 2.1 });
  assert.deepEqual(res.picked, { impact: "server" });
  assert.equal(res.clip.name, "test.mp4");

  // Original doc not mutated
  assert.equal(doc.frames["1.500000"].grip, undefined);
});

test("merge: supports hidden points and all-hidden club format", () => {
  const doc = { schema: 1, frames: {} };
  const allHidden = {
    grip: { hidden: true },
    hosel: { hidden: true },
    head: { hidden: true },
  };
  const res = merge(doc, 1.9031, allHidden);
  assert.equal(res.frames["1.903100"].grip.hidden, true);
  assert.equal(res.frames["1.903100"].hosel.hidden, true);
  assert.equal(res.frames["1.903100"].head.hidden, true);
});
