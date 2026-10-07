// Session story in plain words, for the story card at the top of a session's Trends view:
// how the session went against earlier ones (headline), which clubs shone or struggled, the swing
// to rewatch (best swing with in-range body numbers), and the session's top fault with drill and thought.
// No P-numbers: positions are named as a golfer says them.
//
// Works in the browser (window.SwingSessionStory) and in Node (module.exports).
(function (root) {
  const SessionScore = root.SwingSessionScore || (typeof require !== "undefined" && require("./sessionscore.js"));
  const GoodShots = root.SwingGoodShots || (typeof require !== "undefined" && require("./goodshots.js"));
  const ShotStory = root.SwingShotStory || (typeof require !== "undefined" && require("./shotstory.js"));
  const Faults = root.SwingFaults || (typeof require !== "undefined" && require("./faults.js"));
  const Summary = root.SwingSummary || (typeof require !== "undefined" && require("./summary.js"));

  const finite = v => typeof v === "number" && Number.isFinite(v);

  const CLUB_NAMES = { DR: "driver", PW: "PW", GW: "GW", SW: "SW", LW: "LW", PT: "putter" };

  /** Format a club code or name into plain English for a sentence (e.g. "7 iron", "4 hybrid", "driver"). */
  function plainClub(code) {
    if (!code) return "";
    const trimmed = String(code).trim();
    if (CLUB_NAMES[trimmed.toUpperCase()]) return CLUB_NAMES[trimmed.toUpperCase()];
    let m = trimmed.match(/^([WHI])(\d)$/i);
    if (m) return `${m[2]}${{ W: " wood", H: " hybrid", I: " iron" }[m[1].toUpperCase()]}`;
    m = trimmed.match(/^(\d)([WHI])$/i);
    if (m) return `${m[1]}${{ W: " wood", H: " hybrid", I: " iron" }[m[2].toUpperCase()]}`;
    return trimmed.toLowerCase();
  }

  /**
   * Numeric bag rank for ordering: DR (100), woods (200+), hybrids (300+),
   * irons (400+), wedges (500-530). Putter and empty return -1.
   */
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

  /**
   * One session's story card: headline against earlier sessions, best and worst clubs,
   * the swing to rewatch (good shot with the most in-range body numbers), and top fault.
   *
   * @param session {start, rows} (all clubs, swingRow rows, not left out)
   * @param earlier [{start, rows}] older sessions, oldest first
   * @param ctx {clubs: goodShotData().clubs, name: r => r.c?.name || r.name, settings, ...}
   * @returns {headline, clubs: [{club, n, good, goodRate, note}], best: {name, why} | null,
   *   fault: {name, count, readable, thought, drill} | null}
   */
  function story(session, earlier, ctx) {
    ctx = ctx || {};
    const rows = (session && session.rows) || [];
    const st = GoodShots ? GoodShots.withDefaults(ctx.settings) : {};

    // 1. Headline: compare with earlier sessions using SwingSessionScore
    let headline = "";
    if (SessionScore && SessionScore.compare) {
      const cmp = SessionScore.compare([...(earlier || []), session], ctx);
      headline = (cmp && cmp.headline) || "";
    }

    // 2. Clubs: per club with 3+ judged shots, good-shot rate, bag order, best/worst notes
    const byClub = new Map();
    for (const r of rows) {
      const club = r.club || (r.c && r.c.shot && r.c.shot.club);
      if (!club) continue;
      const group = GoodShots ? GoodShots.groupOf(club) : null;
      if (!group) continue;
      const cData = ctx.clubs && ctx.clubs[club];
      const base = cData && cData.baseline;
      if (!base) continue;
      const rowName = ctx.name ? ctx.name(r) : (r.c ? r.c.name : r.name);
      const v = cData.verdicts && cData.verdicts[rowName];
      const judgedHere = v || (finite(r.carry) && base ? GoodShots.judgeShot(r, base, group, st) : null);
      if (judgedHere && finite(r.carry) && r.carry > 0) {
        let entry = byClub.get(club);
        if (!entry) {
          entry = { club, n: 0, good: 0 };
          byClub.set(club, entry);
        }
        entry.n++;
        if (judgedHere.good) entry.good++;
      }
    }

    const clubs = [...byClub.values()]
      .filter(e => e.n >= 3)
      .map(e => ({
        club: e.club,
        n: e.n,
        good: e.good,
        goodRate: e.n > 0 ? e.good / e.n : 0,
        note: "",
      }))
      .sort((a, b) => bagRank(a.club) - bagRank(b.club));

    if (clubs.length === 1) {
      const only = clubs[0];
      only.note = `your best club today: ${Math.round(only.goodRate * 100)}% good with the ${plainClub(only.club)}`;
    } else if (clubs.length > 1) {
      const sortedByRate = [...clubs].sort((a, b) => b.goodRate - a.goodRate || b.n - a.n);
      const bestClub = sortedByRate[0];
      const worstClub = sortedByRate[sortedByRate.length - 1];

      bestClub.note = `your best club today: ${Math.round(bestClub.goodRate * 100)}% good with the ${plainClub(bestClub.club)}`;
      if (worstClub !== bestClub && worstClub.goodRate < bestClub.goodRate) {
        worstClub.note = `the ${plainClub(worstClub.club)} struggled: ${worstClub.good} good of ${worstClub.n}`;
      }
    }

    // 3. Best swing: good shot (verdict good) with the most body numbers inside that club's good-shot ranges
    let bestSwing = null;
    let maxInCount = -1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const club = r.club || (r.c && r.c.shot && r.c.shot.club);
      if (!club) continue;
      const group = GoodShots ? GoodShots.groupOf(club) : null;
      if (!group) continue;
      const cData = ctx.clubs && ctx.clubs[club];
      const base = cData && cData.baseline;
      if (!base) continue;
      const rowName = ctx.name ? ctx.name(r) : (r.c ? r.c.name : r.name);
      const v = (cData.verdicts && cData.verdicts[rowName]) || (finite(r.carry) && base ? GoodShots.judgeShot(r, base, group, st) : null);
      if (!v || !v.good) continue;

      const ranges = cData.ranges || {};
      let inCount = 0;
      const bodyKeys = Summary && Summary.BODY ? Summary.BODY.map(b => b.key) : Object.keys(ranges);
      for (const key of bodyKeys) {
        if (!r.trust || !r.trust[key] || r.trust[key].level !== "ok") continue;
        const val = r[key] != null ? r[key] : (r.shown && r.shown[key]);
        if (!finite(val)) continue;
        const rng = ranges[key];
        if (!rng || !rng.enough) continue;
        if (GoodShots && GoodShots.place(val, rng).status === "in") inCount++;
      }

      // Ties go to the later swing (rows are oldest first)
      if (inCount >= maxInCount) {
        maxInCount = inCount;
        bestSwing = { row: r, club, judged: v, baseline: base, group, name: rowName };
      }
    }

    let best = null;
    if (bestSwing) {
      let why = "";
      if (ShotStory && ShotStory.card) {
        const r = bestSwing.row;
        const sShot = r.c?.shot ? (Summary ? Summary.shotNumbers(r.c.shot) : r.c.shot) : r;
        const faults = Faults ? Faults.faultsOf(r, ctx.shaky) : [];
        const cRes = ShotStory.card({
          shot: sShot,
          judged: bestSwing.judged,
          baseline: bestSwing.baseline,
          group: bestSwing.group,
          settings: ctx.settings,
          faults,
          body: r.body || r,
          trust: r.trust || {},
          ranges: (ctx.clubs && ctx.clubs[bestSwing.club] && ctx.clubs[bestSwing.club].ranges) || {},
        });
        why = (cRes && cRes.why) || "";
      }
      best = {
        name: bestSwing.name,
        why: ShotStory && ShotStory.plain ? ShotStory.plain(why) : why,
      };
    }

    // 4. Top fault: the session's top fault, thought and drill through SwingShotStory.plain
    let fault = null;
    if (Faults && Faults.sessionFaults) {
      const sFaults = Faults.sessionFaults(rows, ctx.shaky);
      const topF = (sFaults || []).find(f => f.top);
      if (topF) {
        fault = {
          name: topF.name,
          count: topF.count,
          readable: topF.readable,
          thought: ShotStory && ShotStory.plain ? ShotStory.plain(topF.thought) : (topF.thought || ""),
          drill: ShotStory && ShotStory.plain ? ShotStory.plain(topF.drill) : (topF.drill || ""),
        };
      }
    }

    return {
      headline,
      clubs,
      best,
      fault,
    };
  }

  const api = { story, plainClub, bagRank };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingSessionStory = api;
})(typeof window !== "undefined" ? window : globalThis);
