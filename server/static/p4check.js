// P4 check: quick hand labels for the top of the backswing
//
// Allows the owner to step through frames around the top and mark P4
// without seeing either analysis's answer.
//
// Pure helpers are exported for node testing (tests/p4check.test.js)
// and browser use (window.SwingP4Check).

(function (root) {
  /** Mulberry32 PRNG from a 32-bit integer seed. */
  function mulberry32(a) {
    return function () {
      let t = (a += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Hashes string to a 32-bit unsigned integer. */
  function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(31, h) + str.charCodeAt(i) | 0;
    }
    return h >>> 0;
  }

  function makePrng(seed) {
    if (seed == null) {
      const today = new Date().toISOString().slice(0, 10);
      return mulberry32(hashString(today));
    }
    if (typeof seed === "string") {
      return mulberry32(hashString(seed));
    }
    return mulberry32(Number(seed) >>> 0);
  }

  function getLabelDoc(labels, clipName) {
    if (!labels) return null;
    if (typeof labels.get === "function") return labels.get(clipName) || null;
    if (Array.isArray(labels)) {
      return labels.find(l => {
        if (!l) return false;
        if (typeof l.clip === "string") return l.clip === clipName;
        if (l.clip && l.clip.name) return l.clip.name === clipName;
        if (l.name) return l.name === clipName;
        return false;
      }) || null;
    }
    if (typeof labels === "object") return labels[clipName] || null;
    return null;
  }

  /**
   * Returns true if the clip already has a hand-labeled P4.
   * A pick between the two analyses (events.p4 set, but p4 only in picked)
   * is NOT a hand label.
   */
  function hasHandP4(clipName, labels) {
    const doc = getLabelDoc(labels, clipName);
    if (!doc) return false;
    if (doc.events && doc.events.p4 != null) {
      if (doc.picked && doc.picked.p4 != null && (!doc.quick || doc.quick.p4 !== "p4check")) {
        return false; // pick-only, not hand label
      }
      return true;
    }
    if (doc.missing && Array.isArray(doc.missing)) {
      const present = !doc.missing.includes("p4");
      if (present && doc.picked && Array.isArray(doc.picked) && doc.picked.includes("p4")) {
        return false;
      }
      return present;
    }
    return false;
  }

  function getNightEntry(night, c) {
    if (!night) return null;
    const swings = night.swings || night;
    if (!swings || typeof swings !== "object") return null;
    if (swings[c.name]) return swings[c.name];
    if (c.partner && swings[c.partner]) return swings[c.partner];
    const stem = c.name.replace(/_(face|dtl)_/, "_");
    if (swings[stem]) return swings[stem];
    if (c.partner) {
      const pStem = c.partner.replace(/_(face|dtl)_/, "_");
      if (swings[pStem]) return swings[pStem];
    }
    return null;
  }

  /** Returns P4 ms difference between night pass and server, or null. */
  function getP4Disagreement(c, night) {
    const entry = getNightEntry(night, c);
    if (!entry) return null;
    const angle = c.angle === "dtl" ? "dtl" : "face";
    const a = entry[angle] || (angle === "face" ? entry.face : entry.dtl);
    if (!a || !a.ms || a.ms.p4 == null) return null;
    return a.ms.p4;
  }

  /**
   * Selects queue of face-on clips to label (down the line only for swings with no face-on clip).
   *
   * @param {Array} clips All clips from /api/clips
   * @param {Object|Map|Array} labels Known labels map or list
   * @param {Object} night Night comparisons from /api/night
   * @param {Object} [opts] {max: 30, seed}
   * @returns {Array} Ordered queue of clip objects to check
   */
  function queue(clips, labels, night, opts = {}) {
    const max = opts.max ?? 30;
    const prng = makePrng(opts.seed);

    const valid = (clips || []).filter(c => {
      if (!c || c.excluded || c.drill) return false;
      if (c.pose !== "done") return false;
      return true;
    });

    const clipNames = new Set(valid.map(c => c.name));

    // Choose representative clip per swing:
    // Face-on preferred; DTL only for swings with no face-on clip
    const candidates = [];
    for (const c of valid) {
      if (c.angle === "dtl") {
        const hasFacePartner = c.partner && clipNames.has(c.partner);
        if (hasFacePartner) continue; // face-on partner represents this swing
      }
      if (hasHandP4(c.name, labels)) continue;
      candidates.push(c);
    }

    if (!candidates.length) return [];

    // Classify into disagreements (|ms| >= 12.5) vs random pool
    const disagreements = [];
    const rest = [];

    for (const c of candidates) {
      const ms = getP4Disagreement(c, night);
      if (ms != null && Math.abs(ms) >= 12.5) {
        disagreements.push({ c, ms: Math.abs(ms) });
      } else {
        rest.push(c);
      }
    }

    // Sort disagreements by usefulness (|ms| descending) and spread across (day, club)
    function bucketRoundRobin(list, comparator) {
      const buckets = new Map();
      for (const item of list) {
        const c = item.c || item;
        const day = c.recorded ? c.recorded.slice(0, 10) : "";
        const club = c.shot?.club || c.club || "";
        const key = `${day}_${club}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(item);
      }
      // Sort within each bucket
      for (const b of buckets.values()) {
        if (comparator) b.sort(comparator);
      }
      // Shuffle bucket order using PRNG for fair spread
      const bucketArray = Array.from(buckets.values());
      for (let i = bucketArray.length - 1; i > 0; i--) {
        const j = Math.floor(prng() * (i + 1));
        const temp = bucketArray[i];
        bucketArray[i] = bucketArray[j];
        bucketArray[j] = temp;
      }
      const out = [];
      let round = 0, added = true;
      while (added) {
        added = false;
        for (const b of bucketArray) {
          if (round < b.length) {
            out.push(b[round].c || b[round]);
            added = true;
          }
        }
        round++;
      }
      return out;
    }

    const orderedDisagreements = bucketRoundRobin(
      disagreements,
      (a, b) => b.ms - a.ms
    );

    // Random pool: rest, plus disagreements shuffled so they can also serve as random choices
    const randomItems = [...rest];
    // Shuffle with seeded PRNG inside buckets
    const orderedRandom = bucketRoundRobin(randomItems, () => prng() - 0.5);

    // Mix 2 random : 1 disagreement
    const out = [];
    const used = new Set();
    let rIdx = 0, dIdx = 0;

    while (out.length < max && (rIdx < orderedRandom.length || dIdx < orderedDisagreements.length)) {
      const step = out.length % 3;
      if (step === 2) {
        // Disagreement slot
        let picked = null;
        while (dIdx < orderedDisagreements.length) {
          const cand = orderedDisagreements[dIdx++];
          if (!used.has(cand.name)) {
            picked = cand;
            break;
          }
        }
        // Fall back to random if no disagreements left
        if (!picked) {
          while (rIdx < orderedRandom.length) {
            const cand = orderedRandom[rIdx++];
            if (!used.has(cand.name)) {
              picked = cand;
              break;
            }
          }
        }
        if (picked) {
          used.add(picked.name);
          out.push(picked);
        } else {
          break;
        }
      } else {
        // Random slot
        let picked = null;
        while (rIdx < orderedRandom.length) {
          const cand = orderedRandom[rIdx++];
          if (!used.has(cand.name)) {
            picked = cand;
            break;
          }
        }
        // Fall back to disagreements if random exhausted
        if (!picked) {
          while (dIdx < orderedDisagreements.length) {
            const cand = orderedDisagreements[dIdx++];
            if (!used.has(cand.name)) {
              picked = cand;
              break;
            }
          }
        }
        if (picked) {
          used.add(picked.name);
          out.push(picked);
        } else {
          break;
        }
      }
    }

    return out;
  }

  /**
   * Frames to show around server's P4: from 0.15 s before to 0.10 s after.
   * Returns array of frame times with .from, .to, .start bounds.
   *
   * @param {number} serverP4 Server's estimated P4 timestamp in seconds
   * @param {number} [fps=240] Video frame rate
   * @returns {Array<number>}
   */
  function p4Window(serverP4, fps = 240) {
    const rate = fps > 0 ? fps : 240;
    const nBefore = Math.round(0.15 * rate);
    const nAfter = Math.round(0.10 * rate);

    const frames = [];
    for (let k = -nBefore; k <= nAfter; k++) {
      frames.push(Number((serverP4 + k / rate).toFixed(6)));
    }

    const from = frames[0];
    const to = frames[frames.length - 1];

    frames.from = from;
    frames.to = to;
    frames.start = from;
    frames.frames = frames;

    return frames;
  }

  /**
   * Per-frame lead wrist and clubhead speed over the window.
   *
   * @param {Array} poseFrames Frame objects from /api/pose/<clip> { t, lm, clubhead }
   * @param {number} from Window start in seconds
   * @param {number} to Window end in seconds
   * @param {string} [leadSide="left"] "left" for right-handed golfer, "right" for left-handed
   * @returns {Array<{t: number, wrist: number|null, clubhead: number|null}>}
   */
  function traces(poseFrames, from, to, leadSide = "left") {
    if (!Array.isArray(poseFrames) || !poseFrames.length) {
      const empty = [];
      empty.t = []; empty.wrist = []; empty.clubhead = [];
      return empty;
    }

    const sorted = [...poseFrames].sort((a, b) => a.t - b.t);
    const wristIdx = leadSide === "right" ? 16 : 15;

    function getWristPoint(f) {
      if (!f || !f.lm) return null;
      if (Array.isArray(f.lm)) {
        if (f.lm.length >= (wristIdx + 1) * 3) {
          const x = f.lm[wristIdx * 3], y = f.lm[wristIdx * 3 + 1];
          if (x != null && y != null && (x !== 0 || y !== 0)) return { x, y };
        }
        if (f.lm[wristIdx] && typeof f.lm[wristIdx] === "object") {
          const pt = f.lm[wristIdx];
          if (pt.x != null && pt.y != null) return { x: pt.x, y: pt.y };
        }
      }
      return null;
    }

    function getClubheadPoint(f) {
      if (!f || !f.clubhead) return null;
      if (Array.isArray(f.clubhead)) {
        const x = f.clubhead[0], y = f.clubhead[1];
        const conf = f.clubhead.length >= 3 ? f.clubhead[2] : 1;
        if (x != null && y != null && conf >= 0.25) return { x, y };
      } else if (typeof f.clubhead === "object") {
        const x = f.clubhead.x, y = f.clubhead.y;
        const conf = f.clubhead.conf ?? 1;
        if (x != null && y != null && conf >= 0.25) return { x, y };
      }
      return null;
    }

    // Compute raw derivatives
    function computeSpeeds(extractor) {
      const n = sorted.length;
      const speeds = new Array(n).fill(null);
      for (let i = 0; i < n; i++) {
        const p = extractor(sorted[i]);
        if (!p) continue;

        // Find nearest valid neighbors within 0.05s
        let prev = null, prevT = null;
        for (let j = i - 1; j >= 0 && sorted[i].t - sorted[j].t <= 0.05; j--) {
          const pt = extractor(sorted[j]);
          if (pt) { prev = pt; prevT = sorted[j].t; break; }
        }

        let next = null, nextT = null;
        for (let j = i + 1; j < n && sorted[j].t - sorted[i].t <= 0.05; j++) {
          const pt = extractor(sorted[j]);
          if (pt) { next = pt; nextT = sorted[j].t; break; }
        }

        if (prev && next) {
          const dt = nextT - prevT;
          if (dt > 0) speeds[i] = Math.hypot(next.x - prev.x, next.y - prev.y) / dt;
        } else if (next) {
          const dt = nextT - sorted[i].t;
          if (dt > 0) speeds[i] = Math.hypot(next.x - p.x, next.y - p.y) / dt;
        } else if (prev) {
          const dt = sorted[i].t - prevT;
          if (dt > 0) speeds[i] = Math.hypot(p.x - prev.x, p.y - prev.y) / dt;
        }
      }

      // Light 3-point smoothing [1, 2, 1] / 4 where values exist; preserve null gaps
      const smoothed = new Array(n).fill(null);
      for (let i = 0; i < n; i++) {
        if (speeds[i] == null) continue;
        let sum = speeds[i] * 2, count = 2;
        if (i > 0 && speeds[i - 1] != null) { sum += speeds[i - 1]; count += 1; }
        if (i + 1 < n && speeds[i + 1] != null) { sum += speeds[i + 1]; count += 1; }
        smoothed[i] = Number((sum / count).toFixed(4));
      }
      return smoothed;
    }

    const wristSpeeds = computeSpeeds(getWristPoint);
    const headSpeeds = computeSpeeds(getClubheadPoint);

    const out = [];
    for (let i = 0; i < sorted.length; i++) {
      const t = sorted[i].t;
      if (from != null && t < from - 0.0005) continue;
      if (to != null && t > to + 0.0005) continue;
      const w = wristSpeeds[i];
      const h = headSpeeds[i];
      out.push({
        t,
        wrist: w,
        clubhead: h,
        wristSpeed: w,
        clubheadSpeed: h
      });
    }

    out.t = out.map(p => p.t);
    out.wrist = out.map(p => p.wrist);
    out.clubhead = out.map(p => p.clubhead);

    return out;
  }

  /**
   * Merges hand P4 label into a label document.
   * Sets events.p4 = t, quick.p4 = "p4check", and removes picked.p4 if present.
   * Nothing else changes.
   *
   * @param {Object} doc Existing label document (or new doc)
   * @param {number} t Timestamp of P4 in seconds
   * @returns {Object} Updated label document
   */
  function mergeP4(doc, t) {
    const updated = { ...(doc || { schema: 1 }) };
    updated.events = { ...(doc?.events || {}) };
    updated.events.p4 = Number(Number(t).toFixed(6));
    updated.quick = { ...(doc?.quick || {}), p4: "p4check" };
    if (updated.picked && updated.picked.p4 !== undefined) {
      const picked = { ...updated.picked };
      delete picked.p4;
      updated.picked = picked;
    }
    return updated;
  }

  const SwingP4Check = {
    queue,
    window: p4Window,
    p4Window,
    traces,
    mergeP4,
    hasHandP4,
    getP4Disagreement
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = SwingP4Check;
  } else {
    root.SwingP4Check = SwingP4Check;
  }
})(typeof self !== "undefined" ? self : this);
