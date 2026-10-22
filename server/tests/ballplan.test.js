// ballplan.js: the 4-week ball plan drawn from /api/ballplan (today's steps and Start buttons, the
// scoreboard, the weeks table, the Week brief's lines), and the brief's "Ball plan" section (week.js).
//
// Run with: node --test tests/ballplan.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const BP = require("../static/ballplan.js");
const Week = require("../static/week.js");

const share = (value, n, sessions = 1) => ({ value, n, sessions });
const num = (key, label, target, better, start, plan, week, verdict) => ({
  key, label, what: `${label} what`, club: "7 iron", better, target, start, plan, week, verdict, interval: null,
});

function model(over = {}) {
  return {
    plan: {
      id: "t", name: "4-week ball plan", start: "2026-10-22", end: "2026-11-18",
      baseline: { from: "2026-09-23", to: "2026-10-21" }, why: "Flat since August.", need: { practice: 2, test: 1 },
      programs: ["ballpractice", "balltest"], active: true, started: true, ended: false, week: 2, weeks: 4, today: "2026-11-01",
      ...(over.plan || {}),
    },
    numbers: over.numbers || [
      num("solid7", "7 iron solid", 70, "up", share(56.1, 187, 13), share(64, 50, 3), share(62, 20, 1), "better"),
      num("heavyThin", "Irons heavy or thin", 5, "down", share(9.7, 462, 14), share(8, 90, 3), share(6, 30, 1), "same"),
      num("attack7", "7 iron attack angle -2 to -5", null, "up", share(52.4, 187), share(60, 50), share(55, 20), "same"),
    ],
    combine: { before: [{ day: "2026-10-08", sgPerShot: -0.204 }], plan: [{ day: "2026-10-25", sgPerShot: -0.15, greens: 20, shots: 27 }],
      best: -0.204, bestPlan: -0.15 },
    weeks: [
      { n: 1, from: "2026-10-22", to: "2026-10-28", practice: 2, test: 1, combine: [{ day: "2026-10-25", sgPerShot: -0.15 }],
        numbers: { solid7: share(66, 30), heavyThin: share(9, 60), attack7: share(60, 30) } },
      { n: 2, from: "2026-10-29", to: "2026-11-04", practice: 1, test: 0, combine: [],
        numbers: { solid7: share(62, 20), heavyThin: share(6, 30), attack7: share(55, 20) } },
      { n: 3, from: "2026-11-05", to: "2026-11-11", practice: 0, test: 0, combine: [], numbers: {} },
    ],
    today: over.today === undefined ? {
      kind: "practice", title: "Practice day",
      steps: [{ text: "Warm up: 10 easy wedges." }, { text: "Practice day: ...", program: "ballpractice", running: false, done: false }],
    } : over.today,
    ...(over.range ? { range: over.range } : {}),
  };
}

test("today: a Start button per step not done, Running and Done otherwise", () => {
  let html = BP.todayHtml(model());
  assert.match(html, /Today: Practice day/);
  assert.match(html, /Week 2 of 4 · Oct 29 to Nov 4/);
  assert.match(html, /data-program="ballpractice"/);
  assert.match(html, /This week: practice days 1 of 2 · test day 0 of 1/);
  html = BP.todayHtml(model({ today: { kind: "test", title: "Test day", steps: [
    { text: "Cold." }, { text: "Test.", program: "balltest", done: true, running: false },
    { text: "Combine.", game: "combine", done: false, running: true }] } }));
  assert.match(html, /✓ Done/);
  assert.match(html, /● Running/);
  assert.doesNotMatch(html, /bp-go/);
  // Outside the plan's weeks: the name and when it starts.
  html = BP.todayHtml(model({ today: null, plan: { started: false, active: false, week: null } }));
  assert.match(html, /Starts Oct 22, 4 weeks to Nov 18/);
});

