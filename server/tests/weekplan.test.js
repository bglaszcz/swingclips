// weekplan.test.js: unit tests for SwingWeekPlan.build (weekplan.js).
const test = require("node:test");
const assert = require("node:assert");
const WeekPlan = require("../static/weekplan.js");

// Local-time helper: Oct 13, 2025 is a Monday; Oct 19, 2025 is a Sunday.
function localTime(y, m, d, hr = 0, min = 0, sec = 0) {
  return new Date(y, m - 1, d, hr, min, sec, 0).getTime();
}

function makeClips(n, newestMs, excludedLast = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = newestMs - i * 60000;
    out.push({ name: `swing_face_${t}_${i}.mp4`, recorded: new Date(t).toISOString(), excluded: i < excludedLast });
  }
  return out;
}

function makeSession(startMs, nSwings, newestMs) {
  const end = newestMs != null ? newestMs : startMs + (nSwings - 1) * 60000;
  return { key: `sess_${startMs}`, start: startMs, clips: makeClips(nSwings, end) };
}

const find = (m, id) => m.items.find(i => i.id === id);

test("week edges: Sunday 23:59 session is last week's; Monday 00:00 session is this week's", () => {
  const sun2359 = localTime(2025, 10, 12, 23, 59, 0);
  const mon0000 = localTime(2025, 10, 13, 0, 0, 0);
  const wedNoon = localTime(2025, 10, 15, 12, 0, 0);

  const m = WeekPlan.build({
    now: wedNoon,
    sessions: [makeSession(mon0000, 12), makeSession(sun2359, 12)],
    focus: null,
  });

  assert.strictEqual(m.weekStart, mon0000);
  assert.strictEqual(m.title, "This week (Oct 13 to 19)");
  assert.strictEqual(find(m, "sessions").have, 1);
  assert.strictEqual(find(m, "sessions").text, "1 of 3 sessions");
  assert.strictEqual(m.last.weekStart, localTime(2025, 10, 6, 0, 0, 0));
  assert.strictEqual(find(m.last, "sessions").have, 1);
});

test("10-swing session rule and a session still going", () => {
  const now = localTime(2025, 10, 15, 15, 0, 0);
  const mon = localTime(2025, 10, 13, 10, 0, 0);
  const tue = localTime(2025, 10, 14, 10, 0, 0);
  // Session still going (newest clip 2 minutes ago) with 10 swings counts; one with 9 swings does not.
  const goingStart = now - 15 * 60000;
  const goingNewest = now - 2 * 60000;

  const m9 = WeekPlan.build({
    now,
    sessions: [
      makeSession(goingStart, 9, goingNewest),
      makeSession(tue, 9),
      makeSession(mon, 10),
    ],
  });
  assert.strictEqual(find(m9, "sessions").have, 1);

  const m10 = WeekPlan.build({
    now,
    sessions: [
      makeSession(goingStart, 10, goingNewest),
      makeSession(tue, 9),
      makeSession(mon, 10),
    ],
  });
  assert.strictEqual(find(m10, "sessions").have, 2);
  assert.strictEqual(find(m10, "sessions").text, "2 of 3 sessions");
});

test("need 2 and 5, and done mark on sessions", () => {
  const now = localTime(2025, 10, 16, 12, 0, 0);
  const sessions = [
    makeSession(localTime(2025, 10, 13, 10, 0), 10),
    makeSession(localTime(2025, 10, 14, 10, 0), 14),
  ];

  const m2 = WeekPlan.build({ now, sessions, need: 2 });
  const s2 = find(m2, "sessions");
  assert.strictEqual(s2.need, 2);
  assert.strictEqual(s2.done, true);
  assert.strictEqual(s2.text, "2 of 2 sessions \u2713");

  const m5 = WeekPlan.build({ now, sessions, need: 5 });
  const s5 = find(m5, "sessions");
  assert.strictEqual(s5.need, 5);
  assert.strictEqual(s5.done, false);
  assert.strictEqual(s5.text, "2 of 5 sessions");
});

