// Gapping test suite (static/gapping.js): percentiles, bag order, overlap and big-gap flags,
// minimum-shots rule, mishit filtering, and period gapping analysis.
//
// Run with: node --test tests/gapping.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const Gapping = require("../static/gapping.js");

test("bag order: DR, woods, hybrids, irons, wedges; putter left out", () => {
  // Ranks
  assert.ok(Gapping.bagRank("DR") < Gapping.bagRank("W3"));
  assert.ok(Gapping.bagRank("W3") < Gapping.bagRank("W5"));
  assert.ok(Gapping.bagRank("W5") < Gapping.bagRank("H3"));
  assert.ok(Gapping.bagRank("H3") < Gapping.bagRank("H4"));
  assert.ok(Gapping.bagRank("H4") < Gapping.bagRank("I3"));
  assert.ok(Gapping.bagRank("I3") < Gapping.bagRank("I7"));
  assert.ok(Gapping.bagRank("I7") < Gapping.bagRank("I9"));
  assert.ok(Gapping.bagRank("I9") < Gapping.bagRank("PW"));
  assert.ok(Gapping.bagRank("PW") < Gapping.bagRank("GW"));
  assert.ok(Gapping.bagRank("GW") < Gapping.bagRank("SW"));
  assert.ok(Gapping.bagRank("SW") < Gapping.bagRank("LW"));

  // Putter and empty are excluded (-1)
  assert.equal(Gapping.bagRank("PT"), -1);
  assert.equal(Gapping.bagRank("Putter"), -1);
  assert.equal(Gapping.bagRank(null), -1);
  assert.equal(Gapping.bagRank(""), -1);

  // Sorting
  const unsorted = ["LW", "I7", "DR", "PT", "W5", "PW", "H4", "SW", "W3", "GW", "I4"];
  const sorted = Gapping.sortClubs(unsorted);
  assert.deepEqual(sorted, ["DR", "W3", "W5", "H4", "I4", "I7", "PW", "GW", "SW", "LW"]);

  // Alternate codes: 3W, 4H, 7I
  assert.equal(Gapping.bagRank("3W"), Gapping.bagRank("W3"));
  assert.equal(Gapping.bagRank("4H"), Gapping.bagRank("H4"));
  assert.equal(Gapping.bagRank("7I"), Gapping.bagRank("I7"));
});

test("mishits: shots with no carry or marked invalid by Square are filtered out", () => {
  // Valid shot
  assert.equal(Gapping.isMishit({ ball: { carry: 155.0 } }), false);
  assert.equal(Gapping.validCarry({ ball: { carry: 155.0 } }), 155.0);

  // No shot or empty object
  assert.equal(Gapping.isMishit(null), true);
  assert.equal(Gapping.isMishit({}), true);
  assert.equal(Gapping.isMishit({ ball: null }), true);

  // No carry, zero carry, negative carry
  assert.equal(Gapping.isMishit({ ball: { carry: null } }), true);
  assert.equal(Gapping.isMishit({ ball: { carry: 0 } }), true);
  assert.equal(Gapping.isMishit({ ball: { carry: -5 } }), true);
  assert.equal(Gapping.isMishit({ ball: { carry: NaN } }), true);
  assert.equal(Gapping.validCarry({ ball: { carry: 0 } }), null);

  // Square marked invalid
  assert.equal(Gapping.isMishit({ ball: { carry: 150 }, valid: false }), true);
  assert.equal(Gapping.isMishit({ ball: { carry: 150 }, isValid: false }), true);
  assert.equal(Gapping.isMishit({ ball: { carry: 150 }, invalid: true }), true);
  assert.equal(Gapping.isMishit({ ball: { carry: 150, valid: false } }), true);
  assert.equal(Gapping.isMishit({ ball: { carry: 150, isValid: false } }), true);
  assert.equal(Gapping.isMishit({ ball: { carry: 150, invalid: true } }), true);

  // Unrelated fields (offline, smash, strike) do NOT cause mishit
  assert.equal(Gapping.isMishit({ ball: { carry: 150, side: 40 }, clubData: { smash: 0.9 } }), false);
});

