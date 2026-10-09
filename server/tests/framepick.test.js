// Frame picker helper tests (server/static/framepick.js)
//
//   node --test tests/framepick.test.js

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  labelEvent,
  nightTime,
  newLabelDoc,
  mergePick,
  pickSource,
  frameDiff,
  filterDisagreements,
  nightBroken,
  todaysSet,
  tally,
} = require("../static/framepick.js");

test("labelEvent: maps key position names to label event names, skips p1", () => {
  assert.equal(labelEvent("p7"), "impact");
  assert.equal(labelEvent("impact"), "impact");
  assert.equal(labelEvent("takeaway"), "takeaway");
  assert.equal(labelEvent("p2"), "p2");
  assert.equal(labelEvent("p3"), "p3");
  assert.equal(labelEvent("p4"), "p4");
  assert.equal(labelEvent("p5"), "p5");
  assert.equal(labelEvent("p6"), "p6");
  assert.equal(labelEvent("p8"), "p8");

  // Address (p1) is not in label files
  assert.equal(labelEvent("p1"), null);
  assert.equal(labelEvent("unknown"), null);
  assert.equal(labelEvent(""), null);
  assert.equal(labelEvent(null), null);
});

test("nightTime: calculates night pass time from server time and ms difference", () => {
  assert.equal(nightTime(1.5, 25), 1.525);
  assert.equal(nightTime(2.0, -12.5), 1.9875);
  assert.equal(nightTime(1.7136, 0), 1.7136);
  assert.equal(nightTime(1.0, null), 1.0);
});

test("newLabelDoc: creates standard schema 1 document structure", () => {
  const clip = { name: "swing_face.mp4", angle: "face", strike: 1.45, excluded: false };
  const partner = { name: "swing_dtl.mp4", angle: "dtl", strike: 1.45 };

  const doc = newLabelDoc(clip, partner);
  assert.equal(doc.schema, 1);
  assert.deepEqual(doc.clip, { name: "swing_face.mp4", angle: "face", strike: 1.45 });
  assert.deepEqual(doc.partner, { name: "swing_dtl.mp4", angle: "dtl", strike: 1.45 });
  assert.deepEqual(doc.events, {});
  assert.deepEqual(doc.picked, {});

  // Lone clip without partner
  const loneDoc = newLabelDoc(clip, null);
  assert.equal(loneDoc.partner, null);
});

test("mergePick: adds event time and source without touching other events or fields", () => {
  const existingDoc = {
    schema: 1,
    clip: { name: "swing.mp4", angle: "face", strike: null },
    partner: null,
    events: {
      takeaway: 0.986944,
      impact: 2.236244,
    },
    picked: {
      takeaway: "server",
    },
    ball: { x: 0.55, y: 0.88 },
    frames: {
      "0.000000": { l_shoulder: { x: 0.64, y: 0.48 } },
    },
    pass: 1,
  };

  const updated = mergePick(existingDoc, "p4", 1.71360012, "night");

  // Non-destructive: original object unchanged
  assert.equal(existingDoc.events.p4, undefined);
  assert.equal(existingDoc.picked.p4, undefined);

  // New values merged
  assert.equal(updated.events.p4, 1.7136);
  assert.equal(updated.picked.p4, "night");

  // Existing events preserved
  assert.equal(updated.events.takeaway, 0.986944);
  assert.equal(updated.events.impact, 2.236244);
  assert.equal(updated.picked.takeaway, "server");

  // Other fields intact
  assert.deepEqual(updated.ball, { x: 0.55, y: 0.88 });
  assert.ok(updated.frames["0.000000"]);
  assert.equal(updated.pass, 1);
});

test("pickSource: identifies server, night, onset, or adjusted", () => {
  const refs = { serverT: 1.7136, nightT: 1.7386, onsetT: 0.95 };

  // Exact or near matches
  assert.equal(pickSource(1.7136, refs), "server");
  assert.equal(pickSource(1.7136002, refs), "server");
  assert.equal(pickSource(1.7386, refs), "night");
  assert.equal(pickSource(0.95, refs), "onset");

  // Stepped away
  assert.equal(pickSource(1.717767, refs), "adjusted");
  assert.equal(pickSource(1.742767, refs), "adjusted");
  assert.equal(pickSource(1.0, refs), "adjusted");
});

test("frameDiff: formats difference in frames correctly", () => {
  assert.equal(frameDiff(1.0, 1.025, 240), "6 frames apart");
  assert.equal(frameDiff(1.0, 1.004166, 240), "1 frame apart");
  assert.equal(frameDiff(1.0, 1.0, 240), "0 frames apart");
  assert.equal(frameDiff(1.025, 1.0, 240), "6 frames apart");
});

