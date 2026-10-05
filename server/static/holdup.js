// Did the findings hold up? Forward-in-time validation of "What helps, what hurts" links.
//
// A link found using only sessions up to some day is tested forward on the later sessions alone.
// Works in the browser (window.SwingHoldUp) and in Node (module.exports).
(function (root) {
  const Helps = root.SwingHelps || (typeof require !== "undefined" && require("./helps.js"));

  const finite = v => typeof v === "number" && Number.isFinite(v);

  /**
   * Formats a session key or ISO date string into a short date ("Sep 28").
   * Non-ISO keys (like "s0") are returned unchanged.
   */
  function formatDate(dStr) {
    if (typeof dStr !== "string") return String(dStr || "");
    if (/^\d{4}-\d{2}-\d{2}/.test(dStr)) {
      const parts = dStr.slice(0, 10).split("-").map(Number);
      const dt = new Date(parts[0], parts[1] - 1, parts[2], 12);
      if (!isNaN(dt.getTime())) {
        return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      }
    }
    return dStr;
  }

  /**
   * Builds the session point arrays for SwingHelps.link.
   * @param sessions [{rows: [...]}]
   * @param moveKey string
   * @param resultKey string
   * @returns [[{x, y, shaky}]]
   */
  function buildPoints(sessions, moveKey, resultKey) {
    const resultNumbers = Helps.resultNumbers;
    return (sessions || []).map(s => {
      const rows = (s.rows || []).filter(r => r && r.body && finite(r.body[moveKey]));
      const pts = [];
      for (const r of rows) {
        const res = resultNumbers(r);
        const y = res[resultKey];
        if (finite(y)) {
          pts.push({
            x: r.body[moveKey],
            y,
            shaky: !!(r.shaky && r.shaky[moveKey])
          });
        }
      }
      return pts;
    });
  }

  /**
   * Replays findings forward in time across sessions.
   * @param sessions [{key, rows}] oldest first
   * @param opts {minSessions, moves, results}
   * @returns [{move, result, foundAt, foundLabel, foundSign, later: {sessions, n, r, p, agree, counted}, verdict}]
   */
  function replay(sessions, opts = {}) {
    if (!Array.isArray(sessions) || sessions.length < 2) return [];
    const minSessions = (opts && opts.minSessions != null) ? opts.minSessions : 3;
    if (sessions.length <= minSessions) return [];

    const foundMap = new Map();

    for (let k = minSessions; k < sessions.length; k++) {
      const slice = sessions.slice(0, k);
      const a = Helps.analyze(slice, opts);
      const links = (a && a.links) || [];
      for (const l of links) {
        if (l.label === "confirmed" || l.label === "emerging") {
          const key = `${l.move}:${l.result}`;
          if (!foundMap.has(key)) {
            foundMap.set(key, {
              move: l.move,
              result: l.result,
              foundAt: sessions[k - 1].key,
              foundLabel: l.label,
              foundSign: l.r > 0 ? 1 : l.r < 0 ? -1 : 0,
              foundK: k
            });
          }
        }
      }
    }

    const out = [];
    for (const item of foundMap.values()) {
      const laterSessions = sessions.slice(item.foundK);
      const pts = buildPoints(laterSessions, item.move, item.result);
      const l = Helps.link(pts);
      const laterSwings = l.n || 0;

      let verdict;
      if (laterSwings < Helps.MIN_PAIRS || l.p == null || l.r == null) {
        verdict = laterSwings < Helps.MIN_PAIRS ? "too early" : "faded";
      } else {
        const laterSign = l.r > 0 ? 1 : l.r < 0 ? -1 : 0;
        const pOneSided = l.p / 2;
        if (laterSign === item.foundSign && pOneSided < 0.05) {
          verdict = "held";
        } else if (laterSign === -item.foundSign && pOneSided < 0.05) {
          verdict = "reversed";
        } else {
          verdict = "faded";
        }
      }

      out.push({
        move: item.move,
        result: item.result,
        foundAt: item.foundAt,
        foundLabel: item.foundLabel,
        foundSign: item.foundSign,
        later: {
          sessions: laterSessions.length,
          n: l.n || 0,
          r: l.r,
          p: l.p,
          agree: l.agree || 0,
          counted: l.counted || 0
        },
        verdict
      });
    }

    return out;
  }

  /**
   * Tallies the verdicts of replayed findings.
   * @param replayed array from replay()
   * @returns {found, held, faded, reversed, early}
   */
  function tally(replayed) {
    const counts = { found: 0, held: 0, faded: 0, reversed: 0, early: 0 };
    if (!Array.isArray(replayed)) return counts;
    counts.found = replayed.length;
    for (const item of replayed) {
      if (item.verdict === "held") counts.held++;
      else if (item.verdict === "faded") counts.faded++;
      else if (item.verdict === "reversed") counts.reversed++;
      else if (item.verdict === "too early") counts.early++;
    }
    return counts;
  }

  function fmtR(r) {
    if (r == null || !finite(r)) return "";
    const abs = Math.abs(r);
    if (abs < 0.005) return "0.00";
    return r.toFixed(2);
  }

  /**
   * Formats a replayed finding into a plain-words sentence.
   * e.g. "Found Sep 28; held up in the 6 sessions since (r 0.31, 84 swings)."
   * @param x replayed item
   * @returns string
   */
  function sentence(x) {
    if (!x) return "";
    const date = formatDate(x.foundAt);
    const count = (x.later && x.later.sessions != null) ? x.later.sessions : 0;
    const sessionWord = `${count} session${count === 1 ? "" : "s"}`;

    if (x.verdict === "held") {
      const n = (x.later && x.later.n != null) ? x.later.n : 0;
      const r = fmtR(x.later && x.later.r);
      return `Found ${date}; held up in the ${sessionWord} since (r ${r}, ${n} swing${n === 1 ? "" : "s"}).`;
    }
    if (x.verdict === "reversed") {
      const n = (x.later && x.later.n != null) ? x.later.n : 0;
      const r = fmtR(x.later && x.later.r);
      return `Found ${date}; reversed in the ${sessionWord} since (r ${r}, ${n} swing${n === 1 ? "" : "s"}).`;
    }
    if (x.verdict === "faded") {
      return `Found ${date}; faded in the ${sessionWord} since.`;
    }
    // "too early"
    return `Found ${date}; too early to tell (${sessionWord} since).`;
  }

  const api = {
    replay,
    tally,
    sentence,
    buildPoints,
    formatDate
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingHoldUp = api;
})(typeof window !== "undefined" ? window : globalThis);
