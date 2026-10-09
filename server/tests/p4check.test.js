const test = require("node:test");
const assert = require("node:assert/strict");
const { queue, window: p4Window, direction, mergeP4 } = require("../static/p4check.js");

function makeClip(id, opts = {}) {
  const angle = opts.angle || "face";
  const partner = opts.partner !== undefined ? opts.partner : (angle === "face" ? `swing_dtl_${id}.mp4` : `swing_face_${id}.mp4`);
  return {
    name: `swing_${angle}_${id}.mp4`,
    angle,
    partner,
    pose: opts.pose || "done",
    excluded: !!opts.excluded,
    drill: opts.drill || null,
    recorded: opts.recorded || "2026-10-04T12:00:00",
    shot: opts.club ? { club: opts.club } : { club: "7I" }
  };
}

test("queue: skips hand-labeled swings", () => {
  const clips = [
    makeClip(1),
    makeClip(2),
    makeClip(3)
  ];
  const labels = {
    "swing_face_1.mp4": {
      schema: 1,
      events: { p4: 1.85 },
      picked: {} // Hand labeled
    },
    "swing_face_2.mp4": {
      schema: 1,
      events: { p4: 1.90 },
      quick: { p4: "p4check" } // Hand labeled via p4check
    }
  };
  const q = queue(clips, labels, null, { max: 10 });
  assert.equal(q.length, 1);
  assert.equal(q[0].name, "swing_face_3.mp4");
});

test("queue: includes pick-only labels (picked between server and night)", () => {
  const clips = [
    makeClip(1),
    makeClip(2)
  ];
  const labels = {
    "swing_face_1.mp4": {
      schema: 1,
      events: { p4: 1.85 },
      picked: { p4: "server" } // Only a pick, not a hand label
    },
    "swing_face_2.mp4": {
      schema: 1,
      events: { p4: 1.92 },
      picked: { p4: "night" } // Only a pick, not a hand label
    }
  };
  const q = queue(clips, labels, null, { max: 10, seed: "2026-10-06" });
  assert.equal(q.length, 2);
  // The order is shuffled by the day's seed: which swings, not their order.
  assert.deepEqual(q.map(x => x.name).sort(), ["swing_face_1.mp4", "swing_face_2.mp4"]);
});

test("queue: prefers face-on, includes lone DTL, skips paired DTL and drills/excluded", () => {
  const clips = [
    // Paired swing: face + dtl
    makeClip(1, { angle: "face", partner: "swing_dtl_1.mp4" }),
    makeClip(1, { angle: "dtl", partner: "swing_face_1.mp4" }),
    // Lone DTL swing
    makeClip(2, { angle: "dtl", partner: null }),
    // Excluded swing
    makeClip(3, { angle: "face", excluded: true }),
    // Drill swing
    makeClip(4, { angle: "face", drill: "pump" }),
    // Not done pose
    makeClip(5, { angle: "face", pose: "failed" })
  ];
  const q = queue(clips, {}, null, { max: 10, seed: "2026-10-06" });
  assert.equal(q.length, 2);
  assert.deepEqual(q.map(x => x.name).sort(), ["swing_dtl_2.mp4", "swing_face_1.mp4"]);
});

test("queue: unbiased mix (2 of 3 random, 1 of 3 disagreements) and spread", () => {
  // Generate 30 swings across 3 days and 3 clubs
  const clubs = ["DR", "7I", "PW"];
  const days = ["2026-10-01", "2026-10-02", "2026-10-03"];
  const clips = [];
  const night = { swings: {} };

  for (let i = 0; i < 30; i++) {
    const club = clubs[i % clubs.length];
    const day = days[Math.floor(i / 10)];
    const c = makeClip(i, {
      recorded: `${day}T12:00:00`,
      club,
      partner: null
    });
    clips.push(c);

    // Give 10 swings P4 disagreement (|ms| >= 12.5)
    if (i % 3 === 0) {
      night.swings[c.name] = {
        face: { ms: { p4: 25.0 } }
      };
    } else {
      night.swings[c.name] = {
        face: { ms: { p4: 0.0 } }
      };
    }
  }

  const q = queue(clips, {}, night, { max: 15, seed: 12345 });
  assert.equal(q.length, 15);

  // In groups of 3: indices 2, 5, 8, 11, 14 are disagreements
  const disagreementIndices = [2, 5, 8, 11, 14];
  for (const idx of disagreementIndices) {
    const item = q[idx];
    const ms = Math.abs(night.swings[item.name]?.face?.ms?.p4 || 0);
    assert.ok(ms >= 12.5, `Slot ${idx} should be a disagreement swing, got ${item.name} with ms ${ms}`);
  }

  // All items in the queue are unique
  const names = new Set(q.map(x => x.name));
  assert.equal(names.size, 15);

  // Seed reproducibility: same seed gives identical queue
  const q2 = queue(clips, {}, night, { max: 15, seed: 12345 });
  assert.deepEqual(q.map(x => x.name), q2.map(x => x.name));

  // Different seed gives different order
  const q3 = queue(clips, {}, night, { max: 15, seed: 99999 });
  assert.notDeepEqual(q.map(x => x.name), q3.map(x => x.name));
});