test("filterDisagreements: drops only labeled (clip, position) pairs and skips p1", () => {
  const clips = [
    { name: "swing_face.mp4", angle: "face", partner: "swing_dtl.mp4" },
    { name: "swing_dtl.mp4", angle: "dtl", partner: "swing_face.mp4" },
    { name: "swing_exc.mp4", angle: "face", partner: null, excluded: true },
  ];

  const nightSwings = {
    "swing_face.mp4": {
      face: {
        ms: { p1: 20.0, takeaway: 30.0, p4: 40.0 },
        t: { p1: 0.5, takeaway: 1.0, p4: 1.5 },
      },
      dtl: {
        ms: { p7: 25.0 },
        t: { p7: 2.0 },
      },
    },
    "swing_exc.mp4": {
      face: {
        ms: { p4: 50.0 },
        t: { p4: 1.6 },
      },
    },
  };

  // Case 1: No labels yet -> p1 is skipped, p4 (40ms) is worse than takeaway (30ms)
  let rows = filterDisagreements(nightSwings, clips, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].c.name, "swing_face.mp4");
  assert.equal(rows[0].key, "p4");
  assert.equal(rows[0].ms, 40.0);

  // Case 2: p4 is labeled on face -> p4 dropped, next worst (takeaway 30ms) is listed
  const labelRows = [
    { clip: "swing_face.mp4", pass: 1, missing: ["takeaway", "p2", "p3", "p5", "p6", "impact", "p8"], events: 1 },
  ];
  rows = filterDisagreements(nightSwings, clips, labelRows);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, "takeaway");
  assert.equal(rows[0].ms, 30.0);

  // Case 3: takeaway also labeled on face -> only impact (p7) on dtl remains
  labelRows[0].missing = ["p2", "p3", "p5", "p6", "impact", "p8"]; // takeaway now labeled
  rows = filterDisagreements(nightSwings, clips, labelRows);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].angle, "dtl");
  assert.equal(rows[0].key, "p7");

  // Case 4: dtl clip also has impact labeled -> nothing left
  labelRows.push({ clip: "swing_dtl.mp4", pass: 1, missing: ["takeaway", "p2", "p3", "p4", "p5", "p6", "p8"], events: 1 });
  rows = filterDisagreements(nightSwings, clips, labelRows);
  assert.equal(rows.length, 0);
});

test("filterDisagreements: skips disagreements on camera angles that do not exist", () => {
  const clips = [
    { name: "swing_solo_face.mp4", angle: "face", partner: null, excluded: false },
  ];
  const nightSwings = {
    "swing_solo_face.mp4": {
      dtl: {
        ms: { p7: 25.0 },
        t: { p7: 2.0 },
      },
    },
  };
  const rows = filterDisagreements(nightSwings, clips, []);
  assert.equal(rows.length, 0);
});

test("nightBroken: detects inverted or equal night pass timestamps in swing order", () => {
  assert.equal(nightBroken(null), false);
  assert.equal(nightBroken({}), false);

  // Normal order
  const normal = {
    ms: { takeaway: 0, p2: 10, p3: 20, p4: 0, p5: 0, p6: 0, p7: 0, p8: 0 },
    t: { takeaway: 1.0, p2: 1.2, p3: 1.4, p4: 1.8, p5: 2.0, p6: 2.1, p7: 2.2, p8: 2.3 },
  };
  assert.equal(nightBroken(normal), false);

  // Multi-angle object with normal face and broken dtl (p2 after p3)
  const multi = {
    face: normal,
    dtl: {
      ms: { p2: 500, p3: 0 }, // p2 night time = 1.2 + 0.5 = 1.7s, p3 night time = 1.4s (inverted!)
      t: { p2: 1.2, p3: 1.4 },
    },
  };
  assert.equal(nightBroken(multi), true);

  // Equal timestamps (not strictly increasing)
  const equalTimes = {
    ms: { p4: 0, p5: 0 },
    t: { p4: 1.8, p5: 1.8 },
  };
  assert.equal(nightBroken(equalTimes), true);

  // Partial positions still in order
  const partial = {
    ms: { takeaway: 0, p4: 10, p7: -10 },
    t: { takeaway: 1.0, p4: 1.8, p7: 2.2 },
  };
  assert.equal(nightBroken(partial), false);
});

