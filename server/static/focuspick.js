// Move options for "Pick my own focus" (trends.js): every body move from coach.js MOVES
// that has a number in summary.js BODY, both ways, only sides without fault: true.
// Grouped by where it happens (Setup and backswing / Top of swing / Downswing / Impact; from
// the BODY entry's pos, tempo numbers in their own group), named in plain golfer's words
// with SwingShotStory.plain().
//
// Works in the browser (window.SwingFocusPick) and in Node (module.exports).
(function (root) {
  const Coach = root.SwingCoach || (typeof require !== "undefined" && require("./coach.js"));
  const Summary = root.SwingSummary || (typeof require !== "undefined" && require("./summary.js"));
  const ShotStory = root.SwingShotStory || (typeof require !== "undefined" && require("./shotstory.js"));

  const GROUPS = [
    "Setup and backswing",
    "Top of swing",
    "Downswing",
    "Impact",
    "Tempo",
  ];

  function groupFor(key, pos) {
    if (key === "tempo" || key === "backswing" || key === "downswing") return "Tempo";
    if (pos === "p1" || pos === "p2" || pos === "p3") return "Setup and backswing";
    if (pos === "p4") return "Top of swing";
    if (pos === "p5" || pos === "p6" || key === "releaseArm") return "Downswing";
    if (pos === "p7") return "Impact";
    return "Other";
  }

  /**
   * Builds the flat list of all selectable non-fault move sides.
   * Each: { move, aim, name, how, drill, thought, group, pos }
   */
  function allMoves(opts = {}) {
    const moves = (opts.coach && opts.coach.MOVES) || Coach.MOVES;
    const body = (opts.summary && opts.summary.BODY) || Summary.BODY;
    const plain = (opts.shotStory && opts.shotStory.plain) || ShotStory.plain;
    const bodyMap = new Map(body.map(b => [b.key, b]));

    const out = [];
    for (const [move, mVal] of Object.entries(moves)) {
      if (!bodyMap.has(move)) continue;
      const b = bodyMap.get(move);
      for (const aim of ["more", "less"]) {
        const side = mVal && mVal[aim];
        if (!side || side.fault) continue;
        const group = groupFor(move, b.pos);
        out.push({
          move,
          aim,
          name: plain(side.name),
          how: plain(side.how),
          drill: plain(side.drill),
          thought: plain(side.thought),
          group,
          pos: b.pos || null,
        });
      }
    }
    return out;
  }

  /**
   * Builds the moves grouped by where they happen.
   * Returns array of { group, moves: [...] } in GROUPS order.
   * If includeEmpty is false (default), omits groups with 0 moves.
   */
  function groupedMoves(opts = {}) {
    const list = allMoves(opts);
    const byGroup = new Map();
    for (const g of GROUPS) byGroup.set(g, []);
    for (const item of list) {
      if (!byGroup.has(item.group)) byGroup.set(item.group, []);
      byGroup.get(item.group).push(item);
    }
    const res = [];
    for (const [group, moves] of byGroup.entries()) {
      if (moves.length > 0 || opts.includeEmpty) {
        res.push({ group, moves });
      }
    }
    return res;
  }

  const api = { GROUPS, groupFor, allMoves, groupedMoves };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingFocusPick = api;
})(typeof window !== "undefined" ? window : globalThis);
