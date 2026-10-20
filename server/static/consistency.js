// server/static/consistency.js
// Consistency analysis: your least consistent body movements compared to the room your good shots leave.
// Works in the browser (window.SwingConsistency) and in Node (module.exports).

(function (root) {
  const Summary = root.SwingSummary || (typeof require !== "undefined" && require("./summary.js"));
  const Trust = root.SwingTrust || (typeof require !== "undefined" && require("./trust.js"));
  const Indicators = root.SwingIndicators || (typeof require !== "undefined" && require("./indicators.js"));
  const GoodShots = root.SwingGoodShots || (typeof require !== "undefined" && require("./goodshots.js"));

  const finite = v => typeof v === "number" && Number.isFinite(v);

  function median(vals) {
    const v = (vals || []).filter(finite).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = (v.length - 1) / 2;
    return (v[Math.floor(m)] + v[Math.ceil(m)]) / 2;
  }

  /**
   * Robust spread: 1.4826 x Median Absolute Deviation (MAD).
   * Returns null if fewer than 2 finite values.
   */
  function robustSpread(vals) {
    const v = (vals || []).filter(finite);
    if (v.length < 2) return null;
    const med = median(v);
    if (med == null) return null;
    const diffs = v.map(x => Math.abs(x - med));
    const mad = median(diffs);
    return mad == null ? null : 1.4826 * mad;
  }

  /**
   * Ratio expressed in plain words.
   */
  function ratioWords(ratio) {
    if (!finite(ratio)) return "–";
    if (ratio >= 2.5) {
      return `wanders about ${Math.round(ratio)} times as far as your good shots do`;
    }
    if (ratio >= 1.85) {
      return "wanders about twice as far as your good shots do";
    }
    if (ratio >= 1.4) {
      return "wanders about one and a half times as far as your good shots do";
    }
    if (ratio >= 1.15) {
      return "wanders about a quarter further than your good shots do";
    }
    if (ratio >= 0.88) {
      return "wanders about as far as your good shots do";
    }
    if (ratio >= 0.65) {
      return "wanders about three quarters as far as your good shots do";
    }
    if (ratio >= 0.4) {
      return "wanders about half as far as your good shots do";
    }
    return "wanders about a third as far as your good shots do";
  }

  function resolveField(key) {
    if (Indicators && Indicators.KNOWN_FIELDS && Indicators.KNOWN_FIELDS[key]) {
      return Indicators.KNOWN_FIELDS[key];
    }
    const b = Summary && Summary.BODY ? Summary.BODY.find(x => x.key === key) : null;
    return b ? { key: b.key, label: b.label, unit: b.unit } : { key, label: key, unit: "" };
  }

  /**
   * Analyze consistency across body numbers for a club or pooled club group.
   *
   * @param sessions array of session objects ({key, rows: [...]})
   * @param opts {
   *   club: target club code (e.g. "I7") or null,
   *   group: "irons" | "woods" | null,
   *   scope: "club" | "group",
   *   goodRange: (club, key) => range object with {q25, q75, n, enough, reliable},
   *   noiseTable: noise table object from /api/noise,
   *   bodyFields: optional override for Summary.BODY
   * }
   */
  function analyze(sessions, opts = {}) {
    const targetClub = opts.club || null;
    const groupOf = (GoodShots && GoodShots.groupOf) || (c => (/^(DR|[WH]\d|\d[WH])$/.test(c) ? "woods" : "irons"));
    const group = opts.group || (targetClub ? groupOf(targetClub) : null);
    const pooled = opts.scope === "group" && !!group;

    const list = sessions || [];
    // Flatten rows belonging to the target club or group
    const rows = [];
    for (const s of list) {
      const sKey = s.key || s.session || "unknown";
      for (const r of (s.rows || [])) {
        if (!r || !r.club || r.excluded || (r.drill && r.drill !== "none")) continue;
        const cl = r.club;
        if (pooled) {
          if (groupOf(cl) !== group) continue;
        } else if (targetClub && cl !== targetClub) {
          continue;
        }
        rows.push({
          sKey,
          club: cl,
          row: r,
          body: r.body || (r.rec && r.rec.body) || {},
          trust: r.trust || (r.rec && r.rec.trust) || {}
        });
      }
    }

    const bodyFields = opts.bodyFields || (Summary && Summary.BODY) || [];
    const noiseTable = opts.noiseTable || null;
    const getRange = typeof opts.goodRange === "function" ? opts.goodRange : () => null;

    const ranked = [];
    const excluded = [];

    // Group rows by session-and-club
    const scMap = new Map();
    for (const r of rows) {
      const k = `${r.sKey}|${r.club}`;
      if (!scMap.has(k)) scMap.set(k, []);
      scMap.get(k).push(r);
    }

    for (const f of bodyFields) {
      const key = f.key;
      const field = resolveField(key);

      // Determine good-shot range width
      // If single club, rangeOf(club, key)
      // If pooled group, average width weighted by shots with each club in group
      let goodWidth = null;
      let goodCount = 0;
      if (!pooled && targetClub) {
        const gr = getRange(targetClub, key);
        if (gr && gr.enough && gr.n >= 8 && gr.q75 != null && gr.q25 != null && gr.q75 > gr.q25) {
          goodWidth = gr.q75 - gr.q25;
          goodCount = gr.n;
        }
      } else if (pooled) {
        // Collect distinct clubs in rows
        const groupClubs = [...new Set(rows.map(r => r.club))];
        let sumW = 0, sumN = 0;
        for (const cl of groupClubs) {
          const gr = getRange(cl, key);
          if (gr && gr.enough && gr.n >= 8 && gr.q75 != null && gr.q25 != null && gr.q75 > gr.q25) {
            sumW += (gr.q75 - gr.q25) * gr.n;
            sumN += gr.n;
          }
        }
        if (sumN >= 8) {
          goodWidth = sumW / sumN;
          goodCount = sumN;
        }
      }

      if (goodWidth == null || goodWidth <= 0 || goodCount < 8) {
        excluded.push({
          key,
          label: field.label,
          unit: field.unit,
          reason: `fewer than 8 good shots (${goodCount} good shot${goodCount === 1 ? "" : "s"})`
        });
        continue;
      }

      // Collect session-and-club robust spreads
      let totalClean = 0;
      let totalShaky = 0;
      let totalMissing = 0;
      const distinctSessions = new Set();
      const scSpreads = [];

      for (const [scKey, scRows] of scMap.entries()) {
        const sess = scKey.split("|")[0];
        const vals = [];
        for (const item of scRows) {
          const val = item.body[key];
          const tr = item.trust[key];
          if (val == null || !finite(val) || (tr && tr.level === "none")) {
            totalMissing++;
            continue;
          }
          if (tr && tr.level === "shaky") {
            totalShaky++;
            continue;
          }
          vals.push(val);
        }

        const nClean = vals.length;
        if (nClean >= 2) {
          const sp = robustSpread(vals);
          if (sp != null) {
            scSpreads.push({ n: nClean, spread: sp });
            distinctSessions.add(sess);
            totalClean += nClean;
          }
        } else if (nClean === 1) {
          totalClean += 1;
          distinctSessions.add(sess);
        }
      }

      // Exclusion: most readings shaky
      if (totalShaky > totalClean) {
        excluded.push({
          key,
          label: field.label,
          unit: field.unit,
          reason: `most readings are shaky (${totalShaky} shaky vs ${totalClean} clean)`
        });
        continue;
      }

      // Exclusion: fewer than 20 readings over 3 sessions
      if (totalClean < 20 || distinctSessions.size < 3) {
        excluded.push({
          key,
          label: field.label,
          unit: field.unit,
          reason: `fewer than 20 readings over 3 sessions (${totalClean} reading${totalClean === 1 ? "" : "s"} across ${distinctSessions.size} session${distinctSessions.size === 1 ? "" : "s"})`
        });
        continue;
      }

      // Weighted average of session spreads
      let sumSpread = 0, sumN = 0;
      for (const sc of scSpreads) {
        sumSpread += sc.spread * sc.n;
        sumN += sc.n;
      }
      const rawSpread = sumN > 0 ? (sumSpread / sumN) : 0;

      // Address noise from noiseTable
      let addressNoise = 0;
      if (noiseTable && noiseTable.keys && Trust && Trust.numberOf) {
        const nInfo = Trust.numberOf(key);
        if (nInfo && nInfo.pos) {
          const nRow = noiseTable.keys[`${nInfo.view}.${nInfo.value}.${nInfo.pos}`];
          if (nRow && finite(nRow.noise)) {
            addressNoise = nRow.noise;
          }
        }
      }

      // Net spread: sqrt(max(0, spread^2 - noise^2))
      const netSpread = Math.sqrt(Math.max(0, rawSpread * rawSpread - addressNoise * addressNoise));
      const ratio = goodWidth > 0 ? (netSpread / goodWidth) : 0;

      ranked.push({
        key,
        label: field.label,
        unit: field.unit,
        rawSpread,
        addressNoise,
        netSpread,
        goodWidth,
        ratio,
        words: ratioWords(ratio),
        swings: totalClean,
        sessions: distinctSessions.size,
        shakyCount: totalShaky,
        noiseTakesOut: (rawSpread > 0 && netSpread === 0)
      });
    }

    // Sort descending by ratio
    ranked.sort((a, b) => b.ratio - a.ratio);

    const top5 = ranked.slice(0, 5);
    const others = ranked.slice(5);

    let status = "";
    if (ranked.length > 0) {
      const topRatio = ranked[0].ratio;
      status = topRatio > 1.0 ? "wanders outside good shots" : "inside good-shot range";
    }

    return {
      club: targetClub,
      group,
      pooled,
      ranked,
      top5,
      others,
      excluded,
      status
    };
  }

  /**
   * Render the Consistency view into box.
   */
  function render(box, model, opts = {}) {
    if (!box) return;
    box.replaceChildren();

    if (!model || (!model.ranked.length && !model.excluded.length)) {
      const empty = document.createElement("div");
      empty.className = "note";
      empty.textContent = "No swings to measure consistency with this club yet (takes at least 20 swings over 3 sessions).";
      box.appendChild(empty);
      return;
    }

    const onPick = typeof opts.onPick === "function" ? opts.onPick : () => {};
    const dec = (v, unit) => {
      if (unit === ":1" || unit === "s") return v.toFixed(2);
      if (v < 10) return v.toFixed(2);
      return v.toFixed(1);
    };

    // Container for card rows
    const container = document.createElement("div");
    container.className = "cs-list";
    container.style.cssText = "display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;";

    function renderRow(item, isTop) {
      const row = document.createElement("div");
      row.className = "cs-row";
      row.style.cssText = "display: flex; flex-direction: column; padding: 10px 14px; background: var(--panel); border-radius: 8px; cursor: pointer; transition: background 0.15s; border-left: 3px solid " + (item.ratio >= 1.0 ? "var(--miss, #e05d52)" : "var(--accent, #4da3ff)") + ";";
      row.onmouseover = () => { row.style.background = "var(--panel-2)"; };
      row.onmouseout = () => { row.style.background = "var(--panel)"; };
      row.onclick = () => onPick(item.key);

      const topLine = document.createElement("div");
      topLine.style.cssText = "display: flex; justify-content: space-between; align-items: baseline; gap: 8px;";
      
      const title = document.createElement("b");
      title.style.fontSize = "15px";
      title.textContent = item.label;

      const ratioBadge = document.createElement("span");
      ratioBadge.style.cssText = "font-weight: 700; font-size: 14px; color: " + (item.ratio >= 1.0 ? "var(--miss, #e05d52)" : "var(--muted)");
      ratioBadge.textContent = `${item.ratio.toFixed(2)}x`;

      topLine.append(title, ratioBadge);

      const wordsLine = document.createElement("div");
      wordsLine.style.cssText = "font-size: 13px; color: var(--text-2, #bbb); margin: 3px 0;";
      wordsLine.textContent = item.words;

      const subLine = document.createElement("div");
      subLine.style.cssText = "font-size: 12px; color: var(--muted); display: flex; gap: 12px; flex-wrap: wrap;";
      const spreadText = `spread ±${dec(item.netSpread, item.unit)}${item.unit}`;
      const goodText = `good width ${dec(item.goodWidth, item.unit)}${item.unit}`;
      const countText = `${item.swings} swings · ${item.sessions} sessions`;
      subLine.append(
        Object.assign(document.createElement("span"), { textContent: spreadText }),
        Object.assign(document.createElement("span"), { textContent: goodText }),
        Object.assign(document.createElement("span"), { textContent: countText })
      );

      row.append(topLine, wordsLine, subLine);
      return row;
    }

    // Top 5 rows
    for (const item of model.top5) {
      container.appendChild(renderRow(item, true));
    }
    box.appendChild(container);

    // "Every number" fold
    if (model.others.length > 0 || model.excluded.length > 0) {
      const fold = document.createElement("details");
      fold.className = "p-fold";
      fold.style.cssText = "margin-top: 12px;";

      const summary = document.createElement("summary");
      summary.style.cursor = "pointer";
      summary.innerHTML = `<strong>Every number</strong> <span class="note">${model.others.length} more, ${model.excluded.length} excluded</span>`;
      fold.appendChild(summary);

      const inner = document.createElement("div");
      inner.style.cssText = "display: flex; flex-direction: column; gap: 8px; margin-top: 8px;";

      for (const item of model.others) {
        inner.appendChild(renderRow(item, false));
      }

      if (model.excluded.length > 0) {
        const exTitle = document.createElement("div");
        exTitle.className = "p-why-sub";
        exTitle.style.cssText = "margin-top: 12px; font-size: 13px; color: var(--muted);";
        exTitle.textContent = "Left out:";
        inner.appendChild(exTitle);

        const exList = document.createElement("div");
        exList.style.cssText = "font-size: 12px; color: var(--muted); display: flex; flex-direction: column; gap: 4px;";
        for (const ex of model.excluded) {
          const line = document.createElement("div");
          line.textContent = `• ${ex.label || ex.key}: ${ex.reason}`;
          exList.appendChild(line);
        }
        inner.appendChild(exList);
      }

      fold.appendChild(inner);
      box.appendChild(fold);
    }

    // "How it's worked out" fold
    const how = document.createElement("details");
    how.className = "p-fold";
    how.style.cssText = "margin-top: 16px;";
    how.innerHTML = `
      <summary class="note" style="cursor: pointer;">How it's worked out</summary>
      <div class="note" style="margin-top: 8px; line-height: 1.5;">
        <p>Your movements are ranked by how much they wobble swing to swing compared to the room your good shots leave.</p>
        <p>For each session and club, we calculate the robust spread (1.4826 × median absolute deviation) of clean readings. Because spreads are calculated <em>within</em> each session, a camera placed at a slightly different distance or angle between days never artificially inflates your spread.</p>
        <p>Session spreads are weighted by swings, and camera jitter at address is subtracted: <code>√(spread² - noise²)</code>. This net spread is divided by the middle half of your good shots with that club (75th percentile minus 25th percentile). A ratio above 1 means the movement wanders further than your good shots allow.</p>
      </div>
    `;
    box.appendChild(how);
  }

  const api = {
    robustSpread,
    ratioWords,
    analyze,
    render
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingConsistency = api;
})(typeof window !== "undefined" ? window : globalThis);
