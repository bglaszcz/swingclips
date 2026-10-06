// server/tests/week.test.js: unit tests for SwingWeek.weekSummary
const test = require("node:test");
const assert = require("node:assert/strict");
const Week = require("../static/week.js");

function makeRow(dateStr, club, carry, offline, strikeV, body = {}) {
  const t = new Date(dateStr + "T12:00:00").getTime();
  return {
    name: `swing_${club}_${dateStr}`,
    t,
    club,
    carry,
    offline,
    strikeV,
    ...body
  };
}

test("weekStartOf aligns correctly to Monday", () => {
  // 2026-09-30 is a Wednesday
  const mon = Week.weekStartOf("2026-09-30");
  assert.equal(mon.getDay(), 1); // Monday
  assert.equal(mon.getFullYear(), 2026);
  assert.equal(mon.getMonth(), 8); // Sep is index 8
  assert.equal(mon.getDate(), 28); // Sep 28 is Monday

  // 2026-10-04 is Sunday -> should be Monday Sep 28
  const monSun = Week.weekStartOf("2026-10-04");
  assert.equal(monSun.getDate(), 28);

  // 2026-09-28 is Monday -> stays Sep 28
  const monMon = Week.weekStartOf("2026-09-28");
  assert.equal(monMon.getDate(), 28);
});

test("formatWeekTitle formats date range across month boundaries", () => {
  const mon = Week.weekStartOf("2026-09-28");
  const title = Week.formatWeekTitle(mon);
  assert.equal(title, "Week of Sep 28 – Oct 4, 2026");

  const monSame = Week.weekStartOf("2026-10-05");
  const titleSame = Week.formatWeekTitle(monSame);
  assert.equal(titleSame, "Week of Oct 5 – 11, 2026");
});

test("a week with no practice", () => {
  const data = {
    rows: [],
    clips: [],
    sessions: [],
    gameLog: [],
    programLog: [],
    journal: { notes: {}, handicap: [] }
  };
  const summary = Week.weekSummary(data, "2026-09-28");

  assert.equal(summary.title, "Week of Sep 28 – Oct 4, 2026");
  assert.equal(summary.sections.length, 0);
  assert.match(summary.text, /No practice this week/);
});

test("a club below 15 swings left out of ball flight", () => {
  const rows = [];
  // 7 iron: 18 swings (>= 15, should be included)
  for (let i = 0; i < 18; i++) {
    rows.push(makeRow("2026-09-29", "7I", 150 + i % 5, -2, -12));
  }
  // Driver: 10 swings (< 15, should be left out)
  for (let i = 0; i < 10; i++) {
    rows.push(makeRow("2026-09-29", "DR", 230 + i % 5, 5, 2));
  }
  // PW: 14 swings (< 15, should be left out)
  for (let i = 0; i < 14; i++) {
    rows.push(makeRow("2026-09-30", "PW", 115 + i % 5, 0, -8));
  }

  const data = { rows };
  const summary = Week.weekSummary(data, "2026-09-28");

  const bfSection = summary.sections.find(s => s.title === "Ball flight");
  assert.ok(bfSection, "Ball flight section should exist");
  assert.equal(bfSection.lines.length, 1, "Only 7 iron should have a ball flight line");
  assert.match(bfSection.lines[0], /7 iron \(18 swings\)/);
  assert.doesNotMatch(bfSection.lines[0], /driver/);
  assert.doesNotMatch(bfSection.lines[0], /PW/);
});