test("reps with and without a drill for the move; two drill sets this week and one last week", () => {
  const now = localTime(2025, 10, 16, 12, 0, 0);
  const drillId = (move, aim) => (move === "leadHipP6" && aim === "more" ? "move:leadHipP6:more" : null);
  const verdict = set => ({ text: set.vText });

  // Focus without a drill: no reps item
  const noDrill = WeekPlan.build({
    now,
    focus: { move: "unknownMove", aim: "more" },
    drillId,
    drillSets: [],
    verdict,
    held: { state: "new", run: 0, of: 3 },
    words: () => "New focus.",
  });
  assert.strictEqual(find(noDrill, "reps"), undefined);
  assert.strictEqual(noDrill.total, 2);

  // Focus with a drill: 1 set this week
  const setLastWeek = { drill: "move:leadHipP6:more", timestamp: localTime(2025, 10, 8, 11, 0), count: 10, vText: "maybe carrying over" };
  const setTue = { drill: "move:leadHipP6:more", timestamp: localTime(2025, 10, 14, 11, 0), count: 10, vText: "there in the reps, but no carry-over yet" };
  const setThu = { drill: "move:leadHipP6:more", timestamp: localTime(2025, 10, 16, 10, 0), count: 12, vText: "clear carry-over into your swings" };

  const oneSet = WeekPlan.build({
    now,
    focus: { move: "leadHipP6", aim: "more" },
    drillId,
    drillSets: [setTue, setLastWeek],
    verdict,
    held: { state: "building", run: 1, of: 3 },
    words: () => "Latest session: 60% of swings in your target.",
  });
  const r1 = find(oneSet, "reps");
  assert.ok(r1);
  assert.strictEqual(r1.have, 1);
  assert.strictEqual(r1.need, 2);
  assert.strictEqual(r1.done, false);
  assert.strictEqual(r1.text, "1 of 2 drill sets for your focus: there in the reps, but no carry-over yet");

  // 2 sets this week and 1 last week
  const twoSets = WeekPlan.build({
    now,
    focus: { move: "leadHipP6", aim: "more" },
    drillId,
    drillSets: [setThu, setTue, setLastWeek],
    verdict,
    held: { state: "building", run: 1, of: 3 },
    words: () => "Latest session: 60% of swings in your target.",
  });
  const r2 = find(twoSets, "reps");
  assert.strictEqual(r2.have, 2);
  assert.strictEqual(r2.done, true);
  assert.strictEqual(r2.text, "2 of 2 drill sets for your focus: clear carry-over into your swings");

  const rLast = find(twoSets.last, "reps");
  assert.strictEqual(rLast.have, 1);
  assert.strictEqual(rLast.done, false);
  assert.strictEqual(rLast.text, "1 of 2 drill sets for your focus: maybe carrying over");
});

test("Combine this week vs only last week, and 'your first' text", () => {
  const now = localTime(2025, 10, 16, 12, 0, 0);
  const tueThisWeek = localTime(2025, 10, 14, 14, 0, 0) / 1000;
  const thuThisWeek = localTime(2025, 10, 16, 9, 0, 0) / 1000;
  const wedLastWeek = localTime(2025, 10, 8, 14, 0, 0) / 1000;

  // Only last week
  const onlyLast = WeekPlan.build({
    now,
    games: [{ id: "combine", started: wedLastWeek, summary: { shots: 27, greens: 12, sgPerShot: -0.24 } }],
  });
  const tOnlyLast = find(onlyLast, "test");
  assert.strictEqual(tOnlyLast.done, false);
  assert.strictEqual(tOnlyLast.text, "Combine: not played yet this week");
  assert.strictEqual(find(onlyLast.last, "test").done, true);
  assert.strictEqual(find(onlyLast.last, "test").text, "Combine on Wed: -0.24 strokes a shot vs tour (your first)");

  // First Combine ever is this week on Tue
  const firstThisWeek = WeekPlan.build({
    now,
    games: [{ id: "combine", started: tueThisWeek, summary: { shots: 27, greens: 15, sgPerShot: -0.18 } }],
  });
  const tFirst = find(firstThisWeek, "test");
  assert.strictEqual(tFirst.done, true);
  assert.strictEqual(tFirst.text, "Combine on Tue: -0.18 strokes a shot vs tour (your first)");

  // Combine this week and last week (and if two this week, newest wins)
  const bothWeeks = WeekPlan.build({
    now,
    games: [
      { id: "combine", started: wedLastWeek, summary: { shots: 27, greens: 12, sgPerShot: -0.24 } },
      { id: "combine", started: tueThisWeek, summary: { shots: 27, greens: 15, sgPerShot: -0.18 } },
      { id: "combine", started: thuThisWeek, summary: { shots: 27, greens: 18, sgPerShot: 0.05 } },
    ],
  });
  const tBoth = find(bothWeeks, "test");
  assert.strictEqual(tBoth.done, true);
  assert.strictEqual(tBoth.have, 2);
  assert.strictEqual(tBoth.text, "Combine on Thu: +0.05 strokes a shot vs tour (last week -0.24)");
});

