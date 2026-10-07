// My focus (Progress): one move I'm working on, which way (coach.js), with one club, since a day.
// Did the move change since, and did the results it's for follow? Each number's session medians
// since the focus started against the sessions before it (the latest BEFORE_SESSIONS), measured
// against how much it wobbles from session to session anyway:
//   wobble = the larger of the spread (sd) of the session medians before (with 3+ sessions of 3+
//   swings), and what the counts alone allow (1.25 x the swing-to-swing sd x sqrt(1/n before +
//   1/n since): a median's standard error);
//   "clear" when the change is 2 wobbles or more, "maybe" from 1.5, else "no change yet" (at 1, chance
//   alone said "maybe" about one time in three).
// Which way is good: the move's aim; a result's better way (helps.js RESULTS), or toward its target
// (coach.js targetOf: path, face, curve toward 0, attack toward the club's).
//
// Works in the browser (window.SwingFocus) and in Node (module.exports).
(function (root) {
  const Summary = root.SwingSummary || (typeof require !== "undefined" && require("./summary.js"));
  const Helps = root.SwingHelps || (typeof require !== "undefined" && require("./helps.js"));
  const Coach = root.SwingCoach || (typeof require !== "undefined" && require("./coach.js"));

  const BEFORE_SESSIONS = 6;
  const MIN_IN_SESSION = 3;

  const finite = v => typeof v === "number" && Number.isFinite(v);
  function median(xs) {
    const v = xs.filter(finite).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = (v.length - 1) / 2;
    return (v[Math.floor(m)] + v[Math.ceil(m)]) / 2;
  }
  function sd(xs) {
    if (xs.length < 2) return null;
    const m = xs.reduce((s, x) => s + x, 0) / xs.length;
    return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
  }

  /** A swing row's number for a key: a body move (as swingRow has it), or a result (helps.js). */
  function valueOf(row, key) {
    if (Summary.BODY.some(f => f.key === key)) return finite(row[key]) ? row[key] : null;
    const r = Helps.resultNumbers(row)[key];
    return finite(r) ? r : null;
  }

  /** One number before and since: {key, before, after, change, wobble, level, good, nBefore, nAfter, sessions}. */
  function compareOne(before, after, key, better) {
    const per = (list, since) => list.map(s => {
      const vals = s.rows.map(r => valueOf(r, key)).filter(finite);
      return { key: s.key, start: s.start, since, n: vals.length, median: median(vals), vals };
    }).filter(p => p.n > 0);
    const b = per(before, false), a = per(after, true);
    const out = { key, sessions: [...b, ...a].map(({ vals, ...p }) => p),
                  nBefore: b.reduce((s, p) => s + p.n, 0), nAfter: a.reduce((s, p) => s + p.n, 0) };
    if (!b.length || !a.length) return { ...out, level: "few" };
    out.before = median(b.map(p => p.median));
    out.after = median(a.map(p => p.median));
    out.change = out.after - out.before;
    // Swing-to-swing spread within sessions, pooled.
    let ss = 0, df = 0;
    for (const p of [...b, ...a]) {
      if (p.n < 2) continue;
      const m = p.vals.reduce((s, x) => s + x, 0) / p.n;
      ss += p.vals.reduce((s, x) => s + (x - m) ** 2, 0);
      df += p.n - 1;
    }
    const within = df > 0 ? Math.sqrt(ss / df) : 0;
    const fromCounts = 1.25 * within * Math.sqrt(1 / out.nBefore + 1 / out.nAfter);
    const steady = b.filter(p => p.n >= MIN_IN_SESSION);
    const between = steady.length >= 3 ? sd(steady.map(p => p.median)) : 0;
    out.wobble = Math.max(fromCounts, between || 0, 1e-9);
    const size = Math.abs(out.change) / out.wobble;
    out.level = size >= 2 ? "clear" : size >= 1.5 ? "maybe" : "none";
    out.good = better ? better(out.before, out.after) : null;
    return out;
  }

  /**
   * @param sessions the club's sessions oldest first, as trends.js progressSessions gives them:
   *   [{key, start (ms), rows: [swing rows], moved: {face, dtl}}]
   * @param focus {move, aim, club, results: [keys], since: "YYYY-MM-DD"}
   * @returns {before: n sessions, after: n sessions, move: compareOne, results: [compareOne],
   *   cameraMoved: bool (a camera the move is measured from moved since)}
   */
  function compare(sessions, focus) {
    const since = new Date(focus.since + "T00:00:00").getTime();
    const before = sessions.filter(s => s.start < since).slice(-BEFORE_SESSIONS);
    const after = sessions.filter(s => s.start >= since);
    const view = (Summary.BODY.find(f => f.key === focus.move) || {}).view;
    const move = compareOne(before, after, focus.move, (b, a) => (a > b) === (focus.aim === "more"));
    const results = (focus.results || []).map(key => {
      const rs = Helps.RESULTS.find(r => r.key === key);
      const target = Coach.targetOf(key, focus.club);
      const better = rs && rs.better ? (b, a) => (a > b) === (rs.better === "up")
        : target != null ? (b, a) => Math.abs(a - target) < Math.abs(b - target) : null;
      return compareOne(before, after, key, better);
    });
    return { before: before.length, after: after.length, move, results,
             cameraMoved: !!view && after.some(s => s.moved && s.moved[view]) };
  }

  /** In words: "clearly the right way", "maybe the wrong way", "no change yet", "not enough swings". */
  function verdict(x) {
    if (x.level === "few") return "not enough swings yet";
    if (x.level === "none") return "no change yet (within the usual wobble)";
    const way = x.good == null ? "changed" : x.good ? "the right way" : "the wrong way";
    return `${x.level === "clear" ? "clearly" : "maybe"} ${way}`;
  }

  /**
   * Is it working? The verdict on a compare() result in one heading and what to do about it:
   * {head, next, cls: "better" | "worse" | ""}. label(key) names a number in words.
   */
  function working(cmp, label) {
    const n = cmp.after, sess = `${n} session${n === 1 ? "" : "s"}`;
    const cap = t => t.replace(/^./, c => c.toUpperCase());
    const shows = x => x.level === "clear" || x.level === "maybe";
    const good = x => shows(x) && x.good === true, bad = x => shows(x) && x.good === false;
    const names = xs => {
      const w = xs.map(x => label(x.key));
      return w.length < 2 ? w.join("") : `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}`;
    };
    const up = cmp.results.filter(good), down = cmp.results.filter(bad);
    if (!n) return { cls: "", head: "Not started yet", next: "No sessions since your focus began: hit some balls with the drill." };
    if (cmp.move.level === "few") return { cls: "", head: "Not enough swings yet", next: `Too few swings with the move since it started (${sess}): keep going.` };
    if (bad(cmp.move) || (down.length && !up.length)) {
      return { cls: "worse", head: "Going the wrong way so far",
               next: `${bad(cmp.move) ? "The move itself" : cap(names(down))} moved the wrong way over ${sess}. Slow the drill down (half speed, 10 balls) before going back to full swings.` };
    }
    if (good(cmp.move) && up.length) return { cls: "better", head: "It's working", next: `You're making the move and ${names(up)} followed over ${sess}. Keep the drill going.` };
    if (good(cmp.move)) return { cls: "", head: "You're making the move; the results haven't followed yet", next: `That's over ${sess}: give it another session or two.` };
    if (up.length) return { cls: "better", head: "The results are moving the right way", next: `${cap(names(up))} improved over ${sess}, though the move itself hasn't changed clearly yet: keep going.` };
    if (n >= 4) return { cls: "worse", head: `Not working yet after ${sess}`,
                         next: "Neither the move nor its results have changed. Try the drill slower, or show your coach (Tools > Week for coach)." };
    return { cls: "", head: "Too early to tell", next: `Only ${sess} since it started: keep going.` };
  }

  const api = { BEFORE_SESSIONS, compare, compareOne, verdict, valueOf, working };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingFocus = api;
})(typeof window !== "undefined" ? window : globalThis);
