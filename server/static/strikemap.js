// Strike heat map on the club face and its trend over sessions.
//
// Strike location: Square Omni reports clubData.faceImpactH (toe/heel, mm) and
// faceImpactV (high/low, mm, + = high).
// Toe/heel sign: default + = toe (configurable per browser).
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
   * Plain text description of a spot on the club face.
   * e.g. "3 mm toward the heel, 17 mm low"
   */
  function spotText(point, opts) {
    if (!point || !finite(point.h) || !finite(point.v)) return "";
    opts = opts || {};
    const toeSign = (opts.toeSign === -1 || opts.toe === "-") ? -1 : 1;
    const h = point.h * toeSign;
    const v = point.v;

    const parts = [];
    if (Math.abs(h) < 1.0) {
      parts.push("centered");
    } else if (h > 0) {
      parts.push(`${Math.round(Math.abs(h))} mm ${opts.short ? "toe" : "toward the toe"}`);
    } else {
      parts.push(`${Math.round(Math.abs(h))} mm ${opts.short ? "heel" : "toward the heel"}`);
    }

    if (Math.abs(v) < 1.0) {
      parts.push("mid-face");
    } else if (v > 0) {
      parts.push(`${Math.round(Math.abs(v))} mm high`);
    } else {
      parts.push(`${Math.round(Math.abs(v))} mm low`);
    }
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
    const toeSign = (opts.toeSign === -1 || opts.toe === "-") ? -1 : 1;

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
    const toeDelta = diffH * toeSign;

    let hText = null;
    if (hMoved) {
      const dist = Math.round(Math.abs(diffH));
      hText = toeDelta > 0
        ? `${dist} mm toward the toe`
        : `${dist} mm toward the heel`;
    }

    let vText = null;
    if (vMoved) {
      const dist = Math.round(Math.abs(diffV));
      vText = diffV > 0
        ? `${dist} mm higher on the face`
        : `${dist} mm lower on the face`;
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

  function getToeSign() {
    try {
      if (typeof localStorage !== "undefined") {
        const v = localStorage.getItem("strike-toe-sign");
        if (v === "-") return -1;
      }
    } catch {}
    return 1;
  }

  function setToeSign(v) {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("strike-toe-sign", v === "-" || v === -1 ? "-" : "+");
      }
    } catch {}
  }

  const api = {
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
    getToeSign,
    setToeSign,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingStrikeMap = api;
})(typeof window !== "undefined" ? window : globalThis);
