// server/static/checkpoints.js
// Swing checkpoints view for Analysis: every body number against its own good-shot range.
(function (root) {
  "use strict";

  const finite = v => typeof v === "number" && Number.isFinite(v);

  function quantile(sorted, q) {
    if (!sorted || !sorted.length) return null;
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  function defaultClubName(c) {
    if (!c) return "club";
    if (typeof clubWords === "function") return clubWords(c);
    if (typeof clubName === "function") return clubName(c);
    const map = {
      DR: "Driver", W3: "3 wood", W5: "5 wood", H4: "4 hybrid",
      I4: "4 iron", I5: "5 iron", I6: "6 iron", I7: "7 iron", I8: "8 iron", I9: "9 iron",
      PW: "PW", GW: "GW", SW: "SW", LW: "LW",
    };
    return map[c] || c;
  }

  const GROUP_DEFS = [
    { id: "rhythm", name: "Rhythm", match: f => !f.pos },
    { id: "top", name: "Top of the swing", match: f => f.pos === "p4" },
    { id: "downswing", name: "Downswing", match: f => f.pos === "p5" || f.pos === "p6" },
    { id: "impact", name: "Impact", match: f => f.pos === "p7" },
  ];

  /**
   * Analyze body numbers across sessions against good-shot ranges.
   */
  function analyze(sessions, opts = {}) {
    sessions = sessions || [];
    const fields = opts.fields || [];
    const isShaky = typeof opts.isShaky === "function" ? opts.isShaky : () => false;
    const allRows = sessions.flatMap(s => s.rows || []);

    const bodyKeys = fields.map(f => f.key);
    const swingsWithAnyBody = allRows.filter(r => bodyKeys.some(k => finite(r[k])));
    const totalSwings = swingsWithAnyBody.length;

    const latestSess = sessions.length ? sessions[sessions.length - 1] : null;

    const allItems = [];

    // Analyze each field
    for (const f of fields) {
      const rowsWithVal = allRows.filter(r => finite(r[f.key]));
      const n = rowsWithVal.length;

      let med = null, q1 = null, q3 = null;
      if (n > 0) {
        const sorted = rowsWithVal.map(r => r[f.key]).sort((a, b) => a - b);
        med = quantile(sorted, 0.5);
        q1 = quantile(sorted, 0.25);
        q3 = quantile(sorted, 0.75);
      }

      // Latest session readings
      const latestRows = latestSess ? (latestSess.rows || []).filter(r => finite(r[f.key])) : [];
      const latestN = latestRows.length;
      let latestMed = null;
      if (latestN > 0) {
        const sortedLatest = latestRows.map(r => r[f.key]).sort((a, b) => a - b);
        latestMed = quantile(sortedLatest, 0.5);
      }

      // Good-shot range (only when enough and reliable)
      const rawRange = opts.ranges && opts.ranges[f.key];
      const range = rawRange && rawRange.enough && rawRange.reliable ? rawRange : null;

      let inRange = null;
      let outRows = [];
      if (range && n > 0) {
        const inCount = rowsWithVal.filter(r => r[f.key] >= range.q10 && r[f.key] <= range.q90).length;
        inRange = inCount / n;
        outRows = rowsWithVal.filter(r => r[f.key] < range.q10 || r[f.key] > range.q90);
      }

      let latestInRange = null;
      if (range && latestN > 0) {
        const inCountLatest = latestRows.filter(r => r[f.key] >= range.q10 && r[f.key] <= range.q90).length;
        latestInRange = inCountLatest / latestN;
      }

      // Gap: how far latest session's median sits outside q25..q75, 0 when inside, null without range or < 5 latest swings
      let gap = null;
      if (range && latestN >= 5 && latestMed != null) {
        if (latestMed < range.q25) {
          gap = range.q25 - latestMed;
        } else if (latestMed > range.q75) {
          gap = latestMed - range.q75;
        } else {
          gap = 0;
        }
      }

      const shakyCount = rowsWithVal.filter(r => isShaky(r, f.key)).length;
      const shakyShare = n > 0 ? shakyCount / n : 0;

      const item = {
        key: f.key,
        field: f,
        n,
        med,
        q1,
        q3,
        latest: { n: latestN, med: latestMed },
        range,
        inRange,
        latestInRange,
        gap,
        shakyShare,
        rows: rowsWithVal,
        outRows,
      };

      allItems.push(item);
    }

    // Build groups in swing order
    const groups = [];
    for (const gDef of GROUP_DEFS) {
      const gItems = allItems.filter(item => gDef.match(item.field));
      if (gItems.length > 0) {
        groups.push({
          name: gDef.name,
          items: gItems,
        });
      }
    }

    // Worst items: up to 3 items with largest gap relative to range's width (q75 - q25), gap > 0 and latest.n >= 8
    const worstCandidates = allItems.filter(item =>
      item.gap != null &&
      item.gap > 0 &&
      item.latest.n >= 8 &&
      item.range &&
      (item.range.q75 - item.range.q25) > 0
    );
    worstCandidates.sort((a, b) => {
      const relA = a.gap / (a.range.q75 - a.range.q25);
      const relB = b.gap / (b.range.q75 - b.range.q25);
      return relB - relA;
    });
    const worst = worstCandidates.slice(0, 3);

    // Status line: e.g. "7 iron · 163 swings · 14 of 21 numbers inside your good-shot range last session"
    const itemsWithRange = allItems.filter(item => item.range && item.gap != null);
    const insideCount = itemsWithRange.filter(item => item.gap === 0).length;

    const clubCode = opts.club || (allRows.find(r => r.club)?.club);
    const cLabel = clubCode ? defaultClubName(clubCode) : "";
    const prefix = cLabel ? `${cLabel} · ` : "";

    let status = "";
    if (totalSwings === 0) {
      status = `${prefix}no swings`;
    } else if (itemsWithRange.length > 0) {
      status = `${prefix}${totalSwings} swing${totalSwings === 1 ? "" : "s"} · ${insideCount} of ${itemsWithRange.length} numbers inside your good-shot range last session`;
    } else {
      status = `${prefix}${totalSwings} swing${totalSwings === 1 ? "" : "s"} · no good-shot ranges yet`;
    }

    return {
      n: totalSwings,
      status,
      groups,
      worst,
      insideCount,
      itemsWithRangeCount: itemsWithRange.length,
      allItems,
    };
  }

  // --- SVG drawing helpers ---
  const NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs, parent) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v != null) el.setAttribute(k, v);
    }
    if (parent) parent.appendChild(el);
    return el;
  }

  /**
   * Render the Swing checkpoints view.
   */
  function render(box, analysis, opts = {}) {
    if (!box) return;
    box.replaceChildren();

    const fmt = typeof opts.fmt === "function"
      ? opts.fmt
      : ((f, v) => (v != null ? Number(v).toFixed(f.dec ?? 1) + (f.unit ? " " + f.unit : "") : "–"));
    const onMetric = typeof opts.onMetric === "function" ? opts.onMetric : () => {};
    const onPick = typeof opts.onPick === "function" ? opts.onPick : () => {};

    // 1. One sentence
    const sentenceDiv = document.createElement("div");
    sentenceDiv.className = "cp-sentence";

    if (analysis.itemsWithRangeCount > 0) {
      let sentence = `Last session ${analysis.insideCount} of ${analysis.itemsWithRangeCount} body numbers sat where your good shots have them.`;
      if (analysis.worst && analysis.worst.length > 0) {
        const w0 = analysis.worst[0];
        const w0Desc = `${w0.field.label.toLowerCase()} (${fmt(w0.field, w0.latest.med)} against ${fmt(w0.field, w0.range.q25)} to ${fmt(w0.field, w0.range.q75)})`;
        if (analysis.worst.length === 1) {
          sentence += ` Furthest out: ${w0Desc}.`;
        } else {
          const w1 = analysis.worst[1];
          const w1Desc = `${w1.field.label.toLowerCase()} (${fmt(w1.field, w1.latest.med)} against ${fmt(w1.field, w1.range.q25)} to ${fmt(w1.field, w1.range.q75)})`;
          sentence += ` Furthest out: ${w0Desc} and ${w1Desc}.`;
        }
      } else if (analysis.insideCount === analysis.itemsWithRangeCount) {
        sentence += " All numbers were inside your good-shot range.";
      }
      sentenceDiv.textContent = sentence;
    } else if (analysis.n > 0) {
      sentenceDiv.textContent = "Hit more good shots with this club to build your good-shot ranges (at least 8 good shots with each body number needed).";
    } else {
      sentenceDiv.textContent = "No swings recorded with this club in this period yet.";
    }

    box.appendChild(sentenceDiv);

    if (!analysis.groups || !analysis.groups.length) return;

    // 2. Groups and rows
    const container = document.createElement("div");
    container.className = "cp-groups-wrap";

    for (const group of analysis.groups) {
      if (!group.items || !group.items.length) continue;

      const groupDiv = document.createElement("div");
      groupDiv.className = "cp-group";

      const titleEl = document.createElement("div");
      titleEl.className = "cp-group-title";
      titleEl.textContent = group.name;
      groupDiv.appendChild(titleEl);

      const listEl = document.createElement("div");
      listEl.className = "cp-group-list";

      for (const item of group.items) {
        const rowEl = document.createElement("div");
        rowEl.className = "cp-row";
        rowEl.onclick = () => onMetric(item.key);

        // Column 1: Label and shaky marker
        const labCol = document.createElement("div");
        labCol.className = "cp-col-label";
        const labSpan = document.createElement("span");
        labSpan.className = "cp-label-text";
        labSpan.textContent = item.field.label;
        labCol.appendChild(labSpan);

        if (item.shakyShare > 0.5) {
          const shakySpan = document.createElement("span");
          shakySpan.className = "cp-shaky";
          shakySpan.textContent = " ~";
          shakySpan.title = "Most swings had shaky camera tracking on this number";
          labCol.appendChild(shakySpan);
        }
        rowEl.appendChild(labCol);

        // Column 2: Range Bar SVG
        const barCol = document.createElement("div");
        barCol.className = "cp-col-bar";

        const barW = 160;
        const barH = 20;
        const svg = document.createElementNS(NS, "svg");
        svg.setAttribute("viewBox", `0 0 ${barW} ${barH}`);
        svg.setAttribute("class", "cp-bar-svg");

        if (item.range) {
          // Determine scale domain
          const pts = [item.range.q10, item.range.q90, item.range.q25, item.range.q75];
          if (item.q1 != null) pts.push(item.q1);
          if (item.q3 != null) pts.push(item.q3);
          if (item.latest.med != null) pts.push(item.latest.med);

          const vMin = Math.min(...pts);
          const vMax = Math.max(...pts);
          const span = vMax - vMin || 1;
          const pad = span * 0.12;
          const minX = vMin - pad;
          const maxX = vMax + pad;
          const scale = v => ((v - minX) / (maxX - minX)) * barW;

          // Background track
          svgEl("rect", {
            x: 0, y: 8, width: barW, height: 4,
            rx: 2, ry: 2, fill: "var(--line)",
          }, svg);

          // Good-shot range: q10..q90 (fainter)
          const rx10 = Math.max(0, Math.min(barW, scale(item.range.q10)));
          const rx90 = Math.max(0, Math.min(barW, scale(item.range.q90)));
          const rw90 = Math.max(2, rx90 - rx10);
          svgEl("rect", {
            x: rx10, y: 5, width: rw90, height: 10,
            rx: 3, ry: 3, fill: "var(--dot)", opacity: 0.18,
          }, svg);

          // Good-shot range: q25..q75 (solid-faint)
          const rx25 = Math.max(0, Math.min(barW, scale(item.range.q25)));
          const rx75 = Math.max(0, Math.min(barW, scale(item.range.q75)));
          const rw75 = Math.max(2, rx75 - rx25);
          svgEl("rect", {
            x: rx25, y: 5, width: rw75, height: 10,
            rx: 3, ry: 3, fill: "var(--dot)", opacity: 0.38,
          }, svg);

          // Period middle half: thin line q1..q3
          if (item.q1 != null && item.q3 != null) {
            const lx1 = Math.max(0, Math.min(barW, scale(item.q1)));
            const lx3 = Math.max(0, Math.min(barW, scale(item.q3)));
            svgEl("line", {
              x1: lx1, y1: 10, x2: lx3, y2: 10,
              stroke: "var(--text)", "stroke-width": 2, opacity: 0.85,
            }, svg);
          }

          // Latest session median dot
          if (item.latest.med != null) {
            const cx = Math.max(4, Math.min(barW - 4, scale(item.latest.med)));
            const isInside = item.gap === 0;
            const dotCol = isInside ? "var(--dot)" : "var(--warn)";
            svgEl("circle", {
              cx, cy: 10, r: 4.5,
              fill: dotCol, stroke: "var(--panel)", "stroke-width": 1.5,
            }, svg);
          }
        } else if (item.q1 != null && item.q3 != null) {
          // No range yet, show period's middle half
          const pts = [item.q1, item.q3];
          if (item.latest.med != null) pts.push(item.latest.med);
          const vMin = Math.min(...pts);
          const vMax = Math.max(...pts);
          const span = vMax - vMin || 1;
          const pad = span * 0.12;
          const minX = vMin - pad;
          const maxX = vMax + pad;
          const scale = v => ((v - minX) / (maxX - minX)) * barW;

          // Background track
          svgEl("rect", {
            x: 0, y: 8, width: barW, height: 4,
            rx: 2, ry: 2, fill: "var(--line)",
          }, svg);

          const lx1 = Math.max(0, Math.min(barW, scale(item.q1)));
          const lx3 = Math.max(0, Math.min(barW, scale(item.q3)));
          svgEl("line", {
            x1: lx1, y1: 10, x2: lx3, y2: 10,
            stroke: "var(--text)", "stroke-width": 2, opacity: 0.7,
          }, svg);

          if (item.latest.med != null) {
            const cx = Math.max(4, Math.min(barW - 4, scale(item.latest.med)));
            svgEl("circle", {
              cx, cy: 10, r: 4.5,
              fill: "var(--muted)", stroke: "var(--panel)", "stroke-width": 1.5,
            }, svg);
          }
        }

        barCol.appendChild(svg);
        rowEl.appendChild(barCol);

        // Column 3: Value and position word
        const valCol = document.createElement("div");
        valCol.className = "cp-col-val";

        const valSpan = document.createElement("span");
        valSpan.className = "cp-val-num";
        valSpan.textContent = fmt(item.field, item.latest.med);
        valCol.appendChild(valSpan);

        const posSpan = document.createElement("span");
        posSpan.className = "cp-val-pos";
        if (item.range) {
          if (item.latest.med != null) {
            if (item.latest.med < item.range.q25) {
              posSpan.textContent = "low";
              posSpan.style.color = "var(--warn)";
            } else if (item.latest.med > item.range.q75) {
              posSpan.textContent = "high";
              posSpan.style.color = "var(--warn)";
            } else {
              posSpan.textContent = "inside";
              posSpan.style.color = "var(--dot)";
            }
          } else {
            posSpan.textContent = "–";
          }
        } else {
          posSpan.textContent = "no range yet";
          posSpan.style.color = "var(--muted)";
        }
        valCol.appendChild(posSpan);
        rowEl.appendChild(valCol);

        // Column 4: Share in range & outside swings link
        const metaCol = document.createElement("div");
        metaCol.className = "cp-col-meta";

        if (item.inRange != null) {
          const inRangeSpan = document.createElement("span");
          inRangeSpan.className = "cp-in-range";
          inRangeSpan.textContent = `${Math.round(item.inRange * 100)}% in range`;
          metaCol.appendChild(inRangeSpan);
        }

        if (item.outRows && item.outRows.length > 0) {
          const outBtn = document.createElement("button");
          outBtn.className = "cp-outside-btn";
          outBtn.type = "button";
          outBtn.textContent = "swings outside";
          outBtn.title = `Show ${item.outRows.length} swing${item.outRows.length === 1 ? "" : "s"} outside your good-shot range`;
          outBtn.onclick = e => {
            e.stopPropagation();
            onPick(item.outRows, `${item.field.label}: outside your good-shot range`, item.key);
          };
          metaCol.appendChild(outBtn);
        }

        rowEl.appendChild(metaCol);
        listEl.appendChild(rowEl);
      }

      groupDiv.appendChild(listEl);
      container.appendChild(groupDiv);
    }

    box.appendChild(container);

    // 3. Fold "How it's worked out"
    const fold = document.createElement("details");
    fold.className = "explain";
    fold.innerHTML = `
      <summary>How it's worked out</summary>
      <div class="note">
        <strong>Good-shot range:</strong> the solid band covers the middle 50% (25th to 75th percentile) and the faint band covers the middle 80% (10th to 90th percentile) of each number on your good shots with this club (seen in Analysis > Good-shot ranges). At least 8 good shots with a reliable reading are needed for a range.<br><br>
        <strong>Your own swings:</strong> the range describes where you sit when you hit your best shots with this club, not a generic tour model.<br><br>
        <strong>Shaky numbers (~):</strong> marked when more than half of the swings had noisy or uncertain camera tracking on that number.<br><br>
        <strong>Camera placement:</strong> moving phone tripods between sessions shifts angle readings; keep cameras in their marked positions for consistent numbers.
      </div>
    `;
    box.appendChild(fold);
  }

  const api = {
    analyze,
    render,
    quantile,
    GROUP_DEFS,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingCheckpoints = api;
})(typeof window !== "undefined" ? window : globalThis);
