// Find swings: what the review page's Find box (and ?find= in the address) takes. Paste clip numbers
// (the 10 digits in a clip's name, e.g. 1790353993: either angle's, within 2 s), times ("9:25 PM",
// "9:25:49 pm", "21:25"), dates ("Sep 25", "9/25") or both ("Fri Sep 25 9:25:49 PM"), several at once,
// separated by anything. A swing matches any one of them.
//
// Works in the browser (window.SwingFind) and in Node (module.exports) for testing.
(function (root) {
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  // A clip's number and a swing's other angle are a second or two apart.
  const ID_SLACK = 2, SECONDS_SLACK = 2;
  const MON = `(${MONTHS.join("|")})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?`;
  const NUMERIC = `(\\d{1,2})\\/(\\d{1,2})(?:\\/\\d{2,4})?`;
  const TIME = `(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*([ap])?\\.?m?\\.?`;
  const ENTRY = new RegExp(`(?:(?:${MON}|${NUMERIC}),?\\s*)?(?:${TIME})?`, "gi");

  /** {ids: [unix s], moments: [{month, day, hour: [..], minute, second}]} (month 1-12, null = any). */
  function parse(text) {
    const out = { ids: [], moments: [] };
    const rest = String(text || "").replace(/\b(\d{10})(?:\.\d+)?\b/g, (m, id) => { out.ids.push(Number(id)); return " "; });
    for (const m of rest.matchAll(ENTRY)) {
      if (!m[0].trim()) continue;
      const month = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) + 1 : m[3] ? Number(m[3]) : null;
      const day = m[2] ? Number(m[2]) : m[4] ? Number(m[4]) : null;
      const moment = { month, day, hour: null, minute: null, second: null };
      if (m[5] != null) {
        const h = Number(m[5]), ap = m[8] && m[8].toLowerCase();
        if (h > 23 || Number(m[6]) > 59) continue;
        moment.hour = ap ? [(h % 12) + (ap === "p" ? 12 : 0)] : h > 12 || h === 0 ? [h] : [h, (h + 12) % 24];
        moment.minute = Number(m[6]);
        moment.second = m[7] != null ? Number(m[7]) : null;
      } else if (month == null) {
        continue;
      }
      out.moments.push(moment);
    }
    return out;
  }

  const isEmpty = q => !q || (!q.ids.length && !q.moments.length);

  /** The unix seconds in a clip's name (swing_face_1920x1080_240fps_1790353993_2007ms.mp4, or the
   * first days' swing_1920x1080_240fps_1790206507.mp4), or null. */
  function clipNumber(name) {
    const m = /_(\d{10})(?:_|\.)/.exec(name || "");
    return m ? Number(m[1]) : null;
  }

  function momentFits(mo, d) {
    if (mo.month != null && d.getMonth() + 1 !== mo.month) return false;
    if (mo.day != null && d.getDate() !== mo.day) return false;
    if (mo.hour == null) return true;
    // To the minute; with seconds, within SECONDS_SLACK (the list shows the face-on clip's time).
    const secs = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
    return mo.hour.some(h => {
      const want = h * 3600 + mo.minute * 60;
      return mo.second == null ? secs >= want && secs < want + 60 : Math.abs(secs - want - mo.second) <= SECONDS_SLACK;
    });
  }

  /** Whether a swing (its clips: [{name, recorded}], e.g. face-on and down the line) matches `q` (parse). */
  function matches(q, swingClips) {
    if (isEmpty(q)) return true;
    for (const c of swingClips.filter(Boolean)) {
      const n = clipNumber(c.name);
      if (n != null && q.ids.some(id => Math.abs(id - n) <= ID_SLACK)) return true;
      const d = c.recorded ? new Date(c.recorded) : null;
      if (d && !isNaN(d) && q.moments.some(mo => momentFits(mo, d))) return true;
    }
    return false;
  }

  const api = { parse, matches, isEmpty, clipNumber };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingFind = api;
})(typeof window !== "undefined" ? window : globalThis);
