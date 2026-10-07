// Unit tests for SwingSessionStory (static/sessionstory.js)
// cd server && node --test tests/sessionstory.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const Story = require("../static/sessionstory.js");
const Score = require("../static/sessionscore.js");

function makeContext() {
  let id = 0;
  const clubs = {
    DR: {
      baseline: { carry: 240, smash: 1.48 },
      verdicts: {},
      ranges: {
        hipSlide: { enough: true, reliable: true, q10: 2, q25: 3, q75: 5, q90: 6 },
        bendLoss: { enough: true, reliable: true, q10: 0, q25: 2, q75: 4, q90: 6 },
      },
    },
    I7: {
      baseline: { carry: 150, smash: 1.33 },
      verdicts: {},
      ranges: {
        hipSlide: { enough: true, reliable: true, q10: 2, q25: 3, q75: 5, q90: 6 },
        bendLoss: { enough: true, reliable: true, q10: 0, q25: 2, q75: 4, q90: 6 },
      },
    },
    PW: {
      baseline: { carry: 110, smash: 1.2 },
      verdicts: {},
      ranges: {
        hipSlide: { enough: true, reliable: true, q10: 2, q25: 3, q75: 5, q90: 6 },
        bendLoss: { enough: true, reliable: true, q10: 0, q25: 2, q75: 4, q90: 6 },
      },
    },
    H4: {
      baseline: { carry: 190, smash: 1.4 },
      verdicts: {},
      ranges: {
        hipSlide: { enough: true, reliable: true, q10: 2, q25: 3, q75: 5, q90: 6 },
      },
    },
  };

  function shot(club, good, extras = {}) {
    const b = clubs[club].baseline;
    const name = `s${id++}`;
    clubs[club].verdicts[name] = { good, fails: good ? [] : ["offline"] };
    return {
      name,
      club,
      carry: good ? b.carry : b.carry * 0.8,
      offline: good ? 1 : 0.2 * b.carry,
      smash: good ? b.smash + 0.01 : b.smash - 0.1,
      trust: extras.trust || {},
      shown: extras.shown || {},
      ...extras,
    };
  }

  return { clubs, shot, ctx: { clubs, name: r => r.name } };
}

test("headline matches compare", () => {
  const { shot, ctx } = makeContext();
  const earlier1 = {
    start: 1000,
    rows: Array.from({ length: 20 }, () => shot("I7", false)),
  };
  const session = {
    start: 2000,
    rows: Array.from({ length: 20 }, () => shot("I7", true)),
  };

  const st = Story.story(session, [earlier1], ctx);
  const cmp = Score.compare([earlier1, session], ctx);
  assert.equal(st.headline, cmp.headline);
  assert.match(st.headline, /^Better than last time/);
});

test("clubs: sorted by bag order, best and worst club notes in plain words", () => {
  const { shot, ctx } = makeContext();
  // Session with:
  // PW: 4 shots, 3 good (75%)
  // DR: 3 shots, 1 good (33%)
  // I7: 11 shots, 10 good (91%) - best club
  // H4: 11 shots, 1 good (9%) - worst club
  const rows = [
    ...Array.from({ length: 3 }, () => shot("PW", true)),
    shot("PW", false),
    shot("DR", true),
    ...Array.from({ length: 2 }, () => shot("DR", false)),
    ...Array.from({ length: 10 }, () => shot("I7", true)),
    shot("I7", false),
    shot("H4", true),
    ...Array.from({ length: 10 }, () => shot("H4", false)),
  ];

  const st = Story.story({ start: 1, rows }, [], ctx);
  assert.equal(st.clubs.length, 4);

  // Bag order: Driver (100) -> 4 hybrid (300) -> 7 iron (400) -> PW (500)
  assert.deepEqual(st.clubs.map(c => c.club), ["DR", "H4", "I7", "PW"]);

  // Best club is 7 iron (91%)
  const i7 = st.clubs.find(c => c.club === "I7");
  assert.equal(i7.note, "your best club today: 91% good with the 7 iron");

  // Worst club is 4 hybrid (9%)
  const h4 = st.clubs.find(c => c.club === "H4");
  assert.equal(h4.note, "the 4 hybrid struggled: 1 good of 11");

  // Middle clubs have empty note
  const pw = st.clubs.find(c => c.club === "PW");
  assert.equal(pw.note, "");
  const dr = st.clubs.find(c => c.club === "DR");
  assert.equal(dr.note, "");
});

test("clubs: clubs with fewer than 3 judged shots are left out; single club gets best note only", () => {
  const { shot, ctx } = makeContext();
  const rows = [
    shot("DR", true),
    shot("DR", false), // only 2 DR shots -> filtered out
    ...Array.from({ length: 5 }, () => shot("I7", true)), // 5 I7 shots -> single club
  ];

  const st = Story.story({ start: 1, rows }, [], ctx);
  assert.equal(st.clubs.length, 1);
  assert.equal(st.clubs[0].club, "I7");
  assert.equal(st.clubs[0].note, "your best club today: 100% good with the 7 iron");
});

