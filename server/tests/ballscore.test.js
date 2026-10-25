// server/tests/ballscore.test.js: the ball scoreboard on Week for coach (static/ballscore.js)
const test = require("node:test");
const assert = require("node:assert/strict");
const BallScore = require("../static/ballscore.js");

// The week of Mon Oct 19 2026 (local time); the 4 weeks before start Sep 21.
const WEEK = new Date(2026, 9, 19, 0, 0, 0, 0).getTime();
const at = (daysFromWeek, minute = 0) => new Date(2026, 9, 19 + daysFromWeek, 10, minute).getTime();

/** n shots of a club on one day: carries cycle through `carries`, strike and side as given. */
function day(daysFromWeek, club, n, carries, strikeH = 0, side = 0) {
  return Array.from({ length: n }, (_, i) => ({
    t: at(daysFromWeek, i), club, carry: carries[i % carries.length], side: Array.isArray(side) ? side[i % side.length] : side,
    strikeH: Array.isArray(strikeH) ? strikeH[i % strikeH.length] : strikeH,
  }));
}

const row = (model, label) => model.rows.find(r => r.label === label);

test("club codes are read either way round", () => {
  assert.equal(BallScore.clubCode("7I"), "I7");
  assert.equal(BallScore.clubCode("i7"), "I7");
  assert.equal(BallScore.clubCode("dr"), "DR");
  assert.equal(BallScore.clubCode("PW"), "PW");
  assert.equal(BallScore.clubCode(null), null);
});

test("only normal swings count: drills, warm up, games and left out swings are dropped", () => {
  const shot = { club: "I7", ball: { carry: 150, side: 4 }, clubData: { faceImpactH: 6 } };
  const rows = [
    { t: at(0), c: { shot } },
    { t: at(0, 1), c: { shot, drill: "warmup" } },
    { t: at(0, 2), c: { shot, game: { id: "combine" } } },
    { t: at(0, 3), c: { shot, excluded: true } },
    { t: at(0, 4), drill: "pump", c: { shot } },
    { t: at(0, 5), club: "7I", carry: 148, offline: -3, strikeH: -2 },
  ];
  const shots = BallScore.shotsFromRows(rows);
  assert.equal(shots.length, 2);
  assert.deepEqual(shots[0], { t: at(0), club: "I7", carry: 150, side: 4, strikeH: 6 });
  assert.deepEqual(shots[1], { t: at(0, 5), club: "I7", carry: 148, side: -3, strikeH: -2 });
});

test("short is measured against one median per club over the five weeks", () => {
  // Before: 4 sessions of 10 shots, 2 of each 10 short (carry 140 against a median of 155).
  // This week: 3 sessions of 10, none short. The median over all 70 carries is 155.
  const before = [-25, -18, -11, -4].flatMap(d => day(d, "I7", 10, [155, 155, 156, 154, 155, 140, 157, 155, 153, 140]));
  const week = [0, 2, 4].flatMap(d => day(d, "I7", 10, [155, 156, 154, 155, 157, 153, 155, 156, 154, 155]));
  const m = BallScore.build([...before, ...week], WEEK);
  const r = row(m, "5 to 7 iron, 10+ yd short");
  assert.equal(r.before.n, 40);
  assert.equal(r.before.hits, 8);
  assert.equal(r.before.sessions, 4);
  assert.equal(r.week.hits, 0);
  assert.equal(r.week.sessions, 3);
  // Clearly better this week, but last week (one session) can't back it up: one good week is too early.
  assert.equal(r.thisWeek, "better");
  assert.equal(r.verdict, "too early");
  assert.equal(r.why, "better this week, needs a second better week in a row");
  assert.equal(r.byWeek.length, 5);
  assert.equal(r.byWeek[4].start, WEEK);
  assert.equal(r.byWeek[4].pct, 0);
  assert.equal(r.byWeek[0].pct, 0.2);
});

test("too early until there are 3 sessions this week, however good the week looks", () => {
  const before = [-25, -18, -11, -4].flatMap(d => day(d, "I7", 10, [155, 140]));
  const week = [0, 2].flatMap(d => day(d, "I7", 20, [155, 156]));
  const r = row(BallScore.build([...before, ...week], WEEK), "5 to 7 iron, 10+ yd short");
  assert.equal(r.verdict, "too early");
  assert.equal(r.why, "2 sessions this week, needs 3");
  const lines = BallScore.lines(BallScore.build([...before, ...week], WEEK));
  assert.ok(lines.some(l => l.includes("Too early: 2 sessions this week, needs 3.")));
});

