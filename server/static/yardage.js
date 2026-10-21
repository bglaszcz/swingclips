// Yardage card (Tools > Yardage card): the numbers a golfer takes to the sim to pick a club.
// One row per club in bag order, over a period the owner picks (default 90 days):
// stock carry, carry window (middle 80%), offline window (middle 80%), centre and aim,
// usual ball flight shape, apex and landing angle medians, and neighbouring window overlaps.
//
// Works in the browser (window.SwingYardage) and in Node (module.exports).
(function (root) {
  const MIN_SHOTS = 5;       // carry and offline windows, centre and aim need this many shots
  const MIN_FLIGHT_SHOTS = 10; // usual ball flight needs 10+ shots
  const AIM_OFF_THRESH = 3;  // aim advice only when centre is more than 3 yd off line
  const BOOT_ITERS = 500;    // bootstrap iterations for median offline 90% confidence interval

  const finite = v => typeof v === "number" && Number.isFinite(v);

  const ClubSpread = () => root.SwingClubSpread || (typeof require !== "undefined" ? require("./clubspread.js") : null);
  const FlightGrid = () => root.SwingFlightGrid || (typeof require !== "undefined" ? require("./flightgrid.js") : null);
  const Gapping = () => root.SwingGapping || (typeof require !== "undefined" ? require("./gapping.js") : null);

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  const sorted = xs => xs.filter(finite).sort((a, b) => a - b);

  function makeRng(seed) {
    if (seed == null) return Math.random;
    let s = (seed >>> 0) || 123456789;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (t >>> 0) / 4294967296;
    };
  }

  /** Words for offline yards: "4 yd left", "3 yd right", "on the line". */
  function sideWords(v) {
    const CS = ClubSpread();
    if (CS && typeof CS.sideWords === "function") return CS.sideWords(v);
    if (!finite(v)) return "–";
    const a = Math.abs(v);
    if (a < 0.5) return "on the line";
    return `${a.toFixed(0)} yd ${v < 0 ? "left" : "right"}`;
  }

  /** Whether a row is a usable shot with a landing spot. */
  function usable(r) {
    const CS = ClubSpread();
    if (CS && typeof CS.usable === "function") return CS.usable(r);
    if (!r || !finite(r.carry) || r.carry <= 0 || !finite(r.offline)) return false;
    const shot = r.c && r.c.shot;
    const G = Gapping();
    return !(shot && G && G.isMishit(shot));
  }

  /** Clubs in bag order (driver first, putter left out). */
  function bagOrder(clubs) {
    const CS = ClubSpread();
    if (CS && typeof CS.bagOrder === "function") return CS.bagOrder(clubs);
    const G = Gapping();
    const uniq = [...new Set(clubs.filter(Boolean))];
    return G && typeof G.sortClubs === "function" ? G.sortClubs(uniq) : uniq.sort();
  }

  /**
   * 90% bootstrap confidence interval of the median: resamples vals B times with replacement.
   * Returns [ciLo, ciHi] or null if n < MIN_SHOTS.
   */
  function bootstrapMedianCi(vals, iters = BOOT_ITERS, rng = Math.random) {
    const n = vals.length;
    if (n < MIN_SHOTS) return null;
    const medians = new Float64Array(iters);
    const sample = new Float64Array(n);
    for (let b = 0; b < iters; b++) {
      for (let i = 0; i < n; i++) {
        sample[i] = vals[Math.floor(rng() * n)];
      }
      sample.sort();
      medians[b] = quantile(sample, 0.5);
    }
    medians.sort();
    return [quantile(medians, 0.05), quantile(medians, 0.95)];
  }

  /**
   * Where to aim so the pattern's centre sits on the target ("aim 6 yd right").
   * Only when centre is > 3 yd off line AND its 90% bootstrap interval leaves out zero;
   * else "at the target".
   */
  function determineAim(offlineVals, centre, opts = {}) {
    if (!finite(centre) || Math.abs(centre) <= AIM_OFF_THRESH || offlineVals.length < MIN_SHOTS) {
      return { text: "at the target", yards: 0, direction: null, leavesOutZero: false, ci: null };
    }
    const rng = opts.rng || makeRng(opts.seed);
    const iters = opts.bootIters || BOOT_ITERS;
    const ci = bootstrapMedianCi(offlineVals, iters, rng);
    if (!ci) {
      return { text: "at the target", yards: 0, direction: null, leavesOutZero: false, ci: null };
    }
    const [lo, hi] = ci;
    const leavesOutZero = (lo > 0 && hi > 0) || (lo < 0 && hi < 0);
    if (!leavesOutZero) {
      return { text: "at the target", yards: 0, direction: null, leavesOutZero: false, ci };
    }
    const yd = Math.round(Math.abs(centre));
    // If centre is left (negative), golfer misses left, so they must aim right to centre the pattern.
    // If centre is right (positive), golfer misses right, so they must aim left.
    const direction = centre < 0 ? "right" : "left";
    const text = `aim ${yd} yd ${direction}`;
    return { text, yards: yd, direction, leavesOutZero: true, ci };
  }

  /**
   * Most common flight shape from SwingFlightGrid.classify and its percentage share (10+ shots).
   */
  function determineShape(rows, opts = {}) {
    const FG = FlightGrid();
    if (!FG || typeof FG.classify !== "function") return { name: null, count: 0, total: 0, pct: null, text: "" };
    const counts = {};
    let total = 0;
    for (const r of rows) {
      // Support direction on r or r.c.shot.ball.hla
      const b = (r.c && r.c.shot && r.c.shot.ball) || (r.shot && r.shot.ball) || r.ball || {};
      const dir = finite(r.direction) ? r.direction : (finite(b.hla) ? b.hla : null);
      const rowForClassify = { ...r, direction: dir };
      const cl = FG.classify(rowForClassify, { leftHanded: opts.leftHanded });
      if (cl && cl.name) {
        counts[cl.name] = (counts[cl.name] || 0) + 1;
        total++;
      }
    }
    if (total < MIN_FLIGHT_SHOTS) {
      return { name: null, count: 0, total, pct: null, text: "" };
    }
    let topName = null, topCount = -1;
    for (const [name, cnt] of Object.entries(counts)) {
      if (cnt > topCount) {
        topCount = cnt;
        topName = name;
      }
    }
    const pct = Math.round((topCount / total) * 100);
    const text = `${topName} (${pct}%)`;
    return { name: topName, count: topCount, total, pct, text };
  }

  /**
   * Builds the Yardage card model from swing rows.
   * `rows`: array of swing rows.
   * `opts`: { period: 90, nameOf: c => c, leftHanded: false, now: timestamp, seed: number }
   */
  function build(rows, opts = {}) {
    const periodDays = opts.period != null ? Number(opts.period) : 90;
    const nameOf = typeof opts.nameOf === "function" ? opts.nameOf : (c => c);

    // Filter usable rows
    const usableRows = (rows || []).filter(usable).filter(r => !!r.club);

    // Determine cutoff timestamp from the data's latest date (not today's clock, respecting house rule)
    let maxDate = -Infinity;
    if (opts.now != null) {
      maxDate = opts.now;
    } else {
      for (const r of usableRows) {
        const t = r.t || (r.c && new Date(r.c.recorded).getTime()) || 0;
        if (t > maxDate) maxDate = t;
      }
      if (!Number.isFinite(maxDate) || maxDate <= 0) maxDate = Date.now();
    }
    const since = periodDays > 0 ? maxDate - periodDays * 86400000 : -Infinity;

    // Filter by period
    const periodRows = usableRows.filter(r => {
      const t = r.t || (r.c && new Date(r.c.recorded).getTime()) || 0;
      return t >= since;
    });

    // Group by club
    const byClub = {};
    for (const r of periodRows) {
      (byClub[r.club] = byClub[r.club] || []).push(r);
    }

    const clubsInOrder = bagOrder(Object.keys(byClub));
    const clubModels = [];

    for (const club of clubsInOrder) {
      const cRows = byClub[club];
      const n = cRows.length;
      const carries = sorted(cRows.map(r => r.carry));
      const offlines = sorted(cRows.map(r => r.offline));

      const stockCarry = quantile(carries, 0.5);
      const carryLo = n >= MIN_SHOTS ? quantile(carries, 0.1) : null;
      const carryHi = n >= MIN_SHOTS ? quantile(carries, 0.9) : null;

      const offlineLo = n >= MIN_SHOTS ? quantile(offlines, 0.1) : null;
      const offlineHi = n >= MIN_SHOTS ? quantile(offlines, 0.9) : null;
      const centre = n >= MIN_SHOTS ? quantile(offlines, 0.5) : quantile(offlines, 0.5);

      const aim = determineAim(offlines, centre, opts);
      const usualShape = determineShape(cRows, opts);

      // Apex and landing angle medians (from Square's ball.apexFt / ball.landingAngle)
      const apexes = [];
      const landingAngles = [];
      for (const r of cRows) {
        const b = (r.c && r.c.shot && r.c.shot.ball) || (r.shot && r.shot.ball) || r.ball || {};
        const ap = finite(r.apexFt) ? r.apexFt : (finite(b.apexFt) ? b.apexFt : null);
        const la = finite(r.landingAngle) ? r.landingAngle : (finite(b.landingAngle) ? b.landingAngle : null);
        if (finite(ap)) apexes.push(ap);
        if (finite(la)) landingAngles.push(la);
      }
      const apexFt = apexes.length ? quantile(sorted(apexes), 0.5) : null;
      const landingAngle = landingAngles.length ? quantile(sorted(landingAngles), 0.5) : null;

      clubModels.push({
        club,
        name: nameOf(club),
        n,
        enough: n >= MIN_SHOTS,
        stockCarry,
        carryLo,
        carryHi,
        offlineLo,
        offlineHi,
        centre,
        aim,
        usualShape,
        apexFt,
        landingAngle,
        rows: cRows,
      });
    }

    // Overlap detection: when two neighbouring clubs in bag order have carry windows that overlap
    // by more than half of the shorter window.
    const overlaps = [];
    const withWindow = clubModels.filter(c => c.enough && c.carryLo != null && c.carryHi != null);
    for (let i = 0; i < withWindow.length - 1; i++) {
      const a = withWindow[i], b = withWindow[i + 1];
      const wA = a.carryHi - a.carryLo;
      const wB = b.carryHi - b.carryLo;
      if (wA > 0 && wB > 0) {
        const ovSpan = Math.max(0, Math.min(a.carryHi, b.carryHi) - Math.max(a.carryLo, b.carryLo));
        const shorter = Math.min(wA, wB);
        if (ovSpan > 0.5 * shorter) {
          const text = `Your ${a.name} and ${b.name} land in the same window: ${a.carryLo.toFixed(0)}-${a.carryHi.toFixed(0)} and ${b.carryLo.toFixed(0)}-${b.carryHi.toFixed(0)} yd`;
          overlaps.push({ clubA: a.club, clubB: b.club, nameA: a.name, nameB: b.name, text, span: ovSpan });
        }
      }
    }

    return {
      period: periodDays,
      totalShots: periodRows.length,
      clubs: clubModels,
      overlaps,
    };
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /**
   * Renders the Yardage card into `box`.
   * `opts`: { onPeriod: days => {}, colors: {}, nameOf: c => c }
   */
  function render(box, model, opts = {}) {
    box.replaceChildren();

    // Controls bar: Period picker and summary
    const toolbar = el("div", "y-toolbar");
    const label = el("label", "y-period-label");
    label.append(document.createTextNode("Period "));
    const select = el("select", "y-period-select");
    const periods = [
      { val: "30", label: "Last 30 days" },
      { val: "90", label: "Last 90 days" },
      { val: "365", label: "Last year" },
      { val: "0", label: "All" },
    ];
    for (const p of periods) {
      const opt = el("option", null, p.label);
      opt.value = p.val;
      if (String(model.period) === p.val) opt.selected = true;
      select.appendChild(opt);
    }
    if (typeof opts.onPeriod === "function") {
      select.addEventListener("change", () => opts.onPeriod(select.value));
    }
    label.appendChild(select);
    toolbar.appendChild(label);

    const summary = el("span", "y-summary note", `${model.clubs.length} club${model.clubs.length === 1 ? "" : "s"} · ${model.totalShots} shot${model.totalShots === 1 ? "" : "s"} in this period`);
    toolbar.appendChild(summary);
    box.appendChild(toolbar);

    if (!model.clubs.length) {
      box.appendChild(el("p", "note", "No shots to show in this period."));
      return;
    }

    // Yardage table
    const wrap = el("div", "y-table-wrap");
    const tbl = el("table", "a-table y-table");
    const thead = el("thead");
    const htr = el("tr");
    const headers = [
      "Club",
      "Shots",
      "Stock carry",
      "Carry window",
      "Left / right",
      "Centre",
      "Aim",
      "Usual shape",
      "Apex",
      "Landing",
    ];
    for (const h of headers) htr.appendChild(el("th", null, h));
    thead.appendChild(htr);
    tbl.appendChild(thead);

    const tbody = el("tbody");
    const cmap = opts.colors || (typeof SwingClubSpread !== "undefined" ? SwingClubSpread.colors(model.clubs.map(c => c.club)) : null);

    for (const c of model.clubs) {
      const tr = el("tr");

      // Club name with swatch if colors available
      const tdClub = el("td", "y-club-cell");
      if (cmap && cmap[c.club]) {
        const sw = el("i", "cs-sw" + (cmap[c.club].alt ? " alt" : ""));
        sw.style.setProperty("--c", `var(--club-${cmap[c.club].slot})`);
        tdClub.appendChild(sw);
      }
      tdClub.appendChild(document.createTextNode(c.name));
      tr.appendChild(tdClub);

      // Shots
      tr.appendChild(el("td", c.enough ? null : "dim", `${c.n}`));

      // Stock carry
      tr.appendChild(el("td", null, c.stockCarry != null ? `${c.stockCarry.toFixed(0)} yd` : "—"));

      // Carry window (middle 80%)
      if (c.enough && c.carryLo != null && c.carryHi != null) {
        tr.appendChild(el("td", null, `${c.carryLo.toFixed(0)}–${c.carryHi.toFixed(0)} yd`));
      } else {
        tr.appendChild(el("td", "dim", "needs 5 shots"));
      }

      // Left / right (middle 80%)
      if (c.enough && c.offlineLo != null && c.offlineHi != null) {
        tr.appendChild(el("td", null, `${sideWords(c.offlineLo)} to ${sideWords(c.offlineHi)}`));
      } else {
        tr.appendChild(el("td", "dim", "–"));
      }

      // Centre
      if (c.enough && c.centre != null) {
        tr.appendChild(el("td", null, sideWords(c.centre)));
      } else {
        tr.appendChild(el("td", "dim", "–"));
      }

      // Aim
      tr.appendChild(el("td", c.aim.leavesOutZero ? "y-aim-bias" : null, c.aim.text));

      // Usual shape
      tr.appendChild(el("td", c.usualShape.text ? null : "dim", c.usualShape.text || "—"));

      // Apex (blank when Square gave none)
      tr.appendChild(el("td", null, c.apexFt != null ? `${c.apexFt.toFixed(0)} ft` : ""));

      // Landing angle (blank when Square gave none)
      tr.appendChild(el("td", null, c.landingAngle != null ? `${c.landingAngle.toFixed(0)}°` : ""));

      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    box.appendChild(wrap);

    // Overlaps under the table
    if (model.overlaps.length > 0) {
      const ovBox = el("div", "y-overlaps");
      for (const ov of model.overlaps) {
        ovBox.appendChild(el("p", "y-overlap-item note", ov.text));
      }
      box.appendChild(ovBox);
    }

    // How it's worked out fold
    const fold = el("details", "fold y-fold");
    const summaryEl = el("summary", null, "How it's worked out");
    const foldBody = el("div", "note");
    foldBody.innerHTML = `
      <p>The yardage card brings the numbers you need on the sim mat together on one card, in bag order:</p>
      <ul>
        <li><strong>Stock carry:</strong> the median carry distance across your usable shots in the period.</li>
        <li><strong>Carry window:</strong> the middle 80% of carry (10th to 90th percentile), leaving out the 10% shortest and 10% longest shots. Needs at least 5 shots.</li>
        <li><strong>Left / right:</strong> the middle 80% of offline dispersion. Left is negative, right is positive.</li>
        <li><strong>Centre:</strong> where your pattern is centred (median offline distance).</li>
        <li><strong>Aim:</strong> where to aim so the pattern's centre sits on the target. If your centre is more than 3 yd off line and a 90% bootstrap confidence interval leaves out zero (confirming the bias is not random chance), it suggests aiming opposite to cancel out the miss; otherwise "at the target".</li>
        <li><strong>Usual shape:</strong> the most common of the nine ball flights (start line and sideways curve) and its percentage share, shown when a club has 10+ shots.</li>
        <li><strong>Apex & landing angle:</strong> median peak height (ft) and descent landing angle (degrees) reported by Square Golf. Left blank when not recorded.</li>
        <li><strong>Overlap:</strong> flagged under the table when two neighbouring clubs in bag order have carry windows overlapping by more than half of the shorter window.</li>
      </ul>
    `;
    fold.append(summaryEl, foldBody);
    box.appendChild(fold);
  }

  const api = {
    MIN_SHOTS,
    MIN_FLIGHT_SHOTS,
    AIM_OFF_THRESH,
    BOOT_ITERS,
    usable,
    bagOrder,
    sideWords,
    bootstrapMedianCi,
    determineAim,
    determineShape,
    build,
    render,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingYardage = api;
})(typeof window !== "undefined" ? window : globalThis);
