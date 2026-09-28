// Practice games: target planning and tour-baseline strokes gained scoring.
//
// Calculates strokes gained against a PGA Tour baseline (from Mark Broadie's "Every Shot Counts")
// for shots hit into a net without rollout: carry and offline give distance to pin and green status.
// Defines practice games (Combine, Wedge ladder, Random pick, Ladder) with deterministic seeded targets.
//
// Works in the browser (window.SwingGames), in Node (module.exports), and in py_mini_racer.
(function (root) {
  // Green radius in yards; shots finishing within this distance count as on the green.
  const GREEN_RADIUS_YD = 15;

  // Strokes gained penalty assigned to mishits in session summary.
  const MISHIT_SG = -1.0;

  // Expected strokes to hole out on the green (PGA Tour baseline) by distance in feet.
  const PUTT_BASELINE = [
    [2, 1.01],
    [3, 1.04],
    [4, 1.13],
    [5, 1.23],
    [6, 1.34],
    [8, 1.50],
    [10, 1.61],
    [15, 1.78],
    [20, 1.87],
    [30, 1.98],
    [40, 2.06],
    [50, 2.14],
    [60, 2.21],
    [90, 2.40],
  ];

  // Expected strokes to hole out from the fairway (PGA Tour baseline) by distance in yards.
  const FAIRWAY_BASELINE = [
    [20, 2.40],
    [40, 2.60],
    [60, 2.70],
    [80, 2.75],
    [100, 2.80],
    [120, 2.85],
    [140, 2.91],
    [160, 2.98],
    [180, 3.05],
    [200, 3.19],
    [220, 3.32],
    [240, 3.45],
  ];

  // The 9 target yardages for the Combine game.
  const COMBINE_TARGETS = [50, 65, 80, 95, 110, 125, 140, 155, 170];

  // Number of shots per target in the Combine game (27 shots total).
  const COMBINE_SHOTS_PER_TARGET = 3;

  // Ordered targets for the Wedge ladder game (40 to 100 yd and back down, 13 shots).
  const WEDGE_TARGETS = [40, 50, 60, 70, 80, 90, 100, 90, 80, 70, 60, 50, 40];

  // Default parameters for the Random pick game.
  const RANDOM_DEFAULTS = { count: 20, min: 40, max: 150, step: 5 };

  // Default parameters for the Ladder game.
  const LADDER_DEFAULTS = { min: 50, max: 150, step: 10, count: 30 };

  const finite = v => typeof v === "number" && Number.isFinite(v);

  // Mulberry32: a tiny 32-bit seeded PRNG returning [0, 1).
  function mulberry32(seed) {
    let s;
    if (typeof seed === "number" && Number.isFinite(seed)) {
      s = seed >>> 0 || 1;
    } else if (typeof seed === "string") {
      let h = 2166136261 >>> 0;
      for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      s = h || 1;
    } else {
      s = 1;
    }
    return function () {
      let t = (s += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Linear interpolation on a 2D sorted table [[x, y], ...], clamped at the ends.
  function interpolateTable(table, val) {
    if (val <= table[0][0]) return table[0][1];
    if (val >= table[table.length - 1][0]) return table[table.length - 1][1];
    for (let i = 0; i < table.length - 1; i++) {
      const [x0, y0] = table[i];
      const [x1, y1] = table[i + 1];
      if (val >= x0 && val <= x1) {
        if (x1 === x0) return y0;
        return y0 + ((val - x0) / (x1 - x0)) * (y1 - y0);
      }
    }
    return table[table.length - 1][1];
  }

  // Expected putts on the green by distance in feet (clamped: 1.0 under 2 ft, 2.40 at 90+ ft).
  function expectedPutts(feet) {
    if (!finite(feet)) return null;
    if (feet < 2) return 1.0;
    return interpolateTable(PUTT_BASELINE, feet);
  }

  // Expected strokes from fairway by distance in yards (clamped: 2.40 at 20- yd, 3.45 at 240+ yd).
  function expectedStrokes(yards) {
    if (!finite(yards)) return null;
    return interpolateTable(FAIRWAY_BASELINE, yards);
  }

  /**
   * Score a shot against a target distance in yards.
   * @param {number} target Target distance in yards
   * @param {{carry: number, offline: number}} shot Shot carry and offline in yards
   * @returns {{along: number, side: number, dist: number, onGreen: boolean, sg: number, verdict: string} | null}
   */
  function scoreShot(target, shot) {
    if (!finite(target) || target <= 0) return null;
    if (!shot || typeof shot !== "object") return null;
    if (!finite(shot.carry) || shot.carry <= 0) return null;
    if (!finite(shot.offline)) return null;

    const along = shot.carry - target;
    const side = shot.offline;
    const dist = Math.hypot(along, side);
    const onGreen = dist <= GREEN_RADIUS_YD;

    const eOff = expectedStrokes(target);
    const eEnd = onGreen ? expectedPutts(dist * 3) : expectedStrokes(dist);
    const sg = eOff - eEnd - 1;

    // Spoken phrase (whole yards, plain words, no symbols)
    const parts = [];
    if (Math.abs(along) < 1) {
      parts.push("pin high");
    } else if (along > 0) {
      parts.push(`${Math.round(along)} long`);
    } else {
      parts.push(`${Math.round(-along)} short`);
    }

    if (Math.abs(side) < 1) {
      parts.push("on line");
    } else if (side > 0) {
      parts.push(`${Math.round(side)} right`);
    } else {
      parts.push(`${Math.round(-side)} left`);
    }

    if (onGreen) {
      parts.push("on the green");
    }

    const verdict = parts.join(", ");
    return { along, side, dist, onGreen, sg, verdict };
  }

  /**
   * Summarize a session of practice game results.
   * @param {Array<{target: number, sg: number|null, onGreen?: boolean, dist?: number}>} results
   * @returns {{shots: number, mishits: number, sgTotal: number, sgPerShot: number, greens: number, byTarget: Array<{target: number, shots: number, sgPerShot: number, avgDist: number|null}>}}
   */
  function summarize(results) {
    const list = results || [];
    let mishits = 0;
    let sgTotal = 0;
    let greens = 0;
    const targetMap = new Map();

    for (const r of list) {
      const isMishit = r == null || r.sg == null || !finite(r.sg);
      const shotSg = isMishit ? MISHIT_SG : r.sg;
      if (isMishit) mishits++;
      sgTotal += shotSg;
      if (r && r.onGreen) greens++;

      const target = r && finite(r.target) ? r.target : null;
      if (target != null) {
        let entry = targetMap.get(target);
        if (!entry) {
          entry = { shots: 0, sgTotal: 0, distSum: 0, distCount: 0 };
          targetMap.set(target, entry);
        }
        entry.shots++;
        entry.sgTotal += shotSg;
        if (r && finite(r.dist)) {
          entry.distSum += r.dist;
          entry.distCount++;
        }
      }
    }

    const shots = list.length;
    const sgPerShot = shots > 0 ? sgTotal / shots : 0;

    const byTarget = Array.from(targetMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([target, entry]) => ({
        target,
        shots: entry.shots,
        sgPerShot: entry.shots > 0 ? entry.sgTotal / entry.shots : 0,
        avgDist: entry.distCount > 0 ? entry.distSum / entry.distCount : null,
      }));

    return { shots, mishits, sgTotal, sgPerShot, greens, byTarget };
  }

  // Plan combine game targets: 9 targets x 3 shots = 27 shots, shuffled with no back-to-back repeats.
  function planCombine(options = {}) {
    const rng = mulberry32(options.seed);
    const counts = new Map();
    for (const t of COMBINE_TARGETS) {
      counts.set(t, COMBINE_SHOTS_PER_TARGET);
    }
    let remaining = COMBINE_TARGETS.length * COMBINE_SHOTS_PER_TARGET;
    const result = [];
    let last = null;

    while (remaining > 0) {
      const threshold = Math.ceil((remaining - 1) / 2);
      let mustPick = null;
      for (const [t, c] of counts) {
        if (c > threshold) {
          mustPick = t;
          break;
        }
      }

      let pick;
      if (mustPick !== null) {
        pick = mustPick;
      } else {
        const candidates = [];
        for (const [t, c] of counts) {
          if (c > 0 && t !== last) {
            candidates.push(t);
          }
        }
        const idx = Math.floor(rng() * candidates.length);
        pick = candidates[idx];
      }

      result.push(pick);
      counts.set(pick, counts.get(pick) - 1);
      last = pick;
      remaining--;
    }

    return result;
  }

  // Plan random pick game targets: options.count (default 20) targets, uniform from min..max rounded to 5 yd.
  function planRandom(options = {}) {
    const count = options.count ?? RANDOM_DEFAULTS.count;
    const min = options.min ?? RANDOM_DEFAULTS.min;
    const max = options.max ?? RANDOM_DEFAULTS.max;
    const step = options.step ?? RANDOM_DEFAULTS.step;
    const rng = mulberry32(options.seed);
    const lo = Math.ceil(min / step);
    const hi = Math.floor(max / step);
    const numSteps = Math.max(1, hi - lo + 1);
    const targets = [];
    for (let i = 0; i < count; i++) {
      const s = lo + Math.floor(rng() * numSteps);
      targets.push(s * step);
    }
    return targets;
  }

  // Next target for ladder game: steps +10 yd after each green hit, stops after max or options.count shots.
  function nextLadder(options = {}, history = []) {
    const min = options.min ?? LADDER_DEFAULTS.min;
    const max = options.max ?? LADDER_DEFAULTS.max;
    const step = options.step ?? LADDER_DEFAULTS.step;
    const count = options.count ?? LADDER_DEFAULTS.count;

    const hist = history || [];
    if (hist.length >= count) return null;

    let target = min;
    for (const h of hist) {
      if (h && h.target >= max && h.onGreen) {
        return null;
      }
      if (h && h.onGreen) {
        target = (h.target ?? target) + step;
      } else if (h) {
        target = h.target ?? target;
      }
    }
    return target;
  }

  const GAMES = {
    combine: {
      id: "combine",
      name: "Combine",
      describe: "Combine: 27 shots at 9 targets from 50 to 170 yards. Pick the club you would play.",
      clubsHint: "any",
      plan: function (options) {
        return planCombine(options);
      },
      next: function (options, history) {
        const p = this.plan(options);
        const idx = history ? history.length : 0;
        return idx < p.length ? p[idx] : null;
      },
    },
    wedges: {
      id: "wedges",
      name: "Wedge ladder",
      describe: "Wedge ladder: 13 shots from 40 to 100 yards and back down. Pick the club you would play.",
      clubsHint: "any",
      plan: function () {
        return [...WEDGE_TARGETS];
      },
      next: function (options, history) {
        const p = this.plan(options);
        const idx = history ? history.length : 0;
        return idx < p.length ? p[idx] : null;
      },
    },
    random: {
      id: "random",
      name: "Random pick",
      describe: "Random pick: 20 random targets from 40 to 150 yards. Pick the club you would play.",
      clubsHint: "any",
      plan: function (options) {
        return planRandom(options);
      },
      next: function (options, history) {
        const p = this.plan(options);
        const idx = history ? history.length : 0;
        return idx < p.length ? p[idx] : null;
      },
    },
    ladder: {
      id: "ladder",
      name: "Ladder",
      describe: "Ladder: climb from 50 to 150 yards by hitting each green. Pick the club you would play.",
      clubsHint: "any",
      plan: function () {
        return null;
      },
      next: function (options, history) {
        return nextLadder(options, history);
      },
    },
  };

  const api = {
    GREEN_RADIUS_YD,
    MISHIT_SG,
    PUTT_BASELINE,
    FAIRWAY_BASELINE,
    COMBINE_TARGETS,
    COMBINE_SHOTS_PER_TARGET,
    WEDGE_TARGETS,
    RANDOM_DEFAULTS,
    LADDER_DEFAULTS,
    mulberry32,
    expectedPutts,
    expectedStrokes,
    scoreShot,
    summarize,
    GAMES,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SwingGames = api;
})(typeof window !== "undefined" ? window : globalThis);