test("a fault that went down", () => {
  // Last week: Sep 21 - Sep 27: early extension on 8 of 10 swings (80%)
  const rowsLastWeek = [];
  for (let i = 0; i < 10; i++) {
    rowsLastWeek.push(makeRow("2026-09-22", "7I", 150, 0, -10, {
      earlyExt: i < 8 ? 4.5 : 1.0 // threshold is 3 in faults.js
    }));
  }

  // This week: Sep 28 - Oct 04: early extension on 2 of 10 swings (20%)
  const rowsThisWeek = [];
  for (let i = 0; i < 10; i++) {
    rowsThisWeek.push(makeRow("2026-09-29", "7I", 150, 0, -10, {
      earlyExt: i < 2 ? 4.5 : 1.0
    }));
  }

  const data = {
    rows: [...rowsLastWeek, ...rowsThisWeek]
  };

  const summary = Week.weekSummary(data, "2026-09-28");
  const faultSection = summary.sections.find(s => s.title === "Faults");
  assert.ok(faultSection, "Faults section should exist");

  const eeLine = faultSection.lines.find(l => l.includes("Early extension"));
  assert.ok(eeLine, "Early extension fault line should exist");
  assert.match(eeLine, /20% of swings/);
  assert.match(eeLine, /vs 80% last week/);
});

test("a held-up finding listed and a not-clear one not", () => {
  const data = {
    rows: [
      makeRow("2026-09-29", "7I", 150, 0, -10)
    ],
    holdUp: [
      {
        move: "hipSway",
        result: "carry",
        foundStart: "2026-09-15",
        verdict: "held",
        later: { sessions: 6, n: 84, r: 0.31 },
        linkSentence: "Each 0.5 in more hip sway at impact: carry 3.2 yd shorter"
      },
      {
        move: "earlyExt",
        result: "path",
        foundStart: "2026-09-15",
        verdict: "faded", // NOT held up
        later: { sessions: 6, n: 84, r: 0.05 },
        linkSentence: "Early extension to path"
      },
      {
        move: "releaseArm",
        result: "strikeV",
        foundStart: "2026-09-15",
        verdict: "too early", // NOT held up
        later: { sessions: 1, n: 10, r: null },
        linkSentence: "Release arm to strike"
      }
    ]
  };

  const summary = Week.weekSummary(data, "2026-09-28");
  const huSection = summary.sections.find(s => s.title === "What held up");
  assert.ok(huSection, "What held up section should exist");
  assert.equal(huSection.lines.length, 1);
  assert.match(huSection.lines[0], /hip sway/);
  assert.match(huSection.lines[0], /held up in the 6 sessions since/);
  assert.doesNotMatch(huSection.lines[0], /Early extension/);
  assert.doesNotMatch(huSection.lines[0], /Release arm/);
});

