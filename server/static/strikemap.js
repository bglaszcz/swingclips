// Strike heat map on the club face and its trend over sessions.
//
// Strike location: Square Omni reports clubData.faceImpactH (toe/heel, mm) and
// faceImpactV (high/low, mm, + = high).
// Toe/heel sign: Square's + is the HEEL (its "T" in the CSV export, which is really a heel strike:
// the owner's square_parse.py, confirmed against feel 24 Aug; the database's + is the CSV's "T").
//
// Box:
//   Irons and wedges: 70 mm wide x 40 mm tall around face centre (0, 0).
//   Woods and driver: 90 mm wide x 50 mm tall around face centre (0, 0).
//
// Works in the browser (window.SwingStrikeMap) and in Node (module.exports).
(function (root) {
  const GoodShots = root.SwingGoodShots || (typeof require !== "undefined" && (() => {
    try { return require("./goodshots.js"); } catch { return null; }
  })());

  const BOX_IRONS = Object.freeze({ width: 70, height: 40 });
  const BOX_WOODS = Object.freeze({ width: 90, height: 50 });

  const MIN_STRIKES_COMPARE = 5;
  const MIN_MOVE_MM = 3;
  const MAX_BASELINE_SESSIONS = 6;

  const finite = v => typeof v === "number" && Number.isFinite(v);
  const round = (v, d = 1) => (v == null || !Number.isFinite(v)) ? null : Number(v.toFixed(d));

  function median(xs) {
    const v = (xs || []).filter(finite).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  function quantile(xs, q) {
    const v = (xs || []).filter(finite).sort((a, b) => a - b);
    if (!v.length) return null;
    const pos = (v.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (base + 1 < v.length) {
      return v[base] + rest * (v[base + 1] - v[base]);
    }
    return v[base];
  }

  /** Club face box for a club or club group. */
  function boxOf(clubOrGroup) {
    if (clubOrGroup === "woods") return { ...BOX_WOODS };
    if (clubOrGroup === "irons") return { ...BOX_IRONS };
    const group = (clubOrGroup && GoodShots && GoodShots.groupOf ? GoodShots.groupOf(clubOrGroup) : null) || clubOrGroup;
    return group === "woods" ? { ...BOX_WOODS } : { ...BOX_IRONS };
  }

  /** Extracts {h, v} in mm from a shot object in any supported format. */
  function extractStrike(s) {
    if (!s) return null;
    if (Array.isArray(s) && s.length >= 2 && finite(s[0]) && finite(s[1])) {
      return { h: s[0], v: s[1] };
    }
    let h = s.strikeH != null ? s.strikeH : s.h;
    let v = s.strikeV != null ? s.strikeV : s.v;
    if ((h == null || v == null) && s.shot && s.shot.clubData) {
      h = s.shot.clubData.faceImpactH;
      v = s.shot.clubData.faceImpactV;
    } else if ((h == null || v == null) && s.clubData) {
      h = s.clubData.faceImpactH;
      v = s.clubData.faceImpactV;
    }
    if (finite(h) && finite(v)) {
      return { h, v };
    }
    return null;
  }

  /**
   * 1D Gaussian convolution kernel: [0.06, 0.24, 0.40, 0.24, 0.06].
   * Smooths lightly so ~20 shots read as a blob without blurring out location.
   */
  const GAUSS_KERNEL = [0.06, 0.24, 0.40, 0.24, 0.06];
  const GAUSS_RADIUS = 2;

  function blur2d(matrix, rows, cols) {
    const temp = Array.from({ length: rows }, () => new Float32Array(cols));
    for (let r = 0; r < rows; r++) {
      const row = matrix[r];
      const target = temp[r];
      for (let c = 0; c < cols; c++) {
        let sum = 0;
        for (let k = -GAUSS_RADIUS; k <= GAUSS_RADIUS; k++) {
          const sc = Math.min(cols - 1, Math.max(0, c + k));
          sum += row[sc] * GAUSS_KERNEL[k + GAUSS_RADIUS];
        }
        target[c] = sum;
      }
    }
    const out = Array.from({ length: rows }, () => new Array(cols));
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        let sum = 0;
        for (let k = -GAUSS_RADIUS; k <= GAUSS_RADIUS; k++) {
          const sr = Math.min(rows - 1, Math.max(0, r + k));
          sum += temp[sr][c] * GAUSS_KERNEL[k + GAUSS_RADIUS];
        }
        out[r][c] = Number(sum.toFixed(4));
      }
    }
    return out;
  }

  /**
   * 2D histogram of (strikeH, strikeV) over a club-face box, lightly smoothed.
   * @param shots Array of shots or strike objects
   * @param opts {club, group, box, cols, rows}
   * @returns {cells: [[count]], bins, n, centre: {h, v}, spread: {h, v}, shots: [{h, v}]}
   */
  function grid(shots, opts) {
    opts = opts || {};
    const box = opts.box || boxOf(opts.group || opts.club);
    const width = box.width || 70;
    const height = box.height || 40;

    // Standard bin resolution (~2.5 mm per cell): 28x16 for irons, 36x20 for woods
    const cols = opts.cols || (opts.bins && opts.bins.h) || Math.round(width / 2.5);
    const rows = opts.rows || (opts.bins && opts.bins.v) || Math.round(height / 2.5);

    const valid = [];
    for (const s of shots || []) {
      const p = extractStrike(s);
      if (p) valid.push(p);
    }

    const n = valid.length;
    let centre = null;
    let spread = null;

    if (n > 0) {
      const hs = valid.map(p => p.h);
      const vs = valid.map(p => p.v);
      centre = {
        h: round(median(hs), 1),
        v: round(median(vs), 1),
      };
      const q25H = quantile(hs, 0.25), q75H = quantile(hs, 0.75);
      const q25V = quantile(vs, 0.25), q75V = quantile(vs, 0.75);
      spread = {
        h: round(q75H - q25H, 1),
        v: round(q75V - q25V, 1),
      };
    }

    const minH = -width / 2, maxH = width / 2;
    const minV = -height / 2, maxV = height / 2;
    const stepH = width / cols;
    const stepV = height / rows;

    const raw = Array.from({ length: rows }, () => new Float32Array(cols));
    for (const p of valid) {
      // Map H to col: minH -> 0, maxH -> cols - 1
      const c = Math.min(cols - 1, Math.max(0, Math.floor((p.h - minH) / stepH)));
      // Map V to row: minV (low) -> 0, maxV (high) -> rows - 1
      const r = Math.min(rows - 1, Math.max(0, Math.floor((p.v - minV) / stepV)));
      raw[r][c] += 1;
    }

    const cells = blur2d(raw, rows, cols);
    const bins = {
      h: cols,
      v: rows,
      cols,
      rows,
      width,
      height,
      minH,
      maxH,
      minV,
      maxV,
      stepH,
      stepV,
    };

    return {
      cells,
      bins,
      n,
      centre,
      spread,
      shots: valid,
    };
  }

  /**
   * Strike trend per session (for sessions with 5+ strikes).
   * @param sessions Array of sessions [{start, rows | shots | swings}]
   * @param opts {club, group, box}
   * @returns [{start, centre, spread, n}]
   */
  function trend(sessions, opts) {
    const out = [];
    for (const s of sessions || []) {
      const shots = s.rows || s.shots || s.swings || (Array.isArray(s) ? s : []);
      const g = grid(shots, opts);
      if (g.n >= MIN_STRIKES_COMPARE) {
        out.push({
          start: s.start != null ? s.start : (s.t != null ? s.t : 0),
          centre: g.centre,
          spread: g.spread,
          n: g.n,
        });
      }
    }
    return out;
  }

  /**
   * Plain-words description of horizontal strike position or difference (Square: + is heel, - is toe).
   * e.g. "8 mm heel", "3 mm toe", "centre" (|h| < 1), or "" for null/non-finite.
   */
  function hWords(h, opts) {
    if (h == null || !finite(h)) return "";
    opts = opts || {};
    const toeSign = (opts.toeSign === 1) ? 1 : SQUARE_TOE_SIGN;
    const isHeel = toeSign === -1 ? h > 0 : h < 0;
    const abs = Math.abs(h);
    if (abs < 1.0) {
      if (opts.diff) return "0 mm";
      return opts.centered ? "centered" : "centre";
    }
    const dist = Math.round(abs);
    const toward = opts.toward || opts.diff || opts.short === false;
    const side = isHeel ? (toward ? "toward the heel" : "heel") : (toward ? "toward the toe" : "toe");
    return `${dist} mm ${side}`;
  }

  /**
   * Plain-words description of vertical strike position or difference (+ is high, - is low).
   * e.g. "14 mm low", "5 mm high", "centre" (|v| < 1), or "" for null/non-finite.
   */
  function vWords(v, opts) {
    if (v == null || !finite(v)) return "";
    opts = opts || {};
    const abs = Math.abs(v);
    if (abs < 1.0) {
      if (opts.diff) return "0 mm";
      return opts.midFace ? "mid-face" : "centre";
    }
    const dist = Math.round(abs);
    if (opts.diff || opts.toward) {
      return v > 0 ? `${dist} mm higher on the face` : `${dist} mm lower on the face`;
    }
    const side = v > 0 ? "high" : "low";
    return `${dist} mm ${side}`;
  }

  function hDiffWords(dh, opts) {
    return hWords(dh, { diff: true, ...(opts || {}) });
  }

  function vDiffWords(dv, opts) {
    return vWords(dv, { diff: true, ...(opts || {}) });
  }

  /**
   * Plain text description of a spot on the club face.
   * e.g. "3 mm toward the heel, 17 mm low"
   */
  function spotText(point, opts) {
    if (!point || !finite(point.h) || !finite(point.v)) return "";
    opts = opts || {};
    const toeSign = (opts.toeSign === 1) ? 1 : SQUARE_TOE_SIGN;
    const h = opts.toeSign === 1 ? -point.h : point.h;
    const v = point.v;

    const parts = [];
    const hPart = hWords(h, { toward: !opts.short, centered: true, toeSign: SQUARE_TOE_SIGN });
    const vPart = vWords(v, { midFace: true });
    if (hPart) parts.push(hPart);
    if (vPart) parts.push(vPart);
    return parts.join(", ");
  }

  function toSummary(item, opts) {
    if (!item) return null;
    if (item.centre && item.spread) return item;
    const shots = item.rows || item.shots || item.swings || (Array.isArray(item) ? item : null);
    if (shots) {
      const g = grid(shots, opts);
      return g.n >= MIN_STRIKES_COMPARE ? g : null;
    }
    return null;
  }

  /**
   * Compares the latest session against the median of up to 6 earlier sessions.
   * @param recent Session, shots array, or {centre, spread, n} summary
   * @param before Array of earlier sessions / summaries (or single summary)
   * @param opts {toeSign: +1 | -1, toe: "+" | "-", club, group}
   * @returns {moved: {h, v} mm, tighter: bool, text: string | null}
   */
  function compare(recent, before, opts) {
    if (Array.isArray(recent) && arguments.length === 1) {
      const list = recent;
      opts = before || {};
      const sessions = trend(list, opts);
      if (sessions.length < 2) {
        return { moved: null, tighter: null, text: null };
      }
      recent = sessions[sessions.length - 1];
      before = sessions.slice(0, -1);
    }
    opts = opts || {};
    const toeSign = (opts.toeSign === 1) ? 1 : SQUARE_TOE_SIGN;

    const rec = toSummary(recent, opts);
    if (!rec || !rec.centre || (rec.n != null && rec.n < MIN_STRIKES_COMPARE)) {
      return { moved: null, tighter: null, text: null };
    }

    const earlierList = Array.isArray(before) ? before : (before ? [before] : []);
    const validEarlier = [];
    for (const b of earlierList) {
      const s = toSummary(b, opts);
      if (s && s.centre) validEarlier.push(s);
    }
    const baselinePool = validEarlier.slice(-MAX_BASELINE_SESSIONS);
    if (!baselinePool.length) {
      return { moved: null, tighter: null, text: null };
    }

    const baseH = median(baselinePool.map(s => s.centre.h));
    const baseV = median(baselinePool.map(s => s.centre.v));
    const baseSpreadH = median(baselinePool.map(s => s.spread.h));
    const baseSpreadV = median(baselinePool.map(s => s.spread.v));
    const baseSpread = ((baseSpreadH || 0) + (baseSpreadV || 0)) / 2;
    const recSpread = ((rec.spread.h || 0) + (rec.spread.v || 0)) / 2;

    // Session-to-session wobble across baseline sessions
    const wobbleH = baselinePool.length > 1
      ? (median(baselinePool.map(s => Math.abs(s.centre.h - baseH))) || 0)
      : 0;
    const wobbleV = baselinePool.length > 1
      ? (median(baselinePool.map(s => Math.abs(s.centre.v - baseV))) || 0)
      : 0;

    const threshH = Math.max(MIN_MOVE_MM, wobbleH);
    const threshV = Math.max(MIN_MOVE_MM, wobbleV);

    const diffH = rec.centre.h - baseH;
    const diffV = rec.centre.v - baseV;

    const hMoved = Math.abs(diffH) >= threshH;
    const vMoved = Math.abs(diffV) >= threshV;

    // Direction toward toe vs heel according to toeSign
    let hText = null;
    if (hMoved) {
      hText = hWords(diffH, { toward: true, toeSign });
    }

    let vText = null;
    if (vMoved) {
      vText = vWords(diffV, { diff: true });
    }

    // Tighter: spread reduced by at least 2 mm or by 15%+
    const tighter = (baseSpread - recSpread) >= 2.0 || (baseSpread > 0 && recSpread / baseSpread < 0.85);
    const looser = (recSpread - baseSpread) >= 2.0 || (baseSpread > 0 && recSpread / baseSpread > 1.15);

    let text;
    if (hMoved && vMoved) {
      text = `Strikes moved ${hText} and ${vText}`;
    } else if (hMoved) {
      if (rec.centre.v <= -8) {
        const lowMm = Math.round(Math.abs(rec.centre.v));
        text = `Strikes moved ${hText} and stayed low (${lowMm} mm below centre)`;
      } else {
        text = `Strikes moved ${hText}`;
      }
    } else if (vMoved) {
      text = `Strikes moved ${vText}`;
    } else if (tighter) {
      text = "Tighter than usual";
    } else if (looser) {
      text = "More spread out than usual";
    } else {
      text = "About the same as usual";
    }

    return {
      moved: { h: round(diffH, 1), v: round(diffV, 1) },
      tighter,
      text,
      base: {
        centre: { h: round(baseH, 1), v: round(baseV, 1) },
        spread: { h: round(baseSpreadH, 1), v: round(baseSpreadV, 1) },
      },
    };
  }

  // Square's faceImpactH: - is toward the toe (see the top).
  const SQUARE_TOE_SIGN = -1;

  function getToeSign() {
    return SQUARE_TOE_SIGN;
  }

  // ---- The face picture (Oct 9, the owner: like FlightScope's): a club face seen from the front, toe on
  // the left and the hosel on the right (a right-hander's club), a smooth heat map of where the strikes
  // land (green, yellow, red where most are), the latest shot as a dot, the usual spot as a dashed ring,
  // and an inch grid. Drawn in mm, the units Square reports, with y up (SVG y = -v). ----

  const MM_PER_INCH = 25.4;
  // Heat: each strike spread as a Gaussian of this many mm (irons, woods), on a grid of this many mm.
  const HEAT_SIGMA = { irons: 5, woods: 7 }, HEAT_STEP = 1;
  // Where a share of the busiest spot starts to show, and the colours from there to the busiest.
  const HEAT_FLOOR = 0.06;
  const HEAT_STOPS = [[0, [70, 205, 70]], [0.55, [245, 225, 40]], [1, [230, 45, 35]]];

  // The outlines in SVG coordinates (mm, y down), x = toward the heel. Iron: sole, round toe, top line
  // sloping down to the heel, hosel up to the right. Wood: a wide rounded face with a short hosel.
  const FACES = {
    irons: {
      face: "M 27 19 L -28 21 Q -44 21 -46 8 Q -48 -12 -38 -22 Q -33 -27 -26 -27 L 20 -14 Q 27 -13 31 -17 L 46 -48 L 57 -45 L 40 -8 Q 37 14 27 19 Z",
      grooves: { x0: -34, x1: 22, ys: [-12, -8.8, -5.6, -2.4, 0.8, 4, 7.2, 10.4, 13.6] },
      view: [-62, -48, 130, 82],
      tile: [-50, -30, 92, 56],
    },
    woods: {
      face: "M -54 -4 Q -52 -27 -20 -29 L 30 -27 Q 34 -27 38 -30 L 50 -46 L 59 -41 L 50 -22 Q 54 -8 52 4 Q 48 22 30 26 Q 0 30 -32 26 Q -54 20 -54 -4 Z",
      grooves: { x0: -18, x1: 18, ys: [-8, -4, 0, 4, 8] },
      view: [-68, -48, 140, 86],
      tile: [-58, -32, 116, 62],
    },
  };

  /**
   * The heat: a Gaussian density of the strikes on a grid over [x0, x1] x [v0, v1] (mm), normalised to
   * its busiest cell. {x0, v0, step, nx, nv, d: Float64Array (row 0 = v0, the low edge), max}.
   */
  function density(points, opts = {}) {
    const sigma = opts.sigma || HEAT_SIGMA.irons, step = opts.step || HEAT_STEP;
    const [x0, x1, v0, v1] = opts.extent || [-60, 60, -40, 40];
    const nx = Math.round((x1 - x0) / step) + 1, nv = Math.round((v1 - v0) / step) + 1;
    const d = new Float64Array(nx * nv);
    const reach = 3 * sigma, k = -0.5 / (sigma * sigma);
    for (const p of points || []) {
      if (!p || !finite(p.x) || !finite(p.v)) continue;
      const i0 = Math.max(0, Math.floor((p.x - reach - x0) / step)), i1 = Math.min(nx - 1, Math.ceil((p.x + reach - x0) / step));
      const j0 = Math.max(0, Math.floor((p.v - reach - v0) / step)), j1 = Math.min(nv - 1, Math.ceil((p.v + reach - v0) / step));
      for (let j = j0; j <= j1; j++) {
        const dv = v0 + j * step - p.v;
        for (let i = i0; i <= i1; i++) {
          const dx = x0 + i * step - p.x;
          d[j * nx + i] += Math.exp(k * (dx * dx + dv * dv));
        }
      }
    }
    let max = 0;
    for (const v of d) if (v > max) max = v;
    if (max > 0) for (let i = 0; i < d.length; i++) d[i] /= max;
    return { x0, v0, step, nx, nv, d, max };
  }

  /** A density share (0-1) as [r, g, b, a] (0-255): clear below HEAT_FLOOR, then green, yellow, red. */
  function heatColor(t) {
    if (!(t > HEAT_FLOOR)) return [0, 0, 0, 0];
    let i = 1;
    while (i < HEAT_STOPS.length - 1 && t > HEAT_STOPS[i][0]) i++;
    const [ta, ca] = HEAT_STOPS[i - 1], [tb, cb] = HEAT_STOPS[i];
    const f = Math.max(0, Math.min(1, (t - ta) / (tb - ta)));
    const rgb = ca.map((c, k) => Math.round(c + (cb[k] - c) * f));
    // Soft edge: fades in over the first third, then mostly opaque.
    const a = Math.round(255 * Math.min(0.88, 0.88 * (t - HEAT_FLOOR) / 0.3));
    return [...rgb, a];
  }

  let faceIds = 0;

  /**
   * The face picture as an SVG element (browser only). opts: {club, shots: [{h, v}] (the heat), dots:
   * [{h, v}] (small dots, e.g. the latest session), latest: {h, v} (the big dot), usual: {h, v} (dashed
   * ring), grid: true for the inch grid and labels, tile: true for a small picture (the face only, bigger
   * dots), title: text for each dot's tooltip (p => text)}.
   */
  function faceSvg(opts = {}) {
    const NS = "http://www.w3.org/2000/svg", id = `sf${++faceIds}`;
    const group = boxOf(opts.club || "irons").width === BOX_WOODS.width ? "woods" : "irons";
    const F = FACES[group];
    // Screen x: toe on the left (Square's - is the toe), so x = h; SVG y = -v.
    const sx = p => -SQUARE_TOE_SIGN * p.h, sy = p => -p.v;
    const svg = document.createElementNS(NS, "svg");
    const [vx, vy, vw, vh] = opts.tile ? F.tile : F.view;
    const big = opts.tile ? 2 : 1;
    const pad = opts.grid ? 9 : 0;
    svg.setAttribute("viewBox", `${vx - pad} ${vy} ${vw + pad} ${vh + (opts.grid ? 16 : 0)}`);
    svg.setAttribute("role", "img");
    const add = (parent, tag, a, text) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(a)) e.setAttribute(k, v);
      if (text != null) e.textContent = text;
      parent.append(e);
      return e;
    };
    const defs = add(svg, "defs", {});
    const metal = add(defs, "linearGradient", { id: id + "m", x1: "0", y1: "0", x2: "0", y2: "1" });
    for (const [o, c] of [["0", "#f1f2f4"], ["0.55", "#c9cdd2"], ["1", "#9aa0a7"]]) add(metal, "stop", { offset: o, "stop-color": c });
    const clip = add(defs, "clipPath", { id: id + "c" });
    add(clip, "path", { d: F.face });

    // The inch grid behind the club: lines every half inch, labelled every inch.
    if (opts.grid) {
      const g = add(svg, "g", { class: "sf-grid" });
      for (let k = -3; k <= 3; k++) {
        const x = k * MM_PER_INCH / 2;
        if (x < vx || x > vx + vw) continue;
        add(g, "line", { x1: x, x2: x, y1: vy, y2: vy + vh, "stroke-dasharray": k % 2 ? "2 2" : "" });
      }
      for (let k = -3; k <= 3; k++) {
        const y = k * MM_PER_INCH / 2;
        if (y < vy || y > vy + vh) continue;
        add(g, "line", { x1: vx, x2: vx + vw, y1: y, y2: y, "stroke-dasharray": k % 2 ? "2 2" : "" });
      }
      const t = add(svg, "g", { class: "sf-label" });
      for (const k of [-2, -1, 0, 1, 2]) {
        const x = k * MM_PER_INCH;
        if (x < vx || x > vx + vw) continue;
        add(t, "text", { x, y: vy + vh + 6, "text-anchor": "middle" }, k === 0 ? "0" : `${Math.abs(k)}"`);
      }
      for (const k of [-1, 0, 1]) add(t, "text", { x: vx - 2, y: -k * MM_PER_INCH + 1.5, "text-anchor": "end" }, k === 0 ? "0" : `${k > 0 ? "" : "-"}${Math.abs(k)}"`);
      add(t, "text", { x: vx + 2, y: vy + vh + 13, "text-anchor": "start", class: "sf-word" }, "← Toe");
      add(t, "text", { x: vx + vw - 2, y: vy + vh + 13, "text-anchor": "end", class: "sf-word" }, "Heel →");
    }

    // The club: the metal, the grooves, the outline.
    add(svg, "path", { d: F.face, fill: `url(#${id}m)` });
    const grooves = add(svg, "g", { "clip-path": `url(#${id}c)`, stroke: "#6f757c", "stroke-width": "0.9", "stroke-linecap": "round", opacity: "0.75" });
    for (const y of F.grooves.ys) add(grooves, "line", { x1: F.grooves.x0, x2: F.grooves.x1, y1: y, y2: y });

    // The heat, drawn on a canvas and laid over the face, not cut to it: a strike off the face (a thin
    // one, or a reading Square got wrong) would otherwise disappear.
    const shots = (opts.shots || []).filter(p => p && finite(p.h) && finite(p.v));
    if (shots.length && typeof document !== "undefined" && document.createElement) {
      const step = 0.5, ext = [vx, vx + vw, -(vy + vh), -vy];
      const dens = density(shots.map(p => ({ x: sx(p), v: p.v })), { sigma: HEAT_SIGMA[group], step, extent: ext });
      const canvas = document.createElement("canvas");
      canvas.width = dens.nx;
      canvas.height = dens.nv;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const img = ctx.createImageData(dens.nx, dens.nv);
        for (let j = 0; j < dens.nv; j++) {
          for (let i = 0; i < dens.nx; i++) {
            const c = heatColor(dens.d[j * dens.nx + i]), o = ((dens.nv - 1 - j) * dens.nx + i) * 4;   // canvas row 0 = top = high v
            img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = c[3];
          }
        }
        ctx.putImageData(img, 0, 0);
        add(svg, "image", { href: canvas.toDataURL(), x: ext[0], y: -ext[3], width: ext[1] - ext[0], height: ext[3] - ext[2],
                            preserveAspectRatio: "none" });
      }
    }
    add(svg, "path", { d: F.face, fill: "none", stroke: "#7d838a", "stroke-width": "1" });

    // The face centre, the usual spot, the dots.
    add(svg, "path", { d: "M -2.5 0 H 2.5 M 0 -2.5 V 2.5", stroke: "#4b5158", "stroke-width": "0.6" });
    const title = (e, p) => { if (opts.title) add(e, "title", {}, opts.title(p)); return e; };
    if (opts.usual && finite(opts.usual.h) && finite(opts.usual.v)) {
      title(add(svg, "circle", { cx: sx(opts.usual), cy: sy(opts.usual), r: 3.2 * big, fill: "none", stroke: "#1f2937",
                                 "stroke-width": 0.9 * big, "stroke-dasharray": `${1.6 * big} ${1.2 * big}` }), opts.usual);
    }
    for (const p of opts.dots || []) {
      if (!p || !finite(p.h) || !finite(p.v)) continue;
      title(add(svg, "circle", { cx: sx(p), cy: sy(p), r: 1.5, fill: "#1d6fd8", stroke: "#fff", "stroke-width": "0.5", opacity: "0.9" }), p);
    }
    if (opts.latest && finite(opts.latest.h) && finite(opts.latest.v)) {
      title(add(svg, "circle", { cx: sx(opts.latest), cy: sy(opts.latest), r: 2.8 * big, fill: "#1d6fd8", stroke: "#fff", "stroke-width": 0.9 * big }), opts.latest);
    }
    return svg;
  }

  const api = {
    MM_PER_INCH,
    density,
    heatColor,
    faceSvg,
    BOX_IRONS,
    BOX_WOODS,
    MIN_STRIKES_COMPARE,
    MIN_MOVE_MM,
    boxOf,
    extractStrike,
    grid,
    trend,
    compare,
    spotText,
    hWords,
    vWords,
    hDiffWords,
    vDiffWords,
    getToeSign,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingStrikeMap = api;
})(typeof window !== "undefined" ? window : globalThis);
