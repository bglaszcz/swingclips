// Club check: quick club points (grip, hosel, clubhead) that feed the nightly club model
//
// Allows the owner to rapidly inspect and confirm/adjust club points on high-value frames,
// retrained by the night worker (docs/night-worker.md).
//
// Pure helpers are exported for node testing (tests/clubcheck.test.js).

(function () {
  const HOSEL_SHARE = 0.93;
  // The zoom's magnification of the clip's own pixels.
  const ZOOM_MAG = 3.5;

  /** Generates model's guess {grip, hosel, head} in upright picture shares (0..1).
   * head = frame.clubhead when confidence >= 0.25 (else null).
   * grip = midpoint of index knuckles (19, 20) or wrists (15, 16).
   * hosel = HOSEL_SHARE (0.93) of the way from grip to head.
   * Null head -> all three null. */
  /** The upright picture's height over its width, from a clip name's WxH and the pose's rotation. */
  function uprightAspect(name, rotation) {
    const m = /_(\d+)x(\d+)_/.exec(name || "");
    if (!m) return null;
    const w = Number(m[1]), h = Number(m[2]);
    return Math.abs(rotation || 0) % 180 === 90 ? w / h : h / w;
  }

  /**
   * The model's guess for a frame: the clubhead where the club model found it; where it didn't (most
   * downswing frames), along the server's shaft line from the hands, `clubLength` long (as the swing
   * page draws the shaft), marked `estimated`. `aspect`: uprightAspect, needed for the estimate.
   */
  function guess(frame, pose, aspect = null) {
    if (!frame) return { grip: null, hosel: null, head: null };
    const headArr = frame.clubhead;
    const headConf = headArr && headArr.length >= 3 ? headArr[2] : 0;
    let head = headArr && headConf >= 0.25 ? { x: Number(headArr[0].toFixed(6)), y: Number(headArr[1].toFixed(6)) } : null;
    const shaft = frame.club;
    // Any tracked shaft angle will do (in the downswing it's mostly a low-confidence prediction): it's
    // only where the owner starts moving the clubhead from, and said so.
    const canEstimate = !head && aspect && pose && pose.clubLength && Array.isArray(shaft) && shaft[0] != null;
    if (!head && !canEstimate) {
      return { grip: null, hosel: null, head: null };
    }

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
    let estimated = false;
    if (!head) {
      const a = shaft[0] * Math.PI / 180;
      const x = grip.x + pose.clubLength * aspect * Math.cos(a), y = grip.y + pose.clubLength * Math.sin(a);
      if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return { grip: null, hosel: null, head: null };
      head = { x: Number(x.toFixed(6)), y: Number(y.toFixed(6)) };
      estimated = true;
    }

    const hosel = {
      x: Number((grip.x + (head.x - grip.x) * HOSEL_SHARE).toFixed(6)),
      y: Number((grip.y + (head.y - grip.y) * HOSEL_SHARE).toFixed(6)),
    };

    return estimated ? { grip, hosel, head, estimated } : { grip, hosel, head };
  }

  /**
   * Helper to get key timestamps (takeaway, p1, p2, p3, p4, p7, p8) for a clip/pose.
   * Computes them using SwingSummary.positionTimes when available (as p4check does),
   * or falls back to pose/clip positions or impact-based offsets.
   */
  function getKeyPositions(c, pose, otherPose = null, leadSide = "left") {
    let pos = null;
    if (pose?.positions) pos = { ...pose.positions };
    else if (pose?.positionTimes) pos = { ...pose.positionTimes };
    else if (c?.positions) pos = { ...c.positions };

    // If pos already contains complete key positions (e.g. test mock), use it directly
    if (pos && pos.takeaway != null && pos.p2 != null && pos.p3 != null && pos.p4 != null && pos.p8 != null) {
      return {
        p1: pos.p1 ?? null,
        takeaway: pos.takeaway,
        p2: pos.p2,
        p3: pos.p3,
        p4: pos.p4,
        p7: pos.p7 ?? null,
        p8: pos.p8,
      };
    }

    // Try computing with SwingSummary.positionTimes (same as p4check.js getServerP4)
    const summaryApi = (typeof SwingSummary !== "undefined" ? SwingSummary : (typeof Summary !== "undefined" ? Summary : null));
    if (summaryApi && pose && Array.isArray(pose.frames) && pose.frames.length) {
      try {
        const w = pose.video?.videoWidth || 1080;
        const h = pose.video?.videoHeight || 1920;
        const aspect = pose.aspect ?? (h ? w / h : 1);
        const input = {
          name: c?.name || "",
          strike: c?.strike ?? null,
          angle: c?.angle || pose.angle || "face",
          aspect,
          frames: pose.frames,
          impact: pose.impact ?? null,
          ball: pose.ball ?? null,
          drill: c?.drill ?? null,
          clubOnset: pose.clubOnset ?? null,
        };
        let otherInput = null;
        if (otherPose && Array.isArray(otherPose.frames) && c?.partner) {
          const ow = otherPose.video?.videoWidth || 1080;
          const oh = otherPose.video?.videoHeight || 1920;
          const oAspect = otherPose.aspect ?? (oh ? ow / oh : 1);
          otherInput = {
            name: c.partner,
            strike: c.partnerStrike ?? null,
            angle: otherPose.angle || (c?.angle === "dtl" ? "face" : "dtl"),
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
          if (pt?.main?.times && pt.main.times.p4 != null) {
            const t = pt.main.times;
            const refImp = t.p7 ?? (t.p4 != null ? t.p4 + 0.35 : null);
            return {
              p1: t.p1 ?? pos?.p1 ?? (refImp != null ? Number((refImp - 1.2).toFixed(6)) : null),
              takeaway: t.takeaway ?? pos?.takeaway ?? (refImp != null ? Number((refImp - 0.95).toFixed(6)) : null),
              p2: t.p2 ?? pos?.p2 ?? (refImp != null ? Number((refImp - 0.75).toFixed(6)) : null),
              p3: t.p3 ?? pos?.p3 ?? (refImp != null ? Number((refImp - 0.55).toFixed(6)) : null),
              p4: t.p4 ?? pos?.p4 ?? (refImp != null ? Number((refImp - 0.35).toFixed(6)) : null),
              p7: t.p7 ?? pos?.p7 ?? (refImp != null ? Number(refImp.toFixed(6)) : null),
              p8: t.p8 ?? pos?.p8 ?? (refImp != null ? Number((refImp + 0.15).toFixed(6)) : null),
            };
          }
        }
      } catch (err) {
        // fall back below
      }
    }

    // Impact-based fallback
    const imp = pose?.impact ?? c?.strike ?? c?.quality?.positions?.p7 ?? pos?.p7 ?? (pos?.p4 != null ? pos.p4 + 0.35 : null);
    if (imp != null) {
      return {
        p1: pos?.p1 ?? Number((imp - 1.2).toFixed(6)),
        takeaway: pos?.takeaway ?? Number((imp - 0.95).toFixed(6)),
        p2: pos?.p2 ?? Number((imp - 0.75).toFixed(6)),
        p3: pos?.p3 ?? Number((imp - 0.55).toFixed(6)),
        p4: pos?.p4 ?? Number((imp - 0.35).toFixed(6)),
        p7: pos?.p7 ?? Number(imp.toFixed(6)),
        p8: pos?.p8 ?? Number((imp + 0.15).toFixed(6)),
      };
    }

    // Mid-frame fallback
    const frames = pose?.frames || [];
    if (frames.length > 0) {
      const mid = frames[Math.floor(frames.length / 2)].t;
      return {
        p1: pos?.p1 ?? frames[0].t,
        takeaway: pos?.takeaway ?? Number((mid - 0.65).toFixed(6)),
        p2: pos?.p2 ?? Number((mid - 0.50).toFixed(6)),
        p3: pos?.p3 ?? Number((mid - 0.35).toFixed(6)),
        p4: pos?.p4 ?? Number((mid - 0.20).toFixed(6)),
        p7: pos?.p7 ?? Number(mid.toFixed(6)),
        p8: pos?.p8 ?? Number((mid + 0.20).toFixed(6)),
      };
    }

    return null;
  }

  function getP1P4P8(c, pose, otherPose = null) {
    return getKeyPositions(c, pose, otherPose);
  }

  /** Balances swings across (day, club) buckets, round-robin. */
  function balanceSwings(list) {
    const groups = new Map();
    for (const c of (list || [])) {
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

  /** Selects a queue of frames to check, prioritizing swings without club points yet
   * (and swings with no club points in takeaway..P3 before those that do), spread over clubs and days.
   * In each swing: opts.perSwing (default 5) frames: 2 backswing frames between takeaway and P3
   * (one within +-0.03s of P2, preferring low clubhead confidence), 2 downswing frames between P4 and P8,
   * then address. Spread >= 0.03s apart. Total capped at opts.max (default 40). */
  function queue(clips, poses, labeled, opts = {}) {
    const perSwing = opts.perSwing ?? 5;
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

    function swingHasBackswingClubPoints(clipName, partnerName, pTimes) {
      if (!pTimes || pTimes.takeaway == null || pTimes.p3 == null) return false;
      const tStart = Math.min(pTimes.takeaway, pTimes.p3) - 0.01;
      const tEnd = Math.max(pTimes.takeaway, pTimes.p3) + 0.01;
      for (const name of [clipName, partnerName].filter(Boolean)) {
        const doc = labelMap.get(name);
        if (!doc || !doc.frames) continue;
        for (const [key, pts] of Object.entries(doc.frames)) {
          if (pts && (pts.grip || pts.hosel || pts.head || pts.allHidden)) {
            const t = parseFloat(key);
            if (t >= tStart && t <= tEnd) return true;
          }
        }
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

    // Group swings into:
    // 1. unlabeledSwings: swings without any club points anywhere
    // 2. noBackswingSwings: swings with club points, but none in takeaway..P3
    // 3. hasBackswingSwings: swings that already have club points in takeaway..P3
    const unlabeledSwings = [];
    const noBackswingSwings = [];
    const hasBackswingSwings = [];

    for (const c of validClips) {
      if (!swingHasClubPoints(c.name, c.partner)) {
        unlabeledSwings.push(c);
      } else {
        const p = getPose(c.name);
        const otherP = c.partner ? getPose(c.partner) : null;
        const pTimes = p ? getKeyPositions(c, p, otherP) : null;
        if (swingHasBackswingClubPoints(c.name, c.partner, pTimes)) {
          hasBackswingSwings.push(c);
        } else {
          noBackswingSwings.push(c);
        }
      }
    }

    const orderedSwings = [
      ...balanceSwings(unlabeledSwings),
      ...balanceSwings(noBackswingSwings),
      ...balanceSwings(hasBackswingSwings),
    ];

    const outQueue = [];

    for (const c of orderedSwings) {
      if (outQueue.length >= max) break;
      const p = getPose(c.name);
      if (!p || !p.frames || p.frames.length === 0) continue;

      const otherP = c.partner ? getPose(c.partner) : null;
      const pTimes = getKeyPositions(c, p, otherP);
      if (!pTimes) continue;

      const conf = (f) => (f.clubhead && f.clubhead.length >= 3 ? f.clubhead[2] : 0);

      const pickedForSwing = [];

      // 1. Backswing frames between takeaway and P3 (prefer 2, one within +-0.03s of P2, prefer low clubhead confidence)
      const tk = pTimes.takeaway != null ? pTimes.takeaway : (pTimes.p1 != null ? pTimes.p1 + 0.2 : 0);
      const p3 = pTimes.p3 != null ? pTimes.p3 : (pTimes.p4 != null ? pTimes.p4 - 0.2 : 0);
      const backCandidates = p.frames.filter(f => f.t >= tk && f.t <= p3 && !frameHasClubPoints(c.name, f.t));

      const targetBack = Math.min(2, Math.max(0, perSwing - 3));

      if (targetBack >= 1 && pTimes.p2 != null) {
        const p2Candidates = backCandidates
          .filter(f => Math.abs(f.t - pTimes.p2) <= 0.03)
          .sort((a, b) => conf(a) - conf(b));
        if (p2Candidates.length > 0) {
          pickedForSwing.push(p2Candidates[0]);
        }
      }

      backCandidates.sort((a, b) => conf(a) - conf(b));
      for (const f of backCandidates) {
        if (pickedForSwing.length >= targetBack) break;
        if (pickedForSwing.every(x => Math.abs(x.t - f.t) >= minGap)) {
          pickedForSwing.push(f);
        }
      }

      // 2. Downswing frames between P4 and P8 (prefer 2, prefer low clubhead confidence)
      const downCandidates = p.frames.filter(f => f.t >= pTimes.p4 && f.t <= pTimes.p8 && !frameHasClubPoints(c.name, f.t));
      downCandidates.sort((a, b) => conf(a) - conf(b));

      const targetDown = Math.min(2, Math.max(0, perSwing - pickedForSwing.length - 1));
      let downCount = 0;
      for (const f of downCandidates) {
        if (downCount >= targetDown) break;
        if (pickedForSwing.every(x => Math.abs(x.t - f.t) >= minGap)) {
          pickedForSwing.push(f);
          downCount++;
        }
      }

      // 3. Address frame near P1
      if (pTimes.p1 != null && pickedForSwing.length < perSwing) {
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

      // 4. If still room up to perSwing, pick additional downswing frames, then backswing
      for (const f of downCandidates) {
        if (pickedForSwing.length >= perSwing) break;
        if (pickedForSwing.every(x => Math.abs(x.t - f.t) >= minGap)) {
          pickedForSwing.push(f);
        }
      }
      for (const f of backCandidates) {
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
          pTimes,
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

  // ---- UI Controller ----
  let isOpen = false;
  let currentQueue = [];
  let currentIndex = 0;
  let currentPoints = { grip: null, hosel: null, head: null };
  let selectedPoint = "head";
  let hoselManuallyMoved = false;
  const posesCache = {};
  let isDragging = false;
  let hitSelected = false;
  let dragMoved = false;
  let downClientPos = { x: 0, y: 0 };
  let statusTimer = null;

  function getTodayKey() {
    return "clubcheck_today_" + new Date().toLocaleDateString("en-CA");
  }

  function getCheckedToday() {
    try {
      return parseInt(localStorage.getItem(getTodayKey()) || "0", 10);
    } catch {
      return 0;
    }
  }

  function incrementCheckedToday() {
    try {
      const val = getCheckedToday() + 1;
      localStorage.setItem(getTodayKey(), String(val));
      return val;
    } catch {
      return 0;
    }
  }

  function setStatusMessage(msg, isError = false) {
    if (typeof document === "undefined") return;
    const el = document.getElementById("cc-status");
    if (!el) return;
    el.textContent = msg || "";
    el.classList.toggle("failed", !!isError);
    if (msg && !isError) {
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 4000);
    }
  }

  function updateCounter() {
    if (typeof document === "undefined") return;
    const el = document.getElementById("cc-counter");
    if (!el) return;
    const checked = getCheckedToday();
    const total = currentQueue.length;
    const left = Math.max(0, total - currentIndex);
    el.textContent = `${checked} frame${checked === 1 ? "" : "s"} checked today · ${left} left`;
  }

  function renderPointsUI() {
    if (typeof document === "undefined") return;
    const pts = ["grip", "hosel", "head"];
    for (const key of pts) {
      const btn = document.getElementById(`cc-pt-${key}`);
      const stat = document.getElementById(`cc-stat-${key}`);
      if (!btn) continue;
      btn.classList.toggle("on", selectedPoint === key);
      const pt = currentPoints ? currentPoints[key] : null;
      if (stat) {
        if (!pt) {
          stat.textContent = "(not set)";
        } else if (pt.hidden) {
          stat.textContent = "(can't see)";
        } else {
          stat.textContent = pt.blur ? "(blur)" : `(${pt.x.toFixed(2)}, ${pt.y.toFixed(2)})`;
        }
      }
    }
  }

  function drawOverlay() {
    if (typeof document === "undefined") return;
    const canvas = document.getElementById("cc-overlay");
    const img = document.getElementById("cc-img");
    if (!canvas || !img || !img.naturalWidth || !img.clientWidth) return;

    const dpr = window.devicePixelRatio || 1;
    const w = img.clientWidth;
    const h = img.clientHeight;

    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
    }

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!currentPoints) return;
    const { grip, hosel, head } = currentPoints;

    const hasGrip = grip && !grip.hidden && grip.x != null;
    const hasHosel = hosel && !hosel.hidden && hosel.x != null;
    const hasHead = head && !head.hidden && head.x != null;

    const cw = canvas.width;
    const ch = canvas.height;

    // Draw connecting shaft line
    if (hasGrip && hasHead) {
      ctx.save();
      // Drop shadow for high visibility on light & dark backgrounds
      ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
      ctx.lineWidth = 4 * dpr;
      ctx.beginPath();
      ctx.moveTo(grip.x * cw, grip.y * ch);
      if (hasHosel) ctx.lineTo(hosel.x * cw, hosel.y * ch);
      ctx.lineTo(head.x * cw, head.y * ch);
      ctx.stroke();

      ctx.strokeStyle = "#facc15";
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.moveTo(grip.x * cw, grip.y * ch);
      if (hasHosel) ctx.lineTo(hosel.x * cw, hosel.y * ch);
      ctx.lineTo(head.x * cw, head.y * ch);
      ctx.stroke();
      ctx.restore();
    }

    // Draw markers
    const markers = [
      { key: "grip", label: "Grip", pt: grip, color: "#22d3ee", r: 4 },
      { key: "hosel", label: "Hosel", pt: hosel, color: "#f59e0b", r: 3.5 },
      { key: "head", label: "Clubhead", pt: head, color: "#4ade80", r: 4 },
    ];

    for (const m of markers) {
      const { key, label, pt, color, r } = m;
      if (!pt || pt.hidden || pt.x == null || pt.y == null) continue;
      const px = pt.x * cw;
      const py = pt.y * ch;
      const isSelected = selectedPoint === key;

      ctx.save();

      // Outer ring for selected point
      if (isSelected) {
        ctx.beginPath();
        ctx.arc(px, py, 8 * dpr, 0, Math.PI * 2);
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2.5 * dpr;
        ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
        ctx.shadowBlur = 4 * dpr;
        ctx.stroke();
      }

      // Blurred indicator ring
      if (pt.blur) {
        ctx.beginPath();
        ctx.arc(px, py, 6.5 * dpr, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.setLineDash([3 * dpr, 3 * dpr]);
        ctx.lineWidth = 1.5 * dpr;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Marker circle
      ctx.beginPath();
      ctx.arc(px, py, r * dpr, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.shadowColor = "rgba(0, 0, 0, 0.8)";
      ctx.shadowBlur = 3 * dpr;
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5 * dpr;
      ctx.stroke();

      // Center dot
      ctx.beginPath();
      ctx.arc(px, py, 1.2 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();

      // Text tag: the selected point's only (three tags crowd the hosel and clubhead, a few px apart)
      if (!isSelected) { ctx.restore(); continue; }
      const tagText = label + (pt.blur ? " (blur)" : "");
      ctx.font = `bold ${Math.round(11 * dpr)}px system-ui, -apple-system, sans-serif`;
      ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
      ctx.shadowBlur = 3 * dpr;
      ctx.fillStyle = "#ffffff";
      ctx.fillText(tagText, px + 10 * dpr, py + 4 * dpr);

      ctx.restore();
    }
  }

  function drawZoom() {
    if (typeof document === "undefined") return;
    const zoomCanvas = document.getElementById("cc-zoom");
    const img = document.getElementById("cc-img");
    const zoomWrap = document.getElementById("cc-zoom-wrap");
    const zoomLabel = document.getElementById("cc-zoom-label");
    if (!zoomCanvas || !img || !img.naturalWidth) return;

    const zw = zoomCanvas.width;
    const zh = zoomCanvas.height;
    const zctx = zoomCanvas.getContext("2d");
    zctx.clearRect(0, 0, zw, zh);

    const pt = currentPoints ? currentPoints[selectedPoint] : null;

    if (!pt || pt.hidden || pt.x == null || pt.y == null) {
      zctx.fillStyle = "#111827";
      zctx.fillRect(0, 0, zw, zh);
      zctx.fillStyle = "#9ca3af";
      zctx.font = "12px system-ui, sans-serif";
      zctx.textAlign = "center";
      zctx.fillText(pt?.hidden ? "Point marked hidden" : "No point placed", zw / 2, zh / 2);
      if (zoomLabel) {
        const names = { grip: "Grip", hosel: "Hosel", head: "Clubhead" };
        zoomLabel.textContent = names[selectedPoint] || "";
        zoomLabel.style.color = "#9ca3af";
      }
      return;
    }

    // Flip zoom inset to top-left if selected point is in upper right quadrant
    if (zoomWrap) {
      const isUpperRight = pt.x > 0.55 && pt.y < 0.45;
      zoomWrap.classList.toggle("flip", isUpperRight);
    }

    const cx = pt.x * img.naturalWidth;
    const cy = pt.y * img.naturalHeight;
    const mag = ZOOM_MAG;
    const srcW = zw / mag;
    const srcH = zh / mag;
    const srcX = cx - srcW / 2;
    const srcY = cy - srcH / 2;

    zctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, zw, zh);

    // Reticle crosshair
    zctx.save();
    zctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    zctx.lineWidth = 1;
    const midX = zw / 2;
    const midY = zh / 2;
    const gap = 4;
    const arm = 22;

    zctx.beginPath();
    zctx.moveTo(midX - arm, midY);
    zctx.lineTo(midX - gap, midY);
    zctx.moveTo(midX + gap, midY);
    zctx.lineTo(midX + arm, midY);

    zctx.moveTo(midX, midY - arm);
    zctx.lineTo(midX, midY - gap);
    zctx.moveTo(midX, midY + gap);
    zctx.lineTo(midX, midY + arm);
    zctx.stroke();

    const ptColors = { grip: "#22d3ee", hosel: "#f59e0b", head: "#4ade80" };
    zctx.beginPath();
    zctx.arc(midX, midY, 1.5, 0, Math.PI * 2);
    zctx.fillStyle = ptColors[selectedPoint] || "#fff";
    zctx.fill();
    zctx.restore();

    if (zoomLabel) {
      const names = { grip: "Grip", hosel: "Hosel", head: "Clubhead" };
      zoomLabel.textContent = `${names[selectedPoint]} (3.5×)`;
      zoomLabel.style.color = ptColors[selectedPoint] || "#fff";
    }
  }

  function updatePointPosition(key, { x, y }) {
    if (!currentPoints) currentPoints = { grip: null, hosel: null, head: null };
    const prev = currentPoints[key] || {};
    currentPoints[key] = { x, y, blur: prev.blur || false };

    if (key === "hosel") {
      hoselManuallyMoved = true;
    } else if (!hoselManuallyMoved && currentPoints.grip && currentPoints.head && !currentPoints.grip.hidden && !currentPoints.head.hidden) {
      const gx = currentPoints.grip.x, gy = currentPoints.grip.y;
      const hx = currentPoints.head.x, hy = currentPoints.head.y;
      currentPoints.hosel = {
        x: Number((gx + (hx - gx) * HOSEL_SHARE).toFixed(6)),
        y: Number((gy + (hy - gy) * HOSEL_SHARE).toFixed(6)),
        blur: currentPoints.hosel?.blur || false,
      };
    }
  }

  function cycleNextPoint() {
    const order = { grip: "hosel", hosel: "head", head: "grip" };
    selectedPoint = order[selectedPoint] || "grip";
  }

  function selectPoint(key) {
    if (["grip", "hosel", "head"].includes(key)) {
      selectedPoint = key;
      if (key === "hosel") hoselManuallyMoved = true;
      renderPointsUI();
      drawOverlay();
      drawZoom();
    }
  }

  function toggleBlur() {
    if (!currentPoints) return;
    const pt = currentPoints[selectedPoint];
    if (pt && !pt.hidden) {
      pt.blur = !pt.blur;
      renderPointsUI();
      drawOverlay();
      drawZoom();
    }
  }

  function toggleHidden() {
    if (!currentPoints) return;
    const pt = currentPoints[selectedPoint];
    if (pt && pt.hidden) {
      currentPoints[selectedPoint] = null;
    } else {
      currentPoints[selectedPoint] = { hidden: true };
      cycleNextPoint();
    }
    renderPointsUI();
    drawOverlay();
    drawZoom();
  }

  function markAllHidden() {
    if (!currentPoints) currentPoints = {};
    currentPoints.grip = { hidden: true };
    currentPoints.hosel = { hidden: true };
    currentPoints.head = { hidden: true };
    renderPointsUI();
    drawOverlay();
    drawZoom();
  }

  function showFrame(idx) {
    currentIndex = idx;
    updateCounter();

    if (typeof document === "undefined") return;
    const banner = document.getElementById("cc-banner");
    const titleEl = document.getElementById("cc-swing-title");
    const posEl = document.getElementById("cc-frame-pos");
    const img = document.getElementById("cc-img");

    if (idx >= currentQueue.length) {
      if (titleEl) titleEl.textContent = "All frames checked!";
      if (posEl) posEl.textContent = "";
      if (banner) {
        banner.innerHTML = `<strong>Done for now!</strong> You've checked ${getCheckedToday()} frames today. The night worker will retrain the club model on these labels during its next improve run.`;
      }
      if (img) img.src = "";
      const canvas = document.getElementById("cc-overlay");
      if (canvas) {
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      drawZoom();
      return;
    }

    const item = currentQueue[idx];
    const c = item.clipObj;
    const clipName = item.clip;

    const club = c?.shot?.club || c?.club;
    const clubStr = (typeof clubName === "function" && club) ? clubName(club) : (club || "Club");
    const whenStr = (typeof fmtWhen === "function" && c?.recorded) ? fmtWhen(c.recorded) : (c?.recorded ? c.recorded.slice(0, 10) : "");
    const angleStr = c?.angle === "dtl" ? "down the line" : "face-on";

    if (titleEl) titleEl.textContent = `${clubStr} · ${whenStr} (${angleStr})`;

    let phaseName = "Downswing";
    if (item.pose?.positions?.p1 != null && Math.abs(item.t - item.pose.positions.p1) < 0.05) {
      phaseName = "Address (P1)";
    } else if (item.pose?.positions?.p7 != null && Math.abs(item.t - item.pose.positions.p7) < 0.02) {
      phaseName = "Impact (P7)";
    }
    if (posEl) posEl.textContent = `· ${phaseName} · ${item.t.toFixed(3)} s`;

    const g = guess(item.frame, item.pose, uprightAspect(item.clip, item.pose && item.pose.rotation));
    const estimated = !!g.estimated;
    delete g.estimated;
    currentPoints = { ...g };
    hoselManuallyMoved = false;

    if (currentPoints.head) {
      selectedPoint = "head";
      if (banner) {
        banner.innerHTML = estimated
          ? `The model didn't find the clubhead: it's <b>placed along the shaft</b> from the hands. Move it onto the clubhead (or <b>B</b> for a streak).`
          : `Model guess drawn. <b>Hosel</b> starts at 93% along the shaft — adjust if needed.`;
      }
    } else {
      selectedPoint = "grip";
      if (banner) {
        banner.innerHTML = `Clubhead wasn't detected by model. <b>Tap</b> picture to place <b>Grip</b> (or press <b>0</b> if no club).`;
      }
    }

    renderPointsUI();

    if (img) {
      img.onload = () => {
        drawOverlay();
        drawZoom();
      };
      img.src = `/api/still/${encodeURIComponent(clipName)}?t=${item.t.toFixed(6)}`;
    }

    if (idx + 1 < currentQueue.length) {
      const nextItem = currentQueue[idx + 1];
      const pre = new Image();
      pre.src = `/api/still/${encodeURIComponent(nextItem.clip)}?t=${nextItem.t.toFixed(6)}`;
    }
  }

  async function save() {
    if (!isOpen || currentIndex >= currentQueue.length) return;
    const item = currentQueue[currentIndex];
    if (!item) return;

    const g = currentPoints?.grip;
    const ho = currentPoints?.hosel;
    const he = currentPoints?.head;

    const gOk = g && (g.hidden || (g.x != null && g.y != null));
    const hoOk = ho && (ho.hidden || (ho.x != null && ho.y != null));
    const heOk = he && (he.hidden || (he.x != null && he.y != null));

    if (!gOk || !hoOk || !heOk) {
      setStatusMessage("Place all 3 points, or press 0 if no club in picture", true);
      return;
    }

    setStatusMessage("Saving...", false);

    const clipName = item.clip;
    const t = item.t;

    try {
      let doc = null;
      const res = await fetch(`/api/labels/${encodeURIComponent(clipName)}?pass=1`, { cache: "no-store" });
      if (res.ok) {
        doc = await res.json();
      } else if (res.status === 404) {
        const c = item.clipObj || (typeof clips !== "undefined" ? clips.find(x => x.name === clipName) : null);
        const partner = c?.partner && typeof clips !== "undefined" ? clips.find(x => x.name === c.partner) : null;
        doc = {
          schema: 1,
          clip: {
            name: clipName,
            angle: c?.angle || "face",
            strike: c?.strike ?? null,
          },
          partner: partner ? {
            name: partner.name,
            angle: partner.angle || (c?.angle === "dtl" ? "face" : "dtl"),
            strike: partner.strike ?? null,
          } : null,
          events: {},
          picked: {},
          frames: {},
        };
      } else {
        throw new Error(`Failed to load labels: ${res.statusText}`);
      }

      const formatPt = (p) => {
        if (!p) return null;
        if (p.hidden) return { hidden: true };
        const out = { x: Number(p.x.toFixed(6)), y: Number(p.y.toFixed(6)) };
        if (p.blur) out.blur = true;
        return out;
      };

      const pointsToMerge = {
        grip: formatPt(currentPoints.grip),
        hosel: formatPt(currentPoints.hosel),
        head: formatPt(currentPoints.head),
      };

      const updatedDoc = merge(doc, t, pointsToMerge);

      const postRes = await fetch(`/api/labels/${encodeURIComponent(clipName)}?pass=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatedDoc),
      });

      if (!postRes.ok) {
        const err = await postRes.json().catch(() => ({}));
        throw new Error(err.detail || postRes.statusText);
      }

      incrementCheckedToday();
      setStatusMessage("Saved", false);
      currentIndex++;
      showFrame(currentIndex);
    } catch (err) {
      setStatusMessage(`Error saving: ${err.message}`, true);
    }
  }

  function skip() {
    if (!isOpen || currentIndex >= currentQueue.length) return;
    currentIndex++;
    showFrame(currentIndex);
  }

  async function loadQueue() {
    setStatusMessage("Loading frames to check...", false);
    try {
      const [clipsRes, summaryRes] = await Promise.all([
        (typeof clips !== "undefined" && Array.isArray(clips)) ? Promise.resolve(clips) : fetch("/api/clips").then(r => r.json()),
        fetch("/api/labels/summary", { cache: "no-store" }).then(r => r.json()).catch(() => ({ clips: [] })),
      ]);

      const allClips = Array.isArray(clipsRes) ? clipsRes : [];
      const summaryList = summaryRes?.clips || [];
      const labelMap = new Map(summaryList.map(c => [c.clip, c]));

      function hasClubPoints(c) {
        for (const name of [c.name, c.partner].filter(Boolean)) {
          const doc = labelMap.get(name);
          if (doc && doc.pointFrames > 0) return true;
        }
        return false;
      }

      const valid = allClips.filter(c => !c.excluded && c.pose === "done");
      const unlabeled = valid.filter(c => !hasClubPoints(c));
      const labeled = valid.filter(c => hasClubPoints(c));

      const candidates = [...balanceSwings(unlabeled), ...balanceSwings(labeled)];

      let q = [];
      let idx = 0;
      while (q.length < 40 && idx < candidates.length) {
        const batch = candidates.slice(idx, idx + 10);
        idx += 10;
        await Promise.all(batch.map(async c => {
          if (!posesCache[c.name]) {
            try {
              const r = await fetch("/api/pose/" + encodeURIComponent(c.name));
              if (r.ok) posesCache[c.name] = await r.json();
            } catch (e) {}
          }
        }));
        q = queue(valid, posesCache, summaryList, { max: 40 });
      }

      currentQueue = q;
      setStatusMessage("", false);
      currentIndex = 0;
      showFrame(0);
    } catch (err) {
      setStatusMessage(`Failed to load queue: ${err.message}`, true);
    }
  }

  function open() {
    isOpen = true;
    if (typeof showView === "function") showView("clubcheck");
    if (typeof renderList === "function") renderList();
    const box = document.getElementById("clubcheck");
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
      const box = document.getElementById("clubcheck");
      if (box) box.hidden = true;
    }
  }

  function getPointerPoint(ev, canvas) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height));
    return { x: Number(x.toFixed(6)), y: Number(y.toFixed(6)) };
  }

  // Bind DOM events when in browser environment
  if (typeof document !== "undefined") {
    const toolsBtn = document.getElementById("clubcheck-btn");
    if (toolsBtn) {
      toolsBtn.onclick = () => {
        const box = document.getElementById("clubcheck");
        if (box && box.hidden) open();
        else close();
      };
    }

    const closeBtn = document.getElementById("cc-close");
    if (closeBtn) closeBtn.onclick = () => close();

    const saveBtn = document.getElementById("cc-save-btn");
    if (saveBtn) saveBtn.onclick = () => save();

    const blurBtn = document.getElementById("cc-blur-btn");
    if (blurBtn) blurBtn.onclick = () => toggleBlur();

    const hideBtn = document.getElementById("cc-hide-btn");
    if (hideBtn) hideBtn.onclick = () => toggleHidden();

    const hideAllBtn = document.getElementById("cc-hideall-btn");
    if (hideAllBtn) hideAllBtn.onclick = () => markAllHidden();

    const skipBtn = document.getElementById("cc-skip-btn");
    if (skipBtn) skipBtn.onclick = () => skip();

    for (const key of ["grip", "hosel", "head"]) {
      const b = document.getElementById(`cc-pt-${key}`);
      if (b) b.onclick = () => selectPoint(key);
    }

    const nrLink = document.getElementById("cc-nightreport-link");
    if (nrLink) {
      nrLink.onclick = (e) => {
        e.preventDefault();
        if (typeof openNightReport === "function") openNightReport();
      };
    }

    // Tapping in the zoom puts the selected point exactly there (the zoom shows ZOOM_MAG x the clip's own
    // pixels round it): for the hosel and clubhead, a few px apart in the picture.
    const zoomCanvasEl = document.getElementById("cc-zoom");
    if (zoomCanvasEl) {
      zoomCanvasEl.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const img = document.getElementById("cc-img");
        const pt = currentPoints ? currentPoints[selectedPoint] : null;
        if (!img || !img.naturalWidth || !pt || pt.hidden || pt.x == null) return;
        const rect = zoomCanvasEl.getBoundingClientRect();
        const dx = (ev.clientX - rect.left - rect.width / 2) / rect.width * (zoomCanvasEl.width / ZOOM_MAG);
        const dy = (ev.clientY - rect.top - rect.height / 2) / rect.height * (zoomCanvasEl.height / ZOOM_MAG);
        updatePointPosition(selectedPoint, {
          x: Math.min(1, Math.max(0, pt.x + dx / img.naturalWidth)),
          y: Math.min(1, Math.max(0, pt.y + dy / img.naturalHeight)),
        });
        if (selectedPoint === "hosel") hoselManuallyMoved = true;
        renderPointsUI();
        drawOverlay();
        drawZoom();
      });
    }

    const overlayCanvas = document.getElementById("cc-overlay");
    if (overlayCanvas) {
      overlayCanvas.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        try { overlayCanvas.setPointerCapture(ev.pointerId); } catch (e) {}
        isDragging = true;
        dragMoved = false;
        downClientPos = { x: ev.clientX, y: ev.clientY };

        const p = getPointerPoint(ev, overlayCanvas);
        const rect = overlayCanvas.getBoundingClientRect();
        const clickPx = { x: p.x * rect.width, y: p.y * rect.height };
        // Only a tap right on a point grabs it (the hosel and clubhead end up a few px apart); anywhere
        // else puts the selected point there.
        const hitThreshold = 10;

        let hit = null;
        for (const key of ["head", "hosel", "grip"]) {
          const pt = currentPoints ? currentPoints[key] : null;
          if (pt && !pt.hidden && pt.x != null && pt.y != null) {
            const d = Math.hypot(pt.x * rect.width - clickPx.x, pt.y * rect.height - clickPx.y);
            if (d < hitThreshold) {
              hit = key;
              break;
            }
          }
        }

        hitSelected = !!hit && hit !== selectedPoint;
        if (hit) {
          selectedPoint = hit;
          if (hit === "hosel") hoselManuallyMoved = true;
        } else {
          updatePointPosition(selectedPoint, p);
        }

        renderPointsUI();
        drawOverlay();
        drawZoom();
      });

      overlayCanvas.addEventListener("pointermove", (ev) => {
        if (!isDragging) return;
        const dist = Math.hypot(ev.clientX - downClientPos.x, ev.clientY - downClientPos.y);
        if (dist > 5) dragMoved = true;

        const p = getPointerPoint(ev, overlayCanvas);
        updatePointPosition(selectedPoint, p);
        renderPointsUI();
        drawOverlay();
        drawZoom();
      });

      const onPointerEnd = (ev) => {
        if (!isDragging) return;
        isDragging = false;
        try { overlayCanvas.releasePointerCapture(ev.pointerId); } catch (e) {}

        // A tap that placed a point goes on to the next one; a tap that only picked a point stays on it.
        if (!dragMoved && !hitSelected) {
          cycleNextPoint();
        }
        hitSelected = false;

        renderPointsUI();
        drawOverlay();
        drawZoom();
      };

      overlayCanvas.addEventListener("pointerup", onPointerEnd);
      overlayCanvas.addEventListener("pointercancel", onPointerEnd);
    }

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if (!isOpen) return;
      const box = document.getElementById("clubcheck");
      if (!box || box.hidden) return;
      if (e.target.closest && e.target.closest("input, select, textarea")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const k = e.key.toLowerCase();
      if (k === "escape") {
        e.preventDefault();
        close();
        return;
      }
      if (k === "enter" || k === " ") {
        e.preventDefault();
        save();
        return;
      }
      if (k === "1") {
        e.preventDefault();
        selectPoint("grip");
        return;
      }
      if (k === "2") {
        e.preventDefault();
        selectPoint("hosel");
        return;
      }
      if (k === "3") {
        e.preventDefault();
        selectPoint("head");
        return;
      }
      if (k === "b") {
        e.preventDefault();
        toggleBlur();
        return;
      }
      if (k === "x") {
        e.preventDefault();
        toggleHidden();
        return;
      }
      if (k === "0") {
        e.preventDefault();
        markAllHidden();
        return;
      }
      if (k === "s") {
        e.preventDefault();
        skip();
        return;
      }
    });

    window.addEventListener("resize", () => {
      if (isOpen) {
        drawOverlay();
        drawZoom();
      }
    });
  }

  const ClubCheck = {
    HOSEL_SHARE,
    guess,
    uprightAspect,
    getKeyPositions,
    getP1P4P8,
    queue,
    merge,
    balanceSwings,
    open,
    close,
    save,
    skip,
    selectPoint,
    toggleBlur,
    toggleHidden,
    markAllHidden,
    cycleNextPoint,
    showFrame,
    loadQueue,
  };

  if (typeof window !== "undefined") {
    window.ClubCheck = ClubCheck;
    window.openClubCheck = open;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = ClubCheck;
  }
})();
