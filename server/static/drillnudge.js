// Drill nudge: notices when the golfer appears to be doing a drill
// (consecutive swings with a rehearsal backswing at session end)
// without drill mode switched on.
//
// Works in the browser (window.SwingDrillNudge) and in Node (module.exports).
(function (root) {
  const Review = root.SwingReview || (typeof require !== "undefined" && require("./review.js"));

  const SESSION_GAP_MS = 45 * 60 * 1000;
  const MIN_RUN = 2;

  const finite = v => typeof v === "number" && Number.isFinite(v);

  function median(xs) {
    const v = xs.filter(finite).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  /**
   * Checks whether the swings at the end of the current session look like a drill.
   *
   * @param {Array<object>} rows golfer's swings oldest first:
   *   { name, t (ms), club, backswing (s), clubSpeed, carry, drill, excluded, reviewed }
   * @param {object} [opts]
   *   - sessionGapMs: max ms between swings in a session (default: 45 min)
   *   - min: min consecutive rehearsal swings to trigger nudge (default: 2)
   * @returns {object|null} { names, backswing, usual, club } or null
   */
  function check(rows, opts) {
    if (!rows || !rows.length || !Review || typeof Review.flags !== "function") return null;

    const sessionGapMs = (opts && opts.sessionGapMs) || SESSION_GAP_MS;
    const min = (opts && opts.min) || MIN_RUN;

    // Filter rows for SwingReview.flags: not excluded and not drill swings
    const validRows = rows.filter(r => !r.excluded && !r.drill);
    const flagged = Review.flags(validRows);

    // Find the current session (back from newest row)
    let sessionStartIdx = 0;
    for (let i = rows.length - 1; i > 0; i--) {
      if (rows[i].t - rows[i - 1].t > sessionGapMs) {
        sessionStartIdx = i;
        break;
      }
    }
    const currentSessionRows = rows.slice(sessionStartIdx);

    // Look at swings at session end, newest first
    const run = [];
    let runClub = null;

    for (let i = currentSessionRows.length - 1; i >= 0; i--) {
      const r = currentSessionRows[i];

      // Skip swings whose numbers are not there yet (backswing null)
      if (r.backswing == null) {
        continue;
      }

      // A swing already reviewed ends the run
      if (r.reviewed) {
        break;
      }

      // Drill or excluded swings are not counted
      if (r.excluded || r.drill) {
        break;
      }

      const rFlags = flagged.get(r.name) || [];
      const isRehearsal = rFlags.some(f => f.code === "rehearsal");

      if (!isRehearsal) {
        // A normal swing after/between clears the run
        break;
      }

      if (!runClub) {
        runClub = r.club;
      } else if (r.club !== runClub) {
        // Different club breaks the run
        break;
      }

      run.push(r);
    }

    if (run.length < min || !runClub) {
      return null;
    }

    // Unflagged rows for this club across validRows
    const unflaggedRows = validRows.filter(r => r.club === runClub && (!flagged.has(r.name) || flagged.get(r.name).length === 0));
    const usualBackswing = median(unflaggedRows.map(r => r.backswing));

    return {
      names: run.map(r => r.name).reverse(),
      backswing: median(run.map(r => r.backswing)),
      usual: usualBackswing,
      club: runClub
    };
  }

  const api = { check, median };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingDrillNudge = api;
})(typeof window !== "undefined" ? window : globalThis);
