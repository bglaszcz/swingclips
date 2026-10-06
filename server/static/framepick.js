// Frame picker: side-by-side frame comparison and picking from "Where the two analyses disagree"
//
// Allows the owner to inspect server vs night pass frames side by side, nudge by single frames,
// and pick the better frame directly to pass-1 labels.
//
// Pure helpers are exported for node testing (tests/framepick.test.js).

(function () {
  /** Maps position key from night disagreements (p2-p8, takeaway, p7) to label event name.
   * Label files call impact "impact" (not p7) and have no p1 (address). */
  function labelEvent(key) {
    if (!key || key === "p1") return null;
    if (key === "p7" || key === "impact") return "impact";
    if (key === "takeaway" || /^p[2-8]$/.test(key)) return key;
    return null;
  }

  /** Night pass time in seconds = server time t + ms / 1000. */
  function nightTime(t, ms) {
    return Number((t + (ms || 0) / 1000).toFixed(6));
  }

  /** Creates a clean label document conforming to schema 1. */
  function newLabelDoc(clip, partner) {
    return {
      schema: 1,
      clip: {
        name: clip.name,
        angle: clip.angle || "face",
        strike: clip.strike ?? null,
      },
      partner: partner ? {
        name: partner.name,
        angle: partner.angle || (clip.angle === "dtl" ? "face" : "dtl"),
        strike: partner.strike ?? null,
      } : null,
      events: {},
      picked: {},
    };
  }

  /** Merges picked event time and source into a label document without modifying other fields. */
  function mergePick(doc, eventName, pickedTime, source) {
    const updated = { ...doc };
    updated.events = { ...(doc.events || {}), [eventName]: Number(pickedTime.toFixed(6)) };
    updated.picked = { ...(doc.picked || {}), [eventName]: source };
    return updated;
  }

  /** Determines the pick source: "server" | "night" | "onset" | "adjusted". */
  function pickSource(time, { serverT, nightT, onsetT } = {}) {
    if (serverT != null && Math.abs(time - serverT) < 0.0005) return "server";
    if (nightT != null && Math.abs(time - nightT) < 0.0005) return "night";
    if (onsetT != null && Math.abs(time - onsetT) < 0.0005) return "onset";
    return "adjusted";
  }

  /** Formats difference between two timestamps into frames at given fps. */
  function frameDiff(t1, t2, fps = 240) {
    const diff = Math.round(Math.abs(t1 - t2) * fps);
    return `${diff} frame${diff === 1 ? "" : "s"} apart`;
  }

  /** Filters disagreement candidates against label summary: drops p1 and labeled (clip, position) pairs. */
  function filterDisagreements(allNightSwings, clipsList, labelRows, usual = {}, minMs = 12.5) {
    const byClip = new Map((labelRows || []).filter(r => r.pass === 1 && r.clip).map(r => [r.clip, r]));
    const isLabeled = (clipName, ev) => {
      const r = byClip.get(clipName);
      if (!r) return false;
      return r.missing ? !r.missing.includes(ev) : (r.events === 8);
    };

    const out = [];
    const entries = Array.isArray(allNightSwings) ? allNightSwings : Object.entries(allNightSwings || {});
    for (const [main, angles] of entries) {
      const c = (clipsList || []).find(x => x.name === main);
      if (!c || c.excluded) continue;
      let best = null;
      for (const [angle, a] of Object.entries(angles || {})) {
        for (const [key, raw] of Object.entries(a.ms || {})) {
          if (key === "p1") continue;
          const ev = labelEvent(key);
          if (!ev) continue;
          const targetName = angle === "dtl"
            ? (c.angle === "dtl" ? c.name : c.partner)
            : (c.angle === "face" ? c.name : c.partner);
          if (targetName && isLabeled(targetName, ev)) continue;
          const u = usual[angle + key] || 0;
          const ms = raw - u;
          if (Math.abs(ms) >= minMs && (!best || Math.abs(ms) > Math.abs(best.ms)) && a.t && a.t[key] != null)
            best = { c, angle, key, ms, t: a.t[key] };
        }
      }
      if (best) out.push(best);
    }
    return out.sort((a, b) => Math.abs(b.ms) - Math.abs(a.ms));
  }

  /** Returns true when the night pass's own times (server t + ms) are out of swing order
   * (takeaway < p2 < ... < p8) on an angle. */
  function nightBroken(angles) {
    if (!angles) return false;
    const order = ["takeaway", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];
    const checkAngle = a => {
      if (!a || !a.t || !a.ms) return false;
      let prevT = -Infinity;
      for (const k of order) {
        if (a.t[k] != null && a.ms[k] != null) {
          const curT = a.t[k] + a.ms[k] / 1000;
          if (curT <= prevT) return true;
          prevT = curT;
        }
      }
      return false;
    };

    if (angles.ms && angles.t) return checkAngle(angles);
    for (const a of Object.values(angles)) {
      if (checkAngle(a)) return true;
    }
    return false;
  }

  /** Selects today's set: all big disagreements (|ms| >= bigMs, worst first), followed by
   * a balanced sample of small disagreements across different sessions and clubs before taking
   * a second from the same session/club, then by size. Rows whose position was picked enough
   * times are left out of the small sample. Total capped at opts.max (default 20). */
  function todaysSet(rows, picked, opts = {}) {
    const perPosition = opts.perPosition ?? 4;
    const max = opts.max ?? 20;
    const enoughPerPosition = opts.enoughPerPosition ?? 12;
    const bigMs = opts.bigMs ?? 50;

    // Tally picks per position/event
    const pickCounts = {};
    if (Array.isArray(picked)) {
      for (const doc of picked) {
        for (const ev of Object.keys(doc.picked || {})) {
          pickCounts[ev] = (pickCounts[ev] || 0) + 1;
        }
      }
    } else if (picked && typeof picked === "object") {
      Object.assign(pickCounts, picked);
    }

    const getPickCount = key => {
      const ev = labelEvent(key) || key;
      return pickCounts[key] || pickCounts[ev] || 0;
    };

    const bigRows = [];
    const smallRowsByPos = {};

    for (const r of (rows || [])) {
      if (Math.abs(r.ms) >= bigMs) {
        bigRows.push(r);
      } else {
        if (getPickCount(r.key) >= enoughPerPosition) continue;
        (smallRowsByPos[r.key] = smallRowsByPos[r.key] || []).push(r);
      }
    }

    // Sort big rows worst first (|ms| descending)
    bigRows.sort((a, b) => Math.abs(b.ms) - Math.abs(a.ms));

    // Balanced sample per position
    const sampledByPos = {};
    for (const [pos, candList] of Object.entries(smallRowsByPos)) {
      candList.sort((a, b) => Math.abs(b.ms) - Math.abs(a.ms));
      const selected = [];
      const seenGroups = new Set();
      const remaining = [];

      for (const r of candList) {
        const day = r.c?.recorded ? r.c.recorded.slice(0, 10) : (r.c?.day || "");
        const club = r.c?.shot?.club || r.c?.club || "";
        const gKey = `${day}_${club}`;
        if (!seenGroups.has(gKey) && selected.length < perPosition) {
          seenGroups.add(gKey);
          selected.push(r);
        } else {
          remaining.push(r);
        }
      }
      for (const r of remaining) {
        if (selected.length >= perPosition) break;
        selected.push(r);
      }
      sampledByPos[pos] = selected;
    }

    // Combine across positions up to max total cap
    const remainingSlots = Math.max(0, max - bigRows.length);
    const smallSample = [];
    let round = 0;
    let added = true;
    while (smallSample.length < remainingSlots && added) {
      added = false;
      for (const pos of Object.keys(sampledByPos)) {
        if (round < sampledByPos[pos].length) {
          smallSample.push(sampledByPos[pos][round]);
          added = true;
          if (smallSample.length >= remainingSlots) break;
        }
      }
      round++;
    }

    smallSample.sort((a, b) => Math.abs(b.ms) - Math.abs(a.ms));
    return [...bigRows, ...smallSample];
  }

  /** Tallies picks across pass-1 label documents per position and angle.
   * Returns { positions, totalPicks, summary, neitherNote }. */
  function tally(pickedDocs) {
    const ORDER = ["takeaway", "p2", "p3", "p4", "p5", "p6", "impact", "p8"];
    const byPos = {};
    for (const pos of ORDER) {
      byPos[pos] = {
        pos,
        name: POSITION_NAMES[pos] || pos.toUpperCase(),
        server: 0,
        night: 0,
        onset: 0,
        adjusted: 0,
        total: 0,
        byAngle: {
          face: { server: 0, night: 0, onset: 0, adjusted: 0, total: 0 },
          dtl: { server: 0, night: 0, onset: 0, adjusted: 0, total: 0 },
        },
      };
    }

    let grandTotal = 0;
    for (const doc of (pickedDocs || [])) {
      if (!doc || !doc.picked) continue;
      const angle = doc.clip?.angle === "dtl" ? "dtl" : "face";
      for (const [k, src] of Object.entries(doc.picked)) {
        const pos = labelEvent(k) || k;
        if (!byPos[pos]) {
          byPos[pos] = {
            pos,
            name: POSITION_NAMES[pos] || pos.toUpperCase(),
            server: 0,
            night: 0,
            onset: 0,
            adjusted: 0,
            total: 0,
            byAngle: {
              face: { server: 0, night: 0, onset: 0, adjusted: 0, total: 0 },
              dtl: { server: 0, night: 0, onset: 0, adjusted: 0, total: 0 },
            },
          };
        }
        const entry = byPos[pos];
        const angleEntry = entry.byAngle[angle] || entry.byAngle.face;
        const s = (src === "server" || src === "night" || src === "onset" || src === "adjusted") ? src : "adjusted";
        entry[s]++;
        entry.total++;
        angleEntry[s]++;
        angleEntry.total++;
        grandTotal++;
      }
    }

    // Summary sentence in plain words for positions with 5+ picks
    const sentences = [];
    for (const pos of ORDER) {
      const e = byPos[pos];
      if (e && e.total >= 5) {
        let winner = "the server";
        let count = e.server;
        if (e.night > count) {
          winner = "the night pass";
          count = e.night;
        } else if (e.onset > count) {
          winner = "club onset";
          count = e.onset;
        } else if (e.adjusted > count) {
          winner = "adjusted";
          count = e.adjusted;
        }
        if (e.server === e.night && e.server === count) {
          sentences.push(`${e.name}: server and night pass tied at ${count} of ${e.total}`);
        } else {
          sentences.push(`${e.name}: ${winner} won ${count} of ${e.total}`);
        }
      }
    }

    const summary = sentences.length > 0 ? sentences.join(". ") + "." : "too few picks yet";
    return {
      positions: byPos,
      totalPicks: grandTotal,
      summary,
      neitherNote: "Neither left out (requires night comparison times).",
    };
  }

  // ---- UI Controller ----

  let isOpen = false;
  let busy = false;
  let currentRow = null;
  let allRows = [];
  let currentIndex = -1;
  let targetClipName = "";
  let targetClip = null;
  let partnerClip = null;
  let fps = 240;
  let serverT = 0, nightT = 0, onsetT = null, existingLabelTime = null;
  let currentDoc = null;
  let pictures = []; // [{ id, title, subtitle, t, origT, isNight, pose, cardEl, canvas, timeEl, diffEl, btn }]
  let focusedIdx = 0;
  let onSavedCallback = null;

  const POSITION_NAMES = { takeaway: "Takeaway", p2: "P2", p3: "P3", p4: "P4", p5: "P5", p6: "P6", p7: "Impact", impact: "Impact", p8: "P8" };

  function fpEl(tag, props, ...kids) {
    const e = Object.assign(document.createElement(tag), props || {});
    e.append(...kids.filter(k => k != null));
    return e;
  }

  function getPanel() {
    let p = document.getElementById("framepick-panel");
    if (!p) {
      p = fpEl("div", { id: "framepick-panel", className: "t-card", hidden: true });
      const nightCard = document.getElementById("lv-night")?.closest(".t-card");
      if (nightCard && nightCard.parentNode) {
        nightCard.parentNode.insertBefore(p, nightCard);
      } else {
        const lv = document.getElementById("labelview");
        if (lv) lv.prepend(p);
      }
    }
    return p;
  }

  async function fetchPoseData(name, isNight) {
    try {
      const url = isNight ? `/api/night/pose/${encodeURIComponent(name)}` : `/api/pose/${encodeURIComponent(name)}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      return {
        frames: data.frames || [],
        clubOnset: data.clubOnset ?? null,
        clubLength: data.clubLength ?? null,
        impact: data.impact ?? null,
        ball: data.ball ?? null,
        isNight: Boolean(isNight),
      };
    } catch {
      return null;
    }
  }

  async function fetchLabelDoc(name) {
    try {
      const res = await fetch(`/api/labels/${encodeURIComponent(name)}?pass=1`, { cache: "no-store" });
      if (res.status === 404) return null;
      if (res.ok) return await res.json();
    } catch {}
    return null;
  }

  function resolveTargetClips(row) {
    const isDtl = row.angle === "dtl";
    const clipList = (typeof clips !== "undefined" && Array.isArray(clips)) ? clips : [];
    const name = isDtl
      ? (row.c.angle === "dtl" ? row.c.name : row.c.partner)
      : (row.c.angle === "face" ? row.c.name : row.c.partner);
    const clip = clipList.find(c => c.name === name) || row.c;
    const pName = clip.partner;
    const pClip = pName ? clipList.find(c => c.name === pName) : null;
    return { targetClipName: name, targetClip: clip, partnerClip: pClip };
  }

  async function open(row, rows = [], onSaved = null) {
    const ev = labelEvent(row.key);
    if (!ev) return;

    allRows = rows.length ? rows : [row];
    currentIndex = allRows.indexOf(row);
    if (currentIndex < 0) currentIndex = 0;
    onSavedCallback = onSaved;

    await loadRow(allRows[currentIndex]);
  }

  async function loadRow(row) {
    currentRow = row;
    isOpen = true;
    busy = true;

    const resolved = resolveTargetClips(row);
    targetClipName = resolved.targetClipName;
    targetClip = resolved.targetClip;
    partnerClip = resolved.partnerClip;
    fps = (typeof fpsFromName === "function" ? fpsFromName(targetClipName) : 240) || 240;

    serverT = row.t;
    nightT = nightTime(row.t, row.ms);
    onsetT = null;
    existingLabelTime = null;

    const panel = getPanel();
    panel.hidden = false;
    panel.replaceChildren(fpEl("div", { className: "fp-loading", textContent: "Loading frames and poses…" }));
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });

    // Fetch existing label doc, server pose, night pose in parallel
    const [doc, sPose, nPose] = await Promise.all([
      fetchLabelDoc(targetClipName),
      fetchPoseData(targetClipName, false),
      fetchPoseData(targetClipName, true),
    ]);

    currentDoc = doc;
    const ev = labelEvent(row.key);
    if (doc && doc.events && doc.events[ev] != null) {
      existingLabelTime = doc.events[ev];
    }
    if (row.key === "takeaway" && sPose && sPose.clubOnset != null) {
      onsetT = sPose.clubOnset;
    }

    // Build picture list
    pictures = [
      {
        id: "server",
        title: "Server",
        keyNum: "1",
        t: serverT,
        origT: serverT,
        isNight: false,
        pose: sPose,
      },
      {
        id: "night",
        title: "Night pass",
        keyNum: "2",
        t: nightT,
        origT: nightT,
        isNight: true,
        pose: nPose,
      },
    ];

    if (onsetT != null) {
      pictures.push({
        id: "onset",
        title: "Clubhead starts moving (camera)",
        subtitle: "Onset reference",
        keyNum: String(pictures.length + 1),
        t: onsetT,
        origT: onsetT,
        isNight: false,
        pose: sPose,
      });
    }

    if (existingLabelTime != null) {
      pictures.push({
        id: "label",
        title: "Your label",
        subtitle: "Existing label",
        keyNum: String(pictures.length + 1),
        t: existingLabelTime,
        origT: existingLabelTime,
        isNight: false,
        pose: sPose,
      });
    }

    focusedIdx = 0;
    busy = false;
    renderUI();
    prefetchNext();
  }

  function prefetchNext() {
    if (typeof Image === "undefined") return;
    if (currentIndex + 1 < allRows.length) {
      const next = allRows[currentIndex + 1];
      if (next && next.c) {
        const nextTarget = next.angle === "dtl"
          ? (next.c.angle === "dtl" ? next.c.name : next.c.partner)
          : (next.c.angle === "face" ? next.c.name : next.c.partner);
        if (nextTarget) {
          const img1 = new Image();
          img1.src = `/api/still/${encodeURIComponent(nextTarget)}?t=${next.t}`;
          const nTime = nightTime(next.t, next.ms);
          const img2 = new Image();
          img2.src = `/api/still/${encodeURIComponent(nextTarget)}?t=${nTime}`;
        }
      }
    }
  }

  function renderUI() {
    const panel = getPanel();
    const posName = POSITION_NAMES[currentRow.key] || currentRow.key.toUpperCase();
    const angleText = currentRow.angle === "dtl" ? "down the line" : "face-on";
    const clubText = currentRow.c.shot && typeof clubName === "function" ? " · " + clubName(currentRow.c.shot.club) : "";
    const whenText = typeof fmtWhen === "function" ? fmtWhen(currentRow.c.recorded) : "";
    const diffText = `${frameDiff(serverT, nightT, fps)} (${Math.round(Math.abs(currentRow.ms))} ms apart)`;

    const headLeft = fpEl("div", { className: "fp-head-left" },
      fpEl("div", { className: "fp-title", textContent: `${posName} · ${whenText}${clubText} (${angleText})` }),
      fpEl("div", { className: "fp-subtitle", textContent: `Server vs Night pass: ${diffText}` })
    );

    const statusEl = fpEl("span", { className: "fp-status", id: "fp-status-msg" });
    const closeBtn = fpEl("button", { className: "small", textContent: "Close (Esc)", title: "Close picker" });
    closeBtn.onclick = () => close();

    const head = fpEl("div", { className: "fp-header" }, headLeft, fpEl("div", { className: "fp-head-right" }, statusEl, closeBtn));

    // Pictures grid
    const grid = fpEl("div", { className: "fp-grid" });

    pictures.forEach((pic, idx) => {
      const card = fpEl("div", { className: "fp-card" + (idx === focusedIdx ? " focused" : "") });
      card.onclick = () => focusPicture(idx);

      const titleEl = fpEl("span", { className: "fp-card-title", textContent: `${pic.title} (${pic.keyNum})` });
      const badgeEl = pic.subtitle ? fpEl("span", { className: "fp-card-sub", textContent: pic.subtitle }) : null;
      const cardHead = fpEl("div", { className: "fp-card-head" }, titleEl, badgeEl);

      const canvas = fpEl("canvas");
      const canvasBox = fpEl("div", { className: "fp-canvas-box" }, canvas);

      const prevBtn = fpEl("button", { className: "small icon", textContent: "‹", title: "Step 1 frame earlier ([)" });
      prevBtn.onclick = (e) => { e.stopPropagation(); focusPicture(idx); step(idx, -1); };

      const timeEl = fpEl("span", { className: "fp-time", textContent: pic.t.toFixed(4) + " s" });

      const nextBtn = fpEl("button", { className: "small icon", textContent: "›", title: "Step 1 frame later (])" });
      nextBtn.onclick = (e) => { e.stopPropagation(); focusPicture(idx); step(idx, 1); };

      const controls = fpEl("div", { className: "fp-controls" }, prevBtn, timeEl, nextBtn);

      const pickBtn = fpEl("button", { className: "primary fp-pick-btn", textContent: `This one (${pic.keyNum})` });
      pickBtn.onclick = (e) => { e.stopPropagation(); focusPicture(idx); pick(idx); };

      card.append(cardHead, canvasBox, controls, pickBtn);
      grid.append(card);

      pic.cardEl = card;
      pic.canvas = canvas;
      pic.timeEl = timeEl;
      pic.pickBtn = pickBtn;

      renderCanvas(pic);
    });

    // Bottom actions
    const neitherBtn = fpEl("button", { className: "small", textContent: "Neither, label it myself (N)" });
    neitherBtn.onclick = () => neither();

    const skipBtn = fpEl("button", { className: "small", textContent: "Skip (S)" });
    skipBtn.onclick = () => skip();

    const legend = fpEl("span", { className: "hint", textContent: "1/2/3: pick · [ ]: step focused · N: neither · S: skip · Esc: close" });

    const bottom = fpEl("div", { className: "fp-bottom-actions" },
      fpEl("div", { style: "display: flex; gap: 8px; align-items: center;" }, neitherBtn, skipBtn),
      legend
    );

    panel.replaceChildren(head, grid, bottom);
  }

  function focusPicture(idx) {
    focusedIdx = idx;
    pictures.forEach((p, i) => {
      if (p.cardEl) p.cardEl.classList.toggle("focused", i === focusedIdx);
    });
  }

  function renderCanvas(pic) {
    const canvas = pic.canvas;
    if (!canvas) return;
    const stillUrl = `/api/still/${encodeURIComponent(targetClipName)}?t=${pic.t.toFixed(6)}`;
    const img = new Image();
    img.onload = () => {
      canvas.width = img.naturalWidth || 720;
      canvas.height = img.naturalHeight || 1280;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      if (pic.pose && pic.pose.frames && pic.pose.frames.length) {
        const p = {
          ...pic.pose,
          video: { videoWidth: canvas.width, videoHeight: canvas.height },
          isNight: Boolean(pic.isNight),
        };
        const frame = (typeof frameAtTime === "function") ? frameAtTime(pic.t, p) : null;
        if (frame && typeof drawPose === "function") {
          const r = { x: 0, y: 0, w: canvas.width, h: canvas.height };
          drawPose(ctx, frame, r, false, p);
        }
      }
    };
    img.src = stillUrl;
  }

  function step(picIdx, deltaFrames) {
    if (busy || picIdx < 0 || picIdx >= pictures.length) return;
    const pic = pictures[picIdx];
    pic.t = Math.max(0, Number((pic.t + deltaFrames / fps).toFixed(6)));
    if (pic.timeEl) pic.timeEl.textContent = pic.t.toFixed(4) + " s";
    renderCanvas(pic);
  }

  async function pick(picIdx) {
    if (busy || picIdx < 0 || picIdx >= pictures.length) return;
    const pic = pictures[picIdx];
    const ev = labelEvent(currentRow.key);
    if (!ev) return;

    if (existingLabelTime != null && pic.id !== "label") {
      const msg = `Replace existing ${ev.toUpperCase()} label at ${existingLabelTime.toFixed(4)} s with ${pic.t.toFixed(4)} s?`;
      if (typeof confirm === "function" && !confirm(msg)) return;
    }

    busy = true;
    const statusEl = document.getElementById("fp-status-msg");
    if (statusEl) statusEl.textContent = "Saving…";

    const source = pickSource(pic.t, { serverT, nightT, onsetT });
    const baseDoc = currentDoc || newLabelDoc(targetClip, partnerClip);
    const docToSave = mergePick(baseDoc, ev, pic.t, source);

    try {
      const res = await fetch(`/api/labels/${encodeURIComponent(targetClipName)}?pass=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(docToSave),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || res.statusText);
      }

      currentDoc = docToSave;
      const posName = POSITION_NAMES[currentRow.key] || currentRow.key.toUpperCase();
      const savedText = `Saved: ${posName} at ${pic.t.toFixed(4)} s`;
      if (statusEl) statusEl.textContent = savedText;
      if (typeof showToast === "function") showToast(savedText);

      if (typeof onSavedCallback === "function") {
        onSavedCallback(targetClipName, ev, docToSave);
      }

      setTimeout(() => {
        advance(1);
      }, 600);
    } catch (err) {
      if (statusEl) statusEl.textContent = `Error: ${err.message}`;
      busy = false;
    }
  }

  function advance(delta) {
    const nextIdx = currentIndex + delta;
    if (nextIdx >= 0 && nextIdx < allRows.length) {
      currentIndex = nextIdx;
      loadRow(allRows[currentIndex]);
    } else {
      const statusEl = document.getElementById("fp-status-msg");
      if (statusEl) statusEl.textContent = "All comparisons done!";
      setTimeout(() => close(), 1200);
    }
  }

  function skip() {
    advance(1);
  }

  function neither() {
    const row = currentRow;
    close();
    if (row && typeof openForLabeling === "function") {
      openForLabeling(row.c.name, { angle: row.angle, t: row.t });
    }
  }

  function close() {
    isOpen = false;
    busy = false;
    const panel = document.getElementById("framepick-panel");
    if (panel) {
      panel.hidden = true;
      panel.replaceChildren();
    }
  }

  // Global keydown handler
  if (typeof document !== "undefined") {
    document.addEventListener("keydown", (e) => {
      if (!isOpen) return;
      if (e.target.closest && e.target.closest("input:not([type=range]), select, textarea")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const k = e.key.toLowerCase();
      if (k === "escape") {
        e.preventDefault();
        close();
        return;
      }
      if (k === "s") {
        e.preventDefault();
        skip();
        return;
      }
      if (k === "n") {
        e.preventDefault();
        neither();
        return;
      }
      if (k === "[") {
        e.preventDefault();
        step(focusedIdx, -1);
        return;
      }
      if (k === "]") {
        e.preventDefault();
        step(focusedIdx, 1);
        return;
      }
      if (k === "1" && pictures[0]) {
        e.preventDefault();
        pick(0);
        return;
      }
      if (k === "2" && pictures[1]) {
        e.preventDefault();
        pick(1);
        return;
      }
      if (k === "3" && pictures[2]) {
        e.preventDefault();
        pick(2);
        return;
      }
      if (k === "4" && pictures[3]) {
        e.preventDefault();
        pick(3);
        return;
      }
    });
  }

  const FramePicker = {
    labelEvent,
    nightTime,
    newLabelDoc,
    mergePick,
    pickSource,
    frameDiff,
    filterDisagreements,
    nightBroken,
    todaysSet,
    tally,
    open,
    close,
    step,
    pick,
    skip,
    neither,
  };

  if (typeof window !== "undefined") {
    window.FramePicker = FramePicker;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = FramePicker;
  }
})();
