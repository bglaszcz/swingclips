// Drill sets: groups drill swings (recorded in drill mode, app.py /api/drill)
// into sets (same drill, same session, <= 20 min between swings; up to SET_BREAK other swings between
// two drill swings don't end a set: a normal swing hit mid-drill) and answers:
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
  const SHORT_LEAD_S = 4;
  // Other swings allowed between two drill swings of one set (they count neither before nor after).
  const SET_BREAK = 2;

  function isShortClip(c) {
    return Boolean(c && typeof c.strike === "number" && c.strike < SHORT_LEAD_S);
  }

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
   * Checks whether a swing's number (any body metric) is trustworthy or shaky/missing.
   * Shaky: P6 estimated (quality.p6Estimated, for numbers taken at P6), doubtful impact, bad camera,
   * dark/flicker. Missing: no reading (null/undefined/NaN), or camera check "out"/"hands".
   * Note: 'noisy' by definition (trust.js NOISY) is NOT treated as a reason to exclude a swing,
   * because such numbers (the plane numbers) are noisy on every swing and judged over sets.
   */
  function checkTrust(rec, clip, noiseTable, metric) {
    if (!rec || !rec.body || rec.error) return { valid: false, reason: "missing" };
    const val = rec.body[metric];
    if (!finite(val)) return { valid: false, reason: "missing" };

    if (/P6$/.test(metric) && rec.quality && rec.quality.p6Estimated) {
      return { valid: false, reason: "estimated" };
    }

    if (Trust && typeof Trust.judge === "function") {
      const facts = Trust.factsOf(rec, clip && clip.quality);
      const j = Trust.judge(Trust.numberOf(metric), facts, val, noiseTable, unitOf(metric));
      if (j.level === "none") return { valid: false, reason: "none", codes: j.codes };
      const shakyCodes = (j.codes || []).filter(c => c !== "noisy" && c !== "ok");
      if (shakyCodes.length > 0) return { valid: false, reason: "shaky", codes: shakyCodes };
    }

    return { valid: true, value: val };
  }

  /** The pump drill's number, the hands to plane at P6 (kept for callers of round 12's name). */
  function checkP6Trust(rec, clip, noiseTable) {
    return checkTrust(rec, clip, noiseTable, "handsPlaneP6");
  }

  /**
   * The number a drill trains and which way: "pump" -> handsPlaneP6 less; "move:<key>:<aim>" -> that
   * move's number when coach.js has the move that way; anything else (a coach program's block) null.
   */
  function trained(drill) {
    if (drill === "pump") return { metric: "handsPlaneP6", aim: "less" };
    if (typeof drill !== "string") return null;
    const m = drill.match(/^move:([A-Za-z0-9_]+):(more|less)$/);
    if (!m) return null;
    const mv = Coach && Coach.MOVES ? Coach.MOVES[m[1]] : null;
    if (!mv || !mv[m[2]]) return null;
    return { metric: m[1], aim: m[2] };
  }

  // Loaded after this file on the pages, so looked up when used.
  function indicators() {
    return root.SwingIndicators || (typeof require !== "undefined" ? require("./indicators.js") : null);
  }
  function shotStory() {
    return root.SwingShotStory || (typeof require !== "undefined" ? require("./shotstory.js") : null);
  }
  function fieldOf(metric) {
    const ind = indicators();
    const known = ind && ind.KNOWN_FIELDS ? ind.KNOWN_FIELDS[metric] : null;
    // The Start page has no indicators.js: summary.js knows each number's unit too.
    return known || (Summary && Array.isArray(Summary.BODY) ? Summary.BODY.find(b => b.key === metric) : null) || null;
  }
  function unitOf(metric) {
    if (metric === "handsPlaneP6") return "in";
    const f = fieldOf(metric);
    return f ? f.unit : undefined;
  }

  /** A metric's value with its own unit and decimals (indicators.js); one decimal, no unit, when unknown. */
  function formatValue(v, metric) {
    if (v == null || !finite(v)) return "–";
    if (metric === "handsPlaneP6") return `${v.toFixed(1)} in`;
    const f = fieldOf(metric);
    const dec = f && Number.isInteger(f.dec) ? f.dec : 1;
    const unit = f ? f.unit : "";
    const s = v.toFixed(dec);
    if (!unit) return s;
    return unit === "°" ? `${s}°` : `${s} ${unit}`;
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
    const isNormal = s => !s.c.excluded && !s.c.drill && !(s.rec && s.rec.drill);

    for (const [sessIdx, sess] of sessions.entries()) {
      // Find drill sets within this session
      // A set is a contiguous sequence of drill swings of the same drill, <= setGap apart
      let i = 0;
      while (i < sess.length) {
        const item = sess[i];
        const drill = item.c.drill || (item.rec && item.rec.drill && item.rec.drill.kind) || null;
        // Only drills that train a number (the pump, a focus's reps): the coach program's blocks report on their own (programs.py).
        const tr = trained(drill);
        if (!tr) {
          i++;
          continue;
        }
        const metric = tr.metric;
        const isPump = drill === "pump";
        const check = s => checkTrust(s.rec, s.c, noise, metric);

        // Start of a drill set
        const drillSwings = [item];
        let j = i + 1, last = i;
        while (j < sess.length) {
          const next = sess[j];
          const nextDrill = next.c.drill || (next.rec && next.rec.drill && next.rec.drill.kind) || null;
          if (nextDrill === drill) {
            if (next.t - sess[last].t > setGap) break; // gap too large
            drillSwings.push(next);
            last = j;
          } else if (nextDrill || j - last > SET_BREAK) {
            break; // another drill, or more than a swing or two that aren't the drill
          }
          j++;
        }

        const setStartIdx = i;
        const setEndIdx = last;
        i = last + 1;

        // Clubs used in drill swings
        const clubsUsed = [...new Set(drillSwings.map(s => s.c.shot && s.c.shot.club).filter(Boolean))];
        const primaryClub = clubsUsed[0] || (sess.find(s => s.c.shot && s.c.shot.club)?.c.shot?.club) || options.defaultClub || null;

        // Collect pumps. Not from a short clip: its video starts mid-drill, so what is read as the address
        // (the shaft line the hands are measured against) is wherever the club was in its first frame.
        // On the owner's 20 of Oct 9, six clips gave pump numbers that way, all with "address" at 0.00 s.
        const allPumpHands = [];
        const allPumpLag = [];
        for (const s of drillSwings) {
          if (isShortClip(s.c)) continue;
          const pumps = s.rec && s.rec.drill && Array.isArray(s.rec.drill.pumps) ? s.rec.drill.pumps : [];
          for (const p of pumps) {
            if (finite(p.handsPlane)) allPumpHands.push(p.handsPlane);
            if (finite(p.lag)) allPumpLag.push(p.lag);
          }
        }

        // Drill swings' own number. "Short" is the pump's alone: its pumps come seconds before the
        // strike, so a 2 s clip misses them; reps are ordinary swings, whole in a 2 s clip.
        const validDrillP6 = [];
        let drillLeftOut = 0;
        let markedCount = 0;
        let shortCount = 0;
        for (const s of drillSwings) {
          const isShort = isPump && isShortClip(s.c);
          if (isShort) shortCount++;
          if (s.c.drillMarked) markedCount++;

          // A short pump clip's own number is against that same wrong line: not used, and not "left out".
          if (isShort) continue;
          const tRes = check(s);
          if (tRes.valid) validDrillP6.push(tRes.value);
          else drillLeftOut++;
        }

        // Normal swings with matching club in this session
        const isMatchingClub = s => {
          if (s.c.excluded) return false;
          if (s.c.drill || (s.rec && s.rec.drill)) return false;
          if (!primaryClub) return true;
          return !s.c.shot || !s.c.shot.club || s.c.shot.club === primaryClub;
        };

        // Before set (closest up to maxNormal)
        const normalBefore = sess.slice(0, setStartIdx).filter(isMatchingClub);
        const candBefore = normalBefore.slice(-maxNormal);
        const validBefore = [];
        let beforeLeftOut = 0;
        for (const s of candBefore) {
          const tRes = check(s);
          if (tRes.valid) validBefore.push(tRes.value);
          else beforeLeftOut++;
        }

        // After set (closest up to maxNormal)
        const normalAfter = sess.slice(setEndIdx + 1).filter(isMatchingClub);
        const candAfter = normalAfter.slice(0, maxNormal);
        const validAfter = [];
        let afterLeftOut = 0;
        for (const s of candAfter) {
          const tRes = check(s);
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
              const tRes = check(s);
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
          metric,
          aim: tr.aim,
          club: primaryClub,
          clubs: clubsUsed.length ? clubsUsed : (primaryClub ? [primaryClub] : []),
          clubName: clubName(primaryClub),
          count: drillSwings.length,
          marked: markedCount,
          short: shortCount,
          firstClip: firstItem.c.name,
          lastClip: lastItem.c.name,
          clips: drillSwings.map(s => s.c.name)
        };
        if (isPump) {
          Object.assign(setObj, {
            pumps: {
              count: allPumpHands.length,
              handsPlane: median(allPumpHands),
              lag: median(allPumpLag)
            },
            pumpsHandsPlane: median(allPumpHands),
            pumpsLag: median(allPumpLag),
            drillP6: median(validDrillP6),
            drillP6Count: validDrillP6.length,
            drillSwings: validDrillP6
          });
        } else {
          setObj.reps = {
            count: validDrillP6.length,
            median: median(validDrillP6),
            swings: validDrillP6
          };
        }
        Object.assign(setObj, {
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
        });

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
    if (set.reps) return verdictReps(set);

    const pumpT = set.pumps ? set.pumps.handsPlane : null;
    if (pumpT == null) {
      if (set && set.short > 0) {
        return verdictDirection(set);
      }
      return makeVerdict("too few swings", "few");
    }

    const nDrill = set.drillP6Count != null ? set.drillP6Count : (set.drillSwings ? set.drillSwings.length : 0);
    const mDrill = set.drillP6;

    const nAfter = set.after ? set.after.count : 0;
    const mAfter = set.after ? set.after.median : null;

    const nBefore = set.before ? set.before.count : 0;
    const mBefore = set.before ? set.before.median : null;

    // Minimum check
    if (nDrill < MIN_SWINGS || nBefore < MIN_SWINGS) {
      return makeVerdict("too few swings", "few", { basis: "pumps" });
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

    return makeVerdict(text, level, { drillCloser, afterMoved, basis: "pumps" });
  }

  function verdictDirection(set) {
    const nBefore = set.before ? set.before.count : 0;
    const mBefore = set.before ? set.before.median : null;
    const nAfter = set.after ? set.after.count : 0;
    const mAfter = set.after ? set.after.median : null;

    if (nBefore < MIN_SWINGS) {
      return makeVerdict("too few swings", "few", { basis: "direction" });
    }
    if (nAfter < MIN_SWINGS) {
      return makeVerdict("too few swings after the drill", "few", { basis: "direction" });
    }

    const groups = [
      (set.before && set.before.swings) || [],
      (set.after && set.after.swings) || []
    ].filter(g => g.length > 0);

    let ss = 0, df = 0;
    for (const g of groups) {
      if (g.length < 2) continue;
      const m = g.reduce((s, x) => s + x, 0) / g.length;
      ss += g.reduce((s, x) => s + (x - m) ** 2, 0);
      df += g.length - 1;
    }
    const within = df > 0 ? Math.sqrt(ss / df) : 1.0;

    const delta = mBefore - mAfter;
    const wobble = Math.max(1.25 * within * Math.sqrt(1 / nBefore + 1 / nAfter), 1e-9);
    const size = delta / wobble;

    let text = "";
    let level = "none";

    if (delta <= 0 || size < 1.5) {
      text = "no change in your swings after the drill";
      level = "none";
    } else if (size >= 2.0) {
      text = "the hands came down clearly lower in your swings after the drill";
      level = "clear";
    } else {
      text = "the hands maybe came down lower in your swings after the drill";
      level = "maybe";
    }

    return makeVerdict(text, level, { basis: "direction", delta, wobble, size, within });
  }

  /** Sizes against the wobble, as everywhere here: under 1.5 none, 1.5 to 2 maybe, 2 and over clear. */
  function sizeLevel(delta, wobble) {
    const size = delta / wobble;
    if (delta <= 0 || size < 1.5) return "none";
    return size >= 2.0 ? "clear" : "maybe";
  }

  /**
   * A focus's reps (a "move:" drill): 1. did the reps themselves move the number the aimed way against
   * before (repsMoved), 2. did the swings after (afterMoved). delta > 0 = the aimed way.
   */
  function verdictReps(set) {
    const sign = set.aim === "less" ? -1 : 1;
    const reps = set.reps || { count: 0, median: null, swings: [] };
    const nReps = reps.count || 0, mReps = reps.median;
    const nBefore = set.before ? set.before.count : 0, mBefore = set.before ? set.before.median : null;
    const nAfter = set.after ? set.after.count : 0, mAfter = set.after ? set.after.median : null;

    const groups = [reps.swings || [], (set.before && set.before.swings) || [], (set.after && set.after.swings) || []];
    let ss = 0, df = 0;
    for (const g of groups) {
      if (g.length < 2) continue;
      const m = g.reduce((s, x) => s + x, 0) / g.length;
      ss += g.reduce((s, x) => s + (x - m) ** 2, 0);
      df += g.length - 1;
    }
    const within = df > 0 ? Math.sqrt(ss / df) : 1.0;

    let repsMoved = "few", repsDelta = null, repsWobble = null;
    if (nBefore >= MIN_SWINGS && nReps >= MIN_SWINGS && mBefore != null && mReps != null) {
      repsDelta = sign * (mReps - mBefore);
      repsWobble = Math.max(1.25 * within * Math.sqrt(1 / nBefore + 1 / nReps), 1e-9);
      repsMoved = sizeLevel(repsDelta, repsWobble);
    }
    let afterMoved = "few", afterDelta = null, afterWobble = null;
    if (nBefore >= MIN_SWINGS && nAfter >= MIN_SWINGS && mBefore != null && mAfter != null) {
      afterDelta = sign * (mAfter - mBefore);
      afterWobble = Math.max(1.25 * within * Math.sqrt(1 / nBefore + 1 / nAfter), 1e-9);
      afterMoved = sizeLevel(afterDelta, afterWobble);
    }

    let text, level;
    if (afterMoved === "clear") {
      text = "clear carry-over into your swings"; level = "clear";
    } else if (afterMoved === "maybe") {
      text = "maybe carrying over"; level = "maybe";
    } else if (afterMoved === "none" && (repsMoved === "clear" || repsMoved === "maybe")) {
      text = "there in the reps, but no carry-over yet"; level = "none";
    } else if (afterMoved === "none" && repsMoved === "none") {
      text = "no change in the reps or after"; level = "none";
    } else if (afterMoved === "few" && repsMoved === "clear") {
      text = "clearly there in the reps, too few swings after"; level = "clear";
    } else if (afterMoved === "few" && repsMoved === "maybe") {
      text = "maybe there in the reps, too few swings after"; level = "maybe";
    } else {
      text = "too few swings"; level = "few";
    }
    return makeVerdict(text, level, {
      basis: "reps", repsMoved, afterMoved, within,
      repsDelta, repsWobble, afterDelta, afterWobble
    });
  }

  function makeVerdict(text, level, details = {}) {
    return {
      text,
      level,
      ...details,
      toString() { return this.text; }
    };
  }

  /** The move a "move:" drill rehearses, its coach.js entry ({name, drill, thought, ...}) or null. */
  function moveSide(set) {
    const tr = set ? (set.metric && set.aim ? { metric: set.metric, aim: set.aim } : trained(set.drill)) : null;
    if (!tr || !Coach || !Coach.MOVES || !Coach.MOVES[tr.metric]) return null;
    return Coach.MOVES[tr.metric][tr.aim] || null;
  }

  /** "Pump drill"; "Reps: <the move in plain words>" for a focus's reps. */
  function nameOf(set) {
    if (!set) return "Drill";
    if (set.drill === "pump") return "Pump drill";
    if (typeof set.drill === "string" && set.drill.startsWith("move:")) {
      const side = moveSide(set);
      if (side && side.name) {
        const ss = shotStory();
        return `Reps: ${ss && ss.plain ? ss.plain(side.name) : side.name}`;
      }
      return "Reps";
    }
    return set.drill ? `${set.drill} drill` : "Drill";
  }

  /**
   * A reps set in one line, e.g. "Reps: the lead hip getting to the target in the downswing, Oct 12
   * (12 reps, 7 iron): reps 2.6 in, your swings after 2.3 in (before 1.9 in): clear carry-over into your swings."
   */
  function formatReps(set, verd) {
    const dateStr = set.dateFormatted || formatDate(set.timestamp || set.date);
    const clubStr = set.clubName || clubName(set.club) || set.club || "";
    let countStr = `${set.count} rep${set.count === 1 ? "" : "s"}${clubStr ? ", " + clubStr : ""}`;
    if (set.marked && set.marked === set.count && set.count > 0) countStr += ", marked afterwards";
    const fmt = v => formatValue(v, set.metric);

    const parts = [];
    if (set.reps && set.reps.count > 0) parts.push(`reps ${fmt(set.reps.median)}`);
    if (set.after && set.after.count > 0) {
      let afterPart = `your swings after ${fmt(set.after.median)}`;
      if (set.before && set.before.count > 0) {
        afterPart += ` (${set.before.earlier ? "your usual" : "before"} ${fmt(set.before.median)})`;
      }
      parts.push(afterPart);
    } else if (set.before && set.before.count > 0) {
      parts.push(`${set.before.earlier ? "your usual" : "your swings before"} ${fmt(set.before.median)}`);
    }

    const vObj = verd != null ? verd : verdict(set);
    const vText = typeof vObj === "string" ? vObj : (vObj && vObj.text) || "";
    let line = `${nameOf(set)}, ${dateStr} (${countStr}): ${parts.join(", ")}${vText ? `: ${vText}.` : "."}`;
    if (set.leftOut > 0) line += ` (${set.leftOut} left out)`;
    return line;
  }

  /**
   * Formats a set into a single concise line.
   * e.g. "Pump drill, Sep 30 (10 swings, 7 iron): pumps -0.9 in, drill swings' hands in the downswing 4.7 in, your swings after 4.3 in (before 4.4 in): no carry-over yet."
   */
  function formatSet(set, verd) {
    if (!set) return "";
    if (set.reps) return formatReps(set, verd);
    const drillName = nameOf(set);
    const dateStr = set.dateFormatted || formatDate(set.timestamp || set.date);
    const clubStr = set.clubName || clubName(set.club) || set.club || "";
    let countStr = `${set.count} swing${set.count === 1 ? "" : "s"}${clubStr ? ", " + clubStr : ""}`;
    if (set.marked && set.marked === set.count && set.count > 0) {
      countStr += ", marked afterwards";
    }

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

    const vObj = verd != null ? verd : verdict(set);
    const vText = typeof vObj === "string" ? vObj : (vObj && vObj.text) || "";
    const vSuffix = vText ? `: ${vText}.` : ".";

    let prefixSentence = "";
    if (set.short > 0) {
      if (set.short === set.count) {
        prefixSentence = "the videos start after the pumps, so no pump numbers.";
      } else {
        prefixSentence = `${set.short} of them start after the pumps.`;
      }
    }

    let body = "";
    if (prefixSentence) {
      if (parts.length > 0) {
        const capParts = [...parts];
        capParts[0] = capParts[0].charAt(0).toUpperCase() + capParts[0].slice(1);
        body = `${prefixSentence} ${capParts.join(", ")}${vSuffix}`;
      } else {
        body = `${prefixSentence.replace(/\.$/, "")}${vSuffix}`;
      }
    } else {
      body = `${parts.join(", ")}${vSuffix}`;
    }

    let line = `${drillName}, ${dateStr} (${countStr}): ${body}`;
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
    if (set && set.reps) {
      const side = moveSide(set);
      if (side && side.thought) return side.thought;
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
    trained,
    nameOf,
    formatValue,
    checkTrust,
    checkP6Trust,
    SESSION_GAP_MS,
    SET_GAP_MS,
    MAX_NORMAL_SWINGS,
    MIN_SWINGS,
    SHORT_LEAD_S,
    SET_BREAK
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingDrillSets = api;
})(typeof window !== "undefined" ? window : globalThis);
