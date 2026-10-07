// Habit watch: flags when a bad habit is forming during a session, e.g. drifting into early extension.
// Pure library: SwingHabits (window.SwingHabits in browser, module.exports in Node).
(function (root) {
  const Faults = root.SwingFaults || (typeof require !== "undefined" && require("./faults.js"));
  const ShotStory = root.SwingShotStory || (typeof require !== "undefined" && require("./shotstory.js"));
  const Coach = root.SwingCoach || (typeof require !== "undefined" && require("./coach.js"));
  const Summary = root.SwingSummary || (typeof require !== "undefined" && require("./summary.js"));

  const finite = v => typeof v === "number" && Number.isFinite(v);

  // What the drift looks like in the swing, in golf words (by fault name: head rise has two).
  const DRIFT = {
    "early extension": "your hips have been moving closer to the ball at impact",
    "standing up": "you've been standing up more through impact",
    "over the top": "your hands have been coming down further over the plane in the downswing",
    "head toward the ball": "your head has been moving toward the ball at impact",
    "hip slide": "your hips have been sliding toward the target instead of turning",
    "head dip": "your head has been dropping more through impact",
    "head lift": "your head has been lifting more through impact",
    "casting": "your wrists have been letting go of their hinge earlier in the downswing",
  };

  function coachEntry(move, dir) {
    const c = root.SwingCoach || Coach;
    return (c && c.MOVES && c.MOVES[move] && c.MOVES[move][dir]) || {};
  }

  function unitOf(key) {
    const s = root.SwingSummary || Summary;
    if (s && s.BODY) {
      const b = s.BODY.find(item => item.key === key);
      if (b && b.unit) return b.unit;
    }
    return "";
  }

  function fmtVal(v, unit) {
    const s = v.toFixed(1);
    if (!unit) return s;
    if (unit === "°") return `${s}°`;
    return `${s} ${unit}`;
  }

  /**
   * Watches recent swings for forming bad habits.
   *
   * @param rows array of swing rows for the session up to the open swing, oldest first, same club.
   * @param opts { last?: number (default 5), clubName?: string }
   * @returns array of at most 1 item: [{key, fault, n, slope, from, to, text, detail (the numbers), thought, drill}].
   */
  function watch(rows, opts) {
    const lastN = (opts && typeof opts.last === "number") ? opts.last : 5;
    if (!Array.isArray(rows) || rows.length < lastN) return [];

    const subset = rows.slice(-lastN);
    const flist = (root.SwingFaults || Faults)?.FAULTS || [];
    const candidates = [];

    for (const f of flist) {
      if (f.key === "armsLed") continue;

      // Extract readable swings
      const readable = [];
      for (let i = 0; i < subset.length; i++) {
        const r = subset[i];
        const v = (r.shown && r.shown[f.key] != null) ? r.shown[f.key] : r[f.key];
        const t = r.trust && r.trust[f.key];
        const isOk = finite(v) && (!t || (t.level !== "none" && t.level !== "shaky"));
        if (isOk) {
          readable.push({ index: i, value: v, row: r });
        }
      }

      // Condition 1: at least 4 of the last 5 readable
      if (readable.length < 4) continue;

      // Condition 4: latest one past the threshold
      const latest = readable[readable.length - 1];
      if (latest.index !== subset.length - 1) continue;
      if (!f.test(latest.value, latest.row)) continue;

      // Condition 3: at least 3 of readable past threshold
      const pastThreshold = readable.filter(item => f.test(item.value, item.row));
      if (pastThreshold.length < 3) continue;

      // Condition 2: Theil-Sen slope points toward fault side
      const slopes = [];
      for (let i = 0; i < readable.length; i++) {
        for (let j = i + 1; j < readable.length; j++) {
          const dx = readable[j].index - readable[i].index;
          const dy = readable[j].value - readable[i].value;
          slopes.push(dy / dx);
        }
      }
      slopes.sort((a, b) => a - b);
      const mid = Math.floor(slopes.length / 2);
      const medianSlope = slopes.length % 2 === 1
        ? slopes[mid]
        : (slopes[mid - 1] + slopes[mid]) / 2;

      const faultMore = f.test(f.threshold + 0.01);
      const pointsTowardFault = faultMore ? medianSlope > 0 : medianSlope < 0;
      if (!pointsTowardFault) continue;

      // Severity / ranking distance
      const scale = Math.abs(f.threshold) || 10;
      const dist = Math.abs(latest.value - f.threshold) / scale;

      const ce = coachEntry(f.move, f.dir);
      const ss = root.SwingShotStory || ShotStory;
      const plainFn = ss && typeof ss.plain === "function" ? ss.plain : (t => t);
      const thought = plainFn(ce.thought || "");
      const drill = plainFn(ce.drill || "");

      const rawLabel = (ss && ss.LABELS && ss.LABELS[f.key]) || f.name;
      const plainLabel = plainFn(rawLabel);
      const desc = plainLabel ? (plainLabel[0].toLowerCase() + plainLabel.slice(1)) : f.name;

      const unit = unitOf(f.key);
      const clubPart = (opts && opts.clubName) ? ` with the ${opts.clubName}` : "";
      const fromVal = readable[0].value;
      const toVal = latest.value;
      // The sentence in golf words; the numbers behind it for a tooltip.
      const drift = DRIFT[f.name] || `your ${desc} has been moving toward ${f.name}`;
      const text = plainFn(`Watch out, ${f.name} is creeping in: over your last ${subset.length} swings${clubPart}, ${drift}.`);
      const detail = plainFn(`${plainLabel}: ${fmtVal(fromVal, unit)} to ${fmtVal(toVal, unit)} over the last ${subset.length} swings`);

      candidates.push({
        key: f.key,
        fault: f.name,
        n: subset.length,
        slope: medianSlope,
        from: fromVal,
        to: toVal,
        dist,
        text,
        detail,
        thought,
        drill,
      });
    }

    candidates.sort((a, b) => b.dist - a.dist);
    return candidates.slice(0, 1).map(c => {
      const { dist, ...rest } = c;
      return rest;
    });
  }

  const api = { watch };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingHabits = api;
})(typeof window !== "undefined" ? window : globalThis);
