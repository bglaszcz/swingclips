// Good vs bad today: on your good shots today vs your misses with one club, what was different?
// Separates today's swings into good shots and the rest (SwingGoodShots.judgeShot against the club's
// usual baseline, as Progress does), finds which body numbers (summary.js BODY) most separate them
// (Hedges' g with a 95% confidence interval over today's swings), and picks today's best good shot
// and worst miss to compare side by side.
//
// Works in the browser (window.SwingSessionDiff) and in Node (module.exports).
(function (root) {
  const Summary = root.SwingSummary || (typeof require !== "undefined" && require("./summary.js"));
  const GoodShots = root.SwingGoodShots || (typeof require !== "undefined" && require("./goodshots.js"));
  const Coach = root.SwingCoach || (typeof require !== "undefined" && require("./coach.js"));
  const Trust = root.SwingTrust || (typeof require !== "undefined" && require("./trust.js"));

  // Minimum swings on each side (good vs rest) needed to compare: at least 3 swings per side
  // (matches spreadOf in trends.js and MIN_SWINGS in drillsets.js; allows small sessions while avoiding 1- or 2-swing flukes).
  const MIN_PER_SIDE = 3;

  const CLUB_NAMES = { DR: "driver", PW: "PW", GW: "GW", SW: "SW", LW: "LW", PT: "putter" };
  function clubName(code) {
    if (!code) return "";
    if (CLUB_NAMES[code]) return CLUB_NAMES[code];
    const m = code.match(/^([WHI])(\d)$/);
    return m ? `${m[2]}${{ W: " wood", H: " hybrid", I: " iron" }[m[1]]}` : code;
  }

  function formatClubPlural(code) {
    if (!code) return "shots";
    const name = clubName(code).toLowerCase();
    if (name.endsWith("s")) return name;
    return name + "s";
  }

  const FRIENDLY_NAMES = {
    handsPlaneP6: "hands to the trail pocket at P6",
  };

  const finite = v => typeof v === "number" && Number.isFinite(v);

  function readingOf(r, key) {
    if (r.trust && r.trust[key] && r.trust[key].level === "none") return null;
    if (r.shown && r.shown[key] != null && finite(r.shown[key])) return r.shown[key];
    if (r.rec && r.rec.body && finite(r.rec.body[key])) return r.rec.body[key];
    if (r.body && r.body[key] != null && finite(r.body[key])) return r.body[key];
    if (finite(r[key])) return r[key];
    return null;
  }

  function isShakyReading(r, key) {
    return !!(r.trust && r.trust[key] && r.trust[key].level === "shaky");
  }

  /**
   * Evaluates today's good shots vs misses for one club in one session.
   * @param rows session Trends rows (trends.js swingRow: club, shot, body, shown, trust, rec)
   * @param options { settings, baseline, group, club, minPerSide }
   * @returns { club, clubName, clubPlural, nGood, nRest, total, leftOutCount, leftOut, good, rest,
   *            enough, separating, allDiffs, best, worst, lines }
   */
  function diff(rows, options = {}) {
    const list = rows || [];
    const club = options.club || list.find(r => r.club || r.c?.shot?.club)?.club || (list[0] ? list[0].club : null);
    const clubRows = club ? list.filter(r => (r.club || r.c?.shot?.club) === club) : [...list];
    const group = options.group || (club ? GoodShots.groupOf(club) : "irons") || "irons";
    const st = GoodShots.withDefaults(options.settings || options);
    const rules = (group && st[group]) ? st[group] : st.irons;
    const base = options.baseline || options.base || (options.shots ? GoodShots.baselineOf(options.shots) : null);
    const minPerSide = options.minPerSide ?? MIN_PER_SIDE;

    const leftOut = [];
    const good = [];
    const rest = [];

    for (const r of clubRows) {
      const isExcluded = !!(r.excluded || (r.c && (r.c.excluded || r.c.drill)));
      const s = Summary ? Summary.shotNumbers(r.c?.shot || r) : null;
      const hasValidShot = s && finite(s.carry) && finite(s.offline) && s.carry > 0;
      const hasBodyNumbers = !!(
        (r.rec && r.rec.body && !r.rec.error) ||
        (r.shown && Object.values(r.shown).some(finite)) ||
        (r.body && Object.values(r.body).some(finite))
      );

      if (isExcluded || !hasValidShot || !hasBodyNumbers) {
        leftOut.push(r);
        continue;
      }

      const judge = GoodShots.judgeShot(s, base, group, st);
      const rowItem = { ...r, shotNumbers: s, judge };
      if (judge.good) good.push(rowItem);
      else rest.push(rowItem);
    }

    const nGood = good.length;
    const nRest = rest.length;
    const total = nGood + nRest;
    const leftOutCount = leftOut.length;
    const enough = nGood >= minPerSide && nRest >= minPerSide;

    const allDiffs = [];
    const separating = [];

    const bodyFields = (Summary && Summary.BODY) ? Summary.BODY : [];
    for (const f of bodyFields) {
      const gVals = good.map(r => readingOf(r, f.key)).filter(v => v != null);
      const rVals = rest.map(r => readingOf(r, f.key)).filter(v => v != null);
      const fEnough = gVals.length >= minPerSide && rVals.length >= minPerSide;

      const usedRows = [...good, ...rest].filter(r => readingOf(r, f.key) != null);
      const shakyCount = usedRows.filter(r => isShakyReading(r, f.key)).length;
      const isShaky = usedRows.length > 0 && shakyCount * 2 > usedRows.length;

      let h = null;
      if (fEnough) {
        h = GoodShots.hedges(gVals, rVals);
        if (h && h.g == null) h = null;
      }

      const meanGood = gVals.length ? gVals.reduce((a, b) => a + b, 0) / gVals.length : null;
      const meanRest = rVals.length ? rVals.reduce((a, b) => a + b, 0) / rVals.length : null;
      const diffVal = h ? h.diff : (meanGood != null && meanRest != null ? meanGood - meanRest : null);
      const dir = diffVal != null && diffVal < 0 ? "less" : "more";
      const fieldName = FRIENDLY_NAMES[f.key] || f.label.toLowerCase();
      const coachMove = (Coach && Coach.MOVES && Coach.MOVES[f.key]) ? Coach.MOVES[f.key][dir] : null;
      const amtStr = diffVal != null ? GoodShots.amount(Math.abs(diffVal), f.unit) : null;

      const item = {
        key: f.key,
        field: f,
        fieldName,
        nGood: gVals.length,
        nRest: rVals.length,
        enough: fEnough,
        meanGood,
        meanRest,
        diff: diffVal,
        amount: amtStr,
        dir,
        g: h ? h.g : null,
        se: h ? h.se : null,
        lo: h ? h.lo : null,
        hi: h ? h.hi : null,
        clear: !!(h && h.clear),
        shaky: isShaky,
        coach: coachMove ? { name: coachMove.name, drill: coachMove.drill, thought: coachMove.thought, how: coachMove.how } : null,
      };

      allDiffs.push(item);
      if (item.enough && item.clear) {
        separating.push(item);
      }
    }

    separating.sort((a, b) => Math.abs(b.g) - Math.abs(a.g));

    // Best good swing: smallest offline share of carry (|offline| / carry)
    let best = null, minShare = Infinity;
    for (const g of good) {
      const s = g.shotNumbers;
      if (s && finite(s.carry) && finite(s.offline) && s.carry > 0) {
        const share = Math.abs(s.offline) / s.carry;
        if (share < minShare) {
          minShare = share;
          best = g;
        }
      }
    }

    // Worst rest swing: furthest outside the good-shot box
    // (larger of offline share over offline limit and carry shortfall share over carry-below limit)
    // Mishits with no Square shot are never worst.
    let worst = null, maxOutside = -Infinity;
    const offLimit = rules.offlinePct / 100;
    const carryLimit = rules.carryBelowPct / 100;

    for (const r of rest) {
      const s = r.shotNumbers;
      if (!s || !finite(s.carry) || !finite(s.offline) || !(s.carry > 0)) {
        continue; // mishit with no Square shot: never worst
      }
      const offShare = Math.abs(s.offline) / s.carry;
      const offScore = offLimit > 0 ? offShare / offLimit : 0;

      let carryScore = 0;
      if (base && finite(base.carry) && base.carry > 0 && s.carry < base.carry) {
        const shortfallShare = (base.carry - s.carry) / base.carry;
        carryScore = carryLimit > 0 ? shortfallShare / carryLimit : 0;
      }

      const outsideScore = Math.max(offScore, carryScore);
      if (outsideScore > maxOutside) {
        maxOutside = outsideScore;
        worst = r;
      }
    }

    const cName = clubName(club);
    const cPlural = formatClubPlural(club);

    const result = {
      club,
      clubName: cName,
      clubPlural: cPlural,
      group,
      rules,
      baseline: base,
      settings: st,
      good,
      rest,
      nGood,
      nRest,
      total,
      leftOut,
      leftOutCount,
      enough,
      allDiffs,
      separating,
      best,
      worst,
    };

    result.lines = lines(result);
    return result;
  }

  /**
   * Plain-words summary lines for the session diff.
   * @param result output of diff()
   * @returns [string]
   */
  function lines(result) {
    if (!result) return [];
    const { clubPlural, nGood, nRest, total, leftOutCount, enough, separating } = result;

    if (total === 0) {
      return [`No ${clubPlural} today to compare.`];
    }
    if (nGood === 0) {
      return [`No good ${clubPlural} today (0 of ${total}).`];
    }
    if (nRest === 0) {
      return [`All ${clubPlural} today were good (${nGood} of ${total}).`];
    }
    if (!enough) {
      return [`Too few good ${clubPlural} today to compare (${nGood} of ${total}).`];
    }
    if (!separating || separating.length === 0) {
      return [`Nothing separates today's good and bad ${clubPlural} clearly yet.`];
    }

    const leftNote = leftOutCount > 0 ? `, ${leftOutCount} left out` : "";
    const out = [];
    separating.forEach((s, i) => {
      const phrase = `${s.amount} ${s.dir} ${s.fieldName} than your misses.`;
      if (i === 0) {
        out.push(`Good ${clubPlural} today (${nGood} of ${total}${leftNote}): ${phrase}`);
      } else {
        out.push(`Also: ${phrase}`);
      }
    });

    return out;
  }

  const api = {
    diff,
    lines,
    MIN_PER_SIDE,
    clubName,
    formatClubPlural,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingSessionDiff = api;
})(typeof window !== "undefined" ? window : globalThis);