test("too early when the 4 weeks before have too few sessions", () => {
  const before = [-4, -3].flatMap(d => day(d, "I8", 15, [149, 135]));
  const week = [0, 2, 4].flatMap(d => day(d, "I8", 10, [149, 150]));
  const r = row(BallScore.build([...before, ...week], WEEK), "8 iron to gap wedge, 10+ yd short");
  assert.equal(r.verdict, "too early");
  assert.match(r.why, /2 sessions in the 4 weeks before, needs 3/);
});

test("a small change is no clear change", () => {
  // Before 20% short, this week about 17%: under 5 points.
  const before = [-25, -18, -11, -4].flatMap(d => day(d, "I7", 10, [155, 155, 156, 154, 155, 140, 157, 155, 153, 140]));
  const week = [0, 2, 4].flatMap(d => day(d, "I7", 12, [155, 155, 156, 154, 155, 140, 157, 155, 153, 155, 154, 140]));
  const r = row(BallScore.build([...before, ...week], WEEK), "5 to 7 iron, 10+ yd short");
  assert.equal(r.verdict, "no clear change");
});

test("a big change that comes from one wild session is not clear", () => {
  // This week: two sessions like before (20% short) and one with most shots short.
  const norm = [155, 155, 156, 154, 155, 140, 157, 155, 153, 140];
  const before = [-25, -18, -11, -4].flatMap(d => day(d, "I7", 10, norm));
  const week = [...day(0, "I7", 10, norm), ...day(2, "I7", 10, norm), ...day(4, "I7", 10, [140, 141, 139, 140, 142, 140, 155, 140, 141, 140])];
  const r = row(BallScore.build([...before, ...week], WEEK), "5 to 7 iron, 10+ yd short");
  assert.ok(r.week.pct > r.before.pct + 0.2, "the week looks much worse on the totals");
  assert.equal(r.verdict, "no clear change");
});

test("centred strike: higher is better, within 12 mm either side", () => {
  const before = [-25, -18, -11, -4].flatMap(d => day(d, "PW", 10, [114], [20, -15, 3, 0, 18, 2, -2, 25, 1, 0])); // 6 of 10 centred
  const week = [0, 2, 4].flatMap(d => day(d, "PW", 10, [114], [12, -12, 3, 0, 1, 2, -2, 5, 1, 0])); // all centred
  const r = row(BallScore.build([...before, ...week], WEEK), "8 iron to gap wedge, centred strike");
  assert.equal(r.before.pct, 0.6);
  assert.equal(r.week.pct, 1);
  assert.equal(r.better, "higher");
  assert.equal(r.thisWeek, "better");
});

test("driver: beyond 30 yd offline either side, and its own centred strike row", () => {
  const before = [-25, -18, -11, -4].flatMap(d => day(d, "DR", 10, [223], 0, [0, 10, -31, 35, 5, -5, 20, -40, 2, 0])); // 3 of 10 wide
  const week = [0, 2, 4].flatMap(d => day(d, "DR", 10, [223], 0, [0, 10, -20, 25, 5, -5, 20, -30, 2, 0])); // none wide (30 is not beyond)
  const m = BallScore.build([...before, ...week], WEEK);
  const wide = row(m, "Driver, beyond 30 yd offline");
  assert.equal(wide.before.hits, 12);
  assert.equal(wide.week.hits, 0);
  assert.equal(wide.thisWeek, "better");
  assert.ok(row(m, "Driver, centred strike"));
  assert.equal(m.rows.filter(r => r.group === "long").length, 0, "no 5 to 7 iron rows without those clubs");
});

test("irons and woods are never pooled: a 3 wood or a hybrid is in no row", () => {
  const shots = [-25, -18, -11, -4, 0, 2, 4].flatMap(d => [...day(d, "W3", 10, [206]), ...day(d, "H4", 10, [181])]);
  assert.equal(BallScore.build(shots, WEEK).rows.length, 0);
});

test("shots outside the five weeks are ignored", () => {
  const old = day(-40, "I7", 30, [100]);
  const m = BallScore.build(old, WEEK);
  assert.equal(m.rows.length, 0);
});

test("a club needs 8 carries in the five weeks before its shots can be short", () => {
  const shots = [...day(-4, "I9", 7, [133, 120]), ...day(0, "I8", 10, [149])];
  const r = row(BallScore.build(shots, WEEK), "8 iron to gap wedge, 10+ yd short");
  assert.equal(r.before.n, 0, "the 9 iron has too few carries for a median");
  assert.equal(r.week.n, 10);
});

test("the uncertainty never drops below plain shot counting", () => {
  // Three identical sessions: no session to session wobble, so the floor applies.
  const t = { hits: 6, n: 30, perSession: [{ hits: 2, n: 10 }, { hits: 2, n: 10 }, { hits: 2, n: 10 }] };
  const v = BallScore.variance(t);
  assert.ok(v > 0);
  const p = 6.5 / 31;
  assert.ok(Math.abs(v - (p * (1 - p)) / 30) < 1e-12);
});

