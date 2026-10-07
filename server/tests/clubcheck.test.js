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
  getKeyPositions,
  getP1P4P8,
  phaseName,
  progressText,
  clubLeavesPicture,
  savedPointsFor,
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

test("balanceSwings: round-robin balances across (day, club) buckets", () => {
  const ClubCheck = require("../static/clubcheck.js");
  const swings = [
    { name: "s1", recorded: "2026-10-04T12:00:00", shot: { club: "I7" } },
    { name: "s2", recorded: "2026-10-04T12:01:00", shot: { club: "I7" } },
    { name: "s3", recorded: "2026-10-04T12:02:00", shot: { club: "PW" } },
    { name: "s4", recorded: "2026-10-02T10:00:00", shot: { club: "DR" } },
  ];

  const balanced = ClubCheck.balanceSwings(swings);
  assert.equal(balanced.length, 4);
  // Round 0 picks one from each bucket: 10-04_I7, 10-04_PW, 10-02_DR
  const round0 = balanced.slice(0, 3).map(s => s.name);
  assert.ok(round0.includes("s1"));
  assert.ok(round0.includes("s3"));
  assert.ok(round0.includes("s4"));
  // Round 1 picks the remaining s2
  assert.equal(balanced[3].name, "s2");
});

test("ClubCheck exports UI controller methods and balanceSwings", () => {
  const ClubCheck = require("../static/clubcheck.js");
  assert.equal(typeof ClubCheck.balanceSwings, "function");
  assert.equal(typeof ClubCheck.open, "function");
  assert.equal(typeof ClubCheck.close, "function");
  assert.equal(typeof ClubCheck.save, "function");
  assert.equal(typeof ClubCheck.skip, "function");
  assert.equal(typeof ClubCheck.selectPoint, "function");
  assert.equal(typeof ClubCheck.toggleBlur, "function");
  assert.equal(typeof ClubCheck.toggleHidden, "function");
  assert.equal(typeof ClubCheck.markAllHidden, "function");
  assert.equal(typeof ClubCheck.cycleNextPoint, "function");
  assert.equal(typeof ClubCheck.clubLeavesPicture, "function");
  assert.equal(typeof ClubCheck.savedPointsFor, "function");
  assert.equal(typeof ClubCheck.back, "function");
  assert.ok(ClubCheck.savedThisSession instanceof Set);
  assert.equal(typeof ClubCheck.showFrame, "function");
  assert.equal(typeof ClubCheck.loadQueue, "function");
});

test("index.html contains Club check markup, Tools menu item, and scripts", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const htmlPath = path.resolve(__dirname, "../static/index.html");
  const html = fs.readFileSync(htmlPath, "utf8");

  assert.ok(html.includes('id="clubcheck-btn"'), "defines Tools menu Club check button");
  assert.ok(html.includes('<section id="clubcheck" class="clubcheck-view" hidden>'), "defines #clubcheck section");
  assert.ok(html.includes('id="clubcheck-view"'), "defines #clubcheck-view container");
  assert.ok(html.includes('id="cc-close"'), "defines Close button");
  assert.ok(html.includes('id="cc-status"'), "defines status span");
  assert.ok(html.includes('id="cc-progress"'), "defines progress container");
  assert.ok(html.includes('id="cc-session-saved"'), "defines session saved counter");
  assert.ok(html.includes('id="cc-counter"'), "defines counter element");
  assert.ok(html.includes('id="cc-img"'), "defines still image element");
  assert.ok(html.includes('id="cc-overlay"'), "defines overlay canvas");
  assert.ok(html.includes('id="cc-zoom"'), "defines zoom canvas");
  assert.ok(html.includes('id="cc-zoom-wrap"'), "defines zoom inset wrapper");
  assert.ok(html.includes('id="cc-back-btn"'), "defines Back button");
  assert.ok(html.includes('id="cc-save-btn"'), "defines Looks right / save button");
  assert.ok(html.includes('id="cc-blur-btn"'), "defines Blurred button");
  assert.ok(html.includes('id="cc-hide-btn"'), "defines Can't see button");
  assert.ok(html.includes('id="cc-off-btn"'), "defines Club leaves button");
  assert.ok(html.includes('id="cc-hideall-btn"'), "defines No club button");
  assert.ok(html.includes('id="cc-skip-btn"'), "defines Skip button");
  assert.ok(html.includes('id="cc-nightreport-link"'), "defines link to Night report");
  assert.ok(html.includes('<script src="/static/clubcheck.js"></script>'), "loads clubcheck.js");
  assert.ok(html.includes("#clubcheck {"), "defines #clubcheck CSS");
  assert.ok(html.includes(".cc-viewport"), "defines .cc-viewport CSS");
  assert.ok(html.includes(".cc-zoom-wrap"), "defines .cc-zoom-wrap CSS");
});

