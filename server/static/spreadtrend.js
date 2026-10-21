// server/static/spreadtrend.js
// Is each club's pattern getting tighter? (spread over time)
//
// Small multiples chart per club: each qualifying session's (>= 8 usable shots)
// left-to-right width (middle 80% of offline) and carry depth (middle 80% of carry).
// A verdict compares the latest 3 qualifying sessions' shots with the 3 before them
// (at least 20 shots each side) via a permutation test (500 iterations, p < 0.04).
//
// Works in the browser (window.SwingSpreadTrend) and in Node (module.exports).

(function (root) {
  const MIN_SESSION_SHOTS = 8;
  const MIN_VERDICT_SESSIONS = 6;
  const MIN_VERDICT_SHOTS = 20;
  const PERM_ITERATIONS = 500;
  const ALPHA = 0.04;

  const finite = v => typeof v === "number" && Number.isFinite(v);

  function rng(seed = 42) {
    let s = (seed >>> 0) || 42;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function quantile(sorted, q) {
    if (!sorted.length) return 0;
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  function span80(xs) {
    const s = xs.filter(finite).sort((a, b) => a - b);
    if (!s.length) return 0;
    return quantile(s, 0.9) - quantile(s, 0.1);
  }

  function bagOrder(clubs) {
    const CS = root.SwingClubSpread || (typeof require !== "undefined" ? require("./clubspread.js") : null);
    if (CS && typeof CS.bagOrder === "function") return CS.bagOrder(clubs);
    const G = root.SwingGapping || (typeof require !== "undefined" ? require("./gapping.js") : null);
    const uniq = [...new Set(clubs.filter(Boolean))];
    return G && typeof G.sortClubs === "function" ? G.sortClubs(uniq) : uniq.sort();
  }

  function isUsable(r) {
    const CS = root.SwingClubSpread || (typeof require !== "undefined" ? require("./clubspread.js") : null);
    if (CS && typeof CS.usable === "function") return CS.usable(r);
    if (!r || !finite(r.carry) || r.carry <= 0 || !finite(r.offline)) return false;
    const shot = r.c && r.c.shot;
    if (shot && shot.valid === false) return false;
    return true;
  }

  function permTest(g0Offline, g1Offline, g0Carry, g1Carry, K = PERM_ITERATIONS, seed = 42) {
    const r = rng(seed);
    const w0 = span80(g0Offline);
    const w1 = span80(g1Offline);
    const deltaObs = w1 - w0;
    const n0 = g0Offline.length, n1 = g1Offline.length;
    const pool = [...g0Offline, ...g1Offline];
    const N = pool.length;

    let countGe = 0;
    for (let k = 0; k < K; k++) {
      for (let i = 0; i < n1; i++) {
        const j = i + Math.floor(r() * (N - i));
        const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
      }
      const sample1 = pool.slice(0, n1);
      const sample0 = pool.slice(n1);
      const deltaStar = span80(sample1) - span80(sample0);
      if (Math.abs(deltaStar) >= Math.abs(deltaObs)) countGe++;
    }

    const p = (countGe + 1) / (K + 1);
    const d0 = g0Carry ? span80(g0Carry) : 0;
    const d1 = g1Carry ? span80(g1Carry) : 0;

    let verdict = "about the same";
    if (p < ALPHA) {
      verdict = deltaObs < 0 ? "tighter" : "wider";
    }

    return { verdict, p, w0, w1, deltaObs, d0, d1 };
  }

  function analyzeClub(sessions, opts = {}) {
    const club = opts.club || (sessions && sessions[0] && sessions[0].rows && sessions[0].rows[0] && sessions[0].rows[0].club) || "Club";
    const nameOf = opts.nameOf || (c => c);
    const name = nameOf(club);

    const sortedSessions = [...(sessions || [])].sort((a, b) => (a.start || 0) - (b.start || 0));

    const qualifying = [];
    let skippedSessions = 0;
    let allUsableShots = 0;

    for (const s of sortedSessions) {
      const rows = (s.rows || []).filter(r => (r.club ? r.club === club : true) && isUsable(r));
      allUsableShots += rows.length;
      if (rows.length < MIN_SESSION_SHOTS) {
        if (rows.length > 0) skippedSessions++;
        continue;
      }
      const off = rows.map(r => r.offline).sort((a, b) => a - b);
      const car = rows.map(r => r.carry).sort((a, b) => a - b);
      qualifying.push({
        key: s.key,
        start: s.start,
        n: rows.length,
        width: quantile(off, 0.9) - quantile(off, 0.1),
        depth: quantile(car, 0.9) - quantile(car, 0.1),
        medOffline: quantile(off, 0.5),
        medCarry: quantile(car, 0.5),
        shots: rows,
      });
    }

    const totalShots = qualifying.reduce((sum, s) => sum + s.n, 0);
    const enough = qualifying.length >= 1;

    let verdict = "not enough shots yet";
    let verdictText = "Not enough shots yet";
    let verdictClass = "st-v-na";
    let testResult = null;

    if (qualifying.length >= MIN_VERDICT_SESSIONS) {
      const latest3 = qualifying.slice(-3);
      const earlier3 = qualifying.slice(-6, -3);
      const latestShots = latest3.flatMap(s => s.shots);
      const earlierShots = earlier3.flatMap(s => s.shots);

      if (latestShots.length >= MIN_VERDICT_SHOTS && earlierShots.length >= MIN_VERDICT_SHOTS) {
        testResult = permTest(
          earlierShots.map(s => s.offline),
          latestShots.map(s => s.offline),
          earlierShots.map(s => s.carry),
          latestShots.map(s => s.carry),
          PERM_ITERATIONS,
          opts.seed != null ? opts.seed : 42
        );
        verdict = testResult.verdict;
        if (verdict === "tighter") {
          verdictText = `Tighter: ${testResult.w1.toFixed(0)} yd wide vs ${testResult.w0.toFixed(0)} yd earlier (p = ${testResult.p.toFixed(2)})`;
          verdictClass = "st-v-tight";
        } else if (verdict === "wider") {
          verdictText = `Wider: ${testResult.w1.toFixed(0)} yd wide vs ${testResult.w0.toFixed(0)} yd earlier (p = ${testResult.p.toFixed(2)})`;
          verdictClass = "st-v-wide";
        } else {
          verdictText = `About the same: ${testResult.w1.toFixed(0)} yd wide vs ${testResult.w0.toFixed(0)} yd earlier`;
          verdictClass = "st-v-same";
        }
      } else {
        verdictText = `Not enough shots yet (${latestShots.length} latest vs ${earlierShots.length} earlier, 20 needed each side)`;
      }
    } else if (qualifying.length > 0) {
      verdictText = `Not enough sessions yet (${qualifying.length} of 6 needed with 8+ shots)`;
    }

    const model = {
      club,
      name,
      sessions: qualifying,
      skippedSessions,
      totalShots,
      allUsableShots,
      enough,
      verdict,
      verdictText,
      verdictClass,
      test: testResult,
    };
    model.clubs = [model];
    return model;
  }

  function analyze(input, opts = {}) {
    if (!input) return { clubs: [] };

    // Case 1: object of club sessions: { [club]: sessions }
    if (!Array.isArray(input) && typeof input === "object") {
      const clubs = bagOrder(Object.keys(input));
      const clubModels = clubs.map(c => analyzeClub(input[c], { ...opts, club: c }));
      return { clubs: clubModels };
    }

    // Case 2: array of sessions
    const sessions = input;
    // Check if sessions contain multiple clubs across rows
    const allClubsSet = new Set();
    for (const s of sessions) {
      for (const r of (s.rows || [])) if (r.club) allClubsSet.add(r.club);
    }
    const allClubs = bagOrder([...allClubsSet]);

    if (allClubs.length > 1 && !opts.club) {
      const byClub = {};
      for (const c of allClubs) byClub[c] = [];
      for (const s of sessions) {
        const rowsByClub = {};
        for (const r of (s.rows || [])) {
          if (!r.club) continue;
          if (!rowsByClub[r.club]) rowsByClub[r.club] = [];
          rowsByClub[r.club].push(r);
        }
        for (const c of allClubs) {
          if (rowsByClub[c] && rowsByClub[c].length) {
            byClub[c].push({ ...s, rows: rowsByClub[c] });
          }
        }
      }
      const clubModels = allClubs.map(c => analyzeClub(byClub[c], { ...opts, club: c }));
      return { clubs: clubModels };
    }

    return analyzeClub(sessions, opts);
  }

  function hel(tag, attrs = {}, text = null) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    return e;
  }

  function renderChartSvg(c, cmap) {
    const W = 260, H = 140;
    const L = 32, R = 12, T = 12, B = 24;
    const PW = W - L - R, PH = H - T - B;

    const svg = hel("svg", {
      viewBox: `0 0 ${W} ${H}`,
      role: "img",
      "aria-label": `${c.name} spread over time`,
      class: "st-svg",
    });

    const pts = c.sessions;
    if (!pts || !pts.length) return svg;

    let maxVal = 30;
    for (const s of pts) {
      if (s.width > maxVal) maxVal = s.width;
      if (s.depth > maxVal) maxVal = s.depth;
    }
    const yMax = Math.ceil((maxVal * 1.15) / 10) * 10;

    const xPos = i => (pts.length === 1 ? L + PW / 2 : L + (i / (pts.length - 1)) * PW);
    const yPos = v => T + PH * (1 - Math.max(0, Math.min(yMax, v)) / yMax);

    // Y grid lines and labels at 0, yMax/2, yMax
    const yTicks = [0, yMax / 2, yMax];
    for (const yt of yTicks) {
      const y = yPos(yt);
      const line = hel("line", { x1: L, x2: W - R, y1: y, y2: y, stroke: "var(--line, #333)", "stroke-width": "0.75" });
      svg.appendChild(line);
      const txt = hel("text", { x: L - 4, y: y + 3, "text-anchor": "end", fill: "var(--muted, #888)", "font-size": "9" }, `${yt.toFixed(0)}`);
      svg.appendChild(txt);
    }

    // Color variable for this club
    const slot = (cmap && cmap[c.club] ? cmap[c.club].slot : 0) + 1;
    const color = `var(--cs${slot}, #3b82f6)`;

    // Width line (solid)
    if (pts.length > 1) {
      const wPoints = pts.map((s, i) => `${xPos(i).toFixed(1)},${yPos(s.width).toFixed(1)}`).join(" ");
      svg.appendChild(hel("polyline", { points: wPoints, fill: "none", stroke: color, "stroke-width": "2" }));

      // Depth line (dashed)
      const dPoints = pts.map((s, i) => `${xPos(i).toFixed(1)},${yPos(s.depth).toFixed(1)}`).join(" ");
      svg.appendChild(hel("polyline", { points: dPoints, fill: "none", stroke: color, "stroke-width": "1.75", "stroke-dasharray": "4 2", opacity: "0.75" }));
    }

    // Dots for each session
    pts.forEach((s, i) => {
      const x = xPos(i), yw = yPos(s.width), yd = yPos(s.depth);
      const dateStr = s.start ? new Date(s.start).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";

      // Width circle
      const circ = hel("circle", { cx: x.toFixed(1), cy: yw.toFixed(1), r: "3.5", fill: color });
      circ.appendChild(hel("title", {}, `${dateStr}: width ${s.width.toFixed(1)} yd (${s.n} shots)`));
      svg.appendChild(circ);

      // Depth square
      const rect = hel("rect", { x: (x - 3).toFixed(1), y: (yd - 3).toFixed(1), width: "6", height: "6", fill: color, opacity: "0.85" });
      rect.appendChild(hel("title", {}, `${dateStr}: depth ${s.depth.toFixed(1)} yd (${s.n} shots)`));
      svg.appendChild(rect);
    });

    // Date labels on X axis
    if (pts.length > 0) {
      const dFirst = pts[0].start ? new Date(pts[0].start).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
      svg.appendChild(hel("text", { x: L, y: H - 8, "text-anchor": "start", fill: "var(--muted, #888)", "font-size": "9" }, dFirst));
      if (pts.length > 1) {
        const dLast = pts[pts.length - 1].start ? new Date(pts[pts.length - 1].start).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
        svg.appendChild(hel("text", { x: W - R, y: H - 8, "text-anchor": "end", fill: "var(--muted, #888)", "font-size": "9" }, dLast));
      }
    }

    return svg;
  }

  function render(box, model, opts = {}) {
    if (!box) return;
    box.replaceChildren();

    const clubs = (model && model.clubs ? model.clubs : []).filter(c => c && c.enough);
    if (!clubs.length) {
      box.appendChild(hel("div", { class: "note" }, "No clubs with 8+ shots in a session yet to track spread over time."));
      return;
    }

    const head = hel("div", { class: "st-head" });
    head.appendChild(hel("strong", {}, "Is your pattern getting tighter?"));
    head.appendChild(hel("span", { class: "note" }, "Each session's middle 80% left-to-right width and carry depth over time"));
    box.appendChild(head);

    const legend = hel("div", { class: "st-legend" });
    const legWidth = hel("span", {});
    legWidth.innerHTML = `<svg width="22" height="10" style="vertical-align: middle; margin-right: 4px"><line x1="0" y1="5" x2="22" y2="5" stroke="currentColor" stroke-width="2"/></svg>Width (offline)`;
    const legDepth = hel("span", {});
    legDepth.innerHTML = `<svg width="22" height="10" style="vertical-align: middle; margin-right: 4px"><line x1="0" y1="5" x2="22" y2="5" stroke="currentColor" stroke-width="2" stroke-dasharray="4 2"/></svg>Depth (carry)`;
    legend.append(legWidth, legDepth);
    box.appendChild(legend);

    const cmap = opts.colors || (root.SwingClubSpread && root.SwingClubSpread.colors ? root.SwingClubSpread.colors(clubs.map(c => c.club)) : {});

    const grid = hel("div", { class: "st-grid" });
    for (const c of clubs) {
      const card = hel("div", { class: "st-card", "data-club": c.club });
      if (opts.hidden && opts.hidden.has(c.club)) card.style.display = "none";

      const slot = (cmap[c.club] ? cmap[c.club].slot : 0) + 1;
      card.style.setProperty("--c", `var(--cs${slot}, #3b82f6)`);

      const chead = hel("div", { class: "st-card-head" });
      const nameWrap = hel("div", { class: "st-card-name" });
      const sw = hel("span", { class: "st-sw" });
      nameWrap.append(sw, hel("strong", {}, c.name));
      const cnt = hel("span", { class: "st-count" }, `${c.sessions.length} session${c.sessions.length === 1 ? "" : "s"} · ${c.totalShots} shots`);
      chead.append(nameWrap, cnt);
      card.appendChild(chead);

      const verd = hel("div", { class: `st-verdict ${c.verdictClass}` }, c.verdictText);
      card.appendChild(verd);

      const chartSvg = renderChartSvg(c, cmap);
      card.appendChild(chartSvg);

      if (c.skippedSessions > 0) {
        card.appendChild(hel("div", { class: "st-card-note" }, `${c.skippedSessions} session${c.skippedSessions === 1 ? "" : "s"} with fewer than 8 shots left out`));
      }

      grid.appendChild(card);
    }
    box.appendChild(grid);

    const explain = hel("details", { class: "explain" });
    explain.appendChild(hel("summary", {}, "How it's worked out"));
    const expNote = hel("div", { class: "note" });
    expNote.textContent =
      "Each session needs at least 8 usable shots of that club. Middle 80% width leaves out each session's best and worst " +
      "tenth of shots both ways. The verdict compares the pooled shots of the latest 3 qualifying sessions with the 3 before them " +
      "(at least 20 shots each side), using a permutation test (500 random shuffles) to check whether the change in width is larger " +
      "than chance (p < 0.04, so a club that has not changed reads \"about the same\" at least 96 times in 100). Permutation testing makes no assumption that shot spreads follow a normal bell curve.";
    explain.appendChild(expNote);
    box.appendChild(explain);
  }

  const api = {
    MIN_SESSION_SHOTS,
    MIN_VERDICT_SESSIONS,
    MIN_VERDICT_SHOTS,
    PERM_ITERATIONS,
    span80,
    permTest,
    analyzeClub,
    analyze,
    render,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingSpreadTrend = api;
})(typeof window !== "undefined" ? window : globalThis);
