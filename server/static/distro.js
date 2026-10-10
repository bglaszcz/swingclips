// server/static/distro.js
// Distribution analysis: how spread out one number is with a club, and whether the latest session was tighter.
// Works in the browser (window.SwingDistro) and in Node (module.exports).

(function (root) {
  const finite = v => typeof v === "number" && Number.isFinite(v);

  /**
   * Linear interpolation quantile matching the rest of the codebase.
   */
  function quantile(sorted, q) {
    if (!sorted || !sorted.length) return null;
    const i = (sorted.length - 1) * q;
    const lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  /**
   * Summary stats for a numeric series.
   * Returns null if fewer than 3 finite values.
   */
  function stats(values) {
    const v = (values || []).filter(finite);
    if (v.length < 3) return null;
    const s = [...v].sort((a, b) => a - b);
    const n = s.length;
    const med = quantile(s, 0.5);
    const q1 = quantile(s, 0.25);
    const q3 = quantile(s, 0.75);
    const min = s[0];
    const max = s[s.length - 1];
    const mean = s.reduce((a, b) => a + b, 0) / n;
    const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
    const sd = Math.sqrt(variance);
    return { n, med, q1, q3, min, max, sd };
  }

  /**
   * Determine a round step (1, 2 or 5 * 10^k) producing 8 to 16 bars
   * over the middle 98% of values.
   */
  function bins(values, opts = {}) {
    const v = (values || []).filter(finite);
    if (!v.length) {
      return { lo: 0, hi: 10, step: 1, edges: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };
    }
    const s = [...v].sort((a, b) => a - b);
    let p01 = quantile(s, 0.01);
    let p99 = quantile(s, 0.99);
    if (p99 <= p01) {
      p01 = s[0];
      p99 = s[s.length - 1];
    }
    let span = p99 - p01;
    if (span <= 0) span = 1;

    // Search for round step (1, 2, or 5 * 10^exp) giving between 8 and 16 bars
    const rough = span / 11;
    const exp = Math.floor(Math.log10(rough));
    const base = 10 ** exp;

    // Candidate steps from small to large
    const candidates = [
      0.1 * base, 0.2 * base, 0.5 * base,
      1 * base, 2 * base, 5 * base,
      10 * base, 20 * base, 50 * base,
    ].map(st => Number(st.toPrecision(6)));

    let bestStep = candidates[3];
    let bestDist = Infinity;

    for (const step of candidates) {
      if (step <= 0) continue;
      const lo = Math.floor(p01 / step) * step;
      const hi = Math.ceil(p99 / step) * step;
      const count = Math.round((hi - lo) / step);
      if (count >= 8 && count <= 16) {
        // Preferred: closest to 11 bars
        const d = Math.abs(count - 11);
        if (d < bestDist) {
          bestDist = d;
          bestStep = step;
        }
      }
    }

    // Fallback if no candidate fell strictly in [8, 16]
    if (bestDist === Infinity) {
      for (const step of candidates) {
        const lo = Math.floor(p01 / step) * step;
        const hi = Math.ceil(p99 / step) * step;
        const count = Math.round((hi - lo) / step);
        const d = count < 8 ? 8 - count : count - 16;
        if (d < bestDist) {
          bestDist = d;
          bestStep = step;
        }
      }
    }

    // Clean decimals on step
    const dec = Math.max(0, -Math.floor(Math.log10(bestStep)));
    const step = Number(bestStep.toFixed(dec + 2));
    const lo = Number((Math.floor(p01 / step) * step).toFixed(dec + 2));
    const count = Math.max(1, Math.ceil((p99 - lo) / step));
    const hi = Number((lo + count * step).toFixed(dec + 2));

    const edges = [];
    for (let i = 0; i <= count; i++) {
      edges.push(Number((lo + i * step).toFixed(dec + 2)));
    }

    return { lo, hi, step, edges };
  }

  /**
   * Analyze spread for key across sessions.
   */
  function analyze(sessions, key, opts = {}) {
    const range = opts.range || null;
    const sessList = Array.isArray(sessions) ? sessions : [];
    const latestSess = sessList.length > 0 ? sessList[sessList.length - 1] : null;

    const allValues = [];
    const latestRows = [];
    const beforeRows = [];

    const sessSummaries = [];

    for (const sess of sessList) {
      const isLatest = sess === latestSess;
      const sVals = [];
      const rows = Array.isArray(sess.rows) ? sess.rows : [];

      for (const r of rows) {
        const v = r[key];
        if (!finite(v)) continue;
        allValues.push(v);
        sVals.push(v);
        if (isLatest) latestRows.push(r);
        else beforeRows.push(r);
      }

      // Sessions with 3+ values get included in sessions breakdown
      if (sVals.length >= 3) {
        sessSummaries.push({
          key: sess.key,
          start: sess.start,
          n: sVals.length,
          stats: stats(sVals),
        });
      }
    }

    const latestStats = stats(latestRows.map(r => r[key]));
    const beforeStats = stats(beforeRows.map(r => r[key]));

    // Generate bins over all values
    const binInfo = bins(allValues);
    const edges = binInfo.edges;
    const numBars = edges.length - 1;

    const bars = [];
    for (let i = 0; i < numBars; i++) {
      const bLo = edges[i];
      const bHi = edges[i + 1];
      const bLatest = [];
      const bBefore = [];

      // Outer bars take everything beyond
      const isFirst = i === 0;
      const isLast = i === numBars - 1;

      for (const r of latestRows) {
        const val = r[key];
        if (isFirst && isLast) {
          bLatest.push(r);
        } else if (isFirst) {
          if (val < bHi) bLatest.push(r);
        } else if (isLast) {
          if (val >= bLo) bLatest.push(r);
        } else {
          if (val >= bLo && val < bHi) bLatest.push(r);
        }
      }

      for (const r of beforeRows) {
        const val = r[key];
        if (isFirst && isLast) {
          bBefore.push(r);
        } else if (isFirst) {
          if (val < bHi) bBefore.push(r);
        } else if (isLast) {
          if (val >= bLo) bBefore.push(r);
        } else {
          if (val >= bLo && val < bHi) bBefore.push(r);
        }
      }

      bars.push({ lo: bLo, hi: bHi, latest: bLatest, before: bBefore });
    }

    // Tighter verdict: middle half comparison (IQR)
    let tighter = null;
    if (latestRows.length >= 8 && beforeRows.length >= 8 && latestStats && beforeStats) {
      const iqrLatest = latestStats.q3 - latestStats.q1;
      const iqrBefore = beforeStats.q3 - beforeStats.q1;
      if (iqrBefore > 0) {
        const change = (iqrLatest - iqrBefore) / iqrBefore;
        if (Math.abs(change) < 0.15) {
          tighter = "same";
        } else if (change <= -0.15) {
          tighter = "tighter";
        } else {
          tighter = "wider";
        }
      } else {
        tighter = iqrLatest <= 0 ? "same" : "wider";
      }
    }

    const n = allValues.length;
    let status = n > 0 ? `${n} swing${n === 1 ? "" : "s"}` : "no swings";
    if (tighter) {
      status += ` · ${tighter}`;
    }

    return {
      key,
      n,
      latest: {
        key: latestSess ? latestSess.key : null,
        start: latestSess ? latestSess.start : null,
        rows: latestRows,
        stats: latestStats,
      },
      before: {
        rows: beforeRows,
        stats: beforeStats,
      },
      bars,
      sessions: sessSummaries,
      range,
      tighter,
      status,
    };
  }

  // --- SVG drawing helpers ---
  const NS = "http://www.w3.org/2000/svg";
  function createSvg(w, h, cls) {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    if (cls) svg.setAttribute("class", cls);
    return svg;
  }
  function svgEl(tag, attrs, parent) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v != null) el.setAttribute(k, v);
    }
    if (parent) parent.appendChild(el);
    return el;
  }

  /**
   * Render distribution view.
   */
  function render(box, analysis, opts = {}) {
    if (!box) return;
    box.replaceChildren();

    const field = opts.field || { key: analysis.key, label: analysis.key, unit: "", dec: 1 };
    const fmt = typeof opts.fmt === "function" ? opts.fmt : (v => (v != null ? String(v) : ""));
    const dayOf = opts.dayOf || (ms => new Date(ms).toLocaleDateString());
    const onPick = typeof opts.onPick === "function" ? opts.onPick : () => {};
    const onSession = typeof opts.onSession === "function" ? opts.onSession : () => {};

    // 1. One sentence
    const sentenceDiv = document.createElement("div");
    sentenceDiv.className = "ds-sentence";
    sentenceDiv.style.cssText = "font-size: 14px; line-height: 1.5; margin-bottom: 16px;";

    const lStats = analysis.latest && analysis.latest.stats;
    const bStats = analysis.before && analysis.before.stats;

    if (lStats && bStats) {
      const wL = lStats.q3 - lStats.q1;
      const wB = bStats.q3 - bStats.q1;
      let text = `Last session the middle half of your ${field.label.toLowerCase()} ran ${fmt(lStats.q1)} to ${fmt(lStats.q3)} (${fmt(wL, true)} wide); before that ${fmt(bStats.q1)} to ${fmt(bStats.q3)} (${fmt(wB, true)} wide)`;
      if (analysis.tighter) {
        text += `: ${analysis.tighter}.`;
      } else {
        text += ".";
      }
      sentenceDiv.textContent = text;
    } else if (lStats) {
      const wL = lStats.q3 - lStats.q1;
      sentenceDiv.textContent = `Last session the middle half of your ${field.label.toLowerCase()} ran ${fmt(lStats.q1)} to ${fmt(lStats.q3)} (${fmt(wL, true)} wide).`;
    } else {
      sentenceDiv.textContent = `Not enough swings to measure the spread of ${field.label.toLowerCase()} yet.`;
    }
    box.appendChild(sentenceDiv);

    if (!analysis.bars.length) return;

    // 2. The histogram
    const histCard = document.createElement("div");
    histCard.className = "a-chart ds-hist-chart";
    histCard.style.cssText = "position: relative; margin-bottom: 24px;";

    const boxWidth = Math.max(280, box.clientWidth || 320);
    const W = boxWidth;
    const H = Math.max(240, Math.min(380, Math.round(W * 0.55)));

    const svg = createSvg(W, H, "ds-hist-svg");
    svg.style.display = "block";
    svg.style.overflow = "hidden";

    const tip = document.createElement("div");
    tip.className = "tip";
    tip.hidden = true;
    tip.style.cssText = "position: absolute; pointer-events: none; z-index: 10;";
    histCard.appendChild(svg);
    histCard.appendChild(tip);

    const m = { top: 20, right: 30, bottom: 32, left: 45 };
    const plotW = W - m.left - m.right;
    const plotH = H - m.top - m.bottom;
    const axisY = H - m.bottom;

    const minX = analysis.bars[0].lo;
    const maxX = analysis.bars[analysis.bars.length - 1].hi;
    const spanX = maxX - minX || 1;

    const scaleX = x => m.left + ((x - minX) / spanX) * plotW;

    const latestTotal = analysis.latest.rows.length;
    const beforeTotal = analysis.before.rows.length;

    // Find max share for Y scale
    let maxShare = 0.1;
    for (const b of analysis.bars) {
      const sL = latestTotal > 0 ? b.latest.length / latestTotal : 0;
      const sB = beforeTotal > 0 ? b.before.length / beforeTotal : 0;
      if (sL > maxShare) maxShare = sL;
      if (sB > maxShare) maxShare = sB;
    }
    maxShare = Math.min(1, Math.ceil(maxShare * 20) / 20 + 0.05);

    const scaleY = s => axisY - (s / maxShare) * plotH;

    // Y axis grid lines (shares: e.g. 10%, 20%...)
    const ySteps = maxShare <= 0.3 ? 0.1 : 0.2;
    for (let s = ySteps; s <= maxShare; s += ySteps) {
      const sy = scaleY(s);
      svgEl("line", {
        x1: m.left, y1: sy, x2: W - m.right, y2: sy,
        stroke: "var(--line)", "stroke-width": 1, "stroke-dasharray": "3,3",
      }, svg);
      svgEl("text", {
        x: m.left - 6, y: sy + 4,
        "text-anchor": "end", fill: "var(--muted)", "font-size": 10,
      }, svg).textContent = `${Math.round(s * 100)}%`;
    }

    // Good-shot range middle half band behind
    if (analysis.range && finite(analysis.range.q25) && finite(analysis.range.q75)) {
      const rx1 = Math.max(m.left, scaleX(analysis.range.q25));
      const rx2 = Math.min(W - m.right, scaleX(analysis.range.q75));
      if (rx2 > rx1) {
        svgEl("rect", {
          x: rx1, y: m.top, width: rx2 - rx1, height: plotH,
          fill: "var(--accent)", opacity: 0.12,
        }, svg);
        svgEl("text", {
          x: (rx1 + rx2) / 2, y: m.top + 12,
          "text-anchor": "middle", fill: "var(--muted)", "font-size": 10,
        }, svg).textContent = "your good shots";
      }
    }

    // Axis line
    svgEl("line", {
      x1: m.left, y1: axisY, x2: W - m.right, y2: axisY,
      stroke: "var(--line-strong)", "stroke-width": 1,
    }, svg);

    // Bars
    const binElements = [];
    const numBins = analysis.bars.length;
    const binSlotW = plotW / numBins;

    for (let i = 0; i < numBins; i++) {
      const bar = analysis.bars[i];
      const bx = m.left + i * binSlotW;
      const sB = beforeTotal > 0 ? bar.before.length / beforeTotal : 0;
      const sL = latestTotal > 0 ? bar.latest.length / latestTotal : 0;

      // Grey bar: sessions before
      const bW = Math.max(4, Math.round(binSlotW * 0.72));
      const bLeft = bx + (binSlotW - bW) / 2;
      const bH = sB > 0 ? Math.max(2, axisY - scaleY(sB)) : 0;

      if (bH > 0) {
        svgEl("rect", {
          x: bLeft, y: axisY - bH, width: bW, height: bH,
          rx: 2, ry: 2, fill: "var(--muted)", opacity: 0.45,
        }, svg);
      }

      // Latest session bar: narrower on top
      const lW = Math.max(2, Math.round(binSlotW * 0.45));
      const lLeft = bx + (binSlotW - lW) / 2;
      const lH = sL > 0 ? Math.max(2, axisY - scaleY(sL)) : 0;

      if (lH > 0) {
        svgEl("rect", {
          x: lLeft, y: axisY - lH, width: lW, height: lH,
          rx: 2, ry: 2, fill: "var(--dot)", opacity: 0.9,
        }, svg);
      }

      // X tick label (show at reasonable intervals)
      const showTick = numBins <= 10 || i % Math.ceil(numBins / 8) === 0 || i === numBins - 1;
      if (showTick) {
        svgEl("line", {
          x1: bx, y1: axisY, x2: bx, y2: axisY + 4,
          stroke: "var(--line)", "stroke-width": 1,
        }, svg);
        svgEl("text", {
          x: bx, y: axisY + 14,
          "text-anchor": "middle", fill: "var(--muted)", "font-size": 10,
        }, svg).textContent = fmt(bar.lo);
      }

      binElements.push({ bar, x: bx, width: binSlotW, sB, sL });
    }

    // Last edge tick
    svgEl("text", {
      x: W - m.right, y: axisY + 14,
      "text-anchor": "middle", fill: "var(--muted)", "font-size": 10,
    }, svg).textContent = fmt(maxX);

    // Median ticks on axis
    if (bStats && finite(bStats.med)) {
      const mx = scaleX(bStats.med);
      svgEl("polygon", {
        points: `${mx},${axisY - 2} ${mx - 4},${axisY + 6} ${mx + 4},${axisY + 6}`,
        fill: "var(--muted)", opacity: 0.7,
      }, svg);
    }
    if (lStats && finite(lStats.med)) {
      const mx = scaleX(lStats.med);
      svgEl("polygon", {
        points: `${mx},${axisY - 2} ${mx - 4},${axisY + 6} ${mx + 4},${axisY + 6}`,
        fill: "var(--dot)",
      }, svg);
    }

    // Legend
    const histLegend = document.createElement("div");
    histLegend.className = "p-legend";
    histLegend.style.cssText = "margin-top: 8px;";
    let legendHtml = `
      <span><i class="p-key" style="background: var(--dot)"></i>Latest session</span>
      <span><i class="p-key" style="background: var(--muted); opacity: 0.5;"></i>Sessions before</span>
    `;
    if (analysis.range) {
      legendHtml += `<span><i class="p-key" style="background: var(--accent); opacity: 0.35;"></i>Good shots</span>`;
    }
    histLegend.innerHTML = legendHtml;
    histCard.appendChild(histLegend);

    // Bin tooltips & pick
    let activeBin = null;
    svg.onpointerleave = () => {
      activeBin = null;
      tip.hidden = true;
    };
    svg.onpointermove = e => {
      const rect = svg.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const b = binElements.find(item => px >= item.x && px <= item.x + item.width);
      if (!b) {
        activeBin = null;
        tip.hidden = true;
        return;
      }
      activeBin = b;
      const bar = b.bar;
      const sLPct = Math.round(b.sL * 100);
      const sBPct = Math.round(b.sB * 100);

      tip.innerHTML = `
        <div style="font-weight: 600;">${fmt(bar.lo)} to ${fmt(bar.hi)}</div>
        <div style="font-size: 12px; margin-top: 2px;">
          Latest: ${bar.latest.length} (${sLPct}%)<br>
          Before: ${bar.before.length} (${sBPct}%)
        </div>
      `;
      tip.hidden = false;
      const tipX = Math.min(W - 140, Math.max(10, px - 60));
      const tipY = Math.max(10, e.clientY - rect.top - 65);
      tip.style.left = `${tipX}px`;
      tip.style.top = `${tipY}px`;
    };

    svg.onclick = () => {
      if (activeBin) {
        const rows = [...activeBin.bar.latest, ...activeBin.bar.before];
        onPick(rows, `${field.label} ${fmt(activeBin.bar.lo)} to ${fmt(activeBin.bar.hi)}`);
      }
    };

    box.appendChild(histCard);

    // 3. Session by session
    const sessWrap = document.createElement("div");
    sessWrap.className = "ds-sessions";
    sessWrap.style.cssText = "margin-bottom: 24px;";

    const sessTitle = document.createElement("div");
    sessTitle.className = "p-why-sub";
    sessTitle.style.cssText = "font-weight: 600; font-size: 13px; margin-bottom: 8px;";
    sessTitle.textContent = "Session by session";
    sessWrap.appendChild(sessTitle);

    // Newest at top
    const sortedSess = [...analysis.sessions].sort((a, b) => b.start - a.start);

    if (sortedSess.length > 0) {
      const sessListEl = document.createElement("div");
      sessListEl.className = "ds-sess-list";
      sessListEl.style.cssText = "display: flex; flex-direction: column; gap: 4px;";

      sortedSess.forEach(sess => {
        const isLatest = analysis.latest && sess.key === analysis.latest.key;
        const s = sess.stats;

        const rowEl = document.createElement("div");
        rowEl.className = "ds-sess-row";
        rowEl.style.cssText = `
          display: flex; align-items: center; gap: 12px; padding: 6px 8px; border-radius: var(--radius-sm, 6px);
          cursor: pointer; transition: background 0.15s;
        `;
        rowEl.onpointerenter = () => { rowEl.style.background = "var(--sel)"; };
        rowEl.onpointerleave = () => { rowEl.style.background = ""; };
        rowEl.onclick = () => onSession(sess.key);

        // Date and count
        const metaEl = document.createElement("div");
        metaEl.className = "ds-sess-meta";
        metaEl.style.cssText = "width: 140px; flex: none; font-size: 12px;";
        metaEl.innerHTML = `
          <strong style="color: ${isLatest ? "var(--dot)" : "var(--text)"};">${dayOf(sess.start)}</strong>
          <span class="muted" style="margin-left: 6px;">${sess.n} shots</span>
        `;
        rowEl.appendChild(metaEl);

        // Box plot SVG
        const bpW = Math.max(120, plotW);
        const bpH = 22;
        const bpSvg = createSvg(bpW, bpH, "ds-boxplot-svg");
        bpSvg.style.cssText = "flex: 1; min-width: 120px;";

        const col = isLatest ? "var(--dot)" : "var(--muted)";
        const fillOp = isLatest ? 0.7 : 0.35;

        // Thin line from 10th to 90th percentile
        const q10 = quantile(sess.stats ? [sess.stats.min, sess.stats.q1, sess.stats.med, sess.stats.q3, sess.stats.max] : [], 0.1) || sess.stats.min;
        const q90 = quantile(sess.stats ? [sess.stats.min, sess.stats.q1, sess.stats.med, sess.stats.q3, sess.stats.max] : [], 0.9) || sess.stats.max;

        const x10 = Math.max(2, Math.min(bpW - 2, scaleX(q10) - m.left));
        const x90 = Math.max(2, Math.min(bpW - 2, scaleX(q90) - m.left));
        const x1 = Math.max(2, Math.min(bpW - 2, scaleX(s.q1) - m.left));
        const x3 = Math.max(2, Math.min(bpW - 2, scaleX(s.q3) - m.left));
        const xm = Math.max(2, Math.min(bpW - 2, scaleX(s.med) - m.left));

        const cy = bpH / 2;

        // Whisker line
        svgEl("line", {
          x1: x10, y1: cy, x2: x90, y2: cy,
          stroke: col, "stroke-width": 1, opacity: 0.6,
        }, bpSvg);

        // Middle half box
        const bw = Math.max(2, x3 - x1);
        svgEl("rect", {
          x: x1, y: cy - 5, width: bw, height: 10,
          rx: 2, ry: 2, fill: col, opacity: fillOp,
        }, bpSvg);

        // Median tick
        svgEl("line", {
          x1: xm, y1: cy - 7, x2: xm, y2: cy + 7,
          stroke: isLatest ? "var(--text)" : col, "stroke-width": 2,
        }, bpSvg);

        rowEl.appendChild(bpSvg);
        sessListEl.appendChild(rowEl);
      });

      sessWrap.appendChild(sessListEl);
    }
    box.appendChild(sessWrap);

    // 4. Fold "How it's worked out"
    const fold = document.createElement("details");
    fold.className = "explain";
    fold.innerHTML = `
      <summary>How it's worked out</summary>
      <div class="note">
        <strong>Middle half:</strong> the interquartile range (25th to 75th percentile). Half your shots fell inside this range.<br><br>
        <strong>Histogram:</strong> compares the share of shots in each bin between the latest session and all sessions before it. Using shares accounts for different session sizes.<br><br>
        <strong>Tighter vs wider:</strong> compares the width of the latest session's middle half against earlier sessions. A change under 15% is considered the same; at least 8 shots in each group are required for a verdict.<br><br>
        <strong>Session rows:</strong> the box shows the middle half, the tick is the median, and the line runs from the 10th to the 90th percentile.
      </div>
    `;
    box.appendChild(fold);
  }

  const api = {
    stats,
    bins,
    quantile,
    analyze,
    render,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingDistro = api;
})(typeof window !== "undefined" ? window : globalThis);
