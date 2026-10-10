// Strokes gained for range shots: every shot scored against a tour player from the same spot.
//
// A range shot has no flag, so each one is given the target a player would have with that club: the
// club's own usual carry, on the target line. Irons, wedges and hybrids are scored as approach shots
// (games.js scoreShot: how many strokes a tour player needs from where the ball finished, against
// how many they need from where it was hit). The driver and fairway woods are scored as tee shots on
// a 400 yd par 4 (games.js scoreDriving: longer and in the fairway is better). 0 is tour level.
//
// What a miss costs is split two ways for approach shots: what the shot would have lost with its
// sideways miss alone (direction) and with its long-or-short miss alone (distance).
//
// A net has no roll and the target is your own usual carry, so this measures how well you repeat a
// distance on a line: it is a practice number, not a round's strokes gained.
// Works in the browser (window.SwingStrokes) and in Node (module.exports).
(function (root) {
  const Games = root.SwingGames || (typeof require !== "undefined" && require("./games.js"));
  const GoodShots = root.SwingGoodShots || (typeof require !== "undefined" && require("./goodshots.js"));

  // Shots a session or a club needs before its average is shown.
  const MIN_SHOTS = 5;
  // A miss: further from the target than this share of its distance, that way.
  const MISS_PCT = 5;
  const TEE = /^(DR|W\d|\dW)$/;

  const finite = v => typeof v === "number" && Number.isFinite(v);
  const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const median = xs => {
    const v = xs.filter(finite).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };

  /** "tee" for the driver and fairway woods, "approach" for everything else but the putter (null). */
  function kindOf(club) {
    if (!GoodShots.groupOf(club)) return null;
    return TEE.test(club) ? "tee" : "approach";
  }

  /**
   * One shot against a tour player.
   * @param row {club, carry, offline}; base: the club's baseline (goodshots.js: its usual carry)
   * @returns {kind, sg, target, along, side, dist, lossDir, lossLen} or null (no carry, no usual carry yet)
   */
  function shot(row, base) {
    const kind = kindOf(row.club);
    if (!kind || !finite(row.carry) || !(row.carry > 0) || !finite(row.offline)) return null;
    if (kind === "tee") {
      const s = Games.scoreDriving(0, row);
      return s ? { kind, sg: s.sg, target: null, along: null, side: row.offline, dist: Math.abs(row.offline), lossDir: null, lossLen: null } : null;
    }
    const target = base && base.carry;
    if (!finite(target) || !(target > 0)) return null;
    const s = Games.scoreShot(target, row);
    if (!s) return null;
    // On the target exactly, and each miss on its own.
    const perfect = Games.scoreShot(target, { carry: target, offline: 0 }).sg;
    const dir = Games.scoreShot(target, { carry: target, offline: row.offline }).sg;
    const len = Games.scoreShot(target, { carry: row.carry, offline: 0 }).sg;
    return { kind, sg: s.sg, target, along: s.along, side: s.side, dist: s.dist, lossDir: perfect - dir, lossLen: perfect - len };
  }

  /**
   * A set of shots (a session, a club, a period).
   * @param ctx {clubs: goodshots.js build().clubs}
   * @returns {n, sg (per shot), prox (median yards from the target, approach shots), proxPct (as a share
   *   of the target), loss: {dir, len, dirShare} (approach shots; null without any), miss: {n, short, long,
   *   left, right, on}, byClub: [{club, kind, n, sg, prox}] most-hit first, shots: [{row, ...shot}]}
   */
  function session(rows, ctx) {
    const shots = [];
    for (const row of rows || []) {
      const c = ctx && ctx.clubs && ctx.clubs[row.club];
      const s = shot(row, c ? c.baseline : null);
      if (s) shots.push({ row, ...s });
    }
    const app = shots.filter(s => s.kind === "approach");
    const miss = { n: app.length, short: 0, long: 0, left: 0, right: 0, on: 0 };
    for (const s of app) {
      const band = MISS_PCT / 100 * s.target;
      const a = s.along < -band ? "short" : s.along > band ? "long" : null, b = s.side < -band ? "left" : s.side > band ? "right" : null;
      if (a) miss[a]++;
      if (b) miss[b]++;
      if (!a && !b) miss.on++;
    }
    const dir = mean(app.map(s => s.lossDir)), len = mean(app.map(s => s.lossLen));
    const clubs = {};
    for (const s of shots) (clubs[s.row.club] = clubs[s.row.club] || []).push(s);
    const byClub = Object.keys(clubs).map(club => ({ club, kind: clubs[club][0].kind, n: clubs[club].length,
      sg: mean(clubs[club].map(s => s.sg)), prox: clubs[club][0].kind === "approach" ? median(clubs[club].map(s => s.dist)) : null }))
      .sort((a, b) => b.n - a.n);
    return {
      n: shots.length, sg: mean(shots.map(s => s.sg)),
      prox: median(app.map(s => s.dist)), proxPct: median(app.map(s => s.dist / s.target * 100)),
      loss: app.length ? { dir, len, dirShare: dir + len > 0 ? dir / (dir + len) : null } : null,
      miss, byClub, shots,
    };
  }

  /** "0.42 behind" / "0.10 ahead" / "level": a strokes gained number in words. */
  function words(sg, digits = 2) {
    if (!finite(sg)) return "";
    const n = Math.abs(sg).toFixed(digits);
    return Number(n) === 0 ? "level" : `${n} ${sg < 0 ? "behind" : "ahead"}`;
  }

  const api = { MIN_SHOTS, MISS_PCT, kindOf, shot, session, words };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingStrokes = api;
})(typeof window !== "undefined" ? window : globalThis);
