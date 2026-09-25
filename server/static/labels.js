// Labeling mode, for the scorecard (server/eval.py): mark by hand when each key moment happens, and
// where the joints, the club and the ball are, on the swing that's open. Press L (or Label) to start.
//
// Each clip's labels are saved as you go to /api/labels/<clip> (?pass=2 for a second pass, done
// days later without looking at the first, which measures how consistent the labels themselves are).
// Times are the start of the frame on screen, from the pose file, since phone clips drop frames;
// positions are shares of the upright picture, like the pose file's.
//
// Uses the review page's own state and helpers (index.html): video, video2, pose, partner, current,
// clips, positions, overlays, frameIndexAt, fitRect, jumpTo, partnerOffset, syncPartner, setSkeleton, setOverlay.
(function () {
  const EVENTS = [
    ["takeaway", "Takeaway", "T"], ["p2", "P2 shaft parallel back", "2"], ["p3", "P3 lead arm parallel back", "3"],
    ["p4", "P4 top", "4"], ["p5", "P5 lead arm parallel down", "5"], ["p6", "P6 shaft parallel down", "6"],
    ["impact", "P7 impact", "7"], ["p8", "P8 shaft parallel through", "8"],
  ];
  const EVENT_KEYS = { t: "takeaway", 2: "p2", 3: "p3", 4: "p4", 5: "p5", 6: "p6", 7: "impact", i: "impact", 8: "p8" };
  // What gets clicked on a frame, in order. Left and right are the golfer's own.
  const POINTS = [
    ["l_shoulder", "Left shoulder", "LS"], ["l_elbow", "Left elbow", "LE"], ["l_wrist", "Left wrist", "LW"],
    ["r_shoulder", "Right shoulder", "RS"], ["r_elbow", "Right elbow", "RE"], ["r_wrist", "Right wrist", "RW"],
    ["l_hip", "Left hip", "LH"], ["r_hip", "Right hip", "RH"],
    ["grip", "Club: grip end", "G"], ["hosel", "Club: hosel", "Ho"], ["head", "Club: clubhead", "CH"],
  ];
  const LEFT_COLOR = "#22d3ee", RIGHT_COLOR = "#f472b6", CLUB_COLOR = "#facc15", BALL_COLOR = "#f97316";
  const SAVE_DELAY_MS = 500;

  const panel = document.getElementById("labelpanel");
  const button = document.getElementById("label-btn");
  const stages = document.getElementById("stages");

  let on = false;
  let labelPass = 1;
  let active = "main";          // which video clicks and keys go to: "main" or "dtl"
  let target = 0;               // index into POINTS of the next point to click
  let ballArmed = false;        // the next click places the ball
  let shownBefore = null;       // the tracker's overlays, hidden while labeling so they don't sway the labels
  let lastFrameKey = null;
  let labeledCount = null;
  let message = "";
  // `${clip}|${pass}` -> {doc, state: "loading" | "ready" | "saving" | "saved" | "error", timer}
  const docs = new Map();

  // ---- The clip on screen ----

  function activeClip() {
    if (active === "dtl" && partner) return { name: partner.name, pose: partner.pose, video: video2 };
    return { name: current, pose, video };
  }

  function clipInfo(name) {
    const c = clips.find(c => c.name === name);
    return c ? { name, angle: c.angle || "face", strike: c.strike ?? null } : { name, angle: "face", strike: null };
  }

  /** The start of the frame on screen in the active clip (s), or null before it's analyzed. */
  function frameTime() {
    const a = activeClip();
    if (!a.pose || !a.pose.frames.length) return null;
    return a.pose.frames[frameIndexAt(a.video.currentTime, a.pose)].t;
  }
  const frameKey = t => t.toFixed(6);

  // ---- Label files ----

  function entry(name) {
    if (!name) return null;
    const key = `${name}|${labelPass}`;
    let e = docs.get(key);
    if (!e) {
      e = { doc: null, state: "loading", timer: null, pass: labelPass };
      docs.set(key, e);
      fetch(`/api/labels/${encodeURIComponent(name)}?pass=${labelPass}`)
        .then(res => res.status === 404 ? null : res.ok ? res.json() : Promise.reject(new Error(res.statusText)))
        .then(doc => {
          e.doc = doc || { schema: 1, clip: clipInfo(name), partner: null, events: {}, ball: null, frames: {} };
          e.state = "ready";
        })
        .catch(err => { e.state = "error"; message = `Couldn't load labels: ${err.message}`; })
        .finally(() => { render(); redraw(); });
    }
    return e;
  }

  function activeDoc() {
    const e = entry(activeClip().name);
    return e && e.doc ? e : null;
  }

  /** Saves a clip's labels a moment after the last change. */
  function changed(e) {
    const c = clips.find(c => c.name === e.doc.clip.name);
    e.doc.clip = clipInfo(e.doc.clip.name);
    e.doc.partner = c && c.partner ? clipInfo(c.partner) : null;
    e.changes = (e.changes || 0) + 1;
    e.state = "saving";
    clearTimeout(e.timer);
    // One save at a time, each sending the labels as they are by then, so they land in order.
    e.timer = setTimeout(() => { e.saving = (e.saving || Promise.resolve()).then(() => save(e)); }, SAVE_DELAY_MS);
    render();
    redraw();
  }

  async function save(e) {
    const name = e.doc.clip.name, changes = e.changes;
    try {
      const res = await fetch(`/api/labels/${encodeURIComponent(name)}?pass=${e.pass}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(e.doc),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
      if (e.changes === changes) e.state = "saved";
      refreshCount();
    } catch (err) {
      e.state = "error";
      message = `Not saved: ${err.message}`;
    }
    render();
  }

  function refreshCount() {
    fetch("/api/labels").then(r => r.json()).then(l => { labeledCount = (l[String(labelPass)] || []).length; render(); })
      .catch(() => {});
  }

  // ---- Suggested frames ----

  /** About a dozen frames worth labeling: spread over the swing, most of them in the downswing. */
  function suggestions() {
    const a = activeClip();
    if (!a.pose || !a.pose.frames.length) return [];
    const at = k => positions.find(p => p.key === k)?.t ?? null;
    const mid = (x, y) => x != null && y != null ? (x + y) / 2 : null;
    const plus = (x, d) => x != null ? x + d : null;
    let times;
    if (positions.length) {
      const [p1, p2, p3, p4, p5, p6, p7, p8] = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"].map(at);
      times = [p1, p2, p3, p4, p5, mid(p5, p6), p6, mid(p6, p7), p7, plus(p7, 0.03), p8, plus(p8, 0.15)];
    } else {
      const c = clips.find(c => c.name === current);
      const strike = c && c.strike != null ? c.strike : 2.0;
      times = Array.from({ length: 12 }, (_, k) => strike - 1.2 + k * (1.6 / 11));
    }
    const idx = new Set();
    for (const t of times) {
      if (t == null) continue;
      idx.add(frameIndexAt(a.video === video2 ? t + partnerOffset() : t, a.pose));
    }
    return [...idx].sort((x, y) => x - y);
  }

  function frameDone(doc, t) {
    const pts = doc.frames[frameKey(t)];
    return !!pts && POINTS.every(([k]) => pts[k]);
  }

  /** Shows frame i of the active clip. Down the line, the face-on video is moved so that the synced
   *  down-the-line one lands on it. */
  function showFrame(i) {
    const a = activeClip();
    const f = a.pose.frames;
    i = Math.max(0, Math.min(f.length - 1, i));
    const t = i + 1 < f.length ? (f[i].t + f[i + 1].t) / 2 : f[i].t + 0.001;
    if (a.video === video) { jumpTo(i); return; }
    video.pause();
    video.currentTime = Math.max(0, t - partnerOffset());
    syncPartner();
  }

  // ---- Actions ----

  function setEvent(key) {
    const e = activeDoc(), t = frameTime();
    if (!e || t == null) return;
    const label = EVENTS.find(ev => ev[0] === key)[1];
    if (e.doc.events[key] === t) {
      delete e.doc.events[key];
      message = `${label} cleared.`;
    } else {
      e.doc.events[key] = t;
      message = `${label} at ${t.toFixed(3)} s.`;
    }
    changed(e);
  }

  /** The first point not yet done on this frame, from `from` on (wrapping round). */
  function nextTarget(pts, from) {
    for (let k = 0; k < POINTS.length; k++) {
      const j = (from + k) % POINTS.length;
      if (!pts || !pts[POINTS[j][0]]) return j;
    }
    return from % POINTS.length;
  }

  function setPoint(value) {
    const e = activeDoc(), t = frameTime();
    if (!e || t == null) return;
    const key = frameKey(t);
    const pts = e.doc.frames[key] = e.doc.frames[key] || {};
    pts[POINTS[target][0]] = value;
    target = nextTarget(pts, target + 1);
    changed(e);
  }

  function clearPoint() {
    const e = activeDoc(), t = frameTime();
    if (!e || t == null) return;
    const key = frameKey(t), pts = e.doc.frames[key];
    if (!pts) return;
    // Back up to the last point placed, if the current one isn't placed yet.
    if (!pts[POINTS[target][0]]) {
      for (let k = 1; k <= POINTS.length; k++) {
        const j = (target - k + POINTS.length) % POINTS.length;
        if (pts[POINTS[j][0]]) { target = j; break; }
      }
    }
    delete pts[POINTS[target][0]];
    if (!Object.keys(pts).length) delete e.doc.frames[key];
    changed(e);
  }

  function onClick(ev, which) {
    if (!on) return;
    if (which !== active) { setActive(which); return; }
    const a = activeClip();
    if (!a.pose || !a.video.videoWidth) return;
    const dpr = window.devicePixelRatio || 1;
    const c = ev.currentTarget;
    const r = fitRect(c.width, c.height, a.video);
    const x = (ev.offsetX * dpr - r.x) / r.w, y = (ev.offsetY * dpr - r.y) / r.h;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    const xy = { x: Math.round(x * 1e5) / 1e5, y: Math.round(y * 1e5) / 1e5 };
    if (ballArmed) {
      const e = activeDoc();
      if (!e) return;
      e.doc.ball = xy;
      ballArmed = false;
      message = "Ball placed.";
      changed(e);
      return;
    }
    setPoint(ev.shiftKey ? { ...xy, blur: true } : xy);
  }

  function setActive(which) {
    if (which === "dtl" && !partner) return;
    active = which;
    lastFrameKey = null;
    render();
    redraw();
  }

  function setPass(n) {
    labelPass = n;
    lastFrameKey = null;
    refreshCount();
    render();
    redraw();
  }

  function setOn(v) {
    if (v && (!current || viewer.hidden)) return;
    on = v;
    stages.classList.toggle("labeling", on);
    panel.hidden = !on;
    button.classList.toggle("on", on);
    if (on) {
      video.pause();
      if (!partner) active = "main";
      shownBefore = { skeleton: showSkeleton, ...overlays };
      if (showSkeleton) setSkeleton(false);
      for (const k in overlays) if (overlays[k]) setOverlay(k, false);
      message = "";
      refreshCount();
    } else if (shownBefore) {
      if (shownBefore.skeleton) setSkeleton(true);
      for (const k in overlays) if (shownBefore[k]) setOverlay(k, true);
      shownBefore = null;
    }
    render();
    redraw();
  }

  // ---- Drawing over the video ----

  function drawOn(ctx, r, which, i) {
    if (!on) return;
    const name = which === "dtl" ? partner && partner.name : current;
    const p = which === "dtl" ? partner && partner.pose : pose;
    const e = entry(name);
    if (!p || !e || !e.doc) return;
    const t = p.frames[i].t;
    const pts = e.doc.frames[frameKey(t)] || {};
    const toPx = q => ({ x: r.x + q.x * r.w, y: r.y + q.y * r.h });
    const size = Math.max(5, r.w / 90), font = Math.max(12, r.w / 40);
    ctx.save();
    ctx.lineWidth = Math.max(1.5, r.w / 300);
    ctx.font = `600 ${font}px system-ui, sans-serif`;
    const club = ["grip", "hosel", "head"].map(k => pts[k]).filter(q => q && q.x != null).map(toPx);
    if (club.length > 1) {
      ctx.strokeStyle = CLUB_COLOR;
      ctx.beginPath();
      club.forEach((q, k) => k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y));
      ctx.stroke();
    }
    for (const [key, , tag] of POINTS) {
      const q = pts[key];
      if (!q || q.x == null) continue;
      const at = toPx(q);
      ctx.strokeStyle = ctx.fillStyle = key.startsWith("l_") ? LEFT_COLOR : key.startsWith("r_") ? RIGHT_COLOR : CLUB_COLOR;
      ctx.setLineDash(q.blur ? [4, 3] : []);
      ctx.beginPath();
      ctx.arc(at.x, at.y, size, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText(tag, at.x + size + 2, at.y - size);
    }
    if (e.doc.ball) {
      const b = toPx(e.doc.ball);
      ctx.strokeStyle = BALL_COLOR;
      ctx.beginPath();
      ctx.arc(b.x, b.y, size * 1.4, 0, 2 * Math.PI);
      ctx.stroke();
    }
    const here = EVENTS.filter(([k]) => e.doc.events[k] === t).map(([, label]) => label);
    if (here.length) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
      const text = here.join(", ");
      ctx.fillRect(r.x + 8, r.y + r.h - font * 2.4, ctx.measureText(text).width + font, font * 1.8);
      ctx.fillStyle = "#fff";
      ctx.fillText(text, r.x + 8 + font / 2, r.y + r.h - font * 1.05);
    }
    if (which === active) {
      ctx.strokeStyle = CLUB_COLOR;
      ctx.lineWidth = 3;
      ctx.strokeRect(r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3);
    }
    ctx.restore();
    if (which === active && frameKey(t) !== lastFrameKey) {
      lastFrameKey = frameKey(t);
      target = nextTarget(pts, 0);
      render();
    }
  }

  // ---- The panel ----

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter(c => c != null));
    return node;
  }

  function chip(text, opts = {}) {
    const b = el("button", { className: "small" + (opts.on ? " on" : "") + (opts.done ? " done" : ""), textContent: text, title: opts.title || "" });
    if (opts.onclick) b.onclick = opts.onclick; else b.disabled = true;
    return b;
  }

  function render() {
    if (!on) return;
    const a = activeClip();
    const e = entry(a.name);
    const doc = e && e.doc;
    const t = frameTime();
    const kids = [];

    const state = !e ? "" : { loading: "Loading…", ready: "", saving: "Saving…", saved: "Saved", error: "Not saved" }[e.state];
    kids.push(el("div", { className: "lp-row" },
      el("strong", { textContent: "Labeling" }),
      el("span", { className: "lp-label", textContent: "Pass" }),
      ...[1, 2].map(n => chip(String(n), { on: labelPass === n, onclick: () => setPass(n),
        title: n === 2 ? "A second pass, days later, without looking at the first: measures your own consistency" : "" })),
      partner ? el("span", { className: "lp-label", textContent: "Angle (D)" }) : null,
      partner ? chip("Face-on", { on: active === "main", onclick: () => setActive("main") }) : null,
      partner ? chip("Down the line", { on: active === "dtl", onclick: () => setActive("dtl") }) : null,
      el("span", { className: "lp-state" + (e && e.state === "error" ? " bad" : ""), textContent: state }),
      el("span", { className: "grow" }),
      labeledCount != null ? el("span", { className: "lp-label", textContent: `${labeledCount} clip(s) labeled in pass ${labelPass}` }) : null,
      chip("Done (L)", { onclick: () => setOn(false) })));

    if (!a.pose) {
      kids.push(el("div", { className: "note", textContent: "This clip hasn't been analyzed yet: labels are tied to its analyzed frames, so wait for it." }));
      panel.replaceChildren(...kids);
      return;
    }
    if (!doc) {
      panel.replaceChildren(...kids);
      return;
    }

    kids.push(el("div", { className: "lp-row" },
      el("span", { className: "lp-label", textContent: "Moments" }),
      ...EVENTS.map(([k, label, key]) => {
        const v = doc.events[k];
        const i = v == null ? null : frameIndexAt(v, a.pose);
        return chip(`${key}  ${v == null ? "–" : v.toFixed(3)}`, {
          on: v != null && v === t, done: v != null, title: `${label} (key ${key}${k === "impact" ? " or I" : ""})`,
          onclick: i == null ? () => setEvent(k) : () => showFrame(i),
        });
      })));

    const pts = t == null ? {} : doc.frames[frameKey(t)] || {};
    kids.push(el("div", { className: "lp-row" },
      el("span", { className: "lp-label", textContent: "This frame" }),
      ...POINTS.map(([k, label, tag], j) => {
        const q = pts[k];
        const text = tag + (q ? q.hidden ? " ✕" : q.blur ? " ~" : " ✓" : "");
        return chip(text, { on: j === target && !ballArmed, done: !!q, title: label, onclick: () => { target = j; ballArmed = false; render(); } });
      }),
      chip(doc.ball ? "Ball ✓" : "Ball", { on: ballArmed, done: !!doc.ball, title: "B, then click the ball's middle (at address)",
        onclick: () => { ballArmed = !ballArmed; render(); } })));
    const next = ballArmed ? "the ball's middle" : POINTS[target][1];
    kids.push(el("div", { className: "lp-prompt" }, "Click: ", el("b", { textContent: next })));

    const sugg = suggestions();
    const here = frameIndexAt(a.video.currentTime, a.pose);
    kids.push(el("div", { className: "lp-row" },
      el("span", { className: "lp-label", textContent: "Suggested frames ([ ])" }),
      ...sugg.map((i, k) => chip(String(k + 1), { on: i === here, done: frameDone(doc, a.pose.frames[i].t),
        title: `Frame ${i + 1} at ${a.pose.frames[i].t.toFixed(3)} s`, onclick: () => showFrame(i) }))));

    kids.push(el("div", { className: "note" },
      "Keys: T, 2-8 (7 or I = impact) mark the moment on the frame on screen (again to clear) · click a point · ",
      "Shift+click if it's a blur · X = can't see it · Tab = skip · Backspace = undo · B = ball · [ ] = suggested frames · ",
      "← → = frame" + (partner ? " (of the angle being labeled) · D = switch angle" : "") + ". ",
      "The tracker's skeleton and numbers are hidden while you label, so they don't sway you; they come back when you're done. ",
      "Left and right are the golfer's own: face-on, the golfer's left is on the picture's right. ",
      "Takeaway = the first frame the club moves; in a blurred frame put the clubhead in the middle of the streak."));
    if (message) kids.push(el("div", { className: "lp-msg", textContent: message }));
    panel.replaceChildren(...kids);
  }

  // ---- Keys and clicks ----

  function stepActive(n) {
    const a = activeClip();
    if (!a.pose) return;
    showFrame(frameIndexAt(a.video.currentTime, a.pose) + n);
  }

  window.addEventListener("keydown", ev => {
    if (ev.target.closest && ev.target.closest("input, select, textarea")) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    const handled = () => { ev.preventDefault(); ev.stopImmediatePropagation(); };
    if (!on) {
      if (k === "l" && current && !viewer.hidden) { handled(); setOn(true); }
      return;
    }
    if (viewer.hidden) { setOn(false); return; }   // Trends or Progress took over the page
    if (k === "l" || k === "Escape") { handled(); setOn(false); return; }
    if ((k === "ArrowLeft" || k === "ArrowRight") && active === "dtl") { handled(); stepActive(k === "ArrowLeft" ? -1 : 1); return; }
    if (EVENT_KEYS[k]) { handled(); setEvent(EVENT_KEYS[k]); return; }
    if (k === "x") { handled(); setPoint({ hidden: true }); return; }
    if (k === "Tab") { handled(); target = (target + (ev.shiftKey ? POINTS.length - 1 : 1)) % POINTS.length; render(); return; }
    if (k === "Backspace") { handled(); clearPoint(); return; }
    if (k === "b") { handled(); ballArmed = !ballArmed; render(); return; }
    if (k === "d") { handled(); setActive(active === "dtl" ? "main" : "dtl"); return; }
    if (k === "[" || k === "]") {
      handled();
      const a = activeClip();
      if (!a.pose) return;
      const here = frameIndexAt(a.video.currentTime, a.pose), list = suggestions();
      const to = k === "]" ? list.find(i => i > here) : [...list].reverse().find(i => i < here);
      if (to != null) showFrame(to);
    }
  }, true);

  document.getElementById("overlay").addEventListener("click", ev => onClick(ev, "main"));
  document.getElementById("overlay2").addEventListener("click", ev => onClick(ev, "dtl"));
  button.onclick = () => setOn(!on);

  window.Labels = {
    drawOn,
    /** Another swing was opened: labels follow its clips, starting on the face-on angle. */
    opened() { active = "main"; lastFrameKey = null; ballArmed = false; message = ""; render(); },
  };
})();
