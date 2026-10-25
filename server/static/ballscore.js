// server/static/ballscore.js
// The ball scoreboard on Week for coach: a few ball numbers, this week against the 4 weeks before.
// The owner judges by trends, not by one session, so a row only says "better" or "worse" once
// there are enough sessions on both sides and the change is bigger than the usual session to
// session wobble, two weeks in a row. Until then it says "too early" (or "no clear change").
//
// Rows, per club group (never pooled across irons and woods):
//   5 to 7 iron and 8 iron to gap wedge: shots 10+ yd short, and centred strike;
//   driver: drives beyond 30 yd offline, and centred strike.
// "Short" is carry at least 10 yd under that club's median over the five weeks shown, so both
// sides are measured against the same yardstick. "Centred" is within 12 mm of the centre, heel to
// toe (Square's strike reading). Normal swings only: drills (warm up is a drill), games and
// left out swings don't count.
//
// Works in the browser (window.SwingBallScore) and in Node (module.exports).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SwingBallScore = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DAY_MS = 86400000;
  const WEEK_MS = 7 * DAY_MS;
  const BEFORE_WEEKS = 4;
  const SHORT_YD = 10;       // carry this far under the club's median counts as short
  const CENTRED_MM = 12;     // heel to toe within this of the centre counts as centred
  const WIDE_YD = 30;        // a drive further offline than this counts as wide
  const MIN_SESSIONS = 3;    // sessions needed on each side before any verdict
  const MIN_WEEK_SHOTS = 10; // shots needed this week
  const MIN_BEFORE_SHOTS = 20;
  const MIN_STOCK_SHOTS = 8; // a club needs this many carries in the five weeks for a median
  const MIN_CHANGE = 0.05;   // a verdict needs a change of at least 5 points...
  const CLEAR_Z = 2;         // ...and more than twice its uncertainty

  const GROUPS = [
    { key: "long", label: "5 to 7 iron", clubs: ["I5", "I6", "I7"], metrics: ["short", "centred"] },
    { key: "short", label: "8 iron to gap wedge", clubs: ["I8", "I9", "PW", "GW"], metrics: ["short", "centred"] },
    { key: "driver", label: "Driver", clubs: ["DR"], metrics: ["wide", "centred"] },
  ];

  const METRICS = {
    short: { label: `${SHORT_YD}+ yd short`, better: "lower" },
    centred: { label: "centred strike", better: "higher" },
    wide: { label: `beyond ${WIDE_YD} yd offline`, better: "lower" },
  };

  const finite = v => typeof v === "number" && Number.isFinite(v);

  /** "7I", "i7", "I7" -> "I7"; "dr" -> "DR". */
  function clubCode(c) {
    if (!c) return null;
    const up = String(c).trim().toUpperCase();
    const m = up.match(/^(\d)([IWH])$/);
    return m ? m[2] + m[1] : up;
  }

  function dayKey(t) {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function median(xs) {
    const v = xs.filter(finite).sort((a, b) => a - b);
    if (!v.length) return null;
    const i = (v.length - 1) / 2;
    return (v[Math.floor(i)] + v[Math.ceil(i)]) / 2;
  }

  /**
   * Week rows (week.js extractRows) as plain shots: {t, club, carry, side, strikeH}, normal swings
   * only. Accepts rows that carry their clip (c.shot) or plain test rows with the same fields.
   */
  function shotsFromRows(rows) {
    const out = [];
    for (const r of rows || []) {
      if (!r || !finite(r.t)) continue;
      const c = r.c || {};
      if (r.drill || c.drill || r.game || c.game || c.excluded) continue;
      const shot = c.shot || r.shot || null;
      const ball = (shot && shot.ball) || {};
      const cd = (shot && shot.clubData) || {};
      const club = clubCode(r.club || (shot && shot.club));
      if (!club) continue;
      out.push({
        t: r.t,
        club,
        carry: finite(r.carry) ? r.carry : finite(ball.carry) ? ball.carry : null,
        side: finite(r.offline) ? r.offline : finite(ball.side) ? ball.side : null,
        strikeH: finite(r.strikeH) ? r.strikeH : finite(cd.faceImpactH) ? cd.faceImpactH : null,
      });
    }
    return out;
  }

  /** Each shot's 0/1 for a metric (null when it can't be scored). */
  function scorer(metric, stock) {
    if (metric === "short") {
      return s => (finite(s.carry) && finite(stock[s.club]) ? (s.carry <= stock[s.club] - SHORT_YD ? 1 : 0) : null);
    }
    if (metric === "centred") return s => (finite(s.strikeH) ? (Math.abs(s.strikeH) <= CENTRED_MM ? 1 : 0) : null);
    return s => (finite(s.side) ? (Math.abs(s.side) > WIDE_YD ? 1 : 0) : null);
  }

  /** {pct, hits, n, sessions, perSession: [{hits, n}]} for shots already scored ({t, v}). */
  function tally(scored) {
    const bySession = new Map();
    let hits = 0, n = 0;
    for (const s of scored) {
      const k = dayKey(s.t);
      const cur = bySession.get(k) || { hits: 0, n: 0 };
      cur.hits += s.v; cur.n += 1;
      bySession.set(k, cur);
      hits += s.v; n += 1;
    }
    return { pct: n ? hits / n : null, hits, n, sessions: bySession.size, perSession: [...bySession.values()] };
  }

  /**
   * How unsure a rate is, from how much it moved session to session (a ratio estimate's cluster
   * variance), and never less than plain shot counting would say.
   */
  function variance(t) {
    if (!t.n) return null;
    const p = t.hits / t.n, k = t.perSession.length;
    let v = 0;
    if (k > 1) {
      for (const s of t.perSession) v += (s.hits - p * s.n) ** 2;
      v = (k / (k - 1)) * v / (t.n * t.n);
    }
    const pAdj = (t.hits + 0.5) / (t.n + 1);
    return Math.max(v, (pAdj * (1 - pAdj)) / t.n);
  }

  function verdict(week, before, better) {
    if (week.sessions < MIN_SESSIONS) {
      return { verdict: "too early", why: `${week.sessions} session${week.sessions === 1 ? "" : "s"} this week, needs ${MIN_SESSIONS}` };
    }
    if (before.sessions < MIN_SESSIONS) {
      return { verdict: "too early", why: `${before.sessions} session${before.sessions === 1 ? "" : "s"} in the 4 weeks before, needs ${MIN_SESSIONS}` };
    }
    if (week.n < MIN_WEEK_SHOTS) return { verdict: "too early", why: `${week.n} shots this week, needs ${MIN_WEEK_SHOTS}` };
    if (before.n < MIN_BEFORE_SHOTS) return { verdict: "too early", why: `${before.n} shots in the 4 weeks before, needs ${MIN_BEFORE_SHOTS}` };
    const diff = week.pct - before.pct;
    const z = diff / Math.sqrt(variance(week) + variance(before));
    if (Math.abs(diff) < MIN_CHANGE || Math.abs(z) < CLEAR_Z) return { verdict: "no clear change", why: null, diff, z };
    const improved = better === "lower" ? diff < 0 : diff > 0;
    return { verdict: improved ? "better" : "worse", why: null, diff, z };
  }

  /**
   * The scoreboard for the week starting weekStartMs (local Monday 00:00). A row only says better
   * or worse when this week AND last week each said so against their own 4 weeks before: one good
   * or bad week is "too early" too (the owner judges by trends, two weeks at the least).
   * @returns {{weekStart, weekEnd, beforeStart, rows: Array<{group, metric, label, better, week,
   *   before, byWeek: Array<{start, pct, n}>, verdict, why, thisWeek, lastWeek}>}}
   */
  function build(shots, weekStartMs) {
    const model = compute(shots, weekStartMs);
    const last = compute(shots, weekStartMs - WEEK_MS);
    for (const r of model.rows) {
      const prev = last.rows.find(p => p.group === r.group && p.metric === r.metric);
      r.thisWeek = r.verdict;
      r.lastWeek = prev ? prev.verdict : "too early";
      if ((r.verdict === "better" || r.verdict === "worse") && r.lastWeek !== r.verdict) {
        r.why = `${r.verdict} this week, needs a second ${r.verdict} week in a row`;
        r.verdict = "too early";
      }
    }
    return model;
  }

  /** One week against its 4 weeks before, without the two weeks in a row rule. */
  function compute(shots, weekStartMs) {
    const weekStart = weekStartMs, weekEnd = weekStartMs + WEEK_MS;
    const beforeStart = weekStartMs - BEFORE_WEEKS * WEEK_MS;
    const span = (shots || []).filter(s => s.t >= beforeStart && s.t < weekEnd);

    // Each club's median carry over the five weeks: the one yardstick for both sides.
    const carries = {};
    for (const s of span) if (finite(s.carry)) (carries[s.club] = carries[s.club] || []).push(s.carry);
    const stock = {};
    for (const [club, cs] of Object.entries(carries)) if (cs.length >= MIN_STOCK_SHOTS) stock[club] = median(cs);

    const rows = [];
    for (const g of GROUPS) {
      const gShots = span.filter(s => g.clubs.includes(s.club));
      for (const metric of g.metrics) {
        const score = scorer(metric, stock);
        const scored = gShots.map(s => ({ t: s.t, v: score(s) })).filter(s => s.v != null);
        const week = tally(scored.filter(s => s.t >= weekStart));
        const before = tally(scored.filter(s => s.t < weekStart));
        if (!week.n && !before.n) continue;
        const byWeek = [];
        for (let i = BEFORE_WEEKS; i >= 0; i--) {
          const from = weekStart - i * WEEK_MS, to = from + WEEK_MS;
          const w = tally(scored.filter(s => s.t >= from && s.t < to));
          byWeek.push({ start: from, pct: w.pct, n: w.n });
        }
        const m = METRICS[metric];
        const v = verdict(week, before, m.better);
        rows.push({
          group: g.key, metric, label: `${g.label}, ${m.label}`, better: m.better,
          week: strip(week), before: strip(before), byWeek, verdict: v.verdict, why: v.why,
        });
      }
    }
    return { weekStart, weekEnd, beforeStart, rows };
  }

  function strip(t) {
    return { pct: t.pct, hits: t.hits, n: t.n, sessions: t.sessions };
  }

  function pctText(p) {
    return p == null ? "none" : `${Math.round(p * 100)}%`;
  }

  function shortDate(ms) {
    return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function sideText(t) {
    if (!t.n) return "no shots";
    return `${pctText(t.pct)} (${t.n} shot${t.n === 1 ? "" : "s"}, ${t.sessions} session${t.sessions === 1 ? "" : "s"})`;
  }

  function verdictText(row) {
    if (row.verdict === "too early") return `Too early: ${row.why}.`;
    if (row.verdict === "no clear change") return "No clear change.";
    return row.verdict === "better" ? "Better." : "Worse.";
  }

  /** The scoreboard as the brief's lines (the page shows them and Copy for coach sends them). */
  function lines(model) {
    if (!model || !model.rows.length) return [];
    const out = [
      `This week against the 4 weeks before (${shortDate(model.beforeStart)} to ${shortDate(model.weekStart - DAY_MS)}). Normal swings only: no drills, warm up or games.`,
    ];
    for (const r of model.rows) {
      const series = r.byWeek.map(w => (w.pct == null ? "–" : pctText(w.pct))).join(" · ");
      out.push(`${r.label}: ${sideText(r.week)} this week vs ${sideText(r.before)} before. ${verdictText(r)} By week, oldest first: ${series}.`);
    }
    out.push(`${SHORT_YD}+ yd short: carry at least ${SHORT_YD} yd under that club's median over these 5 weeks. Centred: within ${CENTRED_MM} mm of the centre, heel to toe.`);
    out.push(`Better or worse needs ${MIN_SESSIONS}+ sessions this week and in the 4 weeks before, a change of 5+ points that is more than twice its session to session wobble, and the same call two weeks in a row. One good or bad session, or week, is not a trend.`);
    return out;
  }

  return {
    GROUPS, METRICS, SHORT_YD, CENTRED_MM, WIDE_YD, MIN_SESSIONS, MIN_WEEK_SHOTS, MIN_BEFORE_SHOTS,
    clubCode, shotsFromRows, build, lines, variance, verdict,
  };
});