test("todaysSet: prioritizes big disagreements and takes a balanced sample across sessions/clubs", () => {
  const mkRow = (name, key, ms, day, club) => ({
    c: { name, recorded: `${day}T12:00:00`, club },
    angle: "face",
    key,
    ms,
    t: 1.5,
  });

  const rows = [
    // Big ones (>= 50ms)
    mkRow("s1", "p4", 65, "2026-10-01", "7I"),
    mkRow("s2", "p4", -80, "2026-10-02", "7I"),
    mkRow("s3", "takeaway", 55, "2026-10-01", "DR"),

    // Small ones (< 50ms) for takeaway
    mkRow("s4", "takeaway", 30, "2026-10-01", "7I"),
    mkRow("s5", "takeaway", 28, "2026-10-01", "7I"), // duplicate session/club
    mkRow("s6", "takeaway", 25, "2026-10-02", "7I"), // different session
    mkRow("s7", "takeaway", 22, "2026-10-01", "DR"), // different club
    mkRow("s8", "takeaway", 20, "2026-10-03", "5I"), // different session & club

    // Small ones for p4
    mkRow("s9", "p4", 45, "2026-10-01", "7I"),
    mkRow("s10", "p4", 40, "2026-10-02", "7I"),

    // Small ones for p2
    mkRow("s11", "p2", 20, "2026-10-01", "7I"),
    mkRow("s12", "p2", 18, "2026-10-02", "7I"),
  ];

  // Case 1: No previous picks -> big ones first (worst first: -80, 65, 55), then small
  const res1 = todaysSet(rows, [], { max: 10, perPosition: 3 });
  assert.equal(res1[0].c.name, "s2"); // |ms| = 80
  assert.equal(res1[1].c.name, "s1"); // |ms| = 65
  assert.equal(res1[2].c.name, "s3"); // |ms| = 55

  // Big ones are 3. Max is 10, so 7 small slots.
  assert.equal(res1.length, 10);

  // Takeaway balanced sample should prefer diverse session/club (s4, s6, s7) over duplicate (s5)
  const takeawaySmall = res1.filter(r => r.key === "takeaway" && Math.abs(r.ms) < 50);
  const takeawayNames = takeawaySmall.map(r => r.c.name);
  assert.equal(takeawayNames.includes("s4"), true);
  assert.equal(takeawayNames.includes("s6"), true);
  assert.equal(takeawayNames.includes("s7"), true);
  assert.equal(takeawayNames.includes("s5"), false); // s5 had duplicate 2026-10-01_7I

  // Case 2: p4 already has 12 picks -> p4 small ones excluded, but big p4 (s1, s2) remain!
  const pickedDocs = Array.from({ length: 12 }, () => ({
    picked: { p4: "night" },
  }));
  const res2 = todaysSet(rows, pickedDocs, { max: 20 });
  const p4InRes2 = res2.filter(r => r.key === "p4");
  assert.equal(p4InRes2.length, 2); // only s1 and s2 (big ones)
  assert.equal(p4InRes2[0].c.name, "s2");
  assert.equal(p4InRes2[1].c.name, "s1");

  // Case 3: More big rows than max cap -> all big rows returned, 0 small rows added
  const bigOnly = [
    mkRow("b1", "p4", 90, "2026-10-01", "7I"),
    mkRow("b2", "p4", 80, "2026-10-01", "7I"),
    mkRow("b3", "p4", 70, "2026-10-01", "7I"),
    mkRow("sm1", "p2", 20, "2026-10-01", "7I"),
  ];
  const res3 = todaysSet(bigOnly, [], { max: 2 });
  assert.equal(res3.length, 3); // all 3 big rows included
  assert.equal(res3.every(r => Math.abs(r.ms) >= 50), true);
});

