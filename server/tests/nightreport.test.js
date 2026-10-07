// Night report helper tests (server/static/nightreport.js)
//
//   node --test tests/nightreport.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const NightReport = require("../static/nightreport.js");

const sample = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "improve-sample.json"), "utf8")
);

test("rows paired correctly: sample candidate scores in swing order", () => {
  const cand = sample.candidates[0];
  const rows = NightReport.compareRows(cand.scores);

  // 6 positions (takeaway, p2, p4, p8 on face; p2, p8 on dtl)
  // + 2 club (face, dtl downswing)
  // + 1 clubhead (face downswing)
  assert.equal(rows.length, 9);

  // Check swing order: face takeaway, face p2, face p4, face p8, dtl p2, dtl p8
  const posRows = rows.filter(r => r.kind === "positions");
  assert.equal(posRows.length, 6);

  assert.equal(posRows[0].angle, "face");
  assert.equal(posRows[0].event, "takeaway");
  assert.equal(posRows[0].within1.before, 33.3);
  assert.equal(posRows[0].within1.after, 33.3);
  assert.equal(posRows[0].within1.change, 0);
  assert.equal(posRows[0].p90.before, 38.0);
  assert.equal(posRows[0].p90.after, 36.0);
  assert.equal(posRows[0].p90.change, -2.0);
  assert.equal(posRows[0].better, null); // within noise

  assert.equal(posRows[1].angle, "face");
  assert.equal(posRows[1].event, "p2");
  assert.equal(posRows[1].within1.before, 55.6);
  assert.equal(posRows[1].within1.after, 66.7);
  assert.equal(posRows[1].within1.change, 11.1);
  assert.equal(posRows[1].p90.before, 20.8);
  assert.equal(posRows[1].p90.after, 16.6);
  assert.equal(posRows[1].p90.change, -4.2);
  assert.equal(posRows[1].better, true); // +11.1% > 5%, p90 improved

  assert.equal(posRows[2].angle, "face");
  assert.equal(posRows[2].event, "p4");

  assert.equal(posRows[3].angle, "face");
  assert.equal(posRows[3].event, "p8");
  assert.equal(posRows[3].better, true); // +11.1% within1

  assert.equal(posRows[4].angle, "dtl");
  assert.equal(posRows[4].event, "p2");
  assert.equal(posRows[4].better, true); // +12.5% within1

  assert.equal(posRows[5].angle, "dtl");
  assert.equal(posRows[5].event, "p8");
  assert.equal(posRows[5].better, null);

  // Club shaft
  const clubRows = rows.filter(r => r.kind === "club");
  assert.equal(clubRows.length, 2);
  assert.equal(clubRows[0].angle, "face");
  assert.equal(clubRows[0].found.before, 90.3);
  assert.equal(clubRows[0].found.after, 93.5);
  assert.equal(clubRows[0].found.change, 3.2);
  assert.equal(clubRows[0].p90.change, -0.2);
  assert.equal(clubRows[0].better, null); // within noise: 3.2 <= 5 and 0.2 <= 4.2

  assert.equal(clubRows[1].angle, "dtl");
  assert.equal(clubRows[1].better, null);

  // Clubhead
  const headRows = rows.filter(r => r.kind === "clubhead");
  assert.equal(headRows.length, 1);
  assert.equal(headRows[0].angle, "face");
  assert.equal(headRows[0].found.change, 6.2);
  assert.equal(headRows[0].p90.change, -0.2);
  assert.equal(headRows[0].better, true); // +6.2% found > 5%
});

test("the noise band: within noise (null), improved (true), worsened (false)", () => {
  // Test position noise evaluation
  function evalPos(curW, candW, curP, candP) {
    const scores = {
      current: { positions: [{ angle: "face", event: "p2", within1: curW, p90: curP }] },
      candidate: { positions: [{ angle: "face", event: "p2", within1: candW, p90: candP }] }
    };
    return NightReport.compareRows(scores)[0].better;
  }

  // Exactly on the boundary or within: within 5 points AND p90 within 4.2 ms
  assert.equal(evalPos(50, 55, 20, 24.2), null); // +5.0 within1, +4.2 p90 -> null
  assert.equal(evalPos(50, 45, 20, 15.8), null); // -5.0 within1, -4.2 p90 -> null
  assert.equal(evalPos(50, 50, 20, 20), null);   // 0 change -> null

  // Improvement: > 5 points within1 or < -4.2 ms p90, neither worsening
  assert.equal(evalPos(50, 55.1, 20, 20), true); // +5.1% within1 -> true
  assert.equal(evalPos(50, 50, 20, 15.7), true); // -4.3 ms p90 -> true
  assert.equal(evalPos(50, 60, 20, 15), true);   // both improved -> true

  // Worsening: < -5 points within1 or > +4.2 ms p90
  assert.equal(evalPos(50, 44.9, 20, 20), false); // -5.1% within1 -> false
  assert.equal(evalPos(50, 50, 20, 24.3), false); // +4.3 ms p90 -> false

  // Mixed: improved on one metric but worsened past noise on the other -> false (never say better)
  assert.equal(evalPos(50, 65, 20, 25), false);   // +15% within1, but +5 ms p90 -> false
  assert.equal(evalPos(50, 40, 20, 10), false);   // -10 ms p90, but -10% within1 -> false
});

