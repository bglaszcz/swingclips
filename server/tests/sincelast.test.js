const test = require("node:test");
const assert = require("node:assert/strict");
const { summary, sessionsOf, formatDate } = require("../static/sincelast.js");

function makeSwing(id, recorded, opts = {}) {
  const angle = opts.angle || "face";
  const isLone = opts.lone ?? false;
  const partnerName = isLone ? null : (angle === "face" ? `swing_dtl_${id}.mp4` : `swing_face_${id}.mp4`);
  return {
    name: `swing_${angle}_${id}.mp4`,
    recorded,
    angle,
    partner: partnerName,
    shot: opts.shot !== undefined ? opts.shot : { club: "I7" },
    excluded: !!opts.excluded
  };
}

test("clean session: all swings both angles, high square pair rate, cameras in place", () => {
  const clips = [];
  // 20 swings, all recorded on Oct 4, 2026 between 14:00 and 14:30
  for (let i = 0; i < 20; i++) {
    const min = String(i).padStart(2, "0");
    const face = makeSwing(i, `2026-10-04T14:${min}:00`, { angle: "face" });
    const dtl = makeSwing(i, `2026-10-04T14:${min}:00`, { angle: "dtl" });
    clips.push(face, dtl);
  }

  // Ref time 2 hours later
  const now = "2026-10-04T16:30:00";
  const calib = { moved: null };
  const res = summary({ clips, calib }, now);

  assert.equal(res.headline, "Last session (Sun Oct 4, 20 swings): all good.");
  assert.equal(res.lines.length, 3);
  assert.deepEqual(res.lines[0], {
    kind: "ok",
    text: "All 20 swings had both angles"
  });
  assert.deepEqual(res.lines[1], {
    kind: "ok",
    text: "Square paired 20 of 20 swings with a shot"
  });
  assert.deepEqual(res.lines[2], {
    kind: "ok",
    text: "Cameras in place"
  });
});

test("Oct 4-like session: 68 swings, 6 face-on misses, 1 no-swing, 67/68 paired", () => {
  const clips = [];
  // 68 swings total:
  // - 62 swings with both angles
  // - 6 swings with DTL only (face-on missed!)
  // - 67 paired with shot, 1 without shot
  for (let i = 0; i < 68; i++) {
    const min = String(Math.floor(i / 2)).padStart(2, "0");
    const sec = String((i % 2) * 30).padStart(2, "0");
    const time = `2026-10-04T17:${min}:${sec}`;
    const hasShot = i !== 40 ? { club: "I5" } : null; // swing 40 has no shot

    if (i < 6) {
      // Lone DTL (face-on phone missed)
      clips.push(makeSwing(i, time, { angle: "dtl", lone: true, shot: hasShot }));
    } else {
      // Both angles
      clips.push(makeSwing(i, time, { angle: "face", shot: hasShot }));
      clips.push(makeSwing(i, time, { angle: "dtl", shot: hasShot }));
    }
  }

  const events = [
    {
      t: "2026-10-04T17:20:00",
      kind: "noswing",
      clip: "swing_dtl_40.mp4"
    }
  ];

  const calib = { moved: null };
  const now = "2026-10-04T20:00:00";
  const res = summary({ clips, events, calib }, now);

  // 1 warning (face-on misses 6 of 68 swings)
  assert.equal(res.headline, "Last session (Sun Oct 4, 68 swings): 1 thing to check.");
  assert.equal(res.lines.length, 4);

  // Warn: Face-on misses
  assert.deepEqual(res.lines[0], {
    kind: "warn",
    text: "Face-on missed 6 of 68 swings",
    todo: "Check the face-on phone: app open, on the charger, mic not covered"
  });

  // Ok: Square paired 67 of 68
  assert.deepEqual(res.lines[1], {
    kind: "ok",
    text: "Square paired 67 of 68 swings with a shot"
  });

  // Info: 1 clip with no swing (false triggers)
  assert.deepEqual(res.lines[2], {
    kind: "info",
    text: "1 clip with no swing (false triggers)"
  });

  // Ok: Cameras in place
  assert.deepEqual(res.lines[3], {
    kind: "ok",
    text: "Cameras in place"
  });
});

test("camera moved: produces warn with link to /calibrate", () => {
  const clips = [
    makeSwing(1, "2026-10-04T10:00:00", { angle: "face" }),
    makeSwing(1, "2026-10-04T10:00:00", { angle: "dtl" })
  ];
  const calib = {
    moved: {
      since: 1791151211,
      text: "at address the joints miss by 48 px"
    }
  };
  const now = "2026-10-04T12:00:00";
  const res = summary({ clips, calib }, now);

  assert.equal(res.headline, "Last session (Sun Oct 4, 1 swing): 1 thing to check.");
  const camLine = res.lines.find(l => l.text === "Camera moved since calibration");
  assert.ok(camLine);
  assert.equal(camLine.kind, "warn");
  assert.equal(camLine.todo, "Re-place the cameras on the Calibrate page");
  assert.equal(camLine.link, "/calibrate");
});