test("held not counted in done/total; line in each state; daysLeft on Monday and Sunday", () => {
  const mon = localTime(2025, 10, 13, 9, 0, 0);
  const fri = localTime(2025, 10, 17, 9, 0, 0);
  const sun = localTime(2025, 10, 19, 20, 0, 0);

  const mMon = WeekPlan.build({ now: mon });
  assert.strictEqual(mMon.daysLeft, 7);
  assert.strictEqual(mMon.line, "0 of 2 done this week, 7 days left.");

  const mSun = WeekPlan.build({ now: sun });
  assert.strictEqual(mSun.daysLeft, 1);
  assert.strictEqual(mSun.line, "0 of 2 done this week, 1 day left.");

  // With focus, 2 of 3 done on Friday (3 days left), held is "building" (not counted in done/total)
  const sessions = [
    makeSession(localTime(2025, 10, 13, 10, 0), 12),
    makeSession(localTime(2025, 10, 14, 10, 0), 12),
    makeSession(localTime(2025, 10, 15, 10, 0), 12),
  ];
  const sets = [
    { drill: "pump", timestamp: localTime(2025, 10, 13, 10, 5), count: 10, verdict: "clear carry-over into your swings" },
    { drill: "pump", timestamp: localTime(2025, 10, 15, 10, 5), count: 10, verdict: "clear carry-over into your swings" },
  ];
  const mFri = WeekPlan.build({
    now: fri,
    sessions,
    focus: { move: "handsPlaneP6", aim: "less" },
    drillId: () => "pump",
    drillSets: sets,
    verdict: s => ({ text: s.verdict }),
    games: [],
    held: { state: "building", run: 1, of: 3 },
    words: () => "Latest session: 55% of swings in your target.",
  });
  assert.strictEqual(mFri.items.length, 4);
  assert.strictEqual(mFri.done, 2);
  assert.strictEqual(mFri.total, 3);
  assert.strictEqual(mFri.daysLeft, 3);
  assert.strictEqual(mFri.line, "2 of 3 done this week, 3 days left.");
  assert.strictEqual(find(mFri, "held").done, false);
  assert.strictEqual(find(mFri, "held").text, "Latest session: 55% of swings in your target.");

  // When held.state === "held" and not all items done:
  const mHeldPartial = WeekPlan.build({
    now: fri,
    sessions,
    focus: { move: "handsPlaneP6", aim: "less" },
    drillId: () => "pump",
    drillSets: sets,
    verdict: s => ({ text: s.verdict }),
    games: [],
    held: { state: "held", run: 3, of: 3 },
    words: () => "Held for three sessions in a row. This one looks learned.",
  });
  // held is done, but still not counted in done/total (2 of 3)
  assert.strictEqual(mHeldPartial.done, 2);
  assert.strictEqual(mHeldPartial.total, 3);
  assert.strictEqual(find(mHeldPartial, "held").done, true);
  assert.strictEqual(
    mHeldPartial.line,
    "2 of 3 done this week, 3 days left. Your focus has held: pick the next one on the review page (Progress)."
  );

  // When all 3 items are done and held is held:
  const mAllDoneHeld = WeekPlan.build({
    now: fri,
    sessions,
    focus: { move: "handsPlaneP6", aim: "less" },
    drillId: () => "pump",
    drillSets: sets,
    verdict: s => ({ text: s.verdict }),
    games: [{ id: "combine", started: localTime(2025, 10, 16, 12, 0) / 1000, summary: { shots: 27, greens: 15, sgPerShot: -0.15 } }],
    held: { state: "held", run: 3, of: 3 },
    words: () => "Held for three sessions in a row. This one looks learned.",
  });
  assert.strictEqual(mAllDoneHeld.done, 3);
  assert.strictEqual(mAllDoneHeld.total, 3);
  assert.strictEqual(
    mAllDoneHeld.line,
    "All done this week. Your focus has held: pick the next one on the review page (Progress)."
  );

  // All done without held:
  const mAllDone = WeekPlan.build({
    now: fri,
    sessions,
    focus: null,
    games: [{ id: "combine", started: localTime(2025, 10, 16, 12, 0) / 1000, summary: { shots: 27, greens: 15, sgPerShot: -0.15 } }],
  });
  assert.strictEqual(mAllDone.done, 2);
  assert.strictEqual(mAllDone.total, 2);
  assert.strictEqual(mAllDone.line, "All done this week.");
});

