// The 4-week ball plan (server ballplan.py, GET /api/ballplan) drawn for the Start page, Progress and the
// Week brief: today's session with its Start buttons, this week's sessions, and the scoreboard (each
// number so far against where it started and its target, and whether the change beats chance).
// The server does the sums; this only draws them.
//
// Works in the browser (window.SwingBallPlan) and in Node (module.exports).
(function (root) {
  const finite = v => typeof v === "number" && Number.isFinite(v);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = v => finite(v) ? `${Math.round(v)}%` : "–";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  /** "2026-10-22" -> "Oct 22". */
  function day(iso) {
    if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return String(iso || "");
    return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
  }
  /** Strokes a shot against tour, signed: "-0.20". */
  const sg = v => finite(v) ? (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2) : "–";

  const VERDICT = {
    better: "Better than at the start",
    worse: "Worse than at the start",
    same: "Can't tell yet",
    early: "Too early to tell",
  };

  const CSS = `
  .bp-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; }
  .bp-head strong { font-size: 16px; }
  .bp-muted { color: var(--muted); font-size: 13px; }
  .bp-steps { display: flex; flex-direction: column; gap: 8px; margin: 10px 0; padding: 0; list-style: none; }
  .bp-step { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--line);
    border-radius: 10px; background: var(--panel-2); }
  .bp-step .bp-n { flex: none; width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center;
    font-size: 12px; font-weight: 700; border: 1px solid var(--line); background: var(--panel); }
  .bp-step.done .bp-n { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
  .bp-step .bp-text { flex: 1 1 auto; min-width: 0; }
  .bp-step .bp-state { font-size: 13px; font-weight: 600; color: var(--accent); white-space: nowrap; }
  .bp-step button { flex: none; }
  .bp-board { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; margin-top: 10px; }
  .bp-tile { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: var(--panel);
    display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .bp-tile .bp-label { font-weight: 700; font-size: 14px; }
  .bp-tile .bp-big { font-size: 28px; font-weight: 800; line-height: 1.1; font-variant-numeric: tabular-nums; }
  .bp-tile .bp-big small { font-size: 13px; font-weight: 600; color: var(--muted); margin-left: 4px; }
  .bp-bar { position: relative; height: 8px; border-radius: 4px; background: var(--panel-2); border: 1px solid var(--line); }
  .bp-bar .bp-fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 4px; background: var(--muted); opacity: 0.55; }
  .bp-bar .bp-tick { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--muted); }
  .bp-bar .bp-tick.target { background: var(--accent); width: 3px; }
  .bp-chip { align-self: flex-start; font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 999px;
    background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); }
  .bp-chip.better { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
  .bp-chip.worse { background: var(--warn-soft); color: var(--bad); border-color: transparent; }
  .bp-info { margin: 10px 0 0; padding-left: 18px; font-size: 13px; color: var(--muted); }
  .bp-info b { color: var(--text); font-weight: 600; }
  .bp-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 10px; font-variant-numeric: tabular-nums; }
  .bp-table th, .bp-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  .bp-table th { color: var(--muted); font-weight: 600; }
  .bp-table tr.now td { font-weight: 700; }
  .bp-scroll { overflow-x: auto; }
  .bp-check { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; margin-top: 10px; align-items: start; }
  .bp-check > div { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; min-width: 0; }
  .bp-check .bp-well { background: var(--accent-soft); border-color: transparent; }
  .bp-check .bp-hard { background: var(--warn-soft); border-color: transparent; }
  .bp-check h4 { margin: 0 0 6px; font-size: 14px; }
  .bp-check ul { margin: 0; padding-left: 18px; font-size: 13px; }
  .bp-check li + li { margin-top: 6px; }
  .bp-check .bp-sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .bp-why { font-size: 12px; color: var(--muted); margin-top: 3px; }
  `;

  /** Adds the plan's styles to the page once (both pages share these colour names). */
  function injectStyles(doc) {
    if (!doc || doc.getElementById("bp-styles")) return;
    const st = doc.createElement("style");
    st.id = "bp-styles";
    st.textContent = CSS;
    doc.head.appendChild(st);
  }

  const mainNumbers = m => (m && m.numbers || []).filter(n => n.target != null);
  const infoNumbers = m => (m && m.numbers || []).filter(n => n.target == null);

  /** "Week 2 of 4 · Oct 29 to Nov 4", or when it starts / ended. */
  function weekLine(m) {
    const p = m && m.plan;
    if (!p) return "";
    if (!p.started) return `Starts ${day(p.start)}, ${p.weeks} weeks to ${day(p.end)}`;
    if (p.ended) return `Ended ${day(p.end)}`;
    const w = (m.weeks || [])[p.week - 1];
    return `Week ${p.week} of ${p.weeks}` + (w ? ` · ${day(w.from)} to ${day(w.to)}` : "");
  }

  /** "Practice days 1 of 2 · test day 0 of 1" for the week in play. */
  function sessionsLine(m) {
    const p = m && m.plan;
    const w = p && p.week ? (m.weeks || [])[p.week - 1] : null;
    if (!w) return "";
    const need = p.need || {};
    return `This week: practice days ${w.practice} of ${need.practice ?? 2} · test day ${w.test} of ${need.test ?? 1}`;
  }

  /** Today's session: its title and steps, each with a Start button, Running, or Done. */
  function todayHtml(m) {
    if (!m || !m.plan) return "";
    const t = m.today;
    if (!t) {
      return `<div class="bp-head"><strong>${esc(m.plan.name)}</strong><span class="bp-muted">${esc(weekLine(m))}</span></div>`;
    }
    const steps = t.steps.map((s, i) => {
      let right = "";
      if (s.running) right = `<span class="bp-state">● Running</span>`;
      else if (s.done) right = `<span class="bp-state">✓ Done</span>`;
      else if (s.program) right = `<button class="primary bp-go" data-program="${esc(s.program)}">Start</button>`;
      else if (s.game) right = `<button class="primary bp-go" data-game="${esc(s.game)}">Start</button>`;
      const why = s.why ? `<div class="bp-why">${esc(s.why)}</div>` : "";
      return `<li class="bp-step${s.done ? " done" : ""}"><span class="bp-n">${s.done ? "✓" : i + 1}</span>` +
        `<span class="bp-text">${esc(s.text)}${why}</span>${right}</li>`;
    }).join("");
    return `<div class="bp-head"><strong>Today: ${esc(t.title)}</strong><span class="bp-muted">${esc(weekLine(m))}</span></div>` +
      `<ol class="bp-steps">${steps}</ol><div class="bp-muted">${esc(sessionsLine(m))}</div>`;
  }

  /** One number's tile: so far (or where it starts, before the plan), against the start and the target. */
  function tileHtml(n, m) {
    const started = m.plan && m.plan.started;
    const now = started && n.plan && finite(n.plan.value) ? n.plan : null;
    const big = now ? now.value : (n.start && n.start.value);
    const shots = now ? now.n : (n.start && n.start.n);
    const marks = [];
    if (n.start && finite(n.start.value)) marks.push(`<span class="bp-tick" style="left: calc(${Math.min(100, n.start.value)}% - 1px)" title="Start ${pct(n.start.value)}"></span>`);
    if (finite(n.target)) marks.push(`<span class="bp-tick target" style="left: calc(${Math.min(100, n.target)}% - 1px)" title="Target ${pct(n.target)}"></span>`);
    const bar = `<div class="bp-bar" aria-hidden="true">${finite(big) ? `<span class="bp-fill" style="width: ${Math.min(100, big)}%"></span>` : ""}${marks.join("")}</div>`;
    const aim = n.better === "down" ? `${pct(n.target)} or less` : `${pct(n.target)} or more`;
    const sub = started
      ? `Start ${pct(n.start && n.start.value)} · Target ${aim}`
      : `Where you start (${shots || 0} shots) · Target ${aim}`;
    const wk = started && n.week && n.week.n ? `<div class="bp-muted">This week ${pct(n.week.value)} (${n.week.n} shots)</div>` : "";
    const chip = started ? `<span class="bp-chip ${esc(n.verdict)}">${esc(VERDICT[n.verdict] || "")}</span>` : "";
    return `<div class="bp-tile"><div class="bp-label">${esc(n.label)}</div>` +
      `<div class="bp-big">${pct(big)}<small>${now ? `so far, ${shots} shots` : ""}</small></div>${bar}` +
      `<div class="bp-muted">${esc(sub)}</div>${wk}${chip}<div class="bp-muted">${esc(n.what)} (${esc(n.club)})</div></div>`;
  }

  /** The Combine, the weekly test: the best before the plan and each one since. */
  function combineLine(m) {
    const c = m && m.combine;
    if (!c) return "";
    const before = finite(c.best) ? `best before the plan ${sg(c.best)} strokes a shot against tour (the target: beat it)` : "none before the plan";
    const during = (c.plan || []).map(g => `${day(g.day)} ${sg(g.sgPerShot)}`).join(", ");
    return `Combine (test days): ${before}` + (during ? `; in the plan: ${during}` : "") + ".";
  }

  /** The scoreboard: a tile per number with a target, the Combine, and the numbers behind them. */
  function boardHtml(m) {
    if (!m || !m.plan) return "";
    const tiles = mainNumbers(m).map(n => tileHtml(n, m)).join("");
    const started = m.plan.started;
    const info = infoNumbers(m).map(n => `<li><b>${esc(n.label)}:</b> ${pct(n.start && n.start.value)} at the start` +
      (started && n.plan && n.plan.n ? `, ${pct(n.plan.value)} so far` : "") + ` (${esc(n.what)})</li>`).join("");
    return `<div class="bp-board">${tiles}</div><ul class="bp-info"><li>${esc(combineLine(m))}</li>${info}</ul>`;
  }

  /** Week by week: sessions done, each number, the Combine. */
  function weeksTableHtml(m) {
    if (!m || !m.weeks || !m.weeks.length) return "";
    const nums = mainNumbers(m);
    const head = `<tr><th>Week</th><th>Practice</th><th>Test</th>${nums.map(n => `<th>${esc(n.label)}</th>`).join("")}<th>Combine</th></tr>`;
    const startRow = `<tr><td>Start (${day(m.plan.baseline.from)} to ${day(m.plan.baseline.to)})</td><td></td><td></td>` +
      nums.map(n => `<td>${pct(n.start && n.start.value)} <span class="bp-muted">(${(n.start && n.start.n) || 0})</span></td>`).join("") +
      `<td>${finite(m.combine && m.combine.best) ? sg(m.combine.best) + " best" : "–"}</td></tr>`;
    const need = m.plan.need || {};
    const rows = m.weeks.map(w => {
      const future = m.plan.today < w.from;
      const cells = nums.map(n => {
        const x = w.numbers[n.key];
        return `<td>${future || !x || !x.n ? "–" : `${pct(x.value)} <span class="bp-muted">(${x.n})</span>`}</td>`;
      }).join("");
      const comb = (w.combine || []).map(g => sg(g.sgPerShot)).join(", ") || "–";
      return `<tr class="${m.plan.week === w.n ? "now" : ""}"><td>${w.n}: ${day(w.from)} to ${day(w.to)}</td>` +
        `<td>${future ? "–" : `${w.practice} of ${need.practice ?? 2}`}</td><td>${future ? "–" : `${w.test} of ${need.test ?? 1}`}</td>${cells}<td>${comb}</td></tr>`;
    }).join("");
    return `<div class="bp-scroll"><table class="bp-table"><thead>${head}</thead><tbody>${startRow}${rows}</tbody></table></div>`;
  }

  const HANDS_DIFF_IN = 0.15;   // ballplan.py HANDS_DIFF_IN
  const inch = v => `${Math.abs(v).toFixed(1)} in`;

  /** The hands to plane on heel strikes against centred ones (each against that club's median that day). */
  function handsLine(h) {
    if (!h || !finite(h.diff)) return "";
    const what = h.diff >= HANDS_DIFF_IN ? `the hands sat ${inch(h.diff)} higher in the downswing than on`
      : h.diff <= -HANDS_DIFF_IN ? `the hands sat ${inch(h.diff)} lower in the downswing than on`
        : "the hands in the downswing were where they were on";
    return `On ${h.nHeel} heel strikes ${what} ${h.nCentre} centred ones (same club, same day).`;
  }

  /** One miss: what it was, how many, why, and its drill and swing thought. */
  function struggleLines(s) {
    const lines = [`${s.label}: ${s.n} of ${s.of}, ${s.what}.`, s.why];
    if (s.hands) lines.push(handsLine(s.hands));
    lines.push(`Drill: ${s.drill}`, `Swing thought: "${s.thought}"`);
    return lines.filter(Boolean);
  }

  /** The counts behind a check: irons and drives, in one line each. */
  function countsLine(c) {
    const out = [];
    const ir = c.irons || {}, dr = c.drives || {};
    if (ir.n) {
      const k = ir.causes || {};
      const parts = [["heel", "off the heel"], ["toe", "off the toe"], ["shallow", "heavy"], ["steep", "digging"], ["short", "short"]]
        .filter(([key]) => k[key]).map(([key, w]) => `${k[key]} ${w}`);
      out.push(`Irons: ${ir.good} of ${ir.n} centred and full length` + (parts.length ? `; ${parts.join(", ")}` : "") + ".");
    }
    if (c.solid7 && c.solid7.n) out.push(`7 irons solid: ${c.solid7.hits} of ${c.solid7.n}.`);
    if (dr.n) {
      const k = dr.causes || {};
      const parts = [["left-curve", "curved left"], ["left-start", "started left"], ["left", "left"],
        ["right-curve", "curved right"], ["right-start", "started right"], ["right", "right"]]
        .filter(([key]) => k[key]).map(([key, w]) => `${k[key]} ${w}`);
      out.push(`Drives: ${dr.fairway} of ${dr.n} in the fairway` + (parts.length ? `; ${parts.join(", ")}` : "") + ".");
    }
    return out;
  }

  /** A check (ballplan.py check()): what went well and where it struggled, with the drill for each miss.
   *  `title`: "Last session, Oct 21" and such. Empty without shots. */
  function checkHtml(c, title) {
    if (!c || !((c.irons && c.irons.n) || (c.drives && c.drives.n))) return "";
    const well = (c.good || []).length ? c.good.map(g => `<li>${esc(g)}</li>`).join("")
      : `<li>Nothing at its target yet.</li>`;
    const hard = (c.struggle || []).length ? c.struggle.map(s => {
      const [head, ...rest] = struggleLines(s);
      return `<li><b>${esc(head)}</b>${rest.map(l => `<div class="bp-sub">${esc(l)}</div>`).join("")}</li>`;
    }).join("") : `<li>No miss stood out.</li>`;
    const counts = countsLine(c).map(l => `<div class="bp-muted">${esc(l)}</div>`).join("");
    return `<div class="bp-head" style="margin-top: 12px;"><strong>${esc(title)}</strong></div>${counts}` +
      `<div class="bp-check"><div class="bp-well"><h4>Going well</h4><ul>${well}</ul></div>` +
      `<div class="bp-hard"><h4>Struggling</h4><ul>${hard}</ul></div></div>`;
  }

  /** The title of the last session's check: "Today so far" or "Last session, Oct 21". */
  function lastTitle(m) {
    const c = m && m.checks && m.checks.last;
    if (!c) return "";
    return m.plan && c.from === m.plan.today ? "Today so far" : `Last session, ${day(c.from)}`;
  }

  /** The Week brief's lines for a week (the model fetched with from/to = that week): sessions, each number
   *  that week against the start and target, the Combine, and so far. Empty when the week isn't in the plan. */
  function weekBriefLines(m) {
    if (!m || !m.plan || !m.range) return [];
    const p = m.plan, r = m.range;
    if (r.to < p.start || r.from > p.end) return [];
    const need = p.need || {};
    const lines = [`${p.name} (${day(p.start)} to ${day(p.end)}): ${p.why}`,
      `Sessions this week: practice days ${r.practice} of ${need.practice ?? 2}, test day ${r.test} of ${need.test ?? 1}.`];
    for (const n of mainNumbers(m)) {
      const x = r.numbers[n.key] || {};
      const aim = n.better === "down" ? "or less" : "or more";
      lines.push(`${n.label} (${n.what}, ${n.club}): ${x.n ? `${pct(x.value)} this week (${x.n} shots)` : "no shots this week"}; ` +
        `start ${pct(n.start && n.start.value)}, target ${pct(n.target)} ${aim}` +
        (p.started && n.plan && n.plan.n ? `; so far in the plan ${pct(n.plan.value)} (${n.plan.n} shots): ${VERDICT[n.verdict].toLowerCase()}.` : "."));
    }
    for (const n of infoNumbers(m)) {
      const x = r.numbers[n.key] || {};
      if (x.n) lines.push(`${n.label}: ${pct(x.value)} this week (${x.n} shots), ${pct(n.start && n.start.value)} at the start.`);
    }
    const comb = (r.combine || []).map(g => `${day(g.day)} ${sg(g.sgPerShot)} strokes a shot (${g.greens} of ${g.shots} on the green)`);
    lines.push(comb.length ? `Combine this week: ${comb.join("; ")}. Best before the plan: ${sg(m.combine && m.combine.best)}.`
      : "No Combine this week.");
    const c = r.check;
    if (c) {
      lines.push(...countsLine(c));
      for (const g of c.good || []) lines.push(`Going well: ${g}`);
      for (const s of c.struggle || []) lines.push(`Struggling: ${struggleLines(s).join(" ")}`);
    }
    if (m.emphasis && m.emphasis.why) lines.push(`Next practice day: ${m.emphasis.why}`);
    return lines;
  }

  const api = { injectStyles, todayHtml, boardHtml, weeksTableHtml, weekBriefLines, weekLine, sessionsLine, combineLine,
    checkHtml, lastTitle, handsLine, struggleLines, countsLine, VERDICT, day };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingBallPlan = api;
})(typeof window !== "undefined" ? window : globalThis);
