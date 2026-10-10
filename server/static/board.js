// Progress's scoreboard: a session's score, its skills, your personal bests and how much you practise.
//
// The score is built from the good-shot rules (goodshots.js), one at a time. A shot is good when it
// passes all of them; here each rule is a skill of its own, the share of shots that passed it:
//   on line: offline within the club's allowance;
//   distance control: carry inside your usual window with the club;
//   solid strike: smash at or above your usual with the club;
//   middle of the face: struck within the strike allowance of your usual spot.
// The session score is the average of those shares, 0 to 100. Every rule is taken against that
// club's own usual, so a session of wedges and one of long irons compare. A fifth skill, swing
// match, is the share of the body numbers the cameras could read that sat inside the range of your
// good shots; it depends on the cameras, so it stays out of the score.
//
// Works in the browser (window.SwingBoard) and in Node (module.exports).
(function (root) {
  const GoodShots = root.SwingGoodShots || (typeof require !== "undefined" && require("./goodshots.js"));

  // Judged shots a session needs for its score to be compared, and earlier sessions in "usual".
  const MIN_SHOTS = 8, USUAL = 6;
  // Body numbers a swing needs inside known ranges for a swing match.
  const MIN_MATCH = 5;
  const EPS = 1e-9;

  const SKILLS = [
    { key: "line", label: "On line", hint: "finished within the club's offline allowance" },
    { key: "distance", label: "Distance control", hint: "carried inside your usual window with the club" },
    { key: "solid", label: "Solid strike", hint: "smash at or above your usual with the club" },
    { key: "centred", label: "Middle of the face", hint: "struck within the strike allowance of your usual spot" },
    { key: "match", label: "Swing match", hint: "body numbers inside the range of your good shots", video: true },
  ];
  const SCORED = SKILLS.filter(s => !s.video).map(s => s.key);

  const finite = v => typeof v === "number" && Number.isFinite(v);
  const median = xs => {
    const v = xs.filter(finite).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };

  /**
   * Each good-shot rule for one shot: {line, distance, solid, centred}, true / false, or null when it
   * can't be checked (goodshots.js judgeShot skips the same ones). null with no baseline or no carry.
   */
  function rules(s, base, group, settings) {
    const st = GoodShots.withDefaults(settings), r = st[group] || st.irons;
    if (!base || !finite(s.carry) || !finite(s.offline) || !(s.carry > 0)) return null;
    const out = { line: Math.abs(s.offline) <= r.offlinePct / 100 * s.carry + EPS, distance: null, solid: null, centred: null };
    if (finite(base.carry)) {
      out.distance = s.carry >= base.carry * (1 - r.carryBelowPct / 100) - EPS && s.carry <= base.carry * (1 + r.carryAbovePct / 100) + EPS;
    }
    if (finite(base.smash) && finite(s.smash)) out.solid = s.smash >= base.smash - r.smashBelow - EPS;
    if (st.strike.on) {
      const parts = [["strikeH", st.strike.heelToeMm], ["strikeV", st.strike.highLowMm]]
        .filter(([k]) => finite(base[k]) && finite(s[k])).map(([k, max]) => Math.abs(s[k] - base[k]) <= max + EPS);
      if (parts.length) out.centred = parts.every(Boolean);
    }
    return out;
  }

  /**
   * The share of a swing's readable body numbers inside the club's good-shot range (10th to 90th
   * percentile), or null with fewer than MIN_MATCH to go on.
   * @param body {key: number | null} (null: no reading); ranges: goodshots.js ranges for the club
   */
  function swingMatch(body, ranges) {
    if (!body || !ranges) return null;
    let n = 0, inside = 0;
    for (const key in ranges) {
      const g = ranges[key], v = body[key];
      if (!g || !g.enough || !g.reliable || !finite(v)) continue;
      n++;
      if (v >= g.q10 - EPS && v <= g.q90 + EPS) inside++;
    }
    return n >= MIN_MATCH ? inside / n : null;
  }

  /**
   * One session's skills and score.
   * @param rows swing rows ({club, carry, offline, smash, strikeH, strikeV, body})
   * @param ctx {clubs: goodshots.js build().clubs, settings}
   * @returns {n (shots judged), skills: {key: {k, n, rate}}, score (0-100 | null), good, goodRate}
   */
  function session(rows, ctx) {
    const tally = Object.fromEntries(SKILLS.map(s => [s.key, { k: 0, n: 0 }]));
    let n = 0, good = 0, match = 0, matchN = 0;
    for (const row of rows || []) {
      const group = GoodShots.groupOf(row.club), c = group && ctx.clubs && ctx.clubs[row.club];
      if (!c) continue;
      const r = rules(row, c.baseline, group, ctx.settings);
      if (r) {
        n++;
        let all = true;
        for (const key of SCORED) {
          if (r[key] == null) continue;
          tally[key].n++;
          if (r[key]) tally[key].k++;
          else all = false;
        }
        if (all) good++;
      }
      const m = swingMatch(row.body, c.ranges);
      if (m != null) { match += m; matchN++; }
    }
    const skills = {};
    for (const s of SKILLS) skills[s.key] = { ...tally[s.key], rate: tally[s.key].n ? tally[s.key].k / tally[s.key].n : null };
    skills.match = { k: match, n: matchN, rate: matchN ? match / matchN : null };
    const rates = SCORED.map(k => skills[k].rate).filter(finite);
    return { n, skills, good, goodRate: n ? good / n : null,
             score: n && rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length * 100 : null };
  }

  /**
   * The latest session against the last one and the usual.
   * @param sessions [{key, start, rows}] oldest first
   * @param opts {minShots}: judged shots a session needs to be compared (default MIN_SHOTS)
   * @returns {latest, last, enough (the latest has minShots), score: {now, last, usual, best}, skills:
   *   [{key, label, hint, video, now, last, usual, n}], sessions: [{key, start, n, score, skills}]}, or null
   */
  function board(sessions, ctx, opts) {
    const min = (opts && opts.minShots) || MIN_SHOTS;
    const scored = (sessions || []).map(s => ({ key: s.key, start: s.start, ...session(s.rows, ctx) }));
    const latest = scored[scored.length - 1];
    if (!latest) return null;
    const earlier = scored.slice(0, -1).filter(s => s.n >= min);
    const last = earlier[earlier.length - 1] || null, recent = earlier.slice(-USUAL);
    const counted = scored.filter(s => s.n >= min && s.score != null);
    return {
      latest, last, enough: latest.n >= min,
      score: { now: latest.score, last: last ? last.score : null, usual: median(recent.map(s => s.score)),
               best: counted.length ? Math.max(...counted.map(s => s.score)) : null },
      skills: SKILLS.map(s => ({ ...s, now: latest.skills[s.key].rate, n: latest.skills[s.key].n,
        last: last ? last.skills[s.key].rate : null, usual: median(recent.map(x => x.skills[s.key].rate)) })),
      sessions: scored,
    };
  }

  /**
   * Personal bests over the sessions given (oldest first), each {key, label, value, unit, club, t, name
   * (the swing, when it is one), session (its session's key), isNew: set in the latest session}.
   * Session records need MIN_SHOTS judged shots; a carry record has to finish on line.
   */
  function records(sessions, ctx) {
    const out = [], list = sessions || [], latest = list.length ? list[list.length - 1].key : null;
    const add = rec => { if (rec && finite(rec.value)) out.push({ ...rec, isNew: rec.session === latest && list.length > 1 }); };
    let bestScore = null, streak = null;
    const carry = {}, speed = {}, counts = {};
    for (const s of list) {
      const sc = session(s.rows, ctx);
      if (sc.n >= MIN_SHOTS && sc.score != null && (!bestScore || sc.score > bestScore.value)) {
        bestScore = { key: "score", label: "Best session score", value: sc.score, unit: "", t: s.start, session: s.key };
      }
      let run = 0;
      for (const row of s.rows) {
        const group = GoodShots.groupOf(row.club), c = group && ctx.clubs && ctx.clubs[row.club];
        const r = c ? rules(row, c.baseline, group, ctx.settings) : null;
        if (!r) { continue; }
        counts[row.club] = (counts[row.club] || 0) + 1;
        const good = SCORED.every(k => r[k] !== false);
        run = good ? run + 1 : 0;
        if (run >= 2 && (!streak || run > streak.value)) {
          streak = { key: "streak", label: "Most good shots in a row", value: run, unit: "", t: row.t, session: s.key };
        }
        if (r.line && (!carry[row.club] || row.carry > carry[row.club].value)) {
          carry[row.club] = { key: "carry", label: "Longest carry on line", value: row.carry, unit: "yd", club: row.club, t: row.t, name: row.name, session: s.key };
        }
        // A club speed misread high shows as a smash far under your usual: not a record.
        const struck = finite(row.smash) && finite(c.baseline.smash) && row.smash >= c.baseline.smash - 0.1;
        if (struck && finite(row.clubSpeed) && (!speed[row.club] || row.clubSpeed > speed[row.club].value)) {
          speed[row.club] = { key: "speed", label: "Fastest swing", value: row.clubSpeed, unit: "mph", club: row.club, t: row.t, name: row.name, session: s.key };
        }
      }
    }
    add(bestScore);
    add(streak);
    // Clubs with enough shots for a record to mean something, most-hit first.
    const clubs = Object.keys(counts).filter(c => counts[c] >= MIN_SHOTS).sort((a, b) => counts[b] - counts[a]);
    for (const c of clubs) add(carry[c]);
    for (const c of clubs) add(speed[c]);
    return out;
  }

  const DAY = 86400000;
  const dayStart = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  // Monday of the week t falls in (local time).
  const weekStart = t => { const d = new Date(dayStart(t)); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return d.getTime(); };
  const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };

  /**
   * How much you practise: the last `weeks` weeks day by day, this week against a usual one, and how
   * many weeks in a row had a session.
   * @param sessions [{start (ms), n (swings)}] every session, any order
   * @returns {weeks: [[{t, swings, sessions, future}] x 7, Monday first], max (most swings in a day shown),
   *   week: {swings, sessions}, usual: {swings, sessions} (the median of the 4 weeks before, or null),
   *   streak (weeks in a row with a session, the current week counting only once it has one),
   *   total: {swings, sessions, days}}
   */
  function activity(sessions, now, weeks = 12) {
    const byDay = new Map(), byWeek = new Map();
    let swings = 0;
    for (const s of sessions || []) {
      if (!finite(s.start)) continue;
      const d = dayStart(s.start), w = weekStart(s.start);
      const a = byDay.get(d) || { swings: 0, sessions: 0 };
      a.swings += s.n || 0; a.sessions++;
      byDay.set(d, a);
      const b = byWeek.get(w) || { swings: 0, sessions: 0 };
      b.swings += s.n || 0; b.sessions++;
      byWeek.set(w, b);
      swings += s.n || 0;
    }
    const thisWeek = weekStart(now), today = dayStart(now);
    const grid = [];
    for (let i = weeks - 1; i >= 0; i--) {
      const w = addDays(thisWeek, -7 * i);
      grid.push(Array.from({ length: 7 }, (_, k) => {
        const t = addDays(w, k), a = byDay.get(t) || { swings: 0, sessions: 0 };
        return { t, swings: a.swings, sessions: a.sessions, future: t > today };
      }));
    }
    const weekOf = i => byWeek.get(addDays(thisWeek, -7 * i)) || { swings: 0, sessions: 0 };
    const before = [1, 2, 3, 4].map(weekOf);
    let streak = 0;
    for (let i = weekOf(0).sessions ? 0 : 1; weekOf(i).sessions; i++) streak++;
    return {
      weeks: grid, max: Math.max(0, ...grid.flat().map(d => d.swings)),
      week: weekOf(0),
      usual: byWeek.size > 1 ? { swings: median(before.map(w => w.swings)), sessions: median(before.map(w => w.sessions)) } : null,
      streak, total: { swings, sessions: (sessions || []).length, days: byDay.size },
    };
  }

  const api = { MIN_SHOTS, USUAL, MIN_MATCH, SKILLS, SCORED, rules, swingMatch, session, board, records, activity, weekStart, dayStart };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingBoard = api;
})(typeof window !== "undefined" ? window : globalThis);
