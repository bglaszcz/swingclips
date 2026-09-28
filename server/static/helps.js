// What helps, what hurts: with one club, how each body move goes with each result, across sessions.
//
// Within sessions first: each swing's move and result are taken against that session's own mean,
// which cancels what changes from day to day (warm-up, fatigue, where the cameras stood). The
// deviations are pooled over the club's sessions into one slope (the within-session regression) and
// its correlation, tested with a t test on n - sessions - 1 degrees of freedom. With ~18 moves x ~14
// results, some links look strong by luck, so the p values get a false-discovery correction
// (Benjamini-Hochberg, over every pair tested with the club). Then each link gets a label:
//   confirmed: q < 0.05, and the same direction in at least 3 sessions and 3 in 4 of those with
//     enough swings to say (MIN_SESSION);
//   emerging: q < 0.2 (or q < 0.05 without enough sessions yet), and not the other way round in
//     most sessions;
//   could be chance: the rest (not listed).
// Between sessions (session means against session means) is shown alongside once there are
// MIN_BETWEEN sessions; body numbers either side of a camera move don't compare, so it doesn't count
// toward the label.
//
// This describes your swings: it doesn't prove a move causes a result (both may follow from
// something else). Works in the browser (window.SwingHelps) and in Node (module.exports).
(function (root) {
  const Summary = root.SwingSummary || (typeof require !== "undefined" && require("./summary.js"));

  // Swings with both numbers a session needs to take part (fewer: its mean is mostly the swings).
  const MIN_IN_SESSION = 3;
  // Swings with both numbers a session needs for its own direction to count.
  const MIN_SESSION = 8;
  // Pooled swings a pair needs to be tested at all.
  const MIN_PAIRS = 15;
  const MIN_BETWEEN = 5;
  const Q_CONFIRMED = 0.05, Q_EMERGING = 0.2;
  const EPS = 1e-12;

  // The results: Square's numbers (summary.js SHOT), and a few worked out from them. `better`: which
  // way helps, where there is one ("up", "down"); the rest are shown as links, neither help nor hurt.
  // `more` / `less`: how a higher / lower value is said.
  const RESULTS = [
    { key: "carry", label: "Carry", unit: "yd", better: "up", more: "longer", less: "shorter" },
    { key: "absOffline", label: "Distance offline", unit: "yd", better: "down", more: "further offline", less: "closer to the line",
      from: s => s.offline == null ? null : Math.abs(s.offline) },
    { key: "offline", label: "Offline", unit: "yd", more: "further right", less: "further left" },
    { key: "smash", label: "Smash", unit: "", better: "up", more: "higher", less: "lower" },
    { key: "ballSpeed", label: "Ball speed", unit: "mph", better: "up", more: "faster", less: "slower" },
    { key: "clubSpeed", label: "Club speed", unit: "mph", more: "faster", less: "slower" },
    { key: "path", label: "Club path", unit: "°", more: "more in-to-out", less: "more out-to-in" },
    { key: "face", label: "Face to target", unit: "°", more: "more open", less: "more closed" },
    { key: "faceToPath", label: "Face to path", unit: "°", more: "more open to the path (fade side)", less: "more closed to the path (draw side)" },
    { key: "absFaceToPath", label: "Face to path, either way", unit: "°", better: "down", more: "more curve", less: "less curve",
      from: s => s.faceToPath == null ? null : Math.abs(s.faceToPath) },
    { key: "attack", label: "Attack angle", unit: "°", more: "more up", less: "more down" },
    { key: "loft", label: "Dynamic loft", unit: "°", more: "more", less: "less" },
    { key: "launch", label: "Launch", unit: "°", more: "higher", less: "lower" },
    { key: "spin", label: "Spin", unit: "rpm", more: "more", less: "less" },
    { key: "strikeH", label: "Strike toe/heel", unit: "mm", more: "higher", less: "lower" },
    { key: "strikeV", label: "Strike high/low", unit: "mm", more: "higher on the face", less: "lower on the face" },
  ];

  const finite = v => typeof v === "number" && Number.isFinite(v);

  /** A swing's results: Square's numbers plus the worked-out ones ({key: number | null}). */
  function resultNumbers(shotNums) {
    const out = {};
    for (const r of RESULTS) {
      const v = r.from ? r.from(shotNums) : shotNums[r.key];
      out[r.key] = finite(v) ? v : null;
    }
    return out;
  }

  // ---- Statistics ----

  function logGamma(x) {
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
               0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x, tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (const k of c) ser += k / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  }
  // Continued fraction for the incomplete beta (Numerical Recipes betacf).
  function betacf(a, b, x) {
    let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= 200; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
      c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30;
      c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 3e-12) break;
    }
    return h;
  }
  /** The regularized incomplete beta I_x(a, b). */
  function ibeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
  }
  /** Two-sided p value of Student's t with df degrees of freedom. */
  function tTwoSided(t, df) {
    if (!(df > 0) || !finite(t)) return null;
    return ibeta(df / (df + t * t), df / 2, 0.5);
  }

  /** Benjamini-Hochberg q values, in the order the p values came (nulls stay null). */
  function bh(ps) {
    const idx = ps.map((p, i) => [p, i]).filter(([p]) => p != null).sort((a, b) => a[0] - b[0]);
    const m = idx.length, q = ps.map(() => null);
    let min = 1;
    for (let k = m - 1; k >= 0; k--) {
      min = Math.min(min, idx[k][0] * m / (k + 1));
      q[idx[k][1]] = min;
    }
    return q;
  }

  /** A round step near x (1, 2 or 5 times a power of ten) for "each <step> more". */
  function niceStep(x) {
    if (!(x > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(x))), f = x / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  }

  // ---- The links ----

  /**
   * One move against one result, within sessions.
   * @param sessions [[{x, y, shaky}]] (both numbers present)
   * @returns {n, sessions, slope, r, t, df, p, agree, counted, between, shaky, sdX, sdY, median (of y)}
   */
  function link(sessions) {
    let sxx = 0, syy = 0, sxy = 0, n = 0, used = 0, shaky = 0, agree = 0, against = 0;
    const means = [];
    for (const pts of sessions) {
      if (pts.length < MIN_IN_SESSION) continue;
      const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length, my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      let a = 0, b = 0, c = 0;
      for (const p of pts) {
        const dx = p.x - mx, dy = p.y - my;
        a += dx * dx; b += dy * dy; c += dx * dy;
        if (p.shaky) shaky++;
      }
      sxx += a; syy += b; sxy += c; n += pts.length; used++;
      means.push([mx, my, pts.length]);
      if (pts.length >= MIN_SESSION && a > EPS && b > EPS) {
        if (c > 0) agree++;
        else if (c < 0) against++;
      }
    }
    const out = { n, sessions: used, shaky: n > 0 && shaky * 2 > n, sdX: null, sdY: null, slope: null, r: null, p: null };
    const df = n - used - 1;
    if (n < MIN_PAIRS || df < 3 || !(sxx > EPS) || !(syy > EPS)) return out;
    const r = sxy / Math.sqrt(sxx * syy);
    const t = r * Math.sqrt(df / Math.max(EPS, 1 - r * r));
    Object.assign(out, { slope: sxy / sxx, r, t, df, p: tTwoSided(t, df),
      sdX: Math.sqrt(sxx / (n - used)), sdY: Math.sqrt(syy / (n - used)) });
    // Sessions that agree with the pooled direction, of those with enough swings to say.
    out.counted = agree + against;
    out.agree = r > 0 ? agree : against;
    // Between sessions: session means (only ones with enough swings), Pearson.
    // The result's usual value over every swing (which way is "toward neutral", coach.js).
    const ys = sessions.filter(pts => pts.length >= MIN_IN_SESSION).flatMap(pts => pts.map(p => p.y)).sort((a, b) => a - b);
    out.median = ys.length ? (ys[(ys.length - 1) >> 1] + ys[ys.length >> 1]) / 2 : null;
    const m = means.filter(q => q[2] >= MIN_SESSION);
    if (m.length >= MIN_BETWEEN) {
      const c = Summary.correlation(m.map(q => q[0]), m.map(q => q[1]));
      if (c.r != null) out.between = { r: c.r, n: c.n, clear: Math.abs(c.r) >= c.needed };
    }
    return out;
  }

  /** "confirmed", "emerging" or "chance". */
  function labelOf(x) {
    if (x.q == null) return "chance";
    const mostlyAgree = !x.counted || x.agree * 2 > x.counted;
    if (x.q < Q_CONFIRMED && x.counted >= 3 && x.agree >= 3 && x.agree >= 0.75 * x.counted) return "confirmed";
    if (x.q < Q_EMERGING && mostlyAgree) return "emerging";
    return "chance";
  }

  /**
   * Every move against every result with one club.
   * @param sessions [{key, rows: [{body: {key: number | null} | null, shaky: {key: bool}, ...shotNumbers}]}]
   *   (rows' body numbers null with no reading; shaky marks the ones trust.js calls shaky)
   * @param opts {moves: [keys], results: [keys]} to test only some
   * @returns {tested, sessions, swings, links: [{move, result, n, sessions, slope, r, p, q, label,
   *   agree, counted, between, shaky, step, effect, helps}] (every tested pair, strongest first)}
   */
  function analyze(sessions, opts = {}) {
    const moves = Summary.BODY.filter(f => !opts.moves || opts.moves.includes(f.key));
    const results = RESULTS.filter(r => !opts.results || opts.results.includes(r.key));
    const prepared = (sessions || []).map(s => s.rows.filter(r => r.body).map(r => ({ body: r.body, shaky: r.shaky || {}, res: resultNumbers(r) })));
    const links = [];
    for (const mv of moves) {
      for (const rs of results) {
        const pts = prepared.map(rows => rows
          .filter(r => finite(r.body[mv.key]) && finite(r.res[rs.key]))
          .map(r => ({ x: r.body[mv.key], y: r.res[rs.key], shaky: !!r.shaky[mv.key] })));
        const l = link(pts);
        if (l.p == null) continue;
        links.push({ move: mv.key, result: rs.key, ...l });
      }
    }
    const qs = bh(links.map(l => l.p));
    links.forEach((l, i) => {
      l.q = qs[i];
      l.label = labelOf(l);
      const rs = results.find(r => r.key === l.result);
      l.step = niceStep(l.sdX);
      l.effect = l.slope * l.step;
      l.helps = rs.better ? ((rs.better === "up") === (l.effect > 0)) : null;
    });
    const rank = { confirmed: 0, emerging: 1, chance: 2 };
    links.sort((a, b) => rank[a.label] - rank[b.label] || a.q - b.q || Math.abs(b.r) - Math.abs(a.r));
    const swings = prepared.reduce((s, rows) => s + rows.length, 0);
    return { tested: links.length, sessions: prepared.filter(rows => rows.length >= MIN_IN_SESSION).length, swings, links };
  }

  const moveOf = key => Summary.BODY.find(f => f.key === key);
  const resultOf = key => RESULTS.find(r => r.key === key);

  function num(x, unit) {
    const a = Math.abs(x);
    const d = unit === "rpm" ? 0 : unit === "" || unit === ":1" ? 2 : a >= 10 ? 0 : a >= 1 ? 1 : 2;
    return a.toFixed(d);
  }
  function withUnit(x, unit) {
    const n = num(x, unit);
    if (unit === "°") return n + "°";
    if (!unit || unit === ":1") return n;
    return `${n} ${unit}`;
  }

  /**
   * A link in plain words: "Each 0.5 in more hip sway at impact (against your usual that day): carry
   * 3.2 yd shorter".
   */
  function sentence(l) {
    const mv = moveOf(l.move), rs = resultOf(l.result);
    // The step is a round number: shown as it is (0.5, 2, 0.05).
    const step = String(Number(l.step.toPrecision(3)));
    const stepText = !mv.unit || mv.unit === ":1" ? `${step} more` : mv.unit === "°" ? `${step}° more` : `${step} ${mv.unit} more`;
    const way = l.effect >= 0 ? rs.more : rs.less;
    return `Each ${stepText} ${mv.label.charAt(0).toLowerCase() + mv.label.slice(1)} than your usual that day: `
      + `${rs.label.toLowerCase()} ${withUnit(l.effect, rs.unit)} ${way}`;
  }

  /** "6 of 7 sessions", or how many swings when too few sessions had enough to say. */
  function support(l) {
    if (l.counted) return `same way in ${l.agree} of ${l.counted} session${l.counted === 1 ? "" : "s"}`;
    return `${l.n} swings; no session has ${MIN_SESSION} yet`;
  }

  const api = { RESULTS, MIN_IN_SESSION, MIN_SESSION, MIN_PAIRS, MIN_BETWEEN, Q_CONFIRMED, Q_EMERGING,
                resultNumbers, tTwoSided, bh, niceStep, link, labelOf, analyze, sentence, support };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingHelps = api;
})(typeof window !== "undefined" ? window : globalThis);
