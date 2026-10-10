// Scoreboard test suite (static/board.js, static/strokes.js): the good-shot rules one at a time, the
// session score, the latest against last time and the usual, personal bests, the practice calendar;
// and strokes gained for range shots.
//
// Run with: node --test tests/board.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const Board = require("../static/board.js");
const Strokes = require("../static/strokes.js");
const GoodShots = require("../static/goodshots.js");
const Games = require("../static/games.js");

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);
const BASE = { n: 50, carry: 150, smash: 1.3, strikeH: 0, strikeV: 0 };
const shotOf = (o = {}) => ({ club: "I7", carry: 150, offline: 0, smash: 1.32, strikeH: 2, strikeV: -3, ...o });
const ctx = (extra = {}) => ({ clubs: { I7: { baseline: BASE, ranges: {}, ...extra }, DR: { baseline: { n: 20, carry: 230, smash: 1.42 }, ranges: {} } }, settings: null });

test("rules: each good-shot rule on its own", () => {
  assert.deepEqual(Board.rules(shotOf(), BASE, "irons", null), { line: true, distance: true, solid: true, centred: true });
  assert.equal(Board.rules(shotOf({ offline: -8 }), BASE, "irons", null).line, false);      // 5% of 150 = 7.5
  assert.equal(Board.rules(shotOf({ offline: 7.5 }), BASE, "irons", null).line, true);
  assert.equal(Board.rules(shotOf({ carry: 134 }), BASE, "irons", null).distance, false);   // 10% short = 135
  assert.equal(Board.rules(shotOf({ carry: 169 }), BASE, "irons", null).distance, false);   // 12% long = 168
  assert.equal(Board.rules(shotOf({ smash: 1.29 }), BASE, "irons", null).solid, false);
  assert.equal(Board.rules(shotOf({ strikeH: 21 }), BASE, "irons", null).centred, false);
  // What can't be checked is null, not a fail.
  const bare = Board.rules(shotOf({ smash: null, strikeH: null, strikeV: null }), BASE, "irons", null);
  assert.equal(bare.solid, null);
  assert.equal(bare.centred, null);
  assert.equal(Board.rules(shotOf({ carry: 0 }), BASE, "irons", null), null);
  assert.equal(Board.rules(shotOf(), null, "irons", null), null);
  assert.equal(Board.rules(shotOf({ strikeH: 30 }), BASE, "irons", { strike: { on: false } }).centred, null);
});

test("rules agree with goodshots.js: a shot is good when no rule fails", () => {
  const shots = [];
  for (const offline of [0, 6, 9]) for (const carry of [130, 150, 170]) for (const smash of [1.25, 1.35, null]) {
    for (const strikeH of [0, 25, null]) shots.push(shotOf({ offline, carry, smash, strikeH }));
  }
  for (const s of shots) {
    const r = Board.rules(s, BASE, "irons", null);
    const good = Board.SCORED.every(k => r[k] !== false);
    assert.equal(good, GoodShots.judgeShot(s, BASE, "irons", null).good, JSON.stringify(s));
  }
});

test("swingMatch: the share of readable body numbers inside the good-shot range", () => {
  const range = { enough: true, reliable: true, q10: 0, q90: 10 };
  const ranges = { a: range, b: range, c: range, d: range, e: range, f: { enough: false }, g: { ...range, reliable: false } };
  near(Board.swingMatch({ a: 5, b: 5, c: 5, d: 11, e: -1, f: 5, g: 5 }, ranges), 3 / 5);
  // Numbers with no reading don't count; under 5 to go on: nothing said.
  assert.equal(Board.swingMatch({ a: 5, b: 5, c: null, d: 5, e: 5 }, ranges), null);
  assert.equal(Board.swingMatch(null, ranges), null);
});