test("a missing row on one side: skipped if only in current or candidate", () => {
  const scores = {
    current: {
      positions: [
        { angle: "face", event: "takeaway", within1: 30, p90: 20 },
        { angle: "face", event: "p2", within1: 50, p90: 15 },
        { angle: "dtl", event: "p4", within1: 40, p90: 25 } // only in current
      ]
    },
    candidate: {
      positions: [
        { angle: "face", event: "takeaway", within1: 35, p90: 18 },
        { angle: "face", event: "p3", within1: 45, p90: 22 }, // only in candidate
        { angle: "face", event: "p2", within1: 52, p90: 14 }
      ]
    }
  };

  const rows = NightReport.compareRows(scores);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].event, "takeaway");
  assert.equal(rows[1].event, "p2");
});

test("headline variants: better candidate", () => {
  const h = NightReport.headline(sample);
  assert.equal(
    h,
    "Last night (Oct 7, 2:00-6:58): 64 clips, and a new club model that did better on swings it never saw: ready to use."
  );
});

test("headline variants: not better candidate", () => {
  const rep = {
    inUse: { club: "club-deep@0173e707" },
    deepLeft: 0,
    candidates: [sample.candidates[1]], // "not better" candidate
    nights: [sample.nights[1]]          // Oct 6 night
  };
  const h = NightReport.headline(rep);
  assert.match(h, /Last night \(Oct 6, 2:00-7:00\): 71 clips/);
  assert.match(h, /not better/);
  assert.match(h, /kept the one in use/);
});

test("headline variants: deepLeft > 0", () => {
  const rep = {
    inUse: { club: "club-deep@9f3c21aa" },
    deepLeft: 312,
    candidates: sample.candidates,
    nights: sample.nights
  };
  const h = NightReport.headline(rep);
  assert.equal(h, "Using the new club model: 312 clips still to be analyzed again.");
});

test("headline variants: no nights", () => {
  assert.equal(
    NightReport.headline({ inUse: {}, deepLeft: 0, candidates: [], nights: [] }),
    "No night report yet: the night worker hasn't run the improve step."
  );
  assert.equal(
    NightReport.headline(null),
    "No night report yet: the night worker hasn't run the improve step."
  );
});

test("headline variants: nothing new to learn", () => {
  const rep = {
    inUse: { club: "club-deep@0173e707" },
    deepLeft: 0,
    candidates: [],
    nights: [sample.nights[2]] // Oct 5: "Nothing new to learn..."
  };
  const h = NightReport.headline(rep);
  assert.equal(h, "Last night (Oct 5, 11:05-16:40): 824 clips, nothing new to learn (no new labels).");
});

test("nightLine: formats date, time, clips and improve sentence", () => {
  const line = NightReport.nightLine(sample.nights[0]);
  assert.match(line, /Oct 7/);
  assert.match(line, /2:00-6:58/);
  assert.match(line, /64 clips/);
  assert.match(line, /Trained a club model on 52 labeled swings: better/);
  assert.ok(line.includes(" · "));
});

test("index.html contains Night report markup, Tools menu item, and scripts", () => {
  const htmlPath = path.resolve(__dirname, "../static/index.html");
  const html = fs.readFileSync(htmlPath, "utf8");

  assert.ok(html.includes('id="nightreport-btn"'), "defines Tools menu Night report button");
  assert.ok(html.includes('<section id="nightreport" hidden>'), "defines #nightreport section");
  assert.ok(html.includes('id="nr-close"'), "defines Close button");
  assert.ok(html.includes('id="nr-status"'), "defines status span");
  assert.ok(html.includes('id="nr-content"'), "defines content container");
  assert.ok(html.includes('<script src="/static/nightreport.js"></script>'), "loads nightreport.js");
  assert.ok(html.includes('<script src="/static/nightreport-view.js"></script>'), "loads nightreport-view.js");
  assert.ok(html.includes("#nightreport {"), "defines #nightreport CSS");
  assert.ok(html.includes(".nr-table"), "defines .nr-table CSS");
});

