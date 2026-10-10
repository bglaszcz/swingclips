// Analysis's explorer: the numbers behind "What goes with what" and "Links at a glance".
//
// Two ways to take one number against another over many sessions:
//   as measured: every swing's own numbers (Pearson's r over all of them);
//   against that day's usual: each swing's numbers less the average of its own group (one session
//     with one club), pooled. This cancels what changes from day to day (warm-up, tiredness, where
//     the cameras stood) and from club to club, so it is the fairer test and the only way to put
//     several clubs on one chart. One degree of freedom is spent per group (as helps.js does).
// The thirds table says the same thing without a statistic: the result in the lowest, middle and
// highest third of the other number.
//
// It describes the swings: it doesn't prove one number causes the other.
// Works in the browser (window.SwingExplore) and in Node (module.exports).
(function (root) {
  const Helps = root.SwingHelps || (typeof require !== "undefined" && require("./helps.js"));

  // Swings a group needs to have a usual of its own.
  const MIN_IN_GROUP = 3;
  // Swings with both numbers before anything is said about a link.
  const MIN_POINTS = 8;
  // Under this |r| a link is called "no real link" whatever the count.
  const WEAK_R = 0.2;

  const finite = v => typeof v === "number" && Number.isFinite(v);

  // Numbers worked out from Square's, on top of summary.js SHOT.
  const EXTRA = [
    { key: "absOffline", label: "Offline, either side", unit: "yd",
      from: s => finite(s.offline) ? Math.abs(s.offline) : null },
    { key: "strikeOff", label: "Strike, distance from the middle", unit: "mm",
      from: s => finite(s.strikeH) && finite(s.strikeV) ? Math.hypot(s.strikeH, s.strikeV) : null },
    { key: "absFaceToPath", label: "Face to path, either way", unit: "°",
      from: s => finite(s.faceToPath) ? Math.abs(s.faceToPath) : null },
  ];

  // What a golfer wants more of, and the number that stands for it. `better`: which way is good.
  const OUTCOMES = [
    { key: "carry", name: "Distance", better: "up" },
    { key: "smash", name: "Solid strikes", better: "up" },
    { key: "absOffline", name: "Straighter", better: "down" },
    { key: "spinAxis", name: "Shot shape", better: null },
    { key: "strikeOff", name: "Middle of the face", better: "down" },
  ];

  /** The worked-out numbers of one swing row: {absOffline, strikeOff, absFaceToPath}. */
  function derive(row) {
    const out = {};
    for (const f of EXTRA) out[f.key] = f.from(row);
    return out;
  }

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  /**
   * The swings that have both numbers.
   * @param rows swing rows ({[key]: number | null})
   * @param groupOf row -> the group its usual is taken over (session key + club), for centered()
   * @returns [{x, y, g, row}]
   */
  function points(rows, xKey, yKey, groupOf) {
    const out = [];
    for (const row of rows || []) {
      const x = row[xKey], y = row[yKey];
      if (finite(x) && finite(y)) out.push({ x, y, g: groupOf ? groupOf(row) : "", row });
    }
    return out;
  }

  /** Each point less its group's mean on both axes; groups with fewer than MIN_IN_GROUP points are left out. */
  function centered(pts) {
    const groups = new Map();
    for (const p of pts) (groups.get(p.g) || groups.set(p.g, []).get(p.g)).push(p);
    const out = [];
    for (const list of groups.values()) {
      if (list.length < MIN_IN_GROUP) continue;
      const mx = list.reduce((s, p) => s + p.x, 0) / list.length, my = list.reduce((s, p) => s + p.y, 0) / list.length;
      for (const p of list) out.push({ x: p.x - mx, y: p.y - my, g: p.g, row: p.row });
    }
    return out;
  }

  /**
   * The straight-line fit of the points.
   * @param lost degrees of freedom already spent: 0 as measured, the number of groups for centered points
   * @returns {n, r, slope, mx, my, sdX, needed, clear, p} (r null with too few points or no spread)
   */
  function fit(pts, lost = 0) {
    const n = pts.length, out = { n, r: null, slope: null, mx: 0, my: 0, sdX: null, needed: null, clear: false, p: null };
    if (n < 3) return out;
    const mx = pts.reduce((s, p) => s + p.x, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of pts) { sxx += (p.x - mx) ** 2; syy += (p.y - my) ** 2; sxy += (p.x - mx) * (p.y - my); }
    out.mx = mx; out.my = my;
    // Centered points: a mean already taken out per group.
    const df = n - 2 - Math.max(0, lost - 1);
    if (df < 3 || !(sxx > 0) || !(syy > 0)) return out;
    const r = sxy / Math.sqrt(sxx * syy);
    // Two-sided 5% t value, approximated (summary.js correlation).
    const t = 1.96 + 2.5 / df + 3 / (df * df);
    out.r = r;
    out.slope = sxy / sxx;
    out.sdX = Math.sqrt(sxx / Math.max(1, n - Math.max(1, lost)));
    out.needed = t / Math.sqrt(df + t * t);
    out.clear = n >= MIN_POINTS && Math.abs(r) >= out.needed;
    if (Helps) out.p = Helps.tTwoSided(r * Math.sqrt(df / Math.max(1e-12, 1 - r * r)), df);
    return out;
  }

  /** The fit of points against their groups' means (centered), with the groups' degrees of freedom taken off. */
  function fitWithin(pts) {
    const c = centered(pts);
    const f = fit(c, new Set(c.map(p => p.g)).size);
    f.groups = new Set(c.map(p => p.g)).size;
    return f;
  }

  /**
   * The points in k equal parts by x, lowest first: the result in each.
   * @returns [{lo, hi, n, rows, med, q1, q3, judged, good}] (fewer than k when x has too few different values);
   *   judged: rows with a good-shot verdict (row.good true or false), good: how many of those were good
   */
  function parts(pts, k = 3) {
    const sorted = [...pts].sort((a, b) => a.x - b.x);
    if (sorted.length < k * MIN_IN_GROUP) return [];
    const out = [];
    let from = 0;
    for (let i = 1; i <= k && from < sorted.length; i++) {
      let to = i === k ? sorted.length : Math.round(sorted.length * i / k);
      // Equal values of x stay in one part.
      while (to < sorted.length && to > from && sorted[to].x === sorted[to - 1].x) to++;
      if (to <= from) continue;
      const list = sorted.slice(from, to), ys = list.map(p => p.y).sort((a, b) => a - b);
      const judged = list.filter(p => p.row && typeof p.row.good === "boolean");
      out.push({ lo: list[0].x, hi: list[list.length - 1].x, n: list.length, rows: list.map(p => p.row),
                 med: quantile(ys, 0.5), q1: quantile(ys, 0.25), q3: quantile(ys, 0.75),
                 judged: judged.length, good: judged.filter(p => p.row.good).length });
      from = to;
    }
    return out;
  }

  /** How strong a link reads: "no real link", or "more x goes with more / less y". */
  function words(f, xLabel, yLabel) {
    if (f.r == null) return "";
    if (Math.abs(f.r) < WEAK_R) return "no real link";
    const low = t => t.charAt(0).toLowerCase() + t.slice(1);
    return `more ${low(xLabel)} goes with ${f.r > 0 ? "more" : "less"} ${low(yLabel)}`;
  }

  /** A round step of x (about one typical swing-to-swing difference) and what the fit says y does over it. */
  function effect(f) {
    if (f.slope == null || !(f.sdX > 0) || !Helps) return null;
    const step = Helps.niceStep(f.sdX);
    return { step, change: f.slope * step };
  }

  /** The middle value of each point and the `win - 1` before it (fewer at the start), for a line through noisy points. */
  function rolling(values, win = 7) {
    return values.map((_, i) => {
      const v = values.slice(Math.max(0, i - win + 1), i + 1).filter(finite).sort((a, b) => a - b);
      return v.length >= Math.min(3, win) ? quantile(v, 0.5) : null;
    });
  }

  /**
   * helps.js's links as a grid: one row per move, one cell per result.
   * @param links SwingHelps.analyze(...).links
   * @returns [{move, cells: [{move, result, r, n, label, helps, q, sessions, agree, counted} | null]}]
   */
  function grid(links, moves, results) {
    const by = new Map((links || []).map(l => [l.move + "|" + l.result, l]));
    return moves.map(move => ({ move, cells: results.map(result => by.get(move + "|" + result) || null) }));
  }

  const api = { MIN_IN_GROUP, MIN_POINTS, WEAK_R, EXTRA, OUTCOMES, derive, quantile, points, centered, fit, fitWithin,
                parts, words, effect, rolling, grid };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingExplore = api;
})(typeof window !== "undefined" ? window : globalThis);