test("minimum-shots rule: at least 5 shots needed for enough = true", () => {
  // Fewer than 5 shots
  const stats4 = Gapping.clubStats([150, 152, 148, 155]);
  assert.equal(stats4.n, 4);
  assert.equal(stats4.enough, false);
  assert.equal(stats4.median, null);

  // Exactly 5 shots
  const stats5 = Gapping.clubStats([150, 152, 148, 155, 151]);
  assert.equal(stats5.n, 5);
  assert.equal(stats5.enough, true);
  assert.equal(stats5.median, 151);

  // More than 5 shots
  const stats7 = Gapping.clubStats([150, 152, 148, 155, 151, 160, 145]);
  assert.equal(stats7.n, 7);
  assert.equal(stats7.enough, true);
});

test("percentiles: median and middle 50% spread (q25, q75) linear interpolation", () => {
  // 5 values: index 0, 1, 2, 3, 4
  // q25: 4 * 0.25 = index 1
  // q50: 4 * 0.50 = index 2
  // q75: 4 * 0.75 = index 3
  const s5 = Gapping.clubStats([140, 145, 150, 155, 160]);
  assert.equal(s5.median, 150);
  assert.equal(s5.q25, 145);
  assert.equal(s5.q75, 155);

  // 6 values: index 0, 1, 2, 3, 4, 5
  // sorted: [100, 110, 120, 130, 140, 150]
  // q25: 5 * 0.25 = 1.25 -> 110 + 0.25*(120 - 110) = 112.5
  // q50: 5 * 0.50 = 2.50 -> 120 + 0.5*(130 - 120) = 125
  // q75: 5 * 0.75 = 3.75 -> 130 + 0.75*(140 - 130) = 137.5
  const s6 = Gapping.clubStats([100, 110, 120, 130, 140, 150]);
  assert.equal(s6.median, 125);
  assert.equal(s6.q25, 112.5);
  assert.equal(s6.q75, 137.5);
});

test("gapping flags: overlap under 7 yd, big gap over 20 yd", () => {
  // Overlap: < 7 yd
  assert.equal(Gapping.gapFlag(6.9), "overlap");
  assert.equal(Gapping.gapFlag(5), "overlap");
  assert.equal(Gapping.gapFlag(0), "overlap");
  assert.equal(Gapping.gapFlag(-3), "overlap"); // shorter club carried further

  // Normal gap: 7 to 20 yd
  assert.equal(Gapping.gapFlag(7), null);
  assert.equal(Gapping.gapFlag(12), null);
  assert.equal(Gapping.gapFlag(15.5), null);
  assert.equal(Gapping.gapFlag(20), null);

  // Big gap: > 20 yd
  assert.equal(Gapping.gapFlag(20.1), "big gap");
  assert.equal(Gapping.gapFlag(25), "big gap");
  assert.equal(Gapping.gapFlag(35), "big gap");

  // Missing
  assert.equal(Gapping.gapFlag(null), null);
  assert.equal(Gapping.gapFlag(undefined), null);
});

