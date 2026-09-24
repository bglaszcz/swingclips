// One swing's analysis (key positions, face-on and down-the-line numbers) and its summary: the
// handful of numbers per swing the session trends compare with the launch monitor's.
// Uses SwingPhases (phases.js) and SwingMetrics (metrics.js).
//
// Works in the browser (window.SwingSummary) and in Node (module.exports) for testing.
(function (root) {
  const Phases = root.SwingPhases || (typeof require !== "undefined" && require("./phases.js"));
  const Metrics = root.SwingMetrics || (typeof require !== "undefined" && require("./metrics.js"));
  // Bump when a change here or in phases.js / metrics.js changes the numbers: cached summaries
  // from older versions are worked out again.
  const VERSION = 1;

  /** Index of the frame on screen at time t: the last one that starts at or before t. */
  function frameIndexAt(frames, t) {
    let lo = 0, hi = frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (frames[mid].t <= t + 0.0005) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /**
   * Seconds to add to a time in clip a to get the same moment in clip b ({impact, strike} each).
   * Their impacts line up: by the ball when both saw it go, else by the strike each phone heard.
   */
  function syncOffset(a, b) {
    if (a.impact != null && b.impact != null) return b.impact - a.impact;
    if (a.strike != null && b.strike != null) return b.strike - a.strike;
    // Mixed or missing: the capture app puts the strike about 2 s in.
    return (b.impact ?? b.strike ?? 2.0) - (a.impact ?? a.strike ?? 2.0);
  }

  /** Picture width / height as shown, from the clip's name (…_1920x1080_…) and the pose file's rotation. */
  function aspectOf(name, rotation) {
    const m = name.match(/_(\d+)x(\d+)_/);
    if (!m) return 9 / 16;
    const w = +m[1], h = +m[2];
    return rotation === 90 || rotation === 270 ? h / w : w / h;
  }

  /**
   * Clip seconds impact must be in. Impact is when the ball leaves the mat, if the server saw it
   * go. If not: the capture app cuts each clip 2 s before the strike it heard, starting on a
   * keyframe (every 0.25 s), so the strike is about 2.0-2.25 s in; real impacts have landed
   * 1.97-2.33 s in, so allow a little either side. Newer clips say exactly where it was heard.
   */
  function strikeWindow(name, strike) {
    return strike != null ? [strike - 0.15, strike + 0.15] : name.startsWith("swing_") ? [1.9, 2.4] : null;
  }

  /**
   * @param main the clip the swing is opened through (face-on, or a lone down-the-line one):
   *   {name, strike, angle, aspect, frames, impact, ball}
   * @param other its down-the-line partner in the same shape, or null
   * @param leadSide "left" for a right-handed golfer
   * @returns {positions, metrics (face-on) | null, dtl: the down-the-line clip | null,
   *   dtlMetrics | null, dtlIndex(key): frame index of position key in the down-the-line clip}
   */
  function analyze(main, other, leadSide) {
    const positions = Phases.detect(main.frames, main.aspect, leadSide, strikeWindow(main.name, main.strike),
                                    main.impact);
    const metrics = main.angle === "dtl" ? null : Metrics.compute(main.frames, main.aspect, leadSide, positions);
    const dtl = other || (main.angle === "dtl" ? main : null);
    const offset = other ? syncOffset(main, other) : 0;
    const dtlIndex = key => {
      const p = positions.find(q => q.key === key);
      if (!p || !dtl) return null;
      return dtl === main ? p.index : frameIndexAt(dtl.frames, p.t + offset);
    };
    const address = positions.length ? dtlIndex("p1") : null;
    const dtlMetrics = address == null ? null : Metrics.computeDTL(dtl.frames, dtl.aspect, address, dtl.ball);
    return { positions, metrics, dtl, dtlMetrics, dtlIndex };
  }

  // The body numbers compared across a session: [key, label, unit, view, position, value key].
  // Signs follow metrics.js: turns + = closed, sway + = toward the target, "to ball" + = toward it.
  // Not turns at impact: from face-on they come out ~0 there (the hips look as wide as at address).
  const BODY = [
    ["tempo", "Tempo", ":1", "face"], ["backswing", "Backswing time", "s", "face"],
    ["downswing", "Downswing time", "s", "face"],
    ["shoulderTop", "Shoulder turn at top", "°", "face", "p4", "shoulderTurn"],
    ["pelvisTop", "Pelvis turn at top", "°", "face", "p4", "pelvisTurn"],
    ["xFactor", "X-factor at top", "°", "face", "p4", "separation"],
    ["hipSway", "Hip sway at impact", "in", "face", "p7", "hipSway"],
    ["headSway", "Head sway at impact", "in", "face", "p7", "headSway"],
    ["headRise", "Head rise at impact", "in", "face", "p7", "headRise"],
    ["spineTiltImpact", "Spine tilt at impact", "°", "face", "p7", "spineTilt"],
    ["earlyExt", "Hips to ball at impact", "in", "dtl", "p7", "hipDepth"],
    ["bendLoss", "Bend vs address at impact", "°", "dtl", "p7", "bendChange"],
    ["headToBall", "Head to ball at impact", "in", "dtl", "p7", "headDepth"],
    ["handsPlaneP6", "Hands to plane at P6", "in", "dtl", "p6", "handsPlane"],
    ["shaftPlaneP6", "Shaft to plane at P6", "°", "dtl", "p6", "shaftPlane"],
    ["handsPlaneTop", "Hands to plane at top", "in", "dtl", "p4", "handsPlane"],
    ["handHeightTop", "Hand height at top", "in", "dtl", "p4", "handHeight"],
    ["handDepthTop", "Hand depth at top", "in", "dtl", "p4", "handDepth"],
  ].map(([key, label, unit, view, pos, value]) => ({ key, label, unit, view, pos, value }));

  // The launch monitor's numbers, from a clip's shot. Left is negative, as Square reports it.
  const SHOT = [
    ["carry", "Carry", "yd", s => s.ball.carry], ["offline", "Offline", "yd", s => s.ball.side],
    ["ballSpeed", "Ball speed", "mph", s => s.ball.speed], ["clubSpeed", "Club speed", "mph", s => s.clubData.speed],
    ["smash", "Smash", "", s => s.clubData.smash],
    ["path", "Club path", "°", s => s.clubData.path], ["face", "Face to target", "°", s => s.clubData.faceToTarget],
    ["faceToPath", "Face to path", "°", s => s.clubData.faceToTarget - s.clubData.path],
    ["attack", "Attack angle", "°", s => s.clubData.angleOfAttack], ["loft", "Dynamic loft", "°", s => s.clubData.loft],
    ["launch", "Launch", "°", s => s.ball.vla], ["direction", "Direction", "°", s => s.ball.hla],
    ["spinAxis", "Spin axis", "°", s => s.ball.spinAxis], ["spin", "Spin", "rpm", s => s.ball.totalSpin],
    ["strikeH", "Strike toe/heel", "mm", s => s.clubData.faceImpactH],
    ["strikeV", "Strike high/low", "mm", s => s.clubData.faceImpactV],
  ].map(([key, label, unit, get]) => ({ key, label, unit, get }));

  const finite = v => typeof v === "number" && Number.isFinite(v) ? v : null;

  /** The body numbers of one analyzed swing: {key: number | null}. */
  function bodyNumbers(a) {
    const out = {};
    const tp = a.metrics && a.metrics.tempo;
    out.tempo = tp ? tp.ratio : null;
    out.backswing = tp ? tp.back : null;
    out.downswing = tp ? tp.down : null;
    for (const f of BODY) {
      if (!f.pos) continue;
      let v = null;
      if (f.view === "face" && a.metrics) {
        const p = a.positions.find(q => q.key === f.pos);
        v = p ? a.metrics.values[p.index] : null;
      } else if (f.view === "dtl" && a.dtlMetrics) {
        const i = a.dtlIndex(f.pos);
        v = i == null ? null : a.dtlMetrics.values[i];
      }
      out[f.key] = finite(v && v[f.value]);
    }
    return out;
  }

  /** The launch monitor's numbers for a shot (or all null). */
  function shotNumbers(shot) {
    const out = {};
    for (const f of SHOT) {
      let v = null;
      try { v = shot ? f.get({ ball: {}, clubData: {}, ...shot }) : null; } catch {}
      out[f.key] = finite(v);
    }
    return out;
  }

  /** Pearson's r, and how big |r| must be to stand out from chance (p < 0.05) with this many pairs. */
  function correlation(xs, ys) {
    const pts = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => x != null && y != null);
    const n = pts.length;
    if (n < 3) return { r: null, n, needed: null };
    const mx = pts.reduce((s, p) => s + p[0], 0) / n, my = pts.reduce((s, p) => s + p[1], 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
    const r = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
    // Two-sided 5% t value, approximated: within ~2% from 3 degrees of freedom (5 swings) up; too
    // low below that, where the page doesn't rank anything anyway.
    const df = n - 2, t = 1.96 + 2.5 / df + 3 / (df * df);
    return { r, n, needed: t / Math.sqrt(df + t * t), slope: sxx > 0 ? sxy / sxx : null, mx, my };
  }

  /**
   * Where the golfer is in one camera's picture at address, in picture heights: hips (x, y) and
   * height (nose to ankles). A phone that moves between sessions shifts the body numbers without the
   * swing changing; comparing these shows when the setup changed.
   */
  function framing(input, index) {
    const f = index == null ? null : input.frames[index];
    if (!f || !f.lm) return null;
    const lm = f.lm, y = i => lm[i * 3 + 1];
    return {
      x: (lm[23 * 3] + lm[24 * 3]) / 2 * input.aspect, y: (y(23) + y(24)) / 2,
      h: Math.max(y(27), y(28)) - y(0),
    };
  }

  /**
   * Everything the trends keep about one swing, from its pose files (the server calls this too):
   * {body: bodyNumbers, quality: what could be measured, setup: framing per camera}.
   * Inputs as for analyze(), except aspect may be left out when `rotation` (from the pose file) is given.
   */
  function summarize(main, other, leadSide) {
    for (const c of [main, other]) if (c && c.aspect == null) c.aspect = aspectOf(c.name, c.rotation);
    const a = analyze(main, other, leadSide);
    const pos = key => a.positions.find(p => p.key === key);
    const p1 = pos("p1"), p6 = pos("p6");
    return {
      body: bodyNumbers(a),
      quality: {
        swingFound: a.positions.length > 0,
        // Impact from the ball leaving the mat (frame-exact) rather than the heard strike.
        ballFace: main.angle === "dtl" ? null : main.impact != null,
        dtl: !!a.dtl, ballDtl: a.dtl ? a.dtl.impact != null : null,
        p6Estimated: p6 ? !!p6.estimated : null,
      },
      setup: {
        face: main.angle === "dtl" || !p1 ? null
          : { ...framing(main, a.metrics ? a.metrics.address : p1.index), scale: a.metrics ? a.metrics.scale : null },
        dtl: a.dtlMetrics ? { ...framing(a.dtl, a.dtlMetrics.address), scale: a.dtlMetrics.scale } : null,
      },
    };
  }

  const api = { VERSION, BODY, SHOT, frameIndexAt, syncOffset, aspectOf, strikeWindow, analyze, bodyNumbers,
                shotNumbers, correlation, summarize };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingSummary = api;
})(typeof window !== "undefined" ? window : globalThis);