test("a normal week with all 7 sections populated", () => {
  const rows = [];
  // Swings across 3 days: Mon Sep 28, Wed Sep 30, Fri Oct 2
  for (let i = 0; i < 20; i++) {
    rows.push(makeRow("2026-09-28", "7I", 152 + (i % 3), -2, -12, {
      earlyExt: 2.2,
      bendLoss: -8
    }));
  }
  for (let i = 0; i < 16; i++) {
    rows.push(makeRow("2026-09-30", "DR", 240 + (i % 5), 4, 3, {
      earlyExt: 3.5, // above 3 -> early extension fault
      bendLoss: -12 // below -10 -> standing up fault
    }));
  }
  for (let i = 0; i < 10; i++) {
    rows.push(makeRow("2026-10-02", "PW", 118 + (i % 3), 0, -8, {
      earlyExt: 1.8,
      bendLoss: -5
    }));
  }

  // Last week swings for comparison
  for (let i = 0; i < 20; i++) {
    rows.push(makeRow("2026-09-22", "7I", 145 + (i % 3), -5, -15, {
      earlyExt: 3.8,
      bendLoss: -14
    }));
  }

  const data = {
    rows,
    programLog: [
      {
        id: "lowpoint",
        name: "Low point",
        started: new Date("2026-09-28T10:00:00").getTime() / 1000,
        results: { b1: "passed", b2: "passed", b3: "not passed" },
        how: "done"
      }
    ],
    gameLog: [
      {
        id: "combine",
        name: "Combine",
        started: new Date("2026-09-30T15:00:00").getTime() / 1000,
        summary: { sgPerShot: -0.12, shots: 27, greens: 14 }
      }
    ],
    journal: {
      focus: {
        move: "earlyExt",
        aim: "less",
        club: "7I",
        thought: "Tush on the wall."
      },
      notes: {
        "2026-09-30": "Felt good with driver, kept hips back."
      },
      handicap: [
        { date: "2026-10-02", index: 16.4 }
      ]
    },
    holdUp: [
      {
        move: "hipSway",
        result: "carry",
        foundStart: "2026-09-15",
        verdict: "held",
        later: { sessions: 5, n: 65, r: 0.35 },
        linkSentence: "Hip sway at impact to carry"
      }
    ]
  };

  const summary = Week.weekSummary(data, "2026-09-28");

  assert.equal(summary.title, "Week of Sep 28 – Oct 4, 2026");
  assert.equal(summary.sections.length, 7, "All 7 sections should be present");

  const titles = summary.sections.map(s => s.title);
  assert.deepEqual(titles, [
    "Practice",
    "Ball flight",
    "The focus move",
    "Faults",
    "What held up",
    "Games",
    "Notes"
  ]);

  // Section 1: Practice
  const pSec = summary.sections.find(s => s.title === "Practice");
  assert.match(pSec.lines[0], /session/);
  assert.match(pSec.lines[1], /Swings: 46 total/);
  assert.match(pSec.lines[2], /Program: Low point/);

  // Section 2: Ball flight (7I and DR have >= 15 swings, PW has 10 and is omitted)
  const bfSec = summary.sections.find(s => s.title === "Ball flight");
  assert.equal(bfSec.lines.length, 2);
  assert.match(bfSec.lines[0], /7 iron \(20 swings\)/);
  assert.match(bfSec.lines[1], /driver \(16 swings\)/);

  // Section 3: The focus move
  const focSec = summary.sections.find(s => s.title === "The focus move");
  assert.match(focSec.lines[0], /Early extension \(7 iron\): median 2.2 in this week/);
  assert.match(focSec.lines[1], /Swing thought: “Tush on the wall.”/);

  // Section 4: Faults
  const fSec = summary.sections.find(s => s.title === "Faults");
  assert.ok(fSec.lines.length >= 1);

  // Section 5: What held up
  const huSec = summary.sections.find(s => s.title === "What held up");
  assert.equal(huSec.lines.length, 1);
  assert.match(huSec.lines[0], /held up in the 5 sessions since/);

  // Section 6: Games
  const gSec = summary.sections.find(s => s.title === "Games");
  assert.equal(gSec.lines.length, 1);
  assert.match(gSec.lines[0], /Combine: -0.12 strokes\/shot/);

  // Section 7: Notes
  const nSec = summary.sections.find(s => s.title === "Notes");
  assert.ok(nSec.lines.some(l => l.includes("Felt good with driver")));
  assert.ok(nSec.lines.some(l => l.includes("Handicap index: 16.4 on Oct 2")));

  // Text contains all headers and content
  assert.ok(summary.text.includes("Week of Sep 28 – Oct 4, 2026"));
  assert.ok(summary.text.includes("Practice"));
  assert.ok(summary.text.includes("Ball flight"));
  assert.ok(summary.text.includes("The focus move"));
  assert.ok(summary.text.includes("Faults"));
  assert.ok(summary.text.includes("What held up"));
  assert.ok(summary.text.includes("Games"));
  assert.ok(summary.text.includes("Notes"));
});

test("prevWeekStart and nextWeekStart navigate 7-day intervals", () => {
  const cur = Week.weekStartOf("2026-09-28");
  const prev = Week.prevWeekStart(cur);
  assert.equal(prev.getDate(), 21);
  assert.equal(prev.getMonth(), 8);

  const next = Week.nextWeekStart(cur);
  assert.equal(next.getDate(), 5);
  assert.equal(next.getMonth(), 9);
});

