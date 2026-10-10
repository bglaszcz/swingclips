// Swings worth a second look: far enough from your usual with the club that they are probably not
// a normal swing with it (a drill hit without the drill switched on, a part swing, another club than
// Square was set to, a misread). Nothing is thrown out here: the Swings list marks them "check", and
// you leave them out (one or many at once) or say they're fine.
//
// Each swing is taken against the middle value of that club's own swings:
//   rehearsal: the backswing took REHEARSAL times as long, and at least REHEARSAL_S longer (the pump
//     drill and a paused top read like this);
//   part swing: club speed under SLOW of the usual (not wedges: part swings are their job);
//   fast: club speed over FAST of the usual (another club, or Square misread it);
//   long: carry over LONG of the usual (another club than Square was set to).
// A short carry on its own is a mishit, and a mishit is a real swing: not marked.
//
// Works in the browser (window.SwingReview) and in Node (module.exports).
(function (root) {
  // Swings with the number a club needs before anything is judged against its usual.
  const MIN_SWINGS = 10;
  const REHEARSAL = 1.5, REHEARSAL_S = 0.4, SLOW = 0.8, FAST = 1.12, LONG = 1.25;
  const WEDGE = /^(PW|GW|AW|UW|SW|LW)$/;

  const finite = v => typeof v === "number" && Number.isFinite(v);
  const median = xs => {
    const v = xs.filter(finite).sort((a, b) => a - b);
    if (v.length < MIN_SWINGS) return null;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };

  /**
   * @param rows swing rows of every club ({name, club, backswing (s), clubSpeed, carry}); swings already
   *   left out should not be passed (they would shift the usual)
   * @returns Map name -> [{code: "rehearsal" | "part" | "fast" | "long", text}] for the swings to check
   */
  function flags(rows) {
    const byClub = new Map();
    for (const r of rows || []) if (r.club) (byClub.get(r.club) || byClub.set(r.club, []).get(r.club)).push(r);
    const out = new Map();
    const add = (r, code, text) => (out.get(r.name) || out.set(r.name, []).get(r.name)).push({ code, text });
    for (const [club, list] of byClub) {
      const back = median(list.map(r => r.backswing)), speed = median(list.map(r => r.clubSpeed));
      const carry = median(list.map(r => r.carry > 0 ? r.carry : null));
      for (const r of list) {
        if (back != null && finite(r.backswing) && r.backswing >= REHEARSAL * back && r.backswing >= back + REHEARSAL_S) {
          add(r, "rehearsal", `the backswing took ${r.backswing.toFixed(1)} s against your usual ${back.toFixed(1)}: a drill or a rehearsal?`);
        }
        if (speed != null && finite(r.clubSpeed)) {
          if (r.clubSpeed <= SLOW * speed && !WEDGE.test(club)) {
            add(r, "part", `club speed ${r.clubSpeed.toFixed(0)} mph against your usual ${speed.toFixed(0)}: a part swing, or another club?`);
          } else if (r.clubSpeed >= FAST * speed) {
            add(r, "fast", `club speed ${r.clubSpeed.toFixed(0)} mph against your usual ${speed.toFixed(0)}: another club, or a misread?`);
          }
        }
        if (carry != null && finite(r.carry) && r.carry >= LONG * carry) {
          add(r, "long", `carried ${r.carry.toFixed(0)} yd against your usual ${carry.toFixed(0)}: another club than Square was set to?`);
        }
      }
    }
    return out;
  }

  const api = { MIN_SWINGS, REHEARSAL, REHEARSAL_S, SLOW, FAST, LONG, flags };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingReview = api;
})(typeof window !== "undefined" ? window : globalThis);
