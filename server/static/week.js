// server/static/week.js
// Week for the coach (Tools > Week for coach).
// One page a week the coach can read in two minutes: what was practiced, what the numbers did,
// whether the focus move is changing, and what the app's own checks say held up.
//
// Works in the browser (window.SwingWeek) and in Node (module.exports).
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./summary.js"),
      require("./coach.js"),
      require("./faults.js"),
      require("./focus.js"),
      require("./helps.js"),
      require("./holdup.js"),
      require("./goodshots.js"),
      require("./games.js"),
      require("./drillsets.js"),
      require("./programhistory.js"),
      require("./sincelast.js")
    );
  } else {
    root.SwingWeek = factory(
      root.SwingSummary,
      root.SwingCoach,
      root.SwingFaults,
      root.SwingFocus,
      root.SwingHelps,
      root.SwingHoldUp,
      root.SwingGoodShots,
      root.SwingGames,
      root.SwingDrillSets,
      root.SwingProgramHistory,
      root.SwingSinceLast
    );
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (
  Summary,
  Coach,
  Faults,
  Focus,
  Helps,
  HoldUp,
  GoodShots,
  Games,
  DrillSets,
  ProgramHistory,
  SinceLast
) {
  "use strict";

  const finite = v => typeof v === "number" && Number.isFinite(v);

  const CLUB_NAMES = { DR: "driver", PW: "PW", GW: "GW", SW: "SW", LW: "LW", PT: "putter" };
  function clubName(code) {
    if (!code) return "";
    const upper = String(code).trim().toUpperCase();
    if (CLUB_NAMES[upper]) return CLUB_NAMES[upper];
    let m = upper.match(/^([WHI])(\d)$/);
    if (m) {
      return `${m[2]}${{ W: " wood", H: " hybrid", I: " iron" }[m[1]]}`;
    }
    m = upper.match(/^(\d)([WHI])$/);
    if (m) {
      return `${m[1]}${{ W: " wood", H: " hybrid", I: " iron" }[m[2]]}`;
    }
    return code;
  }

  function quantile(sorted, q) {
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  function median(xs) {
    const v = xs.filter(finite).sort((a, b) => a - b);
    if (!v.length) return null;
    return quantile(v, 0.5);
  }

  function sd(xs, min = 2) {
    const v = xs.filter(finite);
    if (v.length < min) return null;
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
  }

  function formatDate(d) {
    if (!d) return "";
    let dt;
    if (d instanceof Date) dt = d;
    else if (typeof d === "number") dt = new Date(d < 1e11 ? d * 1000 : d);
    else if (typeof d === "string") {
      if (/^\d{4}-\d{2}-\d{2}/.test(d)) {
        const [y, m, day] = d.slice(0, 10).split("-").map(Number);
        dt = new Date(y, m - 1, day, 12, 0, 0);
      } else {
        dt = new Date(d);
      }
    } else return String(d);
    if (isNaN(dt.getTime())) return String(d);
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  /** Aligns a date/timestamp to Monday 00:00:00 local time of its week. */
  function weekStartOf(d) {
    let dt;
    if (typeof d === "string") {
      if (/^\d{4}-\d{2}-\d{2}/.test(d)) {
        const [y, m, day] = d.slice(0, 10).split("-").map(Number);
        dt = new Date(y, m - 1, day, 0, 0, 0, 0);
      } else {
        dt = new Date(d);
        dt.setHours(0, 0, 0, 0);
      }
    } else if (typeof d === "number") {
      dt = new Date(d < 1e11 ? d * 1000 : d);
      dt.setHours(0, 0, 0, 0);
    } else if (d instanceof Date) {
      dt = new Date(d.getTime());
      dt.setHours(0, 0, 0, 0);
    } else {
      dt = new Date();
      dt.setHours(0, 0, 0, 0);
    }

    const day = dt.getDay(); // 0 is Sunday, 1 is Monday
    const diff = day === 0 ? -6 : 1 - day;
    dt.setDate(dt.getDate() + diff);
    dt.setHours(0, 0, 0, 0);
    return dt;
  }

  function prevWeekStart(ws) {
    const d = weekStartOf(ws);
    d.setDate(d.getDate() - 7);
    return d;
  }

  function nextWeekStart(ws) {
    const d = weekStartOf(ws);
    d.setDate(d.getDate() + 7);
    return d;
  }

  function formatWeekTitle(mon) {
    const sun = new Date(mon.getTime() + 6 * 86400000);
    const sMon = mon.toLocaleDateString("en-US", { month: "short" });
    const sDay = mon.getDate();
    const eMon = sun.toLocaleDateString("en-US", { month: "short" });
    const eDay = sun.getDate();
    const yr = mon.getFullYear();
    if (sMon === eMon) {
      return `Week of ${sMon} ${sDay} – ${eDay}, ${yr}`;
    }
    return `Week of ${sMon} ${sDay} – ${eMon} ${eDay}, ${yr}`;
  }

  function clipTime(c) {
    if (!c) return 0;
    if (typeof c.t === "number") return c.t < 1e11 ? c.t * 1000 : c.t;
    if (c.recorded) {
      const t = Date.parse(c.recorded);
      if (!isNaN(t)) return t;
    }
    return 0;
  }

  function extractShotNums(s) {
    if (!s) return { carry: null, offline: null, strikeV: null };
    const b = s.ball || {};
    const c = s.clubData || {};
    return {
      carry: finite(b.carry) ? b.carry : finite(s.carry) ? s.carry : null,
      offline: finite(b.offline) ? b.offline : finite(b.side) ? b.side : finite(s.offline) ? s.offline : null,
      strikeV: finite(c.faceImpactV) ? c.faceImpactV : finite(s.strikeV) ? s.strikeV : null,
    };
  }

  function extractRows(data) {
    if (Array.isArray(data.rows)) return data.rows;
    const clips = Array.isArray(data.clips) ? data.clips : [];
    const swings = (data.swings && data.swings.swings) ? data.swings.swings : (data.swings || {});
    if (!data.noiseTable && data.swings && data.swings.noise) {
      data.noiseTable = data.swings.noise;
    }
    const rows = [];
    for (const c of clips) {
      if (c.excluded) continue;
      if (c.partner && c.angle !== "face") continue;
      const rec = swings[c.name] || swings[c.partner] || null;
      const t = clipTime(c);
      const shot = c.shot || (rec && rec.shot) || null;
      const sNums = Summary ? Summary.shotNumbers(shot) : extractShotNums(shot);
      const club = shot ? (shot.club || shot.squareClub) : c.club;
      const body = (rec && rec.body) || c.body || null;
      const trust = (rec && rec.trust) || null;
      const row = {
        c,
        name: c.name,
        t,
        club,
        rec,
        body,
        trust,
        drill: c.drill || (rec && rec.drill) || false,
        carry: finite(sNums.carry) ? sNums.carry : null,
        offline: finite(sNums.offline) ? sNums.offline : null,
        strikeV: finite(sNums.strikeV) ? sNums.strikeV : null,
        ...(body || {})
      };
      rows.push(row);
    }
    return rows;
  }

  function extractSessions(data, rows) {
    if (Array.isArray(data.sessions)) return data.sessions;
    if (!rows || !rows.length) {
      if (SinceLast && Array.isArray(data.clips)) {
        const sList = SinceLast.sessionsOf(data.clips);
        if (sList && sList.length) return sList;
      }
      return [];
    }
    const sorted = [...rows].sort((a, b) => a.t - b.t);
    const sessions = [];
    let cur = null;
    const SESSION_GAP_MS = 45 * 60 * 1000;
    for (const r of sorted) {
      if (cur && r.t - cur.end < SESSION_GAP_MS) {
        cur.rows.push(r);
        cur.end = Math.max(cur.end, r.t);
      } else {
        cur = {
          key: r.name || String(r.t),
          start: r.t,
          end: r.t,
          rows: [r]
        };
        sessions.push(cur);
      }
    }
    return sessions;
  }

  function fmtNum(v, dec = 1, signed = false) {
    if (v == null || !finite(v)) return "–";
    const rounded = dec === 0 ? Math.round(v) : v.toFixed(dec);
    if (signed && v > 0) return "+" + rounded;
    return String(rounded);
  }

  /**
   * Main pure function: weekSummary(data, weekStart)
   *
   * @param {object} data
   * @param {string|number|Date} weekStart (Monday)
   * @returns {{title: string, sections: Array<{title: string, lines: Array<string>}>, text: string}}
   */
  // Held-up findings listed, strongest first.
  const HELD_SHOWN = 5;

  function weekSummary(data, weekStart) {
    data = data || {};
    const mon = weekStartOf(weekStart);
    const startMs = mon.getTime();
    const endMs = startMs + 7 * 86400000;
    const lastWeekStartMs = startMs - 7 * 86400000;
    const lastWeekEndMs = startMs;
    // "The 4 weeks before": the four weeks before last week, so the three numbers don't overlap.
    const past4WeeksStartMs = startMs - 35 * 86400000;
    const past4WeeksEndMs = lastWeekStartMs;

    const title = formatWeekTitle(mon);

    const allRows = extractRows(data);
    const allSessions = extractSessions(data, allRows);

    const rowsThisWeek = allRows.filter(r => r.t >= startMs && r.t < endMs);
    const rowsLastWeek = allRows.filter(r => r.t >= lastWeekStartMs && r.t < lastWeekEndMs);
    const rowsPast4Weeks = allRows.filter(r => r.t >= past4WeeksStartMs && r.t < past4WeeksEndMs);
    const rowsBeforeThisWeek = allRows.filter(r => r.t < startMs);

    const sessionsThisWeek = allSessions.filter(s => s.start >= startMs && s.start < endMs);
    const sessionsLastWeek = allSessions.filter(s => s.start >= lastWeekStartMs && s.start < lastWeekEndMs);

    // Logs for programs and games
    const allPrograms = data.programLog || data.programs || [];
    const programRunsThisWeek = allPrograms.filter(p => {
      const t = p.started < 1e11 ? p.started * 1000 : p.started;
      return t >= startMs && t < endMs;
    });

    const allGames = data.gameLog || data.games || [];
    const gamesThisWeek = allGames.filter(g => {
      const t = g.started < 1e11 ? g.started * 1000 : g.started;
      return t >= startMs && t < endMs;
    });

    // Drill sets
    let drillSetsThisWeek = [];
    if (Array.isArray(data.drillSets)) {
      drillSetsThisWeek = data.drillSets.filter(d => {
        const t = d.timestamp || (d.date ? new Date(d.date).getTime() : 0);
        return t >= startMs && t < endMs;
      });
    } else if (DrillSets && Array.isArray(data.clips)) {
      try {
        const sets = DrillSets.sets(data.clips, data.swings || {});
        drillSetsThisWeek = sets.filter(d => d.timestamp >= startMs && d.timestamp < endMs);
      } catch {}
    }

    const sections = [];

    // ==========================================
    // 1. PRACTICE
    // ==========================================
    const practiceLines = [];
    if (sessionsThisWeek.length > 0) {
      const dayNames = [...new Set(sessionsThisWeek.map(s => new Date(s.start).toLocaleDateString("en-US", { weekday: "short" })))];
      const totalMinutes = sessionsThisWeek.reduce((sum, s) => sum + Math.max(1, Math.round((s.end - s.start) / 60000)), 0);
      const sessWord = sessionsThisWeek.length === 1 ? "1 session" : `${sessionsThisWeek.length} sessions`;
      practiceLines.push(`${sessWord} (${dayNames.join(", ")}), ${totalMinutes} minutes`);
    }

    if (rowsThisWeek.length > 0) {
      const byClub = {};
      for (const r of rowsThisWeek) {
        const c = r.club || "other";
        byClub[c] = (byClub[c] || 0) + 1;
      }
      const sortedClubs = Object.entries(byClub).sort((a, b) => b[1] - a[1]);
      const clubStrs = sortedClubs.map(([c, n]) => `${clubName(c)} ${n}`).join(", ");
      practiceLines.push(`Swings: ${rowsThisWeek.length} total (${clubStrs})`);
    }

    for (const p of programRunsThisWeek) {
      const pName = p.name || p.id || "Coach program";
      let resStr = "";
      if (p.results && typeof p.results === "object") {
        const vals = Object.values(p.results);
        const passed = vals.filter(v => v === "passed").length;
        resStr = `${passed} of ${vals.length} gates passed`;
        if (p.how && p.how !== "done") resStr += `, ${p.how}`;
      } else if (p.how) {
        resStr = p.how;
      } else {
        resStr = "done";
      }
      practiceLines.push(`Program: ${pName} (${resStr})`);
    }

    for (const d of drillSetsThisWeek) {
      const dName = d.drill === "pump" ? "Pump drill" : (d.drill ? `${d.drill} drill` : "Drill");
      const cStr = d.club ? ` (${clubName(d.club)})` : "";
      let verdText = "";
      if (d.verdictText) verdText = d.verdictText;
      else if (d.verdict) verdText = typeof d.verdict === "string" ? d.verdict : d.verdict.text;
      else if (DrillSets) {
        const v = DrillSets.verdict(d);
        verdText = v ? v.text : "";
      }
      practiceLines.push(`Drill: ${dName}${cStr}${verdText ? " – " + verdText : ""}`);
    }

    if (practiceLines.length > 0) {
      sections.push({ title: "Practice", lines: practiceLines });
    }

    // ==========================================
    // 2. BALL FLIGHT
    // ==========================================
    // per club hit 15+ times: carry median and spread, offline spread, strike (Square's impact height),
    // vs last week, only where the change is bigger than the club's usual week-to-week noise (say how many swings).
    const ballFlightLines = [];
    const clubsThisWeek = [...new Set(rowsThisWeek.map(r => r.club).filter(Boolean))];

    for (const club of clubsThisWeek) {
      const cRowsThis = rowsThisWeek.filter(r => r.club === club);
      if (cRowsThis.length < 15) continue;

      const count = cRowsThis.length;
      const carries = cRowsThis.map(r => r.carry).filter(finite);
      const offlines = cRowsThis.map(r => r.offline).filter(finite);
      const strikes = cRowsThis.map(r => r.strikeV).filter(finite);

      const medCarry = median(carries);
      const spreadCarry = sd(carries);
      const spreadOffline = sd(offlines);
      const medStrike = median(strikes);

      // Last week's numbers
      const cRowsLast = rowsLastWeek.filter(r => r.club === club);
      const lastCarries = cRowsLast.map(r => r.carry).filter(finite);
      const lastOfflines = cRowsLast.map(r => r.offline).filter(finite);
      const lastStrikes = cRowsLast.map(r => r.strikeV).filter(finite);

      const lastMedCarry = lastCarries.length >= 3 ? median(lastCarries) : null;
      const lastSpreadCarry = lastCarries.length >= 3 ? sd(lastCarries) : null;
      const lastSpreadOffline = lastOfflines.length >= 3 ? sd(lastOfflines) : null;
      const lastMedStrike = lastStrikes.length >= 3 ? median(lastStrikes) : null;

      // Noise: week-to-week standard deviation across past weeks (before this week)
      // Group prior rows into weekly buckets
      const pastWeeks = [];
      if (rowsBeforeThisWeek.length > 0) {
        const sortedBefore = [...rowsBeforeThisWeek].sort((a, b) => a.t - b.t);
        const minT = sortedBefore[0].t;
        let curStart = weekStartOf(minT).getTime();
        while (curStart < startMs) {
          const curEnd = curStart + 7 * 86400000;
          const wRows = sortedBefore.filter(r => r.club === club && r.t >= curStart && r.t < curEnd);
          if (wRows.length >= 5) {
            const wCarries = wRows.map(r => r.carry).filter(finite);
            const wOfflines = wRows.map(r => r.offline).filter(finite);
            const wStrikes = wRows.map(r => r.strikeV).filter(finite);
            pastWeeks.push({
              medCarry: median(wCarries),
              spreadCarry: sd(wCarries),
              spreadOffline: sd(wOfflines),
              medStrike: median(wStrikes)
            });
          }
          curStart = curEnd;
        }
      }

      // If we have custom noise passed in data.noise, use it; else compute from pastWeeks (or fallback)
      const noise = (data.noise && data.noise[club]) || {
        carry: pastWeeks.length >= 2 ? sd(pastWeeks.map(w => w.medCarry)) : 3.0,
        carrySpread: pastWeeks.length >= 2 ? sd(pastWeeks.map(w => w.spreadCarry)) : 2.0,
        offlineSpread: pastWeeks.length >= 2 ? sd(pastWeeks.map(w => w.spreadOffline)) : 2.0,
        strike: pastWeeks.length >= 2 ? sd(pastWeeks.map(w => w.medStrike)) : 2.0
      };

      const diffCarry = (medCarry != null && lastMedCarry != null) ? medCarry - lastMedCarry : null;
      const diffSpreadCarry = (spreadCarry != null && lastSpreadCarry != null) ? spreadCarry - lastSpreadCarry : null;
      const diffSpreadOffline = (spreadOffline != null && lastSpreadOffline != null) ? spreadOffline - lastSpreadOffline : null;
      const diffStrike = (medStrike != null && lastMedStrike != null) ? medStrike - lastMedStrike : null;

      const sigCarry = diffCarry != null && noise.carry != null && Math.abs(diffCarry) >= noise.carry;
      const sigSpreadCarry = diffSpreadCarry != null && noise.carrySpread != null && Math.abs(diffSpreadCarry) >= noise.carrySpread;
      const sigSpreadOffline = diffSpreadOffline != null && noise.offlineSpread != null && Math.abs(diffSpreadOffline) >= noise.offlineSpread;
      const sigStrike = diffStrike != null && noise.strike != null && Math.abs(diffStrike) >= noise.strike;

      // Build text for this club
      const parts = [];
      if (medCarry != null) {
        const carryDetails = [];
        if (sigCarry) {
          carryDetails.push(`${diffCarry > 0 ? "+" : ""}${Math.round(diffCarry)} yd vs last week`);
        }
        if (spreadCarry != null) {
          let spStr = `spread ${Math.round(spreadCarry)} yd`;
          if (sigSpreadCarry) {
            spStr += `, ${diffSpreadCarry > 0 ? "+" : ""}${Math.round(diffSpreadCarry)} yd vs last week`;
          }
          carryDetails.push(spStr);
        }
        let carryStr = `carry ${Math.round(medCarry)} yd`;
        if (carryDetails.length > 0) {
          carryStr += ` (${carryDetails.join(", ")})`;
        }
        parts.push(carryStr);
      }

      if (spreadOffline != null) {
        let offStr = `offline spread ${Math.round(spreadOffline)} yd`;
        if (sigSpreadOffline) {
          offStr += ` (${diffSpreadOffline > 0 ? "+" : ""}${Math.round(diffSpreadOffline)} yd vs last week)`;
        }
        parts.push(offStr);
      }

      if (medStrike != null) {
        let strikeStr = `strike ${medStrike > 0 ? "+" : ""}${Math.round(medStrike)} mm`;
        if (sigStrike) {
          strikeStr += ` (${diffStrike > 0 ? "+" : ""}${Math.round(diffStrike)} mm vs last week)`;
        }
        parts.push(strikeStr);
      }

      ballFlightLines.push(`${clubName(club)} (${count} swings): ${parts.join(", ")}`);
    }

    if (ballFlightLines.length > 0) {
      sections.push({ title: "Ball flight", lines: ballFlightLines });
    }

    // ==========================================
    // 3. THE FOCUS MOVE
    // ==========================================
    // (journal focus): its median this week vs last week vs the 4 weeks before,
    // with the good-shot range if there is one, and the coach.js swing thought for it.
    const journal = data.journal || {};
    const focus = journal.focus || data.focus || null;
    if (focus && focus.move) {
      const moveKey = focus.move;
      const aim = focus.aim || "less";
      const fClub = focus.club || null;
      const fEntry = Faults && Faults.FAULTS && Faults.FAULTS.find(f => f.move === moveKey || f.key === moveKey);
      const fInfo = Summary ? Summary.BODY.find(b => b.key === moveKey) : null;
      const moveLabel = focus.name || (fEntry ? fEntry.name.charAt(0).toUpperCase() + fEntry.name.slice(1) : (fInfo ? fInfo.label : moveKey));
      const unit = fInfo ? fInfo.unit : "";

      const getVals = rList => rList
        .filter(r => (!fClub || r.club === fClub) && finite(r[moveKey]))
        .map(r => r[moveKey]);

      const valsThis = getVals(rowsThisWeek);
      const valsLast = getVals(rowsLastWeek);
      const vals4Weeks = getVals(rowsPast4Weeks);

      if (valsThis.length > 0) {
        const medThis = median(valsThis);
        const medLast = valsLast.length ? median(valsLast) : null;
        const med4W = vals4Weeks.length ? median(vals4Weeks) : null;

        // Good-shot range
        let rangeStr = "";
        let rObj = (data.goodRanges && data.goodRanges[moveKey]) || null;
        if (!rObj && GoodShots && fClub) {
          const built = data.goodShotData || GoodShots.build(allRows, data.goodSettings);
          const cData = built && built.clubs && built.clubs[fClub];
          if (cData && cData.ranges && cData.ranges[moveKey]) {
            rObj = cData.ranges[moveKey];
          }
        }
        if (rObj && rObj.enough && GoodShots) {
          rangeStr = GoodShots.rangeText(rObj.q25, rObj.q75, unit);
        }

        // Coach.js swing thought
        const thought = focus.thought ||
          (Coach && Coach.MOVES && Coach.MOVES[moveKey] && Coach.MOVES[moveKey][aim] && Coach.MOVES[moveKey][aim].thought) ||
          "";

        const fmtVal = v => {
          if (v == null) return "–";
          const dec = unit === ":1" ? 1 : unit === "s" ? 2 : 1;
          const s = Math.abs(v).toFixed(dec);
          const sign = (unit === "°" && v > 0) ? "+" : v < 0 ? "-" : "";
          return `${sign}${s}${unit === "°" ? "°" : unit ? " " + unit : ""}`;
        };

        const focusLines = [];
        let line1 = `${moveLabel}${fClub ? " (" + clubName(fClub) + ")" : ""}, median: this week ${fmtVal(medThis)}`;
        if (medLast != null) line1 += `, last week ${fmtVal(medLast)}`;
        if (med4W != null) line1 += `, the 4 weeks before ${fmtVal(med4W)}`;
        if (rangeStr) line1 += ` (good-shot range ${rangeStr})`;
        line1 += ".";
        focusLines.push(line1);

        if (thought) {
          focusLines.push(`Swing thought: “${thought}”`);
        }

        sections.push({ title: "The focus move", lines: focusLines });
      }
    }

    // ==========================================
    // 4. FAULTS
    // ==========================================
    // the top 3 named faults this week (share of swings) vs last week, coach.js wording.
    if (Faults && rowsThisWeek.length > 0) {
      // For the coach the standing 3D pattern (arms-led downswing) counts too.
      const faultsThis = Faults.sessionFaults(rowsThisWeek, undefined, { standing: true });
      const faultsLast = rowsLastWeek.length > 0 ? Faults.sessionFaults(rowsLastWeek, undefined, { standing: true }) : [];
      const active = faultsThis.filter(f => f.count > 0);
      if (active.length > 0) {
        const top3 = active.slice(0, 3);
        const faultLines = [];
        for (const f of top3) {
          const prev = faultsLast.find(x => x.key === f.key);
          const pctThis = Math.round(f.share * 100);
          const pctPrev = prev && prev.total > 0 ? Math.round(prev.share * 100) : null;
          let vsStr = "";
          if (pctPrev != null) {
            vsStr = ` (vs ${pctPrev}% last week)`;
          }
          const fName = f.name.charAt(0).toUpperCase() + f.name.slice(1);
          let fLine = `${fName}: ${pctThis}% of swings (${f.count}/${f.total})${vsStr}`;
          if (f.thought) {
            fLine += ` · Thought: “${f.thought}”`;
          } else if (f.drill) {
            fLine += ` · Drill: ${f.drill}`;
          }
          faultLines.push(fLine);
        }
        if (faultLines.length > 0) {
          sections.push({ title: "Faults", lines: faultLines });
        }
      }
    }

    // ==========================================
    // 5. WHAT HELD UP
    // ==========================================
    // findings from What helps, what hurts that held up in later sessions (holdup.js),
    // with their sentence; not the ones that didn't.
    let replayed = data.holdUp || data.heldUp || null;
    if (!replayed && HoldUp && rowsThisWeek.length > 0 && allSessions.length >= 4) {
      try {
        const sessionsForReplay = allSessions.filter(s => s.start < endMs);
        if (sessionsForReplay.length >= 4) {
          replayed = HoldUp.replay(sessionsForReplay);
        }
      } catch {}
    }
    if (replayed && Array.isArray(replayed)) {
      // The strongest few (by the later sessions' r): a coach reads two minutes, not a list of 20.
      const strength = x => Math.abs((x.later && x.later.r) || 0);
      const held = replayed.filter(x => x && x.verdict === "held").sort((a, b) => strength(b) - strength(a));
      if (held.length > 0) {
        const heldLines = [];
        for (const x of held.slice(0, HELD_SHOWN)) {
          const sText = HoldUp ? HoldUp.sentence(x) : (x.sentence || "");
          let desc = "";
          if (x.finding) desc = x.finding;
          else if (x.findingSentence) desc = x.findingSentence;
          else if (x.linkSentence) desc = x.linkSentence;
          else {
            const mv = Summary ? Summary.BODY.find(b => b.key === x.move) : null;
            const rs = Helps ? Helps.RESULTS.find(r => r.key === x.result) : null;
            const mName = mv ? mv.label : x.move;
            const rName = rs ? rs.label : x.result;
            desc = `${mName} → ${rName}`;
          }
          heldLines.push(`${desc}: ${sText}`);
        }
        if (held.length > HELD_SHOWN) heldLines.push(`And ${held.length - HELD_SHOWN} more (What helps, what hurts).`);
        if (heldLines.length > 0) {
          sections.push({ title: "What held up", lines: heldLines });
        }
      }
    }

    // ==========================================
    // 6. GAMES
    // ==========================================
    // Combine and other game scores this week vs best so far.
    if (gamesThisWeek.length > 0) {
      const gameLines = [];
      const seenGames = new Set();
      for (const g of gamesThisWeek) {
        const gId = g.id || "game";
        if (seenGames.has(gId)) continue;
        seenGames.add(gId);

        const hist = Games ? Games.gameHistory(allGames, gId) : null;
        const best = hist ? hist.best : null;
        const gName = (Games && Games.GAMES && Games.GAMES[gId] && Games.GAMES[gId].name) || g.name || gId;

        if (gId === "combine") {
          const sg = g.summary ? g.summary.sgPerShot : null;
          const sgStr = sg != null ? `${sg >= 0 ? "+" : ""}${sg.toFixed(2)} strokes/shot` : "completed";
          let bestStr = "";
          if (best && best.sgPerShot != null) {
            bestStr = ` (best so far: ${best.sgPerShot >= 0 ? "+" : ""}${best.sgPerShot.toFixed(2)})`;
          }
          gameLines.push(`Combine: ${sgStr}${bestStr}`);
        } else {
          const shots = g.summary ? g.summary.shots : (g.results ? g.results.length : 0);
          const greens = g.summary ? g.summary.greens : (g.results ? g.results.filter(r => r.onGreen).length : 0);
          const pct = shots > 0 ? Math.round((greens / shots) * 100) : 0;
          let bestStr = "";
          if (best) {
            const bPct = Math.round(best.hitShare * 100);
            bestStr = ` (best so far: ${best.hits}/${best.shots}, ${bPct}%)`;
          }
          gameLines.push(`${gName}: ${greens}/${shots} (${pct}%)${bestStr}`);
        }
      }

      if (gameLines.length > 0) {
        sections.push({ title: "Games", lines: gameLines });
      }
    }

    // ==========================================
    // 7. NOTES
    // ==========================================
    // the owner's session notes and any handicap entry this week.
    const noteLines = [];
    const notesMap = journal.notes || {};
    const seenNotes = new Set();

    for (const s of sessionsThisWeek) {
      const nText = notesMap[s.key];
      if (nText && !seenNotes.has(nText)) {
        seenNotes.add(nText);
        noteLines.push(`${formatDate(s.start)}: ${nText}`);
      }
    }

    for (const [key, nText] of Object.entries(notesMap)) {
      if (/^\d{4}-\d{2}-\d{2}/.test(key) && !seenNotes.has(nText)) {
        const t = new Date(key + "T12:00:00").getTime();
        if (t >= startMs && t < endMs) {
          seenNotes.add(nText);
          noteLines.push(`${formatDate(key)}: ${nText}`);
        }
      }
    }

    const hcps = Array.isArray(journal.handicap) ? journal.handicap : [];
    for (const e of hcps) {
      if (!e || !e.date || e.index == null) continue;
      const t = new Date(e.date + "T12:00:00").getTime();
      if (t >= startMs && t < endMs) {
        noteLines.push(`Handicap index: ${Number(e.index).toFixed(1)} on ${formatDate(e.date)}`);
      }
    }

    if (noteLines.length > 0) {
      sections.push({ title: "Notes", lines: noteLines });
    }

    // ==========================================
    // PLAIN TEXT FORMATTING
    // ==========================================
    let text = title;
    if (!sections.length) {
      text += "\n\nNo practice this week.";
    } else {
      for (const s of sections) {
        text += "\n\n" + s.title + "\n" + s.lines.join("\n");
      }
    }

    return {
      title,
      sections,
      text
    };
  }

  /**
   * Joins the week summary text with full coach program run reports.
   * Separated by a blank line and a line `--- <run name>, <date> ---`.
   * @param {string} weekText
   * @param {Array<{name?: string, id?: string, date?: string|number|Date, started?: number, day?: string, text?: string, report?: string}>} runs
   * @returns {string}
   */
  function joinWeekAndRuns(weekText, runs) {
    if (!runs || !runs.length) return weekText || "";
    let out = (weekText || "").trim();
    for (const r of runs) {
      if (!r) continue;
      const report = (r.text || r.report || "").trim();
      if (!report) continue;
      const name = r.name || r.id || "Coach program run";
      let dateStr = "";
      if (r.date != null) {
        if (typeof r.date === "string" && !/^\d{4}-\d{2}-\d{2}/.test(r.date)) {
          dateStr = r.date;
        } else {
          dateStr = formatDate(r.date);
        }
      } else if (r.started) {
        dateStr = formatDate(r.started);
      } else if (r.day) {
        dateStr = formatDate(r.day);
      }
      const header = dateStr ? `--- ${name}, ${dateStr} ---` : `--- ${name} ---`;
      out += (out ? "\n\n" : "") + `${header}\n${report}`;
    }
    return out;
  }

  const api = {
    weekSummary,
    weekStartOf,
    prevWeekStart,
    nextWeekStart,
    formatWeekTitle,
    clubName,
    formatDate,
    extractRows,
    extractSessions,
    joinWeekAndRuns,
  };

  return api;
});
