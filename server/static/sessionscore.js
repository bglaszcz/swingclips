// Progress, all clubs at once: did the latest session go better than the last one, and the one or two
// things most worth working on.
//
// Sessions are scored with numbers that mean the same with any club, each against that club's own
// usual (goodshots.js): good shots (your good-shot rules), on line (offline within the club's
// allowance), solid strikes (smash at or above the club's median) and distance (carry against the
// club's usual carry). So a session of wedges and one of long irons compare.
//
// The last session is the latest earlier one with MIN_JUDGED judged shots (a 9-swing warm-up doesn't
// count as "last time"); "usual" is the median of up to USUAL earlier ones. A change in good shots is
// "clear" when a two-proportion z test says it's unlikely to be luck (|z| >= Z_CLEAR); else it's
// "about the same" unless the gap is at least SAME_PTS points, then "a little better / worse".
//
// What to work on: the "what helps, what hurts" links (helps.js) worked out over every club at
// once, each swing against its own session-and-club usual, ranked by how much they matter to an
// everyday golfer (on line, distance, strike first; attack angle and loft left out: their target
// depends on the club). Coaching from coach.js; never a move toward a fault.
//
// Works in the browser (window.SwingSessionScore) and in Node (module.exports).
(function (root) {
  const Coach = root.SwingCoach || (typeof require !== "undefined" && require("./coach.js"));
  const GoodShots = root.SwingGoodShots || (typeof require !== "undefined" && require("./goodshots.js"));

  // One club's sessions are smaller (5-30 shots with a club): MIN_JUDGED_CLUB for them.
  const MIN_JUDGED = 15, MIN_JUDGED_CLUB = 8, USUAL = 6, Z_CLEAR = 1.64, SAME_PTS = 5;
  // What a result is worth to an everyday golfer, for ranking the moves that go with it.
  const WEIGHT = { absOffline: 1, smash: 0.9, carry: 0.8, path: 0.8, faceToPath: 0.7, absFaceToPath: 0.7,
                   ballSpeed: 0.6, face: 0.6, strikeV: 0.5, strikeH: 0.4 };
  // A second thing to work on only when it's nearly as big as the first.
  const SECOND_SHARE = 0.7;

  const finite = v => typeof v === "number" && Number.isFinite(v);
  const median = xs => {
    const v = xs.filter(finite).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };
  const rate = (k, n) => n ? k / n : null;

  /**
   * One session's numbers over all its clubs.
   * @param rows [{club, carry, offline, smash, ...}] (summary.js shotNumbers fields)
   * @param ctx {clubs: {club: {baseline, verdicts}} as goodshots.js build, name: row -> its clip name,
   *   settings: goodshots.json settings}
   * @returns {n, judged, good, goodRate, lineN, onLine, onLineRate, solidN, solid, solidRate, distance
   *   (median carry as % of the club's usual), clubs: {club: count}}
   */
  function score(rows, ctx) {
    const st = GoodShots.withDefaults(ctx.settings);
    let judged = 0, good = 0, lineN = 0, onLine = 0, solidN = 0, solid = 0;
    const dist = [], clubs = {};
    for (const r of rows) {
      const group = GoodShots.groupOf(r.club);
      if (!group) continue;
      clubs[r.club] = (clubs[r.club] || 0) + 1;
      const c = ctx.clubs && ctx.clubs[r.club], base = c && c.baseline;
      if (!base) continue;
      const v = c.verdicts && c.verdicts[ctx.name(r)];
      const judgedHere = v || (finite(r.carry) ? GoodShots.judgeShot(r, base, group, st) : null);
      if (judgedHere && finite(r.carry) && r.carry > 0) { judged++; if (judgedHere.good) good++; }
      if (finite(r.offline) && finite(r.carry) && r.carry > 0) {
        lineN++;
        if (Math.abs(r.offline) <= st[group].offlinePct / 100 * r.carry) onLine++;
      }
      if (finite(r.smash) && finite(base.smash)) { solidN++; if (r.smash >= base.smash) solid++; }
      if (finite(r.carry) && r.carry > 0 && finite(base.carry) && base.carry > 0) dist.push(r.carry / base.carry * 100);
    }
    return { n: rows.length, judged, good, goodRate: rate(good, judged), lineN, onLine, onLineRate: rate(onLine, lineN),
             solidN, solid, solidRate: rate(solid, solidN), distance: median(dist), clubs };
  }

  /** Two-proportion z for k1/n1 against k0/n0 (+ = the first is higher), or null. */
  function zOf(k1, n1, k0, n0) {
    if (!n1 || !n0) return null;
    const p = (k1 + k0) / (n1 + n0), se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n0));
    return se > 0 ? (k1 / n1 - k0 / n0) / se : 0;
  }

  const ITEMS = [
    { key: "goodRate", label: "Good shots", k: "good", n: "judged", unit: "%", hint: "passed your good-shot rules for that club" },
    { key: "onLineRate", label: "On line", k: "onLine", n: "lineN", unit: "%", hint: "finished within the club's offline allowance" },
    { key: "solidRate", label: "Solid strikes", k: "solid", n: "solidN", unit: "%", hint: "ball speed off the face at or above your usual for that club" },
    { key: "distance", label: "Distance", unit: "% of usual", hint: "median carry against your usual carry with each club" },
  ];

  /**
   * The latest session against the last one and the usual.
   * @param sessions [{start, rows}] oldest first (all clubs, or one club's)
   * @param opts {minJudged}: judged shots a session needs to be compared (default MIN_JUDGED)
   * @returns {latest, last, usual, items: [{key, label, unit, hint, now, last, usual, z, change:
   *   "better" | "worse" | "same" | null, clear}], verdict: "better" | "worse" | "same" | "first" | "few",
   *   headline, series: {key: [value per session]}} or null with no sessions
   */
  function compare(sessions, ctx, opts) {
    const minJudged = (opts && opts.minJudged) || MIN_JUDGED;
    const scored = sessions.map(s => ({ ...s, score: score(s.rows, ctx) }));
    const latest = scored[scored.length - 1];
    if (!latest) return null;
    const earlier = scored.slice(0, -1).filter(s => s.score.judged >= minJudged);
    const last = earlier[earlier.length - 1] || null;
    const usualOf = key => median(earlier.slice(-USUAL).map(s => s.score[key]));
    const items = ITEMS.map(it => {
      const now = latest.score[it.key], prev = last ? last.score[it.key] : null;
      let z = null, change = null, clear = false;
      // Too few shots this session: the tiles show last time and the usual, no verdict.
      if (now != null && prev != null && latest.score.judged >= minJudged) {
        if (it.k) {
          z = zOf(latest.score[it.k], latest.score[it.n], last.score[it.k], last.score[it.n]);
          clear = z != null && Math.abs(z) >= Z_CLEAR;
          const pts = (now - prev) * 100;
          change = clear || Math.abs(pts) >= SAME_PTS ? (pts > 0 ? "better" : "worse") : "same";
        } else {
          change = Math.abs(now - prev) < 3 ? "same" : now > prev ? "better" : "worse";
        }
      }
      return { ...it, now, last: prev, usual: usualOf(it.key), z, change, clear };
    });
    const series = Object.fromEntries(ITEMS.map(it => [it.key, scored.map(s => s.score[it.key])]));
    const head = items[0];
    let verdict, headline;
    const pct = v => `${Math.round(v * 100)}%`;
    if (latest.score.judged < minJudged) {
      verdict = "few";
      headline = `Only ${latest.score.judged} shot${latest.score.judged === 1 ? "" : "s"} with a verdict this session: too few to compare.`;
    } else if (!last) {
      verdict = "first";
      headline = `${pct(head.now)} good shots. Nothing earlier to compare with yet.`;
    } else {
      verdict = head.change;
      const was = `${pct(head.now)} good shots, against ${pct(head.last)} last time`;
      headline = head.change === "same" ? `About the same as last time: ${was}.`
        : head.clear ? `${head.change === "better" ? "Better" : "Worse"} than last time: ${was}.`
        : `A little ${head.change} than last time: ${was} (not a clear change yet: a gap that size can be luck).`;
    }
    return { latest, last, items, verdict, headline, series, sessions: scored };
  }

  /**
   * The moves most worth working on, from helps.js links over all clubs: [{move, aim, fix, goals,
   * label: "confirmed" | "emerging", score, items}], best first, at most 2 (the second only when it's
   * at least SECOND_SHARE of the first). Moves whose links point both ways (a trade-off) are left out.
   */
  function priorities(links) {
    const byMove = new Map();
    for (const l of links || []) {
      if (l.label !== "confirmed" && l.label !== "emerging") continue;
      const w = WEIGHT[l.result];
      if (!w) continue;
      const c = Coach.coach(l, null);
      if (!c || !c.aim || !c.fix || c.fix.fault) continue;
      const m = byMove.get(l.move) || { move: l.move, aims: new Set(), items: [], score: 0 };
      m.aims.add(c.aim);
      m.items.push({ l, c });
      m.score += w * Math.abs(l.r || 0) * (l.label === "confirmed" ? 1 : 0.5);
      byMove.set(l.move, m);
    }
    const ranked = [...byMove.values()].filter(m => m.aims.size === 1).sort((a, b) => b.score - a.score)
      .map(m => {
        const aim = m.items[0].c.aim;
        return { move: m.move, aim, fix: m.items[0].c.fix, score: m.score, items: m.items,
                 goals: [...new Set(m.items.map(x => x.c.goal).filter(Boolean))],
                 label: m.items.some(x => x.l.label === "confirmed") ? "confirmed" : "emerging" };
      });
    return ranked.slice(0, ranked.length > 1 && ranked[1].score >= SECOND_SHARE * ranked[0].score ? 2 : 1);
  }

  const api = { score, compare, priorities, zOf, ITEMS, MIN_JUDGED, MIN_JUDGED_CLUB, USUAL, WEIGHT };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingSessionScore = api;
})(typeof window !== "undefined" ? window : globalThis);
