// Club check: quick club points (grip, hosel, clubhead) that feed the nightly club model
//
// Allows the owner to rapidly inspect and confirm/adjust club points on high-value frames,
// retrained by the night worker (docs/night-worker.md).
//
// Pure helpers are exported for node testing (tests/clubcheck.test.js).

(function () {
  const HOSEL_SHARE = 0.93;

  /** Generates model's guess {grip, hosel, head} in upright picture shares (0..1).
   * head = frame.clubhead when confidence >= 0.25 (else null).
   * grip = midpoint of index knuckles (19, 20) or wrists (15, 16).
   * hosel = HOSEL_SHARE (0.93) of the way from grip to head.
   * Null head -> all three null. */
  function guess(frame, pose) {
    if (!frame) return { grip: null, hosel: null, head: null };
    const headArr = frame.clubhead;
    const headConf = headArr && headArr.length >= 3 ? headArr[2] : 0;
    if (!headArr || headConf < 0.25) {
      return { grip: null, hosel: null, head: null };
    }
    const head = { x: Number(headArr[0].toFixed(6)), y: Number(headArr[1].toFixed(6)) };

    // Grip from index knuckles (19, 20) or wrists (15, 16)
    let grip = null;
    const lm = frame.lm;
    if (Array.isArray(lm) && lm.length >= 63) {
      const lx = lm[19 * 3], ly = lm[19 * 3 + 1];
      const rx = lm[20 * 3], ry = lm[20 * 3 + 1];
      if (lx != null && rx != null && (lx !== 0 || ly !== 0) && (rx !== 0 || ry !== 0)) {
        grip = { x: Number(((lx + rx) / 2).toFixed(6)), y: Number(((ly + ry) / 2).toFixed(6)) };
      }
    }
    if (!grip && Array.isArray(lm) && lm.length >= 51) {
      const lx = lm[15 * 3], ly = lm[15 * 3 + 1];
      const rx = lm[16 * 3], ry = lm[16 * 3 + 1];
      if (lx != null && rx != null && (lx !== 0 || ly !== 0) && (rx !== 0 || ry !== 0)) {
        grip = { x: Number(((lx + rx) / 2).toFixed(6)), y: Number(((ly + ry) / 2).toFixed(6)) };
      }
    }
    // Also support array of landmark objects: lm[19] = { x, y }
    if (!grip && Array.isArray(lm) && lm[19] && lm[20] && typeof lm[19] === "object") {
      grip = { x: Number(((lm[19].x + lm[20].x) / 2).toFixed(6)), y: Number(((lm[19].y + lm[20].y) / 2).toFixed(6)) };
    } else if (!grip && Array.isArray(lm) && lm[15] && lm[16] && typeof lm[15] === "object") {
      grip = { x: Number(((lm[15].x + lm[16].x) / 2).toFixed(6)), y: Number(((lm[15].y + lm[16].y) / 2).toFixed(6)) };
    }

    if (!grip) {
      return { grip: null, hosel: null, head: null };
    }

    const hosel = {
      x: Number((grip.x + (head.x - grip.x) * HOSEL_SHARE).toFixed(6)),
      y: Number((grip.y + (head.y - grip.y) * HOSEL_SHARE).toFixed(6)),
    };

    return { grip, hosel, head };
  }

  /** Helper to get P1, P4, P8 key timestamps for a clip/pose. */
  function getP1P4P8(c, pose) {
    if (pose?.positions?.p4 != null && pose?.positions?.p8 != null) {
      return { p1: pose.positions.p1, p4: pose.positions.p4, p8: pose.positions.p8 };
    }
    if (pose?.positionTimes?.p4 != null && pose?.positionTimes?.p8 != null) {
      return { p1: pose.positionTimes.p1, p4: pose.positionTimes.p4, p8: pose.positionTimes.p8 };
    }
    if (c?.positions?.p4 != null && c?.positions?.p8 != null) {
      return { p1: c.positions.p1, p4: c.positions.p4, p8: c.positions.p8 };
    }
    const imp = pose?.impact ?? c?.strike ?? c?.quality?.positions?.p7;
    if (imp != null) {
      return { p1: imp - 1.2, p4: imp - 0.35, p8: imp + 0.15 };
    }
    const frames = pose?.frames || [];
    if (frames.length > 0) {
      const mid = frames[Math.floor(frames.length / 2)].t;
      return { p1: frames[0].t, p4: mid - 0.2, p8: mid + 0.2 };
    }
    return null;
  }

  /** Selects a queue of frames to check, prioritizing swings without any club points yet,
   * spread over clubs and days. In each swing: opts.perSwing (default 4) frames between P4 and P8,
   * spread >= 0.03s apart, preferring frames where clubhead was missing/low confidence, then address.
   * Total capped at opts.max (default 40). */
  function queue(clips, poses, labeled, opts = {}) {
    const perSwing = opts.perSwing ?? 4;
    const max = opts.max ?? 40;
    const minGap = opts.minGap ?? 0.03;

    // Build label lookup
    const labelMap = new Map();
    if (Array.isArray(labeled)) {
      for (const item of labeled) {
        if (!item) continue;
        const name = typeof item.clip === "string" ? item.clip : item.clip?.name;
        if (name) labelMap.set(name, item);
      }
    } else if (labeled && typeof labeled === "object") {
      for (const [k, v] of Object.entries(labeled)) {
        labelMap.set(k, v);
      }
    }

    function swingHasClubPoints(clipName, partnerName) {
      for (const name of [clipName, partnerName].filter(Boolean)) {
        const doc = labelMap.get(name);
        if (!doc) continue;
        if (doc.frames) {
          for (const pts of Object.values(doc.frames)) {
            if (pts && (pts.grip || pts.hosel || pts.head)) return true;
          }
        }
        if (doc.pointFrames > 0) return true;
      }
      return false;
    }

    function frameHasClubPoints(clipName, t) {
      const doc = labelMap.get(clipName);
      if (!doc || !doc.frames) return false;
      for (const [key, pts] of Object.entries(doc.frames)) {
        if (Math.abs(parseFloat(key) - t) < 0.002) {
          if (pts && (pts.grip || pts.hosel || pts.head)) return true;
        }
      }
      return false;
    }

    function getPose(clipName) {
      if (typeof poses === "function") return poses(clipName);
      if (poses && typeof poses === "object") return poses[clipName] || null;
      return null;
    }

    // Filter valid clips (non-excluded)
    const validClips = (clips || []).filter(c => !c.excluded);

    // Group swings into unlabeled (no club points yet) vs labeled
    const unlabeledSwings = [];
    const labeledSwings = [];

    for (const c of validClips) {
      if (swingHasClubPoints(c.name, c.partner)) {
        labeledSwings.push(c);
      } else {
        unlabeledSwings.push(c);
      }
    }

    // Balance swings across (day, club)
    function balanceSwings(list) {
      const groups = new Map();
      for (const c of list) {
        const day = c.recorded ? c.recorded.slice(0, 10) : "";
        const club = c.shot?.club || c.club || "";
        const key = `${day}_${club}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(c);
      }
      const out = [];
      let round = 0;
      let added = true;
      while (added) {
        added = false;
        for (const bucket of groups.values()) {
          if (round < bucket.length) {
            out.push(bucket[round]);
            added = true;
          }
        }
        round++;
      }
      return out;
    }

    const orderedSwings = [...balanceSwings(unlabeledSwings), ...balanceSwings(labeledSwings)];

    const outQueue = [];

    for (const c of orderedSwings) {
      if (outQueue.length >= max) break;
      const p = getPose(c.name);
      if (!p || !p.frames || p.frames.length === 0) continue;

      const pTimes = getP1P4P8(c, p);
      if (!pTimes) continue;

      // Downswing frames between P4 and P8
      const downCandidates = p.frames.filter(f => f.t >= pTimes.p4 && f.t <= pTimes.p8 && !frameHasClubPoints(c.name, f.t));

      // Prefer missing clubhead or low confidence
      downCandidates.sort((a, b) => {
        const ca = a.clubhead && a.clubhead.length >= 3 ? a.clubhead[2] : 0;
        const cb = b.clubhead && b.clubhead.length >= 3 ? b.clubhead[2] : 0;
        return ca - cb;
      });

      const pickedForSwing = [];

      // Pick downswing frames spaced >= minGap apart (up to perSwing - 1 to leave room for address)
      const targetDown = Math.max(1, perSwing - 1);
      for (const f of downCandidates) {
        if (pickedForSwing.length >= targetDown) break;
        if (pickedForSwing.every(x => Math.abs(x.t - f.t) >= minGap)) {
          pickedForSwing.push(f);
        }
      }

      // Address frame
      if (pTimes.p1 != null) {
        // Find frame closest to p1
        let bestAddr = null;
        let bestDist = Infinity;
        for (const f of p.frames) {
          const d = Math.abs(f.t - pTimes.p1);
          if (d < bestDist && !frameHasClubPoints(c.name, f.t)) {
            bestDist = d;
            bestAddr = f;
          }
        }
        if (bestAddr && pickedForSwing.every(x => Math.abs(x.t - bestAddr.t) >= minGap)) {
          pickedForSwing.push(bestAddr);
        }
      }

      // If still room, pick additional downswing frames
      for (const f of downCandidates) {
        if (pickedForSwing.length >= perSwing) break;
        if (pickedForSwing.every(x => Math.abs(x.t - f.t) >= minGap)) {
          pickedForSwing.push(f);
        }
      }

      // Sort picked frames by time
      pickedForSwing.sort((a, b) => a.t - b.t);

      for (const f of pickedForSwing) {
        if (outQueue.length >= max) break;
        outQueue.push({
          clip: c.name,
          clipObj: c,
          t: f.t,
          frame: f,
          pose: p,
        });
      }
    }

    return outQueue;
  }

  /** Merges grip, hosel, head points into a pass-1 label doc for frame t.toFixed(6).
   * Preserves existing body landmarks and all other doc fields without change. */
  function merge(doc, t, points) {
    const updated = doc ? JSON.parse(JSON.stringify(doc)) : { schema: 1, frames: {} };
    if (!updated.frames) updated.frames = {};
    const key = Number(t).toFixed(6);
    const existing = updated.frames[key] || {};
    const frameObj = { ...existing };

    if (points) {
      if (points.grip !== undefined) frameObj.grip = points.grip;
      if (points.hosel !== undefined) frameObj.hosel = points.hosel;
      if (points.head !== undefined) frameObj.head = points.head;
    }

    updated.frames[key] = frameObj;
    return updated;
  }

  const ClubCheck = {
    HOSEL_SHARE,
    guess,
    queue,
    merge,
  };

  if (typeof window !== "undefined") {
    window.ClubCheck = ClubCheck;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = ClubCheck;
  }
})();
