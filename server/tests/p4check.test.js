const test = require("node:test");
const assert = require("node:assert/strict");
const { queue, window: p4Window, traces, mergeP4 } = require("../static/p4check.js");

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
  const q = queue(clips, labels, null, { max: 10 });
  assert.equal(q.length, 2);
  assert.equal(q[0].name, "swing_face_1.mp4");
  assert.equal(q[1].name, "swing_face_2.mp4");
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
  const q = queue(clips, {}, null, { max: 10 });
  assert.equal(q.length, 2);
  assert.equal(q[0].name, "swing_face_1.mp4");
  assert.equal(q[1].name, "swing_dtl_2.mp4");
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

test("traces: speed peaks where motion is fastest and leaves gaps empty", () => {
  // Create synthetic pose frames over 1.0s to 2.0s
  // Wrist stationary at 1.5s (top), moving fast at 1.8s (downswing)
  // Clubhead present except missing around 1.3s - 1.4s (gap)
  const frames = [];
  const dt = 1 / 60; // 60 fps for test simplicity

  for (let t = 1.0; t <= 2.0; t += dt) {
    // Wrist motion: pos(t) = (t - 1.5)^2 -> speed = 2 * |t - 1.5|
    // Slowest near 1.5s, fastest near 1.0s and 2.0s
    const diff = t - 1.5;
    const wx = 0.5 + diff * Math.abs(diff);
    const wy = 0.5;

    // Landmark array with left wrist at index 15
    const lm = new Array(33 * 3).fill(0);
    lm[15 * 3] = wx;
    lm[15 * 3 + 1] = wy;
    lm[15 * 3 + 2] = 0.9; // visibility

    // Clubhead with gap between 1.30 and 1.45
    let clubhead = null;
    if (t < 1.30 || t > 1.45) {
      // Faster motion at 1.7s: speed proportional to (t - 1.5)^3
      clubhead = [0.5 + diff * 2, 0.5, 0.8];
    }

    frames.push({
      t: Number(t.toFixed(4)),
      lm,
      clubhead
    });
  }

  const tr = traces(frames, 1.35, 1.90, "left");
  assert.ok(tr.length > 0);

  // Wrist speed drops near 1.5s and peaks near 1.9s
  const pNearTop = tr.find(p => Math.abs(p.t - 1.5) < 0.02);
  const pFast = tr.find(p => Math.abs(p.t - 1.85) < 0.02);

  assert.ok(pNearTop && pNearTop.wrist != null);
  assert.ok(pFast && pFast.wrist != null);
  assert.ok(pFast.wrist > pNearTop.wrist * 3, `Speed at 1.85s (${pFast.wrist}) should beat top (${pNearTop.wrist})`);

  // Clubhead gap: at 1.40s clubhead was missing, so clubhead speed must be null
  const pGap = tr.find(p => Math.abs(p.t - 1.40) < 0.02);
  assert.ok(pGap);
  assert.equal(pGap.clubhead, null);

  // Where clubhead is present, speed is computed
  const pClubheadFast = tr.find(p => Math.abs(p.t - 1.80) < 0.02);
  assert.ok(pClubheadFast);
  assert.ok(pClubheadFast.clubhead != null && pClubheadFast.clubhead > 0);
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
  const q = queue(clips, {}, null, { max: 10, cantTell: cantTellSet });
  assert.equal(q.length, 2);
  assert.equal(q[0].name, "swing_face_2.mp4");
  assert.equal(q[1].name, "swing_face_3.mp4");
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