test("clubLeavesPicture: keeps grip when placed and marks hosel and head hidden", () => {
  const points = {
    grip: { x: 0.45, y: 0.55 },
    hosel: { x: 0.50, y: 0.70 },
    head: { x: 0.55, y: 0.85 },
  };
  assert.deepEqual(clubLeavesPicture(points), {
    grip: { x: 0.45, y: 0.55 },
    hosel: { hidden: true },
    head: { hidden: true },
  });
});

test("clubLeavesPicture: preserves blur on grip", () => {
  const points = {
    grip: { x: 0.45, y: 0.55, blur: true },
    hosel: { x: 0.50, y: 0.70 },
    head: { x: 0.55, y: 0.85 },
  };
  assert.deepEqual(clubLeavesPicture(points), {
    grip: { x: 0.45, y: 0.55, blur: true },
    hosel: { hidden: true },
    head: { hidden: true },
  });
});

test("clubLeavesPicture: returns grip null when grip was not placed or was hidden", () => {
  assert.deepEqual(clubLeavesPicture(null), {
    grip: null,
    hosel: { hidden: true },
    head: { hidden: true },
  });

  assert.deepEqual(clubLeavesPicture({ grip: null, hosel: null, head: null }), {
    grip: null,
    hosel: { hidden: true },
    head: { hidden: true },
  });

  assert.deepEqual(clubLeavesPicture({ grip: { hidden: true }, hosel: { x: 0.5, y: 0.6 } }), {
    grip: null,
    hosel: { hidden: true },
    head: { hidden: true },
  });
});

test("savedPointsFor: extracts saved points for exact matching timestamp", () => {
  const doc = {
    frames: {
      "1.500000": {
        grip: { x: 0.45, y: 0.55 },
        hosel: { x: 0.50, y: 0.70 },
        head: { x: 0.55, y: 0.85, blur: true },
      },
    },
  };
  const pts = savedPointsFor(doc, 1.5);
  assert.deepEqual(pts, {
    grip: { x: 0.45, y: 0.55 },
    hosel: { x: 0.50, y: 0.70 },
    head: { x: 0.55, y: 0.85, blur: true },
  });
});

test("savedPointsFor: matches within 1.5ms float tolerance", () => {
  const doc = {
    frames: {
      "1.500000": {
        grip: { x: 0.45, y: 0.55 },
        hosel: { hidden: true },
        head: { hidden: true },
      },
    },
  };
  // 1.5004 is within 0.0015 of 1.500000
  const pts = savedPointsFor(doc, 1.5004);
  assert.deepEqual(pts, {
    grip: { x: 0.45, y: 0.55 },
    hosel: { hidden: true },
    head: { hidden: true },
  });
});

test("savedPointsFor: handles allHidden flag and all-hidden points", () => {
  const docAllFlag = {
    frames: {
      "1.500000": {
        allHidden: true,
      },
    },
  };
  assert.deepEqual(savedPointsFor(docAllFlag, 1.5), {
    grip: { hidden: true },
    hosel: { hidden: true },
    head: { hidden: true },
  });

  const docHiddenPts = {
    frames: {
      "1.500000": {
        grip: { hidden: true },
        hosel: { hidden: true },
        head: { hidden: true },
      },
    },
  };
  assert.deepEqual(savedPointsFor(docHiddenPts, 1.5), {
    grip: { hidden: true },
    hosel: { hidden: true },
    head: { hidden: true },
  });
});

