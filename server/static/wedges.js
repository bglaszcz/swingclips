// Wedge matrix on Progress: how far each wedge carries with a half, three-quarter and full swing.
//
// Swing size is club speed as a share of that wedge's full-swing speed (Square's club speed, on every
// shot; the body tracking's backswing numbers are down the line only and often shaky). A wedge's full
// speed is the 90th percentile of its club speed over all its shots, once there are 10. Mishits (no
// carry, or marked invalid by Square) are left out as in gapping.js. Each cell: median carry, middle
// 50% and shot count, with 3 shots or more. Under it, the biggest carry hole between the cells.
//
// Works in the browser (window.SwingWedges) and in Node (module.exports).
(function (root) {
  const Gapping = root.SwingGapping || (typeof require !== "undefined" && require("./gapping.js"));

  // A wedge's full-swing speed needs this many shots with a club speed (all history).
  const MIN_SPEED_SHOTS = 10;
  // Its full speed: the 90th percentile, so the odd over-swing doesn't set it.
  const FULL_QUANTILE = 0.9;
  // Swing sizes by share of full speed. Stock wedge swings land about 92%+ (full), 80-92% (three
  // quarter, hands to shoulder) and 65-80% (half, hands to hip); under 65% is a chip or a mishit.
  const SIZES = [["half", "Half", 0.65], ["threeq", "3/4", 0.80], ["full", "Full", 0.92]];
  // A cell's median needs this many shots.
  const MIN_CELL = 3;

  const finite = v => typeof v === "number" && Number.isFinite(v);
  const isWedge = club => { const r = Gapping.bagRank(club); return r >= 500 && r < 600; };

  /** The size of a swing from its share of full speed: "half" | "threeq" | "full" | null (a chip). */
  function sizeOf(share) {
    if (!finite(share)) return null;
    let out = null;
    for (const [key, , from] of SIZES) if (share >= from - 1e-9) out = key;
    return out;
  }

  /** A wedge's full-swing speed from its club speeds, or null with fewer than MIN_SPEED_SHOTS. */
  function fullSpeed(speeds) {
    const v = speeds.filter(finite).sort((a, b) => a - b);
    return v.length < MIN_SPEED_SHOTS ? null : Gapping.quantile(v, FULL_QUANTILE);
  }

  /** A row's club, time, carry (null for a mishit) and club speed. */
  function shotOf(r) {
    const shot = r.shot || (r.c && r.c.shot);
    const club = r.club || (shot && shot.club);
    let t = r.t;
    if (t == null) { const rec = r.recorded || (r.c && r.c.recorded); if (rec) t = new Date(rec).getTime(); }
    const carry = shot ? Gapping.validCarry(shot) : finite(r.carry) && r.carry > 0 ? r.carry : null;
    const speed = finite(r.clubSpeed) ? r.clubSpeed : shot && shot.clubData && finite(shot.clubData.speed) ? shot.clubData.speed : null;
    return { club, t, carry, speed, excluded: r.excluded || (r.c && r.c.excluded) };
  }

  /**
   * The largest gap between neighbouring medians when every cell with enough shots is sorted by
   * carry: {from: cell, to: cell, gap} or null with fewer than 3 such cells.
   */
  function biggestHole(cells) {
    const ok = cells.filter(c => c.enough).sort((a, b) => a.median - b.median);
    if (ok.length < 3) return null;
    let best = null;
    for (let i = 1; i < ok.length; i++) {
      const gap = ok[i].median - ok[i - 1].median;
      if (!best || gap > best.gap) best = { from: ok[i - 1], to: ok[i], gap };
    }
    return best;
  }

  /**
   * @param rows swing rows (trends.js swingRow) or clips with .shot
   * @param options {since (ms): the period's start, for the cells; the full speed uses all rows; clubNameFn}
   * @returns {wedges: [{club, name, fullSpeed, speedShots, shots, cells: {half, threeq, full}}], hole, shots}
   *   where a cell is {club, name, size, label, n, enough, median, q25, q75}
   */
  function analyze(rows, options = {}) {
    const since = options.since ?? -Infinity;
    const nameFn = options.clubNameFn || root.clubName || (c => c);
    const byClub = {};
    for (const r of rows || []) {
      const s = shotOf(r);
      if (s.excluded || !s.club || !isWedge(s.club)) continue;
      (byClub[s.club] = byClub[s.club] || []).push(s);
    }
    const wedges = Gapping.sortClubs(Object.keys(byClub)).map(club => {
      const all = byClub[club].filter(s => s.carry != null);
      const full = fullSpeed(all.map(s => s.speed));
      const inPeriod = all.filter(s => s.t == null || s.t >= since);
      const cells = {};
      for (const [key, label] of SIZES) {
        const carries = full == null ? [] : inPeriod.filter(s => finite(s.speed) && sizeOf(s.speed / full) === key).map(s => s.carry);
        const st = Gapping.clubStats(carries, MIN_CELL);
        cells[key] = { club, name: nameFn(club), size: key, label, n: st.n, enough: st.enough, median: st.median, q25: st.q25, q75: st.q75 };
      }
      return { club, name: nameFn(club), fullSpeed: full, speedShots: all.filter(s => finite(s.speed)).length,
               shots: inPeriod.length, cells };
    });
    const hole = biggestHole(wedges.flatMap(w => Object.values(w.cells)));
    return { wedges, hole, shots: wedges.reduce((n, w) => n + w.shots, 0) };
  }

  /** The hole in words, or "". */
  function holeText(hole) {
    if (!hole) return "";
    const at = c => `${Math.round(c.median)} yd (${c.name} ${c.label.toLowerCase()})`;
    return `Biggest hole: ${at(hole.from)} to ${at(hole.to)}: ${Math.round(hole.gap)} yd with no stock shot.`;
  }

  /** The table into `box` (browser). */
  function render(box, a) {
    const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});
    if (!a.wedges.length) { box.replaceChildren(el("div", "muted", "No wedge shots in this period.")); return; }
    const table = el("table", "p-wedges");
    const head = el("tr");
    head.append(el("th", null, ""), ...SIZES.map(([, label]) => el("th", null, label)));
    table.append(head);
    for (const w of a.wedges) {
      const tr = el("tr");
      tr.append(el("th", null, w.name));
      if (w.fullSpeed == null) {
        const td = el("td", "muted", `Not enough shots to know your full speed yet (${w.speedShots} of ${MIN_SPEED_SHOTS})`);
        td.colSpan = SIZES.length;
        tr.append(td);
      } else {
        for (const [key] of SIZES) {
          const c = w.cells[key], td = el("td");
          if (c.enough) {
            td.append(el("b", null, `${Math.round(c.median)} yd`),
              el("div", "p-wedge-sub", `${Math.round(c.q25)}–${Math.round(c.q75)} · ${c.n} shots`));
          } else {
            td.append(el("b", "muted", "–"), el("div", "p-wedge-sub", `${c.n} shot${c.n === 1 ? "" : "s"}`));
          }
          tr.append(td);
        }
      }
      table.append(tr);
    }
    const kids = [table];
    const text = holeText(a.hole);
    if (text) kids.push(el("div", "p-wedge-hole", text));
    box.replaceChildren(...kids);
  }

  const api = { MIN_SPEED_SHOTS, FULL_QUANTILE, SIZES, MIN_CELL, sizeOf, fullSpeed, biggestHole, analyze, holeText, render };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingWedges = api;
})(typeof window !== "undefined" ? window : globalThis);
