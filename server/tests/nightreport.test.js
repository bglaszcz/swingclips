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