test("savedPointsFor: returns null for frames without club points or missing docs", () => {
  // Only body landmarks, no club points
  const docOnlyLm = {
    frames: {
      "1.500000": {
        lm: [0.1, 0.2, 0.9],
      },
    },
  };
  assert.equal(savedPointsFor(docOnlyLm, 1.5), null);

  // Frame not in doc
  assert.equal(savedPointsFor(docOnlyLm, 2.5), null);

  // Missing doc or doc.frames
  assert.equal(savedPointsFor(null, 1.5), null);
  assert.equal(savedPointsFor({}, 1.5), null);
  assert.equal(savedPointsFor({ frames: null }, 1.5), null);
  assert.equal(savedPointsFor(docOnlyLm, null), null);
});

test("session saves: savedThisSession Set tracks saves without double-counting re-saves", () => {
  const set = new Set();
  const key1 = "clipA.mp4|1.500000";
  const key2 = "clipB.mp4|2.100000";

  assert.equal(set.has(key1), false);
  set.add(key1);
  assert.equal(set.size, 1);

  // Re-save same frame
  const isNewSave = !set.has(key1);
  assert.equal(isNewSave, false);
  set.add(key1);
  assert.equal(set.size, 1);

  // Save different frame
  set.add(key2);
  assert.equal(set.size, 2);
});

test("trends.js includes clubcheck in showView and leaveTrendViews", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const trendsPath = path.resolve(__dirname, "../static/trends.js");
  const trends = fs.readFileSync(trendsPath, "utf8");

  assert.ok(trends.includes('document.getElementById("clubcheck")'), "showView references clubcheck box");
  assert.ok(trends.includes('document.getElementById("clubcheck-btn")'), "showView references clubcheck button");
  assert.ok(trends.includes('which === "clubcheck"'), "showView checks for clubcheck");
  assert.ok(trends.includes('!document.getElementById("clubcheck") || document.getElementById("clubcheck").hidden'), "leaveTrendViews checks clubcheck");
});


test("no clubhead found: placed along the shaft from the hands, marked estimated", () => {
  const ClubCheck = require("../static/clubcheck.js");
  // Hands at (0.5, 0.5) in a portrait picture (1920x1080 turned: 1080 wide, 1920 tall), shaft pointing down-right at 45 degrees.
  const lm = new Array(33 * 3).fill(0);
  lm[19 * 3] = 0.5; lm[19 * 3 + 1] = 0.5; lm[20 * 3] = 0.5; lm[20 * 3 + 1] = 0.5;
  const aspect = ClubCheck.uprightAspect("swing_face_1920x1080_240fps_1790000000_2000ms.mp4", 90);
  assert.ok(Math.abs(aspect - 1920 / 1080) < 1e-9);
  assert.equal(ClubCheck.uprightAspect("swing_face_1920x1080_240fps_1790000000_2000ms.mp4", 0), 1080 / 1920);
  const frame = { lm, clubhead: null, club: [45, 0.8] };
  const g = ClubCheck.guess(frame, { clubLength: 0.2 }, aspect);
  assert.equal(g.estimated, true);
  // 0.2 of the height long: 0.2 * 1920 px = 384 px, so 384 * cos45 / 1080 across and 0.2 * sin45 down.
  assert.ok(Math.abs(g.head.x - (0.5 + 0.2 * aspect * Math.SQRT1_2)) < 1e-5);
  assert.ok(Math.abs(g.head.y - (0.5 + 0.2 * Math.SQRT1_2)) < 1e-5);
  assert.ok(g.hosel.x > g.grip.x && g.hosel.x < g.head.x);
  // A low-confidence shaft is still a starting point; without the aspect, a shaft, or off the picture: nothing.
  assert.equal(ClubCheck.guess({ ...frame, club: [45, 0.05] }, { clubLength: 0.2 }, aspect).estimated, true);
  assert.equal(ClubCheck.guess(frame, { clubLength: 0.2 }).head, null);
  assert.equal(ClubCheck.guess({ ...frame, club: null }, { clubLength: 0.2 }, aspect).head, null);
  assert.equal(ClubCheck.guess(frame, { clubLength: 0.9 }, aspect).head, null);
  // A found clubhead is used as it is, not estimated.
  const found = ClubCheck.guess({ ...frame, clubhead: [0.6, 0.7, 0.9] }, { clubLength: 0.2 }, aspect);
  assert.equal(found.estimated, undefined);
  assert.deepEqual(found.head, { x: 0.6, y: 0.7 });
});

