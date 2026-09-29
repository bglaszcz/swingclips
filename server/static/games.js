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

  // Driving game constants
  const FAIRWAY_HALF_WIDTH_YD = 15;
  const ROUGH_EDGE_YD = 30;
  const DRIVE_HOLE_YD = 400;
  const DRIVE_TEE_EXPECTED = 3.99;
  const DRIVING_SHOTS = 14;

  // Shot shaping game constants
  const SHAPE_MIN_AXIS = 3;
  const SHAPE_MAX_OFFLINE_PCT = 10;
  const SHAPING_SHOTS = 12;

  // Distance control game constants
  const DISTANCE_WINDOW_YD = 5;
  const DISTANCE_DEFAULTS = { count: 15, min: 50, max: 130, step: 5 };

  // Hole builder game constants: 6 par-4 holes, 2 shots per hole (12 shots total).
  const HOLES = [340, 380, 400, 420, 440, 360];
  const HOLES_SHOTS = HOLES.length * 2;

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
   * Score a driving tee shot against a 400 yd par 4 baseline.
   * @param {number} target Target distance in yards (0 for driving)
   * @param {{carry: number, offline: number}} shot Shot carry and offline in yards
   * @returns {{along: number, side: number, dist: number, onGreen: boolean, sg: number, verdict: string} | null}
   */
  function scoreDriving(target, shot) {
    if (!shot || typeof shot !== "object") return null;
    if (!finite(shot.carry) || shot.carry <= 0) return null;
    if (!finite(shot.offline)) return null;

    const along = shot.carry;
    const side = shot.offline;
    const dist = Math.abs(side);
    const absSide = Math.abs(side);

    const rem = DRIVE_HOLE_YD - shot.carry;
    const eBase = expectedStrokes(rem);
    if (!finite(eBase)) return null;

    let eEnd;
    let onGreen;
    let band;
    if (absSide <= FAIRWAY_HALF_WIDTH_YD) {
      eEnd = eBase;
      onGreen = true;
      band = "fairway";
    } else if (absSide <= ROUGH_EDGE_YD) {
      eEnd = eBase + 0.20;
      onGreen = false;
      band = "rough";
    } else {
      eEnd = eBase + 0.60;
      onGreen = false;
      band = "miss";
    }

    const sg = DRIVE_TEE_EXPECTED - eEnd - 1;
    const carryWhole = Math.round(shot.carry);
    let verdict;
    if (band === "fairway") {
      verdict = `fairway, ${carryWhole}`;
    } else {
      const sideDir = side > 0 ? "right" : "left";
      const sideDist = Math.round(absSide);
      if (band === "rough") {
        verdict = `${sideDist} ${sideDir}, rough, ${carryWhole}`;
      } else {
        verdict = `${sideDist} ${sideDir}, a miss, ${carryWhole}`;
      }
    }

    return { along, side, dist, onGreen, sg, verdict };
  }

  /**
   * Score a shot shaping attempt against a called shape ("draw" or "fade").
   * @param {"draw" | "fade"} target Called shape
   * @param {{carry: number, offline: number, spinAxis?: number}} shot Shot details
   * @returns {{along: number, side: number, dist: number, onGreen: boolean, sg: number, verdict: string} | null}
   */
  function scoreShaping(target, shot) {
    if (target !== "draw" && target !== "fade") return null;
    if (!shot || typeof shot !== "object") return null;
    if (!finite(shot.carry) || shot.carry <= 0) return null;
    if (!finite(shot.offline)) return null;
    if (!finite(shot.spinAxis)) return null;

    let shape;
    if (shot.spinAxis <= -SHAPE_MIN_AXIS) {
      shape = "draw";
    } else if (shot.spinAxis >= SHAPE_MIN_AXIS) {
      shape = "fade";
    } else {
      shape = "straight";
    }

    const maxOffline = (SHAPE_MAX_OFFLINE_PCT / 100) * shot.carry;
    const withinLine = Math.abs(shot.offline) <= maxOffline;
    const onGreen = shape === target && withinLine;

    // Strokes gained is not meaningful for shot shaping; return 0 for success,
    // -0.5 for miss so session summaries can still rank sessions.
    const sg = onGreen ? 0 : -0.5;

    let verdict;
    if (shape === target) {
      if (withinLine) {
        verdict = `${shape}, good`;
      } else {
        const sideDir = shot.offline > 0 ? "right" : "left";
        verdict = `${shape}, but ${Math.round(Math.abs(shot.offline))} ${sideDir}`;
      }
    } else {
      verdict = `${shape}, wanted a ${target}`;
    }

    const along = shot.carry;
    const side = shot.offline;
    const dist = Math.abs(shot.offline);

    return { along, side, dist, onGreen, sg, verdict };
  }

  /**
   * Score a distance control shot against a target carry distance in yards.
   * Only the carry counts; direction is ignored.
   * @param {number} target Target carry distance in yards
   * @param {{carry: number, offline?: number}} shot Shot details
   * @returns {{along: number, side: number, dist: number, onGreen: boolean, sg: number, verdict: string} | null}
   */
  function scoreDistance(target, shot) {
    if (!finite(target) || target <= 0) return null;
    if (!shot || typeof shot !== "object") return null;
    if (!finite(shot.carry) || shot.carry <= 0) return null;

    const along = shot.carry - target;
    const side = finite(shot.offline) ? shot.offline : 0;
    const dist = Math.abs(along);
    const onGreen = dist <= DISTANCE_WINDOW_YD;

    // sg: the green table (expectedPutts) at |along| * 3 feet when within 15 yd,
    // else the fairway table at |along|, so sg = expectedStrokes(target) - that - 1;
    // same idea as scoreShot but on carry alone.
    const eOff = expectedStrokes(target);
    const eEnd = dist <= GREEN_RADIUS_YD ? expectedPutts(dist * 3) : expectedStrokes(dist);
    const sg = eOff - eEnd - 1;

    let distWord;
    if (Math.abs(along) < 1) {
      distWord = "pin high";
    } else if (along > 0) {
      distWord = `${Math.round(along)} long`;
    } else {
      distWord = `${Math.round(-along)} short`;
    }

    const verdict = onGreen ? `${distWord}, in` : distWord;
    return { along, side, dist, onGreen, sg, verdict };
  }

  /**
   * Score a hole builder shot.
   * Shot 1: tee shot scored like scoreDriving (30 yd fairway) with sg computed against holeLength baseline.
   * Shot 2: approach shot scored like Combine (scoreShot, green within 15 yd).
   * @param {{hole: number, shot: number, yards: number}} target Target details
   * @param {{carry: number, offline: number}} shot Shot details
   * @returns {{along: number, side: number, dist: number, onGreen: boolean, sg: number, verdict: string} | null}
   */
  function scoreHoles(target, shot) {
    if (!target || typeof target !== "object") return null;
    if (!shot || typeof shot !== "object") return null;
    if (!finite(shot.carry) || shot.carry <= 0) return null;

    if (target.shot === 1) {
      if (!finite(shot.offline)) return null;

      const along = shot.carry;
      const side = shot.offline;
      const dist = Math.abs(side);
      const absSide = Math.abs(side);

      const holeLength = finite(target.yards) ? target.yards : DRIVE_HOLE_YD;
      const rem = holeLength - shot.carry;
      const eBase = expectedStrokes(rem);
      if (!finite(eBase)) return null;

      let eEnd;
      let onGreen;
      let band;
      if (absSide <= FAIRWAY_HALF_WIDTH_YD) {
        eEnd = eBase;
        onGreen = true;
        band = "fairway";
      } else if (absSide <= ROUGH_EDGE_YD) {
        eEnd = eBase + 0.20;
        onGreen = false;
        band = "rough";
      } else {
        eEnd = eBase + 0.60;
        onGreen = false;
        band = "miss";
      }

      const eTee = expectedStrokes(holeLength);
      if (!finite(eTee)) return null;
      const sg = eTee - eEnd - 1;

      const carryWhole = Math.round(shot.carry);
      let verdict;
      if (band === "fairway") {
        verdict = `fairway, ${carryWhole}`;
      } else {
        const sideDir = side > 0 ? "right" : "left";
        const sideDist = Math.round(absSide);
        if (band === "rough") {
          verdict = `${sideDist} ${sideDir}, rough, ${carryWhole}`;
        } else {
          verdict = `${sideDist} ${sideDir}, a miss, ${carryWhole}`;
        }
      }

      return { along, side, dist, onGreen, sg, verdict };
    }

    if (target.shot === 2) {
      const targetYards = finite(target.yards) ? target.yards : 150;
      return scoreShot(targetYards, shot);
    }

    return null;
  }

  /**
   * Score a shot for a given game, dispatching to the game's own scorer if defined.
   * @param {string} gameId Game identifier
   * @param {any} target Game target
   * @param {object} shot Shot details
   * @returns {object | null}
   */
  function scoreFor(gameId, target, shot) {
    const g = GAMES[gameId];
    if (g && typeof g.score === "function") {
      return g.score(target, shot);
    }
    return scoreShot(target, shot);
  }

  /**
   * Summarize a session of practice game results.
   * @param {Array<{target: number|string, sg: number|null, onGreen?: boolean, dist?: number}>} results
   * @returns {{shots: number, mishits: number, sgTotal: number, sgPerShot: number, greens: number, byTarget: Array<{target: number|string, shots: number, sgPerShot: number, avgDist: number|null}>}}
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

      const target = r && (finite(r.target) || typeof r.target === "string")
        ? r.target
        : (r && r.target && typeof r.target === "object" && finite(r.target.yards) ? r.target.yards : null);
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
      .sort((a, b) =>
        typeof a[0] === "number" && typeof b[0] === "number"
          ? a[0] - b[0]
          : String(a[0]).localeCompare(String(b[0]))
      )
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

  // Plan shot shaping targets: 12 shots, 6 draw and 6 fade, at most 2 in a row, seeded.
  function planShaping(options = {}) {
    const rng = mulberry32(options.seed);
    while (true) {
      const items = [
        "draw", "draw", "draw", "draw", "draw", "draw",
        "fade", "fade", "fade", "fade", "fade", "fade",
      ];
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = items[i];
        items[i] = items[j];
        items[j] = tmp;
      }
      let valid = true;
      for (let i = 2; i < items.length; i++) {
        if (items[i] === items[i - 1] && items[i] === items[i - 2]) {
          valid = false;
          break;
        }
      }
      if (valid) return items;
    }
  }

  // Plan distance control targets: 15 random carries from 50 to 130 yards, never the same target twice in a row, seeded.
  function planDistance(options = {}) {
    const count = options.count ?? DISTANCE_DEFAULTS.count;
    const min = options.min ?? DISTANCE_DEFAULTS.min;
    const max = options.max ?? DISTANCE_DEFAULTS.max;
    const step = options.step ?? DISTANCE_DEFAULTS.step;
    const rng = mulberry32(options.seed);
    const lo = Math.ceil(min / step);
    const hi = Math.floor(max / step);
    const candidates = [];
    for (let s = lo; s <= hi; s++) candidates.push(s * step);
    const targets = [];
    let last = null;
    for (let i = 0; i < count; i++) {
      const choices = candidates.length > 1 && last !== null
        ? candidates.filter(t => t !== last)
        : candidates;
      const pick = choices[Math.floor(rng() * choices.length)];
      targets.push(pick);
      last = pick;
    }
    return targets;
  }

  // Plan hole builder targets: 12 entries {hole, shot, yards}; shot 1 has hole length, shot 2 has null.
  function planHoles(options = {}) {
    const plan = [];
    for (let i = 0; i < HOLES.length; i++) {
      const hole = i + 1;
      plan.push({ hole, shot: 1, yards: HOLES[i] });
      plan.push({ hole, shot: 2, yards: null });
    }
    return plan;
  }

  // Next target for hole builder game: 12 shots (6 holes x 2 shots).
  // Shot 1 is the tee shot (hole length).
  // Shot 2 is the approach: holeLength - teeCarry - teeRoll (clamped >= 20 yd), or 150 yd if tee was mishit.
  function nextHoles(options = {}, history = []) {
    const hist = history || [];
    const idx = hist.length;
    if (idx >= HOLES_SHOTS) return null;

    const holeIdx = Math.floor(idx / 2);
    const hole = holeIdx + 1;
    const shot = (idx % 2) + 1;
    const holeLength = HOLES[holeIdx];

    if (shot === 1) {
      return { hole, shot: 1, yards: holeLength };
    }

    // Shot 2: approach distance from the tee shot
    const prev = hist[idx - 1];
    if (!prev || prev.sg == null || !finite(prev.sg)) {
      // If the tee shot was a mishit (sg == null) the approach is 150 yd.
      return { hole, shot: 2, yards: 150 };
    }

    // Square shot data has carry and no roll figure, so carry alone is used (roll is 0)
    const teeCarry = prev.carry ?? (prev.shot && prev.shot.carry);
    const teeRoll = prev.roll ?? (prev.shot && prev.shot.roll) ?? 0;
    if (!finite(teeCarry) || teeCarry <= 0) {
      return { hole, shot: 2, yards: 150 };
    }

    let yards = Math.round(holeLength - teeCarry - teeRoll);
    if (yards < 20) yards = 20;
    return { hole, shot: 2, yards };
  }

  function sayHolesTarget(target) {
    if (!target || typeof target !== "object") return String(target ?? "");
    if (target.shot === 1) {
      return `hole ${target.hole}, ${target.yards} yards: the fairway`;
    }
    return `hole ${target.hole}: ${target.yards ?? 0} yards to go`;
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
      sayTarget: function (target) {
        return `${target} yards`;
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
      sayTarget: function (target) {
        return `${target} yards`;
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
      sayTarget: function (target) {
        return `${target} yards`;
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
      sayTarget: function (target) {
        return `${target} yards`;
      },
    },
    driving: {
      id: "driving",
      name: "Driving",
      describe: "Driving: 14 tee shots at a 30 yard fairway. Hit driver or your tee club.",
      clubsHint: "any",
      plan: function (options) {
        const count = options?.count ?? DRIVING_SHOTS;
        return Array(count).fill(0);
      },
      next: function (options, history) {
        const p = this.plan(options);
        const idx = history ? history.length : 0;
        return idx < p.length ? p[idx] : null;
      },
      sayTarget: function (target) {
        return "the fairway";
      },
      score: function (target, shot) {
        return scoreDriving(target, shot);
      },
    },
    shaping: {
      id: "shaping",
      name: "Shot shaping",
      describe: "Shot shaping: 12 shots, each a called draw or fade. Any club.",
      clubsHint: "any",
      plan: function (options) {
        return planShaping(options);
      },
      next: function (options, history) {
        const p = this.plan(options);
        const idx = history ? history.length : 0;
        return idx < p.length ? p[idx] : null;
      },
      sayTarget: function (target) {
        return target === "draw" || target === "fade" ? `a ${target}` : String(target);
      },
      score: function (target, shot) {
        return scoreShaping(target, shot);
      },
    },
    distance: {
      id: "distance",
      name: "Distance control",
      describe: "Distance control: 15 random carries from 50 to 130 yards. Only the carry counts: within 5 yards is a hit.",
      clubsHint: "any",
      plan: function (options) {
        return planDistance(options);
      },
      next: function (options, history) {
        const p = this.plan(options);
        const idx = history ? history.length : 0;
        return idx < p.length ? p[idx] : null;
      },
      sayTarget: function (target) {
        return `${target} yards carry`;
      },
      score: function (target, shot) {
        return scoreDistance(target, shot);
      },
    },
    holes: {
      id: "holes",
      name: "Hole builder",
      describe: "Hole builder: 6 par 4s, a tee shot and an approach each. The approach is from where your tee shot finished.",
      clubsHint: "any",
      plan: function (options) {
        return planHoles(options);
      },
      next: function (options, history) {
        return nextHoles(options, history);
      },
      sayTarget: function (target) {
        return sayHolesTarget(target);
      },
      score: function (target, shot) {
        return scoreHoles(target, shot);
      },
    },
  };

  /**
   * Breakdown finished Combines by target distance over the latest N sessions.
   * @param {Array<object>} logEntries Finished game log entries from /api/game
   * @param {{last?: number}} [options] Options, e.g. last (default 3)
   * @returns {{targets: Array<{target: number, shots: number, sgPerShot: number, greens: number, avgDist: number|null}>, byTarget: Array<object>, worst: Array<object>}}
   */
  function combineBreakdown(logEntries, options = {}) {
    const lastN = options && typeof options.last === "number" && options.last > 0 ? options.last : 3;
    const combines = (logEntries || []).filter(e => e && e.id === "combine" && Array.isArray(e.results));
    const recent = combines.slice(-lastN);
    const targetMap = new Map();

    for (const c of recent) {
      for (const r of c.results || []) {
        if (!r || r.target == null || !finite(r.target)) continue;
        const target = r.target;
        let entry = targetMap.get(target);
        if (!entry) {
          entry = { target, shots: 0, sgTotal: 0, greens: 0, distSum: 0, distCount: 0 };
          targetMap.set(target, entry);
        }
        entry.shots++;
        const isMishit = r.sg == null || !finite(r.sg);
        const shotSg = isMishit ? MISHIT_SG : r.sg;
        entry.sgTotal += shotSg;
        if (r.onGreen) entry.greens++;
        if (finite(r.dist)) {
          entry.distSum += r.dist;
          entry.distCount++;
        }
      }
    }

    const targets = Array.from(targetMap.values())
      .sort((a, b) => a.target - b.target)
      .map(e => ({
        target: e.target,
        shots: e.shots,
        sgPerShot: e.shots > 0 ? e.sgTotal / e.shots : 0,
        greens: e.greens,
        avgDist: e.distCount > 0 ? e.distSum / e.distCount : null,
      }));

    const eligible = targets.filter(t => t.shots >= 3);
    eligible.sort((a, b) => a.sgPerShot - b.sgPerShot || a.target - b.target);
    const worst = eligible.slice(0, 2);

    return {
      targets,
      byTarget: targets,
      worst,
    };
  }

  /**
   * Group finished game shots by target distance and club used.
   * @param {Array<object>} logEntries Finished game log entries from /api/game
   * @param {{id?: string}} [options] Options, e.g. id to restrict games (default: all except shaping, driving and holes)
   * @returns {Array<{target: number, clubs: Array<{club: string, shots: number, avgDist: number|null, greenShare: number}>}>}
   */
  function clubsByTarget(logEntries, options = {}) {
    const list = Array.isArray(logEntries) ? logEntries : [];
    const filterId = options && typeof options.id === "string" ? options.id : null;

    const targetMap = new Map();

    for (const entry of list) {
      if (!entry) continue;
      const id = entry.id;
      if (filterId) {
        if (id !== filterId) continue;
      } else {
        if (id === "shaping" || id === "driving" || id === "holes") continue;   // holes: tee-shot targets are hole lengths
      }

      const results = Array.isArray(entry.results) ? entry.results : [];
      for (const r of results) {
        if (!r) continue;
        const club = r.club;
        if (!club || typeof club !== "string" || !club.trim()) continue;

        let target = null;
        if (finite(r.target) && r.target > 0) {
          target = r.target;
        } else if (r.target && typeof r.target === "object" && finite(r.target.yards) && r.target.yards > 0) {
          target = r.target.yards;
        }
        if (target == null) continue;

        let clubMap = targetMap.get(target);
        if (!clubMap) {
          clubMap = new Map();
          targetMap.set(target, clubMap);
        }

        const clubKey = club.trim();
        let stats = clubMap.get(clubKey);
        if (!stats) {
          stats = { club: clubKey, shots: 0, greens: 0, distSum: 0, distCount: 0 };
          clubMap.set(clubKey, stats);
        }

        stats.shots++;
        if (r.onGreen) stats.greens++;
        if (finite(r.dist)) {
          stats.distSum += r.dist;
          stats.distCount++;
        }
      }
    }

    const rows = [];
    for (const [target, clubMap] of targetMap.entries()) {
      const clubs = Array.from(clubMap.values()).map(s => ({
        club: s.club,
        shots: s.shots,
        avgDist: s.distCount > 0 ? s.distSum / s.distCount : null,
        greenShare: s.shots > 0 ? s.greens / s.shots : 0,
      }));

      // Sort clubs by shots descending; ties by greenShare descending then club name
      clubs.sort((a, b) => (b.shots - a.shots) || (b.greenShare - a.greenShare) || a.club.localeCompare(b.club));

      rows.push({ target, clubs });
    }

    // Sort rows by target ascending
    rows.sort((a, b) => a.target - b.target);

    return rows;
  }

  /**
   * Suggest the best club for a target or across targets.
   * Finds the club with the highest greenShare among clubs with >= 3 shots (ties: more shots), or null.
   * @param {Array<object>|object} rows Target rows from clubsByTarget, or a single row, or club list
   * @returns {string|null|Map<number, string|null>}
   */
  function clubSuggestion(rows) {
    if (!rows) return null;

    // If passed a single target row: { target, clubs: [...] }
    if (!Array.isArray(rows) && Array.isArray(rows.clubs)) {
      return clubSuggestion(rows.clubs);
    }

    if (!Array.isArray(rows) || rows.length === 0) return null;

    // If passed an array of target rows from clubsByTarget: [{ target, clubs: [...] }, ...]
    if (rows[0] && rows[0].target !== undefined && Array.isArray(rows[0].clubs)) {
      const map = new Map();
      for (const row of rows) {
        const best = clubSuggestion(row.clubs);
        map.set(row.target, best);
        map[row.target] = best;
        row.best = best;
      }
      return map;
    }

    // Array of club entries: [{ club, shots, greenShare, ... }, ...]
    const eligible = rows.filter(c => c && typeof c.club === "string" && finite(c.shots) && c.shots >= 3);
    if (eligible.length === 0) return null;

    eligible.sort((a, b) => {
      const gDiff = (b.greenShare ?? 0) - (a.greenShare ?? 0);
      if (Math.abs(gDiff) > 1e-9) return gDiff;
      if (b.shots !== a.shots) return b.shots - a.shots;
      return a.club.localeCompare(b.club);
    });

    return eligible[0].club;
  }

  // Usual shot count for each game (for best score eligibility: >= half usual shots).
  const USUAL_SHOTS = {
    combine: COMBINE_TARGETS.length * COMBINE_SHOTS_PER_TARGET, // 27
    wedges: WEDGE_TARGETS.length, // 13
    random: RANDOM_DEFAULTS.count, // 20
    ladder: LADDER_DEFAULTS.count, // 30
    driving: DRIVING_SHOTS, // 14
    shaping: SHAPING_SHOTS, // 12
    distance: DISTANCE_DEFAULTS.count, // 15
    holes: HOLES_SHOTS, // 12
  };

  /**
   * Extract history of finished sessions for a game, newest first, plus best session.
   * @param {Array<object>} logEntries Finished game log entries from /api/game
   * @param {string} gameId Game ID (e.g. "combine", "wedges", "driving", "distance", etc.)
   * @returns {Array<{started: number|null, shots: number, hits: number, hitShare: number, sgPerShot: number|null, how: string}> & {best: object|null, games: Array, history: Array}}
   */
  function gameHistory(logEntries, gameId) {
    const matching = (logEntries || []).filter(e => e && e.id === gameId);
    const indexed = matching.map((entry, idx) => ({ entry, idx }));
    indexed.sort((a, b) => {
      const timeA = a.entry.started ?? 0;
      const timeB = b.entry.started ?? 0;
      if (timeB !== timeA) return timeB - timeA;
      return b.idx - a.idx;
    });

    const list = indexed.map(({ entry }) => {
      const s = entry.summary;
      const res = Array.isArray(entry.results) ? entry.results : null;
      const shots = s && typeof s.shots === "number"
        ? s.shots
        : (res ? res.length : 0);
      const hits = s && typeof s.greens === "number"
        ? s.greens
        : (res ? res.filter(r => r && r.onGreen).length : 0);
      const hitShare = shots > 0 ? hits / shots : 0;

      let sgPerShot = null;
      if (gameId !== "shaping") {
        if (s && finite(s.sgPerShot)) {
          sgPerShot = s.sgPerShot;
        } else if (res && res.length > 0) {
          const sum = summarize(res);
          sgPerShot = finite(sum.sgPerShot) ? sum.sgPerShot : null;
        }
      }

      const how = entry.how || "done";
      const started = entry.started ?? null;

      return {
        started,
        shots,
        hits,
        hitShare,
        sgPerShot,
        how,
      };
    });

    const usual = USUAL_SHOTS[gameId] ?? 10;
    const minShots = usual / 2;
    const eligible = list.filter(h => h.shots >= minShots);
    let best = null;
    if (eligible.length > 0) {
      best = eligible.slice().sort((a, b) => {
        if (b.hitShare !== a.hitShare) return b.hitShare - a.hitShare;
        if (b.shots !== a.shots) return b.shots - a.shots;
        return (b.started ?? 0) - (a.started ?? 0);
      })[0];
    }

    list.best = best;
    list.games = list;
    list.history = list;
    return list;
  }

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
    FAIRWAY_HALF_WIDTH_YD,
    ROUGH_EDGE_YD,
    DRIVE_HOLE_YD,
    DRIVE_TEE_EXPECTED,
    DRIVING_SHOTS,
    SHAPE_MIN_AXIS,
    SHAPE_MAX_OFFLINE_PCT,
    SHAPING_SHOTS,
    DISTANCE_WINDOW_YD,
    DISTANCE_DEFAULTS,
    USUAL_SHOTS,
    HOLES,
    mulberry32,
    expectedPutts,
    expectedStrokes,
    scoreShot,
    scoreDriving,
    scoreShaping,
    scoreDistance,
    scoreHoles,
    scoreFor,
    summarize,
    planShaping,
    planDistance,
    planHoles,
    nextHoles,
    sayHolesTarget,
    combineBreakdown,
    clubsByTarget,
    clubSuggestion,
    gameHistory,
    GAMES,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SwingGames = api;
})(typeof window !== "undefined" ? window : globalThis);
