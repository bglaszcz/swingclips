// Every club's spread and Flights by club (static/clubspread.js): colours, mishits, the ring, the table numbers,
// and flights that land where Square said.
//
// Run with: node --test tests/clubspread.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const CS = require("../static/clubspread.js");

// A seeded random so the tests are the same every run.
function rng(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}
function normal(r) {
  return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}
const shot = (club, carry, offline, more = {}) => ({
  name: `${club}-${carry}-${offline}`, club, carry, offline, t: 0,
  c: { shot: { club, ball: { carry, side: offline, ...more.ball } } }, ...more.row,
});

test("colours: bag order, the same club the same colour, a ninth club hollow", () => {
  const clubs = ["PW", "I7", "DR", "W3", "H4", "I5", "I6", "I8", "I9", "GW", "SW"];
  const c = CS.colors(clubs);
  assert.equal(c.DR.slot, 0);
  assert.equal(c.W3.slot, 1);
  assert.equal(c.I7.slot, 5);
  assert.equal(c.I9.alt, false);
  assert.equal(c.PW.slot, 0);
  assert.equal(c.PW.alt, true);
  // Neighbours in the bag never share a colour.
  const order = CS.bagOrder(clubs);
  for (let i = 1; i < order.length; i++) assert.notEqual(c[order[i]].slot, c[order[i - 1]].slot);
  // A club's colour doesn't depend on the order it's listed in.
  assert.deepEqual(CS.colors([...clubs].reverse()), c);
});

test("mishits and shots with no landing spot are left out", () => {
  const rows = [shot("I7", 150, 2), shot("I7", 0, 0), shot("I7", 140, null),
                { ...shot("I7", 145, 1), c: { shot: { club: "I7", valid: false, ball: { carry: 145 } } } }];
  const m = CS.analyze(rows);
  assert.equal(m.clubs[0].n, 1);
});

test("the ring holds about two shots in three", () => {
  const r = rng(7), rows = [];
  for (let i = 0; i < 3000; i++) rows.push(shot("I7", 150 + 6 * normal(r), 8 * normal(r) - 3));
  const c = CS.analyze(rows).clubs[0];
  const e = c.ring;
  const inside = rows.filter(s => {
    const dx = s.offline - e.cx, dy = s.carry - e.cy;
    const u = dx * Math.cos(e.th) + dy * Math.sin(e.th), v = -dx * Math.sin(e.th) + dy * Math.cos(e.th);
    return (u / e.a) ** 2 + (v / e.b) ** 2 <= 1;
  }).length / rows.length;
  assert.ok(inside > 0.63 && inside < 0.70, `inside ${inside}`);
  assert.ok(Math.abs(e.cx + 3) < 0.5 && Math.abs(e.cy - 150) < 0.5);
});

test("table numbers: middle 80%, centre, lean; a club with too few shots has none", () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(shot("I7", 140 + 2 * i, -10 + i));   // carry 140..158, side -10..-1
  rows.push(shot("DR", 230, 5));
  const m = CS.analyze(rows);
  const i7 = m.clubs.find(c => c.club === "I7"), dr = m.clubs.find(c => c.club === "DR");
  assert.equal(m.clubs[0].club, "DR");
  assert.ok(Math.abs(i7.carry.mid - 149) < 1e-9);
  assert.ok(Math.abs(i7.carry.lo - 141.8) < 1e-9 && Math.abs(i7.carry.hi - 156.2) < 1e-9);
  assert.equal(i7.leftPct, 1);
  assert.equal(CS.leanWords(i7), "100% left");
  assert.equal(CS.sideWords(i7.side.mid), "6 yd left");
  assert.equal(dr.enough, false);
  assert.equal(dr.ring, null);
  assert.equal(m.widest, null);   // only one club with enough shots
});

test("widest and tightest are judged against each club's length", () => {
  const r = rng(3), rows = [];
  for (let i = 0; i < 40; i++) rows.push(shot("DR", 240 + 8 * normal(r), 12 * normal(r)));   // ~12% of carry
  for (let i = 0; i < 40; i++) rows.push(shot("PW", 110 + 4 * normal(r), 9 * normal(r)));    // ~21% of carry
  const m = CS.analyze(rows);
  assert.equal(m.widest.club, "PW");
  assert.equal(m.tightest.club, "DR");
});

test("one wild shot is drawn but kept out of the ring", () => {
  const r = rng(11), rows = [];
  for (let i = 0; i < 30; i++) rows.push(shot("I7", 150 + 4 * normal(r), 5 * normal(r)));
  rows.push(shot("I7", 60, 45));
  const c = CS.analyze(rows).clubs[0];
  assert.equal(c.far.length, 1);
  assert.ok(c.ring.a < 15, `ring ${c.ring.a}`);
});

