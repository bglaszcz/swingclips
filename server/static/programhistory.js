/**
 * SwingProgramHistory: pure logic for coach program history and trends across runs.
 *
 * API:
 *   runs(log, programs)               -> array of runs (newest first) with block gate state,
 *                                        medians of gate checks, and count left out
 *   trend(runs, programId, blockId)   -> trend for a ball block across runs (oldest first),
 *                                        or null if fewer than 2 runs with read shots
 *   lines(trend)                      -> array of plain-words summary strings
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SwingProgramHistory = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ---- Named constants (thresholds for "about the same") ----
  // Sensor noise / launch monitor reading steps below which a metric change between runs
  // is considered "about the same".
  const SAME_THRESHOLDS = {
    attack: 0.2,          // 0.2° is within launch monitor attack angle reading noise
    loft: 0.2,            // 0.2° is within launch monitor dynamic loft reading noise
    faceToPath: 0.2,      // 0.2° is within launch monitor face/path calculation noise
    strikeV: 1.0,         // 1 mm is Square's reporting resolution for face impact height
    strikeH: 1.0,         // 1 mm is Square's reporting resolution for face impact horizontal
    clubSpeed: 1.0,       // 1 mph is Square's reporting increment for club speed
    carry: 1.0,           // 1 yd is Square's reporting increment for carry distance
    // 3D angles: 1° is within 3D angle noise floor
    pelvisOpen: 1.0,      // 1° is within 3D pelvis angle noise floor
    // 3D timings: 10 ms is within 3D peak timing / video frame noise (~4-10 ms)
    pelvisPeakMs: 10,     // 10 ms is within 3D pelvis peak timing noise
    armPeakMs: 10,        // 10 ms is within 3D arm peak timing noise
    pelvisStartMs: 10,    // 10 ms is within 3D pelvis turn start timing noise
    armAfterPelvis: 0.5,  // boolean / sequence step threshold
    // Camera distances: 0.3 in is within face-on camera body distance tracking noise
    pelvisBall: 0.3,      // 0.3 in is within face-on camera pelvis-to-ball tracking noise
    chestBall: 0.3,       // 0.3 in is within face-on camera chest-to-ball tracking noise
    handsAhead: 0.3,      // 0.3 in is within face-on camera hands-to-ball tracking noise
    // Launch monitor ball flight numbers
    path: 0.5,            // 0.5° is within launch monitor club path reading noise
    face: 0.5,            // 0.5° is within launch monitor face angle reading noise
    startDir: 0.5,        // 0.5° is within launch monitor start direction reading noise
    ballSpeed: 1.0,       // 1 mph is Square's reporting increment for ball speed
    smash: 0.01,          // 0.01 is smash factor calculation resolution
  };
  const DEFAULT_SAME_THRESHOLD = 0.5; // fallback for unlisted launch monitor metrics

  // 3D kinematic sequence keys from server/programs.py BODY3D_KEYS
  const BODY3D_KEYS = ["pelvisPeakMs", "armPeakMs", "pelvisOpen", "pelvisStartMs", "armAfterPelvis"];

  // Metadata for gate check numbers: display label, unit, decimal places
  const NUMBERS = {
    attack: { label: "Attack", unit: "°", decimals: 1, signed: true },
    loft: { label: "Dynamic loft", unit: "°", decimals: 1, signed: false },
    faceToPath: { label: "Face to path", unit: "°", decimals: 1, signed: true },
    strikeV: { label: "Strike", unit: " mm", decimals: 0, signed: true },
    strikeH: { label: "Strike toe/heel", unit: " mm", decimals: 0, signed: true },
    clubSpeed: { label: "Club speed", unit: " mph", decimals: 0, signed: false },
    carry: { label: "Carry", unit: " yd", decimals: 0, signed: false },
    // 3D angles and timings (server/programs.py BODY3D_KEYS)
    pelvisOpen: { label: "Hips open", unit: "°", decimals: 0, signed: false },
    pelvisPeakMs: { label: "Hips peak", unit: " ms", decimals: 0, signed: false },
    armPeakMs: { label: "Arm peak", unit: " ms", decimals: 0, signed: false },
    pelvisStartMs: { label: "Hips turn start", unit: " ms", decimals: 0, signed: false },
    armAfterPelvis: { label: "Arm after pelvis", unit: "", decimals: 0, signed: false },
    // Camera distances (server/programs.py BODY_REPORT)
    pelvisBall: { label: "Hips ahead", unit: " in", decimals: 1, signed: false },
    chestBall: { label: "Chest ahead", unit: " in", decimals: 1, signed: false },
    handsAhead: { label: "Hands ahead", unit: " in", decimals: 1, signed: false },
    // Launch monitor ball flight numbers (Square)
    path: { label: "Club path", unit: "°", decimals: 1, signed: true },
    face: { label: "Face to target", unit: "°", decimals: 1, signed: true },
    startDir: { label: "Start direction", unit: "°", decimals: 1, signed: true },
    ballSpeed: { label: "Ball speed", unit: " mph", decimals: 1, signed: false },
    smash: { label: "Smash", unit: "", decimals: 2, signed: false },
  };

  const finite = v => typeof v === "number" && Number.isFinite(v);

  function quantile(sorted, q) {
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  function median(xs) {
    const v = xs.filter(finite).sort((a, b) => a - b);
    if (!v.length) return null;
    return quantile(v, 0.5);
  }

  function formatNum(v, dec, signed) {
    if (v == null || !Number.isFinite(v)) return "–";
    const rounded = dec === 0 ? Math.round(v) : v.toFixed(dec);
    if (signed && v > 0) return "+" + rounded;
    return String(rounded);
  }

  /**
   * Evaluates whether a number moved toward the gate, away, or stayed about the same.
   *
   * @param {object} check - gate check definition ({ key, min, max })
   * @param {number|null} firstMed - median on earliest run
   * @param {number|null} lastMed - median on latest run
   * @returns {"moved toward the gate"|"moved away"|"about the same"|"inside the gate"|null}
   */
  function evaluateMovement(check, firstMed, lastMed) {
    if (firstMed == null || lastMed == null) return null;
    const threshold = SAME_THRESHOLDS[check.key] ?? DEFAULT_SAME_THRESHOLD;
    // How far outside the gate's limits (0 inside): the same rule for one-sided checks, a band
    // (face to path within 2) and a limit with a floor (strike <= +3, not below -8).
    const outside = v => Math.max(check.min != null ? check.min - v : 0, check.max != null ? v - check.max : 0, 0);
    const d1 = outside(firstMed), d2 = outside(lastMed);
    const diff = Math.abs(lastMed - firstMed);
    if (check.min != null && check.max != null && d1 === 0 && d2 === 0) return "inside the gate";
    if (diff <= threshold || d1 === d2) return "about the same";
    if (d1 === 0 && d2 === 0) return "inside the gate";
    if (d2 === 0) return "now inside the gate";   // crossed in (pelvis open 6 -> 12 against 10 or more)
    return d2 < d1 ? "moved toward the gate" : "moved away";
  }

  const CHECK_ORDER = ["attack", "loft", "faceToPath", "strikeV", "strikeH", "clubSpeed", "carry"];

  function formatLimit(v, signed = false) {
    if (v == null) return "";
    const s = Number.isInteger(v) ? String(v) : String(v);
    if (signed && v > 0) return "+" + s;
    return s;
  }

  /**
   * Describes the target / direction of a gate check in plain words.
   */
  function targetPhrase(check, movement) {
    if (movement === "about the same" || movement === "inside the gate" || movement === "now inside the gate") return movement;
    const info = NUMBERS[check.key] || { unit: "" };
    const lim = v => formatLimit(v, Boolean(info.signed && check.key !== "attack"));
    let gate;
    if (check.min != null && check.max != null && check.min === -check.max) gate = `±${check.max}${info.unit}`;
    else if (check.min != null && check.max != null) gate = `${check.min} to ${check.max}${info.unit}`;
    else if (check.max != null) gate = `${lim(check.max)}${info.unit} or ${check.key === "attack" ? "steeper" : "lower"}`;
    else gate = `${lim(check.min)}${info.unit} or more`;
    return `${movement === "moved toward the gate" ? "toward" : "away from"} ${gate}`;
  }

  /**
   * Summary of finished runs, newest first.
   *
   * @param {Array} log - finished runs from /api/program (newest last)
   * @param {Array|Object} programs - catalog of programs
   * @returns {Array} runs, newest first
   */
  function runs(log, programs) {
    if (!log || !Array.isArray(log)) return [];
    const progMap = Array.isArray(programs)
      ? Object.fromEntries(programs.map(p => [p.id, p]))
      : (programs || {});

    // Sort newest first
    const sorted = [...log].sort((a, b) => (b.started || 0) - (a.started || 0));

    return sorted.map(r => {
      const prog = progMap[r.id] || null;
      const dateStr = r.day ? r.day.slice(0, 10) : (r.started ? new Date(r.started * 1000).toISOString().slice(0, 10) : "");
      const swingsUsed = r.reps ? r.reps.length : (r.used != null ? r.used : 0);
      const cap = prog ? prog.cap : (r.cap || null);

      // Blocks: use server-judged blocks if present, or reconstruct from program definition
      const sourceBlocks = r.blocks || (prog ? prog.blocks : []);
      const blocks = sourceBlocks.map(b => {
        const def = (prog && prog.blocks.find(x => x.id === b.id)) || b;
        const result = b.result != null ? b.result : (r.results && r.results[b.id]) != null ? r.results[b.id] : null;
        const isBall = !!(b.ball != null ? b.ball : def.ball);
        const checks = (b.gate?.checks || def.gate?.checks || []);
        const judged = b.judged || (r.reps ? r.reps.filter(x => x.block === b.id) : []);

        let medians = null;
        let counts = null;
        let d3Notes = null;
        let leftOut = 0;
        let readCount = 0;

        if (isBall) {
          medians = {};
          counts = {};
          d3Notes = {};
          const readShots = judged.filter(x => x.kind === "shot" && !x.noRead);
          leftOut = judged.filter(x => x.kind === "noshot" || !!x.noRead).length;
          readCount = readShots.length;

          for (const c of checks) {
            const vals = readShots.map(x => x.numbers?.[c.key]).filter(finite);
            medians[c.key] = vals.length ? median(vals) : null;
            counts[c.key] = vals.length;
            if (BODY3D_KEYS.includes(c.key) && vals.length < readCount && readCount > 0) {
              d3Notes[c.key] = `(3D on ${vals.length} of ${readCount} swings)`;
            }
          }
        }

        return {
          id: b.id,
          name: b.name || def.name,
          ball: isBall,
          gate: b.gate || def.gate,
          state: b.state || null,
          result,
          medians,
          counts,
          d3Notes,
          leftOut,
          readCount,
        };
      });

      return {
        id: r.id,
        programId: r.id,
        name: r.name || (prog && prog.name) || r.id,
        started: r.started,
        ended: r.ended,
        day: r.day,
        date: dateStr,
        how: r.how || "",
        swingsUsed,
        cap,
        results: r.results || {},
        blocks,
      };
    });
  }

  /**
   * Trend for a specific ball block across runs, oldest first.
   *
   * @param {Array} runList - runs from runs() or raw runs
   * @param {string} programId - e.g. "lowpoint"
   * @param {string} blockId - e.g. "flush"
   * @returns {Object|null} trend object or null if fewer than 2 runs with read shots
   */
  function trend(runList, programId, blockId) {
    if (!runList || !Array.isArray(runList)) return null;

    // Filter to runs matching programId and containing the block with at least one read shot
    const matched = [];
    for (const r of runList) {
      if (r.id !== programId && r.programId !== programId) continue;
      const b = r.blocks?.find(x => x.id === blockId);
      if (!b) continue;
      // Must have read shots
      if (b.readCount > 0 || (b.medians && Object.values(b.medians).some(v => v != null))) {
        matched.push({ run: r, block: b });
      }
    }

    if (matched.length < 2) {
      return null;
    }

    // Sort oldest first
    matched.sort((a, b) => (a.run.started || 0) - (b.run.started || 0));

    const firstBlock = matched[0].block;
    const rawChecks = firstBlock.gate?.checks || [];
    const allInLegacy = rawChecks.length > 0 && rawChecks.every(c => CHECK_ORDER.includes(c.key));
    const checks = allInLegacy
      ? [...rawChecks].sort((a, b) => CHECK_ORDER.indexOf(a.key) - CHECK_ORDER.indexOf(b.key))
      : [...rawChecks];
    const checkTrends = [];

    const lastBlock = matched[matched.length - 1].block;
    for (const c of checks) {
      const firstMed = matched[0].block.medians?.[c.key];
      const lastMed = lastBlock.medians?.[c.key];
      const movement = evaluateMovement(c, firstMed, lastMed);
      const info = NUMBERS[c.key] || { label: c.key, unit: "", decimals: 1, signed: false };
      const d3Note = lastBlock.d3Notes?.[c.key] || null;

      checkTrends.push({
        key: c.key,
        name: info.label,
        unit: info.unit,
        decimals: info.decimals,
        signed: info.signed,
        check: c,
        firstMedian: firstMed,
        lastMedian: lastMed,
        movement,
        d3Note,
        allMedians: matched.map(m => m.block.medians?.[c.key] ?? null),
      });
    }

    const tObj = {
      programId,
      blockId,
      blockName: firstBlock.name,
      gate: firstBlock.gate,
      runs: matched.map(m => ({
        started: m.run.started,
        date: m.run.date,
        how: m.run.how,
        state: m.block.state,
        result: m.block.result,
        medians: m.block.medians,
        counts: m.block.counts,
        d3Notes: m.block.d3Notes,
        leftOut: m.block.leftOut,
        readCount: m.block.readCount,
      })),
      checks: checkTrends,
    };

    return tObj;
  }

  /**
   * Plain-words summary line(s) for a trend.
   *
   * @param {Object|Array|null} t - trend object from trend() or array of trends
   * @returns {Array<string>} array of summary strings
   */
  function lines(t) {
    if (!t) return [];
    if (Array.isArray(t)) {
      return t.flatMap(lines);
    }
    if (!t.runs || t.runs.length < 2) return [];

    const firstRun = t.runs[0];
    const lastRun = t.runs[t.runs.length - 1];

    // Gate count progression: "gate 3/10 -> 7/10 passed" or streak
    let gateProg = "";
    if (firstRun.state && lastRun.state) {
      if (t.gate?.kind === "streak") {
        const v1 = firstRun.state.best ?? firstRun.state.streak ?? firstRun.state.passes;
        const v2 = lastRun.state.best ?? lastRun.state.streak ?? lastRun.state.passes;
        gateProg = `best streak ${v1} → ${v2} (gate ${t.gate.need} in a row)`;
      } else if (firstRun.state.reps != null && lastRun.state.reps != null) {
        gateProg = `passed ${firstRun.state.passes}/${firstRun.state.reps} → ${lastRun.state.passes}/${lastRun.state.reps} (gate ${t.gate.need})`;
      } else if (firstRun.state.streak != null) {
        gateProg = `best streak ${firstRun.state.best || firstRun.state.streak} → ${lastRun.state.best || lastRun.state.streak}`;
      }
    }

    const checkParts = [];
    for (const c of t.checks || []) {
      if (c.firstMedian == null || c.lastMedian == null) continue;
      const v1Str = formatNum(c.firstMedian, c.decimals, c.signed);
      const v2Str = formatNum(c.lastMedian, c.decimals, c.signed);
      const target = targetPhrase(c.check, c.movement);
      const d3Part = c.d3Note ? ` ${c.d3Note}` : "";
      checkParts.push(`${c.name} ${v1Str} → ${v2Str}${c.unit} (${target})${d3Part}.`);
    }

    const prefix = `${t.blockName}, ${t.runs.length} runs:`;
    const gatePart = gateProg ? `${gateProg}. ` : "";
    const line = `${prefix} ${gatePart}${checkParts.join(" ")}`.trim();

    return [line];
  }

  return {
    SAME_THRESHOLDS,
    NUMBERS,
    evaluateMovement,
    runs,
    trend,
    lines,
  };
});
