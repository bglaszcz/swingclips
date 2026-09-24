// The P1-P8 swing checkpoints, found from the pose track. Ported from the phone app
// (src/utils/swingPhases.ts), with two changes for the server's clips:
//  - impact is the first frame the ball is gone from the mat, when the server found the ball
//    (see server/pose.py); otherwise it comes from the hand path;
//  - 240 fps frames are ~4 ms apart, where raw hand speed is mostly tracking jitter, so positions
//    are smoothed and speed is measured over ~1/30 s.
// P2, P6 and P8 are defined by the club shaft: when the server tracked it (server/club.py), they are
// the moments it passes horizontal; otherwise they are estimated from the hands and impact.
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
  const TORSO_MIN_VISIBILITY = 0.25;
  // Down-the-line, the hands spend much of the swing behind the body, so MediaPipe reports low
  // "visibility" while still placing them well. Trust them; the torso gates the frame.
  const HAND_MIN_VISIBILITY = 0.1;
  const SMOOTH_SECONDS = 1 / 60;   // half-width of the position smoothing window
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
    const raw = [];
    frames.forEach((f, index) => {
      if (!f.lm) return;
      const ls = lmAt(f.lm, LM.L_SHOULDER), rs = lmAt(f.lm, LM.R_SHOULDER);
      const lh = lmAt(f.lm, LM.L_HIP), rh = lmAt(f.lm, LM.R_HIP);
      if (![ls, rs, lh, rh].every(p => p.v >= TORSO_MIN_VISIBILITY)) return;
      const hand = handPoint(f.lm);
      const ps = lmAt(f.lm, lead);
      raw.push({
        index, t: f.t,
        // x scaled by the picture's aspect so distances are comparable in both directions.
        hand: { x: hand.x * aspect, y: hand.y },
        leadShoulder: { x: ps.x * aspect, y: ps.y },
        shoulderWidth: Math.abs(ls.x - rs.x) * aspect,
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

  function armParallel(ms, from, to) {
    let best = -1;
    for (let i = Math.max(0, from); i < to && i < ms.length; i++) {
      if (best < 0 || Math.abs(ms[i].armAngle) < Math.abs(ms[best].armAngle)) best = i;
    }
    return best;
  }

  /**
   * @param frames [{t, lm}] from the server's pose file (lm = flat [x, y, visibility] * 33 or null)
   * @param aspect picture width / height as displayed
   * @param leadSide "left" for a right-handed golfer
   * @param impactWindow optional [from, to] clip seconds when the strike was heard
   * @param impactTime optional clip seconds of the first frame without the ball
   * @returns [{key, tag, label, t, index, estimated}] - index is into `frames` - with a `takeaway`
   *   property: {t, fromShaft}, when the club starts back
   */
  function detect(frames, aspect, leadSide = "left", impactWindow = null, impactTime = null) {
    const ms = metrics(frames, aspect, leadSide);
    if (ms.length < 20) return [];

    // Impact must be in this window: around the ball leaving, else when the strike was heard,
    // else anywhere in the clip.
    const [from, to] = impactTime != null ? [impactTime - 0.02, impactTime + 0.02]
      : impactWindow || [-Infinity, Infinity];

    // The hands move fastest around impact, and that's the one moment that stands out in any clip.
    // (A follow-through can be as fast, which is what the strike window guards against.)
    let fastest = -1;
    ms.forEach((m, i) => {
      if (m.t < from - 0.1 || m.t > to + 0.1) return;
      if (fastest < 0 || m.speed > ms[fastest].speed) fastest = i;
    });
    if (fastest < 0) return [];

    // P4 top: hands highest in the two seconds before that.
    let top = -1;
    for (let i = 0; i < fastest; i++) {
      if (ms[fastest].t - ms[i].t > 2) continue;
      if (top < 0 || ms[i].hand.y < ms[top].hand.y) top = i;
    }
    if (top < 0) return [];

    // P1 address: the hands pause at the top too, so require a sustained still stretch, walking
    // back from the top.
    const still = ms[fastest].speed * 0.06;
    let address = 0, quietSince = -1;
    for (let i = top; i >= 0; i--) {
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
    if (impact <= top) return [];

    // Not a swing (e.g. someone waving at the camera): the phases don't fit together.
    const backswing = ms[top].t - ms[address].t, downswing = ms[impact].t - ms[top].t;
    if (backswing < 0.3 || backswing > 2 || downswing < 0.15 || downswing > 0.6) return [];

    // P3 / P5: lead arm parallel to the ground, going back and coming down.
    const p3 = armParallel(ms, address + 1, top);
    const p5 = armParallel(ms, top + 1, impact);

    // P2, fallback when the shaft wasn't tracked: shaft parallel in the takeaway is roughly when the hands have travelled
    // about 1.2 shoulder widths from address (1.1-1.35 measured on real swings, face-on).
    let p2 = -1;
    for (let i = address + 1; i <= top; i++) {
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
      p2: shaftHorizontal(frames, ms[address].t, ms[top].t)[0],
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
    // tracked, the takeaway is where it stops holding still; otherwise, where the hands' quiet
    // stretch ends. Either way P1 sits a little before that.
    const restEnd = shaftRestEnd(frames, shaft.p2 ? frames[shaft.p2.index].t : ms[top].t);
    const takeaway = restEnd >= 0 ? frames[restEnd].t : ms[address].t;
    const p1 = found.find(p => p.key === "p1");
    const a = nearestFrame(frames, takeaway - ADDRESS_LEAD);
    if (p1 && a >= 0) Object.assign(p1, { t: frames[a].t, index: a });

    found.sort((a, b) => a.key.localeCompare(b.key));
    // For tempo: when the club starts back, and whether that came from the shaft.
    found.takeaway = { t: takeaway, fromShaft: restEnd >= 0 };
    return found;
  }

  const api = { detect };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingPhases = api;
})(typeof window !== "undefined" ? window : globalThis);
