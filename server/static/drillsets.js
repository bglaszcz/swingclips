// Drill sets: groups drill swings (recorded in drill mode, app.py /api/drill)
// into sets (same drill, same session, <= 20 min between swings) and answers:
// does the drill carry over into normal swings?
//
// For each set:
//   date, drill, club(s), count;
//   pumps' median hands-to-plane (and lag);
//   drill swings' own P6 median;
//   normal swings with the same club in the same session: up to 15 before and 15 after,
//   their P6 medians and counts. With fewer than MIN_SWINGS trusted ones before the set (a session
//   that starts with the drill), "before" is the last 15 trusted same-club normal swings of earlier
//   sessions instead (before.earlier: "your usual").
//
// Leave out swings whose numbers are shaky or missing under trust.js (estimated P6,
// doubtful impact, bad camera, dark/flicker, or missing value).
//
// verdict(set, range):
//   - did the drill swings' P6 get closer to the pumps than before?
//   - did the after swings move toward the pumps compared with before?
//   Measures against session wobble (as focus.js / Progress step 3),
//   reporting "clearly / maybe / no change / too few swings".
//
// Works in the browser (window.SwingDrillSets) and in Node (module.exports).
(function (root) {
  const Summary = root.SwingSummary || (typeof require !== "undefined" && require("./summary.js"));
  const Trust = root.SwingTrust || (typeof require !== "undefined" && require("./trust.js"));
  const Coach = root.SwingCoach || (typeof require !== "undefined" && require("./coach.js"));

  const SESSION_GAP_MS = 45 * 60 * 1000;
  const SET_GAP_MS = 20 * 60 * 1000;
  const MAX_NORMAL_SWINGS = 15;
  const MIN_SWINGS = 3;
  const P6_DRILLS = new Set(["pump"]);

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

  function sd(xs) {
    const v = xs.filter(finite);
    if (v.length < 2) return null;
    const m = v.reduce((s, x) => s + x, 0) / v.length;
    return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
  }

  const CLUB_NAMES = { DR: "driver", PW: "PW", GW: "GW", SW: "SW", LW: "LW", PT: "putter" };
  function clubName(code) {
    if (!code) return "";
    if (CLUB_NAMES[code]) return CLUB_NAMES[code];
    const m = code.match(/^([WHI])(\d)$/);
    return m ? `${m[2]}${{ W: " wood", H: " hybrid", I: " iron" }[m[1]]}` : code;
  }

  function formatDate(d) {
    if (!d) return "";
    const dt = d instanceof Date ? d : new Date(d);
    if (isNaN(dt.getTime())) return String(d);
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  /**
   * Checks whether a swing's P6 hands-to-plane is trustworthy or shaky/missing.
   * Shaky: P6 estimated (quality.p6Estimated), doubtful impact, bad camera, dark/flicker.
   * Missing: no reading (null/undefined/NaN), or camera check "out"/"hands".
   * Note: 'noisy' by definition (trust.js NOISY) is NOT treated as a reason to exclude a swing,
   * because plane numbers are noisy by definition on every swing and judged over sets.
   */
  function checkP6Trust(rec, clip, noiseTable) {
    if (!rec || !rec.body || rec.error) return { valid: false, reason: "missing" };
    const val = rec.body.handsPlaneP6;
    if (!finite(val)) return { valid: false, reason: "missing" };

    if (rec.quality && rec.quality.p6Estimated) {
      return { valid: false, reason: "estimated" };
    }

    if (Trust && typeof Trust.judge === "function") {
      const facts = Trust.factsOf(rec, clip && clip.quality);
      const j = Trust.judge(Trust.numberOf("handsPlaneP6"), facts, val, noiseTable, "in");
      if (j.level === "none") return { valid: false, reason: "none", codes: j.codes };
      const shakyCodes = (j.codes || []).filter(c => c !== "noisy" && c !== "ok");
      if (shakyCodes.length > 0) return { valid: false, reason: "shaky", codes: shakyCodes };
    }

    return { valid: true, value: val };
  }

  /**
   * Groups drill swings into sets and finds normal swings around them with the same club.
   *
   * @param {Array<object>} clips list of clips (newest or oldest first)
   * @param {object} records map of clipName -> swingRecord (or { swings, noise })
   * @param {object} [options]
   *   - setGapMs: max ms between drill swings in a set (default: 20 min)
   *   - sessionGapMs: max ms between swings in a session (default: 45 min)
   *   - maxNormal: max normal swings before/after (default: 15)
   *   - noiseTable: noise table for trust.js
   * @returns {Array<object>} sets newest first
   */
  function sets(clips = [], records = {}, options = {}) {
    const recMap = (records && records.swings) ? records.swings : (records || {});
    const noise = options.noiseTable || (records && records.noise) || null;
    const maxNormal = options.maxNormal || MAX_NORMAL_SWINGS;
    const setGap = options.setGapMs || SET_GAP_MS;
    const sessionGap = options.sessionGapMs || SESSION_GAP_MS;

    // Filter to primary clips (face-on or un-partnered)
    const primary = clips.filter(c => !c.partner || c.angle === "face");
    if (!primary.length) return [];

    // Chronological order (oldest first)
    const sorted = [...primary].map(c => ({
      c,
      t: new Date(c.recorded).getTime(),
      rec: recMap[c.name] || null
    })).filter(x => !isNaN(x.t)).sort((a, b) => a.t - b.t);

    if (!sorted.length) return [];

    // Group into sessions by session gap
    const sessions = [];
    let currentSession = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].t - sorted[i - 1].t > sessionGap) {
        sessions.push(currentSession);
        currentSession = [sorted[i]];
      } else {
        currentSession.push(sorted[i]);
      }
    }
    sessions.push(currentSession);

    const outSets = [];
    const isNormal = s => !s.c.drill && !(s.rec && s.rec.drill);

    for (const [sessIdx, sess] of sessions.entries()) {
      // Find drill sets within this session
      // A set is a contiguous sequence of drill swings of the same drill, <= setGap apart
      let i = 0;
      while (i < sess.length) {
        const item = sess[i];
        const drill = item.c.drill || (item.rec && item.rec.drill && item.rec.drill.kind) || null;
        // Only drills that rehearse a P6 (the pump): the coach program's blocks report on their own (programs.py).
        if (!P6_DRILLS.has(drill)) {
          i++;
          continue;
        }

        // Start of a drill set
        const drillSwings = [item];
        let j = i + 1;
        while (j < sess.length) {
          const next = sess[j];
          const nextDrill = next.c.drill || (next.rec && next.rec.drill && next.rec.drill.kind) || null;
          if (nextDrill !== drill) break; // interrupted by normal swing or different drill
          if (next.t - sess[j - 1].t > setGap) break; // gap too large
          drillSwings.push(next);
          j++;
        }

        const setStartIdx = i;
        const setEndIdx = j - 1;
        i = j;

        // Clubs used in drill swings
        const clubsUsed = [...new Set(drillSwings.map(s => s.c.shot && s.c.shot.club).filter(Boolean))];
        const primaryClub = clubsUsed[0] || (sess.find(s => s.c.shot && s.c.shot.club)?.c.shot?.club) || options.defaultClub || null;

        // Collect pumps
        const allPumpHands = [];
        const allPumpLag = [];
        for (const s of drillSwings) {
          const pumps = s.rec && s.rec.drill && Array.isArray(s.rec.drill.pumps) ? s.rec.drill.pumps : [];
          for (const p of pumps) {
            if (finite(p.handsPlane)) allPumpHands.push(p.handsPlane);
            if (finite(p.lag)) allPumpLag.push(p.lag);
          }
        }

        // Drill swings P6 trust evaluation
        const validDrillP6 = [];
        let drillLeftOut = 0;
        for (const s of drillSwings) {
          const tRes = checkP6Trust(s.rec, s.c, noise);
          if (tRes.valid) validDrillP6.push(tRes.value);
          else drillLeftOut++;
        }

        // Normal swings with matching club in this session
        const isMatchingClub = s => {
          if (!primaryClub) return !s.c.drill && !(s.rec && s.rec.drill);
          return (!s.c.drill && !(s.rec && s.rec.drill)) && (!s.c.shot || !s.c.shot.club || s.c.shot.club === primaryClub);
        };

        // Before set (closest up to maxNormal)
        const normalBefore = sess.slice(0, setStartIdx).filter(isMatchingClub);
        const candBefore = normalBefore.slice(-maxNormal);
        const validBefore = [];
        let beforeLeftOut = 0;
        for (const s of candBefore) {
          const tRes = checkP6Trust(s.rec, s.c, noise);
          if (tRes.valid) validBefore.push(tRes.value);
          else beforeLeftOut++;
        }

        // After set (closest up to maxNormal)
        const normalAfter = sess.slice(setEndIdx + 1).filter(isMatchingClub);
        const candAfter = normalAfter.slice(0, maxNormal);
        const validAfter = [];
        let afterLeftOut = 0;
        for (const s of candAfter) {
          const tRes = checkP6Trust(s.rec, s.c, noise);
          if (tRes.valid) validAfter.push(tRes.value);
          else afterLeftOut++;
        }

        // A session that starts with the drill: the same club's trusted normal swings from earlier
        // sessions, the latest first, are what "before" means ("your usual").
        let earlier = false;
        if (validBefore.length < MIN_SWINGS && primaryClub) {
          const usual = [];
          for (let k = sessIdx - 1; k >= 0 && usual.length < maxNormal; k--) {
            for (let m = sessions[k].length - 1; m >= 0 && usual.length < maxNormal; m--) {
              const s = sessions[k][m];
              if (!isNormal(s) || !s.c.shot || s.c.shot.club !== primaryClub) continue;
              const tRes = checkP6Trust(s.rec, s.c, noise);
              if (tRes.valid) usual.push(tRes.value);
            }
          }
          if (usual.length >= MIN_SWINGS) {
            validBefore.splice(0, validBefore.length, ...usual.reverse());
            beforeLeftOut = 0;
            earlier = true;
          }
        }

        const totalLeftOut = drillLeftOut + beforeLeftOut + afterLeftOut;
        const firstItem = drillSwings[0];
        const lastItem = drillSwings[drillSwings.length - 1];

        const setObj = {
          date: firstItem.c.recorded ? firstItem.c.recorded.split("T")[0] : "",
          dateFormatted: formatDate(firstItem.t),
          timestamp: firstItem.t,
          drill,
          club: primaryClub,
          clubs: clubsUsed.length ? clubsUsed : (primaryClub ? [primaryClub] : []),
          clubName: clubName(primaryClub),
          count: drillSwings.length,
          firstClip: firstItem.c.name,
          lastClip: lastItem.c.name,
          clips: drillSwings.map(s => s.c.name),
          pumps: {
            count: allPumpHands.length,
            handsPlane: median(allPumpHands),
            lag: median(allPumpLag)
          },
          pumpsHandsPlane: median(allPumpHands),
          pumpsLag: median(allPumpLag),
          drillP6: median(validDrillP6),
          drillP6Count: validDrillP6.length,
          drillSwings: validDrillP6,
          before: {
            earlier,
            count: validBefore.length,
            median: median(validBefore),
            swings: validBefore
          },
          after: {
            count: validAfter.length,
            median: median(validAfter),
            swings: validAfter
          },
          leftOut: totalLeftOut,
          leftOutDetail: {
            drill: drillLeftOut,
            before: beforeLeftOut,
            after: afterLeftOut
          }
        };

        outSets.push(setObj);
      }
    }

    // Newest first
    outSets.sort((a, b) => b.timestamp - a.timestamp);
    return outSets;
  }

  /**
   * Plain-words verdict on carry-over against wobble.
   *
   * @param {object} set set from sets()
   * Against the swings before the set (or, for a session that starts with the drill, the usual
   * ones from earlier sessions: sets() before.earlier); with fewer than MIN_SWINGS of those, only
   * "too few swings".
   * @returns {object} verdict object with .text, .level, and toString()
   */
  function verdict(set) {
    if (!set) return makeVerdict("too few swings", "few");

    const pumpT = set.pumps ? set.pumps.handsPlane : null;
    if (pumpT == null) return makeVerdict("too few swings", "few");

    const nDrill = set.drillP6Count != null ? set.drillP6Count : (set.drillSwings ? set.drillSwings.length : 0);
    const mDrill = set.drillP6;

    const nAfter = set.after ? set.after.count : 0;
    const mAfter = set.after ? set.after.median : null;

    const nBefore = set.before ? set.before.count : 0;
    const mBefore = set.before ? set.before.median : null;

    // Minimum check
    if (nDrill < MIN_SWINGS || nBefore < MIN_SWINGS) {
      return makeVerdict("too few swings", "few");
    }

    // Pooled within-session variance
    const groups = [
      set.drillSwings || [],
      (set.after && set.after.swings) || [],
      (set.before && set.before.swings) || []
    ].filter(g => g.length > 0);

    let ss = 0, df = 0;
    for (const g of groups) {
      if (g.length < 2) continue;
      const m = g.reduce((s, x) => s + x, 0) / g.length;
      ss += g.reduce((s, x) => s + (x - m) ** 2, 0);
      df += g.length - 1;
    }
    const within = df > 0 ? Math.sqrt(ss / df) : 1.0;

    // 1. Did drill swings' P6 get closer to pumps than before?
    let drillCloser = "few";
    if (mBefore != null && mDrill != null && nBefore > 0) {
      const dBefore = Math.abs(mBefore - pumpT);
      const dDrill = Math.abs(mDrill - pumpT);
      const deltaDrill = dBefore - dDrill; // > 0 means closer
      const wobbleDrill = Math.max(1.25 * within * Math.sqrt(1 / nBefore + 1 / nDrill), 1e-9);
      const sizeDrill = deltaDrill / wobbleDrill;
      if (deltaDrill <= 0 || sizeDrill < 1.5) drillCloser = "none";
      else if (sizeDrill >= 2.0) drillCloser = "clear";
      else drillCloser = "maybe";
    }

    // 2. Did after swings move toward pumps compared with before?
    let afterMoved = "few";
    if (nAfter >= MIN_SWINGS && mBefore != null && mAfter != null && nBefore > 0) {
      const dBefore = Math.abs(mBefore - pumpT);
      const dAfter = Math.abs(mAfter - pumpT);
      const deltaAfter = dBefore - dAfter; // > 0 means closer
      const wobbleAfter = Math.max(1.25 * within * Math.sqrt(1 / nBefore + 1 / nAfter), 1e-9);
      const sizeAfter = deltaAfter / wobbleAfter;
      if (deltaAfter <= 0 || sizeAfter < 1.5) afterMoved = "none";
      else if (sizeAfter >= 2.0) afterMoved = "clear";
      else afterMoved = "maybe";
    } else if (nAfter < MIN_SWINGS) {
      afterMoved = "few";
    }

    // Plain-words synthesis
    let text = "";
    let level = "none";

    if (afterMoved === "clear") {
      text = "clear carry-over into your swings";
      level = "clear";
    } else if (afterMoved === "maybe") {
      text = "maybe carrying over";
      level = "maybe";
    } else if (afterMoved === "none") {
      if (drillCloser === "clear") {
        text = "closer in the drill swings, but no carry-over yet";
        level = "none";
      } else if (drillCloser === "maybe") {
        text = "maybe closer in the drill swings, but no carry-over yet";
        level = "none";
      } else {
        text = "no carry-over yet";
        level = "none";
      }
    } else {
      // afterMoved is 'few'
      if (drillCloser === "clear") {
        text = "clear change in the drill swings, too few swings after";
        level = "clear";
      } else if (drillCloser === "maybe") {
        text = "maybe closer in the drill swings, too few swings after";
        level = "maybe";
      } else {
        text = "too few swings";
        level = "few";
      }
    }

    return makeVerdict(text, level, { drillCloser, afterMoved });
  }

  function makeVerdict(text, level, details = {}) {
    return {
      text,
      level,
      ...details,
      toString() { return this.text; }
    };
  }

  /**
   * Formats a set into a single concise line.
   * e.g. "Pump drill, Sep 30 (10 swings, 7 iron): pumps -0.9 in, drill swings' hands in the downswing 4.7 in, your swings after 4.3 in (before 4.4 in): no carry-over yet."
   */
  function formatSet(set, verd) {
    if (!set) return "";
    const drillName = set.drill === "pump" ? "Pump drill" : (set.drill ? `${set.drill} drill` : "Drill");
    const dateStr = set.dateFormatted || formatDate(set.timestamp || set.date);
    const clubStr = set.clubName || clubName(set.club) || set.club || "";
    const countStr = `${set.count} swing${set.count === 1 ? "" : "s"}${clubStr ? ", " + clubStr : ""}`;

    const fmt = v => v == null ? "–" : `${v.toFixed(1)} in`;

    const parts = [];
    if (set.pumps && set.pumps.handsPlane != null) {
      parts.push(`pumps ${fmt(set.pumps.handsPlane)}`);
    }
    if (set.drillP6 != null) {
      parts.push(`drill swings' hands in the downswing ${fmt(set.drillP6)}`);
    }
    if (set.after && set.after.count > 0) {
      let afterPart = `your swings after ${fmt(set.after.median)}`;
      if (set.before && set.before.count > 0) {
        afterPart += ` (${set.before.earlier ? "your usual" : "before"} ${fmt(set.before.median)})`;
      }
      parts.push(afterPart);
    } else if (set.before && set.before.count > 0) {
      parts.push(`${set.before.earlier ? "your usual" : "your swings before"} ${fmt(set.before.median)}`);
    }

    const numbersStr = parts.join(", ");
    const vObj = verd != null ? verd : verdict(set);
    const vText = typeof vObj === "string" ? vObj : (vObj && vObj.text) || "";
    const vSuffix = vText ? `: ${vText}.` : ".";

    let line = `${drillName}, ${dateStr} (${countStr}): ${numbersStr}${vSuffix}`;
    if (set.leftOut > 0) {
      line += ` (${set.leftOut} left out)`;
    }
    return line;
  }

  /**
   * Finds the swing thought from coach.js for a drill set.
   */
  function thoughtFor(set, focus) {
    if (set && set.drill === "pump") {
      const mv = Coach && Coach.MOVES ? Coach.MOVES.handsPlaneP6 : null;
      if (mv && mv.less && mv.less.thought) return mv.less.thought;
    }
    if (focus && focus.move && Coach && Coach.MOVES) {
      const mv = Coach.MOVES[focus.move];
      const fix = mv && focus.aim ? mv[focus.aim] : null;
      if (fix && fix.thought) return fix.thought;
    }
    return null;
  }

  const api = {
    sets,
    verdict,
    formatSet,
    thoughtFor,
    checkP6Trust,
    SESSION_GAP_MS,
    SET_GAP_MS,
    MAX_NORMAL_SWINGS,
    MIN_SWINGS
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingDrillSets = api;
})(typeof window !== "undefined" ? window : globalThis);