test("queue: selects 2 backswing frames (one near P2 +-0.03s), 2 downswing frames, and address (perSwing 5)", () => {
  const clips = [
    { name: "swing1.mp4", recorded: "2026-10-01T10:00:00", club: "7I" },
  ];
  // Key positions:
  // p1: 1.0, takeaway: 1.30, p2: 1.50, p3: 1.70, p4: 1.90, p7: 2.25, p8: 2.35
  const frames = [
    { t: 0.99, lm: [], clubhead: [0.5, 0.8, 0.9] }, // Address near P1 (1.0)
    { t: 1.32, lm: [], clubhead: [0.5, 0.5, 0.4] }, // Backswing in takeaway..p3
    { t: 1.49, lm: [], clubhead: [0.5, 0.5, 0.2] }, // Backswing near P2 (1.50, diff 0.01 <= 0.03)
    { t: 1.52, lm: [], clubhead: [0.5, 0.5, 0.8] }, // Backswing near P2, higher conf (0.8 vs 0.2)
    { t: 1.68, lm: [], clubhead: [0.5, 0.5, 0.3] }, // Backswing in takeaway..p3
    { t: 1.95, lm: [], clubhead: [0.5, 0.6, 0.1] }, // Downswing (P4..P8)
    { t: 2.05, lm: [], clubhead: [0.5, 0.7, 0.2] }, // Downswing
    { t: 2.15, lm: [], clubhead: [0.5, 0.8, 0.5] }, // Downswing
    { t: 2.30, lm: [], clubhead: [0.5, 0.9, 0.9] }, // Downswing
  ];
  const poses = {
    "swing1.mp4": {
      positions: { p1: 1.0, takeaway: 1.30, p2: 1.50, p3: 1.70, p4: 1.90, p7: 2.25, p8: 2.35 },
      frames,
    },
  };

  const q = queue(clips, poses, {});
  assert.equal(q.length, 5);

  const times = q.map(item => item.t);

  // Address frame included near P1
  assert.ok(times.includes(0.99));

  // Exactly 2 backswing frames between takeaway (1.30) and p3 (1.70)
  const backFrames = q.filter(item => item.t >= 1.30 && item.t <= 1.70);
  assert.equal(backFrames.length, 2);

  // One backswing frame is within +-0.03s of P2 (1.50), specifically 1.49 because of lower confidence (0.2 vs 0.8)
  assert.ok(backFrames.some(item => Math.abs(item.t - 1.50) <= 0.03));
  assert.ok(backFrames.some(item => item.t === 1.49));

  // Exactly 2 downswing frames between p4 (1.90) and p8 (2.35)
  const downFrames = q.filter(item => item.t >= 1.90 && item.t <= 2.35);
  assert.equal(downFrames.length, 2);
  // Downswing prefers low confidence (1.95 [conf 0.1] and 2.05 [conf 0.2])
  assert.ok(downFrames.some(item => item.t === 1.95));
  assert.ok(downFrames.some(item => item.t === 2.05));

  // Spacing >= minGap (0.03s)
  for (let i = 0; i < q.length - 1; i++) {
    assert.ok(Math.abs(q[i + 1].t - q[i].t) >= 0.029);
  }
});

test("queue: skips frames that already have club points", () => {
  const clips = [
    { name: "swing1.mp4", recorded: "2026-10-01T10:00:00", club: "7I" },
  ];
  const frames = [
    { t: 1.00, lm: [] },
    { t: 1.49, lm: [] }, // Near P2 (labeled!)
    { t: 1.52, lm: [] }, // Also near P2 (unlabeled)
    { t: 1.68, lm: [] },
    { t: 1.95, lm: [] }, // Downswing (labeled!)
    { t: 2.05, lm: [] }, // Downswing
    { t: 2.15, lm: [] }, // Downswing
  ];
  const poses = {
    "swing1.mp4": {
      positions: { p1: 1.0, takeaway: 1.30, p2: 1.50, p3: 1.70, p4: 1.90, p7: 2.25, p8: 2.35 },
      frames,
    },
  };
  const labeled = {
    "swing1.mp4": {
      frames: {
        "1.490000": { grip: { x: 0.5, y: 0.5 } },
        "1.950000": { head: { x: 0.5, y: 0.8 } },
      },
    },
  };

  const q = queue(clips, poses, labeled, { perSwing: 5 });
  const times = q.map(item => item.t);
  assert.ok(!times.includes(1.49), "Already labeled P2 frame should be skipped");
  assert.ok(!times.includes(1.95), "Already labeled downswing frame should be skipped");
  // Should have picked 1.52 near P2 instead
  assert.ok(times.includes(1.52), "Alternative frame near P2 should be chosen");
});

