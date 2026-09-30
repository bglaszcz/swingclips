// Named swing faults that come together: within-club links via Cochran-Mantel-Haenszel.
// Controls for club confounding (long clubs have more of most faults), skips opposing faults,
// and corrects multiple testing with Benjamini-Hochberg.
//
// Works in the browser (window.SwingFaultLinks) and in Node (module.exports).
(function (root) {
  const Faults = root.SwingFaults || (typeof require !== "undefined" && require("./faults.js"));
  const Helps = root.SwingHelps || (typeof require !== "undefined" && require("./helps.js"));
  const Coach = root.SwingCoach || (typeof require !== "undefined" && require("./coach.js"));

  const MIN_CLUB_SWINGS = 4;
  const MIN_TOTAL_SWINGS = 12;
  const Q_STRONG = 0.05;
  const Q_WATCHING = 0.2;

  // Phase in the swing and phrasing for each named fault in Faults.FAULTS:
  // P6 delivery comes before P7 impact.
  const FAULT_META = {
    "early extension": { phase: "p7", order: 2, action: "early-extend", descriptor: "early extension swings" },
    "standing up": { phase: "p7", order: 2, action: "stand up", descriptor: "standing up swings" },
    "over the top": { phase: "p6", order: 1, action: "go over the top", descriptor: "over-the-top swings" },
    "head toward the ball": { phase: "p7", order: 2, action: "move head toward the ball", descriptor: "head toward the ball swings" },
    "hip slide": { phase: "p7", order: 2, action: "slide hips", descriptor: "hip slide swings" },
    "head dip": { phase: "p7", order: 2, action: "dip head", descriptor: "head dip swings" },
    "casting": { phase: "p6", order: 1, action: "cast", descriptor: "casting swings" },
    "head lift": { phase: "p7", order: 2, action: "lift head", descriptor: "head lift swings" },
  };

  const finite = v => typeof v === "number" && Number.isFinite(v);

  function coachEntry(move, dir) {
    const c = root.SwingCoach || Coach;
    return (c && c.MOVES && c.MOVES[move] && c.MOVES[move][dir]) || {};
  }

  function valueOf(row, key) {
    if (!row) return null;
    const v = row.shown && row.shown[key] != null ? row.shown[key] : row[key];
    return finite(v) ? v : null;
  }

  function isReadable(row, key, shaky) {
    if (!row) return false;
    const v = valueOf(row, key);
    if (v == null) return false;
    if (row.trust && row.trust[key] && row.trust[key].level === "none") return false;
    if (typeof shaky === "function") {
      if (shaky(row, key)) return false;
    } else if (row.trust && row.trust[key] && row.trust[key].level === "shaky") {
      return false;
    }
    return true;
  }

  /** Normal two-sided p value from z via Abramowitz & Stegun 7.1.26. */
  function pNormTwoSided(z) {
    if (!finite(z)) return null;
    const x = Math.abs(z);
    const p = 0.3275911;
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
    const t = 1 / (1 + p * (x / Math.SQRT2));
    const erfc = (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
    return Math.min(1, Math.max(0, erfc));
  }

  /** Reuses Benjamini-Hochberg from helps.js if available, with standalone fallback. */
  function bh(ps) {
    if (root.SwingHelps && typeof root.SwingHelps.bh === "function") {
      return root.SwingHelps.bh(ps);
    }
    if (Helps && typeof Helps.bh === "function") {
      return Helps.bh(ps);
    }
    const idx = ps.map((p, i) => [p, i]).filter(([p]) => p != null).sort((a, b) => a[0] - b[0]);
    const m = idx.length, q = ps.map(() => null);
    let min = 1;
    for (let k = m - 1; k >= 0; k--) {
      min = Math.min(min, idx[k][0] * m / (k + 1));
      q[idx[k][1]] = min;
    }
    return q;
  }

  /**
   * Cochran-Mantel-Haenszel pooled test across 2x2 strata tables.
   * Each stratum: { a, b, c, d, total } where a = both, b = A only, c = B only, d = neither.
   */
  function cochranMantelHaenszel(tables) {
    let sumA = 0, sumE = 0, sumVar = 0;
    let numOR = 0, denOR = 0;
    let usedClubs = 0;

    for (const tab of tables) {
      const { a, b, c, d, total: T } = tab;
      if (!T || T < 2) continue;
      usedClubs++;
      const n1 = a + b, n2 = c + d, m1 = a + c, m2 = b + d;
      const E = (n1 * m1) / T;
      const V = (n1 * n2 * m1 * m2) / (T * T * (T - 1));
      sumA += a;
      sumE += E;
      sumVar += V;
      numOR += (a * d) / T;
      denOR += (b * c) / T;
    }

    const diff = sumA - sumE;
    const z = sumVar > 1e-12 ? diff / Math.sqrt(sumVar) : 0;
    const chi2 = z * z;
    const p = sumVar > 1e-12 ? pNormTwoSided(z) : 1;
    const or = denOR > 1e-12 ? numOR / denOR : (numOR > 1e-12 ? Infinity : 1);

    return { or, chi2, z, p, usedClubs, sumVar };
  }

  function cap(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
  }

  /**
   * Generates the golfer-language sentence explaining the link, evidence, and drill.
   */
  function formatSentence(link) {
    const a = link.a, b = link.b;
    const pWithA = Math.round(link.shareWithA * 100);
    const pWithoutA = Math.round(link.shareWithoutA * 100);

    const descA = a.descriptor || `${a.name} swings`;
    const actB = b.action || b.name;

    const base = `${cap(a.name)} and ${b.name} tend to come together (${pWithA}% of your ${descA} also ${actB}, against ${pWithoutA}% of the rest, same club).`;
    if (link.earlier) {
      return `${base} ${cap(link.earlier.name)} comes first in the swing: try its drill for a session and see if ${b.name} drops too.`;
    }
    const phaseName = a.phase === "p6" ? "delivery" : "impact";
    return `${base} Both show at ${phaseName}: try ${a.name}'s drill for a session and see if ${b.name} drops too.`;
  }

  /**
   * Tests all valid pairs of named faults for association, stratified by club.
   *
   * @param rows array of swing rows
   * @param shaky optional callback (row, key) => boolean
   * @param options { minClubSwings, minTotalSwings, qStrong, qWatching, all }
   * @returns array of link objects, sorted strongest first. By default returns only "Strong" and "Worth watching".
   */
  function links(rows, shaky, options = {}) {
    const faultDefs = (Faults && Faults.FAULTS) || [];
    if (!faultDefs.length || !rows || !rows.length) return [];

    const minClub = options.minClubSwings ?? MIN_CLUB_SWINGS;
    const minTotal = options.minTotalSwings ?? MIN_TOTAL_SWINGS;
    const qStrong = options.qStrong ?? Q_STRONG;
    const qWatching = options.qWatching ?? Q_WATCHING;

    // Build enriched fault definitions with phase and coach drill/thought
    const enriched = faultDefs.map((f, idx) => {
      const meta = FAULT_META[f.name] || { phase: "p7", order: 2, action: f.name, descriptor: `${f.name} swings` };
      const ce = coachEntry(f.move, f.dir);
      return {
        idx,
        key: f.key,
        name: f.name,
        move: f.move,
        dir: f.dir,
        threshold: f.threshold,
        test: f.test,
        phase: meta.phase,
        order: meta.order,
        action: meta.action,
        descriptor: meta.descriptor,
        drill: ce.drill || "",
        thought: ce.thought || "",
      };
    });

    const candidates = [];

    for (let i = 0; i < enriched.length; i++) {
      for (let j = i + 1; j < enriched.length; j++) {
        const f1 = enriched[i], f2 = enriched[j];
        // Skip pairs that cannot happen together or are one number both ways (head dip & head lift share headRise)
        if (f1.key === f2.key || (f1.key === "headRise" && f2.key === "headRise")) continue;

        // Order pair so earlier phase comes first
        let a = f1, b = f2;
        if (f1.order > f2.order) {
          a = f2;
          b = f1;
        }

        // Tally 2x2 contingency table per club
        const clubMap = {};
        let totalReadable = 0;
        let countA = 0, countB = 0, countBoth = 0;

        for (const r of rows) {
          if (!isReadable(r, a.key, shaky) || !isReadable(r, b.key, shaky)) continue;
          const vA = valueOf(r, a.key), vB = valueOf(r, b.key);
          const hasA = a.test(vA);
          const hasB = b.test(vB);

          totalReadable++;
          if (hasA) countA++;
          if (hasB) countB++;
          if (hasA && hasB) countBoth++;

          const club = r.club || "all";
          if (!clubMap[club]) clubMap[club] = { a: 0, b: 0, c: 0, d: 0, total: 0 };
          clubMap[club].total++;
          if (hasA && hasB) clubMap[club].a++;
          else if (hasA && !hasB) clubMap[club].b++;
          else if (!hasA && hasB) clubMap[club].c++;
          else clubMap[club].d++;
        }

        // Filter strata with too few swings
        const strata = [];
        let pooledSwings = 0;
        for (const [cl, tab] of Object.entries(clubMap)) {
          if (tab.total >= minClub) {
            strata.push(tab);
            pooledSwings += tab.total;
          }
        }

        if (pooledSwings < minTotal || totalReadable < minTotal) {
          continue;
        }

        const cmh = cochranMantelHaenszel(strata);
        const shareWithA = countA > 0 ? countBoth / countA : 0;
        const shareWithoutA = (totalReadable - countA) > 0 ? (countB - countBoth) / (totalReadable - countA) : 0;

        const candidate = {
          a,
          b,
          earlier: a.order < b.order ? a : null,
          n: totalReadable,
          pooledSwings,
          clubs: cmh.usedClubs,
          countA,
          countB,
          countBoth,
          shareA: countA / totalReadable,
          shareB: countB / totalReadable,
          shareWithA,
          shareWithoutA,
          or: cmh.or,
          chi2: cmh.chi2,
          z: cmh.z,
          p: cmh.p,
          q: null,
          label: null,
          clubTables: clubMap,
        };
        candidate.sentence = formatSentence(candidate);
        candidates.push(candidate);
      }
    }

    if (!candidates.length) return [];

    // Benjamini-Hochberg correction over all tested pairs
    const qs = bh(candidates.map(c => c.p));
    for (let k = 0; k < candidates.length; k++) {
      const c = candidates[k];
      c.q = qs[k];
      // Only positive associations (OR > 1 and z > 0) represent faults that come together
      if (c.or > 1 && c.z > 0 && c.q != null) {
        if (c.q < qStrong) c.label = "Strong";
        else if (c.q < qWatching) c.label = "Worth watching";
      }
    }

    // Sort strongest first
    const rank = { Strong: 0, "Worth watching": 1 };
    candidates.sort((x, y) => {
      const rx = rank[x.label] ?? 2, ry = rank[y.label] ?? 2;
      return rx - ry || x.q - y.q || y.or - x.or || y.chi2 - x.chi2;
    });

    return options.all ? candidates : candidates.filter(c => c.label != null);
  }

  /**
   * Helper for swing page scorecard: returns short note "Often comes with X"
   * if any other fault on the swing has a strong link with this fault.
   */
  function scorecardNote(fault, strongLinks, swingFaults) {
    if (!fault || !strongLinks || !strongLinks.length || !swingFaults || !swingFaults.length) return null;
    const others = [];
    for (const l of strongLinks) {
      if (l.label !== "Strong") continue;
      let otherName = null;
      if (l.a.name === fault.name) otherName = l.b.name;
      else if (l.b.name === fault.name) otherName = l.a.name;

      if (otherName && swingFaults.some(sf => sf.name === otherName)) {
        if (!others.includes(otherName)) others.push(otherName);
      }
    }
    if (!others.length) return null;
    return `Often comes with ${others.join(", ")}`;
  }

  const api = {
    FAULT_META,
    MIN_CLUB_SWINGS,
    MIN_TOTAL_SWINGS,
    Q_STRONG,
    Q_WATCHING,
    valueOf,
    isReadable,
    pNormTwoSided,
    cochranMantelHaenszel,
    formatSentence,
    scorecardNote,
    links,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingFaultLinks = api;
})(typeof window !== "undefined" ? window : globalThis);
