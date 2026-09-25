// How far each body number can be trusted: one rule set for the review page, Compare, Trends,
// Progress and practice mode (the server runs this file too, as it runs summary.js), so they agree.
//
// Each number on each swing gets one of three levels:
//   "ok"
//   "shaky": shown greyed with "~": the key position it's read at was estimated; the key positions
//     hang on an impact that can't be believed (the ball wasn't found, or went too far from the
//     heard strike); the camera's light check says "dark", or flicker at a fixed shutter; the noise
//     floor says it moves more while standing still at address than half its usual swing-to-swing
//     spread in a session; or it's noisy by definition (head rise, the plane numbers).
//   "none" (no reading): shown as "--": the camera check says part of the golfer was out of the
//     picture ("out") or the hands left it at the top ("hands"), or there is no number.
// Every level comes with its reasons, most serious first, for the tooltip.
//
// A number is named by where it's read: {view: "face" | "dtl", value: its key in metrics.js's
// per-frame values (or "tempo" / "backswing" / "downswing"), pos: "p1".."p8" | undefined}.
//
// Works in the browser (window.SwingTrust) and in Node / the server's V8 (module.exports, globalThis).
(function (root) {
  const Summary = root.SwingSummary || (typeof require !== "undefined" && require("./summary.js"));

  // Camera check codes (summary.js cameraCheck) that leave that camera's numbers with no reading.
  const BAD_CAMERA = ["out", "hands"];
  // summary.js cameras(): impact can't be believed, so the key positions timed from it may be off.
  const IMPACT_CODES = ["noball", "impact"];
  // Key positions placed from impact (phases.js), and the timings that end at it.
  const FROM_IMPACT = ["p5", "p6", "p7", "p8"];
  const TIMING = ["tempo", "backswing", "downswing"];
  const IMPACT_TIMED = ["tempo", "downswing"];
  // Noise floor: shaky when the typical spread while standing still at address is more than this
  // share of the typical swing-to-swing spread in a session.
  const NOISE_SHARE = 0.5;
  // Noisy by definition, by per-frame value key: [view, why].
  const NOISY = {
    headRise: ["face", "head rise: small up-and-down moves are near the tracking noise"],
    handsPlane: ["dtl", "plane number: needs the shaft seen at address"],
    shaftPlane: ["dtl", "plane number: the shaft is often a blur in the downswing"],
  };

  // The noise table (noiseTable): recent swings, sessions, and how much it takes to judge a number.
  const RECENT = 300;
  const SESSION_GAP_S = 45 * 60;     // as the review page's sessions and practice.py's streaks
  const MIN_GROUP = 5;               // swings in a session (one club) for its spread to count
  const MIN_SPREAD_SWINGS = 10;      // swings over those sessions
  const MIN_NOISE_CLIPS = 8;         // clips with a noise floor

  const finite = v => typeof v === "number" && Number.isFinite(v);
  const LEVELS = { ok: 0, shaky: 1, none: 2 };

  /** A body number of the trends (summary.js BODY key) as {view, value, pos}, or null. */
  function numberOf(key) {
    const f = Summary.BODY.find(b => b.key === key);
    if (!f) return null;
    return { key, view: f.view, value: f.value || f.key, pos: f.pos };
  }

  /**
   * What's known about one swing, from its record on the server (/api/swings, swings.py) and each
   * camera's light check (quality.py records, as `quality` on each clip in /api/clips).
   * @returns {measured, camera: {face, dtl}, estimated: {key: bool}, light: {face, dtl}}
   */
  function factsOf(record, light) {
    const q = (record && record.quality) || {};
    return {
      measured: !!(record && !record.error && record.body),
      camera: q.camera || { face: null, dtl: null },
      estimated: { p6: !!q.p6Estimated },
      light: light || { face: null, dtl: null },
    };
  }

  /** The same for a swing analyzed on the page (summary.js analyze), with its main clip's input. */
  function factsOfAnalysis(a, main, light) {
    const estimated = {};
    for (const p of a.positions) estimated[p.key] = !!p.estimated;
    return { measured: true, camera: Summary.cameras(a, main), estimated, light: light || { face: null, dtl: null } };
  }

  const fmt = (x, unit) => `${x < 10 ? x.toFixed(2) : x.toFixed(1)}${unit === "in" ? " in" : unit === "°" ? "°" : ""}`;

  /** The noise table's row for number n, or null. */
  function noiseRow(n, table) {
    if (!table || !table.keys || !n.pos || TIMING.includes(n.value)) return null;
    return table.keys[`${n.view}.${n.value}.${n.pos}`] || null;
  }

  /**
   * How far number n of a swing can be trusted.
   * @param n {view, value, pos} (numberOf, or a cell of the swing numbers table)
   * @param facts factsOf / factsOfAnalysis
   * @param value the number, or null
   * @param table the noise table (server: noise.json, /api/noise), or null
   * @param unit for the tooltip ("in", "°"), optional
   * @returns {level: "ok" | "shaky" | "none", codes: [code], why: [reason], text: reasons in one line}
   */
  function judge(n, facts, value, table, unit) {
    const reasons = [];   // [level, code, why], in the order they're told
    const add = (level, code, why) => reasons.push([level, code, why]);
    if (!facts || !facts.measured) add("none", "record", "not measured");
    const cam = facts && facts.camera ? facts.camera[n.view] : null;
    const bad = (cam || []).filter(c => BAD_CAMERA.includes(c));
    if (bad.length) add("none", "camera", "camera check: " + bad.join(", "));
    if (facts && n.pos && facts.estimated && facts.estimated[n.pos]) add("shaky", "estimated", `${n.pos.toUpperCase()} estimated`);
    if (!finite(value)) add("none", "missing", "not measured");
    const impact = (cam || []).find(c => IMPACT_CODES.includes(c));
    if (impact && (FROM_IMPACT.includes(n.pos) || IMPACT_TIMED.includes(n.value))) {
      add("shaky", impact, impact === "noball" ? "ball not found: impact is from the hands' motion"
        : "impact doubtful: the ball went too far from the heard strike");
    }
    const light = facts && facts.light ? facts.light[n.view] : null;
    const warn = (light && light.warnings) || [];
    if (warn.includes("dark")) add("shaky", "dark", `dark picture${finite(light.brightness) ? ` (brightness ${Math.round(light.brightness)})` : ""}`);
    if (warn.includes("flicker") && flickerMatters(light)) add("shaky", "flicker", "flickering light at a fixed shutter");
    const row = noiseRow(n, table);
    if (row && row.shaky) {
      add("shaky", "noise", `moves ±${fmt(row.noise, unit)} standing still at address, against ±${fmt(row.spread, unit)} swing to swing`);
    }
    const noisy = NOISY[n.value];
    if (noisy && noisy[0] === n.view) add("shaky", "noisy", noisy[1]);
    const level = reasons.reduce((l, r) => LEVELS[r[0]] > LEVELS[l] ? r[0] : l, "ok");
    // Most serious first: no reading's reasons, then the rest in the order above.
    const told = [...reasons.filter(r => r[0] === "none"), ...reasons.filter(r => r[0] !== "none")];
    // With no reading, only why not: the rest doesn't matter then.
    const why = [...new Set(told.filter(r => level !== "none" || r[0] === "none").map(r => r[2]))];
    return { level, codes: reasons.map(r => r[1]), why, text: why.join("; "),
             reasons: reasons.map(([l, code, text]) => ({ level: l, code, why: text })) };
  }

  /** Whether a clip's flicker warning matters (quality.py flickerLevel: at a fixed shutter; on Auto it's mild). */
  function flickerMatters(light) {
    return !(light && light.flickerLevel === "mild");
  }

  /** judge() for each body number of the trends: {key: judgement}. */
  function forSwing(record, light, table) {
    const facts = factsOf(record, light), body = (record && record.body) || {};
    const out = {};
    for (const f of Summary.BODY) out[f.key] = judge(numberOf(f.key), facts, body[f.key], table, f.unit);
    return out;
  }

  /** The worse of two judgements (for a difference of two numbers): its level, both sets of reasons. */
  function worse(a, b) {
    const level = LEVELS[a.level] >= LEVELS[b.level] ? a.level : b.level;
    const why = [...new Set([...a.why, ...b.why])];
    return { level, codes: [...new Set([...a.codes, ...b.codes])], why, text: why.join("; ") };
  }

  /**
   * Practice mode's rule (practice.py): the number to speak, or null and why not. No reading on
   * "none", and also when the key position it's read at was only estimated (one swing's number is
   * spoken on its own, so a guessed P6 isn't worth saying). The rest is spoken as it is.
   * @returns {value: number | null, why: string | null}
   */
  function speakable(key, record) {
    const n = numberOf(key);
    if (!n) return { value: null, why: "not measured" };
    const value = record && record.body ? record.body[key] : null;
    const j = judge(n, factsOf(record, null), value, null);
    if (j.level !== "none" && !j.codes.includes("estimated")) return { value, why: null };
    // Said in the order practice mode always checked them.
    const first = ["record", "camera", "estimated", "missing"].map(c => j.reasons.find(r => r.code === c)).find(Boolean);
    return { value: null, why: first.why };
  }

  const quantile = (sorted, q) => {
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  };
  const median = xs => xs.length ? quantile([...xs].sort((a, b) => a - b), 0.5) : null;
  const sdOf = xs => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  };

  /**
   * The noise floor per number, from recent swings (the server keeps it in noise.json): for each
   * camera, per-frame number and key position, how much it moves standing still at address (the
   * median over clips of summary.js's address spread) against how much it varies from swing to
   * swing (the median over sessions, one club at a time, of its standard deviation).
   * @param swings [{t: unix s, club, record}] (swings left out of the trends already taken out)
   * @returns {swings, sessions, keys: {"view.value.pos": {noise, spread, ratio, clips, swings, shaky}}}
   */
  function noiseTable(swings) {
    const recent = swings.filter(s => s.record && s.record.body && !s.record.error)
      .sort((a, b) => b.t - a.t).slice(0, RECENT).reverse();
    const seen = (s, view) => !((((s.record.quality || {}).camera || {})[view]) || []).some(c => BAD_CAMERA.includes(c));
    // Sessions (a gap of 45 minutes), one club at a time.
    const groups = new Map();
    let session = 0;
    recent.forEach((s, i) => {
      if (i && s.t - recent[i - 1].t > SESSION_GAP_S) session++;
      const k = `${session}|${s.club || ""}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    });
    const keys = {};
    for (const view of ["face", "dtl"]) {
      const noiseBy = {};
      for (const s of recent) {
        const sd = s.record.noise && s.record.noise[view];
        if (!sd || !seen(s, view)) continue;
        for (const k in sd) if (finite(sd[k])) (noiseBy[k] = noiseBy[k] || []).push(sd[k]);
      }
      for (const value in noiseBy) {
        if (noiseBy[value].length < MIN_NOISE_CLIPS) continue;
        const noise = median(noiseBy[value]);
        for (const pos of Summary.NUMBER_POSITIONS) {
          const spreads = [];
          let n = 0;
          for (const g of groups.values()) {
            const xs = g.filter(s => seen(s, view) && !(pos === "p6" && (s.record.quality || {}).p6Estimated))
              .map(s => { const at = s.record.at && s.record.at[view] && s.record.at[view][pos]; return at ? at[value] : null; })
              .filter(finite);
            if (xs.length < MIN_GROUP) continue;
            spreads.push(sdOf(xs));
            n += xs.length;
          }
          if (n < MIN_SPREAD_SWINGS) continue;
          const spread = median(spreads);
          // A number that's the same on every swing by definition (a turn at address) has nothing to judge.
          if (!(spread > 1e-6)) continue;
          const r = n => Math.round(n * 1000) / 1000;
          keys[`${view}.${value}.${pos}`] = {
            noise: r(noise), spread: r(spread), ratio: r(noise / spread), clips: noiseBy[value].length, swings: n,
            sessions: spreads.length, shaky: noise > NOISE_SHARE * spread,
          };
        }
      }
    }
    return { swings: recent.length, sessions: session + (recent.length ? 1 : 0), share: NOISE_SHARE, keys };
  }

  const api = { BAD_CAMERA, IMPACT_CODES, FROM_IMPACT, NOISE_SHARE, NOISY, numberOf, factsOf, factsOfAnalysis,
                judge, forSwing, worse, speakable, noiseTable, flickerMatters };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingTrust = api;
})(typeof window !== "undefined" ? window : globalThis);