test("tally: counts picks by position, angle, and source, with plain-words summary sentence", () => {
  // Empty or null
  const emptyRes = tally(null);
  assert.equal(emptyRes.totalPicks, 0);
  assert.equal(emptyRes.summary, "too few picks yet");

  const docs = [
    // P4 picks (12 total: 9 night, 3 server)
    ...Array.from({ length: 6 }, () => ({
      clip: { name: "c_face.mp4", angle: "face" },
      picked: { p4: "night" },
    })),
    ...Array.from({ length: 3 }, () => ({
      clip: { name: "c_dtl.mp4", angle: "dtl" },
      picked: { p4: "night" },
    })),
    ...Array.from({ length: 2 }, () => ({
      clip: { name: "c_face.mp4", angle: "face" },
      picked: { p4: "server" },
    })),
    {
      clip: { name: "c_dtl.mp4", angle: "dtl" },
      picked: { p4: "server" },
    },

    // Takeaway picks (17 total: 14 server, 2 night, 1 onset)
    ...Array.from({ length: 14 }, () => ({
      clip: { name: "c_face.mp4", angle: "face" },
      picked: { takeaway: "server" },
    })),
    ...Array.from({ length: 2 }, () => ({
      clip: { name: "c_dtl.mp4", angle: "dtl" },
      picked: { takeaway: "night" },
    })),
    {
      clip: { name: "c_face.mp4", angle: "face" },
      picked: { takeaway: "onset" },
    },

    // P2 picks (4 total: < 5 picks, so not in sentence)
    {
      clip: { name: "c_face.mp4", angle: "face" },
      picked: { p2: "adjusted" },
    },
    ...Array.from({ length: 3 }, () => ({
      clip: { name: "c_face.mp4", angle: "face" },
      picked: { p2: "server" },
    })),
  ];

  const res = tally(docs);
  assert.equal(res.totalPicks, 12 + 17 + 4);

  // P4 breakdown
  assert.equal(res.positions.p4.total, 12);
  assert.equal(res.positions.p4.night, 9);
  assert.equal(res.positions.p4.server, 3);
  assert.equal(res.positions.p4.byAngle.face.night, 6);
  assert.equal(res.positions.p4.byAngle.dtl.night, 3);

  // Takeaway breakdown
  assert.equal(res.positions.takeaway.total, 17);
  assert.equal(res.positions.takeaway.server, 14);
  assert.equal(res.positions.takeaway.night, 2);
  assert.equal(res.positions.takeaway.onset, 1);

  // P2 breakdown (< 5)
  assert.equal(res.positions.p2.total, 4);

  // Plain-words sentence: Takeaway (server won 14 of 17) and P4 (night pass won 9 of 12)
  assert.equal(res.summary, "Takeaway: the server won 14 of 17. P4: the night pass won 9 of 12.");
});

test("loadRow: discards stale response if row changed or closed while fetching", async () => {
  const origDoc = global.document;
  const origFetch = global.fetch;
  const origImage = global.Image;

  global.Image = class { constructor() {} };
  global.document = {
    addEventListener: () => {},
    getElementById: () => ({
      hidden: false,
      replaceChildren: () => {},
      scrollIntoView: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      appendChild: () => {},
      addEventListener: () => {},
      append: () => {}
    }),
    createElement: () => ({
      className: "",
      textContent: "",
      appendChild: () => {},
      replaceChildren: () => {},
      addEventListener: () => {},
      append: () => {}
    })
  };

  let resolveA;
  const promiseA = new Promise(r => { resolveA = r; });

  global.fetch = async (url) => {
    if (url.includes("clipA")) {
      await promiseA;
      return { ok: true, json: async () => ({ schema: 1, events: { takeaway: 1.0 } }) };
    }
    return { ok: true, json: async () => ({ schema: 1, events: { takeaway: 2.0 } }) };
  };

  const { loadRow, getCurrentRow, getCurrentDoc, close } = require("../static/framepick.js");

  const rowA = { key: "takeaway", t: 1.0, ms: 10, c: { name: "clipA.mp4" } };
  const rowB = { key: "takeaway", t: 2.0, ms: 20, c: { name: "clipB.mp4" } };

  try {
    const pA = loadRow(rowA);
    const pB = loadRow(rowB);
    await pB;

    assert.equal(getCurrentRow(), rowB);
    assert.equal(getCurrentDoc().events.takeaway, 2.0);

    // Now resolve slow rowA - it must not overwrite rowB
    resolveA();
    await pA;

    assert.equal(getCurrentRow(), rowB);
    assert.equal(getCurrentDoc().events.takeaway, 2.0);

    // Also verify when closed
    let resolveC;
    const promiseC = new Promise(r => { resolveC = r; });
    global.fetch = async () => {
      await promiseC;
      return { ok: true, json: async () => ({ schema: 1, events: { takeaway: 3.0 } }) };
    };
    const rowC = { key: "takeaway", t: 3.0, ms: 10, c: { name: "clipC.mp4" } };
    const pC = loadRow(rowC);
    close();
    resolveC();
    await pC;
    // Does not overwrite since closed
    assert.notEqual(getCurrentDoc()?.events?.takeaway, 3.0);
  } finally {
    global.document = origDoc;
    global.fetch = origFetch;
    global.Image = origImage;
  }
});



