// The focus as a goal: a target for the move, and a progress score against it.
//
// A focus says which move and which way (more / less). The target is what "better" looks like in the
// move's own number:
//   your own: a bound you set (focus.target), or
//   your usual before you started: the middle value of the move over the swings of the sessions
//     before the focus began (the same sessions focus.js compares with), on the side you're aiming
//     for. With no session before it, the first session since stands in.
// The progress score is the share of a session's swings on the right side of the target. Against
// your old usual it is 50% before you start, by construction: above 50% means more swings than not
// now beat it. Session medians and whether a change is beyond the wobble are focus.js's job
// ("Is it working?"); this is the count a golfer can follow swing by swing.
//
// Works in the browser (window.SwingGoal) and in Node (module.exports).
(function (root) {
  // Sessions before the focus that set the usual (focus.js BEFORE_SESSIONS), swings they need between
  // them, and swings a session needs for its own score to be shown.
  const BEFORE_SESSIONS = 6, MIN_BASELINE = 5, MIN_SESSION = 5;

  const finite = v => typeof v === "number" && Number.isFinite(v);
  const median = xs => {
    const v = xs.filter(finite).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };
  const sinceOf = focus => new Date(focus.since + "T00:00:00").getTime();
  const values = (rows, key) => (rows || []).map(r => r[key]).filter(finite);

  /**
   * The target for a focus.
   * @param sessions the focus's sessions oldest first: [{key, start (ms), rows}]
   * @param focus {move, aim: "more" | "less", since: "YYYY-MM-DD", target: number | undefined}
   * @returns {bound, side: "above" | "below", from: "own" | "before" | "first", n (swings behind the
   *   usual)}, or null when there is nothing to set one from yet
   */
  function target(sessions, focus) {
    const side = focus.aim === "more" ? "above" : "below";
    if (finite(focus.target)) return { bound: focus.target, side, from: "own", n: 0 };
    const since = sinceOf(focus);
    const before = (sessions || []).filter(s => s.start < since).slice(-BEFORE_SESSIONS).flatMap(s => values(s.rows, focus.move));
    if (before.length >= MIN_BASELINE) return { bound: median(before), side, from: "before", n: before.length };
    const first = (sessions || []).find(s => s.start >= since && values(s.rows, focus.move).length >= MIN_BASELINE);
    if (!first) return null;
    const v = values(first.rows, focus.move);
    return { bound: median(v), side, from: "first", n: v.length };
  }

  /** Whether a value is on the right side of the target (the bound itself counts). */
  const inTarget = (v, t) => finite(v) && !!t && (t.side === "above" ? v >= t.bound : v <= t.bound);

  /** The swings with a reading, and how many were in the target: {n, k, rate}. */
  function score(rows, focus, t) {
    const v = values(rows, focus.move), k = v.filter(x => inTarget(x, t)).length;
    return { n: v.length, k, rate: v.length ? k / v.length : null };
  }

  /**
   * The focus so far.
   * @returns {target, sessions: [{key, start, since: bool, n, k, rate}] (the sessions before that set
   *   the usual, then every one since; those with no reading left out), before: {n, k, rate},
   *   after: {n, k, rate, sessions, days}, latest: the latest session since (or null), best: the
   *   best session since with MIN_SESSION swings (or null)}, or null without a target
   */
  function progress(sessions, focus, now) {
    const t = target(sessions, focus);
    if (!t) return null;
    const since = sinceOf(focus), list = sessions || [];
    const pick = [...list.filter(s => s.start < since).slice(-BEFORE_SESSIONS), ...list.filter(s => s.start >= since)];
    const per = pick.map(s => ({ key: s.key, start: s.start, since: s.start >= since, ...score(s.rows, focus, t) })).filter(p => p.n > 0);
    const sum = ps => { const n = ps.reduce((a, p) => a + p.n, 0), k = ps.reduce((a, p) => a + p.k, 0); return { n, k, rate: n ? k / n : null }; };
    const after = per.filter(p => p.since), counted = after.filter(p => p.n >= MIN_SESSION);
    return {
      target: t, sessions: per, before: sum(per.filter(p => !p.since)),
      after: { ...sum(after), sessions: after.length, days: Math.max(0, Math.floor(((now ?? Date.now()) - since) / 86400000)) },
      latest: after.length ? after[after.length - 1] : null,
      best: counted.length ? counted.reduce((a, p) => p.rate > a.rate ? p : a) : null,
    };
  }

  /** A practice range that means "in the target": from the bound out to well past where swings go. */
  function practiceRange(t, recent) {
    const v = (recent || []).filter(finite).sort((a, b) => a - b);
    if (!t || v.length < MIN_BASELINE) return null;
    const q = p => { const i = (v.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return v[lo] + (v[hi] - v[lo]) * (i - lo); };
    const reach = 2 * (q(0.9) - q(0.1)) || 1;
    return t.side === "above" ? { min: t.bound, max: t.bound + reach } : { min: t.bound - reach, max: t.bound };
  }

  const api = { BEFORE_SESSIONS, MIN_BASELINE, MIN_SESSION, target, inTarget, score, progress, practiceRange };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingGoal = api;
})(typeof window !== "undefined" ? window : globalThis);
