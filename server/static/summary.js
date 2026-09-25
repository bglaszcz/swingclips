// One swing's analysis (key positions, face-on and down-the-line numbers) and its summary: the
// handful of numbers per swing the session trends compare with the launch monitor's.
// Uses SwingPhases (phases.js) and SwingMetrics (metrics.js).
//
// Works in the browser (window.SwingSummary) and in Node (module.exports) for testing.
(function (root) {
  const Phases = root.SwingPhases || (typeof require !== "undefined" && require("./phases.js"));
  const Metrics = root.SwingMetrics || (typeof require !== "undefined" && require("./metrics.js"));

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

  // Camera check: body points that must be in the picture at address, how close to the side the
  // hips may be (share of the picture's width), and the smallest golfer (nose to ankles, share of
  // its height) the numbers hold up for.
  const IN_PICTURE = [0, 11, 12, 23, 24, 25, 26, 27, 28];
  const EDGE = 0.12, SMALL = 0.28, MARGIN = 0.01;

  /**
   * What's wrong with how one camera saw the swing, as codes: "out" (part of the golfer is out of
   * the picture at address), "edge" (near a side), "small" (too small to measure well), "hands"
   * (the hands leave the picture at the top). Empty when it's fine.
   */
  function cameraCheck(input, address, top) {
    const out = [];
    const f = address == null ? null : input.frames[address];
    if (!f || !f.lm) return out;
    const lm = f.lm, x = i => lm[i * 3], y = i => lm[i * 3 + 1];
    const outside = i => x(i) < MARGIN || x(i) > 1 - MARGIN || y(i) < MARGIN || y(i) > 1 - MARGIN;
    if (IN_PICTURE.some(outside)) out.push("out");
    const hx = (x(23) + x(24)) / 2;
    if (!out.includes("out") && (hx < EDGE || hx > 1 - EDGE)) out.push("edge");
    if (Math.max(y(27), y(28)) - y(0) < SMALL) out.push("small");
    const t = top == null ? null : input.frames[top];
    if (t && t.lm && [15, 16].every(i => { const u = t.lm[i * 3], v = t.lm[i * 3 + 1]; return u < 0 || u > 1 || v < 0 || v > 1; })) {
      out.push("hands");
    }
    return out;
  }

  /**
   * Camera setup, from one still of a phone's preview with the golfer at address: what's wrong and
   * what to do, written and spoken, and where the golfer is for the phone to focus on.
   * @param lm flat [x, y, visibility] * 33 in the upright picture, or null when no one was found
   * @param angle "face" or "dtl"
   * @returns {ok, codes, text, say, focus: {x, y, w, h} (share of the picture) | null}
   */
  function setupAdvice(lm, angle) {
    const cam = angle === "dtl" ? "Down the line" : "Face on";
    if (!lm) return { ok: false, codes: ["nobody"], text: "Can't see you: stand at the ball.", say: `${cam}: I can't see you.`, focus: null };
    const codes = cameraCheck({ frames: [{ lm }] }, 0, null);
    const x = i => lm[i * 3], y = i => lm[i * 3 + 1];
    const xs = IN_PICTURE.map(x), ys = IN_PICTURE.map(y);
    const tips = [];
    if (codes.includes("out") || codes.includes("edge")) {
      const offTop = Math.min(...ys) < MARGIN, offBottom = Math.max(...ys) > 1 - MARGIN;
      if (offTop && offBottom) tips.push("move the phone back");
      else if (offTop) tips.push("tilt the phone up");
      else if (offBottom) tips.push("tilt the phone down");
      const hx = (x(23) + x(24)) / 2;
      if (Math.min(...xs) < MARGIN || Math.max(...xs) > 1 - MARGIN || hx < EDGE || hx > 1 - EDGE) {
        tips.push(`you're at the ${hx < 0.5 ? "left" : "right"} edge: aim the phone more toward you`);
      }
    }
    if (codes.includes("small")) tips.push("move the phone closer");
    // Focus on the body from head to knees: the part that fills the frame.
    const pts = [0, 11, 12, 23, 24, 25, 26].map(i => [x(i), y(i)]);
    const x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0]));
    const y0 = Math.min(...pts.map(p => p[1])), y1 = Math.max(...pts.map(p => p[1]));
    const clamp = v => Math.max(0, Math.min(1, v));
    const focus = { x: clamp(x0 - 0.02), y: clamp(y0 - 0.02) };
    focus.w = clamp(x1 + 0.02) - focus.x;
    focus.h = clamp(y1 + 0.02) - focus.y;
    const ok = !codes.length;
    const text = ok ? "Good: all of you is in the picture." : tips.join("; ").replace(/^./, c => c.toUpperCase()) + ".";
    return { ok, codes, text, say: ok ? `${cam}: good.` : `${cam}: ${tips.join(", and ")}.`, focus };
  }

  /** cameraCheck for both angles of an analyzed swing: {face, dtl}, each a list of codes or null. */
  function cameras(a, main) {
    const p = key => a.positions.find(q => q.key === key);
    return {
      face: main.angle === "dtl" || !p("p1") ? null
        : cameraCheck(main, a.metrics ? a.metrics.address : p("p1").index, p("p4") ? p("p4").index : null),
      dtl: a.dtl && p("p1") ? cameraCheck(a.dtl, a.dtlIndex("p1"), a.dtlIndex("p4")) : null,
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
        camera: cameras(a, main),
      },
      setup: {
        face: main.angle === "dtl" || !p1 ? null
          : { ...framing(main, a.metrics ? a.metrics.address : p1.index), scale: a.metrics ? a.metrics.scale : null },
        dtl: a.dtlMetrics ? { ...framing(a.dtl, a.dtlMetrics.address), scale: a.dtlMetrics.scale } : null,
      },
    };
  }

  // ---- For the scorecard (server/eval.py), which compares all this with hand labels ----

  /**
   * When each key position is, in each clip's own seconds, as the review page shows it: the down-the-line
   * clip's are the main clip's moved by the sync offset. Inputs as for summarize().
   * @returns {main: {times: {key: t}, estimated: {key: bool}}, dtl: same | null, dtlSide: +1 | -1 | null}
   *   with "takeaway" among the times
   */
  function positionTimes(main, other, leadSide) {
    for (const c of [main, other]) if (c && c.aspect == null) c.aspect = aspectOf(c.name, c.rotation);
    const a = analyze(main, other, leadSide);
    const out = { main: { times: {}, estimated: {} }, dtl: null, dtlSide: a.dtlMetrics ? a.dtlMetrics.side : null };
    const second = a.dtl && a.dtl !== main ? { times: {}, estimated: {} } : null;
    for (const p of a.positions) {
      out.main.times[p.key] = p.t;
      out.main.estimated[p.key] = !!p.estimated;
      const i = second ? a.dtlIndex(p.key) : null;
      if (i != null) { second.times[p.key] = a.dtl.frames[i].t; second.estimated[p.key] = !!p.estimated; }
    }
    if (a.positions.takeaway) {
      out.main.times.takeaway = a.positions.takeaway.t;
      if (second) second.times.takeaway = a.dtl.frames[frameIndexAt(a.dtl.frames, a.positions.takeaway.t + syncOffset(main, other))].t;
    }
    out.dtl = second;
    return out;
  }

  /**
   * The one-frame angles for each of `lms` (flat [x, y, v] * 33 each, or null): face-on the tilts and
   * lead arm (metrics.js frameAngles), down the line the forward bend, with the ball to side `side`.
   */
  function frameAngles(lms, aspect, leadSide, angle, side) {
    return lms.map(lm => !lm ? null
      : angle === "dtl" ? (side ? { bend: Metrics.bendOf(lm, aspect, side) } : null)
      : Metrics.frameAngles(lm, aspect, leadSide));
  }

  /**
   * The noise floor: how much each number moves while the golfer stands still at address, the
   * `window` seconds before the takeaway. One clip on its own (its own key positions).
   * @returns {frames, from, to, sd: {key: standard deviation}} | null when no swing was found
   */
  function noiseFloor(input, leadSide, window = [0.35, 0.05]) {
    if (input.aspect == null) input.aspect = aspectOf(input.name, input.rotation);
    const a = analyze(input, null, leadSide);
    const takeaway = a.positions.takeaway;
    const m = input.angle === "dtl" ? a.dtlMetrics : a.metrics;
    if (!takeaway || !m) return null;
    const from = takeaway.t - window[0], to = takeaway.t - window[1];
    const series = {};
    input.frames.forEach((f, i) => {
      const v = m.values[i];
      if (!v || f.t < from || f.t > to) return;
      for (const [k, x] of Object.entries(v)) {
        if (typeof x === "number" && Number.isFinite(x)) (series[k] = series[k] || []).push(x);
      }
    });
    const sd = {};
    let frames = 0;
    for (const [k, xs] of Object.entries(series)) {
      frames = Math.max(frames, xs.length);
      if (xs.length < 5) continue;
      const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
      sd[k] = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1));
    }
    return { frames, from, to, sd };
  }

  const api = { BODY, SHOT, frameIndexAt, syncOffset, aspectOf, strikeWindow, analyze, bodyNumbers,
                shotNumbers, correlation, summarize, cameras, setupAdvice, positionTimes, frameAngles, noiseFloor };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingSummary = api;
})(typeof window !== "undefined" ? window : globalThis);
