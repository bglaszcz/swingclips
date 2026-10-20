// The review page's 3D panel: a stick figure from both phones' joints (server/tri.py) that turns
// with a drag, the 3D turns next to the face-on estimates, and the kinematic sequence. Stays hidden
// unless the server has 3D on and the swing has a calibration (GET /api/3d/<clip>).
// Uses SwingMetrics3D (metrics3d.js).
(function (root) {
  const BONES = [[11, 12], [23, 24], [11, 23], [12, 24], [11, 13], [13, 15], [12, 14], [14, 16], [15, 19], [16, 20],
                 [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32], [27, 29], [28, 30], [7, 8]];
  const LEAD = new Set(["11,13", "13,15", "15,19", "23,25", "25,27", "27,31", "27,29"]);
  const COLORS = { pelvis: "#3b82f6", thorax: "#f59e0b", arm: "#ec4899", club: "#10b981" };
  // Rows: label (golfer's words: hips = pelvis, chest / shoulders = thorax), 3D key, 2D key (metrics.js,
  // face-on) or null, unit.
  const ROWS = [
    ["Hip turn", "pelvisTurn", "pelvisTurn", "°"], ["Shoulder turn", "thoraxTurn", "shoulderTurn", "°"],
    ["Shoulders turned past the hips", "separation", "separation", "°"], ["Chest bend toward the ball", "thoraxBend", null, "°"],
    ["Shoulder tilt", "thoraxSideBend", "shoulderTilt", "°"], ["Hip tilt", "pelvisSideBend", "pelvisTilt", "°"],
    ["Hip slide", "pelvisSway", "hipSway", "in"], ["Hips toward the ball", "pelvisThrust", null, "in"],
    ["Hip lift", "pelvisLift", null, "in"], ["Chest slide", "thoraxSway", null, "in"],
  ];

  const SEGMENTS3D = (root.SwingMetrics3D && root.SwingMetrics3D.SEGMENTS) || [["pelvis", "Hips"], ["thorax", "Chest"], ["arm", "Lead arm"], ["club", "Club"]];
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

  function firstBodyTime(doc) {
    if (!doc || !doc.frames) return null;
    for (const f of doc.frames) {
      if (f.p && BONES.some(([i, j]) => f.p[i] && f.p[j])) return f.t;
    }
    return null;
  }

  function setupExplanation(missing) {
    if (!missing || !missing.length) return null;
    if (missing.length >= 12) {
      return "No 3D at setup on this swing: the body wasn't seen by both cameras before the swing (the cameras' calibration is off by more than 15 px there). The swing order below is from the downswing and still holds.";
    }
    const hasShoulder = missing.some(j => j.includes("shoulder"));
    const hasHip = missing.some(j => j.includes("hip"));

    let jointDesc;
    if (missing.length === 1) {
      jointDesc = `The ${missing[0]} wasn't`;
    } else if (missing.length === 2) {
      jointDesc = `The ${missing[0]} and ${missing[1]} weren't`;
    } else {
      jointDesc = `The ${missing.slice(0, 2).join(", ")} and others weren't`;
    }

    let affects;
    if (hasShoulder && hasHip) {
      affects = "shoulder and hip turns, tilts and the chest";
    } else if (hasShoulder) {
      affects = "shoulder turn, tilt and the chest";
    } else if (hasHip) {
      affects = "hip turn, tilt and slides";
    } else {
      affects = "some body angles";
    }

    return `${jointDesc} seen by both cameras at setup, so ${affects} can't be measured on this swing (the cameras' calibration is off by more than 15 px there). The swing order below is from the downswing and still holds.`;
  }

  /** Draws the figure at face-on clip time t. */
  function draw(t) {
    if (!state) return;
    const { canvas, doc, figNote, firstBodyT } = state;
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

    const showFirst = firstBodyT != null && t < firstBodyT - 0.02;
    if (figNote) {
      figNote.textContent = showFirst ? `3D from ${firstBodyT.toFixed(2)} s` : "";
    }
    const drawT = showFirst ? firstBodyT : t;
    const f = doc.frames[nearestFrame(doc, drawT)];
    if (!f || Math.abs(f.t - drawT) > 0.02) return;
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

  function table(result, doc, positions, metrics2d, blankedKeys) {
    const cols = ["p1", "p4", "p6", "p7"].map(k => positions.find(p => p.key === k)).filter(Boolean);
    const at = SwingMetrics3D.atPositions(result, doc, positions);
    const t = el("table");
    const head = el("tr");
    head.append(el("th"));
    for (const p of cols) {
      const name = SwingShotStory.PHASES[p.key] || p.label;
      head.append(el("th", { title: p.tag }, name[0].toUpperCase() + name.slice(1)));
    }
    t.append(head);
    for (const [label, key, key2, unit] of ROWS) {
      const tr = el("tr");
      tr.append(el("td", {}, label));
      const isBlanked = blankedKeys && blankedKeys.has(key);
      for (const p of cols) {
        const v3 = at[p.key] && at[p.key][key];
        const v2 = key2 && metrics2d && metrics2d.values[p.index] ? metrics2d.values[p.index][key2] : null;
        const td = el("td");
        if (isBlanked && v3 == null) {
          td.append(el("span", { class: "muted" }, "not at setup"));
        } else {
          td.append(document.createTextNode(fmt(v3, unit)));
        }
        if (key2) td.append(el("span", { class: "v2" }, ` (2D ${fmt(v2, unit)})`));
        tr.append(td);
      }
      t.append(tr);
    }
    return t;
  }

  // A speed line is broken where there's no reading for longer than this (s): a straight line across
  // the gap would look like a measurement.
  const LINE_GAP_S = 0.02;

  /** The points of one speed line as runs without gaps: [[[x, y], ...], ...]. */
  function speedRuns(rows, key, x, y) {
    const runs = [];
    let run = null, last = null;
    for (const v of rows) {
      const sp = v[key + "Speed"];
      if (sp == null) continue;
      if (!run || v.t - last > LINE_GAP_S) runs.push(run = []);
      run.push(`${x(v.t).toFixed(1)},${y(sp).toFixed(1)}`);
      last = v.t;
    }
    return runs;
  }

  /** The four speeds from the top to just after impact, peaks marked. */
  function sequenceChart(result, positions) {
    const p4 = positions.find(p => p.key === "p4"), p7 = positions.find(p => p.key === "p7");
    const wrap = el("div", { class: "seq" });
    if (!p4 || !p7 || !result.sequence) return wrap;
    const t0 = p4.t - 0.05, t1 = p7.t + 0.14;
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
      for (const run of speedRuns(rows, k, x, y)) add("polyline", { points: run.join(" "), fill: "none", stroke: COLORS[k], "stroke-width": 2 });
    }
    for (const s of result.sequence.segments) {
      add("circle", { cx: x(s.t), cy: y(s.peak), r: 4, fill: COLORS[s.key] });
    }
    wrap.append(svg);
    const legend = el("div", { class: "seq-legend" });
    for (const s of result.sequence.segments) {
      const item = el("span");
      item.append(el("i", { style: `background:${COLORS[s.key]}` }),
                  `${s.label}: ${Math.round(s.peak)}°/s, ${Math.round(Math.abs(s.beforeImpact))} ms ${s.afterImpact ? "after" : "before"} impact`);
      legend.append(item);
    }
    wrap.append(legend);
    const order = result.sequence.order.map(k => result.sequence.segments.find(s => s.key === k).label.toLowerCase());
    wrap.append(el("div", { class: "note" }, result.sequence.inOrder
      ? `In order: ${order.join(", then ")} (the textbook sequence).`
      : `Out of order: ${order.join(", then ")}. The textbook order is pelvis, thorax, arm, club.`));
    if (result.sequence.segments.some(s => s.unreliable && !s.lost)) {
      wrap.append(el("div", { class: "note" }, `The thorax track jumped ${Math.round(result.sequence.thoraxJump)}° at the `
        + "top (the arms cross the shoulders down the line), so its speed is left out of the order."));
    }
    const lost = result.sequence.segments.filter(s => s.lost).map(s => s.label.toLowerCase());
    if (lost.length) {
      wrap.append(el("div", { class: "note" }, `The ${lost.join(" and ")} wasn't tracked through impact (it blurs at full `
        + "speed), so its top speed isn't known and it's left out of the order."));
    }
    if (result.sequence.bodyLate) {
      const late = result.sequence.segments.filter(s => (s.key === "pelvis" || s.key === "thorax") && s.afterImpact)
        .map(s => s.label.toLowerCase());
      wrap.append(el("div", { class: "note" }, `The ${late.join(" and ")} reached top speed only after impact: the body `
        + "turned late and the arms led the downswing. In a good sequence the pelvis peaks first, well before impact."));
    }
    return wrap;
  }

  // ---- The swing-order strip under the video: the four speeds from just before the top to after
  // impact, a playhead that follows the video (play, frame steps), and a tap or drag on it moves the
  // video. Each line is drawn against its own top speed in the window (the club turns 2-3 times as fast
  // as the hips, so on one scale the body lines lay flat along the bottom): the strip shows WHEN each
  // peaks; the speeds themselves are in the read-out and the legend's tooltips. ----

  let strip = null;   // {box, svg, head, read, x, t0, t1, rows, p7, seek}

  /** Builds the strip for a swing into `box` (the 3D result of compute), or hides it. seek(t): move the video. */
  function showStrip(box, result, positions, seek) {
    strip = null;
    const p4 = positions && positions.find(p => p.key === "p4"), p7 = positions && positions.find(p => p.key === "p7");
    if (!box) return;
    box.hidden = !(result && result.sequence && p4 && p7);
    if (box.hidden) { box.replaceChildren(); return; }
    const t0 = p4.t - 0.08, t1 = p7.t + 0.12;
    const rows = result.values.filter(v => v.t >= t0 && v.t <= t1);
    const W = 800, H = 120, L = 6, R = 6, T = 8, B = 16;
    const top = {};
    for (const k in COLORS) {
      top[k] = 100;
      for (const v of rows) if (v[k + "Speed"] > top[k]) top[k] = v[k + "Speed"];
    }
    const x = t => L + (t - t0) / (t1 - t0) * (W - L - R);
    const yOf = k => s => T + (1 - Math.max(0, s) / top[k]) * (H - T - B);
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Swing order: when the hips, chest, lead arm and club turn fastest from the top to impact, each line against its own top speed; tap to move the video");
    const add = (tag, a, text) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(a)) e.setAttribute(k, v);
      if (text != null) e.textContent = text;
      svg.append(e);
      return e;
    };
    add("line", { x1: x(p7.t), x2: x(p7.t), y1: T, y2: H - B, class: "impact" });
    add("text", { x: x(p7.t), y: H - 3, "text-anchor": "middle", class: "axis" }, "impact");
    add("text", { x: x(p4.t), y: H - 3, "text-anchor": "middle", class: "axis" }, "top");
    for (const k of Object.keys(COLORS)) {
      for (const run of speedRuns(rows, k, x, yOf(k))) {
        add("polyline", { points: run.join(" "), fill: "none", stroke: COLORS[k], "stroke-width": 2, "vector-effect": "non-scaling-stroke" });
      }
    }
    // A peak dot only where the peak is known (not for a segment lost before impact).
    for (const s of result.sequence.segments) if (!s.lost) add("circle", { cx: x(s.t), cy: yOf(s.key)(s.peak), r: 3.5, fill: COLORS[s.key] });
    const head = add("line", { x1: 0, x2: 0, y1: T, y2: H - B, class: "playhead" });
    const legend = el("div", { class: "seq-strip-legend" });
    const read = el("span", { class: "seq-strip-read" });
    for (const s of result.sequence.segments) {
      const item = el("span", { title: s.lost ? `${s.label}: not tracked through impact, so left out of the order`
        : `${s.label}: fastest ${Math.round(s.peak)}°/s, ${Math.round(Math.abs(s.beforeImpact))} ms ${s.afterImpact ? "after" : "before"} impact` });
      item.append(el("i", { style: `background:${COLORS[s.key]}` }), s.label);
      legend.append(item);
    }
    const order = result.sequence.order.map(k => result.sequence.segments.find(s => s.key === k).label.toLowerCase());
    const verdict = el("span", { class: "seq-strip-order" }, result.sequence.inOrder
      ? `In order: ${order.join(", ")}`
      : `Order: ${order.join(", ")} (best: hips, chest, arm, club)`);
    legend.append(verdict, read);
    const wrap = el("div", { class: "seq-strip-chart" });
    wrap.append(svg);
    box.replaceChildren(wrap, legend);
    strip = { box, svg, head, read, x, t0, t1, rows, p7, seek, W };
    // Tap or drag: move the video to that moment.
    const timeAt = e => {
      const r = svg.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width * W;
      return Math.max(t0, Math.min(t1, t0 + (px - L) / (W - L - R) * (t1 - t0)));
    };
    let dragging = false;
    svg.addEventListener("pointerdown", e => { dragging = true; svg.setPointerCapture(e.pointerId); seek && seek(timeAt(e)); });
    svg.addEventListener("pointermove", e => { if (dragging && seek) seek(timeAt(e)); });
    svg.addEventListener("pointerup", () => { dragging = false; });
  }

  /** The playhead and the speeds at time t (face-on clip time). */
  function stripAt(t) {
    if (!strip) return;
    const inside = t >= strip.t0 && t <= strip.t1;
    const xt = strip.x(Math.max(strip.t0, Math.min(strip.t1, t)));
    strip.head.setAttribute("x1", xt);
    strip.head.setAttribute("x2", xt);
    strip.head.classList.toggle("outside", !inside);
    if (!inside) { strip.read.textContent = t < strip.t0 ? "Step to the top to follow the order" : ""; return; }
    let best = strip.rows[0];
    for (const v of strip.rows) if (Math.abs(v.t - t) < Math.abs(best.t - t)) best = v;
    const ms = Math.round((t - strip.p7.t) * 1000);
    const when = ms === 0 ? "at impact" : `${Math.abs(ms)} ms ${ms < 0 ? "before" : "after"} impact`;
    const sp = SEGMENTS3D.map(([k, label]) => best[k + "Speed"] != null ? `${label.toLowerCase()} ${Math.round(Math.max(0, best[k + "Speed"]))}` : null)
      .filter(Boolean).join(" · ");
    strip.read.textContent = `${when}: ${sp} °/s`;
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
    showStrip(opts && opts.strip, result, opts && opts.positions, opts && opts.seek);
    box.hidden = !result;
    if (!result) { box.replaceChildren(); return; }
    const head = el("div", { class: "pos-head" });
    head.append(el("strong", {}, "3D from both phones"));
    const r = doc.reprojection || {};
    const info = el("div", { class: "note" },
      `Calibration ${doc.session}. Reprojection error (median) face-on ${r.face ? r.face.median : "--"} px, `
      + `down the line ${r.dtl ? r.dtl.median : "--"} px; bone lengths varied ${doc.boneSpreadPct ?? "--"}% before the `
      + `filter; synced ${((doc.offset - doc.offsetImpact) * 1000).toFixed(1)} ms from the impact frames. Drag the figure to turn it.`);
    const impact = SwingMetrics3D.atPositions(result, doc, opts.positions).p7;
    const open = el("div", { class: "note" }, impact && impact.pelvisTurn != null
      ? `At impact: hips ${Math.abs(impact.pelvisTurn).toFixed(0)}° ${impact.pelvisTurn <= 0 ? "open" : "closed"}`
        + (impact.thoraxTurn != null ? `, shoulders ${Math.abs(impact.thoraxTurn).toFixed(0)}° ${impact.thoraxTurn <= 0 ? "open" : "closed"}` : "")
        + " (good players' hips are about 30-45° open)." : "");
    const canvas = el("canvas", { class: "fig3d", "aria-label": "3D stick figure; drag to turn" });
    const figNote = el("div", { class: "note fig-note" });
    const left = el("div");
    left.append(canvas, figNote);
    const grid = el("div", { class: "grid3d" });
    grid.append(left);

    const missing = (opts && opts.body3d && opts.body3d.setupMissing) ||
                    (result && result.setup && result.setup.missing) || [];
    const blankedList = SwingMetrics3D ? SwingMetrics3D.blankedRows(missing) : [];
    const blankedKeys = new Set(blankedList);
    if (missing.length >= (SwingMetrics3D && SwingMetrics3D.CORE_JOINTS ? SwingMetrics3D.CORE_JOINTS.length : 12)) {
      for (const [, k] of ROWS) blankedKeys.add(k);
    }
    const explanation = setupExplanation(missing);

    const right = el("div");
    if (explanation) {
      right.append(el("div", { class: "note", style: "margin-bottom: 6px;" }, explanation));
    }
    right.append(table(result, doc, opts.positions, opts.metrics2d, blankedKeys));
    grid.append(right);
    const notes = el("div", { class: "note" },
      "Turn + = closed (going back), - = open; side bend + = lead side higher; forward bend toward the ball; "
      + "sway + toward the target, thrust + toward the ball, lift + up, from address. The 2D numbers in brackets are "
      + "the face-on estimates. The pelvis has no forward tilt: that needs points on the front and back of it.");
    const children = [head, info, open, grid, notes, el("strong", {}, "Kinematic sequence"), sequenceChart(result, opts.positions)];
    const cc = result.clubCheck;
    if (cc) {
      children.push(el("div", { class: "note" }, cc.expected
        ? `Club check: hands to clubhead ${cc.measured.toFixed(1)}" against ${cc.expected.toFixed(1)}" expected for a `
          + `${cc.club} (${cc.diffPct > 0 ? "+" : ""}${cc.diffPct.toFixed(0)}%)${cc.ok ? "" : ": off by more than 10%, so the calibration or the clubhead points are off"}.`
        : `Club check: hands to clubhead ${cc.measured.toFixed(1)}" (no club known to compare with).`));
    }
    box.replaceChildren(...children);
    const firstBodyT = firstBodyTime(doc);
    state = { box, doc, result, canvas, figNote, firstBodyT, yaw: 0.5, pitch: 0.25 };
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
    stripAt(t);
    if (!state) return;
    state.lastT = t;
    draw(t);
  }

  root.View3D = { show, draw: drawAt, setupExplanation, firstBodyTime };
})(typeof window !== "undefined" ? window : globalThis);
