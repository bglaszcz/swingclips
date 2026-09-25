// Compare: the open swing against another one (usually one of your own better ones), side by side.
// Compare… (or C) on a swing opens a picker of other swings; the pair then plays one row per camera
// angle both have, kept in step by key position: P1-P8 line up, with the time between them
// stretched or squeezed in a straight line (piecewise-linear time warping). "Real time" instead
// lines them up at impact only, so tempo differences show. The reference swing's skeleton can be
// drawn as a faint ghost over this one's video, lined up at address by the feet and hips and
// scaled by body height. Linkable as #compare=<clipA>,<clipB>. Esc closes it.
//
// The time mapping works in the browser (window.SwingCompare) and in Node (module.exports) for
// testing. The view itself uses the review page's own state and helpers (index.html): clips,
// current, viewer, video, video2, leadSide, speed, showSkeleton, open, isSecondary, shownClips,
// fetchPose, analysisInput, syncPoint, followVideo, frameIndexAt, fitRect, freshCanvas, drawPose,
// point, fmtValue, fmtWhen, clubName, side, READOUT, DTL_READOUT, SPEEDS, SKELETON, JOINTS, LM,
// L_INDEX, R_INDEX, SHAFT_CONFIDENT, MIN_VISIBILITY, showToast; and trends.js's field and fmtField.
(function (root) {
  const KEYS = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];

  /**
   * The moments that are lined up, as [[time in A, time in B], ...] in order, each clip's own
   * (main clip) seconds.
   * @param timesA {p1: t, ...} swing A's key positions (any may be missing)
   * @param timesB the same for swing B
   * @param mode "keys" (every key position both have) or "impact" (P7 only: real time)
   * @param impactOffset seconds to add to a time in A to get the same moment in B when the key
   *   positions can't be used (SwingSummary.syncOffset: by the ball, else the heard strike)
   */
  function anchors(timesA, timesB, mode, impactOffset = 0) {
    const has = k => timesA && timesB && Number.isFinite(timesA[k]) && Number.isFinite(timesB[k]);
    if (mode !== "impact") {
      // Both must move forward: a key position out of order in either swing is left out.
      const out = [];
      for (const k of KEYS) {
        if (!has(k)) continue;
        const last = out[out.length - 1];
        if (!last || (timesA[k] > last[0] && timesB[k] > last[1])) out.push([timesA[k], timesB[k]]);
      }
      if (out.length >= 2) return out;
    }
    if (has("p7")) return [[timesA.p7, timesB.p7]];
    return [[0, impactOffset]];
  }

  /** The segment of `anch` that A time t falls in: [i, i + 1], or -1 before the first / n - 1 after the last. */
  function segment(anch, t) {
    if (t <= anch[0][0]) return -1;
    for (let i = 0; i + 1 < anch.length; i++) if (t < anch[i + 1][0]) return i;
    return anch.length - 1;
  }

  /**
   * B's time for A's time t: straight lines between the lined-up moments, and at real speed before
   * the first and after the last (the address waggle and the finish aren't stretched).
   */
  function warp(anch, t) {
    if (!anch || !anch.length) return t;
    const i = segment(anch, t);
    if (i < 0) return anch[0][1] + (t - anch[0][0]);
    if (i >= anch.length - 1) return anch[i][1] + (t - anch[i][0]);
    const [a0, b0] = anch[i], [a1, b1] = anch[i + 1];
    return b0 + (t - a0) * (b1 - b0) / (a1 - a0);
  }

  /** How fast B's time runs against A's at A's time t: the playback rate factor for B. */
  function rate(anch, t) {
    if (!anch || anch.length < 2) return 1;
    const i = segment(anch, t);
    if (i < 0 || i >= anch.length - 1) return 1;
    return (anch[i + 1][1] - anch[i][1]) / (anch[i + 1][0] - anch[i][0]);
  }

  /** A's time for B's time t (the inverse of warp). */
  function unwarp(anch, t) {
    return warp((anch || []).map(([a, b]) => [b, a]), t);
  }

  /** "#compare=a,b" for a pair of clip names. */
  function hashFor(a, b) {
    return "#compare=" + encodeURIComponent(a) + "," + encodeURIComponent(b);
  }

  /** [a, b] from a location hash like "#compare=a,b" (b may be missing), or null. */
  function parseHash(hash) {
    const m = /^#?compare=([^,]+)(?:,(.*))?$/.exec(hash || "");
    if (!m) return null;
    try {
      return [decodeURIComponent(m[1]), m[2] ? decodeURIComponent(m[2]) : null];
    } catch { return null; }
  }

  const api = { KEYS, anchors, warp, rate, unwarp, hashFor, parseHash };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }
  root.SwingCompare = api;
  if (typeof document === "undefined") return;

  // ---- The compare view (browser only) ----

  const box = document.getElementById("compare");
  const ANGLES = [["face", "Face-on"], ["dtl", "Down the line"]];
  const NUMBER_POSITIONS = ["p1", "p4", "p6", "p7"];
  const POSITION_TAGS = { p1: "P1 Address", p2: "P2", p3: "P3", p4: "P4 Top", p5: "P5", p6: "P6", p7: "P7 Impact", p8: "P8" };
  const GHOST_COLOR = "rgba(232, 121, 249, 0.8)", GHOST_JOINT = "rgba(232, 121, 249, 0.9)";
  // Camera check codes that make a camera's body numbers unreliable (as the trends leave them out).
  const BAD_CAMERA = ["out", "hands"];
  const SORTS = [
    ["newest", "Newest", null], ["carry", "Carry", -1], ["ballSpeed", "Ball speed", -1],
    ["clubSpeed", "Club speed", -1], ["smash", "Smash", -1], ["straight", "Straightest", 1],
  ];

  let isOpen = false;
  let run = 0;              // bumped when the comparison changes, so old callbacks stop
  let aName = null;         // the swing on the left ("this swing"), by its listed clip
  let cmp = null;           // the loaded comparison: {A, B, rows, anch, ghostT, master}
  let picking = false;
  let mode = "keys", ghost = false, skel = true, cSpeed = 1;
  const pick = { club: null, sort: "carry", period: "90" };
  try {
    const saved = JSON.parse(localStorage.getItem("compare") || "{}");
    if (saved.mode === "impact") mode = "impact";
    ghost = !!saved.ghost;
    if (saved.sort) pick.sort = saved.sort;
    if (saved.period) pick.period = saved.period;
  } catch {}
  const remember = () => {
    try { localStorage.setItem("compare", JSON.stringify({ mode, ghost, sort: pick.sort, period: pick.period })); } catch {}
  };

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k.includes("-")) node.setAttribute(k, v); else node[k] = v;
    }
    node.append(...children.filter(c => c != null));
    return node;
  }

  // ---- Swings ----

  /** A swing by any of its clips: {name (listed clip), c, main: angle, face, dtl: clip names}, or null. */
  function swingOf(name) {
    let c = clips.find(x => x.name === name);
    if (!c) return null;
    if (isSecondary(c)) c = clips.find(x => x.name === c.partner) || c;
    const main = c.angle === "dtl" ? "dtl" : "face";
    const sw = { name: c.name, c, main, face: null, dtl: null };
    sw[main] = c.name;
    if (c.partner) sw[main === "face" ? "dtl" : "face"] = c.partner;
    return sw;
  }

  const anglesOf = sw => ANGLES.map(([g]) => g).filter(g => sw[g]);

  function shotLine(c) {
    const s = c && c.shot, n = SwingSummary.shotNumbers(s);
    return [s ? clubName(s.club) : "", n.carry != null ? `${n.carry.toFixed(0)} yd` : "",
            n.ballSpeed != null ? `${n.ballSpeed.toFixed(1)} mph` : ""].filter(Boolean).join(" · ");
  }

  /** Loads a swing's clips and analysis: videos, poses, key positions and the numbers. */
  async function loadSwing(sw) {
    const angles = anglesOf(sw), vids = {}, poses = {};
    for (const g of angles) {
      vids[g] = el("video", { muted: true, playsInline: true, preload: "auto" });
      vids[g].src = "/clips/" + encodeURIComponent(sw[g]);
    }
    await Promise.all(angles.map(async g => { poses[g] = await fetchPose(sw[g], vids[g]).catch(() => null); }));
    const main = sw.main, other = main === "face" ? "dtl" : "face";
    const S = { ...sw, vids, poses, a: null, times: {}, estimated: {}, offset: { [main]: 0 }, address: {}, posIdx: {}, bad: {} };
    if (sw[other]) {
      S.offset[other] = SwingSummary.syncOffset(syncPoint(sw[main], poses[main] || null), syncPoint(sw[other], poses[other] || null));
    }
    if (!poses[main]) return S;
    const input = analysisInput(sw[main], poses[main]);
    const a = SwingSummary.analyze(input, poses[other] ? analysisInput(sw[other], poses[other]) : null, leadSide);
    S.a = a;
    for (const p of a.positions) { S.times[p.key] = p.t; S.estimated[p.key] = !!p.estimated; }
    const p1 = a.positions.find(p => p.key === "p1");
    if (main === "face") S.address.face = a.metrics ? a.metrics.address : p1 ? p1.index : null;
    if (a.dtl) S.address.dtl = a.dtlIndex("p1");
    // Each key position's frame in each clip.
    for (const g of angles) {
      if (!poses[g]) continue;
      S.posIdx[g] = {};
      for (const p of a.positions) {
        S.posIdx[g][p.key] = g === main ? p.index : frameIndexAt(p.t + S.offset[g], poses[g]);
      }
    }
    const cams = SwingSummary.cameras(a, input);
    for (const g of ["face", "dtl"]) S.bad[g] = (cams[g] || []).filter(code => BAD_CAMERA.includes(code));
    return S;
  }

  /** Where the golfer stands at address in clip g, in video pixels: the middle of feet and hips, and body height. */
  function bodyAnchor(S, g) {
    const p = S.poses[g], i = S.address[g], v = S.vids[g];
    const lm = p && i != null && p.frames[i] ? p.frames[i].lm : null;
    if (!lm || !v.videoWidth) return null;
    const P = k => point(lm, k) && { x: lm[k * 3] * v.videoWidth, y: lm[k * 3 + 1] * v.videoHeight };
    const nose = P(LM.NOSE), la = P(LM.L_ANKLE), ra = P(LM.R_ANKLE), lh = P(LM.L_HIP), rh = P(LM.R_HIP);
    if (!nose || !la || !ra || !lh || !rh) return null;
    const feet = { x: (la.x + ra.x) / 2, y: (la.y + ra.y) / 2 }, hips = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
    const h = feet.y - nose.y;
    return h > 0 ? { x: (feet.x + hips.x) / 2, y: (feet.y + hips.y) / 2, h } : null;
  }

  // ---- Opening and closing ----

  function enter() {
    if (!isOpen) {
      isOpen = true;
      skel = showSkeleton;
      cSpeed = speed;
    }
    video.pause();
    video2.pause();
    viewer.hidden = true;
    box.hidden = false;
    document.getElementById("compare-btn").classList.add("on");
  }

  /** Lets go of the comparison's videos (Windows can't move a file the server is still streaming). */
  function dropMedia() {
    run++;
    if (!cmp) return;
    for (const S of [cmp.A, cmp.B]) {
      for (const v of Object.values(S.vids)) { v.pause(); v.removeAttribute("src"); v.load(); }
    }
    cmp = null;
  }

  /**
   * Closes the compare view. `quiet` when something else is taking over the page (another swing
   * opened, Trends): it sets the page up itself.
   */
  function close(quiet = false) {
    if (!isOpen) return;
    isOpen = false;
    picking = false;
    dropMedia();
    box.hidden = true;
    box.replaceChildren();
    document.getElementById("compare-btn").classList.remove("on");
    if (SwingCompare.parseHash(location.hash)) {
      history.replaceState(null, "", current ? "#" + encodeURIComponent(current) : location.pathname);
    }
    if (!quiet) {
      viewer.hidden = !current;
      redraw();
    }
  }

  /** Opens the comparison of swing a against b; without b, the picker for one. */
  async function show(a, b) {
    const A = swingOf(a);
    if (!A) return;
    const B = b ? swingOf(b) : null;
    if (b && !B) showToast("That reference swing isn't there any more");
    if (current !== A.name) open(A.name);
    enter();
    const same = cmp && cmp.A.name === A.name && B && cmp.B.name === B.name;
    aName = A.name;
    if (!B) {
      picking = true;
      render();
      return;
    }
    picking = false;
    history.replaceState(null, "", SwingCompare.hashFor(A.name, B.name));
    if (same) { render(); return; }
    dropMedia();
    const token = run;
    box.replaceChildren(el("div", { className: "c-head" }, el("strong", { textContent: "Compare" }),
      el("span", { className: "c-status", textContent: "Loading both swings…" }), closeButton()));
    const [SA, SB] = await Promise.all([loadSwing(A), loadSwing(B)]);
    if (token !== run || !isOpen) {
      for (const S of [SA, SB]) for (const v of Object.values(S.vids)) { v.removeAttribute("src"); v.load(); }
      return;
    }
    const rows = anglesOf(A).filter(g => B[g]);
    cmp = { A: SA, B: SB, rows, anch: null, ghostT: {} };
    for (const g of rows) {
      const ta = bodyAnchor(SA, g), tb = bodyAnchor(SB, g);
      cmp.ghostT[g] = ta && tb ? { a: ta, b: tb, s: ta.h / tb.h } : null;
    }
    setMode(mode, true);
    render();
  }

  function setMode(m, quiet) {
    mode = m;
    remember();
    if (!cmp) return;
    const off = SwingSummary.syncOffset(syncPoint(cmp.A.name, cmp.A.poses[cmp.A.main] || null),
                                        syncPoint(cmp.B.name, cmp.B.poses[cmp.B.main] || null));
    cmp.anch = SwingCompare.anchors(cmp.A.times, cmp.B.times, mode, off);
    if (!quiet) { renderControls(); syncAll(); redrawAll(); }
  }

  // ---- Playing both in step ----
  // The first row's "this swing" video leads; the others follow it (followVideo, as the review
  // page's second angle does), the reference at the warped time and rate.

  const master = () => cmp && cmp.rows.length ? cmp.A.vids[cmp.rows[0]] : null;

  /** The lead video's moment in swing A's main-clip seconds. */
  function timeA(t = master().currentTime) {
    return t - cmp.A.offset[cmp.rows[0]];
  }

  /** The middle of the frame of clip p on screen at time t (aiming at a frame's edge can show the one before). */
  function midFrame(p, t) {
    if (!p || !p.frames.length) return t;
    const f = p.frames, i = frameIndexAt(t, p);
    return i + 1 < f.length ? (f[i].t + f[i + 1].t) / 2 : f[i].t + 0.001;
  }

  function syncAll() {
    const m = master();
    if (!m || !m.readyState) return;
    let tA = timeA();
    // Paused: the others show the moment this swing's frame starts (what it shows), each on the
    // middle of its own frame. Playing, they just keep up.
    const still = m.paused, pa = cmp.A.poses[cmp.rows[0]];
    if (still && pa && pa.frames.length) tA = pa.frames[frameIndexAt(m.currentTime, pa)].t - cmp.A.offset[cmp.rows[0]];
    const at = (p, t) => still ? midFrame(p, t) : t;
    const tB = SwingCompare.warp(cmp.anch, tA), r = SwingCompare.rate(cmp.anch, tA);
    for (const g of cmp.rows) {
      const va = cmp.A.vids[g], vb = cmp.B.vids[g];
      if (va !== m) followVideo(va, m, at(cmp.A.poses[g], tA + cmp.A.offset[g]));
      followVideo(vb, m, at(cmp.B.poses[g], tB + cmp.B.offset[g]), r);
    }
    updateScrub();
  }

  function stepFrames(n) {
    const m = master(), p = cmp && cmp.A.poses[cmp.rows[0]];
    if (!m) return;
    m.pause();
    if (!p || !p.frames.length) { m.currentTime = Math.max(0, m.currentTime + n / 30); return; }
    const f = p.frames, i = Math.max(0, Math.min(f.length - 1, frameIndexAt(m.currentTime, p) + n));
    m.currentTime = midFrame(p, f[i].t);
  }

  /** Puts both swings at key position `key` (this swing's; the reference follows). */
  function jumpToPosition(key) {
    const m = master(), g = cmp && cmp.rows[0];
    if (!m || cmp.A.times[key] == null) return;
    const p = cmp.A.poses[g], i = cmp.A.posIdx[g] && cmp.A.posIdx[g][key];
    m.pause();
    if (!p || i == null) { m.currentTime = cmp.A.times[key] + cmp.A.offset[g]; return; }
    m.currentTime = midFrame(p, p.frames[i].t);
  }

  function togglePlay() {
    const m = master();
    if (!m) return;
    if (m.paused) m.play().catch(() => {}); else m.pause();
  }

  // ---- Drawing ----

  /** The key position clip g of swing S is on at frame i, if it is one. */
  function positionAt(S, g, i) {
    const idx = S.posIdx[g];
    if (!idx) return null;
    return SwingCompare.KEYS.find(k => idx[k] === i) || null;
  }

  function fmtRel(dt) {
    if (!Number.isFinite(dt)) return "";
    const ms = Math.round(dt * 1000);
    return ms === 0 ? "impact" : `${ms > 0 ? "+" : "−"}${Math.abs(ms)} ms ${ms > 0 ? "after" : "to"} impact`;
  }

  /** The reference swing's skeleton over this swing's video: lined up at address, scaled by height. */
  function drawGhost(ctx, r, g, tA) {
    const T = cmp.ghostT[g], pb = cmp.B.poses[g], va = cmp.A.vids[g], vb = cmp.B.vids[g];
    if (!T || !pb || !pb.frames.length) return;
    const f = pb.frames[frameIndexAt(SwingCompare.warp(cmp.anch, tA) + cmp.B.offset[g], pb)];
    if (!f.lm) return;
    const toPx = q => ({
      x: r.x + (T.a.x + T.s * (q.x * vb.videoWidth - T.b.x)) / va.videoWidth * r.w,
      y: r.y + (T.a.y + T.s * (q.y * vb.videoHeight - T.b.y)) / va.videoHeight * r.h,
    });
    const lm = f.lm, lineWidth = Math.max(1.5, 3 * r.w / 400);
    ctx.save();
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.strokeStyle = GHOST_COLOR;
    ctx.setLineDash([lineWidth * 2.5, lineWidth * 1.5]);
    for (const [a, b] of SKELETON) {
      const p = point(lm, a), q = point(lm, b);
      if (!p || !q) continue;
      const P = toPx(p), Q = toPx(q);
      ctx.beginPath();
      ctx.moveTo(P.x, P.y);
      ctx.lineTo(Q.x, Q.y);
      ctx.stroke();
    }
    ctx.fillStyle = GHOST_JOINT;
    for (const i of JOINTS) {
      const p = point(lm, i);
      if (!p) continue;
      const P = toPx(p);
      ctx.beginPath();
      ctx.arc(P.x, P.y, lineWidth, 0, Math.PI * 2);
      ctx.fill();
    }
    if (f.club) {
      const grip = toPx({ x: (lm[L_INDEX * 3] + lm[R_INDEX * 3]) / 2, y: (lm[L_INDEX * 3 + 1] + lm[R_INDEX * 3 + 1]) / 2 });
      const len = (pb.clubLength || 0.25) * vb.videoHeight * T.s / va.videoHeight * r.h, a = f.club[0] * Math.PI / 180;
      if (f.club[1] < SHAFT_CONFIDENT) ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(grip.x, grip.y);
      ctx.lineTo(grip.x + Math.cos(a) * len, grip.y + Math.sin(a) * len);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** One video's overlay at its own time t: skeleton, the ghost (this swing only), and its labels. */
  function drawStage(which, g, t) {
    if (!cmp) return;
    const S = cmp[which], stage = S.stages && S.stages[g];
    if (!stage) return;
    const ctx = freshCanvas(stage.canvas), v = S.vids[g], p = S.poses[g];
    const tMain = t - S.offset[g];
    stage.time.textContent = S.times.p7 != null ? fmtRel(tMain - S.times.p7) : "";
    if (!p || !p.frames.length || !v.videoWidth) { stage.pos.textContent = ""; return; }
    const i = frameIndexAt(t, p), f = p.frames[i], r = fitRect(stage.canvas.width, stage.canvas.height, v);
    const key = positionAt(S, g, i);
    stage.pos.textContent = key ? POSITION_TAGS[key] + (S.estimated[key] ? " ~" : "") : "";
    stage.pos.hidden = !key;
    if (skel && f.lm) drawPose(ctx, f, r, false, p);
    // The reference at the moment this frame starts, as the others are lined up.
    if (which === "A" && ghost) drawGhost(ctx, r, g, f.t - S.offset[g]);
  }

  function redrawAll() {
    if (!cmp) return;
    for (const g of cmp.rows) {
      drawStage("A", g, cmp.A.vids[g].currentTime);
      drawStage("B", g, cmp.B.vids[g].currentTime);
    }
  }

  /** Redraws a video's overlay on each frame it shows; the lead video also keeps the others in step. */
  function watch(which, g, isMaster) {
    const v = cmp[which].vids[g], token = run;
    const onFrame = t => {
      drawStage(which, g, t);
      // The ghost follows this swing's frames, so it's drawn with them.
      if (isMaster && !v.paused) syncAll();
    };
    if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
      const cb = (_now, meta) => { if (token !== run) return; onFrame(meta.mediaTime); v.requestVideoFrameCallback(cb); };
      v.requestVideoFrameCallback(cb);
    } else {
      v.addEventListener("timeupdate", () => { if (token === run) onFrame(v.currentTime); });
    }
    v.addEventListener("seeked", () => { if (token === run) drawStage(which, g, v.currentTime); });
    v.addEventListener("loadedmetadata", () => { if (token === run) { if (isMaster) syncAll(); drawStage(which, g, v.currentTime); } });
    if (isMaster) {
      for (const ev of ["play", "pause", "seeked", "ratechange"]) {
        v.addEventListener(ev, () => { if (token === run) { syncAll(); if (ev !== "ratechange") renderPlayButton(); } });
      }
    }
  }

  // ---- The page ----

  function closeButton() {
    return el("button", { className: "small", textContent: "Close (Esc)", onclick: () => close() });
  }

  function swingTitle(S, who) {
    return el("div", { className: "c-who" }, el("b", { textContent: who }),
      el("span", { textContent: [fmtWhen(S.c.recorded), shotLine(S.c)].filter(Boolean).join(" · ") }));
  }

  function render() {
    if (!isOpen) return;
    const A = swingOf(aName);
    if (!A) { close(); return; }
    const head = el("div", { className: "c-head" }, el("strong", { textContent: "Compare" }),
      el("span", { className: "c-status" }),
      cmp && !picking ? el("button", { className: "small", textContent: "Swap", title: "Put the reference on the left",
                                       onclick: () => show(cmp.B.name, cmp.A.name) }) : null,
      cmp && !picking ? el("button", { className: "small", textContent: "Change reference…", onclick: () => {
        for (const S of [cmp.A, cmp.B]) for (const v of Object.values(S.vids)) v.pause();
        picking = true;
        render();
      } }) : null,
      closeButton());
    if (picking) {
      box.replaceChildren(head, renderPicker(A));
      head.querySelector(".c-status").textContent = `Pick a swing to compare ${fmtWhen(A.c.recorded)} with`;
      return;
    }
    if (!cmp) return;
    const kids = [head, el("div", { className: "c-whos" }, swingTitle(cmp.A, "This swing"), swingTitle(cmp.B, "Reference"))];
    if (!cmp.rows.length) {
      kids.push(el("div", { className: "note", textContent: "These two swings have no camera angle in common, so there's nothing to play side by side. Their numbers are below." }));
    }
    // Fresh stages: the old ones' frame callbacks and listeners stop.
    run++;
    for (const g of cmp.rows) kids.push(renderRow(g));
    if (cmp.rows.length) {
      kids.push(el("input", { type: "range", id: "c-scrub", min: 0, step: 0.001, value: 0, "aria-label": "Scrub both swings" }));
      kids.push(el("div", { className: "controls", id: "c-controls" }));
      kids.push(el("div", { className: "note", id: "c-sync-note" }));
    }
    kids.push(renderNumbers());
    box.replaceChildren(...kids);
    const s = box.querySelector("#c-scrub");
    if (s) {
      s.oninput = () => { const m = master(); m.pause(); m.currentTime = Number(s.value); };
      renderControls();
      for (const g of cmp.rows) { watch("A", g, g === cmp.rows[0]); watch("B", g, false); }
      for (const S of [cmp.A, cmp.B]) for (const v of Object.values(S.vids)) v.playbackRate = cSpeed;
      const m = master();
      // Start at this swing's address, both lined up.
      const start = () => { if (cmp.A.times.p1 != null) jumpToPosition("p1"); else syncAll(); };
      m.readyState ? start() : m.addEventListener("loadedmetadata", start, { once: true });
    }
    resize.disconnect();
    box.querySelectorAll(".c-stage canvas").forEach(c => resize.observe(c));
  }
  const resize = new ResizeObserver(() => redrawAll());

  function renderRow(g) {
    const title = ANGLES.find(x => x[0] === g)[1];
    const pair = el("div", { className: "c-pair" });
    for (const [which, who] of [["A", "This swing"], ["B", "Reference"]]) {
      const S = cmp[which], v = S.vids[g];
      const stage = { canvas: el("canvas"), time: el("span", { className: "c-time" }), pos: el("span", { className: "c-pos", hidden: true }) };
      S.stages = S.stages || {};
      S.stages[g] = stage;
      v.controls = false;
      v.onclick = togglePlay;
      pair.append(el("div", { className: "stage c-stage" + (which === "B" ? " ref" : "") },
        el("span", { className: "c-tag", textContent: who + (S.poses[g] ? "" : " (not analyzed)") }), v, stage.canvas, stage.time, stage.pos));
    }
    return el("div", { className: "c-row" }, el("div", { className: "c-rowtitle", textContent: title }), pair);
  }

  function updateScrub() {
    const s = box.querySelector("#c-scrub"), m = master();
    if (!s || !m) return;
    if (m.duration && Number(s.max) !== m.duration) s.max = m.duration;
    if (document.activeElement !== s) s.value = m.currentTime;
  }

  function renderPlayButton() {
    const b = box.querySelector("#c-play"), m = master();
    if (b && m) b.textContent = m.paused ? "Play" : "Pause";
  }

  function chip(text, on, onclick, title = "") {
    return el("button", { className: "small" + (on ? " on" : ""), textContent: text, title, onclick });
  }

  function renderControls() {
    const bar = box.querySelector("#c-controls");
    if (!bar || !cmp) return;
    const keysOk = cmp.anch.length >= 2 || mode === "impact";
    bar.replaceChildren(
      el("button", { id: "c-play", title: "Play / pause both (Space)", onclick: togglePlay }),
      el("button", { textContent: "‹ Frame", title: "Previous frame (←)", onclick: () => stepFrames(-1) }),
      el("button", { textContent: "Frame ›", title: "Next frame (→)", onclick: () => stepFrames(1) }),
      el("span", { className: "sep" }),
      ...SPEEDS.map(s => chip(s === 1 ? "1×" : "1/" + (1 / s) + "×", s === cSpeed, () => {
        cSpeed = s;
        for (const S of [cmp.A, cmp.B]) for (const v of Object.values(S.vids)) v.playbackRate = s;
        renderControls();
        syncAll();
      })),
      el("span", { className: "sep" }),
      chip("Key positions", mode === "keys", () => setMode("keys"), "P1-P8 line up; the time between them is stretched (T)"),
      chip("Real time", mode === "impact", () => setMode("impact"), "Both at real speed, lined up at impact: tempo differences show (T)"),
      el("span", { className: "sep" }),
      chip("Skeleton", skel, () => { skel = !skel; renderControls(); redrawAll(); }, "Both swings' skeletons (S)"),
      chip("Ghost", ghost, () => { ghost = !ghost; remember(); renderControls(); redrawAll(); },
           "The reference swing's skeleton over this one, lined up at address by the feet and hips, scaled by height (G)"),
      el("span", { className: "sep" }),
      ...SwingCompare.KEYS.map((k, n) => {
        const b = chip(k.toUpperCase(), false, () => jumpToPosition(k), `${POSITION_TAGS[k]} (${n + 1})`);
        b.disabled = cmp.A.times[k] == null;
        return b;
      }));
    renderPlayButton();
    const note = box.querySelector("#c-sync-note");
    const ghostNote = ghost && cmp.rows.some(g => !cmp.ghostT[g])
      ? " No ghost where either swing's feet, hips or head couldn't be found at address." : "";
    if (note) {
      note.textContent = (mode === "keys"
        ? keysOk ? `Lined up at ${cmp.anch.length} key positions both swings have; the reference plays faster or slower between them.`
          : "Key positions weren't found in both swings, so they're lined up at impact instead."
        : "Real time: both at the same speed, lined up at impact.") + ghostNote;
    }
  }

  // ---- The numbers ----

  const finite = x => typeof x === "number" && Number.isFinite(x);

  /** Swing S's values at key position `key` from view g ("face" or "dtl"), or null. */
  function valuesAt(S, g, key) {
    const a = S.a, p = a && a.positions.find(q => q.key === key);
    if (!p) return null;
    if (g === "face") return a.metrics ? a.metrics.values[p.index] : null;
    if (!a.dtlMetrics) return null;
    const i = a.dtlIndex(key);
    return i == null ? null : a.dtlMetrics.values[i];
  }

  function cell(text, dim, cls = "") {
    const td = el("td", { textContent: text, className: cls });
    if (dim) { td.classList.add("dim"); td.title = "That camera couldn't see all of this swing: the number doesn't hold up"; }
    return td;
  }

  function renderNumbers() {
    const A = cmp.A, B = cmp.B;
    const wrap = el("div", { className: "c-numbers" }, el("strong", { textContent: "Numbers" }));

    // Tempo (face-on).
    const tA = A.a && A.a.metrics && A.a.metrics.tempo, tB = B.a && B.a.metrics && B.a.metrics.tempo;
    const timing = el("table", { className: "c-table" },
      el("tr", {}, el("th"), el("th", { textContent: "This" }), el("th", { textContent: "Ref" }), el("th", { textContent: "This − ref" })));
    for (const [label, k, d, unit] of [["Tempo", "ratio", 1, " : 1"], ["Backswing", "back", 2, " s"], ["Downswing", "down", 2, " s"]]) {
      const a = tA ? tA[k] : null, b = tB ? tB[k] : null;
      const f = x => finite(x) ? x.toFixed(d) + unit : "--";
      const diff = finite(a) && finite(b) ? (a - b > 0 ? "+" : "") + (a - b).toFixed(d) + unit : "--";
      const dA = A.bad.face && A.bad.face.length, dB = B.bad.face && B.bad.face.length;
      timing.append(el("tr", {}, el("td", { textContent: label }), cell(f(a), dA), cell(f(b), dB), cell(diff, dA || dB, "diff")));
    }
    if (tA || tB) wrap.append(el("div", { className: "c-scroll" }, timing));

    // Body numbers at P1, P4, P6 and P7.
    const cols = NUMBER_POSITIONS.filter(k => A.times[k] != null || B.times[k] != null);
    const sections = [];
    if ((A.a && A.a.metrics) || (B.a && B.a.metrics)) sections.push(["face", "Face-on", READOUT]);
    if ((A.a && A.a.dtlMetrics) || (B.a && B.a.dtlMetrics)) sections.push(["dtl", "Down the line", DTL_READOUT]);
    if (cols.length && sections.length) {
      const table = el("table", { className: "c-table" });
      const h1 = el("tr", {}, el("th"));
      const h2 = el("tr", {}, el("th"));
      for (const k of cols) {
        const est = A.estimated[k] || B.estimated[k] ? " ~" : "";
        h1.append(el("th", { colSpan: 3, className: "c-poshead", textContent: POSITION_TAGS[k] + est }));
        h2.append(el("th", { textContent: "This" }), el("th", { textContent: "Ref" }), el("th", { textContent: "Δ" }));
      }
      table.append(h1, h2);
      for (const [g, title, readout] of sections) {
        table.append(el("tr", { className: "group" }, el("th", { colSpan: cols.length * 3 + 1, textContent: title })));
        const dA = !!(A.bad[g] && A.bad[g].length), dB = !!(B.bad[g] && B.bad[g].length);
        for (const [label, key, unit] of readout) {
          const tr = el("tr", {}, el("td", { textContent: label }));
          for (const k of cols) {
            const va = valuesAt(A, g, k), vb = valuesAt(B, g, k);
            const x = va && va[key], y = vb && vb[key];
            const d = finite(x) && finite(y) ? { [key]: x - y, clubSeen: va.clubSeen !== false && vb.clubSeen !== false } : null;
            tr.append(cell(fmtValue(va, key, unit), dA), cell(fmtValue(vb, key, unit), dB), cell(fmtValue(d, key, unit), dA || dB, "diff"));
          }
          table.append(tr);
        }
      }
      wrap.append(el("div", { className: "c-scroll" }, table));
    } else {
      wrap.append(el("div", { className: "note", textContent: "No body numbers: key positions weren't found in either swing (or they haven't been analyzed yet)." }));
    }

    // The launch monitor's.
    const sa = SwingSummary.shotNumbers(A.c.shot), sb = SwingSummary.shotNumbers(B.c.shot);
    const shotRows = SwingSummary.SHOT.filter(f => sa[f.key] != null || sb[f.key] != null);
    if (shotRows.length) {
      const table = el("table", { className: "c-table" },
        el("tr", {}, el("th", { textContent: "Launch monitor" }), el("th", { textContent: "This" }), el("th", { textContent: "Ref" }), el("th", { textContent: "This − ref" })));
      for (const f of shotRows) {
        const F = field(f.key), a = sa[f.key], b = sb[f.key];
        const diff = a != null && b != null ? ((a - b > 0 ? "+" : "") + (a - b).toFixed(F.dec)).replace(/^[+-]?0(\.0+)?$/, "0") : "–";
        table.append(el("tr", {}, el("td", { textContent: fieldName(F) }), el("td", { textContent: fmtField(F, a) }),
          el("td", { textContent: fmtField(F, b) }), el("td", { className: "diff", textContent: diff })));
      }
      wrap.append(el("div", { className: "c-scroll" }, table));
    }

    const notes = [];
    for (const [S, who] of [[A, "this swing"], [B, "the reference"]]) {
      for (const [g, name] of ANGLES) {
        if (S.bad[g] && S.bad[g].length) notes.push(`The ${name.toLowerCase()} camera couldn't see all of ${who} (greyed out).`);
      }
    }
    notes.push("~ = estimated (the club couldn't be seen clearly then). Δ = this swing minus the reference. " +
      "Body numbers from different sessions only compare if the phones stood in the same places.");
    wrap.append(el("div", { className: "note", textContent: notes.join(" ") }));
    return wrap;
  }

  // ---- The picker ----

  function renderPicker(A) {
    const wrap = el("div", { className: "c-picker" });
    const aShot = A.c.shot;
    if (pick.club == null || pick.forSwing !== A.name) { pick.club = aShot ? aShot.club : ""; pick.forSwing = A.name; }
    const all = shownClips().filter(c => c.name !== A.name);
    const clubs = [...new Set(all.map(c => c.shot && c.shot.club).filter(Boolean))];
    const clubSel = el("select", { "aria-label": "Club" },
      el("option", { value: "", textContent: "Any club" }),
      ...clubs.map(k => el("option", { value: k, textContent: clubName(k) })));
    clubSel.value = clubs.includes(pick.club) ? pick.club : "";
    const sortSel = el("select", { "aria-label": "Sort by" }, ...SORTS.map(([k, label]) => el("option", { value: k, textContent: label })));
    sortSel.value = pick.sort;
    const periodSel = el("select", { "aria-label": "Period" },
      ...[["30", "Last 30 days"], ["90", "Last 90 days"], ["365", "Last year"], ["0", "All"]].map(([v, t]) => el("option", { value: v, textContent: t })));
    periodSel.value = pick.period;
    const again = () => { pick.club = clubSel.value; pick.sort = sortSel.value; pick.period = periodSel.value; remember(); render(); };
    clubSel.onchange = sortSel.onchange = periodSel.onchange = again;
    wrap.append(el("div", { className: "t-filters" },
      el("label", {}, "Club ", clubSel), el("label", {}, "Sort by ", sortSel), el("label", {}, "Period ", periodSel)));

    const since = pick.period === "0" ? 0 : Date.now() - Number(pick.period) * 86400000;
    const aAngles = anglesOf(A);
    let rows = all.filter(c => (!pick.club || (c.shot && c.shot.club === pick.club)) && new Date(c.recorded).getTime() >= since)
      .map(c => ({ c, sw: swingOf(c.name), n: SwingSummary.shotNumbers(c.shot) }));
    const sort = SORTS.find(s => s[0] === pick.sort) || SORTS[0];
    const value = r => sort[0] === "straight" ? (r.n.offline == null ? null : Math.abs(r.n.offline)) : r.n[sort[0]];
    if (sort[0] !== "newest") {
      rows.sort((x, y) => {
        const a = value(x), b = value(y);
        if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
        return (a - b) * sort[2];
      });
    }
    const total = rows.length;
    rows = rows.slice(0, 200);
    if (!rows.length) {
      wrap.append(el("div", { className: "note", textContent: all.length ? "No swings match: try another club or a longer period." : "There are no other swings yet." }));
      return wrap;
    }
    const table = el("table", { className: "c-table c-picktable" }, el("tr", {},
      ...["When", "Club", "Carry", "Offline", "Ball mph", "Club mph", "Smash", "Angles", ""].map(t => el("th", { textContent: t }))));
    const fmt = (x, d) => x == null ? "–" : x.toFixed(d);
    for (const { c, sw, n } of rows) {
      const common = anglesOf(sw).filter(g => aAngles.includes(g));
      const states = [c.pose, ...(c.partner ? [clips.find(x => x.name === c.partner)?.pose] : [])];
      const status = !common.length ? "no angle in common" : states.some(s => s !== "done") ? "not analyzed yet" : c.excluded ? "left out of trends" : "";
      const tr = el("tr", { tabIndex: 0 },
        el("td", { textContent: fmtWhen(c.recorded) }), el("td", { textContent: c.shot ? clubName(c.shot.club) : "" }),
        el("td", { textContent: fmt(n.carry, 0) }), el("td", { textContent: n.offline == null ? "–" : side(n.offline).replace("°", " yd") }),
        el("td", { textContent: fmt(n.ballSpeed, 1) }), el("td", { textContent: fmt(n.clubSpeed, 1) }), el("td", { textContent: fmt(n.smash, 2) }),
        el("td", { textContent: anglesOf(sw).length === 2 ? "both" : anglesOf(sw)[0] === "dtl" ? "down the line" : "face-on" }),
        el("td", { className: "c-status", textContent: status }));
      if (common.length) {
        const go = () => show(A.name, c.name);
        tr.onclick = go;
        tr.onkeydown = e => { if (e.key === "Enter") go(); };
      } else {
        tr.className = "off";
      }
      table.append(tr);
    }
    wrap.append(el("div", { className: "c-scroll" }, table));
    wrap.append(el("div", { className: "note", textContent:
      (total > rows.length ? `The first ${rows.length} of ${total}. ` : "") +
      "Tap a swing to compare with it. Numbers are from the launch monitor; Straightest sorts by how far offline." }));
    return wrap;
  }

  // ---- Keys and links ----

  window.addEventListener("keydown", ev => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const inField = ev.target.closest && ev.target.closest("input, select, textarea");
    const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    if (!isOpen) {
      if (k === "c" && !inField && current && !viewer.hidden && !document.getElementById("stages").classList.contains("labeling")) {
        ev.preventDefault();
        show(current, null);
      }
      return;
    }
    // The review page's own keys would act on its hidden player.
    ev.stopImmediatePropagation();
    if (k === "Escape") {
      ev.preventDefault();
      if (picking && cmp) { picking = false; render(); } else close();
      return;
    }
    if (inField || picking || !cmp) return;
    const handled = () => ev.preventDefault();
    if (k === " ") { handled(); togglePlay(); }
    else if (k === "ArrowLeft" || k === "ArrowRight") { handled(); stepFrames(k === "ArrowLeft" ? -1 : 1); }
    else if (k === "t") setMode(mode === "keys" ? "impact" : "keys");
    else if (k === "g") { ghost = !ghost; remember(); renderControls(); redrawAll(); }
    else if (k === "s") { skel = !skel; renderControls(); redrawAll(); }
    else if (/^[1-8]$/.test(k)) jumpToPosition("p" + k);
  }, true);

  window.addEventListener("hashchange", () => {
    const pair = SwingCompare.parseHash(location.hash);
    if (pair && clips.length) show(pair[0], pair[1]);
  });

  document.getElementById("compare-btn").onclick = () => isOpen ? close() : current && show(current, null);

  window.Compare = {
    show, close,
    get open() { return isOpen; },
  };
})(typeof window !== "undefined" ? window : globalThis);