test("session: the score is the average of the rule shares", () => {
  const rows = [shotOf(), shotOf({ offline: 20 }), shotOf({ carry: 120 }), shotOf({ smash: 1.2 }), { club: "PT", carry: 3, offline: 0 },
                { club: "I7", carry: null, offline: 0 }];
  const s = Board.session(rows, ctx());
  assert.equal(s.n, 4);
  assert.equal(s.good, 1);
  near(s.skills.line.rate, 3 / 4);
  near(s.skills.distance.rate, 3 / 4);
  near(s.skills.solid.rate, 3 / 4);
  near(s.skills.centred.rate, 1);
  near(s.score, (0.75 + 0.75 + 0.75 + 1) / 4 * 100);
  assert.equal(s.skills.match.rate, null);
  assert.equal(Board.session([], ctx()).score, null);
});

test("board: the latest against last time and the usual; small sessions aren't compared with", () => {
  const good = n => Array.from({ length: n }, () => shotOf());
  const wide = n => Array.from({ length: n }, () => shotOf({ offline: 20 }));
  const sessions = [
    { key: "a", start: 1, rows: [...good(6), ...wide(4)] },     // line 60%: score 90
    { key: "warm", start: 2, rows: wide(3) },                   // too few: not "last time"
    { key: "b", start: 3, rows: [...good(8), ...wide(2)] },     // line 80%: score 95
    { key: "c", start: 4, rows: [...good(5), ...wide(5)] },     // line 50%: score 87.5
  ];
  const b = Board.board(sessions, ctx());
  assert.equal(b.latest.key, "c");
  assert.equal(b.last.key, "b");
  assert.ok(b.enough);
  near(b.score.now, 87.5);
  near(b.score.last, 95);
  near(b.score.usual, 92.5);
  near(b.score.best, 95);
  const line = b.skills.find(s => s.key === "line");
  near(line.now, 0.5); near(line.last, 0.8); near(line.usual, 0.7);
  assert.equal(b.sessions.length, 4);
  assert.equal(Board.board([], ctx()), null);
  assert.equal(Board.board([{ key: "x", start: 1, rows: wide(3) }], ctx()).enough, false);
});

test("records: best score, good shots in a row, longest carry on line, fastest swing; new when set in the latest session", () => {
  const sessions = [
    { key: "a", start: 1, rows: [
      shotOf({ name: "a1", t: 10, clubSpeed: 84 }), shotOf({ name: "a2", t: 11, carry: 165, clubSpeed: 85 }), shotOf({ name: "a3", t: 12 }),
      shotOf({ name: "a4", t: 13, offline: 30, carry: 180 }),                    // long, but nowhere near the line
      shotOf({ name: "a5", t: 14, clubSpeed: 99, smash: 1.05 }),                 // a misread: smash far under usual
      ...Array.from({ length: 5 }, (_, i) => shotOf({ name: "ax" + i, t: 20 + i, offline: 20 })) ] },
    { key: "b", start: 2, rows: Array.from({ length: 9 }, (_, i) => shotOf({ name: "b" + i, t: 100 + i, carry: i === 4 ? 167 : 150, clubSpeed: i === 2 ? 86 : 83 })) },
  ];
  const recs = Board.records(sessions, ctx());
  const by = k => recs.find(r => r.key === k);
  assert.equal(by("score").session, "b");
  near(by("score").value, 100);
  assert.ok(by("score").isNew);
  assert.equal(by("streak").value, 9);
  assert.equal(by("carry").value, 167);
  assert.equal(by("carry").name, "b4");
  assert.equal(by("carry").club, "I7");
  assert.equal(by("speed").value, 86);
  assert.equal(by("speed").name, "b2");
  // With one session nothing is "new".
  assert.ok(Board.records(sessions.slice(0, 1), ctx()).every(r => !r.isNew));
});

