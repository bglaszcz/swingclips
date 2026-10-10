// Has a focus held? The end of the loop: measure, set a goal, practise, track, and then know when
// one thing is learned well enough to pick the next.
//
// It reads the focus's progress (goal.js progress): each session since the focus began, with how many
// of its swings were in the target. A session counts ("scored") when it has MIN_SESSION swings with a
// reading of the move.
//   held: the last HOLD_SESSIONS scored sessions each had HOLD_RATE of their swings in the target,
//     and they fall on at least two different days (three sets in one afternoon are one good day);
//   close: not held, and the last HOLD_SESSIONS - 1 reach the rate (or all of them did on one day);
//   slipped: it held at some point earlier, and the latest session is under SLIP_RATE;
//   building: sessions since, none of the above;
//   new: no scored session yet.
// The mark is the app's own, not a tour number: against your usual before you started, 50% of swings
// in the target is where you began (goal.js), so 70% is clearly more swings than not, and three
// sessions on two days is more than one good day. HOW says so on the page.
//
// Works in the browser (window.SwingGraduate) and in Node (module.exports).
(function (root) {
  const HOLD_RATE = 0.7, HOLD_SESSIONS = 3, MIN_SESSION = 5, SLIP_RATE = 0.5;

  const dayKey = ms => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
  const pct = r => `${Math.round(r * 100)}%`;
  const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  const count = n => WORDS[n] || String(n);
  const cap = s => s.replace(/^./, c => c.toUpperCase());
  const list = xs => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

  /**
   * @param progress SwingGoal.progress(...): {sessions: [{key, start (ms), since, n, k, rate, moved}] oldest first, ...}
   *   (moved: the camera that measures the move had moved before that session; board-view.js pbGoal)
   * @param opts {rate, sessions, minSwings}: the mark, if not the defaults
   * @returns {state: "held" | "close" | "slipped" | "building" | "new", run (scored sessions in a row at
   *   the rate, back from the latest), need (how many more it takes; 0 when held), oneDay (the run is
   *   long enough but all on one day), sessions: [{key, start, n, k, rate}] (the run's when held or
   *   close, else the last few scored ones), cameraInRun (a camera moved between those), rate, of
   *   (the mark: the rate and how many sessions), minSwings}
   */
  function check(progress, opts = {}) {
    const rate = opts.rate ?? HOLD_RATE, of = opts.sessions ?? HOLD_SESSIONS, minSwings = opts.minSwings ?? MIN_SESSION;
    const scored = ((progress && progress.sessions) || []).filter(s => s.since && s.n >= minSwings);
    const base = { rate, of, minSwings };
    if (!scored.length) return { ...base, state: "new", run: 0, need: of, oneDay: false, sessions: [], cameraInRun: false };
    const last = scored.length - 1;
    let run = 0;
    while (run <= last && scored[last - run].rate >= rate) run++;
    // The `of` sessions ending at index `end` all reach the rate, on at least two days.
    const heldAt = end => {
      if (end + 1 < of) return false;
      const w = scored.slice(end + 1 - of, end + 1);
      return w.every(s => s.rate >= rate) && new Set(w.map(s => dayKey(s.start))).size >= 2;
    };
    const held = heldAt(last), oneDay = !held && run >= of;
    let before = false;
    for (let end = of - 1; end < last && !before; end++) before = heldAt(end);
    const state = held ? "held"
      : run >= Math.max(1, of - 1) ? "close"
      : before && scored[last].rate < SLIP_RATE ? "slipped"
      : "building";
    const shown = scored.slice(-(state === "held" || state === "close" ? Math.max(run, 1) : of));
    return {
      ...base, state, run, oneDay,
      need: held ? 0 : oneDay ? 1 : of - run,
      sessions: shown.map(s => ({ key: s.key, start: s.start, n: s.n, k: s.k, rate: s.rate })),
      cameraInRun: shown.slice(1).some(s => s.moved),
    };
  }

  /** What check found, in a sentence or two for the golfer: describes, never advises. */
  function words(r) {
    if (!r) return "";
    const mark = `${cap(count(r.of))} sessions in a row at ${pct(r.rate)} is the mark`;
    const latest = r.sessions[r.sessions.length - 1];
    let text;
    if (r.state === "new") text = `No session with ${r.minSwings} swings since you started yet. ${mark}.`;
    else if (r.state === "held") {
      const shown = r.sessions.slice(-r.of).map(s => pct(s.rate));
      text = `Held for ${count(r.run)} sessions in a row (${r.run > r.of ? `the last ${count(r.of)}: ` : ""}${list(shown)} of swings in your target). This one looks learned.`;
    } else if (r.state === "close") {
      text = r.oneDay
        ? `${cap(count(r.run))} sessions in a row over ${pct(r.rate)} of swings in your target, all on one day. One more on another day and it has held.`
        : `${cap(count(r.run))} session${r.run === 1 ? "" : "s"} in a row over ${pct(r.rate)} of swings in your target. ${cap(count(r.need))} more and it has held.`;
    } else if (r.state === "slipped") text = `It held earlier, but the latest session was ${pct(latest.rate)} in your target.`;
    else text = `Latest session: ${pct(latest.rate)} of swings in your target. ${mark}.`;
    return r.cameraInRun ? `${text} A camera moved during these sessions: scores either side may not compare.` : text;
  }

  const HOW = "Your target is your usual before you started, so half your swings beat it on the day you began. "
    + "A session counts once it has 5 swings with a reading of the move. The focus has held when three such sessions in a row "
    + "each have 70% of their swings in the target, on at least two different days: clearly more swings than not, and more than one good day. "
    + "This is the app's own mark for moving on, not a tour number.";

  const api = { HOLD_RATE, HOLD_SESSIONS, MIN_SESSION, SLIP_RATE, check, words, HOW };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingGraduate = api;
})(typeof window !== "undefined" ? window : globalThis);
