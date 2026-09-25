// The review page's 3D panel: a stick figure from both phones' joints (server/tri.py) that turns
// with a drag, the 3D turns next to the face-on estimates, and the kinematic sequence. Stays hidden
// unless the server has 3D on and the swing has a calibration (GET /api/3d/<clip>).
// Uses SwingMetrics3D (metrics3d.js).
(function (root) {
  const BONES = [[11, 12], [23, 24], [11, 23], [12, 24], [11, 13], [13, 15], [12, 14], [14, 16], [15, 19], [16, 20],
                 [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32], [27, 29], [28, 30], [7, 8]];
  const LEAD = new Set(["11,13", "13,15", "15,19", "23,25", "25,27", "27,31", "27,29"]);
  const COLORS = { pelvis: "#3b82f6", thorax: "#f59e0b", arm: "#ec4899", club: "#10b981" };
  // Rows: label, 3D key, 2D key (metrics.js, face-on) or null, unit.
  const ROWS = [
    ["Pelvis turn", "pelvisTurn", "pelvisTurn", "°"], ["Thorax turn", "thoraxTurn", "shoulderTurn", "°"],
    ["X-factor", "separation", "separation", "°"], ["Thorax forward bend", "thoraxBend", null, "°"],
    ["Thorax side bend", "thoraxSideBend", "shoulderTilt", "°"], ["Pelvis side bend", "pelvisSideBend", "pelvisTilt", "°"],
    ["Pelvis sway", "pelvisSway", "hipSway", "in"], ["Pelvis thrust (to ball)", "pelvisThrust", null, "in"],
    ["Pelvis lift", "pelvisLift", null, "in"], ["Thorax sway", "thoraxSway", null, "in"],
  ];

  let state = null;       // {box, doc, result, canvas, yaw, pitch}

  const fmt = (x, unit) => {
    if (x == null || Number.isNaN(x)) return "--";
    let n = unit === "in" ? x.toFixed(1) : Math.round(x).toString();
    if (Number(n) === 0) n = unit === "in" ? "0.0" : "0";
    const s = x > 0 && Number(n) !== 0 ? "+" + n : n;
    return unit === "in" ? s + '"' : s + "°";
  };

  function el(tag, attrs = {}, text) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    return e;
  }

  function nearestFrame(doc, t) {
    const f = doc.frames;
    let lo = 0, hi = f.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (f[m].t < t) lo = m + 1; else hi = m; }
    return lo > 0 && Math.abs(f[lo - 1].t - t) < Math.abs(f[lo].t - t) ? lo - 1 : lo;
  }

  /** Draws the figure at face-on clip time t. */
  function draw(t) {
    if (!state) return;
    const { canvas, doc } = state;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth * dpr, h = canvas.clientHeight * dpr;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    const style = getComputedStyle(state.box);
    const text = style.getPropertyValue("--text") || "#888", muted = style.getPropertyValue("--muted") || "#888";
    const cy = Math.cos(state.yaw), sy = Math.sin(state.yaw), cp = Math.cos(state.pitch), sp = Math.sin(state.pitch);
    const s = Math.min(w, h) / 2.9;
    // Looking at the golfer (z toward the viewer at yaw 0), up is up; centred 1 m up, 0.5 m back.
    const project = p => {
      const x = p[0], y = p[1] - 1.0, z = p[2] + 0.5;
      const x1 = cy * x + sy * z, z1 = -sy * x + cy * z;
      const y1 = cp * y - sp * z1;
      return [w / 2 + s * x1, h / 2 - s * y1];
    };
    // The mat: a metre grid round the ball, and the target line.
    ctx.lineWidth = dpr;
    ctx.strokeStyle = muted;
    ctx.globalAlpha = 0.35;
    for (let k = -1; k <= 1; k += 0.5) {
      let a = project([k, 0, -1.5]), b = project([k, 0, 1]);
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
      a = project([-1, 0, k - 0.25]); b = project([1, 0, k - 0.25]);
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = COLORS.club;
    let a = project([0, 0, 0]), b = project([1.2, 0, 0]);
    ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
    ctx.fillStyle = muted;
    ctx.font = `${11 * dpr}px system-ui, sans-serif`;
    ctx.fillText("target", ...project([1.25, 0, 0]));

    const f = doc.frames[nearestFrame(doc, t)];
    if (!f || Math.abs(f.t - t) > 0.02) return;
    ctx.lineWidth = 3 * dpr;
    ctx.lineCap = "round";
    for (const [i, j] of BONES) {
      const p = f.p[i], q = f.p[j];
      if (!p || !q) continue;
      ctx.strokeStyle = LEAD.has(`${i},${j}`) ? COLORS.arm : text;
      ctx.beginPath(); ctx.moveTo(...project(p)); ctx.lineTo(...project(q)); ctx.stroke();
    }
    if (f.club && f.p[19] && f.p[20]) {
      const hands = [0, 1, 2].map(k => (f.p[19][k] + f.p[20][k]) / 2);
      ctx.strokeStyle = COLORS.club;
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath(); ctx.moveTo(...project(hands)); ctx.lineTo(...project(f.club)); ctx.stroke();
    }
    if (f.p[0]) {
      const [x, y] = project(f.p[0]);
      ctx.fillStyle = text;
      ctx.beginPath(); ctx.arc(x, y, 5 * dpr, 0, 2 * Math.PI); ctx.fill();
    }
  }

  function table(result, doc, positions, metrics2d) {
    const cols = ["p1", "p4", "p6", "p7"].map(k => positions.find(p => p.key === k)).filter(Boolean);
    const at = SwingMetrics3D.atPositions(result, doc, positions);
    const t = el("table");
    const head = el("tr");
    head.append(el("th"));
    for (const p of cols) head.append(el("th", {}, `${p.tag} ${p.label}`));
    t.append(head);
    for (const [label, key, key2, unit] of ROWS) {
      const tr = el("tr");
      tr.append(el("td", {}, label));
      for (const p of cols) {
        const v3 = at[p.key] && at[p.key][key];
        const v2 = key2 && metrics2d && metrics2d.values[p.index] ? metrics2d.values[p.index][key2] : null;
        const td = el("td", {}, fmt(v3, unit));
        if (key2) td.append(el("span", { class: "v2" }, ` (2D ${fmt(v2, unit)})`));
        tr.append(td);
      }
      t.append(tr);
    }
    return t;
  }

  /** The four speeds from the top to just after impact, peaks marked. */
  function sequenceChart(result, positions) {
    const p4 = positions.find(p => p.key === "p4"), p7 = positions.find(p => p.key === "p7");
    const wrap = el("div", { class: "seq" });
    if (!p4 || !p7 || !result.sequence) return wrap;
    const t0 = p4.t - 0.05, t1 = p7.t + 0.06;
    const rows = result.values.filter(v => v.t >= t0 && v.t <= t1);
    const W = 560, H = 220, L = 70, R = 10, T = 10, B = 30;
    let top = 0;
    for (const v of rows) for (const k in COLORS) if (v[k + "Speed"] > top) top = v[k + "Speed"];
    top = Math.max(500, Math.ceil(top / 500) * 500);
    const x = t => L + (t - t0) / (t1 - t0) * (W - L - R);
    const y = s => T + (1 - Math.max(0, s) / top) * (H - T - B);
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Kinematic sequence: speed of pelvis, thorax, lead arm and club through the downswing");
    const add = (tag, a, text) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(a)) e.setAttribute(k, v);
      if (text != null) e.textContent = text;
      svg.append(e);
      return e;
    };
    for (let s = 0; s <= top; s += top / 4) {
      add("line", { x1: L, x2: W - R, y1: y(s), y2: y(s), class: "grid" });
      add("text", { x: L - 4, y: y(s) + 4, "text-anchor": "end", class: "axis" }, Math.round(s) + (s === top ? " °/s" : ""));
    }
    add("line", { x1: x(p7.t), x2: x(p7.t), y1: T, y2: H - B, class: "impact" });
    add("text", { x: x(p7.t), y: H - B + 14, "text-anchor": "middle", class: "axis" }, "impact");
    add("text", { x: x(p4.t), y: H - B + 14, "text-anchor": "middle", class: "axis" }, "top");
    for (const k of Object.keys(COLORS)) {
      const pts = rows.filter(v => v[k + "Speed"] != null).map(v => `${x(v.t).toFixed(1)},${y(v[k + "Speed"]).toFixed(1)}`);
      if (pts.length) add("polyline", { points: pts.join(" "), fill: "none", stroke: COLORS[k], "stroke-width": 2 });
    }
    for (const s of result.sequence.segments) {
      add("circle", { cx: x(s.t), cy: y(s.peak), r: 4, fill: COLORS[s.key] });
    }
    wrap.append(svg);
    const legend = el("div", { class: "seq-legend" });
    for (const s of result.sequence.segments) {
      const item = el("span");
      item.append(el("i", { style: `background:${COLORS[s.key]}` }),
                  `${s.label}: ${Math.round(s.peak)}°/s, ${Math.round(s.beforeImpact)} ms before impact`);
      legend.append(item);
    }
    wrap.append(legend);
    const order = result.sequence.order.map(k => result.sequence.segments.find(s => s.key === k).label.toLowerCase());
    wrap.append(el("div", { class: "note" }, result.sequence.inOrder
      ? `In order: ${order.join(", then ")} (the textbook sequence).`
      : `Out of order: ${order.join(", then ")}. The textbook order is pelvis, thorax, arm, club.`));
    return wrap;
  }

  /**
   * Shows the panel for a swing, or hides it.
   * @param box the panel element
   * @param opts {doc (the 3D file) | null, positions, metrics2d, leadSide, club}
   */
  function show(box, opts) {
    state = null;
    const doc = opts && opts.doc;
    const result = doc ? SwingMetrics3D.compute(doc, opts.positions, opts.leadSide, opts.club) : null;
    box.hidden = !result;
    if (!result) { box.replaceChildren(); return; }
    const head = el("div", { class: "pos-head" });
    head.append(el("strong", {}, "3D from both phones"));
    const r = doc.reprojection || {};
    const info = el("div", { class: "note" },
      `Calibration ${doc.session}. Reprojection error (median) face-on ${r.face ? r.face.median : "--"} px, `
      + `down the line ${r.dtl ? r.dtl.median : "--"} px; bone lengths varied ${doc.boneSpreadPct ?? "--"}% before the `
      + `filter; synced ${((doc.offset - doc.offsetImpact) * 1000).toFixed(1)} ms from the impact frames. Drag the figure to turn it.`);
    const canvas = el("canvas", { class: "fig3d", "aria-label": "3D stick figure; drag to turn" });
    const grid = el("div", { class: "grid3d" });
    grid.append(canvas);
    const right = el("div");
    right.append(table(result, doc, opts.positions, opts.metrics2d));
    grid.append(right);
    const notes = el("div", { class: "note" },
      "Turn + = closed (going back), - = open; side bend + = lead side higher; forward bend toward the ball; "
      + "sway + toward the target, thrust + toward the ball, lift + up, from address. The 2D numbers in brackets are "
      + "the face-on estimates. The pelvis has no forward tilt: that needs points on the front and back of it.");
    const children = [head, info, grid, notes, el("strong", {}, "Kinematic sequence"), sequenceChart(result, opts.positions)];
    const cc = result.clubCheck;
    if (cc) {
      children.push(el("div", { class: "note" }, cc.expected
        ? `Club check: hands to clubhead ${cc.measured.toFixed(1)}" against ${cc.expected.toFixed(1)}" expected for a `
          + `${cc.club} (${cc.diffPct > 0 ? "+" : ""}${cc.diffPct.toFixed(0)}%)${cc.ok ? "" : ": off by more than 10%, so the calibration or the clubhead points are off"}.`
        : `Club check: hands to clubhead ${cc.measured.toFixed(1)}" (no club known to compare with).`));
    }
    box.replaceChildren(...children);
    state = { box, doc, result, canvas, yaw: 0.5, pitch: 0.25 };
    let drag = null;
    canvas.addEventListener("pointerdown", e => { drag = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", e => {
      if (!drag || !state) return;
      state.yaw += (e.clientX - drag[0]) * 0.01;
      state.pitch = Math.max(-0.2, Math.min(1.4, state.pitch + (e.clientY - drag[1]) * 0.01));
      drag = [e.clientX, e.clientY];
      draw(state.lastT ?? 0);
    });
    canvas.addEventListener("pointerup", () => { drag = null; });
  }

  function drawAt(t) {
    if (!state) return;
    state.lastT = t;
    draw(t);
  }

  root.View3D = { show, draw: drawAt };
})(window);
