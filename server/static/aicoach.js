// AI coach brief generator: compiles session facts, comparisons, focus state,
// and any coach program report into a plain text brief under ~4,000 words.
//
// Rules:
// - Plain English: no P-numbers (P4 -> top of swing, P6 -> downswing, P7 -> impact).
// - Numbers with units.
// - Strike heights are face-centred (0 = centre).
// - Missing pieces are left out, not guessed.
//
// Works in the browser (window.SwingAICoach) and in Node (module.exports).
(function (root) {
  const SessionStory = root.SwingSessionStory || (typeof require !== "undefined" && (function() { try { return require("./sessionstory.js"); } catch(e){ return null; } })());
  const SessionScore = root.SwingSessionScore || (typeof require !== "undefined" && (function() { try { return require("./sessionscore.js"); } catch(e){ return null; } })());
  const Focus = root.SwingFocus || (typeof require !== "undefined" && (function() { try { return require("./focus.js"); } catch(e){ return null; } })());
  const Coach = root.SwingCoach || (typeof require !== "undefined" && (function() { try { return require("./coach.js"); } catch(e){ return null; } })());
  const GoodShots = root.SwingGoodShots || (typeof require !== "undefined" && (function() { try { return require("./goodshots.js"); } catch(e){ return null; } })());

  const METRIC_LABELS = {
    // Body metrics
    tempo: "Tempo",
    backswing: "Backswing time",
    downswing: "Downswing time",
    shoulderTop: "Shoulder turn at top of swing",
    pelvisTop: "Hip turn at top of swing",
    xFactor: "Shoulders turned past hips at top of swing",
    hipSway: "Hip slide at impact",
    leadHipP6: "Lead hip in downswing",
    trailHipTop: "Trail hip at top of swing",
    handsAhead: "Hands ahead of ball at impact",
    pelvisBall: "Hips vs ball at impact",
    chestBall: "Chest vs ball at impact",
    headSway: "Head slide at impact",
    headRise: "Head height at impact",
    spineTiltImpact: "Spine tilt at impact",
    lagP5: "Wrist hinge in downswing",
    releaseArm: "Release point in downswing",
    earlyExt: "Hips toward ball at impact",
    bendLoss: "Posture held through impact",
    headToBall: "Head toward ball at impact",
    handsPlaneP6: "Hands to plane in downswing",
    shaftPlaneP6: "Shaft to plane in downswing",
    handsPlaneTop: "Hands to plane at top of swing",
    handHeightTop: "Hand height at top of swing",
    handDepthTop: "Hand depth at top of swing",

    // Shot / launch monitor numbers
    carry: "Carry",
    offline: "Offline",
    ballSpeed: "Ball speed",
    clubSpeed: "Club speed",
    smash: "Smash factor",
    path: "Club path",
    face: "Face to target",
    faceToPath: "Face to path",
    attack: "Attack angle",
    loft: "Dynamic loft",
    launch: "Launch angle",
    direction: "Start direction",
    spinAxis: "Spin axis",
    spin: "Total spin",
    strikeH: "Strike heel/toe",
    strikeV: "Strike height (face-centred)",
  };

  const METRIC_UNITS = {
    tempo: ":1",
    backswing: " s",
    downswing: " s",
    shoulderTop: "°",
    pelvisTop: "°",
    xFactor: "°",
    hipSway: " in",
    leadHipP6: " in",
    trailHipTop: " in",
    handsAhead: " in",
    pelvisBall: " in",
    chestBall: " in",
    headSway: " in",
    headRise: " in",
    spineTiltImpact: "°",
    lagP5: "°",
    releaseArm: "°",
    earlyExt: " in",
    bendLoss: "°",
    headToBall: " in",
    handsPlaneP6: " in",
    shaftPlaneP6: "°",
    handsPlaneTop: " in",
    handHeightTop: " in",
    handDepthTop: " in",

    carry: " yd",
    offline: " yd",
    ballSpeed: " mph",
    clubSpeed: " mph",
    smash: "",
    path: "°",
    face: "°",
    faceToPath: "°",
    attack: "°",
    loft: "°",
    launch: "°",
    direction: "°",
    spinAxis: "°",
    spin: " rpm",
    strikeH: " mm",
    strikeV: " mm",
  };

  function plainClubName(code) {
    if (!code) return "";
    if (SessionStory && SessionStory.plainClub) return SessionStory.plainClub(code);
    const c = String(code).toUpperCase().trim();
    if (c === "DR" || c === "DRIVER") return "driver";
    if (c === "PW") return "PW";
    if (c === "GW") return "GW";
    if (c === "SW") return "SW";
    if (c === "LW") return "LW";
    let m = c.match(/^I(\d+)$/);
    if (m) return `${m[1]} iron`;
    m = c.match(/^W(\d+)$/);
    if (m) return `${m[1]} wood`;
    m = c.match(/^H(\d+)$/);
    if (m) return `${m[1]} hybrid`;
    return String(code).toLowerCase();
  }

  function formatMetricValue(key, val) {
    if (val == null || !Number.isFinite(val)) return "n/a";
    const unit = METRIC_UNITS[key] ?? "";
    if (key === "tempo") return `${val.toFixed(1)}:1`;
    if (key === "smash") return val.toFixed(2);
    if (key === "strikeV") {
      const sign = val > 0 ? "+" : "";
      return `${sign}${val.toFixed(1)} mm (face-centred)`;
    }
    if (key === "strikeH") {
      const sign = val > 0 ? "+" : "";
      return `${sign}${val.toFixed(1)} mm`;
    }
    if (unit === "°" || unit === " yd" || unit === " mph" || unit === " in") {
      const signedMetrics = ["path", "face", "faceToPath", "attack", "offline", "direction"];
      const sign = signedMetrics.includes(key) && val > 0 ? "+" : "";
      return `${sign}${val.toFixed(1)}${unit}`;
    }
    return `${val.toFixed(1)}${unit}`;
  }

  function formatDate(ts) {
    if (!ts) return "";
    let ms = Number(ts);
    if (Number.isFinite(ms) && ms < 1e11) ms *= 1000;
    const d = new Date(ms);
    if (isNaN(d.getTime())) return String(ts);
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  /**
   * Generates a concise session brief for the AI coach.
   *
   * @param input {
   *   session: { start, rows } | rows array,
   *   earlier?: [{ start, rows }],
   *   ctx?: { clubs, settings, name },
   *   story?: { headline, clubs, best, fault },
   *   compare?: { headline, items, verdict },
   *   focus?: { move, aim, club, scope, since, results, evidence },
   *   focusCmp?: { before, after, move, results },
   *   focusWorking?: { head, next, cls },
   *   programReport?: string | { text: string },
   *   date?: string | number,
   *   swings?: number,
   * }
   * @returns {string} Plain text brief under 4,000 words.
   */
  function brief(input) {
    if (!input) return "";

    const lines = [];

    // Resolve session & rows
    const sessionObj = input.session && typeof input.session === "object" && !Array.isArray(input.session)
      ? input.session
      : null;
    const rows = Array.isArray(input.session)
      ? input.session
      : sessionObj && Array.isArray(sessionObj.rows)
      ? sessionObj.rows
      : Array.isArray(input.rows)
      ? input.rows
      : [];

    const startTime = input.date || (sessionObj && sessionObj.start) || (rows.length && rows[0].t);
    const swingCount = input.swings != null ? input.swings : rows.length;

    // 1. Session Section
    lines.push("# Session");
    if (startTime) {
      lines.push(`Date: ${formatDate(startTime)}`);
    }
    if (swingCount > 0) {
      lines.push(`Total swings: ${swingCount}`);
    }

    // Clubs breakdown from rows
    const clubCounts = new Map();
    for (const r of rows) {
      const c = r.club || (r.c && r.c.shot && r.c.shot.club);
      if (c) clubCounts.set(c, (clubCounts.get(c) || 0) + 1);
    }
    if (clubCounts.size > 0) {
      const clubSummaries = [];
      for (const [c, count] of clubCounts.entries()) {
        clubSummaries.push(`${plainClubName(c)} (${count} swings)`);
      }
      lines.push(`Clubs: ${clubSummaries.join(", ")}`);
    }

    // Session Story: use input.story or compute if SessionStory available
    let story = input.story;
    if (!story && SessionStory && sessionObj && sessionObj.rows) {
      try {
        story = SessionStory.story(sessionObj, input.earlier || [], input.ctx || {});
      } catch (e) {
        story = null;
      }
    }

    if (story) {
      if (story.headline) {
        lines.push(`Headline: ${story.headline}`);
      }
      if (Array.isArray(story.clubs) && story.clubs.length > 0) {
        lines.push("Club performance:");
        for (const cl of story.clubs) {
          const pct = Math.round((cl.goodRate || 0) * 100);
          const noteStr = cl.note ? ` - ${cl.note}` : "";
          lines.push(`  - ${plainClubName(cl.club)}: ${cl.n} judged shots, ${pct}% good${noteStr}`);
        }
      }
      if (story.best && story.best.why) {
        lines.push(`Best swing to rewatch: ${story.best.why}`);
      }
      if (story.fault) {
        const faultName = (typeof story.fault.name === "string" && story.fault.name)
          || (typeof story.fault.readable === "string" && story.fault.readable)
          || "Fault";
        const countStr = story.fault.count
          ? (typeof story.fault.readable === "number"
            ? ` (${story.fault.count} of ${story.fault.readable} swings)`
            : ` (${story.fault.count} swings)`)
          : "";
        lines.push(`Top fault: ${faultName}${countStr}`);
        if (story.fault.drill) lines.push(`  Drill: ${story.fault.drill}`);
        if (story.fault.thought) lines.push(`  Swing thought: ${story.fault.thought}`);
      }
    }

    // 2. Comparison Section: Against Earlier Sessions
    let cmp = input.compare;
    if (!cmp && SessionScore && sessionObj && sessionObj.rows && Array.isArray(input.earlier) && input.earlier.length > 0) {
      try {
        cmp = SessionScore.compare([...input.earlier, sessionObj], input.ctx || {});
      } catch (e) {
        cmp = null;
      }
    }

    if (cmp && (cmp.headline || (Array.isArray(cmp.items) && cmp.items.length > 0))) {
      lines.push("");
      lines.push("# Against Earlier Sessions");
      if (cmp.headline) {
        lines.push(`Comparison summary: ${cmp.headline}`);
      }
      if (Array.isArray(cmp.items)) {
        for (const it of cmp.items) {
          if (it.now == null) continue;
          const fmtNow = it.unit === "%" ? `${Math.round(it.now * 100)}%` : `${it.now.toFixed(1)} ${it.unit}`;
          const fmtLast = it.last != null ? (it.unit === "%" ? `${Math.round(it.last * 100)}%` : `${it.last.toFixed(1)} ${it.unit}`) : "n/a";
          const fmtUsual = it.usual != null ? (it.unit === "%" ? `${Math.round(it.usual * 100)}%` : `${it.usual.toFixed(1)} ${it.unit}`) : "n/a";
          const chgStr = it.change ? `, change: ${it.change}${it.clear ? " (clear)" : ""}` : "";
          lines.push(`  - ${it.label}: now ${fmtNow} (last session: ${fmtLast}, usual: ${fmtUsual}${chgStr})`);
        }
      }
    }

    // 3. Focus Section
    const focus = input.focus;
    if (focus && (focus.move || focus.aim)) {
      lines.push("");
      lines.push("# Current Focus");

      const moveLabel = METRIC_LABELS[focus.move] || focus.move || "Current focus";
      const scopeText = focus.scope
        ? ` (${focus.scope === "woods" ? "driver and woods" : "irons"})`
        : focus.club
        ? ` (${plainClubName(focus.club)})`
        : "";
      const sinceText = focus.since ? ` since ${focus.since}` : "";
      // The move in golf words, with what it is, its drill and swing thought (coach.js).
      const plain = (root.SwingShotStory && root.SwingShotStory.plain) || (t => t);
      const fix = Coach && Coach.MOVES && Coach.MOVES[focus.move] ? Coach.MOVES[focus.move][focus.aim] : null;
      if (fix) {
        lines.push(`Focus: ${plain(fix.name)}${scopeText}${sinceText} (measured as ${moveLabel.toLowerCase()}, aiming for ${focus.aim === "more" ? "more" : "less"})`);
        if (fix.how) lines.push(`What it is: ${plain(fix.how)}`);
        if (fix.drill) lines.push(`Its drill: ${plain(fix.drill)}`);
        if (fix.thought) lines.push(`Its swing thought: ${plain(fix.thought)}`);
      } else {
        lines.push(`Focus move: ${moveLabel}${focus.aim ? ` - aim: ${focus.aim}` : ""}${scopeText}${sinceText}`);
      }

      // Evidence lines
      if (Array.isArray(focus.evidence) && focus.evidence.length > 0) {
        lines.push("Evidence for focus:");
        for (const ev of focus.evidence) {
          lines.push(`  - ${ev}`);
        }
      } else if (typeof focus.evidence === "string" && focus.evidence.trim()) {
        lines.push(`Evidence for focus: ${focus.evidence.trim()}`);
      }

      // Focus progress / working
      let focusWorking = input.focusWorking;
      let focusCmp = input.focusCmp;

      if (!focusWorking && Focus && focusCmp) {
        try {
          focusWorking = Focus.working(focusCmp, k => METRIC_LABELS[k] || k);
        } catch (e) {
          focusWorking = null;
        }
      }

      if (focusWorking) {
        if (focusWorking.head) lines.push(`Focus status: ${focusWorking.head}`);
        if (focusWorking.next) lines.push(`Focus next step: ${focusWorking.next}`);
      }

      if (focusCmp) {
        if (focusCmp.move && focusCmp.move.before != null && focusCmp.move.after != null) {
          const mv = focusCmp.move;
          const k = mv.key || focus.move;
          const vrd = Focus && Focus.verdict ? Focus.verdict(mv) : mv.level || "";
          lines.push(`Move progress (${METRIC_LABELS[k] || k}):`);
          lines.push(`  Before median: ${formatMetricValue(k, mv.before)}, since median: ${formatMetricValue(k, mv.after)} (change: ${formatMetricValue(k, mv.change)}, verdict: ${vrd})`);
        }

        if (Array.isArray(focusCmp.results) && focusCmp.results.length > 0) {
          lines.push("Results following focus:");
          for (const res of focusCmp.results) {
            if (res.before == null || res.after == null) continue;
            const rk = res.key;
            const rVrd = Focus && Focus.verdict ? Focus.verdict(res) : res.level || "";
            lines.push(`  - ${METRIC_LABELS[rk] || rk}: before ${formatMetricValue(rk, res.before)}, since ${formatMetricValue(rk, res.after)} (change: ${formatMetricValue(rk, res.change)}, verdict: ${rVrd})`);
          }
        }
      }
    }

    // 4. Coach Program Section
    const progRep = input.programReport != null
      ? (typeof input.programReport === "object" ? input.programReport.text : String(input.programReport))
      : null;
    if (progRep && progRep.trim()) {
      lines.push("");
      lines.push("# Coach Program Run");
      lines.push(progRep.trim());
    }

    const result = lines.join("\n").trim();

    // Check word count safety
    const words = result.split(/\s+/).filter(Boolean);
    if (words.length > 4000) {
      return words.slice(0, 3950).join(" ") + "\n... [brief truncated under 4000 words]";
    }

    return result;
  }

  /**
   * How the focus is going, for pages without Progress's code (the Start page): the move itself and its
   * results, before and since the focus started (focus.js), from sessions [{start, rows}] of any club
   * (oldest first), kept to the focus's club or club group. {} when focus.js isn't loaded or no focus.
   */
  function focusProgress(focus, sessions) {
    if (!focus || !focus.move || !Focus || !GoodShots) return {};
    const scope = focus.scope || focus.club || null;
    const keep = r => scope === "irons" || scope === "woods" ? GoodShots.groupOf(r.club) === scope
      : scope ? r.club === scope : !!GoodShots.groupOf(r.club);
    const ss = (sessions || []).map(s => ({ start: s.start, rows: (s.rows || []).filter(keep), moved: {} })).filter(s => s.rows.length);
    try {
      const focusCmp = Focus.compare(ss, focus);
      return { focusCmp, focusWorking: Focus.working(focusCmp, k => (METRIC_LABELS[k] || k).toLowerCase()) };
    } catch (e) {
      return {};
    }
  }

  const api = {
    focusProgress,
    brief,
    formatMetricValue,
    plainClubName,
    METRIC_LABELS,
    METRIC_UNITS,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingAICoach = api;
})(typeof window !== "undefined" ? window : globalThis);
