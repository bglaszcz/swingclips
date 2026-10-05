const test = require("node:test");
const assert = require("node:assert/strict");
const PelvisZone = require("../static/pelviszone.js");

function makeSwing(club, pelvisBall, angleOfAttack, faceImpactV) {
  return {
    club,
    body: { pelvisBall },
    shot: {
      clubData: {
        angleOfAttack,
        faceImpactV,
      },
    },
  };
}

test("not enough swings: fewer than 30 total or fewer than 8 best", () => {
  // Empty
  const r0 = PelvisZone.zone([], "I7");
  assert.equal(r0.n, 0);
  assert.equal(r0.best, 0);
  assert.equal(r0.enough, false);
  assert.equal(r0.zone, null);
  assert.equal(r0.need.swings, 30);
  assert.equal(r0.need.best, 8);

  // 29 swings, all best
  const swings29 = [];
  for (let i = 0; i < 29; i++) {
    swings29.push(makeSwing("I7", 1.0, -4.5, -14.0));
  }
  const r29 = PelvisZone.zone(swings29, "I7");
  assert.equal(r29.n, 29);
  assert.equal(r29.best, 29);
  assert.equal(r29.enough, false);
  assert.equal(r29.zone, null);
  assert.equal(r29.need.swings, 1);
  assert.equal(r29.need.best, 0);

  // 35 swings, but only 7 best
  const swings35 = [];
  for (let i = 0; i < 7; i++) {
    swings35.push(makeSwing("I7", 1.0, -4.5, -14.0)); // best
  }
  for (let i = 0; i < 28; i++) {
    swings35.push(makeSwing("I7", 1.0, -1.0, -5.0));  // not best
  }
  const r35 = PelvisZone.zone(swings35, "I7");
  assert.equal(r35.n, 35);
  assert.equal(r35.best, 7);
  assert.equal(r35.enough, false);
  assert.equal(r35.zone, null);
  assert.equal(r35.need.swings, 0);
  assert.equal(r35.need.best, 1);
});

test("failed Square reads skipped; other clubs skipped", () => {
  const swings = [
    makeSwing("I7", 1.0, -4.0, -12.0),
    makeSwing("I7", null, -4.0, -12.0),       // no pelvis
    makeSwing("I7", 1.0, null, -12.0),       // failed attack read
    makeSwing("I7", 1.0, -4.0, null),        // failed strike read
    makeSwing("DR", 1.0, -4.0, -12.0),       // wrong club
    { club: "I7", pelvisBall: 2.0, clubData: { angleOfAttack: -5.0, faceImpactV: -10.0 } }, // alternative shape
  ];
  const r = PelvisZone.zone(swings, "I7");
  assert.equal(r.n, 2);
  assert.equal(r.best, 2);
});

test("zone = q25..q75 of the best; median and r calculated", () => {
  const swings = [];
  // 32 swings: 8 best low-point swings with pelvis values 0, 1, 2, 3, 4, 5, 6, 7
  // and 24 other swings with pelvis = -1, attack = -1 (not best)
  for (let i = 0; i < 8; i++) {
    swings.push(makeSwing("I7", i, -5.0 + i * 0.1, -15.0)); // best (attack between -5.0 and -4.3, strike -15)
  }
  for (let i = 0; i < 24; i++) {
    swings.push(makeSwing("I7", -1.0, -10.0, -5.0)); // not best
  }

  const r = PelvisZone.zone(swings, "I7");
  assert.equal(r.n, 32);
  assert.equal(r.best, 8);
  assert.equal(r.enough, true);
  assert.notEqual(r.zone, null);
  // For [0, 1, 2, 3, 4, 5, 6, 7]:
  // q25: index (7 * 0.25) = 1.75 -> 1 + 0.75 * (2 - 1) = 1.75
  // q75: index (7 * 0.75) = 5.25 -> 5 + 0.25 * (6 - 5) = 5.25
  // median: index (7 * 0.5) = 3.5 -> 3 + 0.5 * (4 - 3) = 3.5
  assert.ok(Math.abs(r.zone.lo - 1.75) < 1e-6);
  assert.ok(Math.abs(r.zone.hi - 5.25) < 1e-6);
  assert.ok(Math.abs(r.median - 3.5) < 1e-6);
  assert.equal(typeof r.r, "number");
  assert.ok(r.r > 0); // positive correlation between pelvis and attack in our synthetic data
});

