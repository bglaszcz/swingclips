// server/static/progshot.js
// Last shot helper for coach programs (Start page, coach program).
// Pure logic: lastShot(block) -> {verdict, why, checks, extra} or null.
//
// Works in the browser (window.SwingProgShot, window.lastShot) and in Node (module.exports).

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    const api = factory();
    root.SwingProgShot = api;
    root.lastShot = api.lastShot;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CHECK_LABELS = {
    attack: "Attack",
    faceToPath: "Face to path",
    pelvisOpen: "Hips open",
    pelvisBall: "Hips ahead of ball",
    strikeV: "Strike",
    strikeH: "Strike toe/heel",
    loft: "Dynamic loft",
    clubSpeed: "Club speed",
    carry: "Carry",
    pelvisPeakMs: "Hips peak",
    armPeakMs: "Arm peak",
    pelvisStartMs: "Hips turn start",
    armAfterPelvis: "Arm after pelvis",
    chestBall: "Chest ahead of ball",
    handsAhead: "Hands ahead",
    path: "Club path",
    face: "Face to target",
    startDir: "Start direction",
    ballSpeed: "Ball speed",
    smash: "Smash",
  };

  const METRIC_DEFS = {
    attack: { unit: "°", dec: 1, signed: true },
    faceToPath: { unit: "°", dec: 1, signed: true },
    pelvisOpen: { unit: "°", dec: 0, signed: false },
    pelvisBall: { unit: " in", dec: 1, signed: true },
    strikeV: { unit: " mm", dec: 0, signed: true },
    strikeH: { unit: " mm", dec: 0, signed: true },
    loft: { unit: "°", dec: 1, signed: false },
    clubSpeed: { unit: " mph", dec: 0, signed: false },
    carry: { unit: " yd", dec: 0, signed: false },
    pelvisPeakMs: { unit: " ms", dec: 0, signed: false },
    armPeakMs: { unit: " ms", dec: 0, signed: false },
    pelvisStartMs: { unit: " ms", dec: 0, signed: false },
    armAfterPelvis: { unit: "", dec: 0, signed: false },
    chestBall: { unit: " in", dec: 1, signed: true },
    handsAhead: { unit: " in", dec: 1, signed: true },
    path: { unit: "°", dec: 1, signed: true },
    face: { unit: "°", dec: 1, signed: true },
    startDir: { unit: "°", dec: 1, signed: true },
    ballSpeed: { unit: " mph", dec: 1, signed: false },
    smash: { unit: "", dec: 2, signed: false },
  };

  const CUES = {
    attack: ["attack too shallow", "attack too steep"],
    strikeV: ["strike high on the face", "strike low on the face"],
    faceToPath: ["face open to path", "face closed to path"],
    loft: ["too much loft", "too little loft"],
    clubSpeed: ["too fast", "too slow"],
    carry: ["long", "short"],
    pelvisPeakMs: ["pelvis peaks late", "pelvis peaks early"],
    pelvisOpen: ["pelvis too open", "pelvis not open enough"],
    pelvisStartMs: ["pelvis starts late", "pelvis starts early"],
    pelvisBall: ["pelvis too far ahead", "pelvis not ahead enough"],
  };

  const EXTRA_CANDIDATES = [
    { key: "strikeV", label: "Strike" },
    { key: "loft", label: "Dynamic loft" },
    { key: "carry", label: "Carry" },
    { key: "path", label: "Club path" },
    { key: "face", label: "Face to target" },
    { key: "startDir", label: "Start direction" },
    { key: "ballSpeed", label: "Ball speed" },
    { key: "smash", label: "Smash" },
  ];

  function formatWant(c) {
    if (!c) return "";
    const lo = c.min;
    const hi = c.max;
    if (c.equals !== undefined) {
      return String(c.equals);
    }
    if (lo !== undefined && lo !== null && hi !== undefined && hi !== null) {
      if (lo === -hi) {
        return `within ${hi}`;
      }
      return `${lo} to ${hi}`;
    }
    if (lo !== undefined && lo !== null) {
      return `${lo} or more`;
    }
    if (hi !== undefined && hi !== null) {
      return `${hi} or less`;
    }
    return "";
  }

  function formatMetricText(key, val) {
    if (val === null || val === undefined || (typeof val === "number" && !Number.isFinite(val))) {
      if (typeof val === "boolean") {
        return val ? "yes" : "no";
      }
      return "–";
    }
    if (typeof val === "boolean") {
      return val ? "arm after pelvis" : "arm before pelvis";
    }
    const def = METRIC_DEFS[key] || { unit: "", dec: 1, signed: false };
    const d = def.dec;
    const unit = def.unit || "";
    const absVal = Math.abs(val);
    const formatted = d === 0 ? Math.round(absVal).toString() : absVal.toFixed(d);
    const isZero = Number(formatted) === 0;
    let sign = "";
    if (!isZero) {
      if (val < 0) {
        sign = "-";
      } else if (def.signed) {
        sign = "+";
      }
    }
    return sign + formatted + unit;
  }

  function check(numbers, c) {
    if (!numbers || !c) return null;
    const v = numbers[c.key];
    if (v === null || v === undefined) {
      return null;
    }
    if (c.equals !== undefined) {
      return v === c.equals;
    }
    if (typeof v === "boolean") {
      if (c.min === true || c.min === 1) return v === true;
      if (c.max === false || c.max === 0) return v === false;
      return v === (c.val !== undefined ? c.val : true);
    }
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return null;
    }
    if (c.min !== undefined && c.min !== null && v < c.min) {
      return false;
    }
    if (c.max !== undefined && c.max !== null && v > c.max) {
      return false;
    }
    return true;
  }

  function cue(c, v) {
    if (!c) return "";
    if (c.key === "armAfterPelvis") return "arms before pelvis";
    const pair = CUES[c.key] || [`${c.key} too high`, `${c.key} too low`];
    const hi = c.max;
    return (hi !== undefined && hi !== null && (v === null || v === undefined || v > hi)) ? pair[0] : pair[1];
  }

  /**
   * Returns details for the block's latest ball rep, or null if there are no ball reps.
   *
   * @param {object} block
   * @returns {null|{verdict: "pass"|"miss"|"not counted"|"waiting", why: string|null, checks: Array, extra: Array}}
   */
  function lastShot(block) {
    if (!block || !block.ball || !Array.isArray(block.judged) || !block.judged.length) {
      return null;
    }

    const ballReps = block.judged.filter(r => r && (r.kind === "shot" || r.kind === "ball" || (r.kind !== "tap" && r.numbers)));
    if (!ballReps.length) {
      return null;
    }

    const rep = ballReps[ballReps.length - 1];
    const gateChecks = (block.gate && Array.isArray(block.gate.checks)) ? block.gate.checks : [];
    const numbers = rep.numbers || {};

    let verdict;
    let why = null;

    if (rep.waiting3d) {
      verdict = "waiting";
      why = rep.why || "waiting for 3D";
    } else if (rep.noRead) {
      verdict = "not counted";
      why = rep.noRead;
    } else if (rep.gate === true) {
      verdict = "pass";
      why = rep.why || null;
    } else if (rep.gate === false) {
      verdict = "miss";
      if (rep.why) {
        why = rep.why;
      } else {
        const failed = gateChecks.filter(c => check(numbers, c) === false);
        if (failed.length) {
          why = failed.map(c => cue(c, numbers[c.key])).filter(Boolean).join(", ");
        } else if (rep.mark === false) {
          why = "mark behind the ball";
        }
      }
    } else {
      verdict = "not counted";
      why = rep.why || (rep.noRead ? rep.noRead : null);
    }

    const checks = gateChecks.map(c => {
      const val = (numbers[c.key] !== undefined && numbers[c.key] !== null) ? numbers[c.key] : null;
      const ok = check(numbers, c);
      const label = c.label || CHECK_LABELS[c.key] || c.key;
      const text = formatMetricText(c.key, val);
      const want = formatWant(c);
      return {
        key: c.key,
        label,
        value: val,
        text,
        want,
        ok,
      };
    });

    const gatedKeys = new Set(gateChecks.map(c => c.key));
    const extra = [];
    for (const cand of EXTRA_CANDIDATES) {
      if (gatedKeys.has(cand.key)) continue;
      let v = numbers[cand.key];
      if (cand.key === "strikeV" && v == null) v = numbers.strike;
      if (cand.key === "loft" && v == null) v = numbers.dynamicLoft;
      if (v != null && Number.isFinite(v)) {
        extra.push({
          label: cand.label,
          text: formatMetricText(cand.key, v),
        });
      }
    }

    return {
      verdict,
      why,
      checks,
      extra,
    };
  }

  return {
    lastShot,
    check,
    formatWant,
    formatMetricText,
    cue,
    CHECK_LABELS,
    METRIC_DEFS,
    CUES,
  };
});