test("best swing: picks good shot with the most in-range numbers, tie breaks to later swing", () => {
  const { shot, ctx } = makeContext();
  // Ranges for I7: hipSlide [3, 5], bendLoss [2, 4]
  // Swing 1: good shot, 1 number in range (hipSlide = 4), 1 out (bendLoss = 10)
  const s1 = shot("I7", true, {
    hipSlide: 4,
    bendLoss: 10,
    trust: { hipSlide: { level: "ok" }, bendLoss: { level: "ok" } },
  });
  // Swing 2: miss shot, both in range (must not be picked because it's a miss!)
  const s2 = shot("I7", false, {
    hipSlide: 4,
    bendLoss: 3,
    trust: { hipSlide: { level: "ok" }, bendLoss: { level: "ok" } },
  });
  // Swing 3: good shot, both in range
  const s3 = shot("I7", true, {
    hipSlide: 4,
    bendLoss: 3,
    trust: { hipSlide: { level: "ok" }, bendLoss: { level: "ok" } },
  });
  // Swing 4: good shot, both in range (tie with s3, later swing wins!)
  const s4 = shot("I7", true, {
    hipSlide: 4,
    bendLoss: 3,
    trust: { hipSlide: { level: "ok" }, bendLoss: { level: "ok" } },
  });
  // Swing 5: good shot, 1 in range, but bendLoss is shaky (shaky does not count!)
  const s5 = shot("I7", true, {
    hipSlide: 4,
    bendLoss: 3,
    trust: { hipSlide: { level: "ok" }, bendLoss: { level: "shaky" } },
  });

  const st = Story.story({ start: 1, rows: [s1, s2, s3, s4, s5] }, [], ctx);
  assert.ok(st.best);
  assert.equal(st.best.name, s4.name);
  assert.ok(typeof st.best.why === "string");
});

test("best swing: null when no good shots in session", () => {
  const { shot, ctx } = makeContext();
  const rows = [shot("I7", false), shot("I7", false)];
  const st = Story.story({ start: 1, rows }, [], ctx);
  assert.equal(st.best, null);
});

test("fault: top fault returns plain thought and drill; null when none is top", () => {
  const { shot, ctx } = makeContext();
  // FAULTS earlyExtension: key earlyExt, test v => v > 2.5
  // sessionFaults requires at least 3 swings and 25% share to be top.
  const rowsWithFault = [
    shot("I7", true, { earlyExt: 3.5, trust: { earlyExt: { level: "ok" } } }),
    shot("I7", true, { earlyExt: 3.2, trust: { earlyExt: { level: "ok" } } }),
    shot("I7", true, { earlyExt: 3.8, trust: { earlyExt: { level: "ok" } } }),
    shot("I7", false, { earlyExt: 1.0, trust: { earlyExt: { level: "ok" } } }),
  ];

  const st1 = Story.story({ start: 1, rows: rowsWithFault }, [], ctx);
  assert.ok(st1.fault);
  assert.equal(st1.fault.name, "early extension");
  assert.equal(st1.fault.count, 3);
  assert.equal(st1.fault.readable, 4);
  assert.ok(st1.fault.thought.length > 0);
  assert.ok(st1.fault.drill.length > 0);

  // When no fault meets threshold:
  const rowsNoFault = [
    shot("I7", true, { earlyExt: 1.0, trust: { earlyExt: { level: "ok" } } }),
    shot("I7", true, { earlyExt: 1.2, trust: { earlyExt: { level: "ok" } } }),
    shot("I7", true, { earlyExt: 1.1, trust: { earlyExt: { level: "ok" } } }),
  ];
  const st2 = Story.story({ start: 1, rows: rowsNoFault }, [], ctx);
  assert.equal(st2.fault, null);
});

test("no P[1-8] in any text across the whole story", () => {
  const { shot, ctx } = makeContext();
  const rows = [
    shot("I7", true, {
      earlyExt: 3.5,
      hipSlide: 4,
      bendLoss: 3,
      trust: { earlyExt: { level: "ok" }, hipSlide: { level: "ok" }, bendLoss: { level: "ok" } },
    }),
    shot("I7", true, {
      earlyExt: 3.5,
      hipSlide: 4,
      bendLoss: 3,
      trust: { earlyExt: { level: "ok" }, hipSlide: { level: "ok" }, bendLoss: { level: "ok" } },
    }),
    shot("I7", true, {
      earlyExt: 3.5,
      hipSlide: 4,
      bendLoss: 3,
      trust: { earlyExt: { level: "ok" }, hipSlide: { level: "ok" }, bendLoss: { level: "ok" } },
    }),
  ];

  const st = Story.story({ start: 1, rows }, [], ctx);
  const pRegex = /\bP[1-8]\b/;
  assert.doesNotMatch(st.headline, pRegex);
  for (const c of st.clubs) {
    assert.doesNotMatch(c.note, pRegex);
  }
  if (st.best) {
    assert.doesNotMatch(st.best.why, pRegex);
  }
  if (st.fault) {
    assert.doesNotMatch(st.fault.thought, pRegex);
    assert.doesNotMatch(st.fault.drill, pRegex);
  }
});