test("runs build on the real coach.js, drillsets.js, games.js, graduate.js with empty data without throwing", () => {
  const Coach = require("../static/coach.js");
  const DrillSets = require("../static/drillsets.js");
  const Games = require("../static/games.js");
  const Graduate = require("../static/graduate.js");

  const m = WeekPlan.build({
    now: localTime(2025, 10, 15, 12, 0, 0),
    sessions: [],
    focus: null,
    drillId: Coach.drillId,
    drillSets: DrillSets.sets([], {}),
    verdict: DrillSets.verdict,
    games: Games.gameHistory([], "combine"),
    held: null,
    words: Graduate.words,
  });
  assert.strictEqual(m.done, 0);
  assert.ok(m.total >= 1);
  assert.ok(Array.isArray(m.items));
});

test("render builds head, rows with marks, Last week line, Sessions a week select, and collapses when recording", () => {
  function fakeDoc() {
    function node(tag) {
      let txt = "";
      return {
        tagName: tag.toUpperCase(),
        className: "",
        get textContent() { return txt; },
        set textContent(v) { txt = v; if (v === "") this.children = []; },
        value: "",
        selected: false,
        dataset: {},
        attrs: {},
        children: [],
        ownerDocument: null,
        setAttribute(k, v) { this.attrs[k] = v; },
        append(...kids) {
          for (const k of kids) {
            if (k) this.children.push(k);
          }
        },
      };
    }
    const doc = {
      createElement(tag) {
        const n = node(tag);
        n.ownerDocument = doc;
        return n;
      },
    };
    return doc;
  }

  const doc = fakeDoc();
  const box = doc.createElement("div");
  const model = WeekPlan.build({
    now: localTime(2025, 10, 16, 12, 0, 0),
    sessions: [
      makeSession(localTime(2025, 10, 13, 10, 0), 12),
      makeSession(localTime(2025, 10, 6, 10, 0), 12),
      makeSession(localTime(2025, 10, 7, 10, 0), 12),
      makeSession(localTime(2025, 10, 8, 10, 0), 12),
    ],
    need: 3,
  });

  let chosenNeed = null;
  WeekPlan.render(box, model, { onNeed: n => { chosenNeed = n; } });
  assert.strictEqual(box.children.length, 3); // head, items, foot
  const [head, items, foot] = box.children;
  assert.strictEqual(head.children[0].textContent, "This week (Oct 13 to 19)");
  assert.strictEqual(head.children[2].textContent, "0 of 2 done this week, 4 days left.");
  assert.strictEqual(items.children.length, 2);
  assert.strictEqual(items.children[0].children[0].textContent, "\u25cb");
  assert.strictEqual(items.children[0].children[1].textContent, "1 of 3 sessions");
  assert.strictEqual(foot.children[0].textContent, "Last week: 1 of 2");
  const sel = foot.children[1].children[0];
  assert.strictEqual(sel.value, "3");
  sel.value = "4";
  sel.onchange();
  assert.strictEqual(chosenNeed, 4);

  // Collapsed when recording
  WeekPlan.render(box, model, { recording: true });
  assert.strictEqual(box.children.length, 1);
  assert.strictEqual(box.children[0].className, "wp-head");
});

