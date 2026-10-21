const test = require("node:test");
const assert = require("node:assert/strict");
const SwingClipExport = require("../static/clipexport.js");

test("SwingClipExport.framePlan: calculates correct clip window and frame count", () => {
  // Takeaway at 0.8s, impact at 1.6s, duration 3.0s
  // Window: 0.8 - 0.5 = 0.3s to 1.6 + 0.6 = 2.2s -> clipDuration = 1.9s
  const plan1x = SwingClipExport.framePlan({
    takeaway: 0.8,
    impact: 1.6,
    duration: 3.0,
    speed: 1,
    fps: 30
  });

  assert.equal(plan1x.startTime, 0.3);
  assert.equal(plan1x.endTime, 2.2);
  assert.equal(plan1x.clipDuration, 1.9);
  assert.equal(plan1x.outputDuration, 1.9);
  assert.equal(plan1x.speed, 1);
  assert.equal(plan1x.speedLabel, "1x");
  assert.equal(plan1x.fps, 30);
  assert.equal(plan1x.frameCount, Math.round(1.9 * 30));
  assert.equal(plan1x.times[0], 0.3);
  assert.ok(plan1x.times[plan1x.times.length - 1] <= 2.2);

  // 1/4 speed (slow motion)
  const planQuarter = SwingClipExport.framePlan({
    takeaway: 0.8,
    impact: 1.6,
    duration: 3.0,
    speed: 0.25,
    fps: 30
  });
  assert.equal(planQuarter.speed, 0.25);
  assert.equal(planQuarter.speedLabel, "1/4x");
  assert.equal(planQuarter.outputDuration, 1.9 / 0.25); // 7.6s
  assert.equal(planQuarter.frameCount, Math.round(7.6 * 30)); // 228 frames

  // 1/8 speed (slow motion for 240 fps clips)
  const planEighth = SwingClipExport.framePlan({
    takeaway: 0.8,
    impact: 1.6,
    duration: 3.0,
    speed: "1/8",
    fps: 30
  });
  assert.equal(planEighth.speed, 0.125);
  assert.equal(planEighth.speedLabel, "1/8x");
  assert.equal(planEighth.outputDuration, 1.9 / 0.125); // 15.2s
  assert.equal(planEighth.frameCount, Math.round(15.2 * 30)); // 456 frames

  // Clamp at duration boundaries
  const planClamped = SwingClipExport.framePlan({
    takeaway: 0.2, // 0.2 - 0.5 = -0.3 -> clamps to 0
    impact: 1.8,   // 1.8 + 0.6 = 2.4 -> clamps to duration 2.0
    duration: 2.0,
    speed: 1,
    fps: 30
  });
  assert.equal(planClamped.startTime, 0);
  assert.equal(planClamped.endTime, 2.0);
  assert.equal(planClamped.clipDuration, 2.0);
});

test("SwingClipExport.framePlan: accepts positions array", () => {
  const positions = [
    { key: "p1", t: 0.7 },
    { key: "p7", t: 1.5 }
  ];
  positions.takeaway = { t: 0.75 };

  const plan = SwingClipExport.framePlan(positions, 2.5, { speed: 0.25 });
  assert.equal(plan.startTime, 0.25); // 0.75 - 0.5
  assert.equal(plan.endTime, 2.1);   // 1.5 + 0.6
  assert.equal(plan.speed, 0.25);
});

test("SwingClipExport.panelLines: formats date, club, verdict, and 7 Square numbers", () => {
  const shot = {
    club: "I7",
    ball: {
      carry: 157.3,
      speed: 113.2,
      vla: 18.4,
      totalSpin: 5820
    },
    clubData: {
      speed: 82.1,
      path: 2.3,
      faceToTarget: 1.1 // faceToPath = 1.1 - 2.3 = -1.2
    }
  };

  const card = {
    verdict: { level: "good", text: "Good shot" }
  };

  const lines = SwingClipExport.panelLines({
    date: "Tue, Oct 20, 8:51 PM",
    club: "7-iron",
    shot,
    card
  });

  assert.equal(lines.date, "Tue, Oct 20, 8:51 PM");
  assert.equal(lines.club, "7-iron");
  assert.equal(lines.verdict, "Good shot");
  assert.equal(lines.verdictLevel, "good");

  const numbersMap = Object.fromEntries(lines.numbers.map(n => [n.key, n.value]));
  assert.equal(numbersMap.carry, "157 yd");
  assert.equal(numbersMap.ballSpeed, "113.2 mph");
  assert.equal(numbersMap.clubSpeed, "82.1 mph");
  assert.equal(numbersMap.launch, "18.4°");
  assert.equal(numbersMap.spin, "5820 rpm");
  assert.equal(numbersMap.path, "+2.3°");
  assert.equal(numbersMap.faceToPath, "-1.2°");

  // Check lines content
  assert.ok(lines.some(l => l.includes("7-iron")));
  assert.ok(lines.some(l => l.includes("Good shot")));
  assert.ok(lines.some(l => l.includes("157 yd")));
  assert.ok(lines.some(l => l.includes("113.2 mph")));
});

