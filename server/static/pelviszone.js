// Pelvis vs ball at impact (the coach's shift check).
// Calibrates a personal target zone from the owner's best low-point swings.
//
// Works in the browser (window.SwingPelvisZone) and in Node (module.exports).
(function (root) {
  const DEFAULTS = {
    attackMin: -6,       // Flush gate: attack angle from -6 to -3 degrees
    attackMax: -3,
    strikeVMin: -6,      // Flush gate: strike height from -6 to +6 mm (re-centred on the face: app.recentre_strike)
    strikeVMax: 6,
    minTotal: 30,        // At least 30 swings with this club
    minBest: 8,          // At least 8 best low-point swings
  };

  const COLORS = {
    in: "#22c55e",       // Green = in the target zone
    close: "#f59e0b",    // Amber = close (within 1 in of it)
    out: "#94a3b8",      // Gray = not met (never red)
  };

  const finite = v => typeof v === "number" && Number.isFinite(v);

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  function pearson(xs, ys) {
    const n = xs.length;
    if (n < 3) return null;
    const mx = xs.reduce((s, x) => s + x, 0) / n;
    const my = ys.reduce((s, y) => s + y, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx;
      const dy = ys[i] - my;
      sxy += dx * dy;
      sxx += dx * dx;
      syy += dy * dy;
    }
    return (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : null;
  }

  function normClub(c) {
    if (!c || typeof c !== "string") return "";
    const s = c.trim().toUpperCase();
    const m = s.match(/^([A-Z]+)(\d+)$/);
    if (m) return m[2] + m[1];
    return s;
  }

  function matchClub(c1, c2) {
    if (!c2) return true;
    if (!c1) return false;
    return c1 === c2 || normClub(c1) === normClub(c2);
  }

  function extractValues(s) {
    const club = s.club || s.shot?.club || s.shot?.squareClub || s.c?.shot?.club || null;

    let pelvis = null;
    if (finite(s.pelvisBall)) pelvis = s.pelvisBall;
    else if (s.body && finite(s.body.pelvisBall)) pelvis = s.body.pelvisBall;
    else if (s.record?.body && finite(s.record.body.pelvisBall)) pelvis = s.record.body.pelvisBall;
    else if (s.shown && finite(s.shown.pelvisBall)) pelvis = s.shown.pelvisBall;

    let attack = null;
    const cd = s.clubData || s.shot?.clubData || s.c?.shot?.clubData;
    if (cd && finite(cd.angleOfAttack)) attack = cd.angleOfAttack;
    else if (finite(s.attack)) attack = s.attack;
    else if (finite(s.angleOfAttack)) attack = s.angleOfAttack;

    let strikeV = null;
    if (cd && finite(cd.faceImpactV)) strikeV = cd.faceImpactV;
    else if (finite(s.strikeV)) strikeV = s.strikeV;
    else if (finite(s.faceImpactV)) strikeV = s.faceImpactV;

    return { club, pelvis, attack, strikeV };
  }

  /**
   * Calibrates the target zone for pelvis vs ball at impact from the owner's best swings.
   * @param swings array or object of swing records (e.g. /api/swings or list of clips/rows)
   * @param club the club identifier (e.g. "I7", "7I")
   * @param opts optional overrides for DEFAULTS
   * @returns {{ n, best, need, enough, zone: {lo, hi} | null, r, median, minTotal, minBest }}
   */
  function zone(swings, club, opts) {
    const opt = { ...DEFAULTS, ...(opts || {}) };
    const minTotal = finite(opt.minTotal) ? opt.minTotal : DEFAULTS.minTotal;
    const minBest = finite(opt.minBest) ? opt.minBest : DEFAULTS.minBest;

    let list = [];
    if (Array.isArray(swings)) {
      list = swings;
    } else if (swings && typeof swings === "object") {
      if (Array.isArray(swings.swings)) list = swings.swings;
      else if (swings.swings && typeof swings.swings === "object") list = Object.values(swings.swings);
      else list = Object.values(swings);
    }

    const valid = [];
    for (const item of list) {
      if (!item) continue;
      const v = extractValues(item);
      if (!matchClub(v.club, club)) continue;
      if (v.pelvis == null || v.attack == null || v.strikeV == null) continue;
      valid.push(v);
    }

    const n = valid.length;
    const bestSwings = valid.filter(v =>
      v.attack >= opt.attackMin && v.attack <= opt.attackMax &&
      v.strikeV >= opt.strikeVMin && v.strikeV <= opt.strikeVMax
    );
    const best = bestSwings.length;

    const enough = n >= minTotal && best >= minBest;
    const need = {
      swings: Math.max(0, minTotal - n),
      best: Math.max(0, minBest - best),
    };

    let targetZone = null;
    let median = null;
    if (best > 0) {
      const bestVals = bestSwings.map(v => v.pelvis).sort((a, b) => a - b);
      median = quantile(bestVals, 0.5);
      if (enough) {
        targetZone = {
          lo: quantile(bestVals, 0.25),
          hi: quantile(bestVals, 0.75),
        };
      }
    }

    const xs = valid.map(v => v.pelvis);
    const ys = valid.map(v => v.attack);
    const r = pearson(xs, ys);

    return {
      n,
      best,
      need,
      enough,
      zone: targetZone,
      r,
      median,
      minTotal,
      minBest,
    };
  }

  /**
   * Places a pelvisBall value relative to the target zone.
   * @param value pelvisBall (inches, + = ahead of ball)
   * @param targetZone { lo, hi } or null
   * @returns {"in" | "close" | "out"}
   */
  function place(value, targetZone) {
    if (!targetZone || !finite(value) || !finite(targetZone.lo) || !finite(targetZone.hi)) {
      return "out";
    }
    const EPS = 1e-9;
    if (value >= targetZone.lo - EPS && value <= targetZone.hi + EPS) return "in";
    if (value >= targetZone.lo - 1.0 - EPS && value <= targetZone.hi + 1.0 + EPS) return "close";
    return "out";
  }

  /**
   * Status color: green for "in", amber for "close", gray for "out". Never red.
   */
  function color(statusOrValue, targetZone) {
    const status = typeof statusOrValue === "string" ? statusOrValue : place(statusOrValue, targetZone);
    return COLORS[status] || COLORS.out;
  }

  /**
   * Formats a clear one-line coach sentence: plain position + goal, no fault names.
   * @param value pelvisBall value (inches)
   * @param zoneResult result from zone(...) or null
   * @returns {string}
   */
  function sentence(value, zoneResult) {
    let posText;
    if (!finite(value)) {
      posText = "Pelvis vs ball: no reading.";
    } else if (Math.abs(value) < 0.05) {
      posText = "Pelvis at the ball at impact.";
    } else if (value > 0) {
      posText = `Pelvis ${value.toFixed(1)} in ahead of the ball at impact.`;
    } else {
      posText = `Pelvis ${Math.abs(value).toFixed(1)} in behind the ball at impact.`;
    }

    let targetText;
    if (zoneResult && zoneResult.enough && zoneResult.zone) {
      const lo = zoneResult.zone.lo;
      const hi = zoneResult.zone.hi;
      const fmt = x => ((x > 0 ? "+" : "") + x.toFixed(1)).replace(/^[+-]?0(\.0+)?$/, "0");
      targetText = `Target: ${fmt(lo)} to ${fmt(hi)} in.`;
    } else {
      const n = zoneResult?.n ?? 0;
      const minTotal = zoneResult?.minTotal ?? DEFAULTS.minTotal;
      const best = zoneResult?.best ?? 0;
      const minBest = zoneResult?.minBest ?? DEFAULTS.minBest;
      targetText = n >= minTotal ? `Target: not set yet (${best} of ${minBest} best swings).`
        : `Target: not set yet (${n} of ${minTotal} swings, ${best} of ${minBest} best).`;
    }

    return `${posText} ${targetText}`;
  }

  const api = {
    DEFAULTS,
    COLORS,
    zone,
    place,
    color,
    sentence,
    quantile,
    pearson,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingPelvisZone = api;
})(typeof window !== "undefined" ? window : globalThis);
