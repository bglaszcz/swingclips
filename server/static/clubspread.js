// Every club's spread, and a session's flights, for Analysis.
//
// Spread ("Every club's spread", Bag): where each club's shots land, all clubs on one map (carry up, left/right
// across), each club with its ring that holds about two shots in three, and a table: the middle 80% of carry
// and of left/right, where the pattern is centred and which side it leans to.
// Flights ("Flights by club", Results): one session's shots flown by the server's flight model (tracer.js,
// within ~2 yd of Square's carry), stretched to land exactly where Square said and as high as Square's apex,
// seen from the side and from above, each club its own colour.
//
// A club keeps its colour everywhere: its place in the bag of every club ever hit (not the period's), eight
// colours in a fixed order; a ninth club and on take the same colours again with hollow dots and dashed
// flights, and every club is labelled on the chart, so colour is never the only way to tell them apart.
// Mishits (no carry, or Square marked them invalid) are left out, as in Gapping.
//
// Works in the browser (window.SwingClubSpread) and in Node (module.exports).
(function (root) {
  const MIN_SHOTS = 5;          // a club's ring and its table numbers need this many shots
  const RING_K = Math.sqrt(-2 * Math.log(1 / 3));   // 1.48: a 2D normal's ellipse holding 2 of 3 shots
  const FAR_SD = 3;             // a shot further than this many robust SDs out is drawn but not in the ring
  const SLOTS = 8;
  const YD_FT = 3;

  const finite = v => typeof v === "number" && Number.isFinite(v);
  const Gapping = () => root.SwingGapping || (typeof require !== "undefined" ? require("./gapping.js") : null);
  const Tracer = () => root.SwingTracer || (typeof require !== "undefined" ? require("./tracer.js") : null);

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }
  const sorted = xs => xs.filter(finite).sort((a, b) => a - b);

  /** Clubs in bag order (driver first, putter left out). */
  function bagOrder(clubs) {
    const G = Gapping();
    const uniq = [...new Set(clubs.filter(Boolean))];
    return G ? G.sortClubs(uniq) : uniq.sort();
  }

  /** Each club's colour slot (0-7) and whether it is a second-round club (hollow / dashed): {club: {slot, alt}}. */
  function colors(allClubs) {
    const out = {};
    bagOrder(allClubs).forEach((club, i) => { out[club] = { slot: i % SLOTS, alt: i >= SLOTS }; });
    return out;
  }

  /** Whether a row is a real shot with a landing spot. */
  function usable(r) {
    if (!r || !finite(r.carry) || r.carry <= 0 || !finite(r.offline)) return false;
    const shot = r.c && r.c.shot;
    const G = Gapping();
    return !(shot && G && G.isMishit(shot));
  }

  /** The ellipse of points (xs, ys) holding about 2 of 3 of them: center, half-axes, angle (radians). */
  function ring(xs, ys) {
    const n = xs.length;
    if (n < MIN_SHOTS) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
    sxx /= n - 1; syy /= n - 1; sxy /= n - 1;
    const tr = (sxx + syy) / 2, det = Math.sqrt(((sxx - syy) / 2) ** 2 + sxy ** 2);
    return { cx: mx, cy: my, a: RING_K * Math.sqrt(tr + det), b: RING_K * Math.sqrt(Math.max(0, tr - det)),
             th: 0.5 * Math.atan2(2 * sxy, sxx - syy) };
  }

  /** Points of an ellipse (in data units) for drawing. */
  function ringPoints(e, steps = 64) {
    const pts = [];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps * 2 * Math.PI, u = Math.cos(t) * e.a, v = Math.sin(t) * e.b;
      pts.push([e.cx + u * Math.cos(e.th) - v * Math.sin(e.th), e.cy + u * Math.sin(e.th) + v * Math.cos(e.th)]);
    }
    return pts;
  }

  /** Shots far off the club's usual pattern (beyond FAR_SD robust SDs in carry or left/right). */
  function farOff(rows) {
    const c = sorted(rows.map(r => r.carry)), s = sorted(rows.map(r => r.offline));
    const mc = quantile(c, 0.5), ms = quantile(s, 0.5);
    const sdc = Math.max(1, (quantile(c, 0.75) - quantile(c, 0.25)) / 1.349), sds = Math.max(1, (quantile(s, 0.75) - quantile(s, 0.25)) / 1.349);
    return r => Math.abs(r.carry - mc) > FAR_SD * sdc || Math.abs(r.offline - ms) > FAR_SD * sds;
  }

  /**
   * Every club's spread: {clubs: [{club, n, enough, rows, carry: {lo, mid, hi}, side: {lo, mid, hi},
   * depth, width, leftPct, rightPct, ring, far}], widest, tightest, status}. `rows`: swing rows of every club in
   * the period; `opts.bag`: every club ever hit (for the order).
   */
  function analyze(rows, opts = {}) {
    const by = {};
    for (const r of rows || []) if (usable(r) && r.club) (by[r.club] = by[r.club] || []).push(r);
    const order = bagOrder(Object.keys(by));
    const clubs = order.map(club => {
      const rs = by[club], n = rs.length, enough = n >= MIN_SHOTS;
      const c = sorted(rs.map(r => r.carry)), s = sorted(rs.map(r => r.offline));
      const out = { club, n, enough, rows: rs, carry: null, side: null, depth: null, width: null, leftPct: null, rightPct: null, ring: null, far: [] };
      if (!enough) return out;
      out.carry = { lo: quantile(c, 0.1), mid: quantile(c, 0.5), hi: quantile(c, 0.9) };
      out.side = { lo: quantile(s, 0.1), mid: quantile(s, 0.5), hi: quantile(s, 0.9) };
      out.depth = out.carry.hi - out.carry.lo;
      out.width = out.side.hi - out.side.lo;
      out.leftPct = rs.filter(r => r.offline < 0).length / n;
      out.rightPct = rs.filter(r => r.offline > 0).length / n;
      const isFar = farOff(rs);
      const inner = rs.filter(r => !isFar(r));
      out.far = rs.filter(isFar);
      out.ring = ring(inner.map(r => r.offline), inner.map(r => r.carry));
      return out;
    });
    const ok = clubs.filter(c => c.enough && c.carry.mid > 0);
    // Width against length: a driver 30 yd wide is tighter, for its length, than a wedge 20 yd wide.
    const rel = c => c.width / c.carry.mid;
    const widest = ok.length >= 2 ? ok.reduce((a, b) => rel(b) > rel(a) ? b : a) : null;
    const tightest = ok.length >= 2 ? ok.reduce((a, b) => rel(b) < rel(a) ? b : a) : null;
    const shots = clubs.reduce((k, c) => k + c.n, 0);
    const status = clubs.length ? `${clubs.length} club${clubs.length === 1 ? "" : "s"} · ${shots} shots` : "";
    return { clubs, widest, tightest, status };
  }

  /** "4 yd left" / "3 yd right" / "on the line". */
  function sideWords(v) {
    if (!finite(v)) return "–";
    const a = Math.abs(v);
    if (a < 0.5) return "on the line";
    return `${a.toFixed(0)} yd ${v < 0 ? "left" : "right"}`;
  }

  /** Which way the pattern leans, in words: "62% left", or "even" when neither side has 60%. */
  function leanWords(c) {
    if (c.leftPct == null) return "–";
    if (c.leftPct >= 0.6) return `${Math.round(c.leftPct * 100)}% left`;
    if (c.rightPct >= 0.6) return `${Math.round(c.rightPct * 100)}% right`;
    return "even";
  }

  // ---- Flights ----

  /**
   * One shot's flight, landing where Square said: {row, club, pts: [[down yd, up ft, side yd]], carry, side,
   * apexFt}, or null when the shot can't be flown (no launch numbers, a mishit).
   */
  function flight(r) {
    if (!usable(r)) return null;
    const T = Tracer();
    const b = (r.c && r.c.shot && r.c.shot.ball) || {};
    const speed = finite(r.ballSpeed) ? r.ballSpeed : b.speed, vla = finite(r.launch) ? r.launch : b.vla;
    const spin = finite(r.spin) ? r.spin : b.totalSpin;
    if (!T || !finite(speed) || !finite(vla) || !finite(spin)) return null;
    const hla = finite(r.direction) ? r.direction : (finite(b.hla) ? b.hla : 0);
    const axis = finite(r.spinAxis) ? r.spinAxis : (finite(b.spinAxis) ? b.spinAxis : 0);
    const fl = T.flightPath(speed, vla, hla, spin, axis);
    if (!fl || !(fl.carry > 0)) return null;
    const M_YD = 1.09361, M_FT = 3.28084;
    const land = fl.points[fl.points.length - 1];
    const downM = land[1] * M_YD;
    if (!(downM > 0)) return null;
    // Stretch to Square's landing spot and apex: the chart then agrees with every number on the page.
    const downTo = Math.sqrt(Math.max(1, r.carry * r.carry - r.offline * r.offline));
    const sx = downTo / downM;
    const sy = finite(b.apexFt) && b.apexFt > 0 && fl.apexFt > 0 ? b.apexFt / fl.apexFt : 1;
    const sideFix = r.offline - land[3] * M_YD;
    const pts = fl.points.map(p => {
      const d = p[1] * M_YD;
      return [d * sx, p[2] * M_FT * sy, p[3] * M_YD + sideFix * (d / downM)];
    });
    return { row: r, club: r.club, pts, carry: r.carry, side: r.offline, apexFt: fl.apexFt * sy };
  }

  /** A session's flights: {flights, clubs (bag order, with counts), skipped}. */
  function sessionFlights(rows) {
    const flights = [], counts = {};
    let skipped = 0;
    for (const r of rows || []) {
      const f = flight(r);
      if (!f) { skipped++; continue; }
      flights.push(f);
      counts[f.club] = (counts[f.club] || 0) + 1;
    }
    const clubs = bagOrder(Object.keys(counts)).map(club => {
      const fs = flights.filter(f => f.club === club);
      const med = xs => quantile(sorted(xs), 0.5);
      return { club, n: fs.length, carry: med(fs.map(f => f.carry)), apexFt: med(fs.map(f => f.apexFt)),
               side: med(fs.map(f => f.side)) };
    });
    return { flights, clubs, skipped };
  }

  // ---- Drawing (browser only) ----

  const NS = "http://www.w3.org/2000/svg";
  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function hel(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function niceStep(span, want) {
    const raw = span / Math.max(1, want), p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  }
  function ticks(lo, hi, want) {
    const st = niceStep(hi - lo, want), out = [];
    for (let v = Math.ceil(lo / st) * st; v <= hi + 1e-9; v += st) out.push(Math.round(v * 1000) / 1000);
    return out;
  }
  const colorVar = (cmap, club) => `var(--cs${((cmap[club] || { slot: 0 }).slot) + 1})`;
  const isAlt = (cmap, club) => !!(cmap[club] && cmap[club].alt);

  let clipN = 0;
  /** The chart box: an svg and a tooltip; returns {svg, show(evt, lines), hide(), clip}: `clip` is a clip-path
   *  value that cuts lines and rings at the plot's edge (margins `m`). */
  function chartBox(parent, W, H, label, m) {
    const wrap = hel("div", "a-chart cs-chart");
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": label, class: "cs-svg" });
    const tip = hel("div", "tip");
    tip.hidden = true;
    wrap.append(svg, tip);
    parent.appendChild(wrap);
    const id = `cs-clip-${++clipN}`;
    const cp = el("clipPath", { id }, el("defs", {}, svg));
    el("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b }, cp);
    const show = (evt, lines) => {
      tip.replaceChildren();
      lines.forEach((ln, i) => tip.append(i ? hel("div", null, ln) : hel("b", null, ln)));
      tip.hidden = false;
      const box = wrap.getBoundingClientRect();
      const x = evt.clientX - box.left, y = evt.clientY - box.top;
      const tw = tip.offsetWidth || 160;
      tip.style.left = `${Math.max(0, Math.min(box.width - tw, x + 12))}px`;
      tip.style.top = `${Math.max(0, y - 10 - (tip.offsetHeight || 40))}px`;
    };
    return { svg, show, hide: () => { tip.hidden = true; }, clip: `url(#${id})` };
  }

  /** Club chips: tap to hide or show a club. `hidden`: a Set of clubs, changed in place; `redraw` after. */
  function chips(parent, clubs, cmap, hidden, nameOf, redraw) {
    const row = hel("div", "cs-chips");
    for (const c of clubs) {
      const b = hel("button", "cs-chip" + (hidden.has(c.club) ? " off" : ""));
      b.type = "button";
      const sw = hel("i", "cs-sw" + (isAlt(cmap, c.club) ? " alt" : ""));
      sw.style.setProperty("--c", colorVar(cmap, c.club));
      b.append(sw, `${nameOf(c.club)} `, hel("span", "cs-n", `${c.n}`));
      b.setAttribute("aria-pressed", String(!hidden.has(c.club)));
      b.title = hidden.has(c.club) ? "Show this club" : "Hide this club";
      b.onclick = () => { hidden.has(c.club) ? hidden.delete(c.club) : hidden.add(c.club); redraw(); };
      row.appendChild(b);
    }
    parent.appendChild(row);
  }

  function axisText(svg, x, y, text, anchor, cls) {
    const t = el("text", { x, y, "text-anchor": anchor || "middle", class: cls || "cs-tick" }, svg);
    t.textContent = text;
    return t;
  }

  /** Moves labels apart up and down so none sits within `gap` px of another near it across (in place). */
  function spread(labs, gap, top, bottom) {
    labs.sort((a, b) => a.y - b.y);
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 1; i < labs.length; i++) {
        for (let j = 0; j < i; j++) {
          const a = labs[j], b = labs[i];
          if (Math.abs(a.x - b.x) < 70 && b.y - a.y < gap) b.y = a.y + gap;
        }
      }
      const over = labs.length ? labs[labs.length - 1].y - bottom : 0;
      if (over > 0) for (const l of labs) l.y -= over;
      for (const l of labs) l.y = Math.max(top, l.y);
    }
    return labs;
  }

  const sideTick = v => v === 0 ? "0" : `${Math.abs(v)} ${v < 0 ? "L" : "R"}`;

  /**
   * The spread map and table. opts: {colors, nameOf(club), hidden: Set, onOpen(name), dayOf(ms), redraw}.
   */
  function renderSpread(box, model, opts = {}) {
    box.replaceChildren();
    const nameOf = opts.nameOf || (c => c);
    const cmap = opts.colors || colors(model.clubs.map(c => c.club));
    const hidden = opts.hidden || new Set();
    const dayOf = opts.dayOf || (ms => new Date(ms).toLocaleDateString());
    if (!model.clubs.length) { box.appendChild(hel("p", "note", "No shots with a carry in this period.")); return; }

    const say = hel("div", "pb-say");
    if (model.widest && model.tightest && model.widest !== model.tightest) {
      const w = model.widest, t = model.tightest;
      say.append("For its length your ", hel("b", null, nameOf(w.club)), ` spreads widest: ${w.width.toFixed(0)} yd left to right on a ${w.carry.mid.toFixed(0)} yd carry. Tightest: the `,
        hel("b", null, nameOf(t.club)), `, ${t.width.toFixed(0)} yd on ${t.carry.mid.toFixed(0)} yd.`);
    } else {
      say.textContent = `A club needs ${MIN_SHOTS} shots for its ring and numbers.`;
    }
    box.appendChild(say);
    chips(box, model.clubs, cmap, hidden, nameOf, opts.redraw || (() => renderSpread(box, model, opts)));

    const shown = model.clubs.filter(c => !hidden.has(c.club));
    const pts = shown.flatMap(c => c.rows);
    if (!pts.length) return;
    const W = Math.max(300, box.clientWidth || 640), H = Math.max(360, Math.min(560, Math.round(W * 0.75)));
    const m = { l: 48, r: 14, t: 18, b: 36 };
    const { svg, show, hide, clip } = chartBox(box, W, H, "Where each club's shots land: carry up, left and right across", m);
    // Left/right: the middle shots set the width (one wild shot doesn't squash the rest); far ones sit at the edge.
    const absSide = sorted(pts.map(r => Math.abs(r.offline)));
    const half = Math.max(15, quantile(absSide, 0.98) * 1.15);
    // Up and down the same way: a topped shot of 40 yd sits on the bottom edge instead of stretching the chart.
    const carries = sorted(pts.map(r => r.carry));
    const yHi = carries[carries.length - 1] * 1.04, yLo = Math.max(0, quantile(carries, 0.01) - 15);
    const sx = v => m.l + (Math.max(-half, Math.min(half, v)) + half) / (2 * half) * (W - m.l - m.r);
    const sy = v => H - m.b - (Math.max(yLo, Math.min(yHi, v)) - yLo) / (yHi - yLo) * (H - m.t - m.b);
    // Rings aren't pinned to the edge: they run past it and are cut there.
    const rx = v => m.l + (v + half) / (2 * half) * (W - m.l - m.r), ry = v => H - m.b - (v - yLo) / (yHi - yLo) * (H - m.t - m.b);
    for (const v of ticks(yLo, yHi, 6)) {
      el("line", { x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v), class: "cs-grid" }, svg);
      axisText(svg, m.l - 6, sy(v) + 4, `${v}`, "end");
    }
    for (const v of ticks(-half, half, 6)) axisText(svg, sx(v), H - m.b + 16, sideTick(v));
    el("line", { x1: sx(0), x2: sx(0), y1: m.t, y2: H - m.b, class: "cs-target" }, svg);
    axisText(svg, m.l, 12, "Carry (yd)", "start", "cs-title");
    axisText(svg, W - m.r, H - 4, "Left / right (yd)", "end", "cs-title");

    // Rings under the dots, labels on top.
    for (const c of shown) {
      if (!c.ring) continue;
      const p = ringPoints(c.ring).map(([x, y]) => `${rx(x).toFixed(1)},${ry(y).toFixed(1)}`).join(" ");
      const poly = el("polygon", { points: p, class: "cs-ring" + (isAlt(cmap, c.club) ? " alt" : ""), "clip-path": clip }, svg);
      poly.style.setProperty("--c", colorVar(cmap, c.club));
    }
    for (const c of shown) {
      for (const r of c.rows) {
        const far = c.far.includes(r);
        const dot = el("circle", { cx: sx(r.offline), cy: sy(r.carry), r: 3, class: "cs-dot cs-shot" + (isAlt(cmap, c.club) ? " alt" : "") + (far ? " far" : "") }, svg);
        dot.style.setProperty("--c", colorVar(cmap, c.club));
        const hit = el("circle", { cx: sx(r.offline), cy: sy(r.carry), r: 9, class: "cs-hit", tabindex: 0, role: "button" }, svg);
        const lines = [`${nameOf(c.club)} · ${r.carry.toFixed(0)} yd`, sideWords(r.offline), r.t ? dayOf(r.t) : ""].filter(Boolean);
        hit.setAttribute("aria-label", lines.join(", "));
        hit.addEventListener("pointerenter", e => show(e, lines));
        hit.addEventListener("pointerleave", hide);
        if (opts.onOpen) {
          hit.addEventListener("click", () => opts.onOpen(r.name));
          hit.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); opts.onOpen(r.name); } });
        }
      }
    }
    const labs = shown.map(c => {
      const x = c.ring ? c.ring.cx : (c.side ? c.side.mid : c.rows[0].offline);
      const y = c.ring ? c.ring.cy : (c.carry ? c.carry.mid : c.rows[0].carry);
      return { text: nameOf(c.club), x: Math.min(W - m.r - 30, Math.max(m.l + 30, sx(x))), y: sy(y) + 4 };
    });
    spread(labs, 15, m.t + 10, H - m.b - 4);
    for (const l of labs) axisText(svg, l.x, l.y, l.text, "middle", "cs-label").setAttribute("paint-order", "stroke");

    // The table, in bag order.
    const wrap = hel("div", "cs-table-wrap");
    const tbl = hel("table", "a-table cs-table");
    const head = hel("tr");
    for (const h of ["Club", "Shots", "Carry (middle 80%)", "Long to short", "Left to right (middle 80%)", "Width", "Centre", "Leans"]) head.appendChild(hel("th", null, h));
    const thead = hel("thead"), tbody = hel("tbody");
    thead.appendChild(head);
    for (const c of model.clubs) {
      const tr = hel("tr");
      const name = hel("td");
      const sw = hel("i", "cs-sw" + (isAlt(cmap, c.club) ? " alt" : ""));
      sw.style.setProperty("--c", colorVar(cmap, c.club));
      name.append(sw, nameOf(c.club));
      tr.appendChild(name);
      tr.appendChild(hel("td", c.enough ? null : "dim", `${c.n}`));
      if (!c.enough) {
        const td = hel("td", "dim", `needs ${MIN_SHOTS} shots`);
        td.colSpan = 6;
        tr.appendChild(td);
      } else {
        tr.append(hel("td", null, `${c.carry.lo.toFixed(0)} to ${c.carry.hi.toFixed(0)} yd`), hel("td", null, `${c.depth.toFixed(0)} yd`),
          hel("td", null, `${sideWords(c.side.lo)} to ${sideWords(c.side.hi)}`), hel("td", null, `${c.width.toFixed(0)} yd`),
          hel("td", null, sideWords(c.side.mid)), hel("td", null, leanWords(c)));
      }
      tbody.appendChild(tr);
    }
    tbl.append(thead, tbody);
    wrap.appendChild(tbl);
    box.appendChild(wrap);
  }

  /**
   * A session's flights from the side and from above. opts: {colors, nameOf, hidden: Set, onOpen(name), redraw}.
   */
  function renderFlights(box, model, opts = {}) {
    box.replaceChildren();
    const nameOf = opts.nameOf || (c => c);
    const cmap = opts.colors || colors(model.clubs.map(c => c.club));
    const hidden = opts.hidden || new Set();
    if (!model.flights.length) {
      box.appendChild(hel("p", "note", "No shots to fly in this session (a flight needs Square's ball speed, launch and spin)."));
      return;
    }
    chips(box, model.clubs, cmap, hidden, nameOf, opts.redraw || (() => renderFlights(box, model, opts)));
    const fs = model.flights.filter(f => !hidden.has(f.club));
    if (!fs.length) return;
    const W = Math.max(300, box.clientWidth || 640);
    const m = { l: 48, r: 14, t: 18, b: 34 };
    const maxD = Math.max(...fs.map(f => f.pts[f.pts.length - 1][0])) * 1.04;
    const maxUp = Math.max(...fs.map(f => Math.max(...f.pts.map(p => p[1])))) * 1.12;
    // A wild shot or two run off the edge instead of squashing the rest.
    const maxSide = Math.max(10, quantile(sorted(fs.map(f => Math.max(...f.pts.map(p => Math.abs(p[2]))))), 0.95)) * 1.2;
    const sxD = v => m.l + v / maxD * (W - m.l - m.r);
    const xTicks = ticks(0, maxD, 7);

    const views = [
      { label: "From the side: height (ft) against distance (yd)", title: "Height (ft)", H: Math.max(220, Math.min(320, Math.round(W * 0.38))),
        lo: 0, hi: maxUp, val: p => p[1], tick: v => `${v}` },
      { label: "From above: left and right (yd) against distance (yd)", title: "Left / right (yd)", H: Math.max(200, Math.min(300, Math.round(W * 0.34))),
        lo: -maxSide, hi: maxSide, val: p => -p[2], tick: v => sideTick(-v) },   // left of the target line drawn up
    ];
    const lineEls = new Map();
    const highlight = (f, on) => { for (const ln of lineEls.get(f) || []) ln.classList.toggle("hot", on); };
    for (const v of views) {
      box.appendChild(hel("div", "cs-view-h", v.label.split(":")[0]));
      const { svg, show, hide, clip } = chartBox(box, W, v.H, v.label, m);
      const sy = y => v.H - m.b - (Math.max(v.lo, Math.min(v.hi, y)) - v.lo) / (v.hi - v.lo) * (v.H - m.t - m.b);
      const ly = y => v.H - m.b - (y - v.lo) / (v.hi - v.lo) * (v.H - m.t - m.b);   // lines run past the edge, cut there
      for (const t of ticks(v.lo, v.hi, 5)) {
        el("line", { x1: m.l, x2: W - m.r, y1: sy(t), y2: sy(t), class: t === 0 ? "cs-target" : "cs-grid" }, svg);
        axisText(svg, m.l - 6, sy(t) + 4, v.tick(t), "end");
      }
      for (const t of xTicks) axisText(svg, sxD(t), v.H - m.b + 16, `${t}`);
      axisText(svg, m.l, 12, v.title, "start", "cs-title");
      axisText(svg, W - m.r, v.H - 4, "Distance (yd)", "end", "cs-title");
      for (const f of fs) {
        const d = f.pts.map((p, i) => `${i ? "L" : "M"}${sxD(p[0]).toFixed(1)},${ly(v.val(p)).toFixed(1)}`).join("");
        const ln = el("path", { d, class: "cs-flight" + (isAlt(cmap, f.club) ? " alt" : ""), "clip-path": clip }, svg);
        ln.style.setProperty("--c", colorVar(cmap, f.club));
        const end = f.pts[f.pts.length - 1];
        const dot = el("circle", { cx: sxD(end[0]), cy: sy(v.val(end)), r: 3.5, class: "cs-dot" + (isAlt(cmap, f.club) ? " alt" : "") }, svg);
        dot.style.setProperty("--c", colorVar(cmap, f.club));
        if (!lineEls.has(f)) lineEls.set(f, []);
        lineEls.get(f).push(ln);
        const hit = el("path", { d, class: "cs-hitline", tabindex: 0, role: "button", "clip-path": clip }, svg);
        const lines = [`${nameOf(f.club)} · ${f.carry.toFixed(0)} yd carry`, `Apex ${f.apexFt.toFixed(0)} ft`, sideWords(f.side)];
        hit.setAttribute("aria-label", lines.join(", "));
        hit.addEventListener("pointerenter", e => { highlight(f, true); show(e, lines); });
        hit.addEventListener("pointermove", e => show(e, lines));
        hit.addEventListener("pointerleave", () => { highlight(f, false); hide(); });
        if (opts.onOpen) {
          hit.addEventListener("click", () => opts.onOpen(f.row.name));
          hit.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); opts.onOpen(f.row.name); } });
        }
      }
      // Each club named once, by its middle flight (by carry): over its apex from the side, past its landing
      // spot from above; names that would overlap are pushed apart.
      const labs = [];
      for (const c of model.clubs) {
        if (hidden.has(c.club)) continue;
        const own = fs.filter(f => f.club === c.club).sort((a, b) => a.carry - b.carry);
        if (!own.length) continue;
        const f = own[Math.floor((own.length - 1) / 2)];
        const p = v === views[0] ? f.pts.reduce((a, b) => b[1] > a[1] ? b : a) : f.pts[f.pts.length - 1];
        labs.push({ text: nameOf(c.club), x: Math.min(W - m.r - 30, sxD(p[0])), y: sy(v.val(p)) - 8 });
      }
      spread(labs, 15, m.t + 10, v.H - m.b - 4);
      for (const l of labs) axisText(svg, l.x, l.y, l.text, "middle", "cs-label").setAttribute("paint-order", "stroke");
    }
    const tbl = hel("table", "a-table cs-table");
    const thead = hel("thead"), tbody = hel("tbody"), head = hel("tr");
    for (const h of ["Club", "Shots", "Carry", "Apex", "Lands"]) head.appendChild(hel("th", null, h));
    thead.appendChild(head);
    for (const c of model.clubs) {
      const tr = hel("tr"), name = hel("td"), sw = hel("i", "cs-sw" + (isAlt(cmap, c.club) ? " alt" : ""));
      sw.style.setProperty("--c", colorVar(cmap, c.club));
      name.append(sw, nameOf(c.club));
      tr.append(name, hel("td", null, `${c.n}`), hel("td", null, `${c.carry.toFixed(0)} yd`), hel("td", null, `${c.apexFt.toFixed(0)} ft`),
        hel("td", null, sideWords(c.side)));
      tbody.appendChild(tr);
    }
    tbl.append(thead, tbody);
    const wrap = hel("div", "cs-table-wrap");
    wrap.appendChild(tbl);
    box.appendChild(wrap);
    if (model.skipped) box.appendChild(hel("div", "note", `${model.skipped} shot${model.skipped === 1 ? "" : "s"} not drawn (a mishit, or no launch numbers).`));
  }

  const api = { MIN_SHOTS, RING_K, SLOTS, bagOrder, colors, usable, ring, ringPoints, analyze, sideWords, leanWords,
                flight, sessionFlights, renderSpread, renderFlights };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingClubSpread = api;
})(typeof window !== "undefined" ? window : globalThis);
