// Night report helpers: comparing candidate model scores against the current baseline,
// headline generation, and night line formatting.
//
// Works in the browser (window.SwingNightReport) and in Node (module.exports).
(function (root) {
  const POSITION_ORDER = ["takeaway", "p2", "p3", "p4", "p5", "p6", "p7", "impact", "p8"];
  const ANGLE_ORDER = ["face", "dtl"];

  function round1(v) {
    if (v == null) return null;
    const r = Math.round(v * 10) / 10;
    return Object.is(r, -0) ? 0 : r;
  }

  function formatRowLabel(kind, angle, evOrPhase) {
    const angleStr = angle === "face" ? "face-on" : angle === "dtl" ? "DTL" : angle;
    if (kind === "positions" || kind === "position") {
      let name = evOrPhase || "";
      if (name === "takeaway") name = "Takeaway";
      else if (name === "impact" || name === "p7") name = "Impact";
      else if (name === "p1") name = "Address";
      else if (/^p\d$/i.test(name)) name = name.toUpperCase();
      return `${name} (${angleStr})`;
    }
    if (kind === "club") {
      const ph = evOrPhase ? ` ${evOrPhase}` : "";
      return `Club shaft${ph} (${angleStr})`;
    }
    if (kind === "clubhead") {
      const ph = evOrPhase ? ` ${evOrPhase}` : "";
      return `Clubhead${ph} (${angleStr})`;
    }
    return `${evOrPhase} (${angleStr})`;
  }

  /**
   * Formats a date string (YYYY-MM-DD or ISO) into "Oct 7" or "Wed Oct 7".
   */
  function formatNightDate(dateStr, includeWeekday = true) {
    if (!dateStr) return "";
    let d;
    if (typeof dateStr === "string" && /^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
      const parts = dateStr.slice(0, 10).split("-").map(Number);
      d = new Date(parts[0], parts[1] - 1, parts[2], 12);
    } else {
      d = new Date(dateStr);
    }
    if (isNaN(d.getTime())) return String(dateStr);
    const opts = includeWeekday
      ? { weekday: "short", month: "short", day: "numeric" }
      : { month: "short", day: "numeric" };
    return d.toLocaleDateString("en-US", opts).replace(/,/g, "");
  }

  /**
   * Formats an ISO timestamp or date into "H:MM" (e.g. "2:00", "6:58").
   */
  function formatTime(isoStr) {
    if (!isoStr) return "";
    if (typeof isoStr === "string") {
      const m = isoStr.match(/T(\d{1,2}):(\d{2})/);
      if (m) {
        const h = parseInt(m[1], 10);
        const min = m[2];
        return `${h}:${min}`;
      }
    }
    const d = new Date(isoStr);
    if (!isNaN(d.getTime())) {
      return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    return "";
  }

  /**
   * Compares model evaluation scores between current model and candidate.
   * Returns rows for positions (swing order, face then dtl), club, and clubhead.
   * Only includes rows present in both current and candidate.
   *
   * @param scores {current, candidate}
   * @returns array of row objects
   */
  function compareRows(scores) {
    if (!scores || typeof scores !== "object") return [];
    const cur = scores.current;
    const cand = scores.candidate;
    if (!cur || !cand) return [];

    const rows = [];

    // 1. Positions
    const curPos = Array.isArray(cur.positions) ? cur.positions : [];
    const candPos = Array.isArray(cand.positions) ? cand.positions : [];
    const curPosMap = new Map();
    for (const p of curPos) {
      if (p && p.angle && p.event) curPosMap.set(`${p.angle}:${p.event}`, p);
    }
    const candPosMap = new Map();
    for (const p of candPos) {
      if (p && p.angle && p.event) candPosMap.set(`${p.angle}:${p.event}`, p);
    }

    const matchedPosKeys = [];
    for (const key of curPosMap.keys()) {
      if (candPosMap.has(key)) matchedPosKeys.push(key);
    }

    matchedPosKeys.sort((a, b) => {
      const [angleA, evA] = a.split(":");
      const [angleB, evB] = b.split(":");
      const aIdx = ANGLE_ORDER.indexOf(angleA);
      const bIdx = ANGLE_ORDER.indexOf(angleB);
      const angleComp = (aIdx >= 0 ? aIdx : 99) - (bIdx >= 0 ? bIdx : 99);
      if (angleComp !== 0) return angleComp;

      const eIdxA = POSITION_ORDER.indexOf(evA);
      const eIdxB = POSITION_ORDER.indexOf(evB);
      return (eIdxA >= 0 ? eIdxA : 99) - (eIdxB >= 0 ? eIdxB : 99);
    });

    for (const key of matchedPosKeys) {
      const c = curPosMap.get(key);
      const cd = candPosMap.get(key);

      const b_w = c.within1 != null ? c.within1 : null;
      const a_w = cd.within1 != null ? cd.within1 : null;
      const c_w = (b_w != null && a_w != null) ? round1(a_w - b_w) : null;

      const b_p = c.p90 != null ? c.p90 : null;
      const a_p = cd.p90 != null ? cd.p90 : null;
      const c_p = (b_p != null && a_p != null) ? round1(a_p - b_p) : null;

      let better = null;
      if (c_w != null && c_p != null) {
        if (Math.abs(c_w) <= 5 && Math.abs(c_p) <= 4.2) {
          better = null;
        } else if (c_w < -5 || c_p > 4.2) {
          better = false;
        } else if (c_w > 5 || c_p < -4.2) {
          better = true;
        }
      }

      rows.push({
        kind: "positions",
        angle: c.angle,
        event: c.event,
        label: formatRowLabel("positions", c.angle, c.event),
        within1: { before: b_w, after: a_w, change: c_w },
        p90: { before: b_p, after: a_p, change: c_p },
        before: { within1: b_w, p90: b_p },
        after: { within1: a_w, p90: a_p },
        change: { within1: c_w, p90: c_p },
        better
      });
    }

    // Helper for club and clubhead
    function matchClubRows(curList, candList, kind) {
      const curArr = Array.isArray(curList) ? curList : [];
      const candArr = Array.isArray(candList) ? candList : [];
      const curMap = new Map();
      for (const item of curArr) {
        if (!item || !item.angle) continue;
        const ph = item.phase || item.event || "downswing";
        curMap.set(`${item.angle}:${ph}`, item);
      }
      const candMap = new Map();
      for (const item of candArr) {
        if (!item || !item.angle) continue;
        const ph = item.phase || item.event || "downswing";
        candMap.set(`${item.angle}:${ph}`, item);
      }

      const matchedKeys = [];
      for (const key of curMap.keys()) {
        if (candMap.has(key)) matchedKeys.push(key);
      }

      matchedKeys.sort((a, b) => {
        const [angleA, phA] = a.split(":");
        const [angleB, phB] = b.split(":");
        const aIdx = ANGLE_ORDER.indexOf(angleA);
        const bIdx = ANGLE_ORDER.indexOf(angleB);
        const angleComp = (aIdx >= 0 ? aIdx : 99) - (bIdx >= 0 ? bIdx : 99);
        if (angleComp !== 0) return angleComp;
        return phA.localeCompare(phB);
      });

      for (const key of matchedKeys) {
        const c = curMap.get(key);
        const cd = candMap.get(key);
        const ph = c.phase || c.event || "downswing";

        const b_f = c.found != null ? c.found : null;
        const a_f = cd.found != null ? cd.found : null;
        const c_f = (b_f != null && a_f != null) ? round1(a_f - b_f) : null;

        const b_p = c.p90 != null ? c.p90 : null;
        const a_p = cd.p90 != null ? cd.p90 : null;
        const c_p = (b_p != null && a_p != null) ? round1(a_p - b_p) : null;

        let better = null;
        if (c_f != null && c_p != null) {
          if (Math.abs(c_f) <= 5 && Math.abs(c_p) <= 4.2) {
            better = null;
          } else if (c_f < -5 || c_p > 4.2) {
            better = false;
          } else if (c_f > 5 || c_p < -4.2) {
            better = true;
          }
        }

        rows.push({
          kind,
          angle: c.angle,
          event: ph,
          phase: ph,
          label: formatRowLabel(kind, c.angle, ph),
          found: { before: b_f, after: a_f, change: c_f },
          p90: { before: b_p, after: a_p, change: c_p },
          before: { found: b_f, p90: b_p },
          after: { found: a_f, p90: a_p },
          change: { found: c_f, p90: c_p },
          better
        });
      }
    }

    // 2. Club shaft
    matchClubRows(cur.club, cand.club, "club");

    // 3. Clubhead
    matchClubRows(cur.clubhead, cand.clubhead, "clubhead");

    return rows;
  }

  /**
   * One headline sentence for the top of the Night report.
   *
   * @param report {inUse, deepLeft, candidates, nights}
   * @returns string
   */
  function headline(report) {
    if (!report) return "No night report yet: the night worker hasn't run the improve step.";
    if (report.deepLeft != null && report.deepLeft > 0) {
      return `Using the new club model: ${report.deepLeft} clip${report.deepLeft === 1 ? "" : "s"} still to be analyzed again.`;
    }
    const nights = report.nights || [];
    if (nights.length === 0) {
      return "No night report yet: the night worker hasn't run the improve step.";
    }
    const lastNight = nights[0];
    const dateStr = formatNightDate(lastNight.date || lastNight.started, false);
    const startStr = formatTime(lastNight.started);
    const endStr = formatTime(lastNight.ended);
    const timeRange = (startStr && endStr) ? `${startStr}-${endStr}` : (startStr || endStr || "");
    const timePart = timeRange ? ` (${dateStr}, ${timeRange})` : dateStr ? ` (${dateStr})` : "";
    const clipsPart = lastNight.clips != null ? `${lastNight.clips} clip${lastNight.clips === 1 ? "" : "s"}` : "";
    const prefix = `Last night${timePart}: ${clipsPart}`;

    const cand = (report.candidates && report.candidates[0]) || null;
    if (cand && cand.status === "better") {
      return `${prefix}, and a new club model that did better on swings it never saw: ready to use.`;
    }
    if (lastNight.improve && /nothing new/i.test(lastNight.improve)) {
      return `${prefix}, nothing new to learn (no new labels).`;
    }
    if (cand && cand.status === "not better") {
      return `${prefix}, tried a new club model: not better, kept the one in use.`;
    }
    if (cand && cand.status === "in use") {
      return `${prefix}, new club model is in use.`;
    }
    if (lastNight.improve) {
      return `${prefix}, ${lastNight.improve}`;
    }
    return `${prefix}.`;
  }

  /**
   * Formats a night row into "Tue Oct 7 · 2:00-6:58 · 64 clips · <improve>".
   *
   * @param night {date, started, ended, worker, clips, improve}
   * @returns string
   */
  function nightLine(night) {
    if (!night) return "";
    const dStr = formatNightDate(night.date || night.started, true);
    const startStr = formatTime(night.started);
    const endStr = formatTime(night.ended);
    const timeRange = (startStr && endStr) ? `${startStr}-${endStr}` : (startStr || endStr || "");
    const clipsPart = night.clips != null ? `${night.clips} clip${night.clips === 1 ? "" : "s"}` : "";
    const improvePart = night.improve || "";
    const parts = [dStr, timeRange, clipsPart, improvePart].filter(Boolean);
    return parts.join(" · ");
  }

  /**
   * Formats the club model progress line:
   * "New club frames since the last training: 5 of 40" or
   * "Enough for a new club model: the night worker trains it tonight." (at 40 or more).
   */
  function progressLine(progress) {
    if (!progress) return "";
    const newFrames = progress.newFrames != null ? progress.newFrames : 0;
    const need = progress.need != null ? progress.need : 40;
    if (newFrames >= need) {
      return "Enough for a new club model: the night worker trains it tonight.";
    }
    return `New club frames since the last training: ${newFrames} of ${need}`;
  }

  /**
   * When the latest candidate was trained on fewer than 40 more frames than the try
   * before it, returns the note:
   * "Trained on almost the same frames as the try before (+3): add Club check frames first."
   */
  function almostSameNote(candidates) {
    if (!candidates || candidates.length < 2) return null;
    const c0 = candidates[0];
    const c1 = candidates[1];
    const f0 = c0?.train?.frames;
    const f1 = c1?.train?.frames;
    if (f0 == null || f1 == null) return null;
    const diff = f0 - f1;
    if (diff < 40) {
      const sign = diff >= 0 ? "+" : "";
      return `Trained on almost the same frames as the try before (${sign}${diff}): add Club check frames first.`;
    }
    return null;
  }

  /**
   * For a candidate with training runs, extracts rows for each key position present
   * in `current` and all `runs`.
   * Returns array of { angle, event, n, current, runs, average, label }
   * Same row order as compareRows.
   */
  function runRows(scores) {
    if (!scores || typeof scores !== "object") return [];
    const cur = scores.current;
    const runs = scores.runs;
    if (!cur || !Array.isArray(runs) || runs.length === 0) return [];

    const curPos = Array.isArray(cur.positions) ? cur.positions : [];
    const curPosMap = new Map();
    for (const p of curPos) {
      if (p && p.angle && p.event) curPosMap.set(`${p.angle}:${p.event}`, p);
    }

    const runMaps = runs.map(run => {
      const map = new Map();
      const list = run && Array.isArray(run.positions) ? run.positions : [];
      for (const p of list) {
        if (p && p.angle && p.event) map.set(`${p.angle}:${p.event}`, p);
      }
      return map;
    });

    const candPosMap = new Map();
    if (scores.candidate && Array.isArray(scores.candidate.positions)) {
      for (const p of scores.candidate.positions) {
        if (p && p.angle && p.event) candPosMap.set(`${p.angle}:${p.event}`, p);
      }
    }

    // Only positions present in current and in ALL runs
    const matchedKeys = [];
    for (const key of curPosMap.keys()) {
      if (runMaps.every(m => m.has(key))) {
        matchedKeys.push(key);
      }
    }

    matchedKeys.sort((a, b) => {
      const [angleA, evA] = a.split(":");
      const [angleB, evB] = b.split(":");
      const aIdx = ANGLE_ORDER.indexOf(angleA);
      const bIdx = ANGLE_ORDER.indexOf(angleB);
      const angleComp = (aIdx >= 0 ? aIdx : 99) - (bIdx >= 0 ? bIdx : 99);
      if (angleComp !== 0) return angleComp;

      const eIdxA = POSITION_ORDER.indexOf(evA);
      const eIdxB = POSITION_ORDER.indexOf(evB);
      return (eIdxA >= 0 ? eIdxA : 99) - (eIdxB >= 0 ? eIdxB : 99);
    });

    const rows = [];
    for (const key of matchedKeys) {
      const c = curPosMap.get(key);
      const rList = runMaps.map(m => m.get(key));
      const candRow = candPosMap.get(key);

      const n = candRow?.n != null ? candRow.n : (c.n != null ? c.n : 0);

      const curData = {
        within1: c.within1 != null ? c.within1 : null,
        p90: c.p90 != null ? c.p90 : null
      };

      const runsData = rList.map(r => ({
        within1: r && r.within1 != null ? r.within1 : null,
        p90: r && r.p90 != null ? r.p90 : null
      }));

      let avg_w = candRow?.within1 != null ? candRow.within1 : null;
      let avg_p = candRow?.p90 != null ? candRow.p90 : null;

      if (avg_w == null && candRow == null) {
        const wVals = runsData.map(r => r.within1);
        if (wVals.length > 0 && wVals.every(v => v != null)) {
          avg_w = round1(wVals.reduce((a, b) => a + b, 0) / wVals.length);
        }
      }

      if (avg_p == null && candRow == null) {
        const pVals = runsData.map(r => r.p90);
        if (pVals.length > 0 && pVals.every(v => v != null)) {
          avg_p = round1(pVals.reduce((a, b) => a + b, 0) / pVals.length);
        }
      }

      rows.push({
        angle: c.angle,
        event: c.event,
        label: formatRowLabel("positions", c.angle, c.event),
        n,
        current: curData,
        runs: runsData,
        average: { within1: avg_w, p90: avg_p }
      });
    }

    return rows;
  }

  /**
   * Line explaining multiple training runs and which model was kept:
   * "Trained twice (seeds 0 and 1), judged on the average; run 2's model kept."
   * Returns null when train.runs is missing or <= 1.
   */
  function runsLine(candidate) {
    if (!candidate || !candidate.train) return null;
    const runs = candidate.train.runs;
    if (runs == null || runs <= 1) return null;
    const kept = candidate.train.kept != null ? candidate.train.kept : 0;
    const keptRun = kept + 1;
    if (runs === 2) {
      return `Trained twice (seeds 0 and 1), judged on the average; run ${keptRun}'s model kept.`;
    }
    return `Trained ${runs} times, judged on the average; run ${keptRun}'s model kept.`;
  }

  function formatPosName(ev, angle) {
    let evName = ev || "";
    if (evName === "takeaway") evName = "takeaway";
    else if (evName === "impact" || evName === "p7") evName = "impact";
    else if (evName === "p1") evName = "address";
    else if (/^p\d$/i.test(evName)) evName = evName.toUpperCase();
    const angleName = angle === "face" ? "face-on" : angle === "dtl" ? "down the line" : angle;
    return `${evName} ${angleName}`;
  }

  /**
   * Identifies positions where the two training runs' within-one-frame differ by 25 points or more:
   * e.g. ["P2 face-on: 25% and 75%"]
   */
  function runsDisagree(scores) {
    if (!scores || !Array.isArray(scores.runs) || scores.runs.length < 2) return [];
    const r0 = scores.runs[0]?.positions;
    const r1 = scores.runs[1]?.positions;
    if (!Array.isArray(r0) || !Array.isArray(r1)) return [];

    const m0 = new Map();
    for (const p of r0) {
      if (p && p.angle && p.event) m0.set(`${p.angle}:${p.event}`, p);
    }
    const m1 = new Map();
    for (const p of r1) {
      if (p && p.angle && p.event) m1.set(`${p.angle}:${p.event}`, p);
    }

    const matchedKeys = [];
    for (const key of m0.keys()) {
      if (m1.has(key)) matchedKeys.push(key);
    }

    matchedKeys.sort((a, b) => {
      const [angleA, evA] = a.split(":");
      const [angleB, evB] = b.split(":");
      const aIdx = ANGLE_ORDER.indexOf(angleA);
      const bIdx = ANGLE_ORDER.indexOf(angleB);
      const angleComp = (aIdx >= 0 ? aIdx : 99) - (bIdx >= 0 ? bIdx : 99);
      if (angleComp !== 0) return angleComp;

      const eIdxA = POSITION_ORDER.indexOf(evA);
      const eIdxB = POSITION_ORDER.indexOf(evB);
      return (eIdxA >= 0 ? eIdxA : 99) - (eIdxB >= 0 ? eIdxB : 99);
    });

    const out = [];
    for (const key of matchedKeys) {
      const p0 = m0.get(key);
      const p1 = m1.get(key);
      const w0 = p0?.within1;
      const w1 = p1?.within1;
      if (w0 != null && w1 != null) {
        if (Math.abs(w0 - w1) >= 25) {
          const name = formatPosName(p0.event, p0.angle);
          const pct0 = Math.round(w0);
          const pct1 = Math.round(w1);
          out.push(`${name}: ${pct0}% and ${pct1}%`);
        }
      }
    }
    return out;
  }

  const api = {
    compareRows,
    runRows,
    runsLine,
    runsDisagree,
    headline,
    nightLine,
    progressLine,
    almostSameNote,
    formatNightDate,
    formatTime
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingNightReport = api;
})(typeof window !== "undefined" ? window : globalThis);