test("SwingClipExport.panelLines: handles missing shot data gracefully", () => {
  const lines = SwingClipExport.panelLines({
    date: "Oct 20, 2026",
    club: "Driver",
    shot: null,
    verdict: "Miss"
  });

  assert.equal(lines.verdict, "Miss");
  for (const n of lines.numbers) {
    assert.equal(n.value, "—");
  }
});

test("SwingClipExport.layout: single video layout", () => {
  const lay = SwingClipExport.layout({
    faceWidth: 1080,
    faceHeight: 1920,
    hasPartner: false,
    panelPlacement: "bottom"
  });

  assert.equal(lay.hasPartner, false);
  assert.equal(lay.video2, null);
  assert.equal(lay.video1.x, 0);
  assert.equal(lay.video1.y, 0);
  assert.equal(lay.video1.w, 1080);
  assert.equal(lay.video1.h, 1920);

  // Panel underneath
  assert.equal(lay.panel.x, 0);
  assert.equal(lay.panel.y, 1920);
  assert.equal(lay.panel.w, 1080);
  assert.ok(lay.panel.h >= 120);

  // Total canvas dimensions even
  assert.equal(lay.width % 2, 0);
  assert.equal(lay.height % 2, 0);
  assert.equal(lay.width, 1080);
  assert.equal(lay.height, 1920 + lay.panel.h);
});

test("SwingClipExport.layout: side-by-side two videos (same height)", () => {
  const lay = SwingClipExport.layout({
    faceWidth: 1080,
    faceHeight: 1920,
    dtlWidth: 1080,
    dtlHeight: 1920,
    hasPartner: true,
    panelPlacement: "bottom"
  });

  assert.equal(lay.hasPartner, true);
  assert.ok(lay.video2 !== null);

  // Both videos have same height
  assert.equal(lay.video1.h, 1920);
  assert.equal(lay.video2.h, 1920);

  // Side-by-side: video2 starts where video1 ends
  assert.equal(lay.video1.x, 0);
  assert.equal(lay.video1.w, 1080);
  assert.equal(lay.video2.x, 1080);
  assert.equal(lay.video2.w, 1080);

  // Width is sum of both video widths
  assert.equal(lay.width, 2160);
  assert.equal(lay.panel.w, 2160);
  assert.equal(lay.panel.y, 1920);

  assert.equal(lay.width % 2, 0);
  assert.equal(lay.height % 2, 0);
});

test("SwingClipExport.layout: beside panel layout", () => {
  const lay = SwingClipExport.layout({
    faceWidth: 1280,
    faceHeight: 720,
    hasPartner: false,
    panelPlacement: "beside"
  });

  assert.equal(lay.panelPlacement, "beside");
  assert.equal(lay.video1.x, 0);
  assert.equal(lay.video1.w, 1280);
  assert.equal(lay.video1.h, 720);

  assert.equal(lay.panel.x, 1280);
  assert.equal(lay.panel.y, 0);
  assert.equal(lay.panel.h, 720);
  assert.equal(lay.height, 720);
  assert.equal(lay.width, 1280 + lay.panel.w);
});

test("SwingClipExport.formatFilename: formats swing-<date>-<club>.webm", () => {
  const fn1 = SwingClipExport.formatFilename("2026-10-20", "7i");
  assert.equal(fn1, "swing-2026-10-20-7i.webm");

  const fn2 = SwingClipExport.formatFilename(
    { recorded: "2026-10-20T20:51:55Z", club: "Driver" }
  );
  assert.equal(fn2, "swing-2026-10-20-driver.webm");

  const fn3 = SwingClipExport.formatFilename(
    { recorded: "2026-10-20T14:30:00" },
    { club: "3-wood" }
  );
  assert.equal(fn3, "swing-2026-10-20-3wood.webm");
});