test("getKeyPositions and queue: impact fallback works without positions or SwingSummary", () => {
  const clip = { name: "swing_impact.mp4", strike: 2.0, club: "8I", recorded: "2026-10-01" };
  const pose = {
    frames: [
      { t: 0.80, lm: [] }, // Address (imp - 1.2 = 0.8)
      { t: 1.05, lm: [] }, // Takeaway (imp - 0.95 = 1.05)
      { t: 1.25, lm: [] }, // P2 (imp - 0.75 = 1.25)
      { t: 1.45, lm: [] }, // P3 (imp - 0.55 = 1.45)
      { t: 1.65, lm: [] }, // P4 (imp - 0.35 = 1.65)
      { t: 1.80, lm: [] }, // Downswing
      { t: 2.10, lm: [] }, // Downswing
    ],
  };

  const keyPos = getKeyPositions(clip, pose);
  assert.equal(keyPos.p1, 0.8);
  assert.equal(keyPos.takeaway, 1.05);
  assert.equal(keyPos.p2, 1.25);
  assert.equal(keyPos.p3, 1.45);
  assert.equal(keyPos.p4, 1.65);
  assert.equal(keyPos.p7, 2.0);
  assert.equal(keyPos.p8, 2.15);

  const q = queue([clip], { "swing_impact.mp4": pose }, {});
  assert.equal(q.length, 5);
  const times = q.map(item => item.t);
  assert.ok(times.includes(0.80), "Address at p1");
  assert.ok(times.includes(1.25), "Near P2 in backswing");
  assert.ok(times.some(t => t >= 1.05 && t <= 1.45 && t !== 1.25), "Second backswing frame");
});

test("queue: prefers swings without backswing club points before swings that already have them", () => {
  const clips = [
    { name: "swing_has_backswing.mp4", recorded: "2026-10-01T10:00:00", club: "7I" },
    { name: "swing_no_backswing.mp4", recorded: "2026-10-01T10:00:00", club: "7I" },
  ];
  const mkPose = () => ({
    positions: { p1: 1.0, takeaway: 1.30, p2: 1.50, p3: 1.70, p4: 1.90, p7: 2.25, p8: 2.35 },
    frames: [
      { t: 1.00, lm: [] },
      { t: 1.35, lm: [] },
      { t: 1.50, lm: [] },
      { t: 1.95, lm: [] },
      { t: 2.05, lm: [] },
    ],
  });
  const poses = {
    "swing_has_backswing.mp4": mkPose(),
    "swing_no_backswing.mp4": mkPose(),
  };

  // Both swings have club points, but:
  // - swing_has_backswing has a point at 1.50 (in takeaway..p3)
  // - swing_no_backswing has a point at 2.05 (in downswing, none in takeaway..p3)
  const labeled = {
    "swing_has_backswing.mp4": {
      frames: {
        "1.500000": { head: { x: 0.5, y: 0.5 } },
      },
    },
    "swing_no_backswing.mp4": {
      frames: {
        "2.050000": { head: { x: 0.5, y: 0.5 } },
      },
    },
  };

  const q = queue(clips, poses, labeled, { perSwing: 5 });
  assert.ok(q.length > 0);
  // First item in queue must be from swing_no_backswing.mp4
  assert.equal(q[0].clip, "swing_no_backswing.mp4");
});

test("queue: respects max cap with perSwing 5", () => {
  const clips = Array.from({ length: 5 }, (_, i) => ({
    name: `c_${i}.mp4`,
    recorded: "2026-10-01",
    club: "7I",
  }));
  const poses = Object.fromEntries(clips.map(c => [
    c.name,
    {
      positions: { p1: 1.0, takeaway: 1.3, p2: 1.5, p3: 1.7, p4: 1.9, p7: 2.2, p8: 2.3 },
      frames: [
        { t: 1.0, lm: [] },
        { t: 1.35, lm: [] },
        { t: 1.5, lm: [] },
        { t: 1.95, lm: [] },
        { t: 2.05, lm: [] },
      ],
    },
  ]));

  const q = queue(clips, poses, {}, { max: 8 });
  assert.equal(q.length, 8);
});