test("analyze: full gapping across clubs with period and mishits", () => {
  const baseTime = 1700000000000;
  const swings = [
    // Driver: 6 shots, 1 mishit (no carry), 5 valid: 230, 235, 240, 245, 250 -> med 240
    { club: "DR", t: baseTime + 1000, shot: { ball: { carry: 230 } } },
    { club: "DR", t: baseTime + 2000, shot: { ball: { carry: 235 } } },
    { club: "DR", t: baseTime + 3000, shot: { ball: { carry: 240 } } },
    { club: "DR", t: baseTime + 4000, shot: { ball: { carry: 245 } } },
    { club: "DR", t: baseTime + 5000, shot: { ball: { carry: 250 } } },
    { club: "DR", t: baseTime + 6000, shot: { ball: { carry: 0 } } }, // mishit

    // 3-Wood: 5 shots: 220, 222, 225, 228, 230 -> med 225
    // Gap DR to W3: 240 - 225 = 15 yd (normal)
    { club: "W3", t: baseTime + 10000, shot: { ball: { carry: 220 } } },
    { club: "W3", t: baseTime + 11000, shot: { ball: { carry: 222 } } },
    { club: "W3", t: baseTime + 12000, shot: { ball: { carry: 225 } } },
    { club: "W3", t: baseTime + 13000, shot: { ball: { carry: 228 } } },
    { club: "W3", t: baseTime + 14000, shot: { ball: { carry: 230 } } },

    // 5-Wood: 5 shots: 218, 219, 220, 221, 222 -> med 220
    // Gap W3 to W5: 225 - 220 = 5 yd (< 7 yd -> overlap)
    { club: "W5", t: baseTime + 20000, shot: { ball: { carry: 218 } } },
    { club: "W5", t: baseTime + 21000, shot: { ball: { carry: 219 } } },
    { club: "W5", t: baseTime + 22000, shot: { ball: { carry: 220 } } },
    { club: "W5", t: baseTime + 23000, shot: { ball: { carry: 221 } } },
    { club: "W5", t: baseTime + 24000, shot: { ball: { carry: 222 } } },

    // 4-Iron: 5 shots: 190, 192, 195, 198, 200 -> med 195
    // Gap W5 to I4: 220 - 195 = 25 yd (> 20 yd -> big gap)
    { club: "I4", t: baseTime + 30000, shot: { ball: { carry: 190 } } },
    { club: "I4", t: baseTime + 31000, shot: { ball: { carry: 192 } } },
    { club: "I4", t: baseTime + 32000, shot: { ball: { carry: 195 } } },
    { club: "I4", t: baseTime + 33000, shot: { ball: { carry: 198 } } },
    { club: "I4", t: baseTime + 34000, shot: { ball: { carry: 200 } } },

    // 7-Iron: only 3 shots (fewer than 5) -> not enough shots yet
    { club: "I7", t: baseTime + 40000, shot: { ball: { carry: 150 } } },
    { club: "I7", t: baseTime + 41000, shot: { ball: { carry: 152 } } },
    { club: "I7", t: baseTime + 42000, shot: { ball: { carry: 154 } } },

    // Putter: hit twice -> must be omitted
    { club: "PT", t: baseTime + 50000, shot: { ball: { carry: 10 } } },
    { club: "PT", t: baseTime + 51000, shot: { ball: { carry: 12 } } },

    // Excluded swing
    { club: "I4", t: baseTime + 35000, excluded: true, shot: { ball: { carry: 195 } } },

    // Old swing outside period (before since)
    { club: "PW", t: baseTime - 100000, shot: { ball: { carry: 120 } } },
  ];

  const res = Gapping.analyze(swings, { since: baseTime });
  assert.equal(res.clubs.length, 5); // DR, W3, W5, I4, I7 (PT and PW excluded)

  const [dr, w3, w5, i4, i7] = res.clubs;

  assert.equal(dr.club, "DR");
  assert.equal(dr.n, 5);
  assert.equal(dr.totalShots, 6);
  assert.equal(dr.enough, true);
  assert.equal(dr.median, 240);
  assert.equal(dr.gap, 15);
  assert.equal(dr.gapFlag, null);

  assert.equal(w3.club, "W3");
  assert.equal(w3.enough, true);
  assert.equal(w3.median, 225);
  assert.equal(w3.gap, 5);
  assert.equal(w3.gapFlag, "overlap");

  assert.equal(w5.club, "W5");
  assert.equal(w5.enough, true);
  assert.equal(w5.median, 220);
  assert.equal(w5.gap, 25);
  assert.equal(w5.gapFlag, "big gap");

  assert.equal(i4.club, "I4");
  assert.equal(i4.enough, true);
  assert.equal(i4.median, 195);
  // Next club (i7) has not enough shots, so gap is null
  assert.equal(i4.gap, null);
  assert.equal(i4.gapFlag, null);

  assert.equal(i7.club, "I7");
  assert.equal(i7.n, 3);
  assert.equal(i7.enough, false);
  assert.equal(i7.median, null);
  assert.equal(i7.gap, null);
});