test("scoreboard: so far against start and target, the verdict, the Combine, numbers with no target below", () => {
  const html = BP.boardHtml(model());
  assert.equal((html.match(/class="bp-tile"/g) || []).length, 2);
  assert.match(html, /64%<small>so far, 50 shots/);
  assert.match(html, /Start 56% · Target 70% or more/);
  assert.match(html, /Target 5% or less/);
  assert.match(html, /This week 62% \(20 shots\)/);
  assert.match(html, /Better than at the start/);
  assert.match(html, /Can&#39;t tell yet/);
  assert.match(html, /best before the plan −0.20 strokes a shot/);
  assert.match(html, /in the plan: Oct 25 −0.15/);
  assert.match(html, /7 iron attack angle -2 to -5:<\/b> 52% at the start, 60% so far/);
  // Before the plan: where it starts, no verdict.
  const before = BP.boardHtml(model({ plan: { started: false, active: false, week: null } }));
  assert.match(before, /Where you start \(187 shots\)/);
  assert.doesNotMatch(before, /bp-chip/);
});

test("weeks table: start row, each week, weeks still to come blank", () => {
  const html = BP.weeksTableHtml(model());
  assert.match(html, /Start \(Sep 23 to Oct 21\)/);
  assert.match(html, /1: Oct 22 to Oct 28<\/td><td>2 of 2<\/td><td>1 of 1<\/td><td>66%/);
  assert.match(html, /<tr class="now"><td>2: Oct 29 to Nov 4/);
  assert.match(html, /3: Nov 5 to Nov 11<\/td><td>–<\/td><td>–<\/td><td>–/);
});

test("Week brief lines: the week's sessions and numbers against start and target; none outside the plan", () => {
  const range = { from: "2026-10-27", to: "2026-11-02", practice: 2, test: 1,
    numbers: { solid7: share(70, 30), heavyThin: share(4, 50), attack7: share(61, 30) },
    combine: [{ day: "2026-11-01", sgPerShot: -0.12, greens: 21, shots: 27 }] };
  const lines = BP.weekBriefLines(model({ range }));
  assert.match(lines[0], /^4-week ball plan \(Oct 22 to Nov 18\): Flat since August\./);
  assert.equal(lines[1], "Sessions this week: practice days 2 of 2, test day 1 of 1.");
  assert.match(lines[2], /^7 iron solid \(.*\): 70% this week \(30 shots\); start 56%, target 70% or more; so far in the plan 64% \(50 shots\): better than at the start\.$/);
  assert.match(lines[3], /target 5% or less/);
  assert.match(lines[4], /^7 iron attack angle -2 to -5: 61% this week \(30 shots\), 52% at the start\.$/);
  assert.match(lines[5], /^Combine this week: Nov 1 −0.12 strokes a shot \(21 of 27 on the green\)\. Best before the plan: −0.20\.$/);
  assert.deepEqual(BP.weekBriefLines(model({ range: { ...range, from: "2026-10-12", to: "2026-10-18" } })), []);
  assert.deepEqual(BP.weekBriefLines(model()), []);   // no range asked for
});

test("Week brief: the Ball plan section comes first when the lines are handed in", () => {
  const summary = Week.weekSummary({ clips: [], swings: {}, journal: {}, ballPlanLines: ["Plan line one.", "Plan line two."] }, "2026-10-26");
  assert.equal(summary.sections[0].title, "Ball plan");
  assert.deepEqual(summary.sections[0].lines, ["Plan line one.", "Plan line two."]);
  assert.match(summary.text, /Plan line one\./);
  assert.equal(Week.weekSummary({ clips: [], swings: {}, journal: {} }, "2026-10-26").sections.length, 0);
});

// ---- The checks: going well, struggling (with the drill), and the counts ----
const CHECK = {
  from: "2026-10-21", to: "2026-10-21", days: ["2026-10-21"],
  irons: { n: 19, good: 9, causes: { heel: 5, toe: 3, shallow: 1, steep: 1, short: 0 }, heelPct: 26.3 },
  drives: { n: 14, fairway: 5, causes: { "left-curve": 6, "left-start": 2, "right-curve": 1, "right-start": 0, left: 0, right: 0 } },
  solid7: { hits: 6, n: 8 },
  hands: { heel: 0.2, centre: -0.1, nHeel: 5, nCentre: 9, diff: 0.3 },
  good: ["6 of 8 7 irons solid (75%): at the target of 70%."],
  struggle: [
    { key: "heel", label: "Off the heel", what: "struck more than 12 mm toward the heel", why: "Hands out.",
      drill: "Pump drill.", thought: "Hands drop to the trail pocket.", n: 5, of: 19,
      hands: { heel: 0.2, centre: -0.1, nHeel: 5, nCentre: 9, diff: 0.3 } },
    { key: "left-curve", label: "Curved left", what: "curved left", why: "Face closed to the path.",
      drill: "Hold-off finish.", thought: "Hold the face.", n: 6, of: 14 },
  ],
};

test("check card: going well, struggling with its drill and thought, the counts", () => {
  const html = BP.checkHtml(CHECK, "Last session, Oct 21");
  assert.match(html, /Last session, Oct 21/);
  assert.match(html, /Going well/);
  assert.match(html, /6 of 8 7 irons solid \(75%\): at the target of 70%\./);
  assert.match(html, /Off the heel: 5 of 19, struck more than 12 mm toward the heel./);
  assert.match(html, /Drill: Pump drill\./);
  assert.match(html, /Swing thought: &quot;Hands drop to the trail pocket\.&quot;/);
  assert.match(html, /On 5 heel strikes the hands sat 0\.3 in higher in the downswing than on 9 centred ones/);
  assert.match(html, /Irons: 9 of 19 centred and full length; 5 off the heel, 3 off the toe, 1 heavy, 1 digging\./);
  assert.match(html, /Drives: 5 of 14 in the fairway; 6 curved left, 2 started left, 1 curved right\./);
  // Nothing at all: no card. Nothing going well or no miss standing out: said so.
  assert.equal(BP.checkHtml({ irons: { n: 0 }, drives: { n: 0 } }, "x"), "");
  const quiet = BP.checkHtml({ ...CHECK, good: [], struggle: [] }, "x");
  assert.match(quiet, /Nothing at its target yet\./);
  assert.match(quiet, /No miss stood out\./);
});

test("hands line: higher, lower, or the same on heel strikes", () => {
  assert.match(BP.handsLine({ diff: 0.1, nHeel: 4, nCentre: 6 }), /the hands in the downswing were where they were on 6 centred/);
  assert.match(BP.handsLine({ diff: -0.4, nHeel: 4, nCentre: 6 }), /0\.4 in lower/);
  assert.equal(BP.handsLine(null), "");
});

test("last session title: today so far, or the day", () => {
  const m = model();
  m.checks = { last: { ...CHECK, from: "2026-11-01", to: "2026-11-01" } };
  assert.equal(BP.lastTitle(m), "Today so far");
  m.checks.last = CHECK;
  assert.equal(BP.lastTitle(m), "Last session, Oct 21");
});

test("tailored step shows why; the Week brief carries the check and the next practice day", () => {
  const m = model({ today: { kind: "practice", title: "Practice day", emphasis: "centre", steps: [
    { text: "Centred strike day.", program: "ballcentre", why: "27 iron misses came off the heel or toe.", running: false, done: false }] } });
  assert.match(BP.todayHtml(m), /<div class="bp-why">27 iron misses came off the heel or toe\.<\/div>/);
  m.range = { from: "2026-10-29", to: "2026-11-04", practice: 1, test: 0, combine: [],
    numbers: { solid7: share(62, 20), heavyThin: share(6, 30), attack7: share(55, 20) }, check: CHECK };
  m.emphasis = { key: "centre", why: "Today works on a centred strike." };
  const lines = BP.weekBriefLines(m);
  assert.ok(lines.includes("Going well: 6 of 8 7 irons solid (75%): at the target of 70%."));
  assert.ok(lines.some(l => l.startsWith("Struggling: Off the heel: 5 of 19") && l.includes("Swing thought: \"Hands drop to the trail pocket.\"")));
  assert.ok(lines.includes("Next practice day: Today works on a centred strike."));
});