test("trends.js includes nightreport in showView and leaveTrendViews", () => {
  const trendsPath = path.resolve(__dirname, "../static/trends.js");
  const trends = fs.readFileSync(trendsPath, "utf8");

  assert.ok(trends.includes('document.getElementById("nightreport")'), "showView references nightreport box");
  assert.ok(trends.includes('document.getElementById("nightreport-btn")'), "showView references nightreport button");
  assert.ok(trends.includes('which === "nightreport"'), "showView checks for nightreport");
});

test("progressLine: formats count of need, and says enough at or above 40", () => {
  assert.equal(
    NightReport.progressLine({ newFrames: 5, need: 40 }),
    "New club frames since the last training: 5 of 40"
  );
  assert.equal(
    NightReport.progressLine({ newFrames: 0, need: 40 }),
    "New club frames since the last training: 0 of 40"
  );
  assert.equal(
    NightReport.progressLine({ newFrames: null, need: 40 }),
    "New club frames since the last training: 0 of 40"
  );
  assert.equal(
    NightReport.progressLine({ newFrames: 40, need: 40 }),
    "Enough for a new club model: the night worker trains it tonight."
  );
  assert.equal(
    NightReport.progressLine({ newFrames: 45, need: 40 }),
    "Enough for a new club model: the night worker trains it tonight."
  );
  assert.equal(NightReport.progressLine(null), "");
});

test("almostSameNote: warns when latest candidate was trained on fewer than 40 more frames than try before it", () => {
  const candidatesSmallDiff = [
    { train: { frames: 1107 } },
    { train: { frames: 1104 } },
  ];
  assert.equal(
    NightReport.almostSameNote(candidatesSmallDiff),
    "Trained on almost the same frames as the try before (+3): add Club check frames first."
  );

  const candidatesZeroDiff = [
    { train: { frames: 1104 } },
    { train: { frames: 1104 } },
  ];
  assert.equal(
    NightReport.almostSameNote(candidatesZeroDiff),
    "Trained on almost the same frames as the try before (+0): add Club check frames first."
  );

  const candidatesNegativeDiff = [
    { train: { frames: 1100 } },
    { train: { frames: 1104 } },
  ];
  assert.equal(
    NightReport.almostSameNote(candidatesNegativeDiff),
    "Trained on almost the same frames as the try before (-4): add Club check frames first."
  );

  const candidatesEnoughDiff = [
    { train: { frames: 1150 } },
    { train: { frames: 1104 } },
  ];
  assert.equal(NightReport.almostSameNote(candidatesEnoughDiff), null);

  assert.equal(NightReport.almostSameNote([{ train: { frames: 1104 } }]), null);
  assert.equal(NightReport.almostSameNote([]), null);
  assert.equal(NightReport.almostSameNote(null), null);
});

test("nightreport-view.js includes progressLine and almostSameNote", () => {
  const nrView = fs.readFileSync(path.join(__dirname, "../static/nightreport-view.js"), "utf8");
  assert.ok(nrView.includes("SwingNightReport.progressLine"), "uses SwingNightReport.progressLine");
  assert.ok(nrView.includes("SwingNightReport.almostSameNote"), "uses SwingNightReport.almostSameNote");
  assert.ok(nrView.includes("nr-progress-line"), "renders nr-progress-line");
  assert.ok(nrView.includes("nr-almost-same"), "renders nr-almost-same");
});

test("runsLine: formats two-run candidate with 0-based kept run, null for 1-run or missing", () => {
  assert.equal(
    NightReport.runsLine({ train: { runs: 2, kept: 1 } }),
    "Trained twice (seeds 0 and 1), judged on the average; run 2's model kept."
  );
  assert.equal(
    NightReport.runsLine({ train: { runs: 2, kept: 0 } }),
    "Trained twice (seeds 0 and 1), judged on the average; run 1's model kept."
  );
  assert.equal(NightReport.runsLine({ train: { runs: 1, kept: 0 } }), null);
  assert.equal(NightReport.runsLine({ train: { swings: 48 } }), null);
  assert.equal(NightReport.runsLine({}), null);
  assert.equal(NightReport.runsLine(null), null);
});

