// Drawing on the swing videos, as coach video apps do (V1, OnForm, CoachNow): a line (with its angle to
// level), an angle from three points, a circle, a box and free hand, in a few colours, on either camera
// angle. Drawings stay put while the video plays (draw the shaft's line at address, then play to see the
// club come back to it) and are kept per clip in this browser (localStorage), so a swing opens with them.
// The page calls SwingDraw.paint(ctx, which, rect) at the end of each overlay draw, and routes the
// overlay canvases' pointer events here while drawing is on (#stages.drawing).
(function (root) {
  const TOOLS = [
    ["line", "Line", "A straight line, with its angle to level (drag)"],
    ["angle", "Angle", "Two arms from one point: drag the first arm, then tap where the second ends"],
    ["circle", "Circle", "A circle from its centre (drag)"],
    ["box", "Box", "A box from corner to corner (drag)"],
    ["free", "Free hand", "Draw freely (drag)"],
  ];
  const COLORS = [["#facc15", "Yellow"], ["#f43f5e", "Red"], ["#38bdf8", "Blue"], ["#ffffff", "White"]];
  const KEY_PREFIX = "drawings:";
  const MAX_SHAPES = 60;

  // ---- Pure helpers (tested in tests/draw.test.js) ----

  /** A line's angle to level in degrees (0 = level, 90 = upright), from points in 0..1 of a w x h picture. */
  function lineAngle(p, q, w, h) {
    const dx = (q[0] - p[0]) * w, dy = (q[1] - p[1]) * h;
    if (!dx && !dy) return null;
    let a = Math.abs(Math.atan2(-dy, dx) * 180 / Math.PI);
    if (a > 90) a = 180 - a;
    return a;
  }

  /** The angle at vertex v between the arms to a and b, in degrees (0..180). */
  function jointAngle(a, v, b, w, h) {
    const ax = (a[0] - v[0]) * w, ay = (a[1] - v[1]) * h, bx = (b[0] - v[0]) * w, by = (b[1] - v[1]) * h;
    const na = Math.hypot(ax, ay), nb = Math.hypot(bx, by);
    if (!na || !nb) return null;
    const c = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (na * nb)));
    return Math.acos(c) * 180 / Math.PI;
  }

  /** Keeps a free-hand stroke light: drops points closer than `min` (in 0..1 units) to the last kept one. */
  function thin(pts, min) {
    const out = [];
    for (const p of pts) {
      const last = out[out.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= min) out.push(p);
    }
    const end = pts[pts.length - 1];
    if (end && out[out.length - 1] !== end) out.push(end);
    return out;
  }

  /** Whether a saved shape is one this file can draw (localStorage can hold anything). */
  function valid(s) {
    if (!s || !TOOLS.some(t => t[0] === s.type) || !Array.isArray(s.pts)) return false;
    const need = { line: 2, angle: 3, circle: 2, box: 2, free: 2 }[s.type];
    return s.pts.length >= need && s.pts.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
  }

  function load(storage, clip) {
    if (!clip) return [];
    try {
      const raw = storage && storage.getItem(KEY_PREFIX + clip);
      const got = raw ? JSON.parse(raw) : [];
      return Array.isArray(got) ? got.filter(valid).slice(-MAX_SHAPES) : [];
    } catch { return []; }
  }

  function save(storage, clip, shapes) {
    if (!clip || !storage) return;
    try {
      if (shapes.length) storage.setItem(KEY_PREFIX + clip, JSON.stringify(shapes.slice(-MAX_SHAPES)));
      else storage.removeItem(KEY_PREFIX + clip);
    } catch {}
  }

  // ---- Drawing ----

  const fmtDeg = a => `${Math.round(a)}°`;

  function label(ctx, text, x, y, lw) {
    ctx.save();
    ctx.font = `600 ${Math.max(11, Math.round(lw * 5))}px system-ui, sans-serif`;
    const w = ctx.measureText(text).width, pad = lw * 1.5, h = Math.max(11, lw * 5) + pad * 2;
    ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
    ctx.fillRect(x - w / 2 - pad, y - h / 2, w + pad * 2, h);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y + 0.5);
    ctx.restore();
  }

  /** One shape onto ctx; r = where the picture sits on the canvas ({x, y, w, h}). */
  function paintShape(ctx, s, r, lw) {
    const P = p => [r.x + p[0] * r.w, r.y + p[1] * r.h];
    ctx.save();
    ctx.strokeStyle = s.color || COLORS[0][0];
    ctx.lineWidth = lw;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
    ctx.shadowBlur = lw;
    const pts = s.pts.map(P);
    ctx.beginPath();
    if (s.type === "line" || s.type === "free") {
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.stroke();
    } else if (s.type === "angle") {
      ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]);
      if (pts[2]) ctx.lineTo(pts[2][0], pts[2][1]);
      ctx.stroke();
    } else if (s.type === "circle") {
      const rad = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
      ctx.arc(pts[0][0], pts[0][1], rad, 0, Math.PI * 2);
      ctx.stroke();
    } else if (s.type === "box") {
      ctx.rect(Math.min(pts[0][0], pts[1][0]), Math.min(pts[0][1], pts[1][1]),
               Math.abs(pts[1][0] - pts[0][0]), Math.abs(pts[1][1] - pts[0][1]));
      ctx.stroke();
    }
    ctx.restore();
    // The number a coach reads off it.
    if (s.type === "line") {
      const a = lineAngle(s.pts[0], s.pts[1], r.w, r.h);
      if (a != null) label(ctx, fmtDeg(a), (pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2 - lw * 6, lw);
    } else if (s.type === "angle" && s.pts[2]) {
      const a = jointAngle(s.pts[0], s.pts[1], s.pts[2], r.w, r.h);
      if (a != null) label(ctx, fmtDeg(a), pts[1][0], pts[1][1] - lw * 7, lw);
    }
  }

  // ---- State and the page ----

  const state = {
    on: false, tool: "line", color: COLORS[0][0],
    clips: { main: null, dtl: null },      // clip name per angle
    shapes: { main: [], dtl: [] },
    undo: [],                               // [which, shapes before]
    live: null,                             // the shape being drawn: {which, shape, stage}
    opts: null,
  };

  const storage = () => (state.opts && state.opts.storage) || (typeof localStorage !== "undefined" ? localStorage : null);

  function changed(which) {
    save(storage(), state.clips[which], state.shapes[which]);
    updateBar();
    if (state.opts && state.opts.redraw) state.opts.redraw();
  }

  function remember(which) {
    state.undo.push([which, state.shapes[which].slice()]);
    if (state.undo.length > 50) state.undo.shift();
  }

  /** The open swing's clips (main = the one on top, dtl = the down-the-line partner or null). */
  function setClips(main, dtl) {
    if (state.live) state.live = null;
    if (state.clips.main !== main || state.clips.dtl !== dtl) state.undo = [];
    state.clips = { main: main || null, dtl: dtl || null };
    state.shapes = { main: load(storage(), main), dtl: load(storage(), dtl) };
    updateBar();
  }

  /** Draws `which` angle's shapes (and the one being drawn) last over the overlay. */
  function paint(ctx, which, r) {
    if (!r || !(r.w > 0)) return;
    const lw = Math.max(2, 3 * r.w / 400);
    for (const s of state.shapes[which] || []) paintShape(ctx, s, r, lw);
    if (state.live && state.live.which === which) paintShape(ctx, state.live.shape, r, lw);
  }

  /** The point under a pointer event, in 0..1 of the picture, or null outside it. */
  function pointOf(e, st) {
    const c = st.canvas, rect = c.getBoundingClientRect();
    const dpr = c.width / (rect.width || 1);
    const r = st.rect();
    if (!r || !(r.w > 0)) return null;
    const x = ((e.clientX - rect.left) * dpr - r.x) / r.w, y = ((e.clientY - rect.top) * dpr - r.y) / r.h;
    return [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))];
  }

  function onDown(e, st) {
    if (!state.on || !state.clips[st.which]) return;
    if (state.opts.canDraw && !state.opts.canDraw()) return;
    const p = pointOf(e, st);
    if (!p) return;
    e.preventDefault();
    try { st.canvas.setPointerCapture(e.pointerId); } catch {}
    // The second arm of an angle: this tap ends it.
    if (state.live && state.live.waiting && state.live.which === st.which) {
      state.live.shape.pts[2] = p;
      finish();
      return;
    }
    state.live = { which: st.which, shape: { type: state.tool, color: state.color, pts: [p, p] }, dragging: true };
    if (state.opts.redraw) state.opts.redraw();
  }

  function onMove(e, st) {
    const L = state.live;
    if (!L || L.which !== st.which) return;
    const p = pointOf(e, st);
    if (!p) return;
    if (L.dragging) {
      if (L.shape.type === "free") L.shape.pts.push(p);
      else L.shape.pts[1] = p;
    } else if (L.waiting) {
      L.shape.pts[2] = p;
    } else return;
    if (state.opts.redraw) state.opts.redraw();
  }

  function onUp(e, st) {
    const L = state.live;
    if (!L || L.which !== st.which || !L.dragging) return;
    L.dragging = false;
    const s = L.shape;
    const len = Math.hypot(s.pts[1][0] - s.pts[0][0], s.pts[1][1] - s.pts[0][1]);
    if (s.type !== "free" && len < 0.01) { state.live = null; if (state.opts.redraw) state.opts.redraw(); return; }
    if (s.type === "angle") {
      // The first arm is down (its far end, then the vertex); wait for the tap that ends the second.
      s.pts = [s.pts[0], s.pts[1], s.pts[1]];
      L.waiting = true;
      updateBar();
      return;
    }
    finish();
  }

  function finish() {
    const L = state.live;
    state.live = null;
    if (!L) return;
    const s = L.shape;
    if (s.type === "free") s.pts = thin(s.pts, 0.004);
    s.pts = s.pts.map(p => [Math.round(p[0] * 10000) / 10000, Math.round(p[1] * 10000) / 10000]);
    if (!valid(s)) { changed(L.which); return; }
    remember(L.which);
    state.shapes[L.which] = [...state.shapes[L.which], s];
    changed(L.which);
  }

  function undo() {
    if (state.live) { state.live = null; updateBar(); if (state.opts.redraw) state.opts.redraw(); return; }
    const last = state.undo.pop();
    if (!last) return;
    state.shapes[last[0]] = last[1];
    changed(last[0]);
  }

  function clear() {
    state.live = null;
    for (const which of ["main", "dtl"]) {
      if (!state.shapes[which].length) continue;
      remember(which);
      state.shapes[which] = [];
      changed(which);
    }
    updateBar();
  }

  function setOn(on) {
    state.on = !!on;
    state.live = null;
    const o = state.opts;
    if (!o) return;
    if (o.stagesEl) o.stagesEl.classList.toggle("drawing", state.on);
    if (o.button) { o.button.classList.toggle("on", state.on); o.button.setAttribute("aria-pressed", state.on ? "true" : "false"); }
    if (o.bar) o.bar.hidden = !state.on;
    updateBar();
    if (o.redraw) o.redraw();
  }

  function count() { return state.shapes.main.length + state.shapes.dtl.length; }

  function updateBar() {
    const o = state.opts;
    if (!o || !o.bar) return;
    for (const b of o.bar.querySelectorAll("[data-tool]")) b.classList.toggle("on", b.dataset.tool === state.tool);
    for (const b of o.bar.querySelectorAll("[data-color]")) b.classList.toggle("on", b.dataset.color === state.color);
    const n = count();
    const u = o.bar.querySelector(".dr-undo"), c = o.bar.querySelector(".dr-clear"), hint = o.bar.querySelector(".dr-hint");
    if (u) u.disabled = !state.undo.length && !state.live;
    if (c) c.disabled = !n && !state.live;
    if (hint) {
      hint.textContent = state.live && state.live.waiting ? "Tap where the second arm ends."
        : (TOOLS.find(t => t[0] === state.tool) || [])[2] + (n ? ` · ${n} on this swing` : "");
    }
    if (o.button) o.button.textContent = n && !state.on ? `Draw · ${n}` : "Draw";
  }

  function buildBar(bar, doc) {
    bar.replaceChildren();
    const group = (cls) => { const g = doc.createElement("span"); g.className = cls; bar.append(g); return g; };
    const tools = group("seg dr-tools");
    for (const [key, name, tip] of TOOLS) {
      const b = doc.createElement("button");
      b.type = "button"; b.dataset.tool = key; b.textContent = name; b.title = tip;
      b.onclick = () => { state.tool = key; state.live = null; updateBar(); state.opts.redraw && state.opts.redraw(); };
      tools.append(b);
    }
    const colors = group("dr-colors");
    for (const [c, name] of COLORS) {
      const b = doc.createElement("button");
      b.type = "button"; b.dataset.color = c; b.className = "dr-swatch"; b.title = name; b.setAttribute("aria-label", name);
      b.style.setProperty("--sw", c);
      b.onclick = () => { state.color = c; updateBar(); };
      colors.append(b);
    }
    const acts = group("dr-acts");
    const mk = (cls, text, tip, fn) => {
      const b = doc.createElement("button");
      b.type = "button"; b.className = cls; b.textContent = text; b.title = tip; b.onclick = fn;
      acts.append(b);
    };
    mk("dr-undo", "Undo", "Take back the last drawing (Ctrl+Z)", undo);
    mk("dr-clear", "Clear", "Remove the drawings on this swing (Undo brings them back)", clear);
    mk("dr-done primary", "Done", "Stop drawing; the drawings stay (D or Esc)", () => setOn(false));
    const hint = doc.createElement("span");
    hint.className = "dr-hint hint";
    bar.append(hint);
  }

  /**
   * Hooks drawing up to the page. opts: {stagesEl, button, bar, stages: [{which: "main"|"dtl", canvas,
   * rect: () => {x, y, w, h}}], redraw, storage?, document?, canDraw?: () => bool}.
   */
  function attach(opts) {
    state.opts = opts;
    const doc = opts.document || root.document;
    if (opts.bar) { buildBar(opts.bar, doc); opts.bar.hidden = true; }
    if (opts.button) opts.button.onclick = () => { if (!opts.canDraw || opts.canDraw()) setOn(!state.on); };
    for (const st of opts.stages || []) {
      st.canvas.addEventListener("pointerdown", e => onDown(e, st));
      st.canvas.addEventListener("pointermove", e => onMove(e, st));
      st.canvas.addEventListener("pointerup", e => onUp(e, st));
      st.canvas.addEventListener("pointercancel", () => { if (state.live && state.live.dragging) { state.live = null; opts.redraw && opts.redraw(); } });
    }
    updateBar();
  }

  /** Keys while the swing view is open: D on/off, Esc off, Ctrl+Z undo. True when the key was used. */
  function key(e) {
    if (!state.opts) return false;
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && (k === "z" || k === "Z")) { if (state.on) { undo(); return true; } return false; }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (k === "d" || k === "D") { if (state.opts.canDraw && !state.opts.canDraw()) return false; setOn(!state.on); return true; }
    if (k === "Escape" && state.on) { setOn(false); return true; }
    return false;
  }

  const api = {
    TOOLS, COLORS, KEY_PREFIX, lineAngle, jointAngle, thin, valid, load, save,
    attach, setClips, paint, setOn, key, undo, clear,
    isOn: () => state.on, shapes: which => state.shapes[which].slice(),
  };
  root.SwingDraw = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