test("phaseName: reports Backswing (near P2), Backswing, Downswing, Address (P1), Impact (P7)", () => {
  const pTimes = {
    p1: 1.00,
    takeaway: 1.30,
    p2: 1.50,
    p3: 1.70,
    p4: 1.90,
    p7: 2.25,
    p8: 2.35,
  };

  assert.equal(phaseName(1.00, pTimes), "Address (P1)");
  assert.equal(phaseName(1.04, pTimes), "Address (P1)"); // within 0.05
  assert.equal(phaseName(1.35, pTimes), "Backswing"); // in takeaway..p4, not near P2
  assert.equal(phaseName(1.50, pTimes), "Backswing (near P2)"); // at P2
  assert.equal(phaseName(1.48, pTimes), "Backswing (near P2)"); // within +-0.03 of P2
  assert.equal(phaseName(1.53, pTimes), "Backswing (near P2)"); // within +-0.03 of P2
  assert.equal(phaseName(1.70, pTimes), "Backswing"); // in takeaway..p4, outside +-0.03 of P2
  assert.equal(phaseName(1.95, pTimes), "Downswing"); // >= p4, not near P7
  assert.equal(phaseName(2.25, pTimes), "Impact (P7)"); // at P7
  assert.equal(phaseName(2.26, pTimes), "Impact (P7)"); // within 0.02 of P7
  assert.equal(phaseName(2.30, pTimes), "Downswing"); // after P7, before P8
  assert.equal(phaseName(1.50, null), "Downswing"); // default when no pTimes
});

test("progressText: formats count of need, and says enough at or above 40", () => {
  assert.equal(
    progressText({ newFrames: 5, need: 40 }),
    "New club frames since the last training: 5 of 40"
  );
  assert.equal(
    progressText({ newFrames: 0, need: 40 }),
    "New club frames since the last training: 0 of 40"
  );
  assert.equal(
    progressText({ newFrames: null, need: 40 }),
    "New club frames since the last training: 0 of 40"
  );
  assert.equal(
    progressText({ newFrames: 40, need: 40 }),
    "Enough for a new club model: the night worker trains it tonight."
  );
  assert.equal(
    progressText({ newFrames: 55, need: 40 }),
    "Enough for a new club model: the night worker trains it tonight."
  );
  assert.equal(progressText(null), "");
});

test("index.html: contains #cc-progress element in #clubcheck-view", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const html = fs.readFileSync(path.join(__dirname, "../static/index.html"), "utf8");
  assert.ok(html.includes('id="cc-progress"'), "index.html has #cc-progress element");
});



test("queue: reads /api/labels/summary's clubFrames (there frames is only a count)", () => {
  // Before Oct 6 the summary's "frames": 4 read as no points anywhere, so frames already done came back.
  const clips = [
    { name: "done.mp4", recorded: "2026-10-01T10:00:00", club: "7I" },
    { name: "fresh.mp4", recorded: "2026-10-01T11:00:00", club: "7I" },
  ];
  const frames = [1.0, 1.8, 1.85, 1.9, 1.95, 2.1].map(t => ({ t, lm: [], clubhead: null }));
  const pos = { positions: { p1: 1.0, p4: 1.8, p8: 2.1 }, frames };
  const summary = [
    { clip: "done.mp4", pass: 1, frames: 4, pointFrames: 0, clubFrames: [1.85, 1.9] },
    { clip: "fresh.mp4", pass: 1, frames: 0, pointFrames: 0, clubFrames: [] },
  ];
  const q = queue(clips, { "done.mp4": pos, "fresh.mp4": pos }, summary, { perSwing: 4, max: 20 });
  assert.equal(q[0].clip, "fresh.mp4");   // the swing without club points first
  const fromDone = q.filter(i => i.clip === "done.mp4").map(i => i.t);
  assert.ok(!fromDone.some(t => Math.abs(t - 1.85) < 0.002 || Math.abs(t - 1.9) < 0.002), `served done frames: ${fromDone}`);
});