test("a flight lands where Square said, as high as its apex", () => {
  const r = shot("I7", 153.7, -10.1, { ball: { speed: 108.6, vla: 18.13, hla: -0.34, totalSpin: 5677, spinAxis: -7.11, apexFt: 80 } });
  Object.assign(r, { ballSpeed: 108.6, launch: 18.13, direction: -0.34, spin: 5677, spinAxis: -7.11 });
  const f = CS.flight(r);
  const end = f.pts[f.pts.length - 1];
  assert.ok(Math.abs(Math.hypot(end[0], end[2]) - 153.7) < 0.05, `carry ${Math.hypot(end[0], end[2])}`);
  assert.ok(Math.abs(end[2] + 10.1) < 1e-6);
  assert.ok(Math.abs(Math.max(...f.pts.map(p => p[1])) - 80) < 0.5);
  assert.ok(Math.abs(end[1]) < 1e-6);
  assert.equal(f.pts[0][0], 0);
});

test("a session's flights: clubs in bag order, unflyable shots counted", () => {
  const mk = (club, carry) => Object.assign(shot(club, carry, 0), { ballSpeed: carry * 0.75, launch: 15, direction: 0, spin: 4000, spinAxis: 0 });
  const rows = [mk("I7", 150), mk("DR", 240), mk("I7", 152), shot("I9", 130, 0)];
  const s = CS.sessionFlights(rows);
  assert.deepEqual(s.clubs.map(c => c.club), ["DR", "I7"]);
  assert.equal(s.clubs[1].n, 2);
  assert.equal(s.skipped, 1);
  assert.equal(s.flights.length, 3);
});

test("one number, every club: quantiles per club in bag order, mishits left out for shot numbers", () => {
  const rows = [];
  for (let i = 0; i < 11; i++) rows.push(Object.assign(shot("I7", 150, 0), { spin: 6000 + 100 * i }));
  for (let i = 0; i < 6; i++) rows.push(Object.assign(shot("DR", 230, 0), { spin: 2500 + 50 * i }));
  rows.push(Object.assign(shot("I7", 0, 0), { spin: 99999 }));       // a mishit
  rows.push(Object.assign(shot("PW", 110, 0), { spin: 9000 }));      // too few
  const m = CS.analyzeNumber(rows, "spin", { shot: true });
  assert.deepEqual(m.clubs.map(c => c.club), ["DR", "I7", "PW"]);
  const i7 = m.clubs[1];
  assert.equal(i7.n, 11);
  assert.equal(i7.q50, 6500);
  assert.equal(i7.q10, 6100);
  assert.equal(m.clubs[2].enough, false);
  assert.equal(m.flips.length, 0);
});

test("one number, every club: a club out of the bag's order is named only when it's clear", () => {
  const r = rng(5), rows = [];
  const add = (club, n, med, sd) => { for (let i = 0; i < n; i++) rows.push(Object.assign(shot(club, med + sd * normal(r), 0), {})); };
  add("I5", 40, 166, 8);
  add("I6", 40, 176, 8);   // carries 10 yd further than the 5 iron: out of order
  add("I7", 40, 160, 8);
  const m = CS.analyzeNumber(rows, "carry", { shot: true });
  assert.equal(m.flips.length, 1);
  assert.equal(m.flips[0].a, "I5");
  assert.equal(m.flips[0].b, "I6");
  // Two clubs 1 yd apart the wrong way, 10 shots each: chance, not named.
  const r2 = rng(9), close = [];
  for (let i = 0; i < 10; i++) close.push(shot("I8", 140 + 8 * normal(r2), 0), shot("I9", 141 + 8 * normal(r2), 0));
  assert.equal(CS.analyzeNumber(close, "carry", { shot: true }).flips.length, 0);
});

test("one number, every club: body numbers keep swings whatever the shot, numbers with no order aren't judged", () => {
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push({ club: "I7", name: `a${i}`, tempo: 2.8 + 0.1 * i, carry: null, offline: null });
  for (let i = 0; i < 6; i++) rows.push({ club: "DR", name: `b${i}`, tempo: 3.2 + 0.2 * i, carry: null, offline: null });
  const m = CS.analyzeNumber(rows, "tempo");
  assert.equal(m.clubs.length, 2);
  assert.equal(m.way, 0);
  assert.equal(m.widest.club, "DR");
  assert.equal(m.narrowest.club, "I7");
});

test("one number, every club: a hybrid launching higher than the next iron isn't named", () => {
  const r = rng(13), rows = [];
  for (let i = 0; i < 40; i++) rows.push(Object.assign(shot("H4", 180, 0), { launch: 19 + normal(r) }));
  for (let i = 0; i < 40; i++) rows.push(Object.assign(shot("I5", 170, 0), { launch: 15 + normal(r) }));
  for (let i = 0; i < 40; i++) rows.push(Object.assign(shot("I6", 160, 0), { launch: 13 + normal(r) }));   // lower than the 5 iron
  const m = CS.analyzeNumber(rows, "launch", { shot: true });
  assert.deepEqual(m.flips.map(x => [x.a, x.b]), [["I5", "I6"]]);
});
