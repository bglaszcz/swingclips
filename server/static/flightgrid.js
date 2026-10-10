// server/static/flightgrid.js
// Ball flight grid for Analysis: where the ball started against how it curved.
// Works in the browser (window.SwingFlightGrid) and in Node (module.exports).

(function (root) {
  // Start line threshold: direction beyond 2° either way.
  const START_DEG = 2;
  // Curve threshold: sideways curvature beyond 2.5% of carry either way.
  const CURVE_PCT = 0.025;
  // Minimum classified shots to determine a usual flight cell.
  const MIN_SHOTS = 10;

  const finite = v => typeof v === "number" && Number.isFinite(v);

  const CLUB_NAMES = { DR: "Driver", PW: "PW", GW: "GW", SW: "SW", LW: "LW", PT: "Putter" };
  function defaultClubName(code) {
    if (!code) return "club";
    const u = String(code).trim().toUpperCase();
    if (CLUB_NAMES[u]) return CLUB_NAMES[u];
    let m = u.match(/^([WHI])(\d)$/);
    if (m) return `${m[2]}${{ W: " wood", H: " hybrid", I: " iron" }[m[1]]}`;
    m = u.match(/^(\d)([WHI])$/);
    if (m) return `${m[1]}${{ W: " wood", H: " hybrid", I: " iron" }[m[2]]}`;
    return code;
  }

  /**
   * Names for right-handers vs left-handers:
   * Right-handed: start left = Pull, right = Push; curve left = Draw, right = Fade.
   * Left-handed: start right = Pull, left = Push; curve right = Draw, left = Fade.
   */
  function flightName(start, curve, leftHanded) {
    if (!leftHanded) {
      if (start === "left") {
        if (curve === "left") return "Pull draw";
        if (curve === "right") return "Pull fade";
        return "Pull";
      }
      if (start === "right") {
        if (curve === "left") return "Push draw";
        if (curve === "right") return "Push fade";
        return "Push";
      }
      // start straight
      if (curve === "left") return "Draw";
      if (curve === "right") return "Fade";
      return "Straight";
    } else {
      // Left-handed mirror:
      // start right is pull, start left is push.
      // curve right is draw, curve left is fade.
      if (start === "right") {
        if (curve === "right") return "Pull draw";
        if (curve === "left") return "Pull fade";
        return "Pull";
      }
      if (start === "left") {
        if (curve === "right") return "Push draw";
        if (curve === "left") return "Push fade";
        return "Push";
      }
      // start straight
      if (curve === "right") return "Draw";
      if (curve === "left") return "Fade";
      return "Straight";
    }
  }

  /**
   * Classify a single swing row into one of the nine ball flights.
   * Returns null if missing carry, direction, offline, or if carry <= 0.
   */
  function classify(row, opts) {
    if (!row) return null;
    const carry = row.carry;
    const offline = row.offline;
    const direction = row.direction;
    if (!finite(carry) || carry <= 0 || !finite(offline) || !finite(direction)) {
      return null;
    }

    const leftHanded = !!(opts && opts.leftHanded);

    // Start line: left is negative, right is positive.
    let start = "straight";
    if (direction < -START_DEG) start = "left";
    else if (direction > START_DEG) start = "right";

    // Curve in yards: sideways yards moved off start line.
    const dirRad = (direction * Math.PI) / 180;
    const curveYd = offline - carry * Math.tan(dirRad);
    const thresh = carry * CURVE_PCT;

    let curve = "straight";
    if (curveYd < -thresh) curve = "left";
    else if (curveYd > thresh) curve = "right";

    const key = `${start}_${curve}`;
    const name = flightName(start, curve, leftHanded);

    return { start, curve, key, name, curveYd };
  }

  /**
   * Grid order for the 3x3 cells:
   * Starts left (Pull draw, Pull, Pull fade for righty)
   * Starts straight (Draw, Straight, Fade for righty)
   * Starts right (Push draw, Push, Push fade for righty)
   */
  const GRID_ORDER = [
    { start: "left", curve: "left" },
    { start: "left", curve: "straight" },
    { start: "left", curve: "right" },
    { start: "straight", curve: "left" },
    { start: "straight", curve: "straight" },
    { start: "straight", curve: "right" },
    { start: "right", curve: "left" },
    { start: "right", curve: "straight" },
    { start: "right", curve: "right" },
  ];

  function median(vals) {
    if (!vals || !vals.length) return null;
    const s = [...vals].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 !== 0 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  /**
   * Analyze ball flights across picked sessions for a club.
   */
  function analyze(sessions, opts = {}) {
    const club = opts.club;
    const leftHanded = !!opts.leftHanded;

    const cellsMap = new Map();
    for (const g of GRID_ORDER) {
      const key = `${g.start}_${g.curve}`;
      cellsMap.set(key, {
        start: g.start,
        curve: g.curve,
        key,
        name: flightName(g.start, g.curve, leftHanded),
        n: 0,
        share: 0,
        rows: [],
        good: 0,
        judged: 0,
        medOffline: null,
      });
    }

    const sessList = Array.isArray(sessions) ? sessions : [];
    const latestSess = sessList.length > 0 ? sessList[sessList.length - 1] : null;

    let totalN = 0;
    const classifiedShots = [];
    const sessSummaries = [];

    let latestCount = 0;
    const latestCellCounts = new Map();

    for (const sess of sessList) {
      const isLatest = sess === latestSess;
      const starts = { left: 0, straight: 0, right: 0 };
      const curves = { left: 0, straight: 0, right: 0 };
      let sessN = 0;

      const rows = Array.isArray(sess.rows) ? sess.rows : [];
      for (const r of rows) {
        if (club && r.club && r.club !== club) continue;
        const cls = classify(r, { leftHanded });
        if (!cls) continue;

        totalN++;
        sessN++;
        starts[cls.start]++;
        curves[cls.curve]++;

        const cObj = cellsMap.get(cls.key);
        if (cObj) {
          cObj.n++;
          cObj.rows.push(r);
          if (r.good === true) cObj.good++;
          if (r.good === true || r.good === false) cObj.judged++;
        }

        if (isLatest) {
          latestCount++;
          latestCellCounts.set(cls.key, (latestCellCounts.get(cls.key) || 0) + 1);
        }

        classifiedShots.push({ row: r, cls, latest: isLatest });
      }

      sessSummaries.push({
        key: sess.key,
        start: sess.start,
        n: sessN,
        starts,
        curves,
      });
    }

    const cells = GRID_ORDER.map(g => {
      const c = cellsMap.get(`${g.start}_${g.curve}`);
      c.share = totalN > 0 ? c.n / totalN : 0;
      const offlines = c.rows.map(r => r.offline).filter(finite);
      c.medOffline = offlines.length ? median(offlines) : null;
      return c;
    });

    let usual = null;
    if (totalN >= MIN_SHOTS) {
      let maxN = -1;
      for (const c of cells) {
        if (c.n > maxN) {
          maxN = c.n;
          usual = c;
        }
      }
      if (maxN <= 0) usual = null;
    }

    const latestUsualN = usual ? (latestCellCounts.get(usual.key) || 0) : 0;
    const latest = latestSess ? {
      key: latestSess.key,
      start: latestSess.start,
      n: latestCount,
      usualN: latestUsualN,
    } : { key: null, start: null, n: 0, usualN: 0 };

    const cLabel = defaultClubName(club);
    const status = totalN > 0
      ? `${cLabel} · ${totalN} shot${totalN === 1 ? "" : "s"}`
      : `${cLabel} · no shots`;

    return {
      n: totalN,
      cells,
      usual,
      latest,
      sessions: sessSummaries,
      shots: classifiedShots,
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
   * Mini flight curve icon for grid buttons.
   */
  function miniFlightSvg(start, curve) {
    const w = 40, h = 32;
    const svg = createSvg(w, h, "fg-mini-flight");
    svg.style.overflow = "visible";

    // Target line (faint dashed)
    svgEl("line", {
      x1: w / 2, y1: 2, x2: w / 2, y2: h - 2,
      stroke: "var(--line)", "stroke-width": 1, "stroke-dasharray": "2,2",
    }, svg);

    // Start point: bottom center
    const x0 = w / 2, y0 = h - 4;

    // Start offset along start line
    let x1 = w / 2;
    if (start === "left") x1 = w / 2 - 8;
    else if (start === "right") x1 = w / 2 + 8;
    const y1 = h / 2;

    // End point
    let x2 = w / 2;
    if (start === "left") x2 -= 8;
    else if (start === "right") x2 += 8;

    if (curve === "left") x2 -= 8;
    else if (curve === "right") x2 += 8;
    const y2 = 4;

    // Path
    svgEl("path", {
      d: `M ${x0} ${y0} Q ${x1} ${y1} ${x2} ${y2}`,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 1.75,
      "stroke-linecap": "round",
    }, svg);

    // End dot
    svgEl("circle", {
      cx: x2, cy: y2, r: 2,
      fill: "currentColor",
    }, svg);

    return svg;
  }

  /**
   * Plain English description of the flight shape.
   */
  function describeFlight(usual, leftHanded) {
    if (!usual) return "";
    const { start, curve } = usual;
    let sDesc = "starts on line";
    if (start === "left") sDesc = "starts left";
    else if (start === "right") sDesc = "starts right";

    let cDesc = "and stays straight";
    if (!leftHanded) {
      if (curve === "left") {
        cDesc = start === "right" ? "and draws back" : start === "left" ? "and curves further left" : "and draws left";
      } else if (curve === "right") {
        cDesc = start === "left" ? "and fades back" : start === "right" ? "and curves further right" : "and fades right";
      }
    } else {
      if (curve === "right") {
        cDesc = start === "left" ? "and draws back" : start === "right" ? "and curves further right" : "and draws right";
      } else if (curve === "left") {
        cDesc = start === "right" ? "and fades back" : start === "left" ? "and curves further left" : "and fades left";
      }
    }
    return `${sDesc} ${cDesc}`;
  }

  /**
   * Main render method.
   */
  function render(box, analysis, opts = {}) {
    if (!box) return;
    box.replaceChildren();

    const clubWords = opts.clubWords || defaultClubName(opts.club);
    const dayOf = opts.dayOf || (ms => new Date(ms).toLocaleDateString());
    const onPick = typeof opts.onPick === "function" ? opts.onPick : () => {};
    const onOpen = typeof opts.onOpen === "function" ? opts.onOpen : () => {};
    const onSession = typeof opts.onSession === "function" ? opts.onSession : () => {};
    const leftHanded = !!opts.leftHanded;

    // 1. One sentence summary
    const sentenceDiv = document.createElement("div");
    sentenceDiv.className = "fg-sentence";
    sentenceDiv.style.cssText = "font-size: 14px; line-height: 1.5; margin-bottom: 16px;";

    if (analysis.n >= MIN_SHOTS && analysis.usual) {
      const desc = describeFlight(analysis.usual, leftHanded);
      const sharePct = Math.round(analysis.usual.share * 100);
      let text = `Your usual flight with the ${clubWords} ${desc} (${analysis.usual.name.toLowerCase()}): ${sharePct}% of ${analysis.n} shots.`;
      if (analysis.latest && analysis.latest.n > 0) {
        text += ` Last session: ${analysis.latest.usualN} of ${analysis.latest.n}.`;
      }
      sentenceDiv.textContent = text;
    } else {
      const needed = Math.max(1, MIN_SHOTS - analysis.n);
      sentenceDiv.textContent = `Need ${MIN_SHOTS} shots with the ${clubWords} to find your usual flight (${needed} more needed).`;
    }
    box.appendChild(sentenceDiv);

    // 2. The 3x3 Grid
    const gridWrap = document.createElement("div");
    gridWrap.className = "fg-grid-wrap";
    gridWrap.style.cssText = "margin-bottom: 24px; overflow-x: auto;";

    const grid = document.createElement("div");
    grid.className = "fg-grid";
    grid.style.cssText = "display: grid; grid-template-columns: 80px repeat(3, minmax(80px, 1fr)); gap: 6px; min-width: 320px; align-items: stretch;";

    // Header row
    const emptyCorner = document.createElement("div");
    grid.appendChild(emptyCorner);

    const colTitles = ["Curves left", "Straight", "Curves right"];
    for (const ct of colTitles) {
      const ch = document.createElement("div");
      ch.className = "fg-col-head note";
      ch.style.cssText = "text-align: center; font-size: 12px; font-weight: 600; padding: 4px 2px; color: var(--muted);";
      ch.textContent = ct;
      grid.appendChild(ch);
    }

    const rowTitles = ["Starts left", "Starts straight", "Starts right"];
    const rowStarts = ["left", "straight", "right"];
    const colCurves = ["left", "straight", "right"];

    for (let r = 0; r < 3; r++) {
      const rh = document.createElement("div");
      rh.className = "fg-row-head note";
      rh.style.cssText = "display: flex; align-items: center; font-size: 12px; font-weight: 600; padding: 4px 6px; color: var(--muted);";
      rh.textContent = rowTitles[r];
      grid.appendChild(rh);

      for (let c = 0; c < 3; c++) {
        const key = `${rowStarts[r]}_${colCurves[c]}`;
        const cell = analysis.cells.find(x => x.key === key);

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "fg-cell";

        const share = cell ? cell.share : 0;
        const count = cell ? cell.n : 0;
        const name = cell ? cell.name : "";

        // Fill gets deeper with share (var(--dot) with opacity / color-mix)
        const pct = Math.round(share * 100);
        btn.style.cssText = `
          display: flex; flex-direction: column; align-items: center; justify-content: space-between;
          padding: 8px 6px; border-radius: var(--radius-sm, 6px); border: 1px solid var(--line);
          cursor: pointer; text-align: center; min-height: 84px; gap: 4px; font-family: inherit;
          color: var(--text); background: color-mix(in srgb, var(--dot) ${pct}%, var(--panel));
        `;

        // Mini icon
        const icon = miniFlightSvg(rowStarts[r], colCurves[c]);
        btn.appendChild(icon);

        // Name
        const nameEl = document.createElement("div");
        nameEl.className = "fg-name";
        nameEl.style.cssText = "font-size: 12px; font-weight: 600; line-height: 1.2;";
        nameEl.textContent = name;
        btn.appendChild(nameEl);

        // Share & count
        const countEl = document.createElement("div");
        countEl.className = "fg-count";
        countEl.style.cssText = "font-size: 11px; color: var(--text); opacity: 0.9;";
        countEl.innerHTML = `${pct}% <span class="muted" style="font-size: 10px;">(${count})</span>`;
        btn.appendChild(countEl);

        btn.onclick = () => {
          if (cell) onPick(cell.rows, `${cell.name}: ${cell.n} shots`);
        };

        grid.appendChild(btn);
      }
    }
    gridWrap.appendChild(grid);
    box.appendChild(gridWrap);

    // 3. Every shot from above
    const chartCard = document.createElement("div");
    chartCard.className = "a-chart fg-chart";
    chartCard.style.cssText = "position: relative; margin-bottom: 24px;";

    // No wider than 640: across is stretched against up already, and a wider chart makes a spray of a tight pattern.
    const boxWidth = Math.max(280, Math.min(640, box.clientWidth || 320));
    const W = boxWidth;
    const H = Math.max(280, Math.min(460, Math.round(W * 0.72)));

    const svg = createSvg(W, H, "fg-above-svg");
    svg.style.display = "block";
    svg.style.overflow = "hidden";

    const tip = document.createElement("div");
    tip.className = "tip";
    tip.hidden = true;
    tip.style.cssText = "position: absolute; pointer-events: none; z-index: 10;";
    chartCard.appendChild(svg);
    chartCard.appendChild(tip);

    // Determine max carry and max offline
    let maxCarry = 150;
    let maxAbsOffline = 20;
    for (const s of analysis.shots) {
      if (s.row.carry > maxCarry) maxCarry = s.row.carry;
      const off = Math.abs(s.row.offline);
      if (off > maxAbsOffline) maxAbsOffline = off;
    }
    maxCarry = Math.ceil((maxCarry + 10) / 25) * 25;
    maxAbsOffline = Math.max(20, Math.ceil((maxAbsOffline + 5) / 10) * 10);

    const m = { top: 20, right: 36, bottom: 28, left: 36 };
    const plotW = W - m.left - m.right;
    const plotH = H - m.top - m.bottom;
    const centerX = m.left + plotW / 2;
    const teeY = H - m.bottom;

    const scaleY = plotH / maxCarry;
    const scaleX = (plotW / 2) / maxAbsOffline;

    // Yardage range arcs / gridlines
    const arcStep = maxCarry > 200 ? 50 : 25;
    for (let y = arcStep; y <= maxCarry; y += arcStep) {
      const sy = teeY - y * scaleY;
      svgEl("line", {
        x1: m.left, y1: sy, x2: W - m.right, y2: sy,
        stroke: "var(--line)", "stroke-width": 1, "stroke-dasharray": "3,3",
      }, svg);
      svgEl("text", {
        x: m.left - 4, y: sy + 4,
        "text-anchor": "end", fill: "var(--muted)", "font-size": 10,
      }, svg).textContent = `${y} yd`;
    }

    // Target line (offline = 0)
    svgEl("line", {
      x1: centerX, y1: m.top, x2: centerX, y2: teeY,
      stroke: "var(--line-strong)", "stroke-width": 1.5,
    }, svg);

    // Tee marker
    svgEl("circle", {
      cx: centerX, cy: teeY, r: 3,
      fill: "var(--text)",
    }, svg);

    // Lateral markers at bottom (-20, -10, 0, +10, +20)
    for (const off of [-20, -10, 10, 20]) {
      if (Math.abs(off) <= maxAbsOffline) {
        const sx = centerX + off * scaleX;
        svgEl("line", {
          x1: sx, y1: teeY - 3, x2: sx, y2: teeY + 3,
          stroke: "var(--muted)", "stroke-width": 1,
        }, svg);
        svgEl("text", {
          x: sx, y: H - 8,
          "text-anchor": "middle", fill: "var(--muted)", "font-size": 10,
        }, svg).textContent = `${Math.abs(off)} ${off < 0 ? "L" : "R"}`;
      }
    }

    // Render shot paths
    const shotElements = [];
    for (const s of analysis.shots) {
      const row = s.row;
      const cls = s.cls;
      const isLatest = s.latest;

      const sx2 = centerX + row.offline * scaleX;
      const sy2 = teeY - row.carry * scaleY;

      // Control point at 60% of carry along start line
      const dirRad = (row.direction * Math.PI) / 180;
      const y1Val = 0.6 * row.carry;
      const x1Val = y1Val * Math.tan(dirRad);
      const sx1 = centerX + x1Val * scaleX;
      const sy1 = teeY - y1Val * scaleY;

      const stroke = isLatest ? "var(--dot)" : "var(--muted)";
      const sw = isLatest ? 1.75 : 1;
      const op = isLatest ? 0.85 : 0.3;

      const path = svgEl("path", {
        d: `M ${centerX} ${teeY} Q ${sx1} ${sy1} ${sx2} ${sy2}`,
        fill: "none",
        stroke,
        "stroke-width": sw,
        opacity: op,
      }, svg);

      const dot = svgEl("circle", {
        cx: sx2, cy: sy2, r: isLatest ? 3 : 2,
        fill: stroke, opacity: isLatest ? 0.9 : 0.45,
      }, svg);

      shotElements.push({ s, path, dot, sx: sx2, sy: sy2, stroke, sw, op, isLatest });
    }

    // Legend
    const chartLegend = document.createElement("div");
    chartLegend.className = "p-legend";
    chartLegend.style.cssText = "margin-top: 8px;";
    chartLegend.innerHTML = `
      <span><i class="p-key" style="background: var(--dot)"></i>Latest session</span>
      <span><i class="p-key" style="background: var(--muted)"></i>Earlier sessions</span>
    `;
    chartCard.appendChild(chartLegend);

    // Interactive pointer inspection
    let activeHighlight = null;
    function clearHighlight() {
      if (activeHighlight) {
        activeHighlight.path.setAttribute("stroke-width", activeHighlight.sw);
        activeHighlight.path.setAttribute("opacity", activeHighlight.op);
        activeHighlight.dot.setAttribute("r", activeHighlight.isLatest ? 3 : 2);
        activeHighlight = null;
      }
      tip.hidden = true;
    }

    svg.onpointerleave = clearHighlight;
    svg.onpointermove = e => {
      const rect = svg.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;

      let closest = null;
      let minD = 24; // 24px threshold
      for (const item of shotElements) {
        const d = Math.hypot(item.sx - px, item.sy - py);
        if (d < minD) {
          minD = d;
          closest = item;
        }
      }

      if (!closest) {
        clearHighlight();
        return;
      }

      if (activeHighlight !== closest) {
        clearHighlight();
        activeHighlight = closest;
        closest.path.setAttribute("stroke-width", 3);
        closest.path.setAttribute("opacity", 1);
        closest.dot.setAttribute("r", 5.5);
      }

      const { row, cls } = closest.s;
      const offStr = (row.offline > 0 ? "+" : "") + row.offline.toFixed(1) + " yd";
      const dirStr = (row.direction > 0 ? "+" : "") + row.direction.toFixed(1) + "°";
      const curveStr = (cls.curveYd > 0 ? "+" : "") + cls.curveYd.toFixed(1) + " yd";

      tip.innerHTML = `
        <div style="font-weight: 600;">${cls.name} · ${dayOf(row.t)}</div>
        <div style="font-size: 12px; margin-top: 2px;">
          Carry ${Math.round(row.carry)} yd · Offline ${offStr}<br>
          Start line ${dirStr} · Curve ${curveStr}
        </div>
      `;
      tip.hidden = false;

      // Position tooltip inside chartCard
      const tipX = Math.min(W - 160, Math.max(10, px - 60));
      const tipY = Math.max(10, py - 65);
      tip.style.left = `${tipX}px`;
      tip.style.top = `${tipY}px`;
    };

    svg.onclick = () => {
      if (activeHighlight && activeHighlight.s.row.c && activeHighlight.s.row.c.name) {
        onOpen(activeHighlight.s.row.c.name);
      }
    };

    box.appendChild(chartCard);

    // 4. Session by session stacked bars
    const sessWrap = document.createElement("div");
    sessWrap.className = "fg-sessions";
    sessWrap.style.cssText = "margin-bottom: 24px;";

    const sessTitle = document.createElement("div");
    sessTitle.className = "p-why-sub";
    sessTitle.style.cssText = "font-weight: 600; font-size: 13px; margin-bottom: 8px;";
    sessTitle.textContent = "Session by session";
    sessWrap.appendChild(sessTitle);

    const validSessions = analysis.sessions.filter(s => s.n > 0);
    if (validSessions.length > 0) {
      const sessChart = document.createElement("div");
      sessChart.className = "a-chart fg-sess-chart";
      sessChart.style.cssText = "position: relative; overflow-x: auto;";

      const sTip = document.createElement("div");
      sTip.className = "tip";
      sTip.hidden = true;
      sTip.style.cssText = "position: absolute; pointer-events: none; z-index: 10;";
      sessChart.appendChild(sTip);

      const colW = Math.max(28, Math.min(48, Math.floor((W - 80) / validSessions.length)));
      const sW = Math.max(W, validSessions.length * colW + 80);
      const rowH = 50;
      const gapY = 16;
      const totalH = rowH * 2 + gapY + 30;

      const sSvg = createSvg(sW, totalH, "fg-sess-svg");
      sSvg.style.display = "block";
      sessChart.appendChild(sSvg);

      // Row labels
      svgEl("text", {
        x: 8, y: rowH / 2 + 4,
        fill: "var(--muted)", "font-size": 11, "font-weight": 600,
      }, sSvg).textContent = "Start";

      svgEl("text", {
        x: 8, y: rowH + gapY + rowH / 2 + 4,
        fill: "var(--muted)", "font-size": 11, "font-weight": 600,
      }, sSvg).textContent = "Curve";

      const startX = 60;
      const barW = Math.max(16, colW - 8);

      const sessCols = [];
      validSessions.forEach((sess, idx) => {
        const bx = startX + idx * colW + (colW - barW) / 2;

        // Start line stacked bar: rowH high
        // Left = var(--night), straight = var(--line-strong), right = var(--warn)
        const sL = sess.starts.left / sess.n;
        const sS = sess.starts.straight / sess.n;
        const sR = sess.starts.right / sess.n;

        let curY = 0;
        // Top: Left
        if (sL > 0) {
          const h = Math.max(1, Math.round(sL * (rowH - 4)));
          svgEl("rect", {
            x: bx, y: curY, width: barW, height: h, rx: 2,
            fill: "var(--night)",
          }, sSvg);
          curY += h + 2;
        }
        // Middle: Straight
        if (sS > 0) {
          const h = Math.max(1, Math.round(sS * (rowH - 4)));
          svgEl("rect", {
            x: bx, y: curY, width: barW, height: h, rx: 2,
            fill: "var(--line-strong)",
          }, sSvg);
          curY += h + 2;
        }
        // Bottom: Right
        if (sR > 0) {
          const h = Math.max(1, rowH - curY);
          svgEl("rect", {
            x: bx, y: curY, width: barW, height: h, rx: 2,
            fill: "var(--warn)",
          }, sSvg);
        }

        // Curve stacked bar: rowH high at rowH + gapY
        const cBaseY = rowH + gapY;
        const cL = sess.curves.left / sess.n;
        const cS = sess.curves.straight / sess.n;
        const cR = sess.curves.right / sess.n;

        curY = cBaseY;
        if (cL > 0) {
          const h = Math.max(1, Math.round(cL * (rowH - 4)));
          svgEl("rect", {
            x: bx, y: curY, width: barW, height: h, rx: 2,
            fill: "var(--night)",
          }, sSvg);
          curY += h + 2;
        }
        if (cS > 0) {
          const h = Math.max(1, Math.round(cS * (rowH - 4)));
          svgEl("rect", {
            x: bx, y: curY, width: barW, height: h, rx: 2,
            fill: "var(--line-strong)",
          }, sSvg);
          curY += h + 2;
        }
        if (cR > 0) {
          const h = Math.max(1, cBaseY + rowH - curY);
          svgEl("rect", {
            x: bx, y: curY, width: barW, height: h, rx: 2,
            fill: "var(--warn)",
          }, sSvg);
        }

        // Date label below (thinning if many)
        const showDate = validSessions.length <= 12 || idx % Math.ceil(validSessions.length / 10) === 0 || idx === validSessions.length - 1;
        if (showDate) {
          svgEl("text", {
            x: bx + barW / 2, y: totalH - 6,
            "text-anchor": "middle", fill: "var(--muted)", "font-size": 10,
          }, sSvg).textContent = dayOf(sess.start);
        }

        sessCols.push({ sess, x: bx, width: barW });
      });

      // Hover / interaction on session columns
      sSvg.onpointermove = e => {
        const rect = sSvg.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const col = sessCols.find(c => px >= c.x - 4 && px <= c.x + c.width + 4);
        if (!col) {
          sTip.hidden = true;
          return;
        }
        const s = col.sess;
        sTip.innerHTML = `
          <div style="font-weight: 600;">${dayOf(s.start)} · ${s.n} shots</div>
          <div style="font-size: 11px; margin-top: 2px;">
            Start: ${s.starts.left} left · ${s.starts.straight} straight · ${s.starts.right} right<br>
            Curve: ${s.curves.left} left · ${s.curves.straight} straight · ${s.curves.right} right
          </div>
        `;
        sTip.hidden = false;
        const tipX = Math.min(sW - 180, Math.max(10, col.x - 60));
        sTip.style.left = `${tipX}px`;
        sTip.style.top = `10px`;
      };
      sSvg.onpointerleave = () => { sTip.hidden = true; };
      sSvg.onclick = e => {
        const rect = sSvg.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const col = sessCols.find(c => px >= c.x - 4 && px <= c.x + c.width + 4);
        if (col && col.sess.key) onSession(col.sess.key);
      };

      sessWrap.appendChild(sessChart);

      // Legend
      const sessLegend = document.createElement("div");
      sessLegend.className = "p-legend";
      sessLegend.style.cssText = "margin-top: 8px;";
      sessLegend.innerHTML = `
        <span><i class="p-key" style="background: var(--night)"></i>Left</span>
        <span><i class="p-key" style="background: var(--line-strong)"></i>Straight</span>
        <span><i class="p-key" style="background: var(--warn)"></i>Right</span>
      `;
      sessWrap.appendChild(sessLegend);
    }
    box.appendChild(sessWrap);

    // 5. Fold "How it's worked out"
    const fold = document.createElement("details");
    fold.className = "explain";
    fold.innerHTML = `
      <summary>How it's worked out</summary>
      <div class="note">
        The nine ball flights compare where the ball started to how it curved in the air.<br><br>
        <strong>Start line:</strong> direction beyond 2° either way (starts left under -2°, starts right over +2°, otherwise straight). Left is negative, right is positive.<br><br>
        <strong>Curve:</strong> curvature in yards is offline − carry × tan(direction), measuring how far the ball curved off its initial start line. It curves left if curvature is beyond 2.5% of carry to the left, curves right if beyond 2.5% of carry to the right, otherwise straight.<br><br>
        <strong>Flight names:</strong> assume a right-handed golfer (draw curves left, fade curves right; pull starts left, push starts right). For a left-handed golfer, the draw/fade and pull/push names mirror automatically.
      </div>
    `;
    box.appendChild(fold);
  }

  const api = {
    START_DEG,
    CURVE_PCT,
    MIN_SHOTS,
    classify,
    analyze,
    render,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingFlightGrid = api;
})(typeof window !== "undefined" ? window : globalThis);