test("waiting better candidate and night improve report", () => {
  const clips = [
    makeSwing(1, "2026-10-04T10:00:00", { angle: "face" }),
    makeSwing(1, "2026-10-04T10:00:00", { angle: "dtl" })
  ];
  const improve = {
    inUse: { club: "model-old" },
    candidates: [
      { id: "club-cand-1", status: "better" }
    ],
    nights: [
      {
        started: "2026-10-05T02:00:00",
        clips: 64,
        improve: "Trained a club model on 34 labeled swings: better."
      }
    ]
  };
  const next = {
    due: false,
    why: "Nothing to train: 12 new club-labeled frames since the last try (needs 40; Tools > Club check adds them)."
  };

  const now = "2026-10-05T08:00:00";
  const res = summary({ clips, improve, next }, now);

  const nightLine = res.lines.find(l => l.text.startsWith("Night:"));
  assert.ok(nightLine);
  assert.equal(nightLine.kind, "info");
  assert.equal(nightLine.text, "Night: 64 clips analyzed again; Trained a club model on 34 labeled swings: better.");

  const candLine = res.lines.find(l => l.text.includes("better club model is waiting"));
  assert.ok(candLine);
  assert.equal(candLine.kind, "info");
  assert.equal(candLine.text, "A better club model is waiting: Tools > Night report");
  assert.equal(candLine.link, "/#nightreport");

  const clubCheckLine = res.lines.find(l => l.text.startsWith("Club model:"));
  assert.ok(clubCheckLine);
  assert.equal(clubCheckLine.kind, "info");
  assert.equal(clubCheckLine.text, "Club model: 12 of 40 new club frames for the next try (Tools > Club check)");
  assert.equal(clubCheckLine.link, "/#clubcheck");
});

test("no session yet: empty clips or session ended less than 30 min ago", () => {
  const resEmpty = summary({}, Date.now());
  assert.equal(resEmpty.headline, "No past sessions yet.");
  assert.deepEqual(resEmpty.lines, []);

  // Session still ongoing (ended 10 minutes ago)
  const clips = [
    makeSwing(1, "2026-10-04T10:00:00", { angle: "face" })
  ];
  const nowRecent = "2026-10-04T10:10:00"; // 10 min gap < 30 min
  const resRecent = summary({ clips }, nowRecent);
  assert.equal(resRecent.headline, "No past sessions yet.");
  assert.deepEqual(resRecent.lines, []);
});

test("events in both shapes: array and { events: [...] }", () => {
  const clips = [
    makeSwing(1, "2026-10-04T10:00:00", { angle: "face" }),
    makeSwing(1, "2026-10-04T10:00:00", { angle: "dtl" })
  ];
  const now = "2026-10-04T12:00:00";

  // Shape 1: raw array
  const rawEvents = [
    { kind: "noswing", t: "2026-10-04T10:05:00", clip: "fake1.mp4" },
    { kind: "noswing", t: "2026-10-04T10:06:00", clip: "fake2.mp4" },
    { kind: "noswing", t: "2026-10-04T10:07:00", clip: "fake3.mp4" }
  ];
  const res1 = summary({ clips, events: rawEvents }, now);
  const line1 = res1.lines.find(l => l.text.includes("false triggers"));
  assert.ok(line1);
  assert.equal(line1.kind, "info");
  assert.equal(line1.text, "3 clips with no swing (false triggers)");

  // Shape 2: { events: [...] }
  const objEvents = {
    events: [
      { kind: "noswing", t: "2026-10-04T10:05:00", clip: "fake1.mp4" },
      { kind: "noswing", t: "2026-10-04T10:06:00", clip: "fake2.mp4" },
      { kind: "noswing", t: "2026-10-04T10:07:00", clip: "fake3.mp4" },
      { kind: "noswing", t: "2026-10-04T10:08:00", clip: "fake4.mp4" },
      { kind: "noswing", t: "2026-10-04T10:09:00", clip: "fake5.mp4" }
    ]
  };
  const res2 = summary({ clips, events: objEvents }, now);
  const line2 = res2.lines.find(l => l.text.includes("false triggers"));
  assert.ok(line2);
  assert.equal(line2.kind, "warn");
  assert.equal(line2.text, "5 clips with no swing (false triggers)");
});

test("down-the-line missed (> 3%) and Square pairing warning (< 90%)", () => {
  const clips = [];
  // 10 swings:
  // - 8 with both angles
  // - 2 with face-on only (lone face -> DTL missed!) -> 20% > 3%
  // - 8 paired with shot, 2 without shot -> 80% < 90%
  for (let i = 0; i < 10; i++) {
    const min = String(i).padStart(2, "0");
    const time = `2026-10-04T14:${min}:00`;
    const hasShot = i < 8 ? { club: "I7" } : null;

    if (i < 2) {
      clips.push(makeSwing(i, time, { angle: "face", lone: true, shot: hasShot }));
    } else {
      clips.push(makeSwing(i, time, { angle: "face", shot: hasShot }));
      clips.push(makeSwing(i, time, { angle: "dtl", shot: hasShot }));
    }
  }

  const now = "2026-10-04T16:00:00";
  const res = summary({ clips }, now);

  assert.equal(res.headline, "Last session (Sun Oct 4, 10 swings): 2 things to check.");
  const dtlLine = res.lines.find(l => l.text.startsWith("Down-the-line missed"));
  assert.ok(dtlLine);
  assert.equal(dtlLine.kind, "warn");
  assert.equal(dtlLine.todo, "Check the down-the-line phone: app open, on the charger, mic not covered");

  const sqLine = res.lines.find(l => l.text.startsWith("Square paired"));
  assert.ok(sqLine);
  assert.equal(sqLine.kind, "warn");
  assert.equal(sqLine.todo, "Check the Square app is open on the sim laptop and the watcher is running");
});

test("start.html contains Since last markup, script tag, and styles", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const html = fs.readFileSync(path.join(__dirname, "../static/start.html"), "utf-8");

  assert.ok(html.includes('<script src="/static/sincelast.js"></script>'), "loads sincelast.js");
  assert.ok(html.includes('id="since-last"'), "has #since-last element");
  assert.ok(html.includes('.since-last'), "has .since-last css styles");
});