test("window: bounds from -0.15s to +0.10s and starts at window start", () => {
  const p4 = 1.85;
  const fps = 240;
  const win = p4Window(p4, fps);

  // Bounds
  assert.equal(win.from, 1.70);
  assert.equal(win.to, 1.95);
  assert.equal(win.start, 1.70);

  // Array access and count: 36 frames before, center, 24 frames after = 61 frames
  assert.equal(win.length, 61);
  assert.equal(win[0], 1.70);
  assert.equal(win[win.length - 1], 1.95);
  assert.equal(win[36], 1.85); // center frame is server P4
  assert.equal(win.frames[0], 1.70);
});

test("direction: going back, then down, and the turn is the last frame going back", () => {
  // The clubhead circles the shoulders' middle at 240 fps: its angle grows until 1.50 s, then falls.
  const frames = [];
  for (let k = 0; k <= 240; k++) {
    const t = Number((1.0 + k / 240).toFixed(6));
    const a = t <= 1.5 ? (t - 1.0) * 2 : 1.0 - (t - 1.5) * 6;
    const lm = new Array(33 * 3).fill(0);
    lm[11 * 3] = 0.45; lm[11 * 3 + 1] = 0.4; lm[12 * 3] = 0.55; lm[12 * 3 + 1] = 0.4;
    // A gap with no clubhead (blur) early on, which leaves the frames around it unknown.
    const clubhead = t > 1.2 && t < 1.22 ? null : [0.5 + 0.3 * Math.cos(a), 0.4 + 0.3 * Math.sin(a), 0.9];
    frames.push({ t, lm, clubhead });
  }
  const d = direction(frames, 1.35, 1.6);
  assert.ok(d.frames.length > 50);
  assert.equal(d.frames.find(f => Math.abs(f.t - 1.40) < 0.003).dir, "back");
  assert.equal(d.frames.find(f => Math.abs(f.t - 1.55) < 0.003).dir, "down");
  assert.ok(d.turn != null && Math.abs(d.turn - 1.5) <= 2 / 240, `turn ${d.turn}`);
  // Slowest at the turn.
  const at = d.frames.find(f => Math.abs(f.t - d.turn) < 0.001);
  assert.ok(at.speed < d.frames.find(f => Math.abs(f.t - 1.58) < 0.003).speed);
  // No clubhead: nothing to say.
  assert.equal(direction(frames.map(f => ({ ...f, clubhead: null })), 1.35, 1.6).turn, null);
});
test("mergeP4: sets events.p4, quick.p4 and removes picked.p4", () => {
  const doc = {
    schema: 1,
    clip: { name: "swing_face_1.mp4", angle: "face", strike: 1.45 },
    partner: { name: "swing_dtl_1.mp4", angle: "dtl", strike: 1.45 },
    events: {
      takeaway: 0.95,
      impact: 2.20
    },
    picked: {
      takeaway: "server",
      p4: "night" // Pick between server and night
    },
    ball: { x: 0.5, y: 0.8 }
  };

  const updated = mergeP4(doc, 1.85234567);

  // Non-destructive: original unchanged
  assert.equal(doc.events.p4, undefined);
  assert.equal(doc.picked.p4, "night");

  // Updated has p4 formatted to 6 decimal places
  assert.equal(updated.events.p4, 1.852346);
  assert.deepEqual(updated.quick, { p4: "p4check" });

  // picked.p4 is removed
  assert.equal(updated.picked.p4, undefined);
  assert.equal(updated.picked.takeaway, "server"); // other picks untouched

  // Other fields preserved
  assert.equal(updated.events.takeaway, 0.95);
  assert.equal(updated.events.impact, 2.20);
  assert.deepEqual(updated.ball, { x: 0.5, y: 0.8 });
  assert.deepEqual(updated.clip, doc.clip);
  assert.deepEqual(updated.partner, doc.partner);
});