test("runsDisagree: lists positions where two runs differ by >= 25 within-one-frame points", () => {
  const twoRunScores = {
    runs: [
      {
        positions: [
          { angle: "face", event: "p2", within1: 25.0, p90: 20.4 },
          { angle: "face", event: "p4", within1: 50.0, p90: 30.0 },
          { angle: "dtl", event: "p8", within1: 70.0, p90: 10.0 },
        ],
      },
      {
        positions: [
          { angle: "face", event: "p2", within1: 75.0, p90: 14.6 }, // diff 50 >= 25
          { angle: "face", event: "p4", within1: 60.0, p90: 28.0 }, // diff 10 < 25
          { angle: "dtl", event: "p8", within1: 40.0, p90: 12.0 },  // diff 30 >= 25
        ],
      },
    ],
  };

  const disagree = NightReport.runsDisagree(twoRunScores);
  assert.deepEqual(disagree, [
    "P2 face-on: 25% and 75%",
    "P8 down the line: 70% and 40%",
  ]);

  // Old candidate with no runs or 1 run
  assert.deepEqual(NightReport.runsDisagree({ runs: [{ positions: [] }] }), []);
  assert.deepEqual(NightReport.runsDisagree({}), []);
  assert.deepEqual(NightReport.runsDisagree(null), []);

  // Row missing from one run or null within1 is not in disagree
  const partialRuns = {
    runs: [
      { positions: [{ angle: "face", event: "p2", within1: 25.0 }, { angle: "face", event: "p8", within1: 80.0 }] },
      { positions: [{ angle: "face", event: "p2", within1: null }] }, // p8 missing from run 1, p2 within1 is null
    ],
  };
  assert.deepEqual(NightReport.runsDisagree(partialRuns), []);
});

test("runRows: returns positions present in current and all runs, in compareRows order", () => {
  const twoRunScores = {
    current: {
      positions: [
        { angle: "face", event: "takeaway", n: 9, within1: 33.3, p90: 38.0 },
        { angle: "face", event: "p2", n: 9, within1: 55.6, p90: 20.8 },
        { angle: "face", event: "p8", n: 9, within1: 77.8, p90: 8.3 },
        { angle: "dtl", event: "p2", n: 8, within1: 37.5, p90: 25.0 },
      ],
    },
    candidate: {
      positions: [
        { angle: "face", event: "takeaway", n: 9, within1: 33.3, p90: 36.0 },
        { angle: "face", event: "p2", n: 9, within1: 50.0, p90: 17.5 },
        { angle: "face", event: "p8", n: 9, within1: 62.5, p90: 11.0 },
        { angle: "dtl", event: "p2", n: 8, within1: 50.0, p90: 20.8 },
      ],
    },
    runs: [
      {
        positions: [
          { angle: "face", event: "takeaway", n: 9, within1: 33.3, p90: 36.0 },
          { angle: "face", event: "p2", n: 9, within1: 25.0, p90: 20.4 },
          { angle: "face", event: "p8", n: 9, within1: 75.0, p90: 10.0 },
          { angle: "dtl", event: "p2", n: 8, within1: 45.0, p90: 22.0 },
        ],
      },
      {
        positions: [
          { angle: "face", event: "takeaway", n: 9, within1: 33.3, p90: 36.0 },
          { angle: "face", event: "p2", n: 9, within1: 75.0, p90: 14.6 },
          { angle: "face", event: "p8", n: 9, within1: 50.0, p90: 12.0 },
          { angle: "dtl", event: "p2", n: 8, within1: 55.0, p90: 19.6 },
        ],
      },
    ],
  };

  const rows = NightReport.runRows(twoRunScores);
  assert.equal(rows.length, 4);

  // Swing order: face takeaway, face p2, face p8, dtl p2
  assert.equal(rows[0].event, "takeaway");
  assert.equal(rows[0].angle, "face");
  assert.equal(rows[0].n, 9);
  assert.equal(rows[0].current.within1, 33.3);
  assert.equal(rows[0].runs[0].within1, 33.3);
  assert.equal(rows[0].runs[1].within1, 33.3);
  assert.equal(rows[0].average.within1, 33.3);

  assert.equal(rows[1].event, "p2");
  assert.equal(rows[1].angle, "face");
  assert.equal(rows[1].current.within1, 55.6);
  assert.equal(rows[1].runs[0].within1, 25.0);
  assert.equal(rows[1].runs[1].within1, 75.0);
  assert.equal(rows[1].average.within1, 50.0);
  assert.equal(rows[1].average.p90, 17.5);

  assert.equal(rows[2].event, "p8");
  assert.equal(rows[2].angle, "face");

  assert.equal(rows[3].event, "p2");
  assert.equal(rows[3].angle, "dtl");

  // Old one-run candidate: returns empty array
  assert.deepEqual(NightReport.runRows({ current: twoRunScores.current, candidate: twoRunScores.candidate }), []);
  assert.deepEqual(NightReport.runRows(null), []);
});

