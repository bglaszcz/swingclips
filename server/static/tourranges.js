// server/static/tourranges.js
// Published tour player benchmark ranges for body movements.
// Used as a faint comparison band beside the golfer's own good-shot ranges.
// Tour ranges NEVER determine tile colors, verdicts, focuses, or coaching take.
(function (root) {
  "use strict";

  // Only numbers with a source that measures what SwingClips measures (Claude's review of round 69, Oct 20):
  // the turns, X-factor, hip sway and hips open that round 69 listed were cited to home pages, some with
  // titles no paper has, and are 3D-sensor angles where SwingClips' turns are face-on 2D widths (your
  // shoulder turn reads ~120 on this scale): left out until a real source on the same measure turns up.
  // Tour Tempo (John Novosel): tour players' backswing takes three times as long as the downswing; the frame
  // counts it lists for tour players run from 21/7 to 27/9 at 30 frames a second (0.70-0.90 s back, 0.23-0.30 s
  // down), timed from the takeaway to the top to impact, as SwingClips times tempo (metrics.js).
  const TOUR_TEMPO = {
    title: "It's About Time (Tour Tempo, John Novosel)",
    author: "Sports Illustrated",
    cite: "Tour Tempo",
    year: 2010,
    link: "https://vault.si.com/vault/2010/08/02/its-about-time",
  };
  const RANGES = [
    { key: "tempo", label: "Tempo", min: 2.8, max: 3.2, unit: ":1", club: "all", system: "video", source: TOUR_TEMPO },
    { key: "backswing", label: "Backswing time", min: 0.70, max: 0.90, unit: "s", club: "all", system: "video", source: TOUR_TEMPO },
    { key: "downswing", label: "Downswing time", min: 0.23, max: 0.30, unit: "s", club: "all", system: "video", source: TOUR_TEMPO },
  ];

  function get(key, club) {
    if (!key) return null;
    const matches = RANGES.filter(r => r.key === key);
    if (!matches.length) return null;
    if (club) {
      const specific = matches.find(r => r.club === club);
      if (specific) return specific;
    }
    return matches.find(r => r.club === "all") || matches[0];
  }

  function all() {
    return RANGES.slice();
  }

  function isSupported(key) {
    return RANGES.some(r => r.key === key);
  }

  function formatTourText(key, club) {
    const entry = get(key, club);
    if (!entry) return "";
    const cite = entry.source.cite || (entry.source.author ? `${entry.source.author} ${entry.source.year}` : entry.source.title);
    const u = entry.unit ? (entry.unit === ":1" ? " :1" : entry.unit === "°" ? "°" : " " + entry.unit) : "";
    return `Tour players (${cite}): ${entry.min} to ${entry.max}${u}`;
  }

  const api = {
    RANGES,
    get,
    all,
    isSupported,
    formatTourText,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingTourRanges = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