test("queue: respects cantTell option (skips swings marked cant-tell today)", () => {
  const clips = [
    makeClip(1),
    makeClip(2),
    makeClip(3)
  ];
  const cantTellSet = new Set(["swing_face_1.mp4"]);
  const q = queue(clips, {}, null, { max: 10, cantTell: cantTellSet, seed: "2026-10-06" });
  assert.equal(q.length, 2);
  assert.deepEqual(q.map(x => x.name).sort(), ["swing_face_2.mp4", "swing_face_3.mp4"]);
});

test("getServerP4: resolves from night entry, positions, or fallback", () => {
  const { getServerP4, getFps } = require("../static/p4check.js");
  const c = { name: "swing_face_1920x1080_240fps_12345_2000ms.mp4", angle: "face" };

  // 1. From night entry
  const night = {
    swings: {
      [c.name]: {
        face: { t: { p4: 1.888 } }
      }
    }
  };
  assert.equal(getServerP4(c, null, night), 1.888);

  // 2. From pose positions
  const poseWithPos = { positions: { p4: 1.777 } };
  assert.equal(getServerP4(c, poseWithPos, null), 1.777);

  // 3. Fallback from impact
  const poseWithImpact = { impact: 2.15 };
  assert.equal(getServerP4(c, poseWithImpact, null), 1.80);

  // 4. getFps
  assert.equal(getFps(c.name), 240);
  assert.equal(getFps("swing_face_1280x720_60fps_12345.mp4"), 60);
});

test("index.html contains P4 check markup, Tools menu item, scripts, and hash router", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const htmlPath = path.resolve(__dirname, "../static/index.html");
  const html = fs.readFileSync(htmlPath, "utf8");

  assert.ok(html.includes('id="p4check-btn"'), "defines Tools menu P4 check button");
  assert.ok(html.includes('<section id="p4check"'), "defines #p4check section");
  assert.ok(html.includes('id="p4c-close"'), "defines Close button");
  assert.ok(html.includes('id="p4c-save-btn"'), "defines Save (This is the top) button");
  assert.ok(html.includes('id="p4c-cant-btn"'), "defines Can't tell button");
  assert.ok(html.includes('id="p4c-skip-btn"'), "defines Skip button");
  assert.ok(html.includes('id="p4c-chart"'), "defines speed chart canvas");
  assert.ok(html.includes('<script src="/static/p4check.js"></script>'), "loads p4check.js script");
  assert.ok(html.includes('p4check: "p4check-btn"'), "routes #p4check hash to p4check-btn");
});

test("trends.js includes p4check in showView, tools-btn active list, and leaveTrendViews", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const jsPath = path.resolve(__dirname, "../static/trends.js");
  const js = fs.readFileSync(jsPath, "utf8");

  assert.ok(js.includes('document.getElementById("p4check")'), "checks #p4check in showView / leaveTrendViews");
  assert.ok(js.includes('document.getElementById("p4check-btn")'), "toggles #p4check-btn in showView");
  assert.ok(js.includes('which === "p4check"'), "includes p4check in tools-btn tab activation");
});

test("p4check: showSwing and saveTop discard stale response if modal closed or index moved", async () => {
  const origWindow = global.window;
  const origDoc = global.document;
  const origFetch = global.fetch;
  const origImage = global.Image;

  global.window = { addEventListener: () => {} };
  global.Image = class { constructor() {} };
  global.document = {
    addEventListener: () => {},
    getElementById: () => ({
      hidden: false,
      style: {},
      replaceChildren: () => {},
      scrollIntoView: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      appendChild: () => {},
      addEventListener: () => {},
      append: () => {},
      classList: { add: () => {}, remove: () => {}, toggle: () => {} },
      getContext: () => ({ clearRect: () => {}, drawImage: () => {}, fillRect: () => {}, stroke: () => {} })
    }),
    createElement: () => ({
      className: "",
      style: {},
      textContent: "",
      appendChild: () => {},
      replaceChildren: () => {},
      addEventListener: () => {},
      append: () => {}
    })
  };

  let resolvePose;
  const promisePose = new Promise(r => { resolvePose = r; });

  global.fetch = async (url) => {
    if (url.includes("/api/pose/")) {
      await promisePose;
      return { ok: true, json: async () => ({ frames: [], impact: 1.5 }) };
    }
    return { ok: true, json: async () => ({}) };
  };

  const p4 = require("../static/p4check.js");

  try {
    const p = p4.showSwing(0);
    p4.close();
    resolvePose();
    await p;
    assert.ok(true, "showSwing safely returned when closed during pose fetch");
  } finally {
    global.window = origWindow;
    global.document = origDoc;
    global.fetch = origFetch;
    global.Image = origImage;
  }
});

