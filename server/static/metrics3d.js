// Swing numbers from real 3D joints (server/tri.py: both phones, calibrated), in golf axes: metres,
// x toward the target, y up, z toward the golfer's front (toward the ball), origin at the ball.
// Only when 3D is on and the swing has a calibration; the 2D numbers (metrics.js) stay as they are.
//
// Segments, for a right-handed golfer (lead side = left; the axes assume it):
//  - pelvis: the line from the trail hip to the lead hip. Rotation is its heading about the vertical,
//    side bend its slope (lead hip higher +). Its forward tilt needs points on the front and back of
//    the pelvis, which the body models don't have, so there is none.
//  - thorax: spine from mid-hips to mid-shoulders, and the shoulder line square to it. Rotation is
//    the shoulder line's heading about the vertical, as for the pelvis (on the first real swings the
//    rotation of a Ry Rx Rz split of the thorax came out 46-108 degrees at the top on back-to-back
//    7 irons, swapping with the bend; the shoulder line's heading gave 85-115). Forward bend toward
//    the ball and side bend (lead shoulder higher +) come from that split: Ry(heading) Rx(bend) Rz(side).
// Signs as in metrics.js: rotation + = closed (going back), - = open; sway + toward the target,
// thrust + toward the ball, lift + up, in inches from address. pelvisBall / thoraxBall: the pelvis's
// and the shoulders' middle along the target line from the ball (the origin), + = ahead of it.
//
// Speeds (degrees per second): pelvis and thorax the rate of their rotation toward the target; the
// lead arm (shoulder to wrist) and the club (hands to clubhead) how fast their direction turns. The
// kinematic sequence is when each peaks from the top to AFTER_IMPACT: pelvis, thorax, arm, club is
// the textbook order, each faster than the last. A pelvis or thorax that peaks after impact turned
// late: the arms led the downswing (bodyLate; the first real session: every swing, hips square at
// impact, which the golfer confirmed on the video).
//
// Works in the browser (window.SwingMetrics3D) and in Node / the server's V8 (module.exports).
(function (root) {
  const DEG = 180 / Math.PI, INCHES_PER_METRE = 39.37;
  const I = { L_SHOULDER: 11, R_SHOULDER: 12, L_ELBOW: 13, R_ELBOW: 14, L_WRIST: 15, R_WRIST: 16,
              L_INDEX: 19, R_INDEX: 20, L_HIP: 23, R_HIP: 24 };
  // Speeds are measured over +-SPEED_SECONDS (240 fps frames are too close for a difference).
  const SPEED_SECONDS = 1 / 120;
  // Then filtered (smoothSpeeds): a speed more than SPIKE_MADS robust deviations from the median of
  // the +-SPIKE_SECONDS around it is a tracking glitch and takes that median (Oct 8: the clubhead
  // "reached" 1559 deg/s 106 ms before impact, the frame before it was lost, and was taken as the
  // club's peak), then a Gaussian of SMOOTH_SECONDS (sigma; about a 13 Hz low-pass, as kinematic
  // sequence studies filter) over the frames that have one. Gaps aren't filled. Speeds within
  // GAP_EDGE_SECONDS of a gap of more than GAP_SECONDS are dropped first: the tracker's last frames
  // before it loses a point (the clubhead blurring away) are where it jumps.
  const SPIKE_SECONDS = 0.025, SPIKE_MADS = 3, SMOOTH_SECONDS = 0.012, GAP_SECONDS = 0.02, GAP_EDGE_SECONDS = 0.012;
  // The downswing for the sequence: from the top to this long after impact (s), per segment. The arm and
  // club peak by impact (after it, the release and follow-through outrun the downswing); the pelvis
  // and thorax get longer: at 0.03 those of the first real swings "peaked" right at the edge, still
  // speeding up.
  const AFTER_IMPACT = { pelvis: 0.12, thorax: 0.12, arm: 0.03, club: 0.03 };
  // The thorax track can jump at the top, where the arms cross the shoulders down the line (first real
  // swings: 30-45 degrees within 50 ms before the club reached the top). A jump of more than
  // THORAX_JUMP degrees within JUMP_SECONDS from P3 to the top (P4; the chest turns slowly there, unlike
  // in the downswing) marks its speed unreliable, and its top turn is the most closed one there.
  const THORAX_JUMP = 25, JUMP_SECONDS = 0.05;
  // A segment with no speed within IMPACT_NEAR_SECONDS of impact wasn't tracked through it (the clubhead
  // blurs away: Oct 8, lost from 67 ms before impact, so its "peak" was its last reading): it's left
  // out of the order, as a jumping thorax is.
  const IMPACT_NEAR_SECONDS = 0.02;
  // Pelvis rotation start: speed toward target (deg/s) held for at least this long (s) after P3.
  const PELVIS_START_SPEED = 20, PELVIS_START_SECONDS = 0.03;
  // Hands to clubhead is the club's length less the grip above the hands (inches), and counts as
  // agreeing within CLUB_TOLERANCE of it.
  const GRIP_ABOVE_HANDS = 4.5, CLUB_TOLERANCE = 0.1;
  // Standard steel / graphite lengths, inches, by Square's club code.
  const CLUB_LENGTH = { DR: 45.5, W3: 43, W5: 42, W7: 41, H3: 40.5, H4: 40, H5: 39.5, I3: 39, I4: 38.5, I5: 38,
                        I6: 37.5, I7: 37, I8: 36.5, I9: 36, PW: 35.75, GW: 35.5, SW: 35.25, LW: 35 };
  // Labels in golfer's words (the keys stay pelvis / thorax).
  const SEGMENTS = [["pelvis", "Hips"], ["thorax", "Chest"], ["arm", "Lead arm"], ["club", "Club"]];

  // Core joints (tri.CORE) checked at setup (right-handed golfer: left = lead).
  const CORE_JOINTS = [
    [11, "lead shoulder"], [12, "trail shoulder"],
    [13, "lead elbow"], [14, "trail elbow"],
    [15, "lead wrist"], [16, "trail wrist"],
    [23, "lead hip"], [24, "trail hip"],
    [25, "lead knee"], [26, "trail knee"],
    [27, "lead ankle"], [28, "trail ankle"],
  ];

  // Which table rows a missing joint blanks (view3d.js ROWS).
  const SHOULDER_ROWS = ["thoraxTurn", "separation", "thoraxBend", "thoraxSideBend", "thoraxSway"];
  const HIP_ROWS = ["pelvisTurn", "separation", "pelvisSideBend", "pelvisSway", "pelvisThrust", "pelvisLift"];
  const SHOULDER_LABELS = ["Shoulder turn", "Shoulders turned past the hips", "Chest bend toward the ball", "Shoulder tilt", "Chest slide"];
  const HIP_LABELS = ["Hip turn", "Shoulders turned past the hips", "Hip tilt", "Hip slide", "Hips toward the ball", "Hip lift"];

  const SETUP_BLANKS = {
    "lead shoulder": SHOULDER_ROWS,
    "trail shoulder": SHOULDER_ROWS,
    "shoulders": SHOULDER_ROWS,
    "lead hip": HIP_ROWS,
    "trail hip": HIP_ROWS,
    "hips": HIP_ROWS,
    "lead elbow": [], "trail elbow": [], "lead wrist": [], "trail wrist": [],
    "lead knee": [], "trail knee": [], "lead ankle": [], "trail ankle": [],
  };

  const SETUP_BLANK_LABELS = {
    "lead shoulder": SHOULDER_LABELS,
    "trail shoulder": SHOULDER_LABELS,
    "shoulders": SHOULDER_LABELS,
    "lead hip": HIP_LABELS,
    "trail hip": HIP_LABELS,
    "hips": HIP_LABELS,
    "lead elbow": [], "trail elbow": [], "lead wrist": [], "trail wrist": [],
    "lead knee": [], "trail knee": [], "lead ankle": [], "trail ankle": [],
  };

  function blankedRows(missing) {
    const keys = new Set();
    for (const j of missing || []) {
      for (const k of SETUP_BLANKS[j] || []) keys.add(k);
    }
    return Array.from(keys);
  }

  function blankedRowLabels(missing) {
    const labels = new Set();
    for (const j of missing || []) {
      for (const l of SETUP_BLANK_LABELS[j] || []) labels.add(l);
    }
    return Array.from(labels);
  }

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
        // R = [x y z] as columns = Ry(heading) Rx(bend) Rz(side bend); the rotation itself is the
        // shoulder line's heading, as for the pelvis.
        out.thoraxHeading = Math.atan2(-l[2], l[0]) * DEG;
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

  /** A speed series (per frame, null = none) with its glitches replaced and smoothed (see SMOOTH_SECONDS). */
  function smoothSpeeds(series, ts) {
    const n = series.length;
    const have = [];
    series.forEach((v, i) => { if (v != null) have.push(i); });
    const edges = [];   // [from, to] times of the gaps
    for (let k = 1; k < have.length; k++) {
      if (ts[have[k]] - ts[have[k - 1]] > GAP_SECONDS) edges.push([ts[have[k - 1]], ts[have[k]]]);
    }
    series = series.map((v, i) => v == null || edges.some(([a, b]) =>
      (ts[i] <= a && a - ts[i] < GAP_EDGE_SECONDS) || (ts[i] >= b && ts[i] - b < GAP_EDGE_SECONDS)) ? null : v);
    const near = (i, half) => {
      const out = [];
      for (let j = i; j >= 0 && ts[i] - ts[j] <= half; j--) if (series[j] != null) out.push(j);
      for (let j = i + 1; j < n && ts[j] - ts[i] <= half; j++) if (series[j] != null) out.push(j);
      return out;
    };
    const median = a => { const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
    const clean = series.map((v, i) => {
      if (v == null) return null;
      const vals = near(i, SPIKE_SECONDS).map(j => series[j]);
      if (vals.length < 4) return v;
      // The spread has a floor (5% of the median, 1 deg/s): a steady stretch still has its glitches caught.
      const med = median(vals), mad = Math.max(median(vals.map(x => Math.abs(x - med))) * 1.4826, Math.abs(med) * 0.05, 1);
      return Math.abs(v - med) > SPIKE_MADS * mad ? med : v;
    });
    return clean.map((v, i) => {
      if (v == null) return null;
      let sw = 0, sv = 0;
      for (let j = i; j >= 0 && ts[i] - ts[j] <= 3 * SMOOTH_SECONDS; j--) {
        if (clean[j] == null) continue;
        const w = Math.exp(-0.5 * ((ts[i] - ts[j]) / SMOOTH_SECONDS) ** 2);
        sw += w; sv += w * clean[j];
      }
      for (let j = i + 1; j < n && ts[j] - ts[i] <= 3 * SMOOTH_SECONDS; j++) {
        if (clean[j] == null) continue;
        const w = Math.exp(-0.5 * ((ts[j] - ts[i]) / SMOOTH_SECONDS) ** 2);
        sw += w; sv += w * clean[j];
      }
      return sv / sw;
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

    // Setup window: from 0.4 s before P1 to takeaway, or P1 + 0.1 s without one.
    const takeaway = (positions || []).find(p => p.key === "takeaway") || (positions && positions.takeaway ? positions.takeaway : null);
    const tRef = p1 ? p1.t : (frames[0] ? frames[0].t : 0);
    const tStart = tRef - 0.4;
    const tEnd = (takeaway && typeof takeaway.t === "number") ? takeaway.t : tRef + 0.1;
    const setupFrames = frames.filter(f => f.t >= tStart && f.t <= tEnd);
    const missing = [];
    for (const [id, name] of CORE_JOINTS) {
      const seen = setupFrames.some(f => f.p && f.p[id] != null);
      if (!seen) missing.push(name);
    }
    const setup = { missing, frames: setupFrames.length };
    const ts = frames.map(f => f.t);
    const raw = frames.map(f => frameValues(f.p, f.club || null));
    const ai = p1 ? nearest(frames, p1.t) : raw.findIndex(v => v.pelvisHeading != null && v.thoraxHeading != null);
    if (ai < 0) return null;
    const base = raw[ai];
    const pelvis = turnSeries(raw, "pelvisHeading"), thorax = turnSeries(raw, "thoraxHeading");
    const p0 = pelvis[ai], t0 = thorax[ai];
    const sp = spans(ts);
    // The pelvis start (below) keeps the speeds as measured: its 20 deg/s threshold was set on them.
    const pelvisRaw = rateOf(pelvis, ts, sp);
    const speed = {
      pelvis: smoothSpeeds(pelvisRaw, ts), thorax: smoothSpeeds(rateOf(thorax, ts, sp), ts),
      arm: smoothSpeeds(turnRate(raw.map(v => v.armDir || null), ts, sp), ts),
      club: smoothSpeeds(turnRate(raw.map(v => v.clubDir || null), ts, sp), ts),
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
        if (!v[key]) continue;
        r[seg + "Ball"] = inch(v[key][0]);
        if (!base[key]) continue;
        const d = sub(v[key], base[key]);
        r[seg + "Sway"] = inch(d[0]);
        r[seg + "Lift"] = inch(d[1]);
        r[seg + "Thrust"] = inch(d[2]);
      }
      for (const [seg] of SEGMENTS) if (speed[seg][i] != null) r[seg + "Speed"] = speed[seg][i];
      return r;
    });

    // The thorax's top: the most closed turn from P3 to P4 (the track can jump there), and whether it jumped.
    let thoraxTop = null, thoraxJump = null;
    const p3 = find("p3");
    if (p3 && p4) {
      for (const v of values) if (v.t >= p3.t && v.t <= p4.t && v.thoraxTurn != null && (!thoraxTop || v.thoraxTurn > thoraxTop.thoraxTurn)) thoraxTop = v;
      const end = p4.t;
      thoraxJump = 0;
      values.forEach((v, i) => {
        if (v.t < p3.t || v.t > end || v.thoraxTurn == null) return;
        for (let j = i + 1; j < values.length && values[j].t - v.t <= JUMP_SECONDS; j++) {
          if (values[j].thoraxTurn != null) thoraxJump = Math.max(thoraxJump, Math.abs(values[j].thoraxTurn - v.thoraxTurn));
        }
      });
    }
    const thoraxShaky = thoraxJump != null && thoraxJump > THORAX_JUMP;

    // Kinematic sequence: each segment's fastest moment between the top and just after impact.
    let sequence = null;
    if (p4 && p7) {
      const segs = [];
      for (const [key, label] of SEGMENTS) {
        let best = -1;
        values.forEach((v, i) => {
          const s = v[key + "Speed"];
          if (s == null || v.t < p4.t || v.t > p7.t + AFTER_IMPACT[key]) return;
          if (best < 0 || s > values[best][key + "Speed"]) best = i;
        });
        const lost = !values.some(v => v[key + "Speed"] != null && Math.abs(v.t - p7.t) <= IMPACT_NEAR_SECONDS);
        if (best >= 0) segs.push({ key, label, peak: values[best][key + "Speed"], t: values[best].t,
                                   beforeImpact: (p7.t - values[best].t) * 1000, afterImpact: values[best].t > p7.t,
                                   unreliable: (key === "thorax" && thoraxShaky) || lost,
                                   lost });
      }
      const sure = segs.filter(s => !s.unreliable);
      const order = sure.slice().sort((a, b) => a.t - b.t).map(s => s.key);
      const want = SEGMENTS.map(s => s[0]).filter(k => sure.some(s => s.key === k));
      const byKey = Object.fromEntries(segs.map(s => [s.key, s]));
      sequence = {
        segments: segs, order,
        inOrder: order.join() === want.join(),
        // Each faster than the one before it (the "speed gain" down the chain).
        gains: want.slice(1).map((k, i) => ({ from: want[i], to: k, ratio: byKey[k].peak / byKey[want[i]].peak })),
        // The body turned late: the pelvis or thorax at its fastest only after the ball was gone.
        bodyLate: ["pelvis", "thorax"].some(k => byKey[k] && byKey[k].afterImpact && !byKey[k].unreliable),
        thoraxJump,
        // The lead arm at its fastest before the pelvis.
        armsFirst: !!(byKey.arm && byKey.pelvis && byKey.arm.t < byKey.pelvis.t),
      };
    }

    // Pelvis rotation start: when the pelvis starts turning toward the target relative to the top (P4), in ms.
    // The first moment from P3 on after which the pelvis speed (as measured) stays above PELVIS_START_SPEED
    // for PELVIS_START_SECONDS.
    let pelvisStartMs = null;
    if (p3 && p4) {
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v.t < p3.t || pelvisRaw[i] == null) continue;
        if (pelvisRaw[i] >= PELVIS_START_SPEED) {
          let ok = true, j = i;
          while (j < values.length && values[j].t - v.t < PELVIS_START_SECONDS) {
            if (pelvisRaw[j] == null || pelvisRaw[j] < PELVIS_START_SPEED) {
              ok = false;
              break;
            }
            j++;
          }
          if (ok && j > i) {
            pelvisStartMs = Math.round((v.t - p4.t) * 1000);
            break;
          }
        }
      }
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
    return { values, address: ai, sequence, clubCheck, thoraxTop, pelvisStartMs, setup };
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
    // Along the target line from the ball at impact, + = ahead of it (the coach's pelvis / chest shift).
    ["pelvisBallImpact", "p7", "pelvisBall"], ["thoraxBallImpact", "p7", "thoraxBall"],
    // Open at impact, + = open (the turn's sign flipped): good players' hips are ~30-45 open.
    ["pelvisOpenImpact", "p7", "pelvisTurn", -1], ["thoraxOpenImpact", "p7", "thoraxTurn", -1],
  ];

  /**
   * One swing's 3D numbers from its pose inputs (as SwingSummary.summarize takes them) and 3D file.
   * @returns {numbers: {key: number | null}, sequence, clubCheck, reprojection, boneSpreadPct, setupMissing, addressError} | null
   */
  function summarize3d(main, other, leadSide, doc, club) {
    const S = root.SwingSummary || (typeof require !== "undefined" && require("./summary.js"));
    for (const c of [main, other]) if (c && c.aspect == null) c.aspect = S.aspectOf(c.name, c.rotation);
    const a = S.analyze(main, other, leadSide);
    const r = compute(doc, a.positions, leadSide, club);
    if (!r) return null;
    const at = atPositions(r, doc, a.positions);
    // The thorax's top turn and its separation from the pelvis there: the most closed from P3 to P4.
    if (at.p4 && r.thoraxTop) {
      at.p4 = Object.assign({}, at.p4, { thoraxTurn: r.thoraxTop.thoraxTurn,
        separation: at.p4.pelvisTurn != null ? r.thoraxTop.thoraxTurn - at.p4.pelvisTurn : at.p4.separation });
    }
    const numbers = {};
    for (const [key, pos, value, sign = 1] of SUMMARY) {
      const v = at[pos] && at[pos][value];
      numbers[key] = typeof v === "number" && Number.isFinite(v) ? sign * v : null;
    }
    numbers.pelvisStartMs = typeof r.pelvisStartMs === "number" && Number.isFinite(r.pelvisStartMs) ? r.pelvisStartMs : null;
    return { numbers, sequence: r.sequence, clubCheck: r.clubCheck, reprojection: doc.reprojection,
             boneSpreadPct: doc.boneSpreadPct, setupMissing: r.setup ? r.setup.missing : [],
             addressError: (doc.reprojection && doc.reprojection.address) ? doc.reprojection.address : null };
  }

  const api = { compute, atPositions, summarize3d, frameValues, SEGMENTS, CLUB_LENGTH,
                PELVIS_START_SPEED, PELVIS_START_SECONDS, CORE_JOINTS, SETUP_BLANKS,
                BLANKED_ROWS: SETUP_BLANKS, SETUP_BLANK_LABELS, blankedRows, blankedRowLabels, smoothSpeeds };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingMetrics3D = api;
})(typeof window !== "undefined" ? window : globalThis);