test("lines: the window, each row with this week, before and by week, and how verdicts work", () => {
  const before = [-25, -18, -11, -4].flatMap(d => day(d, "I7", 10, [155, 140]));
  const week = [0, 2, 4].flatMap(d => day(d, "I7", 10, [155]));
  const lines = BallScore.lines(BallScore.build([...before, ...week], WEEK));
  assert.match(lines[0], /^This week against the 4 weeks before \(Sep 21 to Oct 18\)\. Normal swings only/);
  const short = lines.find(l => l.startsWith("5 to 7 iron, 10+ yd short:"));
  assert.match(short, /0% \(30 shots, 3 sessions\) this week vs 50% \(40 shots, 4 sessions\) before\. Too early: better this week, needs a second better week in a row\./);
  assert.match(short, /By week, oldest first: 50% · 50% · 50% · 50% · 0%\.$/);
  assert.ok(lines.some(l => /^10\+ yd short: carry at least 10 yd under that club's median over these 5 weeks/.test(l)));
  assert.ok(lines.some(l => /the same call two weeks in a row\. One good or bad session, or week, is not a trend\.$/.test(l)));
  assert.ok(lines.every(l => !l.includes("—")), "no em dashes");
});

test("a week with no shots in a row says so and is too early", () => {
  const before = [-25, -18, -11].flatMap(d => [...day(d, "I7", 10, [155, 140]), ...day(d, "DR", 10, [223])]);
  const week = [0, 2, 4].flatMap(d => day(d, "I7", 10, [155]));
  const m = BallScore.build([...before, ...week], WEEK);
  const wide = row(m, "Driver, beyond 30 yd offline");
  assert.equal(wide.week.n, 0);
  assert.equal(wide.verdict, "too early");
  const line = BallScore.lines(m).find(l => l.startsWith("Driver, beyond 30 yd offline:"));
  assert.match(line, /: no shots this week vs 0% \(30 shots, 3 sessions\) before\. Too early: 0 sessions this week, needs 3\./);
  // Days 25, 18 and 11 before the week fall in its first three weeks; the fourth week and this one have none.
  assert.match(line, /oldest first: 0% · 0% · 0% · – · –\.$/);
});

// Six weeks: weeks -5 to -2 at 30% short (3 sessions each), then last week and this week as given.
function sixWeeks(lastWeek, thisWeek, often = [155, 155, 156, 154, 155, 140, 157, 140, 153, 140]) {
  const sessions = (week, carries) => [0, 2, 4].flatMap(d => day(7 * week + d, "I7", 10, carries));
  return [...[-5, -4, -3, -2].flatMap(w => sessions(w, often)), ...sessions(-1, lastWeek), ...sessions(0, thisWeek)];
}
const NONE_SHORT = [155, 156, 154, 155, 157, 153, 155, 156, 154, 155];
const HALF_SHORT = [155, 140, 156, 140, 154, 140, 155, 140, 157, 140];
const RARELY_SHORT = [155, 155, 156, 154, 155, 157, 155, 153, 156, 140];

test("better two weeks in a row is better", () => {
  const r = row(BallScore.build(sixWeeks(NONE_SHORT, NONE_SHORT), WEEK), "5 to 7 iron, 10+ yd short");
  assert.equal(r.lastWeek, "better");
  assert.equal(r.thisWeek, "better");
  assert.equal(r.verdict, "better");
  assert.equal(r.why, null);
});

test("worse two weeks in a row is worse", () => {
  // 10% short for four weeks, then half the shots short two weeks running.
  const r = row(BallScore.build(sixWeeks(HALF_SHORT, HALF_SHORT, RARELY_SHORT), WEEK), "5 to 7 iron, 10+ yd short");
  assert.equal(r.lastWeek, "worse");
  assert.equal(r.verdict, "worse");
});

test("a bad week after a good one is too early, not worse", () => {
  const r = row(BallScore.build(sixWeeks(NONE_SHORT, HALF_SHORT, RARELY_SHORT), WEEK), "5 to 7 iron, 10+ yd short");
  assert.equal(r.lastWeek, "better");
  assert.equal(r.thisWeek, "worse");
  assert.equal(r.verdict, "too early");
  assert.equal(r.why, "worse this week, needs a second worse week in a row");
});

test("an empty model gives no lines", () => {
  assert.deepEqual(BallScore.lines(BallScore.build([], WEEK)), []);
  assert.deepEqual(BallScore.lines(null), []);
});
