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
  const Goal = root.SwingGoal || (typeof require !== "undefined" && (function() { try { return require("./goal.js"); } catch(e){ return null; } })());

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
    const focusSec = formatFocus(input);
    if (focusSec) {
      lines.push("");
      lines.push(focusSec);
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

  function formatFocus(input) {
    if (!input) return "";
    const focus = input.focus;
    if (!focus || (!focus.move && !focus.aim)) return "";
    const lines = [];
    lines.push("# Current Focus");

    const moveLabel = METRIC_LABELS[focus.move] || focus.move || "Current focus";
    const scopeText = focus.scope
      ? ` (${focus.scope === "woods" ? "driver and woods" : "irons"})`
      : focus.club
      ? ` (${plainClubName(focus.club)})`
      : "";
    const sinceText = focus.since ? ` since ${focus.since}` : "";
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

    if (Array.isArray(focus.evidence) && focus.evidence.length > 0) {
      lines.push("Evidence for focus:");
      for (const ev of focus.evidence) {
        lines.push(`  - ${ev}`);
      }
    } else if (typeof focus.evidence === "string" && focus.evidence.trim()) {
      lines.push(`Evidence for focus: ${focus.evidence.trim()}`);
    }

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

    const goal = input.focusGoal;
    if (goal && goal.target) {
      const t = goal.target;
      const targetDir = t.side === "below" ? "under" : "over";
      const boundStr = formatMetricValue(focus.move, t.bound);
      const PB_TARGET_FROM = { own: "your own target", before: "your usual before you started", first: "your first session with it" };
      const fromStr = PB_TARGET_FROM[t.from] || "your usual before you started";
      lines.push(`Target: ${targetDir} ${boundStr}, ${fromStr}`);

      if (goal.latest && goal.latest.n) {
        lines.push(`Latest session score: ${goal.latest.k} of ${goal.latest.n} swings in target`);
      }

      const beforeRate = goal.before && goal.before.rate != null ? `${Math.round(goal.before.rate * 100)}%` : null;
      const afterRate = goal.after && goal.after.rate != null ? `${Math.round(goal.after.rate * 100)}%` : null;
      if (beforeRate || afterRate) {
        const parts = [];
        if (beforeRate) parts.push(`${beforeRate} before`);
        if (afterRate) parts.push(`${afterRate} since`);
        lines.push(`Share in target: ${parts.join(", ")}`);
      }

      if (goal.best && goal.best.rate != null) {
        lines.push(`Best session: ${goal.best.k} of ${goal.best.n} (${Math.round(goal.best.rate * 100)}%)`);
      }

      if (goal.cameraMoved) {
        lines.push("A camera moved since it started: scores either side may not compare");
      }
    }

    return lines.join("\n");
  }

  /**
   * Builds the 30-day question brief:
   * 1. Latest session brief (via brief(), without focus).
   * 2. Per club last 30 days' medians of carry, offline, club path, face to path,
   *    attack angle and strike (face-centred) with shot count.
   * 3. Focus section (as brief() gives it).
   */
  function questionBrief(input) {
    if (!input) return "";

    const lines = [];

    // 1. Latest session brief
    let sessionBrief = "";
    if (typeof input.brief === "string") {
      sessionBrief = input.brief;
      const fIdx = sessionBrief.indexOf("# Current Focus");
      if (fIdx !== -1) {
        sessionBrief = sessionBrief.slice(0, fIdx).trim();
      }
    } else if (input.session || input.rows) {
      sessionBrief = brief({ ...input, focus: null });
    }
    if (sessionBrief) {
      lines.push(sessionBrief);
    }

    // 2. Per club last 30 days' medians
    lines.push("");
    lines.push("# Last 30 Days by Club");

    const nowMs = (input.session && input.session.start)
      ? (input.session.start < 1e11 ? input.session.start * 1000 : input.session.start)
      : Date.now();
    const thirtyDaysAgo = nowMs - 30 * 86400 * 1000;

    let allRows = [];
    if (Array.isArray(input.rows30d)) {
      allRows = input.rows30d;
    } else if (Array.isArray(input.sessions30d)) {
      allRows = input.sessions30d.flatMap(s => s.rows || []);
    } else if (Array.isArray(input.sessions)) {
      for (const s of input.sessions) {
        const sTime = s.start < 1e11 ? s.start * 1000 : s.start;
        if (sTime >= thirtyDaysAgo && sTime <= nowMs + 86400 * 1000) {
          allRows.push(...(s.rows || []));
        }
      }
    } else if (Array.isArray(input.earlier)) {
      const sessList = [...input.earlier];
      if (input.session && typeof input.session === "object" && !Array.isArray(input.session)) {
        sessList.push(input.session);
      }
      for (const s of sessList) {
        const sTime = s.start < 1e11 ? s.start * 1000 : s.start;
        if (sTime >= thirtyDaysAgo && sTime <= nowMs + 86400 * 1000) {
          allRows.push(...(s.rows || []));
        }
      }
    } else if (Array.isArray(input.rows)) {
      allRows = input.rows.filter(r => {
        if (!r.t) return true;
        const t = r.t < 1e11 ? r.t * 1000 : r.t;
        return t >= thirtyDaysAgo && t <= nowMs + 86400 * 1000;
      });
    }

    function rowVal(r, key) {
      if (r[key] != null && Number.isFinite(r[key])) return r[key];
      if (r.shot && r.shot[key] != null && Number.isFinite(r.shot[key])) return r.shot[key];
      if (r.c && r.c.shot && r.c.shot[key] != null && Number.isFinite(r.c.shot[key])) return r.c.shot[key];
      return null;
    }

    function rowClub(r) {
      return r.club || (r.shot && r.shot.club) || (r.c && r.c.shot && r.c.shot.club) || null;
    }

    function calcMedian(vals) {
      const nums = vals.filter(v => v != null && Number.isFinite(v)).sort((a, b) => a - b);
      if (!nums.length) return null;
      const mid = Math.floor(nums.length / 2);
      return nums.length % 2 !== 0 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
    }

    function bagRank(code) {
      if (!code) return -1;
      const c = String(code).toUpperCase().trim();
      if (c === "PT" || c === "PUTTER") return -1;
      if (c === "DR" || c === "1W" || c === "DRIVER") return 100;
      let m = c.match(/^(?:W(\d+)|(\d+)W)$/);
      if (m) return 200 + parseInt(m[1] || m[2], 10);
      m = c.match(/^(?:H(\d+)|(\d+)H)$/);
      if (m) return 300 + parseInt(m[1] || m[2], 10);
      m = c.match(/^(?:I(\d+)|(\d+)I)$/);
      if (m) return 400 + parseInt(m[1] || m[2], 10);
      m = c.match(/^(\d+)\s*WOOD$/);
      if (m) return 200 + parseInt(m[1], 10);
      m = c.match(/^(\d+)\s*HYBRID$/);
      if (m) return 300 + parseInt(m[1], 10);
      m = c.match(/^(\d+)\s*IRON$/);
      if (m) return 400 + parseInt(m[1], 10);
      if (c === "PW" || c === "PITCHING" || c === "PITCHING WEDGE") return 500;
      if (c === "GW" || c === "GAP" || c === "GAP WEDGE" || c === "AW" || c === "UW") return 510;
      if (c === "SW" || c === "SAND" || c === "SAND WEDGE") return 520;
      if (c === "LW" || c === "LOB" || c === "LOB WEDGE") return 530;
      return 999;
    }

    const byClub = new Map();
    for (const r of allRows) {
      const c = rowClub(r);
      if (!c) continue;
      if (!byClub.has(c)) byClub.set(c, []);
      byClub.get(c).push(r);
    }

    const sortedClubs = [...byClub.keys()].sort((a, b) => bagRank(a) - bagRank(b));

    if (sortedClubs.length === 0) {
      lines.push("No shots recorded in the last 30 days.");
    } else {
      for (const cl of sortedClubs) {
        const cRows = byClub.get(cl);
        const count = cRows.length;
        const medCarry = calcMedian(cRows.map(r => rowVal(r, "carry")));
        const medOffline = calcMedian(cRows.map(r => rowVal(r, "offline")));
        const medPath = calcMedian(cRows.map(r => rowVal(r, "path")));
        const medFaceToPath = calcMedian(cRows.map(r => rowVal(r, "faceToPath")));
        const medAttack = calcMedian(cRows.map(r => rowVal(r, "attack")));
        const medStrikeV = calcMedian(cRows.map(r => rowVal(r, "strikeV")));

        const parts = [];
        if (medCarry != null) parts.push(`carry ${formatMetricValue("carry", medCarry).trim()}`);
        if (medOffline != null) parts.push(`offline ${formatMetricValue("offline", medOffline).trim()}`);
        if (medPath != null) parts.push(`club path ${formatMetricValue("path", medPath).trim()}`);
        if (medFaceToPath != null) parts.push(`face to path ${formatMetricValue("faceToPath", medFaceToPath).trim()}`);
        if (medAttack != null) parts.push(`attack angle ${formatMetricValue("attack", medAttack).trim()}`);
        if (medStrikeV != null) parts.push(`strike ${formatMetricValue("strikeV", medStrikeV).trim()}`);

        const itemsStr = parts.length > 0 ? parts.join(", ") : "no launch metrics";
        lines.push(`  - ${plainClubName(cl)} (${count} shots): ${itemsStr}`);
      }
    }

    // 3. Focus Section
    const focusSection = formatFocus(input);
    if (focusSection) {
      lines.push("");
      lines.push(focusSection);
    }

    const result = lines.join("\n").trim();
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
      const res = { focusCmp, focusWorking: Focus.working(focusCmp, k => (METRIC_LABELS[k] || k).toLowerCase()) };
      if (Goal && Goal.progress) {
        res.focusGoal = Goal.progress(ss, focus);
      }
      return res;
    } catch (e) {
      return {};
    }
  }

  /**
   * The coach's take as text pieces: [{text, bold}]. Models write a little Markdown (**How it went**,
   * # headings, - bullets); bold is kept as bold, the other marks are dropped, nothing is HTML.
   */
  function takeParts(text) {
    const clean = String(text || "").split("\n")
      .map(l => l.replace(/^\s{0,3}#{1,6}\s+(.*)$/, "**$1**").replace(/^(\s*)[-*]\s+/, "$1• "))
      .join("\n").replace(/__([^_\n]+)__/g, "**$1**");
    const out = [];
    const re = /\*\*([^*\n]+)\*\*/g;
    let at = 0, m;
    while ((m = re.exec(clean))) {
      if (m.index > at) out.push({ text: clean.slice(at, m.index), bold: false });
      out.push({ text: m[1], bold: true });
      at = re.lastIndex;
    }
    if (at < clean.length) out.push({ text: clean.slice(at), bold: false });
    return out.map(p => ({ ...p, text: p.text.replace(/\*\*/g, "") }));
  }

  /** Fills an element with the take (browser): text nodes, and <b> for bold. */
  function renderTake(el, text) {
    el.replaceChildren(...takeParts(text).map(p => p.bold
      ? Object.assign(document.createElement("b"), { textContent: p.text }) : document.createTextNode(p.text)));
    return el;
  }

  const api = {
    takeParts,
    renderTake,
    focusProgress,
    brief,
    questionBrief,
    formatMetricValue,
    plainClubName,
    METRIC_LABELS,
    METRIC_UNITS,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingAICoach = api;
})(typeof window !== "undefined" ? window : globalThis);
