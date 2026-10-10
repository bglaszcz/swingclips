// The focus, swing by swing: after each swing, was it in the target? The last swing's number big,
// with the word for where it sat; how many swings, the share in the target and how long the session
// has run; and every swing as a dot against the target (goal.js live). The same picture on Progress,
// on Practice and on the Start page, so it needs nothing but goal.js: the page hands it the words.
//
// SwingGoalLive.render(box, model, opts)
//   model: SwingGoal.live(rows, focus, target), with `target` set on it
//   opts: {title, label (the move in plain words), fmt(v) (a value with its unit), onOpen(row),
//          thought (the swing thought, shown when the last swing was out), waiting (the latest
//          swing's numbers aren't worked out yet)}
(function (root) {
  const NS = "http://www.w3.org/2000/svg";
  // Its own styles (the page's colors), put in once: the review page and the Start page both draw it.
  const CSS = `
  .gl { display: flex; flex-direction: column; gap: 8px; }
  .gl-title { font-weight: 600; font-size: 13px; }
  .gl-top { display: flex; flex-wrap: wrap; gap: 10px 22px; align-items: center; }
  .gl-tile { display: flex; flex-direction: column; gap: 1px; padding: 8px 14px; border-radius: 10px; border: 2px solid var(--line); min-width: 150px; }
  .gl-tile b { font-size: 30px; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; }
  .gl-tile.in { border-color: var(--accent); } .gl-tile.in b { color: var(--accent); }
  .gl-tile.near { border-color: var(--warn); } .gl-tile.near b { color: var(--warn); }
  .gl-tile.out { border-color: var(--bad); } .gl-tile.out b { color: var(--bad); }
  .gl-label, .gl-stat span { font-size: 12px; color: var(--muted); }
  .gl-word { font-size: 13px; font-weight: 600; }
  .gl-stat { display: flex; flex-direction: column; }
  .gl-stat b { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1.15; }
  .gl-thought { font-size: 14px; }
  .gl-chart svg { display: block; width: 100%; height: 190px; overflow: visible; }
  .gl-band { fill: var(--accent); fill-opacity: 0.1; }
  .gl-bound { stroke: var(--accent); stroke-width: 1.5; }
  .gl-grid { stroke: var(--line); stroke-width: 1; }
  .gl-axis { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .gl-dot { stroke: var(--panel); stroke-width: 2; cursor: pointer; outline: none; }
  .gl-dot.in { fill: var(--accent); } .gl-dot.near { fill: var(--warn); } .gl-dot.out { fill: var(--bad); }
  .gl-dot.last { stroke: var(--text); }
  .gl-dot.off { fill-opacity: 0.5; }
  .gl-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--muted); }
  .gl-legend span { display: inline-flex; align-items: center; gap: 6px; }
  .gl-key { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .gl-key.in { background: var(--accent); } .gl-key.near { background: var(--warn); } .gl-key.out { background: var(--bad); }`;
  function style() {
    if (typeof document === "undefined" || document.getElementById("gl-style")) return;
    document.head.append(Object.assign(document.createElement("style"), { id: "gl-style", textContent: CSS }));
  }
  const WORDS = { in: "in your target", near: "just outside", out: "outside your target" };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const svgEl = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.append(e); return e; };

  function render(box, model, opts = {}) {
    const t = model.target, last = model.last, fmt = opts.fmt || (v => String(v));
    style();
    box.classList.add("gl");
    box.replaceChildren();
    if (opts.title) box.append(el("div", "gl-title", opts.title));
    const top = el("div", "gl-top");
    // The last swing.
    const tile = el("div", "gl-tile" + (last ? " " + last.zone : ""));
    tile.append(el("span", "gl-label", opts.label ? `Last swing: ${opts.label}` : "Last swing"),
      el("b", null, last ? fmt(last.v) : "–"),
      el("span", "gl-word", opts.waiting ? "waiting for the swing's numbers" : last ? WORDS[last.zone] : "no swing with a reading yet"));
    top.append(tile);
    const stat = (value, label) => { const d = el("div", "gl-stat"); d.append(el("b", null, value), el("span", null, label)); return d; };
    top.append(stat(`${model.n}`, model.n === 1 ? "swing" : "swings"),
      stat(model.rate == null ? "–" : `${Math.round(model.rate * 100)}%`, "in your target"),
      stat(model.minutes >= 60 ? `${Math.floor(model.minutes / 60)} h ${model.minutes % 60} min` : `${model.minutes} min`, "so far"));
    box.append(top);
    if (last && last.zone !== "in" && opts.thought && !opts.waiting) box.append(el("div", "gl-thought", `Swing thought: “${opts.thought}”`));
    if (!model.n || !t) return;

    // Every swing as a dot: in the band is in the target.
    const wrap = el("div", "gl-chart"), svg = svgEl("svg", { role: "img" }, wrap);
    box.append(wrap);
    const W = Math.max(260, box.clientWidth || 520), H = 190, m = { l: 52, r: 12, t: 12, b: 24 };
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("aria-label", `${opts.label || "The move"}, swing by swing against the target: ${model.k} of ${model.n} in it`);
    // The scale from the middle of the swings and the target, so one wild swing doesn't flatten the rest.
    const vs = model.points.map(p => p.v).sort((a, b) => a - b);
    const q = p => { const i = (vs.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return vs[lo] + (vs[hi] - vs[lo]) * (i - lo); };
    const reach = Math.max((q(0.9) - q(0.1)) * 0.6, (t.spread || 0) * 0.75, Math.abs(t.bound) * 0.05, 1e-6);
    let lo = Math.min(q(0.05), t.bound) - reach, hi = Math.max(q(0.95), t.bound) + reach;
    const sy = v => H - m.b - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * (H - m.t - m.b);
    const n = Math.max(model.n, 8), sx = i => m.l + (i - 0.5) / n * (W - m.l - m.r);
    const below = t.side === "below";
    svgEl("rect", { x: m.l, y: below ? sy(t.bound) : m.t, width: W - m.l - m.r, height: below ? H - m.b - sy(t.bound) : sy(t.bound) - m.t, class: "gl-band" }, svg);
    svgEl("line", { x1: m.l, x2: W - m.r, y1: sy(t.bound), y2: sy(t.bound), class: "gl-bound" }, svg);
    svgEl("text", { x: m.l - 6, y: sy(t.bound) + 4, "text-anchor": "end", class: "gl-axis" }, svg).textContent = fmt(t.bound);
    svgEl("text", { x: W - m.r - 4, y: below ? H - m.b - 6 : m.t + 12, "text-anchor": "end", class: "gl-axis" }, svg).textContent = "in your target";
    const every = Math.ceil(n / Math.max(1, Math.floor((W - m.l - m.r) / 28)));
    for (const p of model.points) {
      svgEl("line", { x1: sx(p.i), x2: sx(p.i), y1: m.t, y2: H - m.b, class: "gl-grid" }, svg);
      if (p.i % every === 0 || p.i === 1) svgEl("text", { x: sx(p.i), y: H - 7, "text-anchor": "middle", class: "gl-axis" }, svg).textContent = p.i;
    }
    for (const p of model.points) {
      const off = p.v < lo || p.v > hi;
      const dot = svgEl("circle", { cx: sx(p.i), cy: sy(p.v), r: p === last ? 7 : 5.5, class: `gl-dot ${p.zone}` + (p === last ? " last" : "") + (off ? " off" : ""),
        tabindex: 0, role: "button" }, svg);
      const words = `Swing ${p.i}: ${fmt(p.v)}, ${WORDS[p.zone]}`;
      dot.setAttribute("aria-label", words);
      svgEl("title", {}, dot).textContent = words + (off ? " (off the chart: drawn at its edge)" : "");
      if (opts.onOpen) {
        dot.addEventListener("click", () => opts.onOpen(p.row));
        dot.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); opts.onOpen(p.row); } });
      }
    }
    const legend = el("div", "gl-legend");
    for (const z of ["in", "near", "out"]) {
      const s = el("span");
      s.append(el("i", `gl-key ${z}`), WORDS[z].replace(/^./, c => c.toUpperCase()));
      legend.append(s);
    }
    box.append(legend);
  }

  const api = { render, WORDS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingGoalLive = api;
})(typeof window !== "undefined" ? window : globalThis);