test("noise comparison: only changes larger than noise are reported", () => {
  const rows = [];
  // Last week: 20 swings, carry 150, offline spread 8, strike -12
  for (let i = 0; i < 20; i++) {
    rows.push(makeRow("2026-09-22", "7I", 150, i % 2 === 0 ? 8 : -8, -12));
  }
  // This week: 20 swings
  // carry 151 (diff +1, noise 3.0 -> NOT bigger than noise)
  // offline spread 14 (diff +6, noise 2.0 -> BIGGER than noise)
  // strike -12 (diff 0, noise 2.0 -> NOT bigger than noise)
  for (let i = 0; i < 20; i++) {
    rows.push(makeRow("2026-09-29", "7I", 151, i % 2 === 0 ? 14 : -14, -12));
  }

  const data = {
    rows,
    noise: {
      "7I": { carry: 3.0, carrySpread: 3.0, offlineSpread: 2.0, strike: 2.0 }
    }
  };

  const summary = Week.weekSummary(data, "2026-09-28");
  const bfSec = summary.sections.find(s => s.title === "Ball flight");
  assert.ok(bfSec);
  const line = bfSec.lines[0];

  // Offline spread was +6 vs noise 2.0 -> reported
  assert.match(line, /offline spread 14 yd \(\+6 yd vs last week\)/);
  // Carry diff was +1 vs noise 3.0 -> NOT reported as vs last week
  assert.match(line, /carry 151 yd \(spread 0 yd\)/);
  assert.doesNotMatch(line, /carry 151 yd.*\[.*vs last week\]/);
});

test("extractRows and extractSessions handle raw clips and swings objects", () => {
  const clips = [
    {
      name: "swing_face_1.mp4",
      angle: "face",
      recorded: "2026-09-29T10:00:00",
      shot: { club: "7I", ball: { carry: 155, side: 1 }, clubData: { faceImpactV: -10 } },
      partner: "swing_dtl_1.mp4"
    },
    {
      name: "swing_dtl_1.mp4",
      angle: "dtl",
      recorded: "2026-09-29T10:00:00",
      partner: "swing_face_1.mp4"
    }
  ];
  const swings = {
    "swing_face_1.mp4": {
      body: { earlyExt: 2.1 }
    }
  };

  const data = { clips, swings };
  const summary = Week.weekSummary(data, "2026-09-28");

  const pSec = summary.sections.find(s => s.title === "Practice");
  assert.ok(pSec);
  // Exactly 1 swing counted (secondary dtl clip excluded)
  assert.match(pSec.lines[1], /Swings: 1 total \(7 iron 1\)/);
});

test("index.html contains Week for coach markup, Tools menu item, scripts, and hash router", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const htmlPath = path.resolve(__dirname, "../static/index.html");
  const html = fs.readFileSync(htmlPath, "utf8");

  assert.ok(html.includes('id="week-btn"'), "defines Tools menu Week for coach button");
  assert.ok(html.includes('<section id="week"'), "defines #week section");
  assert.ok(html.includes('id="week-close"'), "defines Close button");
  assert.ok(html.includes('id="week-prev-btn"'), "defines Prev week button");
  assert.ok(html.includes('id="week-next-btn"'), "defines Next week button");
  assert.ok(html.includes('id="week-copy-btn"'), "defines Copy for coach button");
  assert.ok(html.includes('id="week-title"'), "defines week title element");
  assert.ok(html.includes('id="week-cards"'), "defines week cards container");
  assert.ok(html.includes('<script src="/static/week.js"></script>'), "loads week.js script");
  assert.ok(html.includes('<script src="/static/week-view.js"></script>'), "loads week-view.js script");
  assert.ok(html.includes('week: "week-btn"'), "routes #week hash to week-btn");
});

test("trends.js includes week in showView, tools-btn active list, and leaveTrendViews", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const jsPath = path.resolve(__dirname, "../static/trends.js");
  const js = fs.readFileSync(jsPath, "utf8");

  assert.ok(js.includes('document.getElementById("week")'), "checks #week in showView / leaveTrendViews");
  assert.ok(js.includes('document.getElementById("week-btn")'), "toggles #week-btn in showView");
  assert.ok(js.includes('which === "week"'), "includes week in tools-btn tab activation");
});


