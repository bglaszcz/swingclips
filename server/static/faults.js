// Named swing faults: per swing and per session.
// Reuses drills and swing thoughts from coach.js (SwingCoach).
//
// Works in the browser (window.SwingFaults) and in Node (module.exports).
(function (root) {
  const Coach = root.SwingCoach || (typeof require !== "undefined" && require("./coach.js"));

  // Arms-led downswing (from 3D): pelvis reaches peak speed after impact (bodyLate) and hips are under
  // PELVIS_OPEN_IMPACT_MAX open at impact (the owner's first session was 0-9 deg open vs good players' 30-45 deg).
  const PELVIS_OPEN_IMPACT_MAX = 20;

  // Thresholds: named on roughly the owner's worst quarter of swings or fewer (on his 178 swings to
  // Sep 28: early extension 23%, standing up 24%, over the top 16%, the rest under 10%). Textbook
  // limits would name nearly every swing from these 2D numbers, which says nothing.
  const FAULTS = [
    // Early extension: hips toward the ball at impact (in) > 3 (2.5 named 45% of swings)
    { key: "earlyExt", name: "early extension", move: "earlyExt", dir: "more", threshold: 3, test: v => v > 3 },
    // Standing up: forward bend vs address at impact (deg; negative = lost) < -10 (-8 named 43%)
    { key: "bendLoss", name: "standing up", move: "bendLoss", dir: "less", threshold: -10, test: v => v < -10 },
    // Over the top: hands above the address shaft plane at P6 (in) > 5
    { key: "handsPlaneP6", name: "over the top", move: "handsPlaneP6", dir: "more", threshold: 5, test: v => v > 5 },
    // Head toward the ball: head moves toward the ball at impact (in) > 1
    { key: "headToBall", name: "head toward the ball", move: "headToBall", dir: "more", threshold: 1, test: v => v > 1 },
    // Hip slide: hips shift toward the target at impact (in) > 5.5
    { key: "hipSway", name: "hip slide", move: "hipSway", dir: "less", threshold: 5.5, test: v => v > 5.5 },
    // Head dip: head height drops at impact vs address (in; negative = dropped) < -1.5
    { key: "headRise", name: "head dip", move: "headRise", dir: "less", threshold: -1.5, test: v => v < -1.5 },
    // Casting: the wrist hinge goes with the lead arm still less than 22 deg below horizontal (release
    // point, face-on; 22% of swings, more with the short irons)
    { key: "releaseArm", name: "casting", move: "releaseArm", dir: "more", threshold: -22, test: v => v > -22 },
    // Head lift: head height rises at impact vs address (in) > 1.0
    { key: "headRise", name: "head lift", move: "headRise", dir: "more", threshold: 1.0, test: v => v > 1.0 },
    // Arms-led downswing: from 3D (pelvis reaches peak speed after impact, hips under 20 deg open at impact)
    {
      key: "armsLed",
      name: "arms-led downswing",
      move: "armsLed",
      dir: "more",
      threshold: PELVIS_OPEN_IMPACT_MAX,
      test: (v, row) => {
        if (v == null || v >= PELVIS_OPEN_IMPACT_MAX) return false;
        if (!row) return true;
        const b3 = row.body3d || (row.rec && row.rec.body3d);
        return !b3 || !!(b3.sequence && b3.sequence.bodyLate);
      },
    },
  ];

  // Minimum swings and minimum share of readable swings for a fault to count as "top" in a session.
  const MIN_TOP_SWINGS = 3;
  const MIN_TOP_SHARE = 0.25;

  const finite = v => typeof v === "number" && Number.isFinite(v);

  function coachEntry(move, dir) {
    const c = root.SwingCoach || Coach;
    return (c && c.MOVES && c.MOVES[move] && c.MOVES[move][dir]) || {};
  }

  function valueOf(row, key) {
    if (!row) return null;
    if (key === "armsLed") {
      const b3 = row.body3d || (row.rec && row.rec.body3d);
      if (b3 && b3.numbers && b3.numbers.pelvisOpenImpact != null) {
        return finite(b3.numbers.pelvisOpenImpact) ? b3.numbers.pelvisOpenImpact : null;
      }
      return finite(row[key]) ? row[key] : null;
    }
    const v = row.shown && row.shown[key] != null ? row.shown[key] : row[key];
    return finite(v) ? v : null;
  }

  function isReadable(row, key, shaky) {
    if (!row) return false;
    if (key === "armsLed") {
      const b3 = row.body3d || (row.rec && row.rec.body3d);
      if (b3) {
        return !!(b3.sequence && typeof b3.sequence.bodyLate === "boolean" && valueOf(row, key) != null);
      }
      return finite(row[key]);
    }
    const v = valueOf(row, key);
    if (v == null) return false;
    if (row.trust && row.trust[key] && row.trust[key].level === "none") return false;
    if (typeof shaky === "function") {
      if (shaky(row, key)) return false;
    } else if (row.trust && row.trust[key] && row.trust[key].level === "shaky") {
      return false;
    }
    return true;
  }

  /**
   * The faults on one swing: [{key, name, value, drill, thought}].
   * Never names a fault from a number with no reading or a shaky one.
   *
   * @param row swing row (or object with body numbers)
   * @param shaky optional callback (row, key) => boolean
   */
  function faultsOf(row, shaky) {
    if (!row) return [];
    const out = [];
    for (const f of FAULTS) {
      if (!isReadable(row, f.key, shaky)) continue;
      const v = valueOf(row, f.key);
      if (f.test(v, row)) {
        const ce = coachEntry(f.move, f.dir);
        out.push({
          key: f.key,
          name: f.name,
          value: v,
          drill: ce.drill || "",
          thought: ce.thought || "",
        });
      }
    }
    return out;
  }

  /**
   * Per fault across a session: how many swings have it out of how many had a trustworthy reading,
   * sorted by share descending; only faults on at least 3 swings and 25% of readable ones count as "top".
   *
   * @param rows array of swing rows
   * @param shaky optional callback (row, key) => boolean
   * @returns array of {key, name, count, total, readable, share, top, drill, thought} sorted by share
   */
  function sessionFaults(rows, shaky) {
    const list = rows || [];
    const results = FAULTS.map(f => {
      let count = 0, total = 0;
      for (const r of list) {
        if (!isReadable(r, f.key, shaky)) continue;
        total++;
        const v = valueOf(r, f.key);
        if (f.test(v, r)) count++;
      }
      const share = total > 0 ? count / total : 0;
      const top = count >= MIN_TOP_SWINGS && share >= MIN_TOP_SHARE;
      const ce = coachEntry(f.move, f.dir);
      return {
        key: f.key,
        name: f.name,
        count,
        total,
        readable: total,
        share,
        top,
        drill: ce.drill || "",
        thought: ce.thought || "",
      };
    });
    results.sort((a, b) => b.share - a.share || b.count - a.count);
    return results;
  }

  const api = { FAULTS, faultsOf, sessionFaults, MIN_TOP_SWINGS, MIN_TOP_SHARE, PELVIS_OPEN_IMPACT_MAX };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingFaults = api;
})(typeof window !== "undefined" ? window : globalThis);