test("activity: the calendar, this week against a usual one, weeks in a row", () => {
  const now = new Date(2026, 9, 9, 18, 0).getTime();              // Friday Oct 9 2026
  const at = (m, d, h = 10) => new Date(2026, m, d, h).getTime();
  const sessions = [
    { start: at(9, 9), n: 20 }, { start: at(9, 7), n: 50 }, { start: at(9, 7, 20), n: 10 },   // this week
    { start: at(9, 1), n: 30 },                                                                // last week
    { start: at(8, 25), n: 40 },                                                               // the week before
    { start: at(8, 2), n: 5 },                                                                 // a gap, then an old one
  ];
  const a = Board.activity(sessions, now, 12);
  assert.equal(a.weeks.length, 12);
  assert.equal(a.weeks[11][0].t, new Date(2026, 9, 5).getTime());     // Monday first
  assert.deepEqual(a.week, { swings: 80, sessions: 3 });
  assert.equal(a.weeks[11][2].swings, 60);                            // Wednesday Oct 7: two sessions
  assert.equal(a.weeks[11][2].sessions, 2);
  assert.ok(a.weeks[11][5].future && !a.weeks[11][4].future);
  assert.equal(a.max, 60);
  assert.equal(a.streak, 3);
  assert.deepEqual(a.total, { swings: 155, sessions: 6, days: 5 });
  near(a.usual.swings, 15);                                           // median of 30, 40, 0, 0
  // No session yet this week: the run still counts up to last week.
  assert.equal(Board.activity(sessions.slice(3), now, 12).streak, 2);
  assert.equal(Board.activity([], now, 12).streak, 0);
});

test("strokes: an approach shot is scored against the club's usual carry", () => {
  const s = Strokes.shot(shotOf({ carry: 140, offline: 6 }), BASE);
  assert.equal(s.kind, "approach");
  assert.equal(s.target, 150);
  near(s.sg, Games.scoreShot(150, { carry: 140, offline: 6 }).sg);
  near(s.along, -10); near(s.side, 6);
  assert.ok(s.lossLen > s.lossDir && s.lossDir > 0);
  // On the target: nothing lost either way.
  const dead = Strokes.shot(shotOf(), BASE);
  near(dead.lossDir, 0); near(dead.lossLen, 0);
  assert.ok(dead.sg > s.sg);
  assert.equal(Strokes.shot(shotOf({ carry: 0 }), BASE), null);
  assert.equal(Strokes.shot(shotOf(), null), null);
  assert.equal(Strokes.shot({ club: "PT", carry: 5, offline: 0 }, BASE), null);
});

test("strokes: the driver and fairway woods are tee shots; hybrids and irons approach shots", () => {
  assert.equal(Strokes.kindOf("DR"), "tee");
  assert.equal(Strokes.kindOf("W3"), "tee");
  assert.equal(Strokes.kindOf("H4"), "approach");
  assert.equal(Strokes.kindOf("SW"), "approach");
  assert.equal(Strokes.kindOf("PT"), null);
  const long = Strokes.shot({ club: "DR", carry: 250, offline: 5 }, null), short = Strokes.shot({ club: "DR", carry: 210, offline: 5 }, null);
  const wild = Strokes.shot({ club: "DR", carry: 250, offline: 45 }, null);
  assert.equal(long.kind, "tee");
  assert.ok(long.sg > short.sg && long.sg > wild.sg);
  near(long.sg, Games.scoreDriving(0, { carry: 250, offline: 5 }).sg);
});

test("strokes: a session's average, how far from the target, the misses and each club", () => {
  const rows = [shotOf(), shotOf({ carry: 135, offline: 0 }), shotOf({ carry: 150, offline: -12 }), shotOf({ carry: 162, offline: 10 }),
                { club: "DR", carry: 240, offline: 0 }, { club: "I7", carry: null, offline: 0 }];
  const s = Strokes.session(rows, ctx());
  assert.equal(s.n, 5);
  near(s.sg, s.shots.reduce((a, x) => a + x.sg, 0) / 5);
  assert.deepEqual(s.miss, { n: 4, short: 1, long: 1, left: 1, right: 1, on: 1 });
  near(s.prox, 13.5);                                  // 0, 12, 15, hypot(12, 10): the middle of them
  assert.ok(s.loss.dirShare > 0 && s.loss.dirShare < 1);
  assert.deepEqual(s.byClub.map(c => [c.club, c.kind, c.n]), [["I7", "approach", 4], ["DR", "tee", 1]]);
  assert.equal(s.byClub[1].prox, null);
  assert.equal(Strokes.session([], ctx()).sg, null);
  assert.equal(Strokes.words(-0.418), "0.42 behind");
  assert.equal(Strokes.words(0.1, 1), "0.1 ahead");
  assert.equal(Strokes.words(0.001), "level");
});