test("place: in / close / out at the edges", () => {
  const targetZone = { lo: 1.0, hi: 3.0 };

  // Inside
  assert.equal(PelvisZone.place(1.0, targetZone), "in");
  assert.equal(PelvisZone.place(2.0, targetZone), "in");
  assert.equal(PelvisZone.place(3.0, targetZone), "in");

  // Close (within 1.0 in outside zone)
  assert.equal(PelvisZone.place(0.0, targetZone), "close"); // lo - 1.0
  assert.equal(PelvisZone.place(0.5, targetZone), "close");
  assert.equal(PelvisZone.place(3.5, targetZone), "close");
  assert.equal(PelvisZone.place(4.0, targetZone), "close"); // hi + 1.0

  // Out (more than 1.0 in outside zone)
  assert.equal(PelvisZone.place(-0.1, targetZone), "out");
  assert.equal(PelvisZone.place(-2.0, targetZone), "out");
  assert.equal(PelvisZone.place(4.1, targetZone), "out");
  assert.equal(PelvisZone.place(6.0, targetZone), "out");

  // Null or missing
  assert.equal(PelvisZone.place(null, targetZone), "out");
  assert.equal(PelvisZone.place(2.0, null), "out");

  // Colors check: green, amber, gray, never red
  assert.equal(PelvisZone.color("in"), "#22c55e");
  assert.equal(PelvisZone.color("close"), "#f59e0b");
  assert.equal(PelvisZone.color("out"), "#94a3b8");
  assert.equal(PelvisZone.color(2.0, targetZone), "#22c55e");
  assert.equal(PelvisZone.color(0.5, targetZone), "#f59e0b");
  assert.equal(PelvisZone.color(5.0, targetZone), "#94a3b8");
});

test("sentence wording: both sides of the ball and at the ball", () => {
  const calibrated = { enough: true, zone: { lo: 0.5, hi: 2.0 } };
  const uncalibrated = { enough: false, n: 12, best: 3, minTotal: 30, minBest: 8 };

  // Ahead of ball, calibrated
  assert.equal(
    PelvisZone.sentence(0.4, calibrated),
    "Pelvis 0.4 in ahead of the ball at impact. Target: +0.5 to +2.0 in."
  );

  // Behind ball, uncalibrated
  assert.equal(
    PelvisZone.sentence(-2.1, uncalibrated),
    "Pelvis 2.1 in behind the ball at impact. Target: not set yet (12 of 30 swings, 3 of 8 best)."
  );

  // Enough swings, too few best ones: only the best count is still short
  assert.equal(
    PelvisZone.sentence(3.6, { n: 35, minTotal: 30, best: 1, minBest: 8, enough: false, zone: null }),
    "Pelvis 3.6 in ahead of the ball at impact. Target: not set yet (1 of 8 best swings)."
  );

  // At the ball (|v| < 0.05), calibrated
  assert.equal(
    PelvisZone.sentence(0.02, calibrated),
    "Pelvis at the ball at impact. Target: +0.5 to +2.0 in."
  );
  assert.equal(
    PelvisZone.sentence(-0.04, calibrated),
    "Pelvis at the ball at impact. Target: +0.5 to +2.0 in."
  );
  assert.equal(
    PelvisZone.sentence(0.0, calibrated),
    "Pelvis at the ball at impact. Target: +0.5 to +2.0 in."
  );
});
