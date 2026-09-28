// Gapping on Progress: bag mapping across all clubs hit in the period.
//
// Shows each club in bag order (DR down to wedges, leaving out the putter) with its shot count,
// median carry, and middle 50% spread (25th-75th percentile).
// Between neighbouring clubs, the gap in median carry is shown, flagging overlaps (< 7 yd)
// and big gaps (> 20 yd).
// Mishits (no carry, or marked invalid by Square) are excluded so they don't drag down the medians.
// At least 5 shots are required to show a club's bar.
//
// Works in the browser (window.SwingGapping) and in Node (module.exports).
(function (root) {
  // Clubs with fewer than 5 valid shots don't have enough data for a reliable median.
  const MIN_SHOTS = 5;

  // Gapping thresholds between neighbouring clubs in median carry (yards).
  // Under 7 yd: clubs cover virtually the same distance, risking bag redundancy.
  const OVERLAP_YD = 7;
  // Over 20 yd: distance gap between adjacent clubs is too wide, leaving uncomfortable yardage gaps.
  const BIG_GAP_YD = 20;

  const finite = v => typeof v === "number" && Number.isFinite(v);

  const CLUB_NAMES = { DR: "Driver", PW: "PW", GW: "GW", SW: "SW", LW: "LW", PT: "Putter" };
  function defaultClubName(code) {
    if (!code) return "";
    if (CLUB_NAMES[code]) return CLUB_NAMES[code];
    const m = String(code).match(/^([WHI])(\d)$/i);
    return m ? `${m[2]}${{ W: " wood", H: " hybrid", I: " iron" }[m[1].toUpperCase()]}` : code;
  }

  /**
   * Numeric bag rank for ordering: DR (100), woods (200+), hybrids (300+),
   * irons (400+), wedges (500-530). Putter and empty return -1 (excluded).
   */
  function bagRank(code) {
    if (!code) return -1;
    const c = String(code).toUpperCase().trim();
    if (c === "PT" || c === "PUTTER") return -1;
    if (c === "DR" || c === "1W" || c === "DRIVER") return 100;
    // Woods: W3, 3W, etc.
    let m = c.match(/^(?:W(\d+)|(\d+)W)$/);
    if (m) return 200 + parseInt(m[1] || m[2], 10);
    // Hybrids: H3, 3H, etc.
    m = c.match(/^(?:H(\d+)|(\d+)H)$/);
    if (m) return 300 + parseInt(m[1] || m[2], 10);
    // Irons: I3..I9, 3I..9I
    m = c.match(/^(?:I(\d+)|(\d+)I)$/);
    if (m) return 400 + parseInt(m[1] || m[2], 10);
    // Wedges in bag order
    if (c === "PW" || c === "PITCHING") return 500;
    if (c === "GW" || c === "GAP" || c === "AW" || c === "UW") return 510;
    if (c === "SW" || c === "SAND") return 520;
    if (c === "LW" || c === "LOB") return 530;
    return 999;
  }

  /** Sort an array of club codes into bag order, omitting putters. */
  function sortClubs(clubs) {
    return [...new Set(clubs)]
      .filter(c => bagRank(c) >= 0)
      .sort((a, b) => bagRank(a) - bagRank(b));
  }

  /**
   * Whether a shot is a mishit: no carry reported (or carry <= 0), or Square marked it invalid.
   * Does NOT filter on smash, offline, or face impact.
   */
  function isMishit(shot) {
    if (!shot || typeof shot !== "object") return true;
    if (shot.valid === false || shot.isValid === false || shot.invalid === true) return true;
    const b = shot.ball;
    if (!b || typeof b !== "object") return true;
    if (b.valid === false || b.isValid === false || b.invalid === true) return true;
    const carry = b.carry;
    if (!finite(carry) || carry <= 0) return true;
    return false;
  }

  /** Returns valid carry distance in yards, or null if mishit / invalid. */
  function validCarry(shot) {
    if (isMishit(shot)) return null;
    return shot.ball.carry;
  }

  /** Linear interpolation quantile matching summary.js and goodshots.js. */
  function quantile(sorted, q) {
    if (!sorted || !sorted.length) return null;
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  /**
   * Summary stats for a list of valid carry distances.
   * If fewer than minShots (default 5): enough is false.
   */
  function clubStats(carries, minShots = MIN_SHOTS) {
    const valid = (carries || []).filter(finite);
    const n = valid.length;
    if (n < minShots) {
      return { n, enough: false, median: null, q25: null, q75: null, need: minShots };
    }
    const sorted = [...valid].sort((a, b) => a - b);
    return {
      n,
      enough: true,
      need: minShots,
      median: quantile(sorted, 0.5),
      q25: quantile(sorted, 0.25),
      q75: quantile(sorted, 0.75),
      min: sorted[0],
      max: sorted[sorted.length - 1],
    };
  }

  /**
   * Flag for gap in median carry between neighbouring clubs:
   * "overlap" if < 7 yd, "big gap" if > 20 yd, else null.
   */
  function gapFlag(gap) {
    if (gap == null || !finite(gap)) return null;
    if (gap < OVERLAP_YD) return "overlap";
    if (gap > BIG_GAP_YD) return "big gap";
    return null;
  }

  /**
   * Analyze swings across the period and compute bag gapping.
   * @param swings Array of swings/clips or swing rows
   * @param options { since, minShots, clubNameFn }
   * @returns { clubs: [ { club, name, n, totalShots, enough, median, q25, q75, gap, gapFlag } ], totalShots }
   */
  function analyze(swings, options = {}) {
    const since = options.since ?? -Infinity;
    const minShots = options.minShots ?? MIN_SHOTS;
    const nameFn = options.clubNameFn || root.clubName || defaultClubName;

    const clubCarries = {};
    const totalHits = {};

    for (const s of swings || []) {
      // Excluded swings don't count
      if (s.excluded || (s.c && s.c.excluded)) continue;

      // Period filter
      let t = s.t;
      if (t == null) {
        const rec = s.recorded || (s.c && s.c.recorded);
        if (rec) t = new Date(rec).getTime();
      }
      if (t != null && t < since) continue;

      const club = s.club || (s.shot && s.shot.club) || (s.c && s.c.shot && s.c.shot.club);
      if (!club || bagRank(club) < 0) continue; // Skip putter and unknown

      totalHits[club] = (totalHits[club] || 0) + 1;

      const shot = s.shot || (s.c && s.c.shot);
      let carry = null;
      if (shot) {
        carry = validCarry(shot);
      } else if (finite(s.carry) && s.carry > 0) {
        carry = s.carry;
      }

      if (carry != null) {
        (clubCarries[club] = clubCarries[club] || []).push(carry);
      }
    }

    const clubsInBag = sortClubs(Object.keys(totalHits));
    const resultClubs = clubsInBag.map(club => {
      const carries = clubCarries[club] || [];
      const stats = clubStats(carries, minShots);
      return {
        club,
        name: nameFn(club),
        ...stats,
        totalShots: totalHits[club],
        gap: null,
        gapFlag: null,
      };
    });

    // Compute gaps between neighbouring clubs in bag order
    for (let i = 0; i < resultClubs.length - 1; i++) {
      const cur = resultClubs[i];
      const next = resultClubs[i + 1];
      if (cur.enough && next.enough) {
        const diff = Math.round((cur.median - next.median) * 10) / 10;
        cur.gap = diff;
        cur.gapFlag = gapFlag(diff);
      }
    }

    const totalShots = Object.values(totalHits).reduce((sum, count) => sum + count, 0);
    return { clubs: resultClubs, totalShots };
  }

  function svgElem(tag, attrs, parent) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.append(el);
    return el;
  }

  /**
   * Render horizontal bar chart into container.
   * @param container DOM element (e.g. #p-gapping-chart)
   * @param analysis Result from analyze()
   * @param options { selectedClub, onSelectClub }
   */
  function render(container, analysis, options = {}) {
    if (!container) return;
    container.replaceChildren();

    const clubs = (analysis && analysis.clubs) || [];
    if (!clubs.length) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.style.padding = "16px 8px";
      empty.textContent = "No shots with carry in this period.";
      container.append(empty);
      return;
    }

    const W = Math.max(340, container.clientWidth || 600);
    const m = { l: 96, r: 84, t: 26, b: 34 };
    const rowH = 34;
    const H = m.t + clubs.length * rowH + m.b;

    // Determine yardage range
    const validPoints = clubs.filter(c => c.enough).flatMap(c => [c.q25, c.median, c.q75]);
    let minX = 50, maxX = 250;
    if (validPoints.length > 0) {
      const lo = Math.min(...validPoints), hi = Math.max(...validPoints);
      minX = Math.max(0, Math.floor((lo - 12) / 25) * 25);
      maxX = Math.ceil((hi + 18) / 25) * 25;
      if (maxX <= minX) maxX = minX + 50;
    }

    const sx = v => m.l + ((v - minX) / (maxX - minX)) * (W - m.l - m.r);
    const sy = i => m.t + i * rowH + rowH / 2;

    const svg = svgElem("svg", {
      viewBox: `0 0 ${W} ${H}`,
      role: "img",
      "aria-label": "Club gapping: carry distance and spread per club",
      style: "display: block; width: 100%; height: auto;",
    }, container);

    // X-axis ticks every 25 or 50 yd depending on span
    const span = maxX - minX;
    const step = span > 200 ? 50 : 25;
    for (let v = minX; v <= maxX; v += step) {
      const x = sx(v);
      svgElem("line", {
        x1: x, x2: x, y1: m.t, y2: H - m.b,
        stroke: "var(--line)", "stroke-width": 1,
      }, svg);
      const text = svgElem("text", {
        x: x, y: H - m.b + 18,
        "text-anchor": "middle", class: "t-axis", fill: "var(--muted)",
      }, svg);
      text.textContent = `${v} yd`;
    }

    // Top subtle axis line
    svgElem("line", {
      x1: m.l, x2: W - m.r, y1: m.t, y2: m.t,
      stroke: "var(--line)", "stroke-width": 1,
    }, svg);

    // Rows
    clubs.forEach((c, i) => {
      const y = sy(i);
      const isSelected = options.selectedClub && options.selectedClub === c.club;

      const rowG = svgElem("g", {
        class: "p-gap-row" + (isSelected ? " sel" : ""),
        tabindex: 0,
        role: "button",
        "aria-label": `${c.name}: ${c.enough ? `${Math.round(c.median)} yd carry` : "not enough shots yet"}`,
      }, svg);

      // Background hit rect
      const bg = svgElem("rect", {
        x: 0, y: y - rowH / 2, width: W, height: rowH,
        fill: isSelected ? "var(--sel)" : "transparent",
        class: "p-gap-bg", rx: 4,
      }, rowG);

      if (options.onSelectClub) {
        rowG.style.cursor = "pointer";
        rowG.onclick = () => options.onSelectClub(c.club);
        rowG.onkeydown = e => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            options.onSelectClub(c.club);
          }
        };
      }

      // Club label on left
      const labelText = svgElem("text", {
        x: m.l - 12, y: y + 4,
        "text-anchor": "end",
        class: "t-title",
        fill: isSelected ? "var(--accent)" : "var(--text)",
        "font-weight": isSelected ? "700" : "600",
      }, rowG);
      labelText.textContent = c.name;

      const countSpan = svgElem("tspan", {
        fill: "var(--muted)",
        "font-size": "11",
        "font-weight": "normal",
      }, labelText);
      countSpan.textContent = ` (${c.n})`;

      if (!c.enough) {
        // Not enough shots notice
        const notice = svgElem("text", {
          x: m.l + 8, y: y + 4,
          fill: "var(--muted)",
          "font-size": "12",
          "font-style": "italic",
        }, rowG);
        notice.textContent = `not enough shots yet (${c.n} of ${MIN_SHOTS})`;
      } else {
        // Middle 50% bar
        const x1 = sx(c.q25);
        const x2 = sx(c.q75);
        const barW = Math.max(3, x2 - x1);
        svgElem("rect", {
          x: x1, y: y - 7, width: barW, height: 14,
          fill: "var(--accent)", "fill-opacity": 0.35,
          stroke: "var(--accent)", "stroke-width": 1.2,
          rx: 3,
        }, rowG);

        // Median tick
        svgElem("line", {
          x1: sx(c.median), x2: sx(c.median),
          y1: y - 9, y2: y + 9,
          stroke: isSelected ? "var(--text)" : "var(--accent)",
          "stroke-width": 3,
          "stroke-linecap": "round",
        }, rowG);

        // Numeric readout at right margin
        const numText = svgElem("text", {
          x: W - m.r + 8, y: y + 4,
          fill: isSelected ? "var(--accent)" : "var(--text)",
          "font-size": "12",
          "font-weight": "600",
          "font-variant-numeric": "tabular-nums",
        }, rowG);
        numText.textContent = `${Math.round(c.median)} yd`;

        // Native tooltip
        const title = svgElem("title", {}, rowG);
        title.textContent = `${c.name}: median ${Math.round(c.median)} yd (middle 50%: ${Math.round(c.q25)}–${Math.round(c.q75)} yd) over ${c.n} shot${c.n === 1 ? "" : "s"}`;
      }

      // Divider and gap callout to next neighbouring club
      if (i < clubs.length - 1) {
        const yGap = m.t + (i + 1) * rowH;
        svgElem("line", {
          x1: m.l, x2: W - m.r, y1: yGap, y2: yGap,
          stroke: "var(--line)", "stroke-width": 0.6,
          "stroke-dasharray": "2,3",
        }, svg);

        if (c.gap != null) {
          const isOverlap = c.gapFlag === "overlap";
          const isBig = c.gapFlag === "big gap";
          const color = (isOverlap || isBig) ? "var(--warn)" : "var(--muted)";
          const weight = (isOverlap || isBig) ? "600" : "normal";
          const desc = isOverlap ? `${c.gap} yd (overlap)` : isBig ? `${c.gap} yd (big gap)` : `${c.gap} yd gap`;

          const gapText = svgElem("text", {
            x: W - m.r + 8, y: yGap + 4,
            fill: color, "font-size": "11",
            "font-weight": weight,
          }, svg);
          gapText.textContent = desc;

          // Connector line between the two medians along the gap divider
          const next = clubs[i + 1];
          if (next && next.enough) {
            const med1 = sx(c.median), med2 = sx(next.median);
            svgElem("line", {
              x1: Math.min(med1, med2), x2: Math.max(med1, med2),
              y1: yGap, y2: yGap,
              stroke: color, "stroke-width": 1.5,
              "stroke-opacity": isOverlap || isBig ? 0.9 : 0.45,
            }, svg);
          }
        }
      }
    });

    // Bottom axis line
    svgElem("line", {
      x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b,
      stroke: "var(--line)", "stroke-width": 1,
    }, svg);
  }

  const api = {
    MIN_SHOTS,
    OVERLAP_YD,
    BIG_GAP_YD,
    bagRank,
    sortClubs,
    isMishit,
    validCarry,
    quantile,
    clubStats,
    gapFlag,
    analyze,
    render,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingGapping = api;
})(typeof window !== "undefined" ? window : globalThis);
