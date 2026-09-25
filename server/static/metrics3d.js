// Swing numbers from real 3D joints (server/tri.py: both phones, calibrated), in golf axes: metres,
// x toward the target, y up, z toward the golfer's front (toward the ball), origin at the ball.
// Only when 3D is on and the swing has a calibration; the 2D numbers (metrics.js) stay as they are.
//
// Segments, for a right-handed golfer (lead side = left; the axes assume it):
//  - pelvis: the line from the trail hip to the lead hip. Rotation is its heading about the vertical,
//    side bend its slope (lead hip higher +). Its forward tilt needs points on the front and back of
//    the pelvis, which the body models don't have, so there is none.
//  - thorax: spine from mid-hips to mid-shoulders, and the shoulder line square to it. Its
//    orientation as three angles in turn: rotation about the vertical, then forward bend toward the
//    ball about the shoulder line, then side bend (lead shoulder higher +).
// Signs as in metrics.js: rotation + = closed (going back), - = open; sway + toward the target,
// thrust + toward the ball, lift + up, in inches from address.
//
// Speeds (degrees per second): pelvis and thorax the rate of their rotation toward the target; the
// lead arm (shoulder to wrist) and the club (hands to clubhead) how fast their direction turns. The
// kinematic sequence is when each peaks in the downswing: pelvis, thorax, arm, club is the textbook
// order, each faster than the last.
//
// Works in the browser (window.SwingMetrics3D) and in Node / the server's V8 (module.exports).
(function (root) {
  const DEG = 180 / Math.PI, INCHES_PER_METRE = 39.37;
  const I = { L_SHOULDER: 11, R_SHOULDER: 12, L_ELBOW: 13, R_ELBOW: 14, L_WRIST: 15, R_WRIST: 16,
              L_INDEX: 19, R_INDEX: 20, L_HIP: 23, R_HIP: 24 };
  // Speeds are measured over +-SPEED_SECONDS (240 fps frames are too close for a difference).
  const SPEED_SECONDS = 1 / 120;
  // The downswing for the sequence: from the top to a little after impact.
  const AFTER_IMPACT = 0.03;
  // Hands to clubhead is the club's length less the grip above the hands (inches), and counts as
  // agreeing within CLUB_TOLERANCE of it.
  const GRIP_ABOVE_HANDS = 4.5, CLUB_TOLERANCE = 0.1;
  // Standard steel / graphite lengths, inches, by Square's club code.
  const CLUB_LENGTH = { DR: 45.5, W3: 43, W5: 42, W7: 41, H3: 40.5, H4: 40, H5: 39.5, I3: 39, I4: 38.5, I5: 38,
                        I6: 37.5, I7: 37, I8: 36.5, I9: 36, PW: 35.75, GW: 35.5, SW: 35.25, LW: 35 };
  const SEGMENTS = [["pelvis", "Pelvis"], ["thorax", "Thorax"], ["arm", "Lead arm"], ["club", "Club"]];

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => Math.hypot(a[0], a[1], a[2]);
  const unit = a => { const n = norm(a); return n > 1e-9 ? scale(a, 1 / n) : null; };
  const mid = (a, b) => scale(add(a, b), 0.5);

  /** Angles and places for one frame's joints [33 x [x, y, z] | null]; null parts where missing. */
  function frameValues(p, club) {
    const got = (...ids) => ids.every(i => p[i]);
    const out = {};
    if (got(I.L_HIP, I.R_HIP)) {
      const l = sub(p[I.L_HIP], p[I.R_HIP]);
      out.pelvisHeading = Math.atan2(-l[2], l[0]) * DEG;
      out.pelvisSideBend = Math.asin(Math.max(-1, Math.min(1, l[1] / norm(l)))) * DEG;
      out.pelvisCentre = mid(p[I.L_HIP], p[I.R_HIP]);
    }
    if (got(I.L_HIP, I.R_HIP, I.L_SHOULDER, I.R_SHOULDER)) {
      const sh = mid(p[I.L_SHOULDER], p[I.R_SHOULDER]);
      const y = unit(sub(sh, mid(p[I.L_HIP], p[I.R_HIP])));
      const l = sub(p[I.L_SHOULDER], p[I.R_SHOULDER]);
      const x = y && unit(sub(l, scale(y, dot(l, y))));
      if (x) {
        const z = cross(x, y);
        // R = [x y z] as columns = Ry(heading) Rx(bend) Rz(side bend).
        out.thoraxHeading = Math.atan2(z[0], z[2]) * DEG;
        out.thoraxBend = Math.asin(Math.max(-1, Math.min(1, -z[1]))) * DEG;
        out.thoraxSideBend = Math.atan2(x[1], y[1]) * DEG;
      }
      out.thoraxCentre = sh;
    }
    if (got(I.L_SHOULDER, I.L_WRIST)) out.armDir = unit(sub(p[I.L_WRIST], p[I.L_SHOULDER]));
    if (got(I.L_INDEX, I.R_INDEX)) out.hands = mid(p[I.L_INDEX], p[I.R_INDEX]);
    if (club && out.hands) {
      out.clubDir = unit(sub(club, out.hands));
      out.clubReach = norm(sub(club, out.hands));
    }
    return out;
  }

  /** A heading series made continuous (no jumps of 360), then turned into "closed +". */
  function turnSeries(values, key) {
    let prev = null, shift = 0;
    return values.map(v => {
      if (!v || v[key] == null) return null;
      let a = v[key] + shift;
      if (prev != null) {
        while (a - prev > 180) { shift -= 360; a -= 360; }
        while (a - prev < -180) { shift += 360; a += 360; }
      }
      prev = a;
      return -a;
    });
  }

  /** Index of the frame nearest time t. */
  function nearest(frames, t) {
    let best = 0;
    frames.forEach((f, i) => { if (Math.abs(f.t - t) < Math.abs(frames[best].t - t)) best = i; });
    return best;
  }

  /** The frames at +-SPEED_SECONDS around each: [a, b] indices. */
  function spans(ts) {
    const out = [];
    let a = 0, b = 0;
    for (let i = 0; i < ts.length; i++) {
      while (ts[a] < ts[i] - SPEED_SECONDS) a++;
      if (b < i) b = i;
      while (b + 1 < ts.length && ts[b + 1] <= ts[i] + SPEED_SECONDS) b++;
      out.push([a, b]);
    }
    return out;
  }

  /** Rate of a series (per second) toward the target: -d/dt of a "closed +" angle. */
  function rateOf(series, ts, sp) {
    return series.map((v, i) => {
      const [a, b] = sp[i];
      if (series[a] == null || series[b] == null || b === a) return null;
      return -(series[b] - series[a]) / (ts[b] - ts[a]);
    });
  }

  /** How fast a direction turns, degrees per second. */
  function turnRate(dirs, ts, sp) {
    return dirs.map((v, i) => {
      const [a, b] = sp[i];
      if (!dirs[a] || !dirs[b] || b === a) return null;
      return Math.acos(Math.max(-1, Math.min(1, dot(dirs[a], dirs[b])))) * DEG / (ts[b] - ts[a]);
    });
  }

  /**
   * @param doc the swing's 3D file (tri.py): {frames: [{t, p: [33 x [x,y,z] | null], club?}], ...}
   * @param positions key positions of the face-on clip (SwingPhases.detect): P1 is address, P4 the top,
   *   P7 impact; times are face-on clip times, as the 3D frames' are
   * @param leadSide only "left" (the axes assume a right-handed golfer); anything else gives null
   * @param club Square's club code (e.g. "I7") for the length check, or null
   * @returns {values: per frame, address, sequence, clubCheck} | null
   */
  function compute(doc, positions, leadSide = "left", club = null) {
    if (!doc || !doc.frames || !doc.frames.length || leadSide !== "left") return null;
    const frames = doc.frames;
    const find = key => (positions || []).find(p => p.key === key);
    const p1 = find("p1"), p4 = find("p4"), p7 = find("p7");
    const ts = frames.map(f => f.t);
    const raw = frames.map(f => frameValues(f.p, f.club || null));
    const ai = p1 ? nearest(frames, p1.t) : raw.findIndex(v => v.pelvisHeading != null && v.thoraxHeading != null);
    if (ai < 0) return null;
    const base = raw[ai];
    const pelvis = turnSeries(raw, "pelvisHeading"), thorax = turnSeries(raw, "thoraxHeading");
    const p0 = pelvis[ai], t0 = thorax[ai];
    const sp = spans(ts);
    const speed = {
      pelvis: rateOf(pelvis, ts, sp), thorax: rateOf(thorax, ts, sp),
      arm: turnRate(raw.map(v => v.armDir || null), ts, sp), club: turnRate(raw.map(v => v.clubDir || null), ts, sp),
    };
    const inch = m => m * INCHES_PER_METRE;
    const values = raw.map((v, i) => {
      const r = { t: ts[i] };
      if (pelvis[i] != null && p0 != null) r.pelvisTurn = pelvis[i] - p0;
      if (thorax[i] != null && t0 != null) r.thoraxTurn = thorax[i] - t0;
      if (r.pelvisTurn != null && r.thoraxTurn != null) r.separation = r.thoraxTurn - r.pelvisTurn;
      if (v.pelvisSideBend != null) r.pelvisSideBend = v.pelvisSideBend;
      if (v.thoraxSideBend != null) r.thoraxSideBend = v.thoraxSideBend;
      if (v.thoraxBend != null) r.thoraxBend = v.thoraxBend;
      for (const [seg, key] of [["pelvis", "pelvisCentre"], ["thorax", "thoraxCentre"]]) {
        if (!v[key] || !base[key]) continue;
        const d = sub(v[key], base[key]);
        r[seg + "Sway"] = inch(d[0]);
        r[seg + "Lift"] = inch(d[1]);
        r[seg + "Thrust"] = inch(d[2]);
      }
      for (const [seg] of SEGMENTS) if (speed[seg][i] != null) r[seg + "Speed"] = speed[seg][i];
      return r;
    });

    // Kinematic sequence: each segment's fastest moment between the top and just after impact.
    let sequence = null;
    if (p4 && p7) {
      const segs = [];
      for (const [key, label] of SEGMENTS) {
        let best = -1;
        values.forEach((v, i) => {
          const s = v[key + "Speed"];
          if (s == null || v.t < p4.t || v.t > p7.t + AFTER_IMPACT) return;
          if (best < 0 || s > values[best][key + "Speed"]) best = i;
        });
        if (best >= 0) segs.push({ key, label, peak: values[best][key + "Speed"], t: values[best].t,
                                   beforeImpact: (p7.t - values[best].t) * 1000 });
      }
      const order = segs.slice().sort((a, b) => a.t - b.t).map(s => s.key);
      const want = SEGMENTS.map(s => s[0]).filter(k => segs.some(s => s.key === k));
      const byKey = Object.fromEntries(segs.map(s => [s.key, s]));
      sequence = {
        segments: segs, order,
        inOrder: order.join() === want.join(),
        // Each faster than the one before it (the "speed gain" down the chain).
        gains: want.slice(1).map((k, i) => ({ from: want[i], to: k, ratio: byKey[k].peak / byKey[want[i]].peak })),
      };
    }

    // The club against its known length, where the clubhead was triangulated.
    let clubCheck = null;
    const reach = raw.map(v => v.clubReach).filter(v => v != null).sort((a, b) => a - b);
    if (reach.length >= 10) {
      const measured = inch(reach[reach.length >> 1]);
      const length = club && CLUB_LENGTH[club];
      const expected = length ? length - GRIP_ABOVE_HANDS : null;
      clubCheck = { club: club || null, measured, expected, frames: reach.length,
                    diffPct: expected ? 100 * (measured - expected) / expected : null,
                    ok: expected ? Math.abs(measured - expected) <= CLUB_TOLERANCE * expected : null };
    }
    return { values, address: ai, sequence, clubCheck };
  }

  /** The numbers at key positions: {p1: values, p4: ..., p6, p7} (nearest 3D frame to each). */
  function atPositions(result, doc, positions) {
    const out = {};
    if (!result) return out;
    for (const p of positions || []) {
      if (!["p1", "p4", "p6", "p7"].includes(p.key)) continue;
      const i = nearest(doc.frames, p.t);
      if (Math.abs(doc.frames[i].t - p.t) < 0.01) out[p.key] = result.values[i];
    }
    return out;
  }

  // Per swing, for the trends (the swing worker keeps these in the swing's record as "body3d").
  const SUMMARY = [
    ["pelvisTop", "p4", "pelvisTurn"], ["thoraxTop", "p4", "thoraxTurn"], ["xFactorTop", "p4", "separation"],
    ["thoraxBendTop", "p4", "thoraxBend"], ["thoraxSideBendTop", "p4", "thoraxSideBend"],
    ["pelvisImpact", "p7", "pelvisTurn"], ["thoraxImpact", "p7", "thoraxTurn"],
    ["pelvisSideBendImpact", "p7", "pelvisSideBend"], ["thoraxSideBendImpact", "p7", "thoraxSideBend"],
    ["thoraxBendImpact", "p7", "thoraxBend"],
    ["pelvisSwayTop", "p4", "pelvisSway"], ["pelvisSwayImpact", "p7", "pelvisSway"],
    ["pelvisThrustImpact", "p7", "pelvisThrust"], ["pelvisLiftImpact", "p7", "pelvisLift"],
    ["thoraxSwayImpact", "p7", "thoraxSway"],
  ];

  /**
   * One swing's 3D numbers from its pose inputs (as SwingSummary.summarize takes them) and 3D file.
   * @returns {numbers: {key: number | null}, sequence, clubCheck, reprojection, boneSpreadPct} | null
   */
  function summarize3d(main, other, leadSide, doc, club) {
    const S = root.SwingSummary || (typeof require !== "undefined" && require("./summary.js"));
    for (const c of [main, other]) if (c && c.aspect == null) c.aspect = S.aspectOf(c.name, c.rotation);
    const a = S.analyze(main, other, leadSide);
    const r = compute(doc, a.positions, leadSide, club);
    if (!r) return null;
    const at = atPositions(r, doc, a.positions);
    const numbers = {};
    for (const [key, pos, value] of SUMMARY) {
      const v = at[pos] && at[pos][value];
      numbers[key] = typeof v === "number" && Number.isFinite(v) ? v : null;
    }
    return { numbers, sequence: r.sequence, clubCheck: r.clubCheck, reprojection: doc.reprojection,
             boneSpreadPct: doc.boneSpreadPct };
  }

  const api = { compute, atPositions, summarize3d, frameValues, SEGMENTS, CLUB_LENGTH };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingMetrics3D = api;
})(typeof window !== "undefined" ? window : globalThis);
