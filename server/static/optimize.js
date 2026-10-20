// server/static/optimize.js
// Distance optimizer for driver and fairway woods (TrackMan Optimizer style).
// Computes optimal launch angle and spin rate at the golfer's median ball speed
// using the aerodynamic flightPath model, constrained to physically achievable delivery
// (within the golfer's actual shot range widened by 2° and 500 rpm).
(function (root) {
  "use strict";

  const TracerAtLoad = typeof SwingTracer !== "undefined"
    ? SwingTracer
    : (typeof require === "function" ? (function () { try { return require("./tracer.js"); } catch (e) { return null; } })() : null);

  const finite = v => typeof v === "number" && Number.isFinite(v);

  // Driver and fairway woods only (irons and hybrids launch and spin for stopping).
  const WOOD_CLUB_RE = /^(DR|[1-9]W|W[1-9]|DRIVER)$/i;

  function isWoodOrDriver(club) {
    if (!club) return false;
    return WOOD_CLUB_RE.test(club);
  }

  function quantile(sorted, q) {
    if (!sorted || !sorted.length) return null;
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  function median(arr) {
    if (!arr || !arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    return quantile(sorted, 0.5);
  }

  /**
   * Check aerodynamic model calibration against Square carry for a set of shots.
   * Fails if median difference exceeds 4.0 yards.
   */
  function checkCalibration(shots, tracer) {
    tracer = tracer || TracerAtLoad;
    if (!tracer || typeof tracer.flightPath !== "function") {
      return { ok: false, n: 0, medianDiff: null, iqr: null, reason: "Flight model unavailable" };
    }
    const diffs = [];
    for (const s of shots || []) {
      const speed = s.ballSpeed ?? (s.ball && s.ball.speed);
      const vla = s.launch ?? (s.ball && s.ball.vla);
      const hla = s.hla ?? (s.ball && s.ball.hla) ?? 0;
      const spin = s.spin ?? (s.ball && s.ball.totalSpin);
      const axis = s.spinAxis ?? (s.ball && s.ball.spinAxis) ?? 0;
      const actualCarry = s.carry ?? (s.ball && s.ball.carry);

      if (!finite(speed) || !finite(vla) || !finite(spin) || !finite(actualCarry)) continue;
      const fl = tracer.flightPath(speed, vla, hla, spin, axis);
      if (fl && finite(fl.carry)) {
        diffs.push(fl.carry - actualCarry);
      }
    }

    if (diffs.length < 5) {
      return { ok: false, n: diffs.length, medianDiff: null, iqr: null, reason: `Need at least 5 shots (found ${diffs.length})` };
    }

    diffs.sort((a, b) => a - b);
    const medDiff = quantile(diffs, 0.5);
    const q1 = quantile(diffs, 0.25);
    const q3 = quantile(diffs, 0.75);
    const iqr = q3 - q1;
    const ok = Math.abs(medDiff) <= 4.0;

    return {
      ok,
      n: diffs.length,
      medianDiff: medDiff,
      iqr,
      diffs,
      reason: ok ? null : `Model carry differs from Square carry by more than 4 yd at the median (${medDiff > 0 ? "+" : ""}${medDiff.toFixed(1)} yd)`,
    };
  }

  /**
   * Compute distance optimization grid and optimal launch/spin recommendation.
   */
  function optimize(shots, club, opts = {}) {
    const tracer = opts.tracer || TracerAtLoad;
    if (!tracer || typeof tracer.flightPath !== "function") {
      return { supported: false, reason: "Aerodynamic tracer model unavailable." };
    }

    if (!isWoodOrDriver(club)) {
      return {
        supported: false,
        reason: "Irons and hybrids launch and spin for stopping on greens; distance optimization is for driver and fairway woods only.",
      };
    }

    // Extract valid shots
    const valid = [];
    for (const s of shots || []) {
      const speed = s.ballSpeed ?? (s.ball && s.ball.speed);
      const launch = s.launch ?? (s.ball && s.ball.vla);
      const spin = s.spin ?? (s.ball && s.ball.totalSpin);
      const carry = s.carry ?? (s.ball && s.ball.carry);
      const hla = s.hla ?? (s.ball && s.ball.hla) ?? 0;
      const axis = s.spinAxis ?? (s.ball && s.ball.spinAxis) ?? 0;

      if (finite(speed) && finite(launch) && finite(spin) && finite(carry)) {
        valid.push({ ballSpeed: speed, launch, spin, carry, hla, spinAxis: axis });
      }
    }

    if (valid.length < 5) {
      return {
        supported: false,
        reason: `Need at least 5 shots with this club to optimize launch and spin (found ${valid.length}).`,
      };
    }

    // Check calibration: model must not be off by > 4 yd at median
    const calib = checkCalibration(valid, tracer);
    if (!calib.ok) {
      return {
        supported: false,
        check: calib,
        reason: calib.reason,
      };
    }

    const speeds = valid.map(s => s.ballSpeed);
    const launches = valid.map(s => s.launch);
    const spins = valid.map(s => s.spin);

    const medSpeed = median(speeds);
    const medLaunch = median(launches);
    const medSpin = median(spins);

    const usualModel = tracer.flightPath(medSpeed, medLaunch, 0, medSpin, 0);
    const usualCarry = usualModel ? usualModel.carry : median(valid.map(s => s.carry));

    // Bounds: golfer's actual shots widened by 2 degrees and 500 rpm
    const hitLaunchMin = Math.min(...launches);
    const hitLaunchMax = Math.max(...launches);
    const hitSpinMin = Math.min(...spins);
    const hitSpinMax = Math.max(...spins);

    const allowedLaunchMin = Math.max(6, hitLaunchMin - 2);
    const allowedLaunchMax = Math.min(20, hitLaunchMax + 2);
    const allowedSpinMin = Math.max(1500, hitSpinMin - 500);
    const allowedSpinMax = Math.min(4000, hitSpinMax + 500);

    // Grid definition: 6-20 deg (1 deg steps) and 1500-4000 rpm (250 rpm steps)
    const gridLaunches = [];
    for (let l = 6; l <= 20; l += 1) gridLaunches.push(l);

    const gridSpins = [];
    for (let sp = 1500; sp <= 4000; sp += 250) gridSpins.push(sp);

    let bestCell = null;
    let maxCarry = -Infinity;
    let minCarry = Infinity;

    const cells = [];
    for (const l of gridLaunches) {
      for (const sp of gridSpins) {
        const fl = tracer.flightPath(medSpeed, l, 0, sp, 0);
        const c = fl ? fl.carry : 0;
        if (c > maxCarry) maxCarry = c;
        if (c < minCarry) minCarry = c;

        const eligible = (l >= allowedLaunchMin && l <= allowedLaunchMax &&
                          sp >= allowedSpinMin && sp <= allowedSpinMax);

        const cell = { launch: l, spin: sp, carry: c, eligible };
        cells.push(cell);

        if (eligible && c > (bestCell ? bestCell.carry : -Infinity)) {
          bestCell = cell;
        }
      }
    }

    if (!bestCell) {
      bestCell = { launch: medLaunch, spin: medSpin, carry: usualCarry, eligible: true };
    }

    const gain = Math.max(0, bestCell.carry - usualCarry);

    let summary = "";
    if (gain >= 1.0) {
      summary = `With your ${Math.round(medSpeed)} mph ball speed, ${Math.round(bestCell.launch)} degrees with ${Math.round(bestCell.spin).toLocaleString()} rpm would carry about ${Math.round(gain)} yd more than your usual ${Math.round(medLaunch)} degrees with ${Math.round(medSpin).toLocaleString()} rpm.`;
    } else {
      summary = `With your ${Math.round(medSpeed)} mph ball speed, your usual ${Math.round(medLaunch)} degrees with ${Math.round(medSpin).toLocaleString()} rpm is already within 1 yd of your optimal carry.`;
    }

    return {
      supported: true,
      club,
      n: valid.length,
      check: calib,
      medSpeed,
      medLaunch,
      medSpin,
      usualCarry,
      bestCell,
      gain,
      summary,
      allowed: {
        launchMin: allowedLaunchMin,
        launchMax: allowedLaunchMax,
        spinMin: allowedSpinMin,
        spinMax: allowedSpinMax,
      },
      grid: {
        launches: gridLaunches,
        spins: gridSpins,
        cells,
        minCarry,
        maxCarry,
      },
      shots: valid,
    };
  }

  // --- SVG Drawing Helpers ---
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
   * Render optimizer heat grid SVG.
   */
  function renderHeatGridSvg(opt) {
    const { grid, bestCell, medLaunch, medSpin, shots } = opt;
    const launches = grid.launches; // 6..20 (ascending)
    const spins = grid.spins; // 1500..4000 (ascending)

    const cellW = 24, cellH = 14;
    const padL = 36, padR = 20, padT = 24, padB = 32;
    const gridW = spins.length * cellW;
    const gridH = launches.length * cellH;
    const totalW = padL + gridW + padR;
    const totalH = padT + gridH + padB;

    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${totalW} ${totalH}`);
    svg.setAttribute("class", "opt-grid-svg");

    const carryRange = (grid.maxCarry - grid.minCarry) || 1;

    // Background cells: Y is launch inverted (20 at top, 6 at bottom)
    for (const cell of grid.cells) {
      const colIdx = spins.indexOf(cell.spin);
      const rowIdx = launches.length - 1 - launches.indexOf(cell.launch);
      const x = padL + colIdx * cellW;
      const y = padT + rowIdx * cellH;

      const norm = Math.max(0, Math.min(1, (cell.carry - grid.minCarry) / carryRange));
      // Heat color: from deep dark slate to bright emerald accent
      const opacity = cell.eligible ? (0.2 + norm * 0.75) : 0.08;

      svgEl("rect", {
        x, y, width: cellW - 1, height: cellH - 1,
        rx: 2, ry: 2,
        fill: "var(--accent, #16803f)",
        opacity: opacity.toFixed(2),
      }, svg);

      // Best cell ring
      if (cell.launch === bestCell.launch && cell.spin === bestCell.spin) {
        svgEl("rect", {
          x: x - 1, y: y - 1, width: cellW + 1, height: cellH + 1,
          rx: 3, ry: 3,
          fill: "none",
          stroke: "var(--warn, #f59e0b)",
          "stroke-width": 2,
        }, svg);
      }
    }

    // Shot dots (actual shots)
    for (const s of shots || []) {
      // Map launch (6..20) and spin (1500..4000) to pixel coordinates
      const x = padL + Math.max(0, Math.min(gridW, ((s.spin - spins[0]) / (spins[spins.length - 1] - spins[0])) * gridW));
      const y = padT + gridH - Math.max(0, Math.min(gridH, ((s.launch - launches[0]) / (launches[launches.length - 1] - launches[0])) * gridH));
      svgEl("circle", {
        cx: x.toFixed(1), cy: y.toFixed(1), r: 2.2,
        fill: "var(--text, #fff)",
        opacity: 0.85,
      }, svg);
    }

    // Usual (median) point cross
    const medX = padL + Math.max(0, Math.min(gridW, ((medSpin - spins[0]) / (spins[spins.length - 1] - spins[0])) * gridW));
    const medY = padT + gridH - Math.max(0, Math.min(gridH, ((medLaunch - launches[0]) / (launches[launches.length - 1] - launches[0])) * gridH));
    svgEl("circle", {
      cx: medX.toFixed(1), cy: medY.toFixed(1), r: 4.5,
      fill: "none",
      stroke: "var(--text, #fff)",
      "stroke-width": 1.5,
    }, svg);

    // Y Axis labels (launch deg, 20, 15, 10, 6)
    for (const l of [20, 15, 10, 6]) {
      const rowIdx = launches.length - 1 - launches.indexOf(l);
      const y = padT + rowIdx * cellH + cellH / 2 + 4;
      const txt = svgEl("text", {
        x: padL - 6, y: y.toFixed(1),
        "text-anchor": "end",
        "font-size": 9,
        fill: "var(--muted, #888)",
      }, svg);
      txt.textContent = `${l}°`;
    }

    // X Axis labels (spin rpm, 1500, 2000, 2500, 3000, 3500, 4000)
    for (const sp of [1500, 2000, 2500, 3000, 3500, 4000]) {
      const colIdx = spins.indexOf(sp);
      if (colIdx >= 0) {
        const x = padL + colIdx * cellW + cellW / 2;
        const txt = svgEl("text", {
          x: x.toFixed(1), y: padT + gridH + 16,
          "text-anchor": "middle",
          "font-size": 9,
          fill: "var(--muted, #888)",
        }, svg);
        txt.textContent = sp >= 1000 ? `${(sp / 1000).toFixed(1)}k` : `${sp}`;
      }
    }

    // Axis titles
    const yTitle = svgEl("text", {
      x: padL, y: padT - 8,
      "text-anchor": "start",
      "font-size": 10,
      fill: "var(--text-2, #aaa)",
      "font-weight": 600,
    }, svg);
    yTitle.textContent = "Launch (°)";

    const xTitle = svgEl("text", {
      x: padL + gridW, y: padT + gridH + 28,
      "text-anchor": "end",
      "font-size": 10,
      fill: "var(--text-2, #aaa)",
      "font-weight": 600,
    }, svg);
    xTitle.textContent = "Spin (rpm)";

    return svg;
  }

  /**
   * Render the optimizer card in the UI.
   */
  function render(container, shots, club, opts = {}) {
    if (!container) return;
    container.replaceChildren();

    if (!isWoodOrDriver(club)) {
      container.hidden = true;
      return;
    }

    const opt = optimize(shots, club, opts);
    if (!opt.supported) {
      if (opt.reason) {
        container.hidden = false;
        const noteDiv = document.createElement("div");
        noteDiv.className = "opt-card note";
        noteDiv.textContent = opt.reason;
        container.appendChild(noteDiv);
      } else {
        container.hidden = true;
      }
      return;
    }

    container.hidden = false;

    const card = document.createElement("div");
    card.className = "opt-card";

    // Header
    const head = document.createElement("div");
    head.className = "opt-head";
    const title = document.createElement("h3");
    title.className = "opt-title";
    title.textContent = "The distance you're leaving (Optimizer)";
    head.appendChild(title);
    card.appendChild(head);

    // Summary sentence
    const sumEl = document.createElement("div");
    sumEl.className = "opt-summary";
    sumEl.textContent = opt.summary;
    card.appendChild(sumEl);

    // Heat grid container
    const gridBox = document.createElement("div");
    gridBox.className = "opt-grid-box";
    gridBox.appendChild(renderHeatGridSvg(opt));
    card.appendChild(gridBox);

    // Legend
    const legend = document.createElement("div");
    legend.className = "opt-legend note";
    legend.innerHTML = `
      <span class="opt-legend-item"><span class="opt-dot-user"></span> your shots</span>
      <span class="opt-legend-item"><span class="opt-circle-usual"></span> your usual</span>
      <span class="opt-legend-item"><span class="opt-ring-best"></span> optimal carry (${Math.round(opt.bestCell.carry)} yd)</span>
    `;
    card.appendChild(legend);

    // How it's worked out
    const fold = document.createElement("details");
    fold.className = "explain";
    const diffSign = opt.check.medianDiff > 0 ? "+" : "";
    fold.innerHTML = `
      <summary>How it's worked out</summary>
      <div class="note">
        <strong>Aerodynamic check:</strong> model carry tested against Square carry for your ${club} shots: median difference ${diffSign}${opt.check.medianDiff.toFixed(1)} yd (spread IQR ${opt.check.iqr.toFixed(1)} yd, n = ${opt.check.n}). Cards only show when the model matches Square within 4 yd at the median.<br><br>
        <strong>Search grid:</strong> calculated step by step using ball flight aerodynamics at your median ball speed (${Math.round(opt.medSpeed)} mph) across launch angles 6° to 20° and spin rates 1,500 to 4,000 rpm.<br><br>
        <strong>Achievable delivery:</strong> the optimal cell is strictly limited to launch and spin values within what you have actually hit with this club (widened by 2° launch and 500 rpm spin) to ensure the target is physically realistic with your swing.<br><br>
        <strong>Driver and woods only:</strong> irons and hybrids launch and spin for green-stopping control, while woods seek maximum carry distance.
      </div>
    `;
    card.appendChild(fold);

    container.appendChild(card);
  }

  const api = {
    isWoodOrDriver,
    checkCalibration,
    optimize,
    render,
    renderHeatGridSvg,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingOptimize = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
