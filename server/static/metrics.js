// Swing measurements from the pose track, for the angle readout and the key-position table.
// compute() is for a face-on camera (the golfer facing it); computeDTL() for one down the line.
//
// Pelvis and shoulder turn come from how much narrower the hips / shoulders look than at address
// (a line turned by t looks cos(t) as wide), with the direction from the swing: closed going back,
// open once they have come back past square. MediaPipe's own 3D estimate from one camera flattens
// turns badly (shoulders ~40 at the top) and even gets the direction wrong at impact, so it's only
// used for the forward bend and for scale. Turn *speeds* (a kinematic sequence) aren't attempted:
// near square a tiny change in width is a big change in angle, so from face-on alone the peaks come
// out in the wrong order; that needs a down-the-line camera too. Distances are in inches, scaled by
// MediaPipe's estimate of the body's real size, so they're approximate.
//
// Signs, for either hand: turns are positive going back (closed), negative once open to the
// target; tilts are positive when the lead side is higher / the spine leans away from the target;
// sway and head drift are positive toward the target (and up).
//
// Works in the browser (window.SwingMetrics) and in Node (module.exports) for testing.
(function (root) {
  const I = { NOSE: 0, L_EAR: 7, R_EAR: 8, L_SHOULDER: 11, R_SHOULDER: 12, L_WRIST: 15, R_WRIST: 16,
              L_INDEX: 19, R_INDEX: 20, L_HIP: 23, R_HIP: 24, L_ANKLE: 27, R_ANKLE: 28 };
  const DEG = 180 / Math.PI, INCHES_PER_METRE = 39.37;
  const FORWARD_MAX_TURN = 30;   // forward bend is only shown with the shoulders this near square

  const at = (a, i) => ({ x: a[i * 3], y: a[i * 3 + 1], z: a[i * 3 + 2] });
  const mid = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, z: (p.z + q.z) / 2 });

  /** The side-dependent landmarks: the lead side is the golfer's left for a right-hander. */
  function sides(leadSide) {
    const left = leadSide === "left";
    return {
      m: left ? 1 : -1,   // +1 when the target is to the picture's right
      leadShoulder: left ? I.L_SHOULDER : I.R_SHOULDER, trailShoulder: left ? I.R_SHOULDER : I.L_SHOULDER,
      leadHip: left ? I.L_HIP : I.R_HIP, trailHip: left ? I.R_HIP : I.L_HIP,
      leadWrist: left ? I.L_WRIST : I.R_WRIST,
    };
  }

  /** Angles and positions for one frame; null where they can't be measured. */
  function frameValues(f, aspect, s) {
    if (!f.lm) return null;
    // Picture units: x scaled by the aspect so both directions are in picture heights.
    const px = i => { const p = at(f.lm, i); return { x: p.x * aspect, y: p.y }; };
    const out = {};

    // How wide the hips and shoulders look, in body heights (nose to feet), for the turns.
    const body = Math.max(at(f.lm, I.L_ANKLE).y, at(f.lm, I.R_ANKLE).y) - at(f.lm, I.NOSE).y;
    if (body > 0) {
      out.hipWidth = s.m * (px(s.leadHip).x - px(s.trailHip).x) / body;
      out.shoulderWidth = s.m * (px(s.leadShoulder).x - px(s.trailShoulder).x) / body;
    }
    if (f.w) {
      const hip = mid(at(f.w, I.L_HIP), at(f.w, I.R_HIP));
      const sh = mid(at(f.w, I.L_SHOULDER), at(f.w, I.R_SHOULDER));
      // Forward bend: the spine's lean toward the ball (the camera), from upright.
      out.spineForward = Math.atan2(-(sh.z - hip.z), -(sh.y - hip.y)) * DEG;
    }

    const lsh = px(s.leadShoulder), lwr = px(s.leadWrist);
    // Lead arm above (+) or below (-) horizontal, in the picture.
    out.leadArm = Math.atan2(-(lwr.y - lsh.y), Math.abs(lwr.x - lsh.x)) * DEG;

    const hip2 = mid(px(I.L_HIP), px(I.R_HIP)), sh2 = mid(px(I.L_SHOULDER), px(I.R_SHOULDER));
    out.spineTilt = Math.atan2(-s.m * (sh2.x - hip2.x), -(sh2.y - hip2.y)) * DEG;
    const tilt = (lead, trail) => {
      const a = px(lead), b = px(trail);
      return Math.atan2(-(a.y - b.y), s.m * (a.x - b.x)) * DEG;
    };
    out.pelvisTilt = tilt(s.leadHip, s.trailHip);
    out.shoulderTilt = tilt(s.leadShoulder, s.trailShoulder);

    if (f.club) {
      // Shaft above (+) or below (-) horizontal: pointing straight down at address is -90.
      out.club = Math.asin(-Math.sin(f.club[0] / DEG)) * DEG;
      out.clubSeen = f.club[1] >= 0.35;
    }

    const ears = [I.NOSE, I.L_EAR, I.R_EAR].map(px);
    out.head = { x: ears.reduce((a, p) => a + p.x, 0) / 3, y: ears.reduce((a, p) => a + p.y, 0) / 3 };
    out.hips = hip2;
    out.grip = mid(px(I.L_INDEX), px(I.R_INDEX));
    return out;
  }

  /** Metres per picture height at the golfer, from MediaPipe's 3D size of shoulders-to-ankles. */
  function scaleAt(f, aspect) {
    if (!f || !f.lm || !f.w) return null;
    const pic = (a, i) => { const p = at(a, i); return { x: p.x * aspect, y: p.y }; };
    const d2 = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
    const d3 = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
    const shP = mid(pic(f.lm, I.L_SHOULDER), pic(f.lm, I.R_SHOULDER));
    const anP = mid(pic(f.lm, I.L_ANKLE), pic(f.lm, I.R_ANKLE));
    const shW = mid(at(f.w, I.L_SHOULDER), at(f.w, I.R_SHOULDER));
    const anW = mid(at(f.w, I.L_ANKLE), at(f.w, I.R_ANKLE));
    const p = d2(shP, anP);
    return p > 0 ? d3(shW, anW) / p : null;
  }

  /**
   * Turn in degrees per frame from apparent widths: acos(width / width at address), positive
   * (closed) until the line comes back to square after the top, negative (open) from then on.
   */
  function turns(widths, address, top) {
    const w0 = widths[address];
    if (w0 == null || w0 <= 0) return widths.map(() => null);
    const ratio = widths.map(w => w == null ? null : Math.max(-1, Math.min(1, w / w0)));
    // Square again: the first frame after the top that looks as wide as at address, or the widest.
    let square = -1;
    if (top != null) {
      for (let i = top; i < ratio.length; i++) {
        if (ratio[i] == null) continue;
        if (ratio[i] >= 0.99) { square = i; break; }
        if (square < 0 || ratio[i] > ratio[square]) square = i;
      }
    }
    return ratio.map((r, i) => {
      if (r == null) return null;
      const a = Math.acos(r) * DEG;
      return square >= 0 && i > square ? -a : a;
    });
  }

  /**
   * @param frames pose frames [{t, lm, w, club}]
   * @param aspect picture width / height
   * @param leadSide "left" for a right-handed golfer
   * @param positions from SwingPhases.detect (P1 is the reference for "vs address")
   * @returns {values: [per-frame values | null], address: frame index, scale, tempo: {back, down,
   *   ratio} | null}
   */
  function compute(frames, aspect, leadSide, positions) {
    const s = sides(leadSide);
    const raw = frames.map(f => frameValues(f, aspect, s));
    const find = key => (positions || []).find(p => p.key === key);
    const p1 = find("p1"), p4 = find("p4"), p7 = find("p7");
    const ai = p1 ? p1.index : raw.findIndex(v => v);
    const base = ai >= 0 ? raw[ai] : null;
    const scale = scaleAt(frames[ai], aspect);
    const top = p4 ? p4.index : null;
    const pelvisTurn = ai >= 0 ? turns(raw.map(v => v && v.hipWidth), ai, top) : [];
    const shoulderTurn = ai >= 0 ? turns(raw.map(v => v && v.shoulderWidth), ai, top) : [];

    // Turns and drift relative to address.
    const values = raw.map((v, i) => {
      if (!v || !base) return v;
      const r = { ...v, pelvisTurn: pelvisTurn[i], shoulderTurn: shoulderTurn[i] };
      if (r.pelvisTurn != null && r.shoulderTurn != null) r.separation = r.shoulderTurn - r.pelvisTurn;
      // The 3D estimate's depth only holds up while the shoulders face the camera.
      if (r.shoulderTurn == null || Math.abs(r.shoulderTurn) > FORWARD_MAX_TURN) r.spineForward = null;
      r.spineTiltChange = v.spineTilt - base.spineTilt;
      if (scale) {
        const inch = scale * INCHES_PER_METRE;
        r.headSway = s.m * (v.head.x - base.head.x) * inch;
        r.headRise = -(v.head.y - base.head.y) * inch;
        r.hipSway = s.m * (v.hips.x - base.hips.x) * inch;
      }
      return r;
    });

    // Tempo: back from takeaway to the top, down from the top to impact. 3:1 is the classic ratio.
    let tempo = null;
    const takeaway = positions && positions.takeaway;
    if (takeaway && p4 && p7 && p4.t > takeaway.t && p7.t > p4.t) {
      const back = p4.t - takeaway.t, down = p7.t - p4.t;
      tempo = { back, down, ratio: back / down };
    }

    return { values, address: ai, scale, tempo };
  }

  // ---- Down the line ----
  //
  // From behind the hands, looking at the target: the picture shows the golfer side-on, so bend,
  // hips, head and hands moving toward or away from the ball are seen directly, not estimated.
  // Signs: + toward the ball, above, steeper; distances in inches (scaled as above).

  const HANDS = [I.L_WRIST, I.R_WRIST, I.L_INDEX, I.R_INDEX];
  const SHAFT_SEEN = 0.35;

  /** The hands: wrists and index fingers, weighted by how sure MediaPipe is of each. */
  function handsAt(lm, aspect) {
    let sw = 0, sx = 0, sy = 0;
    for (const k of HANDS) {
      const w = Math.max(lm[k * 3 + 2], 1e-3);
      sw += w; sx += lm[k * 3] * w; sy += lm[k * 3 + 1] * w;
    }
    return { x: sx / sw * aspect, y: sy / sw };
  }

  /** How steeply a shaft at `deg` (in the picture) runs down toward the ball, in degrees. */
  function steepness(deg, m) {
    let dx = Math.cos(deg / DEG), dy = Math.sin(deg / DEG);
    if (m * dx < 0) { dx = -dx; dy = -dy; }
    return Math.atan2(dy, m * dx) * DEG;
  }

  /**
   * @param frames down-the-line pose frames [{t, lm, w, club}]
   * @param aspect picture width / height
   * @param address frame index of address (P1) in these frames
   * @param ball optional {x, y} where the server found the ball, to tell which way it is
   * @returns {values: [per-frame values | null], address, scale} | null
   */
  function computeDTL(frames, aspect, address, ball) {
    const f0 = frames[address];
    if (!f0 || !f0.lm) return null;
    const px = (lm, i) => ({ x: lm[i * 3] * aspect, y: lm[i * 3 + 1] });
    const hipsOf = lm => mid(px(lm, I.L_HIP), px(lm, I.R_HIP));
    // Which way the ball is: +1 when it's to the picture's right (a right-hander filmed from behind).
    const hip0 = hipsOf(f0.lm);
    const m = Math.sign((ball ? ball.x * aspect : px(f0.lm, I.NOSE).x) - hip0.x) || 1;
    const scale = scaleAt(f0, aspect);
    const inch = scale ? scale * INCHES_PER_METRE : null;

    const raw = frames.map(f => {
      if (!f.lm) return null;
      const hips = hipsOf(f.lm), sh = mid(px(f.lm, I.L_SHOULDER), px(f.lm, I.R_SHOULDER));
      const ears = [I.NOSE, I.L_EAR, I.R_EAR].map(i => px(f.lm, i));
      return {
        hips, sh, hands: handsAt(f.lm, aspect),
        head: { x: ears.reduce((a, p) => a + p.x, 0) / 3, y: ears.reduce((a, p) => a + p.y, 0) / 3 },
        // Forward bend: the spine's lean from upright toward the ball.
        bend: Math.atan2(m * (sh.x - hips.x), hips.y - sh.y) * DEG,
        steep: f.club && f.club[1] >= SHAFT_SEEN ? steepness(f.club[0], m) : null,
      };
    });
    const base = raw[address];
    // The plane line: the shaft at address, through the hands.
    const plane = f0.club && f0.club[1] >= SHAFT_SEEN ? { at: base.hands, a: f0.club[0] / DEG } : null;

    const values = raw.map(v => {
      if (!v) return null;
      const r = { bend: v.bend, bendChange: v.bend - base.bend };
      if (v.steep != null && base.steep != null) r.shaftPlane = v.steep - base.steep;
      if (inch) {
        r.hipDepth = m * (v.hips.x - base.hips.x) * inch;
        r.headDepth = m * (v.head.x - base.head.x) * inch;
        r.handHeight = (v.sh.y - v.hands.y) * inch;
        r.handDepth = m * (v.sh.x - v.hands.x) * inch;
        if (plane) {
          // Straight-line distance from the hands up (+) or down to the plane line.
          const lineY = plane.at.y + Math.tan(plane.a) * (v.hands.x - plane.at.x);
          r.handsPlane = (lineY - v.hands.y) * Math.abs(Math.cos(plane.a)) * inch;
        }
      }
      return r;
    });
    return { values, address, scale };
  }

  const api = { compute, computeDTL };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingMetrics = api;
})(typeof window !== "undefined" ? window : globalThis);