test("runRows: omits row missing from one run", () => {
  const scores = {
    current: {
      positions: [
        { angle: "face", event: "takeaway", n: 9, within1: 33.3, p90: 38.0 },
        { angle: "face", event: "p2", n: 9, within1: 55.6, p90: 20.8 },
      ],
    },
    candidate: { positions: [] },
    runs: [
      {
        positions: [
          { angle: "face", event: "takeaway", n: 9, within1: 33.3, p90: 36.0 },
          { angle: "face", event: "p2", n: 9, within1: 25.0, p90: 20.4 },
        ],
      },
      {
        positions: [
          // p2 missing from run 1
          { angle: "face", event: "takeaway", n: 9, within1: 33.3, p90: 36.0 },
        ],
      },
    ],
  };

  const rows = NightReport.runRows(scores);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, "takeaway");
});

test("runRows: preserves null where within1 or p90 is missing from a run", () => {
  const scores = {
    current: {
      positions: [{ angle: "face", event: "p2", n: 9, within1: 55.6, p90: 20.8 }],
    },
    runs: [
      {
        positions: [{ angle: "face", event: "p2", n: 9, within1: 25.0, p90: 20.4 }],
      },
      {
        positions: [{ angle: "face", event: "p2", n: 9, within1: null, p90: null }],
      },
    ],
  };

  const rows = NightReport.runRows(scores);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runs[0].within1, 25.0);
  assert.equal(rows[0].runs[1].within1, null);
  assert.equal(rows[0].average.within1, null);
  assert.equal(rows[0].average.p90, null);
});

test("renderRunsSummary: renders runsLine and disagreement line for candidate with two runs and gap >= 25", () => {
  const NightReportView = require("../static/nightreport-view.js");
  const cand = sample.candidates[1];
  const html = NightReportView.renderRunsSummary(cand);

  assert.ok(html.includes("Trained twice (seeds 0 and 1), judged on the average; run 2&#039;s model kept."));
  assert.ok(html.includes("The two trainings disagreed on: P2 face-on (25% and 75%)"));
  assert.ok(html.includes("nr-runs-line"));
  assert.ok(html.includes("nr-runs-disagree"));
});

test("renderRunsSummary: returns empty string when candidate has no runs", () => {
  const NightReportView = require("../static/nightreport-view.js");
  const cand = sample.candidates[0];
  const html = NightReportView.renderRunsSummary(cand);
  assert.equal(html, "");
});

test("renderScoresTable: renders In use, Run 1, Run 2, Average (judged) when candidate has runs", () => {
  const NightReportView = require("../static/nightreport-view.js");
  const cand = sample.candidates[1];
  const html = NightReportView.renderScoresTable(cand.scores);

  assert.ok(html.includes("<th>In use</th>"), "includes In use header");
  assert.ok(html.includes("<th>Run 1</th>"), "includes Run 1 header");
  assert.ok(html.includes("<th>Run 2</th>"), "includes Run 2 header");
  assert.ok(html.includes("<th>Average (judged)</th>"), "includes Average header");
  assert.ok(html.includes("within 1 frame"), "includes within 1 frame row");
  assert.ok(html.includes("90th pct"), "includes 90th pct row");
  assert.ok(html.includes("overflow-x: auto"), "table is wrapped in scrollable container");
});

test("renderScoresTable: renders Before, After, Change when candidate has no runs", () => {
  const NightReportView = require("../static/nightreport-view.js");
  const cand = sample.candidates[0];
  const html = NightReportView.renderScoresTable(cand.scores);

  assert.ok(html.includes("<th>Before</th>"), "includes Before header");
  assert.ok(html.includes("<th>After</th>"), "includes After header");
  assert.ok(html.includes("<th>Change</th>"), "includes Change header");
  assert.ok(!html.includes("<th>Run 1</th>"), "does not include Run 1 header");
});



