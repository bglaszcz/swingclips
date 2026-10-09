// Lead wrist check: judge lead wrist at impact on coach program shots (Tools > Wrist check).
//
// Shows down-the-line impact stills cropped and enlarged around the hands for each ball shot.
// Lets the golfer mark flat, bowed (slightly bowed), cupped, or can't tell (keys 1-4), auto-advancing to the next shot.
//
// Pure helpers are exported for node testing (tests/wristcheck.test.js) and browser use (window.SwingWristCheck).

(function (root) {
  /**
   * Extracts ordered ball shots from a program run that have a down-the-line partner clip.
   * Shots without a down-the-line clip or no-ball reps are skipped.
   *
   * @param {Object} run The program run object (from /api/program log or active state)
   * @param {Object} [program] Program definition with block names
   * @returns {Array<Object>} List of shots to display
   */
  function clipForAngle(r, targetAngle) {
    if (!r) return null;
    const isDtl = name => typeof name === "string" && name.includes("_dtl_");
    const isFace = name => typeof name === "string" && (name.includes("_face_") || !name.includes("_dtl_"));
    if (targetAngle === "dtl") {
      if (r.partner && isDtl(r.partner)) return r.partner;
      if (r.clip && isDtl(r.clip)) return r.clip;
      return null;
    }
    if (targetAngle === "face") {
      if (r.clip && isFace(r.clip)) return r.clip;
      if (r.partner && isFace(r.partner)) return r.partner;
      return null;
    }
    return r.clip || null;
  }

  function shotsFromRun(run, program, angle = "dtl") {
    if (!run || !Array.isArray(run.reps)) return [];
    const reps = [...run.reps].sort((a, b) => (a.t || 0) - (b.t || 0));
    const blockMap = {};
    if (run.program && Array.isArray(run.program.blocks)) {
      for (const b of run.program.blocks) blockMap[b.id] = b.name;
    }
    if (run.blocks && Array.isArray(run.blocks)) {
      for (const b of run.blocks) blockMap[b.id] = b.name;
    }
    if (program && Array.isArray(program.blocks)) {
      for (const b of program.blocks) blockMap[b.id] = b.name;
    }
    const wristMap = run.wrist || {};
    const out = [];
    let shotIndex = 1;
    for (const r of reps) {
      if (r.kind !== "shot" && r.kind !== "ball") continue;
      const targetClip = clipForAngle(r, angle);
      if (!targetClip) continue;

      const wristCall = wristMap[r.clip] || (r.partner ? wristMap[r.partner] : null) || null;
      let verdict = "";
      if (r.noRead) verdict = `invalid read (${r.noRead})`;
      else if (r.waiting3d) verdict = "waiting for 3D";
      else if (r.gate === true) verdict = "pass";
      else if (r.gate === false) verdict = "miss";

      out.push({
        index: shotIndex++,
        clip: r.clip,
        partner: r.partner,
        targetClip,
        blockId: r.block,
        block: blockMap[r.block] || r.block || "",
        club: r.club || "",
        verdict,
        wrist: wristCall,
        t: r.t
      });
    }
    return out;
  }

  /**
   * Finds the lead wrist (landmark 15) normalized coordinates (0..1) from a clip's pose data at impact.
   *
   * @param {Object} poseData Pose response from /api/pose/<clip>
   * @returns {{x: number, y: number}|null} Normalized wrist point or null if unavailable
   */
  function getWristPoint(poseData) {
    if (!poseData || !Array.isArray(poseData.frames) || !poseData.frames.length) return null;
    const targetT = poseData.impact ?? poseData.strike ?? null;
    let impactFrame = null;
    if (targetT != null) {
      let minDt = Infinity;
      for (const f of poseData.frames) {
        const dt = Math.abs((f.t ?? 0) - targetT);
        if (dt < minDt) {
          minDt = dt;
          impactFrame = f;
        }
      }
    } else {
      impactFrame = poseData.frames[Math.floor(poseData.frames.length / 2)];
    }
    if (!impactFrame || !impactFrame.lm) return null;
    const lm = impactFrame.lm;
    let x = null, y = null;
    if (Array.isArray(lm)) {
      if (typeof lm[15] === "object" && lm[15] !== null) {
        x = lm[15].x; y = lm[15].y;
      } else if (lm.length > 46 && typeof lm[45] === "number" && typeof lm[46] === "number") {
        x = lm[45]; y = lm[46];
      }
    } else if (typeof lm === "object" && lm[15]) {
      x = lm[15].x; y = lm[15].y;
    }
    if (x != null && y != null && !isNaN(x) && !isNaN(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1) {
      return { x, y };
    }
    return null;
  }

  /**
   * Computes the bounding crop box in pixels to enlarge around the lead wrist.
   * If wristPoint is null, returns the middle 60% of the image.
   *
   * @param {{x: number, y: number}|null} wristPoint Wrist coordinates (normalized 0..1 or pixel)
   * @param {number} [imageWidth=1] Width of source image
   * @param {number} [imageHeight=1] Height of source image
   * @param {Object} [options] Optional size config (e.g. { size: 0.35 })
   * @returns {{x: number, y: number, width: number, height: number}}
   */
  function cropBoxFromWrist(wristPoint, imageWidth = 1, imageHeight = 1, options = {}) {
    const W = Math.max(1, Number(imageWidth) || 1);
    const H = Math.max(1, Number(imageHeight) || 1);

    if (!wristPoint || typeof wristPoint.x !== "number" || typeof wristPoint.y !== "number") {
      const w = Math.round(W * 0.60);
      const h = Math.round(H * 0.60);
      const x = Math.round(W * 0.20);
      const y = Math.round(H * 0.20);
      return { x, y, width: w, height: h };
    }

    let wx = wristPoint.x;
    let wy = wristPoint.y;
    if (wx > 1 || wy > 1) {
      wx = wx / W;
      wy = wy / H;
    }
    wx = Math.max(0, Math.min(1, wx));
    wy = Math.max(0, Math.min(1, wy));

    const size = (options && options.size) || 0.35;
    const w = Math.round(W * size);
    const h = Math.round(H * size);
    const centerX = Math.round(wx * W);
    const centerY = Math.round(wy * H);

    const x = Math.max(0, Math.min(W - w, Math.round(centerX - w / 2)));
    const y = Math.max(0, Math.min(H - h, Math.round(centerY - h / 2)));

    return { x, y, width: w, height: h };
  }

  // --- Browser UI ---
  let isOpen = false;
  let allRuns = [];
  let currentRun = null;
  let currentShots = [];
  let activeShotIndex = 1;
  const poseCache = {};
  const imageCache = {};
  // Which camera's pictures (since Oct 7: the back of the lead hand is often clearer face-on), remembered.
  let angle = "dtl";
  try { if (localStorage.getItem("wrist-angle") === "face") angle = "face"; } catch (e) {}
  // The strip: frames round impact (at 240 fps one frame is ~4 ms; a single frame is often a blur).
  const STRIP = [-2, -1, 0, 1];

  function open() {
    isOpen = true;
    if (typeof showView === "function") showView("wristcheck");
    if (typeof renderList === "function") renderList();
    const box = document.getElementById("wristcheck");
    if (box) {
      box.scrollTop = 0;
      if (window.innerWidth < 900) box.scrollIntoView();
    }
    loadData();
  }

  function close() {
    isOpen = false;
    if (typeof closeTrendView === "function") {
      closeTrendView();
    } else {
      const box = document.getElementById("wristcheck");
      if (box) box.hidden = true;
    }
  }

  let programCatalog = [];

  async function loadData() {
    try {
      const res = await fetch("/api/program");
      if (!res.ok) return;
      const data = await res.json();
      programCatalog = (data && data.programs) || [];
      const logs = (data && data.log) || [];
      // Runs sorted newest first
      allRuns = [...logs].sort((a, b) => (b.started || 0) - (a.started || 0));
      if (!allRuns.length && data && data.program) {
        allRuns = [data.program];
      }

      populateRunPicker();
      if (allRuns.length) {
        currentRun = allRuns[0];
        renderShots();
      } else {
        const container = document.getElementById("wrist-cards");
        if (container) container.innerHTML = '<div class="note" style="padding: 20px; text-align: center;">No coach program runs yet.</div>';
        const countsEl = document.getElementById("wrist-counts");
        if (countsEl) countsEl.textContent = "0 shots · 0 called";
      }
    } catch (e) {
      console.error("Failed to load program data:", e);
    }
  }

  function formatRunTitle(run) {
    const name = (run.program && run.program.name) || run.name || run.id || "Program";
    let dateStr = "";
    if (run.day) {
      dateStr = run.day.replace("T", " ").slice(0, 16);
    } else if (run.started) {
      dateStr = new Date(run.started * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    }
    const ballCount = (run.reps || []).filter(r => (r.kind === "shot" || r.kind === "ball") && clipForAngle(r, angle)).length;
    return `${name} – ${dateStr} (${ballCount} shots)`;
  }

  function populateRunPicker() {
    const select = document.getElementById("wrist-run-select");
    if (!select) return;
    select.innerHTML = "";
    for (const r of allRuns) {
      const opt = document.createElement("option");
      opt.value = String(r.started);
      opt.textContent = formatRunTitle(r);
      select.appendChild(opt);
    }
    select.onchange = () => {
      const val = Number(select.value);
      currentRun = allRuns.find(r => r.started === val) || null;
      renderShots();
    };
  }

  function updateCounts() {
    const countsEl = document.getElementById("wrist-counts");
    if (!countsEl) return;
    const total = currentShots.length;
    const called = currentShots.filter(s => s.wrist != null).length;
    countsEl.textContent = `${total} shots · ${called} called`;
  }

  function renderShots() {
    const container = document.getElementById("wrist-cards");
    if (!container) return;
    container.innerHTML = "";

    if (!currentRun) {
      container.innerHTML = '<div class="note" style="padding: 20px; text-align: center;">No run selected.</div>';
      return;
    }

    const progDef = Array.isArray(programCatalog) ? programCatalog.find(p => p.id === currentRun.id) : null;
    currentShots = shotsFromRun(currentRun, progDef, angle);
    for (const [id, a] of [["wrist-angle-dtl", "dtl"], ["wrist-angle-face", "face"]]) {
      const b = document.getElementById(id);
      if (b) b.classList.toggle("on", angle === a);
    }
    updateCounts();

    if (!currentShots.length) {
      container.innerHTML = `<div class="note" style="padding: 20px; text-align: center;">No ball shots with ${angle === "dtl" ? "down-the-line" : "face-on"} clips in this run.</div>`;
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const shot of currentShots) {
      const card = document.createElement("div");
      card.className = "wrist-card";
      card.id = `wrist-card-${shot.index}`;
      card.dataset.index = String(shot.index);

      const head = document.createElement("div");
      head.className = "wrist-card-head";

      const title = document.createElement("div");
      title.className = "wrist-card-title";
      title.innerHTML = `Shot ${shot.index} <span class="wrist-card-block">${escapeHtml(shot.block)}${shot.club ? ` · ${escapeHtml(shot.club)}` : ""}</span>`;
      head.appendChild(title);

      if (shot.verdict) {
        const badge = document.createElement("span");
        badge.className = "wrist-card-verdict";
        badge.textContent = shot.verdict;
        head.appendChild(badge);
      }
      card.appendChild(head);

      const imgWrap = document.createElement("div");
      imgWrap.className = "wrist-img-wrap";
      const canvas = document.createElement("canvas");
      canvas.className = "wrist-canvas";
      canvas.id = `wrist-canvas-${shot.index}`;
      imgWrap.appendChild(canvas);
      const labels = document.createElement("div");
      labels.className = "wrist-strip-labels";
      labels.innerHTML = STRIP.map(k => `<span>${k === 0 ? "impact" : `${k > 0 ? "+" : ""}${Math.round(k * 1000 / 240)} ms`}</span>`).join("");
      imgWrap.appendChild(labels);
      card.appendChild(imgWrap);

      const btnGroup = document.createElement("div");
      btnGroup.className = "wrist-buttons";

      const choices = [
        { label: "Flat (1)", key: "1", verdict: "flat" },
        { label: "Slightly bowed (2)", key: "2", verdict: "bowed" },
        { label: "Cupped (3)", key: "3", verdict: "cupped" },
        { label: "Can't tell (4)", key: "4", verdict: "can't tell" }
      ];

      for (const choice of choices) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "wrist-btn";
        btn.dataset.verdict = choice.verdict;
        btn.textContent = choice.label;
        if (shot.wrist === choice.verdict) {
          btn.classList.add("selected");
        }
        btn.onclick = (e) => {
          e.stopPropagation();
          callWrist(shot, choice.verdict);
        };
        btnGroup.appendChild(btn);
      }
      card.appendChild(btnGroup);

      card.onclick = () => {
        setActiveShot(shot.index);
      };

      fragment.appendChild(card);
    }

    container.appendChild(fragment);
    setActiveShot(1);

    // Render still crops
    for (const shot of currentShots) {
      renderShotStill(shot);
    }
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  async function renderShotStill(shot) {
    const canvas = document.getElementById(`wrist-canvas-${shot.index}`);
    const clip = shot.targetClip || clipForAngle(shot, angle);
    if (!canvas || !clip) return;

    let pose = poseCache[clip];
    if (pose === undefined) {
      try {
        const r = await fetch(`/api/pose/${encodeURIComponent(clip)}`);
        pose = r.ok ? await r.json() : null;
      } catch (e) {
        pose = null;
      }
      poseCache[clip] = pose;
    }
    const impact = pose && (pose.impact ?? pose.strike);
    // Frames round impact, the same crop round the lead wrist on each, side by side.
    const times = impact != null ? STRIP.map(k => Math.max(0, impact + k / 240)) : [null];
    const imgs = await Promise.all(times.map(t => new Promise(resolve => {
      const key = `${clip}@${t == null ? "impact" : t.toFixed(4)}`;
      let img = imageCache[key];
      if (!img) {
        img = new Image();
        img.src = `/api/still/${encodeURIComponent(clip)}` + (t == null ? "" : `?t=${t.toFixed(6)}`);
        imageCache[key] = img;
      }
      if (img.complete && img.naturalWidth) resolve(img);
      else { img.onload = () => resolve(img); img.onerror = () => resolve(null); }
    })));
    const first = imgs.find(i => i && i.naturalWidth);
    if (!first) return;
    const crop = cropBoxFromWrist(getWristPoint(pose), first.naturalWidth, first.naturalHeight, { size: 0.28 });
    canvas.width = crop.width * imgs.length;
    canvas.height = crop.height;
    const ctx = canvas.getContext("2d");
    imgs.forEach((img, i) => {
      if (img && img.naturalWidth) ctx.drawImage(img, crop.x, crop.y, crop.width, crop.height, i * crop.width, 0, crop.width, crop.height);
    });
  }

  function setActiveShot(index) {
    if (index < 1 || index > currentShots.length) return;
    activeShotIndex = index;
    const cards = document.querySelectorAll(".wrist-card");
    cards.forEach(c => {
      c.classList.toggle("active", c.dataset.index === String(index));
    });
    const activeCard = document.getElementById(`wrist-card-${index}`);
    if (activeCard) {
      activeCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  async function callWrist(shot, verdict) {
    const isClearing = shot.wrist === verdict;
    const newVerdict = isClearing ? null : verdict;
    shot.wrist = newVerdict;

    if (currentRun) {
      currentRun.wrist = currentRun.wrist || {};
      if (newVerdict === null) {
        delete currentRun.wrist[shot.clip];
      } else {
        currentRun.wrist[shot.clip] = newVerdict;
      }
    }

    // Update buttons on the card
    const card = document.getElementById(`wrist-card-${shot.index}`);
    if (card) {
      const btns = card.querySelectorAll(".wrist-btn");
      btns.forEach(b => {
        b.classList.toggle("selected", b.dataset.verdict === newVerdict);
      });
    }

    updateCounts();

    // Move to next shot on a choice
    if (newVerdict !== null && shot.index < currentShots.length) {
      setActiveShot(shot.index + 1);
    }

    // Save to server
    try {
      await fetch("/api/program/wrist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          started: currentRun ? currentRun.started : null,
          clip: shot.clip,
          verdict: newVerdict
        })
      });
    } catch (e) {
      console.error("Failed to save wrist call:", e);
    }
  }

  function handleKeyDown(e) {
    if (!isOpen) return;
    const box = document.getElementById("wristcheck");
    if (!box || box.hidden) return;

    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    const keyMap = { "1": "flat", "2": "bowed", "3": "cupped", "4": "can't tell" };
    if (keyMap[e.key]) {
      e.preventDefault();
      const shot = currentShots[activeShotIndex - 1];
      if (shot) {
        callWrist(shot, keyMap[e.key]);
      }
    } else if (e.key === "ArrowDown" || e.key === "j") {
      if (activeShotIndex < currentShots.length) {
        e.preventDefault();
        setActiveShot(activeShotIndex + 1);
      }
    } else if (e.key === "ArrowUp" || e.key === "k") {
      if (activeShotIndex > 1) {
        e.preventDefault();
        setActiveShot(activeShotIndex - 1);
      }
    }
  }

  // --- Document Event Bindings ---
  if (typeof document !== "undefined") {
    const toolsBtn = document.getElementById("wristcheck-btn");
    if (toolsBtn) {
      toolsBtn.onclick = () => {
        const box = document.getElementById("wristcheck");
        if (box && box.hidden) open();
        else close();
      };
    }

    const closeBtn = document.getElementById("wrist-close");
    if (closeBtn) closeBtn.onclick = () => close();

    for (const [id, a] of [["wrist-angle-dtl", "dtl"], ["wrist-angle-face", "face"]]) {
      const btn = document.getElementById(id);
      if (btn) btn.onclick = () => {
        if (angle === a) return;
        angle = a;
        try { localStorage.setItem("wrist-angle", a); } catch (e) {}
        renderShots();
      };
    }

    const copyLink = document.getElementById("wrist-copy-link");
    if (copyLink) {
      copyLink.onclick = (e) => {
        e.preventDefault();
        close();
        location.hash = "#week";
        document.getElementById("week-btn")?.click();
      };
    }

    window.addEventListener("keydown", handleKeyDown);

    function checkHash() {
      if (location.hash === "#wristcheck") {
        open();
      }
    }
    window.addEventListener("hashchange", checkHash);
    if (location.hash === "#wristcheck") {
      setTimeout(checkHash, 0);
    }
  }

  const SwingWristCheck = {
    shotsFromRun,
    getWristPoint,
    cropBoxFromWrist,
    open,
    close,
    loadData
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = SwingWristCheck;
  }
  if (typeof window !== "undefined") {
    window.SwingWristCheck = SwingWristCheck;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
