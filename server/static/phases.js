// The P1-P8 swing checkpoints, found from the pose track. Ported from the phone app
// (src/utils/swingPhases.ts, since removed; in the git history), with two changes for the server's clips:
//  - impact is the first frame the ball is gone from the mat, when the server found the ball
//    (see server/pose.py); otherwise it comes from the hand path;
//  - 240 fps frames are ~4 ms apart, where raw hand speed is mostly tracking jitter, so positions
//    are smoothed and speed is measured over ~1/30 s.
// P2, P6 and P8 are defined by the club shaft: when the server tracked it (server/club.py), they are
// the moments it passes horizontal; otherwise they are estimated from the hands and impact.
// The takeaway, P3, P4 and P5 follow the owner's hand labels (docs/key-positions.md): the takeaway
// is where the shaft first turns away from its angle at address, P3 / P5 where the lead forearm
// passes level, P4 where the hands start down. They use only points both body models place
// (MediaPipe's and RTMPose's: the wrists and elbows, not MediaPipe's finger points).
// tune_positions.py scores them against the labels (tuned on all swings but one, tested on it).
//
// Works in the browser (window.SwingPhases) and in Node (module.exports) for testing.
(function (root) {
  const LM = { L_SHOULDER: 11, R_SHOULDER: 12, L_ELBOW: 13, R_ELBOW: 14, L_WRIST: 15, R_WRIST: 16, L_HIP: 23, R_HIP: 24 };
  const LABELS = {
    p1: "Address", p2: "Shaft parallel (back)", p3: "Lead arm parallel (back)", p4: "Top",
    p5: "Lead arm parallel (down)", p6: "Shaft parallel (down)", p7: "Impact", p8: "Shaft parallel (through)",
  };
  const CLUB_DEFINED = ["p2", "p6", "p8"];
  // A shaft crossing counts as seen (not estimated) with a clear sighting of the shaft this close.
  const SHAFT_CONFIDENT = 0.35, SHAFT_SEEN_SECONDS = 0.02;
  // In the downswing a driver is a blur at 240 fps and the tracker mostly fills in (or latches onto
  // the arms), so a "crossing" can land right after the top. The shaft goes from horizontal to
  // vertical in ~45-60 ms, so a P6 crossing only counts this long before impact.
  const P6_BEFORE_IMPACT = [0.03, 0.1];
  // Address: the shaft holds within REST_DEGREES for at least REST_SECONDS before the takeaway;
  // P1 is put ADDRESS_LEAD before the takeaway starts, so the club is clearly still at rest.
  const REST_SECONDS = 0.3, REST_DEGREES = 2, ADDRESS_LEAD = 0.1;
  // The few numbers the key positions are tuned by (tune_positions.py picks them on the labeled
  // swings, scoring each swing with them tuned on the others; tests/test_fixtures.py holds the result):
  //  - takeawayDegrees: the takeaway is found from the first frame from which the shaft stays more
  //    than this off its address angle (the tracked angle moves in 2-degree steps: 1 = any change),
  //    extended back to address along the shaft's early motion (see shaftTakeaway);
  //  - topSpeedShares, topSmoothSeconds: the top is found from the last moments before impact the
  //    lead wrist moves at these two shares of its downswing peak (see handsStartDown), with its
  //    positions smoothed over +- this.
  const TUNING = { takeawayDegrees: 1, topSpeedShares: [0.1, 0.4], topSmoothSeconds: 0.03 };
  const TORSO_MIN_VISIBILITY = 0.25;
  // Down-the-line, the hands spend much of the swing behind the body, so MediaPipe reports low
  // "visibility" while still placing them well. Trust them; the torso gates the frame.
  const HAND_MIN_VISIBILITY = 0.1;
  const SMOOTH_SECONDS = 1 / 60;   // half-width of the position smoothing window
  // Pump drill (drills.py): the hands go to the top, down to the trail pocket and back up, once or
  // more, before the real downswing. A turn of the hands counts once they've come back this many
  // torso lengths (shoulders to hips; ~1.2 top to pump bottom on the owner's drills); the final top
  // is the highest the hands get this long before impact.
  const PUMP_DEPTH = 0.5, PUMP_LAST_TOP_SECONDS = 1.0;
  const SPEED_SECONDS = 1 / 60;    // half-width of the span speed is measured over

  function lmAt(lm, i) {
    return { x: lm[i * 3], y: lm[i * 3 + 1], v: lm[i * 3 + 2] };
  }

  function handPoint(lm) {
    const lw = lmAt(lm, LM.L_WRIST), rw = lmAt(lm, LM.R_WRIST);
    const hasL = lw.v >= HAND_MIN_VISIBILITY, hasR = rw.v >= HAND_MIN_VISIBILITY;
    if (hasL && hasR) {
      // Both hands grip the same club; when they disagree, lean on the one the model is surer of.
      const w = lw.v + rw.v;
      return { x: (lw.x * lw.v + rw.x * rw.v) / w, y: (lw.y * lw.v + rw.y * rw.v) / w };
    }
    if (hasL) return { x: lw.x, y: lw.y };
    if (hasR) return { x: rw.x, y: rw.y };
    // Both hands lost: the elbows follow the same arc closely enough.
    const le = lmAt(lm, LM.L_ELBOW), re = lmAt(lm, LM.R_ELBOW);
    return { x: (le.x + re.x) / 2, y: (le.y + re.y) / 2 };
  }

  /** Per-frame hand position, lead-arm angle and hand speed, for frames with a clear torso. */
  function metrics(frames, aspect, leadSide) {
    const lead = leadSide === "left" ? LM.L_SHOULDER : LM.R_SHOULDER;
    const leadElbow = leadSide === "left" ? LM.L_ELBOW : LM.R_ELBOW, leadWrist = leadSide === "left" ? LM.L_WRIST : LM.R_WRIST;
    const raw = [];
    frames.forEach((f, index) => {
      if (!f.lm) return;
      const ls = lmAt(f.lm, LM.L_SHOULDER), rs = lmAt(f.lm, LM.R_SHOULDER);
      const lh = lmAt(f.lm, LM.L_HIP), rh = lmAt(f.lm, LM.R_HIP);
      if (![ls, rs, lh, rh].every(p => p.v >= TORSO_MIN_VISIBILITY)) return;
      const hand = handPoint(f.lm);
      const ps = lmAt(f.lm, lead);
      const el = lmAt(f.lm, leadElbow), wr = lmAt(f.lm, leadWrist);
      raw.push({
        index, t: f.t,
        // x scaled by the picture's aspect so distances are comparable in both directions.
        hand: { x: hand.x * aspect, y: hand.y },
        leadShoulder: { x: ps.x * aspect, y: ps.y },
        shoulderWidth: Math.abs(ls.x - rs.x) * aspect,
        torso: Math.hypot(((ls.x + rs.x) - (lh.x + rh.x)) / 2 * aspect, ((ls.y + rs.y) - (lh.y + rh.y)) / 2),
        // Lead forearm above (+) or below (-) horizontal, in degrees; null when the model hasn't
        // got the arm.
        forearm: el.v >= HAND_MIN_VISIBILITY && wr.v >= HAND_MIN_VISIBILITY
          ? Math.atan2(-(wr.y - el.y), Math.abs(wr.x - el.x) * aspect) * 180 / Math.PI : null,
      });
    });

    // Smooth hand positions over a short time window (by time, so dropped frames don't matter).
    const out = raw.map((m, i) => {
      let sx = 0, sy = 0, n = 0;
      for (let j = i; j >= 0 && m.t - raw[j].t <= SMOOTH_SECONDS; j--) { sx += raw[j].hand.x; sy += raw[j].hand.y; n++; }
      for (let j = i + 1; j < raw.length && raw[j].t - m.t <= SMOOTH_SECONDS; j++) { sx += raw[j].hand.x; sy += raw[j].hand.y; n++; }
      return { ...m, hand: { x: sx / n, y: sy / n } };
    });

    let a = 0, b = 0;
    for (let i = 0; i < out.length; i++) {
      const m = out[i];
      // Lead arm: lead shoulder -> hands. 0 degrees = parallel to the ground.
      let angle = Math.atan2(m.hand.y - m.leadShoulder.y, m.hand.x - m.leadShoulder.x) * 180 / Math.PI;
      if (angle > 90) angle -= 180;
      if (angle < -90) angle += 180;
      m.armAngle = angle;
      // Speed over [t - SPEED_SECONDS, t + SPEED_SECONDS].
      while (out[a].t < m.t - SPEED_SECONDS) a++;
      if (b < i) b = i;
      while (b + 1 < out.length && out[b + 1].t <= m.t + SPEED_SECONDS) b++;
      const dt = out[b].t - out[a].t;
      m.speed = dt > 0 ? Math.hypot(out[b].hand.x - out[a].hand.x, out[b].hand.y - out[a].hand.y) / dt : 0;
    }
    return out;
  }

  /**
   * Moments the tracked shaft passes horizontal (either way) between clip times from and to:
   * [{t, index, seen}], index into frames. frames[i].club is [degrees, confidence] or null.
   */
  function shaftHorizontal(frames, from, to) {
    const out = [];
    for (let i = 0; i + 1 < frames.length; i++) {
      const a = frames[i], b = frames[i + 1];
      if (a.t < from || b.t > to || !a.club || !b.club) continue;
      const sa = Math.sin(a.club[0] * Math.PI / 180), sb = Math.sin(b.club[0] * Math.PI / 180);
      const turn = Math.abs(((b.club[0] - a.club[0] + 540) % 360) - 180);
      if (sa === sb || sa * sb > 0 || turn > 40) continue;
      const t = a.t + (b.t - a.t) * sa / (sa - sb);
      const seen = frames.some(f => f.club && f.club[1] >= SHAFT_CONFIDENT && Math.abs(f.t - t) <= SHAFT_SEEN_SECONDS);
      out.push({ t, index: t - a.t <= b.t - t ? i : i + 1, seen });
    }
    return out;
  }

  /**
   * The last frame before time `before` that ends a stretch of REST_SECONDS with the shaft still:
   * where the takeaway starts. Index into frames, or -1.
   */
  function shaftRestEnd(frames, before) {
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i];
      if (f.t > before || !f.club) continue;
      let ok = true, j = i;
      for (; j >= 0 && f.t - frames[j].t <= REST_SECONDS; j--) {
        const c = frames[j].club;
        if (!c || Math.abs(((c[0] - f.club[0] + 540) % 360) - 180) > REST_DEGREES) { ok = false; break; }
      }
      if (ok && j >= 0) return i;   // j >= 0: the whole stretch is inside the clip
    }
    return -1;
  }

  function nearestFrame(frames, t) {
    let best = -1;
    frames.forEach((f, i) => {
      if (f.lm && (best < 0 || Math.abs(f.t - t) < Math.abs(frames[best].t - t))) best = i;
    });
    return best;
  }

  function nearest(ms, t) {
    let best = 0;
    ms.forEach((m, i) => { if (Math.abs(m.t - t) < Math.abs(ms[best].t - t)) best = i; });
    return best;
  }

  /**
   * P4, the top: where the hands start down (clip seconds), or null. The hands hang near their
   * highest for 0.1-0.25 s at the top, so neither their height nor their slowest moment pins the
   * top down (both wander across that stretch, and MediaPipe often loses the hands behind the head
   * there). The downswing's acceleration does: the lead wrist's speed climbs roughly in a straight
   * line from rest, so the last moments before impact it was under two shares of its downswing peak
   * (TUNING.topSpeedShares, where the climb is steep and well measured) are extended back along
   * that line to zero speed. The lead wrist alone: both body models place it (the finger points
   * are MediaPipe's only), and at the top the trail wrist is often hidden behind the head.
   * Positions smoothed over +-TUNING.topSmoothSeconds, speed over +-SPEED_SECONDS, x scaled by the
   * aspect; only frames between `from` and `to` count.
   */
  function handsStartDown(frames, aspect, leadSide, from, to) {
    const k = leadSide === "left" ? LM.L_WRIST : LM.R_WRIST;
    const half = TUNING.topSmoothSeconds;
    const pts = [];
    for (const f of frames) {
      if (f.lm && f.t >= from - half - SPEED_SECONDS && f.t <= to + half + SPEED_SECONDS) {
        pts.push({ t: f.t, x: f.lm[k * 3] * aspect, y: f.lm[k * 3 + 1] });
      }
    }
    const sm = pts.map(p => {
      const near = pts.filter(q => Math.abs(q.t - p.t) <= half);
      return { x: near.reduce((a, q) => a + q.x, 0) / near.length, y: near.reduce((a, q) => a + q.y, 0) / near.length };
    });
    const speed = pts.map((p, i) => {
      let a = i, b = i;
      while (a > 0 && p.t - pts[a - 1].t <= SPEED_SECONDS) a--;
      while (b + 1 < pts.length && pts[b + 1].t - p.t <= SPEED_SECONDS) b++;
      return b > a && p.t > from && p.t < to ? Math.hypot(sm[b].x - sm[a].x, sm[b].y - sm[a].y) / (pts[b].t - pts[a].t) : null;
    });
    const peak = Math.max(0, ...speed.filter(v => v != null));
    // The last moment the speed climbs through share * peak (between two frames).
    const climbs = share => {
      const level = share * peak;
      for (let i = pts.length - 1; i > 0; i--) {
        const a = speed[i - 1], b = speed[i];
        if (a != null && b != null && a < level && b >= level) return pts[i - 1].t + (pts[i].t - pts[i - 1].t) * (level - a) / (b - a);
      }
      return null;
    };
    const [lo, hi] = TUNING.topSpeedShares;
    const tLo = climbs(lo), tHi = climbs(hi);
    if (!peak || tLo == null || tHi == null || tHi <= tLo) return null;
    return Math.max(from, tLo - (tHi - tLo) * lo / (hi - lo));
  }

  /**
   * P3 / P5, lead arm parallel: the first frame in ms[from..to) where the lead forearm (elbow to
   * wrist, in the picture) passes horizontal, rising (P3) or falling (P5); -1 if it doesn't. The
   * forearm rather than shoulder to hands: against the owner's labels a line from the shoulder
   * point reads ~10 degrees steep (the models put that point above the joint the arm swings from),
   * while the labels sit on the forearm's level with no offset (face-on). Frames without a
   * clear forearm are passed over.
   */
  function forearmLevel(ms, from, to, rising) {
    let prev = -1;
    for (let i = Math.max(0, from); i < to && i < ms.length; i++) {
      if (ms[i].forearm == null) continue;
      if (prev >= 0) {
        const a = ms[prev].forearm, b = ms[i].forearm;
        if (rising ? a < 0 && b >= 0 : a > 0 && b <= 0) return Math.abs(a) < Math.abs(b) ? prev : i;
      }
      prev = i;
    }
    return -1;
  }

  /** Fallback for P3 / P5: the frame in ms[from..to) with the lead arm (shoulder to hands) most level. */
  function armParallel(ms, from, to) {
    let best = -1;
    for (let i = Math.max(0, from); i < to && i < ms.length; i++) {
      if (best < 0 || Math.abs(ms[i].armAngle) < Math.abs(ms[best].armAngle)) best = i;
    }
    return best;
  }

  /**
   * The takeaway: where the shaft starts to turn away from its angle at address (the median over
   * the rest before restEnd). Index into frames, or -1. The tracked angle moves in 2-degree steps,
   * so the first frame from which it stays more than TUNING.takeawayDegrees off (all the way to time
   * `until`, P2 or the top) is already a step into the motion; the next step (2 degrees further)
   * gives the shaft's early speed, and the line through the two is extended back to the address
   * angle. The owner labels the first frame the clubhead visibly moves: the first step came ~25 ms
   * after it (median, RTMPose-m), the line back to address ~17 ms (docs/key-positions.md).
   */
  function shaftTakeaway(frames, restEnd, until) {
    const ref = frames[restEnd].club[0];
    const off = [];
    let start = restEnd;
    for (let j = restEnd; j >= 0 && frames[restEnd].t - frames[j].t <= REST_SECONDS; j--) {
      if (frames[j].club) off.push(((frames[j].club[0] - ref + 540) % 360) - 180);
      start = j;
    }
    off.sort((x, y) => x - y);
    const address = ref + off[off.length >> 1];
    // The first frame from which the shaft stays more than `degrees` off address until `until`.
    const staysOff = degrees => {
      let first = -1;
      for (let i = frames.length - 1; i > start; i--) {
        const f = frames[i];
        if (f.t > until || !f.club) continue;
        if (Math.abs(((f.club[0] - address + 540) % 360) - 180) <= degrees) break;
        first = i;
      }
      return first;
    };
    const d = TUNING.takeawayDegrees, first = staysOff(d), next = first >= 0 ? staysOff(d + 2) : -1;
    if (next <= first) return first;
    const t = frames[first].t - (frames[next].t - frames[first].t) * d / 2;
    let i = first;
    while (i > start && Math.abs(frames[i - 1].t - t) < Math.abs(frames[i].t - t)) i--;
    return i;
  }


  /**
   * The hands' turning points from ms[from] to ms[to] (a zigzag: each turn is kept once the hands
   * have come back PUMP_DEPTH torso lengths from it): [{i, top}] in order, top = highest (true) or
   * lowest (false) point, indices into ms. The last point is where the stretch ends.
   */
  function handTurns(ms, from, to) {
    const torsos = ms.slice(from, to + 1).map(m => m.torso).filter(v => v > 0).sort((a, b) => a - b);
    if (!torsos.length) return [];
    const depth = PUMP_DEPTH * torsos[Math.floor(torsos.length / 2)];
    const out = [];
    let ext = from, up = null;   // the extreme so far, and whether the hands are going up (y falling)
    for (let i = from + 1; i <= to; i++) {
      const y = ms[i].hand.y, ey = ms[ext].hand.y;
      if (up === null) {
        if (Math.abs(y - ey) >= depth) { up = y < ey; out.push({ i: ext, top: !up }); ext = i; }
        else if (y > ey) ext = i;   // before any move, the lowest point so far (address)
        continue;
      }
      if (up ? y < ey : y > ey) ext = i;
      else if (Math.abs(y - ey) >= depth) { out.push({ i: ext, top: up }); up = !up; ext = i; }
    }
    out.push({ i: ext, top: up === true });
    return out;
  }

  /**
   * @param frames [{t, lm}] from the server's pose file (lm = flat [x, y, visibility] * 33 or null)
   * @param aspect picture width / height as displayed
   * @param leadSide "left" for a right-handed golfer
   * @param impactWindow optional [from, to] clip seconds when the strike was heard
   * @param impactTime optional clip seconds of the first frame without the ball
   * @param options {drill}: "pump" for a pump-drill swing (drills.py): P1-P3 come from the first
   *   backswing, P4 is the last top before the downswing, and the pump bottoms are returned too
   * @returns [{key, tag, label, t, index, estimated}] - index is into `frames` - with a `takeaway`
   *   property: {t, fromShaft}, when the club starts back, and for a pump drill `drill` ("pump") and
   *   `pumps` ([{t, index}], where the hands turned back up at the bottom of each pump). When no swing
   *   is found, an empty array with a `why` property: {reason, text, and the numbers behind it} (see noSwing).
   */
  function detect(frames, aspect, leadSide = "left", impactWindow = null, impactTime = null, options = {}) {
    const ms = metrics(frames, aspect, leadSide);
    // Impact must be in this window: around the ball leaving, else when the strike was heard,
    // else anywhere in the clip.
    const [from, to] = impactTime != null ? [impactTime - 0.02, impactTime + 0.02]
      : impactWindow || [-Infinity, Infinity];
    const r3 = x => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
    // Why there's no swing, with what it was looking at, for the server's log (app.py noswing.jsonl).
    const noSwing = (reason, text, extra = {}) => Object.assign([], { why: {
      reason, text,
      window: [r3(from), r3(to)], windowFrom: impactTime != null ? "ball" : impactWindow ? "strike" : "whole clip",
      frames: frames.length, bodyFrames: ms.length,
      bodySpan: ms.length ? [r3(ms[0].t), r3(ms[ms.length - 1].t)] : null,
      ...extra,
    } });
    if (ms.length < 20) {
      return noSwing("tracking", `the body (shoulders and hips) was tracked in only ${ms.length} of ${frames.length} frames (20 needed)`);
    }

    // The hands move fastest around impact, and that's the one moment that stands out in any clip.
    // (A follow-through can be as fast, which is what the strike window guards against.)
    let fastest = -1;
    ms.forEach((m, i) => {
      if (m.t < from - 0.1 || m.t > to + 0.1) return;
      if (fastest < 0 || m.speed > ms[fastest].speed) fastest = i;
    });
    if (fastest < 0) {
      return noSwing("window", `no tracked frames around the strike window ${r3(from)}-${r3(to)} s (the body was tracked ${r3(ms[0].t)}-${r3(ms[ms.length - 1].t)} s)`);
    }
    const peak = { fastestT: r3(ms[fastest].t), peakSpeed: r3(ms[fastest].speed) };

    // Roughly the top for now: hands highest in the two seconds before that (see handsStartDown).
    let top = -1;
    for (let i = 0; i < fastest; i++) {
      if (ms[fastest].t - ms[i].t > 2) continue;
      if (top < 0 || ms[i].hand.y < ms[top].hand.y) top = i;
    }
    if (top < 0) return noSwing("no-backswing", `the hands' fastest moment (${r3(ms[fastest].t)} s) has no tracked frames before it`, peak);

    // A pump drill: the last top is the one the downswing starts from; the backswing is the first
    // move up from address, and the pumps are the low points between the tops.
    let backTop = top, pumps = [];
    if (options && options.drill === "pump") {
      let last = -1;
      for (let i = 0; i < fastest; i++) {
        if (ms[fastest].t - ms[i].t > PUMP_LAST_TOP_SECONDS) continue;
        if (last < 0 || ms[i].hand.y < ms[last].hand.y) last = i;
      }
      const turns = last > 0 ? handTurns(ms, 0, last) : [];
      const tops = turns.filter(x => x.top).map(x => x.i);
      if (tops.length >= 2) {
        top = last;
        backTop = tops[0];
        pumps = turns.filter(x => !x.top && x.i > backTop && x.i < last).map(x => x.i);
      }
    }

    // P1 address: the hands pause at the top too, so require a sustained still stretch, walking
    // back from the top.
    const still = ms[fastest].speed * 0.06;
    let address = 0, quietSince = -1;
    for (let i = backTop; i >= 0; i--) {
      if (ms[i].speed <= still) {
        if (quietSince < 0) quietSince = i;
        if (ms[quietSince].t - ms[i].t >= 0.2) { address = quietSince; break; }
      } else {
        quietSince = -1;
      }
    }

    // P7 impact: the ball leaving, when known. Otherwise the hands come back to about where they
    // were at address. ("Lowest hands" only works down the line; face-on, the hands keep dropping
    // for a moment after impact.)
    let impact = impactTime != null ? nearest(ms, impactTime) : -1;
    for (let i = top + 1; impactTime == null && i < ms.length && ms[i].t <= ms[fastest].t + 0.15; i++) {
      if (ms[i].t < from - 0.05 || ms[i].t > to + 0.05) continue;
      const gap = Math.hypot(ms[i].hand.x - ms[address].hand.x, ms[i].hand.y - ms[address].hand.y);
      const best = impact < 0 ? Infinity
        : Math.hypot(ms[impact].hand.x - ms[address].hand.x, ms[impact].hand.y - ms[address].hand.y);
      if (gap < best) impact = i;
    }
    if (impact <= top) {
      return noSwing("impact-before-top", impact < 0
        ? `no impact found after the top (${r3(ms[top].t)} s) inside the strike window`
        : `impact (${r3(ms[impact].t)} s) came before the top (${r3(ms[top].t)} s)`,
                     { ...peak, topT: r3(ms[top].t), impactT: impact >= 0 ? r3(ms[impact].t) : null });
    }

    // P3: the lead arm parallel to the ground going back (the forearm rising through level), then
    // P4, the top: where the hands start down, between P3 and impact.
    let p3 = forearmLevel(ms, address + 1, pumps.length ? backTop : impact, true);
    if (p3 < 0) p3 = armParallel(ms, address + 1, backTop);
    const downFrom = pumps.length ? ms[pumps[pumps.length - 1]].t : p3 >= 0 ? ms[p3].t : ms[address].t;
    const turn = handsStartDown(frames, aspect, leadSide, downFrom, ms[impact].t);
    if (turn != null) top = nearest(ms, turn);
    if (!pumps.length) backTop = top;

    // Not a swing (e.g. someone waving at the camera): the phases don't fit together. With pumps
    // the backswing is the first move to the top.
    const backswing = ms[backTop].t - ms[address].t, downswing = ms[impact].t - ms[top].t;
    if (backswing < 0.3 || backswing > 2 || downswing < 0.15 || downswing > 0.6) {
      return noSwing("timing", `backswing ${r3(backswing)} s and downswing ${r3(downswing)} s don't fit a swing (0.3-2 s and 0.15-0.6 s)`,
                     { ...peak, addressT: r3(ms[address].t), topT: r3(ms[top].t), impactT: r3(ms[impact].t),
                       backswing: r3(backswing), downswing: r3(downswing) });
    }
    if (p3 >= backTop) p3 = armParallel(ms, address + 1, backTop);

    // P5: the lead arm parallel coming down (the forearm falling through level).
    let p5 = forearmLevel(ms, top + 1, impact, false);
    if (p5 < 0) p5 = armParallel(ms, top + 1, impact);

    // P2, fallback when the shaft wasn't tracked: shaft parallel in the takeaway is roughly when the hands have travelled
    // about 1.2 shoulder widths from address (1.1-1.35 measured on real swings, face-on).
    let p2 = -1;
    for (let i = address + 1; i <= backTop; i++) {
      const moved = Math.hypot(ms[i].hand.x - ms[address].hand.x, ms[i].hand.y - ms[address].hand.y);
      if (moved >= ms[address].shoulderWidth * 1.2) { p2 = i; break; }
    }

    // P6 / P8, fallback when the shaft wasn't tracked: the shaft passes horizontal roughly this long either side of impact
    // (~55-60 ms before and ~70 ms after on real 7-iron swings).
    const p6 = Math.min(impact - 1, nearest(ms, ms[impact].t - 0.055));
    const p8 = Math.max(impact + 1, nearest(ms, ms[impact].t + 0.07));

    const picks = [["p1", address], ["p2", p2], ["p3", p3], ["p4", top], ["p5", p5], ["p6", p6], ["p7", impact], ["p8", p8]];
    const found = picks
      .filter(([, i]) => i >= 0 && i < ms.length)
      .map(([key, i]) => ({
        key, tag: key.toUpperCase(), label: LABELS[key], t: ms[i].t, index: ms[i].index,
        estimated: CLUB_DEFINED.includes(key),
      }));

    // The shaft, where the server tracked it: the first horizontal after address, the last before
    // impact, the first after.
    const shaft = {
      p2: shaftHorizontal(frames, ms[address].t, ms[backTop].t)[0],
      p6: shaftHorizontal(frames, ms[impact].t - P6_BEFORE_IMPACT[1], ms[impact].t - P6_BEFORE_IMPACT[0]).pop(),
      p8: shaftHorizontal(frames, ms[impact].t, ms[impact].t + 0.4)[0],
    };
    for (const p of found) {
      const c = shaft[p.key];
      if (c) Object.assign(p, { t: frames[c.index].t, index: c.index, estimated: !c.seen });
    }
    for (const key of CLUB_DEFINED) {
      if (shaft[key] && !found.some(p => p.key === key)) {
        const c = shaft[key];
        found.push({ key, tag: key.toUpperCase(), label: LABELS[key], t: frames[c.index].t, index: c.index, estimated: !c.seen });
      }
    }

    // P1 address: the club at rest behind the ball, not already moving back. With the shaft
    // tracked, the takeaway is where it starts to turn away from its angle at rest; otherwise,
    // where the hands' quiet stretch ends. Either way P1 sits a little before that.
    const until = shaft.p2 ? frames[shaft.p2.index].t : ms[backTop].t;
    // With the club model (the server's deep pass) the pose file also has the ray-cast shaft
    // (clubRay): steadier at address, where the model's angle wobbles a degree or two, so the rest
    // and the takeaway come from it. Same frames, so the indices hold.
    const restFrames = frames.some(f => f.clubRay !== undefined)
      ? frames.map(f => (f.clubRay === undefined ? f : Object.assign({}, f, { club: f.clubRay })))
      : frames;
    const restEnd = shaftRestEnd(restFrames, until);
    const moved = restEnd >= 0 ? shaftTakeaway(restFrames, restEnd, until) : -1;
    const takeaway = moved >= 0 ? frames[moved].t : restEnd >= 0 ? frames[restEnd].t : ms[address].t;
    const p1 = found.find(p => p.key === "p1");
    const a = nearestFrame(frames, takeaway - ADDRESS_LEAD);
    if (p1 && a >= 0) Object.assign(p1, { t: frames[a].t, index: a });

    found.sort((a, b) => a.key.localeCompare(b.key));
    // For tempo: when the club starts back, and whether that came from the shaft.
    found.takeaway = { t: takeaway, fromShaft: restEnd >= 0 };
    if (pumps.length) {
      found.drill = "pump";
      found.pumps = pumps.map(i => ({ t: ms[i].t, index: ms[i].index }));
    }
    return found;
  }

  const api = { detect, TUNING };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingPhases = api;
})(typeof window !== "undefined" ? window : globalThis);
