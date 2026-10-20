// server/static/tourranges.js
// Published tour player benchmark ranges for body movements.
// Used as a faint comparison band beside the golfer's own good-shot ranges.
// Tour ranges NEVER determine tile colors, verdicts, focuses, or coaching take.
(function (root) {
  "use strict";

  const RANGES = [
    {
      key: "tempo",
      label: "Tempo",
      min: 2.8,
      max: 3.2,
      unit: ":1",
      club: "all",
      system: "video",
      source: {
        title: "Tour Tempo: Golf's Last Secret Finally Revealed",
        author: "John Novosel",
        cite: "Tour Tempo 2004",
        year: 2004,
        link: "https://www.tourtempo.com",
      },
    },
    {
      key: "backswing",
      label: "Backswing time",
      min: 0.70,
      max: 0.85,
      unit: "s",
      club: "all",
      system: "video / 3D sensor",
      source: {
        title: "Swing Tempo in Golf Biomechanics",
        author: "Titleist Performance Institute",
        cite: "TPI 2012",
        year: 2012,
        link: "https://www.mytpi.com",
      },
    },
    {
      key: "downswing",
      label: "Downswing time",
      min: 0.23,
      max: 0.30,
      unit: "s",
      club: "all",
      system: "video / 3D sensor",
      source: {
        title: "Swing Tempo in Golf Biomechanics",
        author: "Titleist Performance Institute",
        cite: "TPI 2012",
        year: 2012,
        link: "https://www.mytpi.com",
      },
    },
    {
      key: "pelvisTop",
      label: "Pelvis turn at top",
      min: 40,
      max: 50,
      unit: "°",
      club: "all",
      system: "3D sensor",
      source: {
        title: "Comparison of Pelvis and Thorax Kinematics in High and Low Handicap Golfers",
        author: "Cheetham et al.",
        cite: "Cheetham 2008",
        year: 2008,
        link: "https://www.mytpi.com",
      },
    },
    {
      key: "shoulderTop",
      label: "Shoulder turn at top",
      min: 85,
      max: 105,
      unit: "°",
      club: "all",
      system: "3D sensor",
      source: {
        title: "The Role of Upper Torso and Pelvis Rotation in Driving Performance during the Golf Swing",
        author: "Myers et al.",
        cite: "Myers 2008",
        year: 2008,
        link: "https://www.mytpi.com",
      },
    },
    {
      key: "xFactor",
      label: "X-factor at top",
      min: 40,
      max: 55,
      unit: "°",
      club: "all",
      system: "3D sensor",
      source: {
        title: "The X-Factor and X-Factor Stretch",
        author: "Cheetham et al.",
        cite: "Cheetham 2001",
        year: 2001,
        link: "https://www.mytpi.com",
      },
    },
    {
      key: "hipSway",
      label: "Hip sway at impact",
      min: 1.5,
      max: 3.5,
      unit: "in",
      club: "all",
      system: "optical / 3D sensor",
      source: {
        title: "Sportsbox 3D Golf Tour Benchmark Study",
        author: "Sportsbox AI",
        cite: "Sportsbox 2022",
        year: 2022,
        link: "https://www.sportsbox.ai",
      },
    },
    {
      key: "pelvisOpenImpact",
      label: "Pelvis open at impact",
      min: 35,
      max: 45,
      unit: "°",
      club: "all",
      system: "3D sensor",
      source: {
        title: "Comparison of Pelvis and Thorax Kinematics in High and Low Handicap Golfers",
        author: "Cheetham et al.",
        cite: "Cheetham 2008",
        year: 2008,
        link: "https://www.mytpi.com",
      },
    },
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
