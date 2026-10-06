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
      if (opts.cantTell) {
        if (typeof opts.cantTell.has === "function" && opts.cantTell.has(c.name)) return false;
        if (Array.isArray(opts.cantTell) && opts.cantTell.includes(c.name)) return false;
      }
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

  // The clubhead's direction (the owner's ask, Oct 6: "where it stops going back and changes direction").
  // Its angle round the shoulders' middle, turning one way going back and the other coming down; velocity
  // over +-DIR_SPAN frames. On the 28 P4-check labels the turn found this way sat a median 8 ms from the
  // label (bias -3 ms); the shaft's own angle did worse (17 ms, +17 late).
  const DIR_SPAN = 2, DIR_MAX_GAP = 0.06, DIR_RUN = 4, CLUBHEAD_CONF = 0.25;

  /**
   * Which way the clubhead moves, per pose frame, and where it turns.
   *
   * @param {Array} poseFrames Frame objects from /api/pose/<clip> { t, lm, clubhead }
   * @param {number} from Window start in seconds (the backswing's direction is read before it)
   * @param {number} to Window end in seconds
   * @returns {{frames: Array<{t: number, dir: "back"|"down"|null, speed: number|null}>, turn: number|null}}
   *   turn: the last frame going back before it comes down for DIR_RUN frames in a row, in the window.
   */
  function direction(poseFrames, from, to) {
    const out = { frames: [], turn: null };
    if (!Array.isArray(poseFrames) || !poseFrames.length) return out;
    const pts = [];
    for (const f of [...poseFrames].sort((a, b) => a.t - b.t)) {
      const lm = f.lm, ch = f.clubhead;
      if (!Array.isArray(lm) || lm.length < 39 || !Array.isArray(ch)) continue;
      if (ch[0] == null || ch[1] == null || (ch.length > 2 && ch[2] < CLUBHEAD_CONF)) continue;
      const cx = (lm[33] + lm[36]) / 2, cy = (lm[34] + lm[37]) / 2;
      pts.push({ t: f.t, a: Math.atan2(ch[1] - cy, ch[0] - cx) });
    }
    if (pts.length < 2 * DIR_SPAN + 5) return out;
    for (let i = 1; i < pts.length; i++) {   // unwrapped
      pts[i].a = pts[i - 1].a + ((((pts[i].a - pts[i - 1].a) + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
    }
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i - DIR_SPAN], b = pts[i + DIR_SPAN];
      pts[i].v = a && b && b.t - a.t > 0 && b.t - a.t < DIR_MAX_GAP ? (b.a - a.a) / (b.t - a.t) : null;
    }
    // Going back turns the way it did over the 0.2 s before the window (the backswing).
    const back = pts.filter(q => q.v != null && q.t >= from - 0.2 && q.t < from).map(q => q.v).sort((x, y) => x - y);
    if (back.length < 5) return out;
    const sign = back[Math.floor(back.length / 2)] > 0 ? 1 : -1;
    let run = 0;
    for (let i = 0; i < pts.length; i++) {
      const q = pts[i];
      if (q.t < from - 0.0005 || q.t > to + 0.0005) continue;
      const dir = q.v == null ? null : q.v * sign > 0 ? "back" : "down";
      out.frames.push({ t: q.t, dir, speed: q.v == null ? null : Math.abs(q.v) });
      if (dir === "down") {
        run++;
        if (run === DIR_RUN && out.turn == null) {
          const before = out.frames[out.frames.length - 1 - DIR_RUN];
          if (before && before.dir === "back") out.turn = before.t;
        }
      } else run = 0;
    }
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

  /**
   * Resolves the server's P4 key position timestamp.
   * Checks night pass's recorded server times, clip/pose positions,
   * Summary.positionTimes if available, or falls back to impact - 0.35s.
   */
  function getServerP4(c, pose, night, otherPose, leadSide = "left") {
    const nightEntry = getNightEntry(night, c);
    if (nightEntry) {
      const angle = c.angle === "dtl" ? "dtl" : "face";
      const a = nightEntry[angle] || (angle === "face" ? nightEntry.face : nightEntry.dtl);
      if (a?.t?.p4 != null) return a.t.p4;
      if (a?.t?.top != null) return a.t.top;
    }
    if (c?.positions?.p4 != null) return c.positions.p4;
    if (pose?.positions?.p4 != null) return pose.positions.p4;
    if (pose?.positionTimes?.p4 != null) return pose.positionTimes.p4;

    const summaryApi = (typeof SwingSummary !== "undefined" ? SwingSummary : (typeof Summary !== "undefined" ? Summary : null));
    if (summaryApi && pose && pose.frames && pose.frames.length) {
      try {
        const w = pose.video?.videoWidth || 1080;
        const h = pose.video?.videoHeight || 1920;
        const aspect = pose.aspect ?? (h ? w / h : 1);
        const input = {
          name: c.name,
          strike: c.strike ?? null,
          angle: c.angle || pose.angle || "face",
          aspect,
          frames: pose.frames,
          impact: pose.impact ?? null,
          ball: pose.ball ?? null,
          drill: c.drill ?? null,
          clubOnset: pose.clubOnset ?? null,
        };
        let otherInput = null;
        if (otherPose && otherPose.frames && c.partner) {
          const ow = otherPose.video?.videoWidth || 1080;
          const oh = otherPose.video?.videoHeight || 1920;
          const oAspect = otherPose.aspect ?? (oh ? ow / oh : 1);
          otherInput = {
            name: c.partner,
            strike: c.partnerStrike ?? null,
            angle: otherPose.angle || (c.angle === "dtl" ? "face" : "dtl"),
            aspect: oAspect,
            frames: otherPose.frames,
            impact: otherPose.impact ?? null,
            ball: otherPose.ball ?? null,
            drill: null,
            clubOnset: otherPose.clubOnset ?? null,
          };
        }
        if (typeof summaryApi.positionTimes === "function") {
          const pt = summaryApi.positionTimes(input, otherInput, leadSide);
          if (pt?.main?.times?.p4 != null) return pt.main.times.p4;
        }
        if (typeof summaryApi.analyze === "function") {
          const an = summaryApi.analyze(input, otherInput, leadSide);
          const p4 = an.positions?.find(p => p.key === "p4" || p.key === "top");
          if (p4?.t != null) return p4.t;
        }
      } catch (e) {}
    }

    const imp = pose?.impact ?? c?.strike ?? c?.quality?.positions?.p7;
    if (imp != null) return Number((imp - 0.35).toFixed(6));

    if (pose?.frames?.length) {
      const midIdx = Math.floor(pose.frames.length / 2);
      return Number(pose.frames[midIdx].t.toFixed(6));
    }
    return 0.5;
  }

  function getFps(clipName) {
    if (typeof fpsFromName === "function") {
      const rate = fpsFromName(clipName);
      if (rate > 0) return rate;
    }
    const m = (clipName || "").match(/_\d+x\d+_(\d+)fps/);
    return m ? Number(m[1]) : 240;
  }

  // --- Browser UI Controller ---

  let isOpen = false;
  let currentQueue = [];
  let currentIndex = 0;
  let currentClip = null;
  let currentPose = null;
  let currentWindow = null;
  let currentDirection = null;
  let currentFrameIndex = 0;
  let posesCache = {};
  let labelsSummary = [];
  let nightData = null;
  let allClips = [];

  function setStatusMessage(msg, isErr) {
    if (typeof document === "undefined") return;
    const el = document.getElementById("p4c-status");
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = isErr ? "var(--warn, #ef4444)" : "var(--muted, #9ca3af)";
  }

  function getTodayLabeledCount() {
    const today = new Date().toISOString().slice(0, 10);
    const key = `p4check_labeled_${today}`;
    try {
      const list = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(list) ? list.length : 0;
    } catch {
      return 0;
    }
  }

  function updateCounter() {
    if (typeof document === "undefined") return;
    const counterEl = document.getElementById("p4c-counter");
    if (!counterEl) return;

    let totalHand = 0;
    for (const c of allClips) {
      if (c.angle === "dtl") continue;
      if (hasHandP4(c.name, labelsSummary)) totalHand++;
    }

    const todayCount = getTodayLabeledCount();
    const left = Math.max(0, currentQueue.length - currentIndex);
    counterEl.textContent = `Face-on hand P4 labels: ${totalHand} · today ${todayCount} · ${left} left`;
  }

  /** The direction strip: one bar per frame, blue going back, amber coming down, height = how fast;
   * the turn marked, the current frame a white line. */
  function drawDirection(dir, currentT, windowFrom, windowTo) {
    const canvas = document.getElementById("p4c-chart");
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round((rect.width > 0 ? rect.width : 300) * dpr), h = Math.round(60 * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    const turnBtn = document.getElementById("p4c-turn");
    if (turnBtn) turnBtn.disabled = !(dir && dir.turn != null);
    if (!dir || !dir.frames.length || windowTo <= windowFrom) {
      ctx.fillStyle = "#6b7280";
      ctx.font = `${11 * dpr}px sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("Clubhead not tracked here", w / 2, h / 2);
      return;
    }
    const padX = 8 * dpr, padY = 6 * dpr, gw = w - 2 * padX, gh = h - 2 * padY;
    const x = t => padX + ((t - windowFrom) / (windowTo - windowFrom)) * gw;
    const max = Math.max(...dir.frames.map(f => f.speed || 0)) || 1;
    const barW = Math.max(1, gw / Math.max(1, dir.frames.length) - 1 * dpr);
    for (const f of dir.frames) {
      const hh = f.speed == null ? gh * 0.15 : Math.max(gh * 0.15, (f.speed / max) * gh);
      ctx.fillStyle = f.dir === "back" ? "#60a5fa" : f.dir === "down" ? "#f59e0b" : "#4b5563";
      ctx.fillRect(x(f.t) - barW / 2, h - padY - hh, barW, hh);
    }
    if (dir.turn != null) {
      ctx.strokeStyle = "#e5e7eb";
      ctx.setLineDash([3 * dpr, 2 * dpr]);
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.moveTo(x(dir.turn), 2 * dpr);
      ctx.lineTo(x(dir.turn), h - 2 * dpr);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#e5e7eb";
      ctx.font = `${10 * dpr}px sans-serif`;
      ctx.textAlign = "left";
      ctx.fillText("turn", x(dir.turn) + 3 * dpr, 11 * dpr);
    }
    const curX = x(currentT);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(curX, 2 * dpr);
    ctx.lineTo(curX, h - 2 * dpr);
    ctx.stroke();
  }

  function goToTurn() {
    if (!currentDirection || currentDirection.turn == null || !currentWindow) return;
    let best = 0;
    for (let i = 1; i < currentWindow.length; i++) {
      if (Math.abs(currentWindow[i] - currentDirection.turn) < Math.abs(currentWindow[best] - currentDirection.turn)) best = i;
    }
    renderFrame(best);
  }

  function renderFrame(fIdx) {
    if (!currentWindow || !currentWindow.length) return;
    currentFrameIndex = Math.max(0, Math.min(currentWindow.length - 1, fIdx));

    const t = currentWindow[currentFrameIndex];
    const img = document.getElementById("p4c-img");
    const timeEl = document.getElementById("p4c-frame-time");
    const numEl = document.getElementById("p4c-frame-num");

    if (timeEl) timeEl.textContent = `· ${t.toFixed(3)} s`;
    if (numEl) numEl.textContent = `Frame ${currentFrameIndex + 1} / ${currentWindow.length}`;

    if (img && currentClip) {
      img.src = `/api/still/${encodeURIComponent(currentClip.name)}?t=${t.toFixed(6)}`;
    }

    drawDirection(currentDirection, t, currentWindow.from, currentWindow.to);

    // Prefetch neighbours: -4, -2, -1, 1, 2, 4
    for (const delta of [-4, -2, -1, 1, 2, 4]) {
      const targetIdx = currentFrameIndex + delta;
      if (targetIdx >= 0 && targetIdx < currentWindow.length && currentClip) {
        const preT = currentWindow[targetIdx];
        const preImg = new Image();
        preImg.src = `/api/still/${encodeURIComponent(currentClip.name)}?t=${preT.toFixed(6)}`;
      }
    }
  }

  function handleChartClick(e) {
    if (!currentWindow || !currentWindow.length) return;
    const canvas = document.getElementById("p4c-chart");
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const relX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const targetT = currentWindow.from + relX * (currentWindow.to - currentWindow.from);

    let closestIdx = 0;
    let minDiff = Infinity;
    for (let i = 0; i < currentWindow.length; i++) {
      const diff = Math.abs(currentWindow[i] - targetT);
      if (diff < minDiff) {
        minDiff = diff;
        closestIdx = i;
      }
    }
    renderFrame(closestIdx);
  }

  async function showSwing(idx) {
    currentIndex = idx;
    updateCounter();

    if (typeof document === "undefined") return;
    const titleEl = document.getElementById("p4c-swing-title");
    const timeEl = document.getElementById("p4c-frame-time");
    const numEl = document.getElementById("p4c-frame-num");
    const img = document.getElementById("p4c-img");
    const chart = document.getElementById("p4c-chart");

    if (idx >= currentQueue.length) {
      if (titleEl) titleEl.textContent = "All swings checked!";
      if (timeEl) timeEl.textContent = "";
      if (numEl) numEl.textContent = "";
      if (img) img.src = "";
      if (chart) {
        const ctx = chart.getContext("2d");
        ctx.clearRect(0, 0, chart.width, chart.height);
      }
      setStatusMessage(`Done for now! Marked ${getTodayLabeledCount()} hand P4 labels today.`, false);
      return;
    }

    const c = currentQueue[idx];
    currentClip = c;

    const club = c.shot?.club || c.club;
    const clubStr = (typeof clubName === "function" && club) ? clubName(club) : (club || "Club");
    const whenStr = (typeof fmtWhen === "function" && c.recorded) ? fmtWhen(c.recorded) : (c.recorded ? c.recorded.slice(0, 10) : "");
    const angleStr = c.angle === "dtl" ? "down the line" : "face-on";
    if (titleEl) titleEl.textContent = `${clubStr} · ${whenStr} (${angleStr})`;

    setStatusMessage("Loading pose...", false);

    let pose = posesCache[c.name];
    if (!pose) {
      try {
        const r = await fetch(`/api/pose/${encodeURIComponent(c.name)}`);
        if (r.ok) {
          pose = await r.json();
          posesCache[c.name] = pose;
        }
      } catch (e) {}
    }
    currentPose = pose;

    let partnerPose = null;
    if (c.partner) {
      partnerPose = posesCache[c.partner];
      if (!partnerPose) {
        try {
          const r = await fetch(`/api/pose/${encodeURIComponent(c.partner)}`);
          if (r.ok) {
            partnerPose = await r.json();
            posesCache[c.partner] = partnerPose;
          }
        } catch (e) {}
      }
    }

    let lead = "left";
    try {
      if (localStorage.getItem("lead") === "right") lead = "right";
    } catch {}

    const serverP4 = getServerP4(c, pose, nightData, partnerPose, lead);
    const fps = getFps(c.name);

    currentWindow = p4Window(serverP4, fps);
    currentDirection = direction(pose?.frames, currentWindow.from, currentWindow.to);

    // Prompt rule: "the first frame shown is the window's start, not the server's P4."
    currentFrameIndex = 0;
    setStatusMessage("", false);

    renderFrame(currentFrameIndex);

    // Prefetch first frame of next swing if available
    if (idx + 1 < currentQueue.length) {
      const nextC = currentQueue[idx + 1];
      if (!posesCache[nextC.name]) {
        fetch(`/api/pose/${encodeURIComponent(nextC.name)}`)
          .then(r => r.ok ? r.json() : null)
          .then(p => { if (p) posesCache[nextC.name] = p; })
          .catch(() => {});
      }
    }
  }

  async function saveTop() {
    if (!isOpen || currentIndex >= currentQueue.length) return;
    const c = currentClip;
    if (!c || !currentWindow || currentFrameIndex == null) return;
    const chosenT = currentWindow[currentFrameIndex];

    setStatusMessage("Saving...", false);

    try {
      let doc = null;
      const res = await fetch(`/api/labels/${encodeURIComponent(c.name)}?pass=1`, { cache: "no-store" });
      if (res.ok) {
        doc = await res.json();
      } else if (res.status === 404) {
        const partner = c.partner ? allClips.find(x => x.name === c.partner) : null;
        doc = {
          schema: 1,
          clip: {
            name: c.name,
            angle: c.angle || "face",
            strike: c.strike ?? null,
          },
          partner: partner ? {
            name: partner.name,
            angle: partner.angle || (c.angle === "dtl" ? "face" : "dtl"),
            strike: partner.strike ?? null,
          } : null,
          events: {},
          picked: {},
          frames: {},
        };
      } else {
        throw new Error(`Failed to load labels: ${res.statusText}`);
      }

      const updatedDoc = mergeP4(doc, chosenT);

      const postRes = await fetch(`/api/labels/${encodeURIComponent(c.name)}?pass=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatedDoc),
      });

      if (!postRes.ok) {
        const err = await postRes.json().catch(() => ({}));
        throw new Error(err.detail || postRes.statusText);
      }

      const today = new Date().toISOString().slice(0, 10);
      const key = `p4check_labeled_${today}`;
      let stored = [];
      try { stored = JSON.parse(localStorage.getItem(key) || "[]"); } catch {}
      if (!stored.includes(c.name)) {
        stored.push(c.name);
        try { localStorage.setItem(key, JSON.stringify(stored)); } catch {}
      }

      let row = labelsSummary.find(r => (r.clip || r.name) === c.name);
      if (row) {
        if (!row.events) row.events = 0;
        if (row.missing) row.missing = row.missing.filter(m => m !== "p4");
        row.quick = { ...(row.quick || {}), p4: "p4check" };
      } else {
        labelsSummary.push({
          clip: c.name,
          pass: 1,
          quick: { p4: "p4check" },
          events: { p4: chosenT }
        });
      }

      setStatusMessage("Saved!", false);
      currentIndex++;
      showSwing(currentIndex);
    } catch (err) {
      setStatusMessage(`Error saving: ${err.message}`, true);
    }
  }

  function cantTell() {
    if (!isOpen || currentIndex >= currentQueue.length) return;
    const c = currentClip;
    if (c) {
      const today = new Date().toISOString().slice(0, 10);
      const key = `p4check_cant_tell_${today}`;
      let stored = [];
      try { stored = JSON.parse(localStorage.getItem(key) || "[]"); } catch {}
      if (!stored.includes(c.name)) {
        stored.push(c.name);
        try { localStorage.setItem(key, JSON.stringify(stored)); } catch {}
      }
    }
    currentIndex++;
    showSwing(currentIndex);
  }

  function skip() {
    if (!isOpen || currentIndex >= currentQueue.length) return;
    currentIndex++;
    showSwing(currentIndex);
  }

  async function loadQueue() {
    setStatusMessage("Loading swings...", false);
    try {
      const [clipsRes, summaryRes, nightRes] = await Promise.all([
        (typeof clips !== "undefined" && Array.isArray(clips) && clips.length)
          ? Promise.resolve(clips)
          : fetch("/api/clips").then(r => r.json()),
        fetch("/api/labels/summary", { cache: "no-store" }).then(r => r.json()).catch(() => ({ clips: [] })),
        (typeof night !== "undefined" && night)
          ? Promise.resolve(night)
          : fetch("/api/night", { cache: "no-store" }).then(r => r.json()).catch(() => null),
      ]);

      allClips = Array.isArray(clipsRes) ? clipsRes : [];
      labelsSummary = summaryRes?.clips || (Array.isArray(summaryRes) ? summaryRes : []);
      nightData = nightRes;

      const today = new Date().toISOString().slice(0, 10);
      const cantTellKey = `p4check_cant_tell_${today}`;
      let cantTellList = [];
      try { cantTellList = JSON.parse(localStorage.getItem(cantTellKey) || "[]"); } catch {}
      const cantTellSet = new Set(cantTellList);

      currentQueue = queue(allClips, labelsSummary, nightData, { max: 30, cantTell: cantTellSet });
      currentIndex = 0;
      setStatusMessage("", false);
      showSwing(0);
    } catch (err) {
      setStatusMessage(`Failed to load swings: ${err.message}`, true);
    }
  }

  function open() {
    isOpen = true;
    if (typeof showView === "function") showView("p4check");
    if (typeof renderList === "function") renderList();
    const box = document.getElementById("p4check");
    if (box) {
      box.scrollTop = 0;
      if (window.innerWidth < 900) box.scrollIntoView();
    }
    loadQueue();
  }

  function close() {
    isOpen = false;
    if (typeof closeTrendView === "function") {
      closeTrendView();
    } else {
      const box = document.getElementById("p4check");
      if (box) box.hidden = true;
    }
  }

  function handleKeyDown(e) {
    if (!isOpen) return;
    const box = document.getElementById("p4check");
    if (!box || box.hidden) return;

    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    if (e.key === "ArrowLeft") {
      e.preventDefault();
      const step = e.shiftKey ? -4 : -1;
      renderFrame(currentFrameIndex + step);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      const step = e.shiftKey ? 4 : 1;
      renderFrame(currentFrameIndex + step);
    } else if (e.key === "Enter") {
      e.preventDefault();
      saveTop();
    } else if (e.key === "c" || e.key === "C") {
      e.preventDefault();
      cantTell();
    } else if (e.key === "s" || e.key === "S") {
      e.preventDefault();
      skip();
    } else if (e.key === "t" || e.key === "T") {
      e.preventDefault();
      goToTurn();
    }
  }

  if (typeof document !== "undefined") {
    const toolsBtn = document.getElementById("p4check-btn");
    if (toolsBtn) {
      toolsBtn.onclick = () => {
        const box = document.getElementById("p4check");
        if (box && box.hidden) open();
        else close();
      };
    }

    const closeBtn = document.getElementById("p4c-close");
    if (closeBtn) closeBtn.onclick = () => close();

    const saveBtn = document.getElementById("p4c-save-btn");
    if (saveBtn) saveBtn.onclick = () => saveTop();

    const cantBtn = document.getElementById("p4c-cant-btn");
    if (cantBtn) cantBtn.onclick = () => cantTell();

    const skipBtn = document.getElementById("p4c-skip-btn");
    if (skipBtn) skipBtn.onclick = () => skip();

    const prev4Btn = document.getElementById("p4c-prev4");
    if (prev4Btn) prev4Btn.onclick = () => renderFrame(currentFrameIndex - 4);

    const prev1Btn = document.getElementById("p4c-prev1");
    if (prev1Btn) prev1Btn.onclick = () => renderFrame(currentFrameIndex - 1);

    const next1Btn = document.getElementById("p4c-next1");
    if (next1Btn) next1Btn.onclick = () => renderFrame(currentFrameIndex + 1);

    const next4Btn = document.getElementById("p4c-next4");
    if (next4Btn) next4Btn.onclick = () => renderFrame(currentFrameIndex + 4);

    const chartCanvas = document.getElementById("p4c-chart");
    if (chartCanvas) {
      chartCanvas.addEventListener("pointerdown", handleChartClick);
    }
    const turnBtn = document.getElementById("p4c-turn");
    if (turnBtn) turnBtn.onclick = goToTurn;

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", () => {
      if (isOpen && currentWindow && currentDirection) {
        drawDirection(currentDirection, currentWindow[currentFrameIndex], currentWindow.from, currentWindow.to);
      }
    });
  }

  const SwingP4Check = {
    queue,
    window: p4Window,
    p4Window,
    direction,
    mergeP4,
    hasHandP4,
    getP4Disagreement,
    getServerP4,
    getFps,
    open,
    close,
    showSwing,
    renderFrame,
    saveTop,
    cantTell,
    skip
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = SwingP4Check;
  } else {
    root.SwingP4Check = SwingP4Check;
  }
})(typeof self !== "undefined" ? self : this);
