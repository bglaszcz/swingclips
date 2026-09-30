// Today's practice plan for the Start page: builds a short, ordered practice session
// of about 45 minutes / 60-80 balls from the golfer's current data:
//
// 1. Warm-up: a few easy wedge shots (fixed block, short).
// 2. Focus block: the current focus (if any) with its drill and swing thought from coach.js,
//    a ball count, and parameters to turn on practice mode for that move (Practice this).
// 3. Scoring-zone block: from the latest Combines' worst targets (combineBreakdown worst), or,
//    with no Combine yet, from the wedge matrix's biggest hole; a suggested game with start button.
// 4. Finish with a game: Combine if the last one was 7 or more days ago (the weekly score),
//    else the game that matches the weakest area (Driving if fairway rate is low, Distance control
//    if carry spread is wide, else Random pick).
//
// API:
//   buildPlan(inputs, options)
//     inputs: {
//       focus?: { move, aim, club, results, since } | null,
//       journal?: { focus, ... },
//       gameLog?: Array<object>,
//       clips?: Array<object>,
//       rows?: Array<object>,
//       swings?: Object<string, object>,
//       games?: Array<object>
//     }
//     options?: {
//       now?: number | Date,
//       clubNameFn?: Function(code: string) -> string
//     }
//   Returns: {
//     totalMinutes: number,
//     totalBalls: number,
//     blocks: Array<{
//       id: "warmup" | "focus" | "scoring" | "finish",
//       title: string,
//       minutes: number,
//       balls: number,
//       why: string,
//       drill: string | null,
//       thought: string | null,
//       button: { id, label, disabled?, title?, gameId?, params? } | null
//     }>
//   }
//
// Works in the browser (window.SwingPlan) and in Node (module.exports).
(function (root) {
  const Games = root.SwingGames || (typeof require !== "undefined" && require("./games.js"));
  const Coach = root.SwingCoach || (typeof require !== "undefined" && require("./coach.js"));
  const Wedges = root.SwingWedges || (typeof require !== "undefined" && require("./wedges.js"));
  const Gapping = root.SwingGapping || (typeof require !== "undefined" && require("./gapping.js"));
  const DrillSets = root.SwingDrillSets || (typeof require !== "undefined" && require("./drillsets.js"));

  const finite = v => typeof v === "number" && Number.isFinite(v);

  // Suggested range parameters for focus practice mode
  const PR_SUGGEST_N = 30;
  const PR_SUGGEST_MIN = 5;

  /** Decimals to round metrics for practice mode. */
  function metricDecimals(key) {
    if (key === "backswing" || key === "downswing" || key === "smash") return 2;
    if (key === "spineTiltImpact" || key === "bendLoss" || key === "shaftPlaneP6"
        || key === "carry" || key === "offline" || key === "clubSpeed" || key === "ballSpeed") return 0;
    return 1;
  }

  /**
   * Extracts recent readings for a move/metric from clips or rows with that club.
   */
  function extractMetricValues(focus, inputs) {
    if (!focus || !focus.move) return [];
    const rows = Array.isArray(inputs.clips) ? inputs.clips
      : Array.isArray(inputs.rows) ? inputs.rows
      : Array.isArray(inputs.swings) ? inputs.swings
      : [];
    const swings = inputs.swings && typeof inputs.swings === "object" && !Array.isArray(inputs.swings)
      ? inputs.swings : null;

    const list = [];
    for (const r of rows) {
      if (!r || r.excluded || (r.c && r.c.excluded)) continue;
      const shot = r.shot || (r.c && r.c.shot);
      const club = r.club || (shot && shot.club);
      if (focus.club && club && club !== focus.club) continue;

      let val = null;
      // 1. Direct property on row
      if (r[focus.move] != null && finite(r[focus.move])) {
        val = r[focus.move];
      }
      // 2. Swings lookup by clip name or partner
      else if (swings) {
        const name = r.name || (r.c && r.c.name);
        const partner = r.partner || (r.c && r.c.partner);
        const rec = (name && swings[name]) || (partner && swings[partner]);
        if (rec && rec.body && finite(rec.body[focus.move])) {
          val = rec.body[focus.move];
        }
      }
      // 3. Body object on clip/row
      else if (r.body && finite(r.body[focus.move])) {
        val = r.body[focus.move];
      }
      // 4. Shot metric from launch monitor
      else if (shot) {
        const cd = shot.clubData || {};
        const b = shot.ball || {};
        if (focus.move === "path" && finite(cd.path)) val = cd.path;
        else if (focus.move === "face" && finite(cd.faceToTarget)) val = cd.faceToTarget;
        else if (focus.move === "faceToPath" && finite(cd.faceToTarget) && finite(cd.path)) val = cd.faceToTarget - cd.path;
        else if (focus.move === "attack" && finite(cd.angleOfAttack)) val = cd.angleOfAttack;
        else if (focus.move === "carry" && finite(b.carry)) val = b.carry;
        else if (focus.move === "offline" && finite(b.side)) val = b.side;
        else if (focus.move === "smash" && finite(cd.smash)) val = cd.smash;
        else if (focus.move === "clubSpeed" && finite(cd.speed)) val = cd.speed;
        else if (focus.move === "ballSpeed" && finite(b.speed)) val = b.speed;
        else if (focus.move === "launch" && finite(b.vla)) val = b.vla;
      }

      if (val != null) {
        list.push(val);
        if (list.length >= PR_SUGGEST_N) break;
      }
    }
    return list;
  }

  /**
   * Computes the suggested practice range for the focus move.
   * Matches trends.js focusPracticeRange:
   * from the median of the latest swings toward the aim (+/- 2 * spread).
   */
  function computePracticeRange(focus, inputs) {
    if (!focus || !focus.move || !focus.aim) return null;
    const vals = extractMetricValues(focus, inputs);
    if (vals.length < PR_SUGGEST_MIN) return null;

    vals.sort((a, b) => a - b);
    const med = Gapping ? Gapping.quantile(vals, 0.5) : vals[Math.floor(vals.length / 2)];
    const q90 = Gapping ? Gapping.quantile(vals, 0.9) : vals[Math.floor(vals.length * 0.9)];
    const q10 = Gapping ? Gapping.quantile(vals, 0.1) : vals[Math.floor(vals.length * 0.1)];
    const spread = q90 - q10;

    const dec = metricDecimals(focus.move);
    const round = v => Number(v.toFixed(dec));

    let min, max;
    if (focus.aim === "more") {
      min = round(med);
      max = round(med + 2 * spread);
    } else {
      min = round(med - 2 * spread);
      max = round(med);
    }
    if (min > max) { const tmp = min; min = max; max = tmp; }
    return { min, max, n: vals.length };
  }

  /**
   * Builds the 4 practice blocks for today's session.
   */
  function buildPlan(inputs = {}, options = {}) {
    const rawNow = options.now ?? Date.now();
    const nowMs = typeof rawNow === "number"
      ? (rawNow > 1e11 ? rawNow : rawNow * 1000)
      : new Date(rawNow).getTime();

    const nameFn = options.clubNameFn
      || (root && root.clubName)
      || (Gapping && Gapping.defaultClubName)
      || (c => c);

    const focus = inputs.focus !== undefined
      ? inputs.focus
      : (inputs.journal && inputs.journal.focus ? inputs.journal.focus : null);

    const gameLog = Array.isArray(inputs.gameLog)
      ? inputs.gameLog
      : (inputs.game && Array.isArray(inputs.game.log))
      ? inputs.game.log
      : (Array.isArray(inputs.log) ? inputs.log : []);

    const clips = Array.isArray(inputs.clips)
      ? inputs.clips
      : (Array.isArray(inputs.rows) ? inputs.rows : []);

    // -------------------------------------------------------------
    // 1. Warm-up block
    // -------------------------------------------------------------
    const warmupBlock = {
      id: "warmup",
      title: "Warm-up",
      minutes: 5,
      balls: 10,
      why: "A few easy wedge shots to loosen up and find the center of the face before working on technique.",
      drill: "Half and 3/4 swings with your sand or gap wedge, focusing on rhythm and clean contact.",
      thought: "Smooth tempo, crisp contact.",
      button: null
    };

    // -------------------------------------------------------------
    // 2. Focus block
    // -------------------------------------------------------------
    let focusBlock;
    if (!focus || !focus.move) {
      focusBlock = {
        id: "focus",
        title: "Focus block",
        minutes: 0,
        balls: 0,
        why: "No focus set yet: choose a move to work on from the Progress page (step 2).",
        drill: null,
        thought: null,
        button: null
      };
    } else {
      const mv = Coach && Coach.MOVES ? Coach.MOVES[focus.move] : null;
      const fix = mv && focus.aim ? mv[focus.aim] : null;
      const clubName = focus.club ? nameFn(focus.club) : "";
      const clubLower = clubName ? clubName.toLowerCase() : "";

      const title = fix
        ? `Focus: ${fix.name}`
        : `Focus: ${focus.move} (${focus.aim || "active"})`;

      const resultNames = focus.results && focus.results.length && Coach && Coach.RESULTS
        ? focus.results.map(r => (Coach.RESULTS[r] && Coach.RESULTS[r].name) || r).join(", ")
        : "";

      const why = fix
        ? `Your current focus is to work on ${fix.name}${clubLower ? ` with the ${clubLower}` : ""}${resultNames ? ` to improve ${resultNames}` : ""}.`
        : `Work on ${focus.move} (${focus.aim || "active"})${clubLower ? ` with the ${clubLower}` : ""}${resultNames ? ` to improve ${resultNames}` : ""}.`;

      const range = computePracticeRange(focus, inputs);

      // Latest drill set within the last 14 days
      const dSet = inputs.drillSet || inputs.latestDrillSet || (inputs.drillSets && inputs.drillSets[0]) || null;
      let drillSetLine = null;
      if (dSet) {
        const now = options.now ? new Date(options.now).getTime() : Date.now();
        const setT = dSet.timestamp || (dSet.date ? new Date(dSet.date).getTime() : 0);
        const ageMs = now - setT;
        // Last 14 days (with a 1-day future grace period for clock skew)
        if (setT > 0 && ageMs >= -86400000 && ageMs <= 14 * 86400000) {
          if (typeof dSet.line === "string") {
            drillSetLine = dSet.line;
          } else if (DrillSets && typeof DrillSets.formatSet === "function") {
            const verd = dSet.verdict || DrillSets.verdict(dSet);
            drillSetLine = DrillSets.formatSet(dSet, verd);
          } else {
            const dateStr = dSet.dateFormatted || dSet.date || "";
            const pumpsStr = dSet.pumps && dSet.pumps.handsPlane != null ? `pumps ${dSet.pumps.handsPlane.toFixed(1)} in` : "";
            const afterStr = dSet.after && dSet.after.median != null ? `your swings after ${dSet.after.median.toFixed(1)} in` : "";
            const vText = (dSet.verdict && dSet.verdict.text) || dSet.verdict || "no carry-over yet";
            drillSetLine = `${dSet.drill === "pump" ? "Pump drill" : "Drill"}, ${dateStr}: ${[pumpsStr, afterStr].filter(Boolean).join(", ")}: ${vText}.`;
          }
        }
      }

      focusBlock = {
        id: "focus",
        title,
        minutes: 15,
        balls: 20,
        why,
        drill: fix && fix.drill ? fix.drill : null,
        thought: fix && fix.thought ? fix.thought : null,
        drillSet: drillSetLine,
        // A drill with its own recording mode (app.py /api/drill): the pump drill's pumps come
        // seconds before the strike, so the phones keep more video and the swings stay out of trends.
        drillMode: fix && fix.drill && /^Pump drill/.test(fix.drill) ? "pump" : null,
        button: {
          id: "practice",
          label: "Practice this",
          disabled: !range,
          title: range
            ? `In range = ${focus.aim === "more" ? "more" : "less"} than usual (${range.min} to ${range.max})`
            : "Not enough recent swings with this club to set a range",
          params: {
            metric: focus.move,
            club: focus.club || null,
            min: range ? range.min : null,
            max: range ? range.max : null,
            cue: fix && fix.thought ? fix.thought : "",
            streak: true,
            on: true
          }
        }
      };
    }

    // -------------------------------------------------------------
    // 3. Scoring-zone block
    // -------------------------------------------------------------
    let scoringBlock;
    const cb = Games && Games.combineBreakdown ? Games.combineBreakdown(gameLog) : { worst: [] };

    if (cb && cb.worst && cb.worst.length > 0) {
      const worst = cb.worst[0];
      const sgStr = (worst.sgPerShot >= 0 ? "+" : "") + worst.sgPerShot.toFixed(2);
      if (worst.target <= 100) {
        scoringBlock = {
          id: "scoring",
          title: `Scoring zone: Wedge ladder (${worst.target} yd focus)`,
          minutes: 12,
          balls: 13,
          why: `Combines show you lose ${Math.abs(worst.sgPerShot).toFixed(2)} strokes a shot at ${worst.target} yards (${sgStr} vs tour); dial in wedge distance control.`,
          drill: null,
          thought: null,
          button: {
            id: "game",
            label: "Start Wedge ladder",
            gameId: "wedges"
          }
        };
      } else {
        scoringBlock = {
          id: "scoring",
          title: `Scoring zone: Distance control (${worst.target} yd focus)`,
          minutes: 15,
          balls: 15,
          why: `Combines show you lose ${Math.abs(worst.sgPerShot).toFixed(2)} strokes a shot at ${worst.target} yards (${sgStr} vs tour); dial in carry control.`,
          drill: null,
          thought: null,
          button: {
            id: "game",
            label: "Start Distance control",
            gameId: "distance"
          }
        };
      }
    } else {
      // No Combine breakdown yet: check wedge matrix biggest hole
      const wAnalysis = Wedges && Wedges.analyze ? Wedges.analyze(clips, { clubNameFn: nameFn }) : null;
      if (wAnalysis && wAnalysis.hole) {
        const h = wAnalysis.hole;
        const fromText = `${Math.round(h.from.median)} yd (${h.from.name} ${h.from.label.toLowerCase()})`;
        const toText = `${Math.round(h.to.median)} yd (${h.to.name} ${h.to.label.toLowerCase()})`;
        const gapText = `${Math.round(h.gap)} yd`;
        // The Wedge ladder covers 40-100 yd; a hole beyond that is Distance control's (50-130 yd).
        const ladder = (h.from.median + h.to.median) / 2 <= 100;
        const game = ladder ? { name: "Wedge ladder", id: "wedges" } : { name: "Distance control", id: "distance" };
        scoringBlock = {
          id: "scoring",
          title: `Scoring zone: ${game.name}`,
          minutes: ladder ? 12 : 15,
          balls: ladder ? 13 : 15,
          why: `Your wedge matrix jumps from ${fromText} to ${toText}: ${gapText} with no stock shot.`,
          drill: null,
          thought: null,
          button: {
            id: "game",
            label: `Start ${game.name}`,
            gameId: game.id
          }
        };
      } else {
        // Fallback for new owner / no wedge data
        scoringBlock = {
          id: "scoring",
          title: "Scoring zone: Wedge ladder",
          minutes: 12,
          balls: 13,
          why: "Hit targets from 40 to 100 yards and back down to build your scoring-zone yardages.",
          drill: null,
          thought: null,
          button: {
            id: "game",
            label: "Start Wedge ladder",
            gameId: "wedges"
          }
        };
      }
    }

    // -------------------------------------------------------------
    // 4. Finish with a game
    // -------------------------------------------------------------
    let finishBlock;
    const combines = (gameLog || []).filter(e => e && e.id === "combine" && e.summary);
    combines.sort((a, b) => (a.started || 0) - (b.started || 0));
    const lastCombine = combines.length ? combines[combines.length - 1] : null;
    const lastCombineMs = lastCombine
      ? (lastCombine.started > 1e11 ? lastCombine.started : lastCombine.started * 1000)
      : null;
    const daysSinceCombine = lastCombineMs != null
      ? (nowMs - lastCombineMs) / (86400 * 1000)
      : Infinity;

    if (daysSinceCombine >= 7) {
      const why = !lastCombine
        ? "No Combine on record yet: play your first Combine to benchmark your game across 9 target yardages."
        : `Last Combine was ${Math.floor(daysSinceCombine)} days ago: play a fresh Combine for your weekly benchmark score.`;

      finishBlock = {
        id: "finish",
        title: "Finish: Combine",
        minutes: 20,
        balls: 27,
        why,
        drill: null,
        thought: null,
        button: {
          id: "game",
          label: "Start Combine",
          gameId: "combine"
        }
      };
    } else {
      // Recent Combine (< 7 days): find weakest area
      // 1. Check Driver fairway rate
      const drShots = clips
        .map(c => c.shot || (c.c && c.c.shot))
        .filter(s => s && s.club === "DR" && (!Gapping || !Gapping.isMishit(s)) && finite(s.ball && s.ball.side));

      let drStats = null;
      if (drShots.length >= 5) {
        const hits = drShots.filter(s => Math.abs(s.ball.side) <= 15).length;
        drStats = { total: drShots.length, hits, rate: hits / drShots.length };
      }

      // 2. Check iron carry spread
      const ironCounts = {};
      for (const c of clips) {
        const s = c.shot || (c.c && c.c.shot);
        if (s && s.club && /^I\d$/i.test(s.club) && (!Gapping || !Gapping.isMishit(s))) {
          ironCounts[s.club] = (ironCounts[s.club] || 0) + 1;
        }
      }
      const topIron = Object.keys(ironCounts).sort((a, b) => ironCounts[b] - ironCounts[a])[0];
      let ironSpread = null;
      if (topIron && ironCounts[topIron] >= 5) {
        const carries = clips
          .map(c => c.shot || (c.c && c.c.shot))
          .filter(s => s && s.club === topIron && (!Gapping || !Gapping.isMishit(s)) && finite(s.ball && s.ball.carry))
          .map(s => s.ball.carry)
          .sort((a, b) => a - b);
        if (carries.length >= 5 && Gapping) {
          const q25 = Gapping.quantile(carries, 0.25);
          const q75 = Gapping.quantile(carries, 0.75);
          ironSpread = { club: topIron, n: carries.length, q25, q75, iqr: q75 - q25 };
        }
      }

      const scoringGameId = scoringBlock.button ? scoringBlock.button.gameId : null;

      if (drStats && drStats.rate < 0.60) {
        finishBlock = {
          id: "finish",
          title: "Finish: Driving",
          minutes: 12,
          balls: 14,
          why: `Driver fairway rate is ${Math.round(drStats.rate * 100)}% (${drStats.hits} of ${drStats.total} in fairway): test tee accuracy with 14 drives.`,
          drill: null,
          thought: null,
          button: {
            id: "game",
            label: "Start Driving",
            gameId: "driving"
          }
        };
      } else if (ironSpread && ironSpread.iqr >= 10 && scoringGameId !== "distance") {
        finishBlock = {
          id: "finish",
          title: "Finish: Distance control",
          minutes: 15,
          balls: 15,
          why: `${nameFn(ironSpread.club)} carry spread is ${Math.round(ironSpread.iqr)} yards (${Math.round(ironSpread.q25)} to ${Math.round(ironSpread.q75)} yd): dial in carry consistency.`,
          drill: null,
          thought: null,
          button: {
            id: "game",
            label: "Start Distance control",
            gameId: "distance"
          }
        };
      } else {
        finishBlock = {
          id: "finish",
          title: "Finish: Random pick",
          minutes: 15,
          balls: 20,
          why: "Test your target adaptation with 20 random yardages from 40 to 150 yards.",
          drill: null,
          thought: null,
          button: {
            id: "game",
            label: "Start Random pick",
            gameId: "random"
          }
        };
      }
    }

    const blocks = [warmupBlock, focusBlock, scoringBlock, finishBlock];
    const totalMinutes = blocks.reduce((sum, b) => sum + (b.minutes || 0), 0);
    const totalBalls = blocks.reduce((sum, b) => sum + (b.balls || 0), 0);

    return {
      totalMinutes,
      totalBalls,
      blocks
    };
  }

  const api = {
    buildPlan,
    computePracticeRange,
    extractMetricValues
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingPlan = api;
})(typeof window !== "undefined" ? window : globalThis);
