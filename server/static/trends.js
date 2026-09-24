// Trends: one session at a time (Trends on a session in the list) and all of them over time
// (Progress). The swings' body numbers come from the server (/api/swings, worked out with
// summary.js as each swing is analyzed); the launch monitor's come with the clips (/api/clips).
// Uses the page's globals: clips, sessionsOf, shownClips, sessionTitle, clubName, open, viewer, video.

const trendsBox = document.getElementById("trends");
const progressBox = document.getElementById("progress");
const tipEl = document.getElementById("t-tip");
const pTipEl = document.getElementById("p-tip");
let trendsKey = null;     // the session shown in Trends, by its key (see sessionsOf)
let progressOpen = false;
let swingRecords = {};    // /api/swings: listed clip name -> {body, quality, setup} (or {error})
let journal = { handicap: [], notes: {} };
let dataSig = "";         // what the open view was last drawn from

const trendPick = { x: "earlyExt", y: "path", club: null };
try { Object.assign(trendPick, JSON.parse(localStorage.getItem("trends") || "{}"), { club: null }); } catch {}
const progressPick = { club: null, period: "90", metric: "earlyExt" };
try { Object.assign(progressPick, JSON.parse(localStorage.getItem("progress") || "{}"), { club: null }); } catch {}

// ---- Fields ----

const DECIMALS = { ":1": 1, s: 2, in: 1, "°": 1, yd: 1, mph: 1, rpm: 0, "": 2, mm: 1 };
const FIELDS = [
  { key: "order", label: "Swing order", unit: "", group: "", dec: 0 },
  ...SwingSummary.SHOT.map(f => ({ ...f, group: "Launch monitor", shot: true })),
  ...SwingSummary.BODY.map(f => ({ ...f, group: f.view === "dtl" ? "Down the line" : "Face-on" })),
].map(f => ({ dec: DECIMALS[f.unit] ?? 1, ...f }));
// How spread out a session's shots are (standard deviation): consistency, which is most of scoring.
const SPREADS = [
  ["carrySpread", "Carry spread", "yd", "carry"], ["offlineSpread", "Offline spread", "yd", "offline"],
  ["faceToPathSpread", "Face-to-path spread", "°", "faceToPath"], ["pathSpread", "Path spread", "°", "path"],
  ["strikeSpread", "Strike spread (toe/heel)", "mm", "strikeH"],
].map(([key, label, unit, of]) => ({ key, label, unit, of, spread: true, shot: true, group: "Consistency", dec: 1 }));
const field = key => FIELDS.find(f => f.key === key) || SPREADS.find(f => f.key === key) || FIELDS[0];
const fieldName = f => f.unit && f.unit !== ":1" ? `${f.label} (${f.unit})` : f.label;
// Which way is better, where there is one: up, down, toward zero, or toward a target value.
const BETTER = {
  carry: "up", ballSpeed: "up", clubSpeed: "up", smash: "up",
  carrySpread: "down", offlineSpread: "down", faceToPathSpread: "down", pathSpread: "down", strikeSpread: "down",
  earlyExt: "zero", bendLoss: "zero", headToBall: "zero", headSway: "zero", headRise: "zero", tempo: 3,
};

function fmtField(f, v) {
  if (v == null) return "–";
  if (f.unit === ":1") return `${v.toFixed(1)} : 1`;
  const n = v.toFixed(f.dec);
  const plain = f.shot || f.unit === "s" || f.key === "order" || v <= 0 || Number(n) === 0;
  return (plain ? n : "+" + n).replace(/^-0(\.0+)?$/, "0");
}

// ---- Data ----

/** Fetches the server's swing numbers (and the journal); true if anything changed. */
async function loadTrendData() {
  try {
    const [s, j] = await Promise.all([fetch("/api/swings"), fetch("/api/journal")]);
    if (s.ok) swingRecords = (await s.json()).swings;
    if (j.ok) journal = await j.json();
  } catch { return false; }
  const sig = JSON.stringify([swingRecords, journal, clips]);
  if (sig === dataSig) return false;
  dataSig = sig;
  return true;
}

/** Whether the server has (or is about to have) a swing's numbers. */
function swingPending(c) {
  const other = c.partner && clips.find(x => x.name === c.partner);
  return !swingRecords[c.name] && c.pose !== "failed" && (!other || other.pose !== "failed");
}

/** A listed swing as a row: its launch monitor numbers and its body numbers (null until worked out). */
function swingRow(c) {
  const rec = swingRecords[c.name];
  const body = rec && rec.body ? rec.body : null;
  return { c, t: new Date(c.recorded).getTime(), club: c.shot ? c.shot.club : null, rec, body,
           ...SwingSummary.shotNumbers(c.shot), ...(body || {}) };
}

/** The page shows one view at a time: a swing, one session's trends, or progress. */
function showView(which) {
  trendsBox.hidden = which !== "trends";
  progressBox.hidden = which !== "progress";
  viewer.hidden = which !== "swing" || !current;
  tipEl.hidden = pTipEl.hidden = true;
  if (which !== "swing") video.pause();
  if (which !== "trends") trendsKey = null;
  progressOpen = which === "progress";
  document.getElementById("progress-btn").classList.toggle("on", progressOpen);
}

/** Called when a swing is opened: back to the swing view. */
function leaveTrendViews() {
  if (!trendsKey && !progressOpen) return;
  showView("swing");
  renderList();
}

/** Called on each refresh of the clip list: keeps an open view up to date. */
async function trendsTick() {
  if (!trendsKey && !progressOpen) return;
  if (await loadTrendData()) renderTrendView();
}

function renderTrendView() {
  if (trendsKey) renderTrends();
  else if (progressOpen) renderProgress();
}

async function openTrends(key) {
  showView("trends");
  trendsKey = key;
  renderTrends();
  trendsBox.scrollTop = 0;
  if (window.innerWidth < 900) trendsBox.scrollIntoView();
  if (await loadTrendData()) renderTrends();
}

async function openProgress() {
  showView("progress");
  renderList();
  renderProgress();
  progressBox.scrollTop = 0;
  if (window.innerWidth < 900) progressBox.scrollIntoView();
  if (await loadTrendData()) renderProgress();
}

function closeTrendView() {
  showView("swing");
  renderList();
}
document.getElementById("t-close").onclick = closeTrendView;
document.getElementById("p-close").onclick = closeTrendView;
document.getElementById("progress-btn").onclick = () => progressOpen ? closeTrendView() : openProgress();

// ---- Numbers ----

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Median and quartiles of the non-null values, or null with fewer than `min` of them. */
function spreadOf(values, min = 3) {
  const v = values.filter(x => x != null).sort((a, b) => a - b);
  if (v.length < min) return null;
  return { n: v.length, med: quantile(v, 0.5), q1: quantile(v, 0.25), q3: quantile(v, 0.75) };
}

function sd(values, min = 5) {
  const v = values.filter(x => x != null);
  if (v.length < min) return null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

/** One number per session for field f: the median of its swings, or their spread for a consistency field. */
function sessionValue(rows, f) {
  if (f.spread) {
    const s = sd(rows.map(r => r[f.of]));
    return s == null ? null : { med: s, n: rows.filter(r => r[f.of] != null).length };
  }
  return spreadOf(rows.map(r => r[f.key]));
}

/** "better", "worse" or "" for a change from a to b in field f. */
function betterWorse(f, a, b) {
  const way = BETTER[f.key];
  if (way == null || a == null || b == null || a === b) return "";
  const dist = v => way === "zero" ? Math.abs(v) : typeof way === "number" ? Math.abs(v - way) : v;
  const improved = way === "up" ? b > a : dist(b) < dist(a);
  return improved ? "better" : "worse";
}

// ---- Session trends ----

function fillSelect(sel, groups, value) {
  sel.replaceChildren(...groups.map(([name, fs]) => {
    const parent = name ? Object.assign(document.createElement("optgroup"), { label: name }) : document.createDocumentFragment();
    for (const f of fs) parent.append(Object.assign(document.createElement("option"), { value: f.key, textContent: fieldName(f) }));
    return parent;
  }));
  sel.value = value;
}

const byGroup = names => names.map(g => [g, FIELDS.filter(f => f.group === g)]);

function savePicks() {
  try {
    localStorage.setItem("trends", JSON.stringify({ x: trendPick.x, y: trendPick.y }));
    localStorage.setItem("progress", JSON.stringify({ period: progressPick.period, metric: progressPick.metric }));
  } catch {}
}

/** Club filter options for these rows, most-hit first; keeps `pick.club` valid. */
function clubOptions(sel, rows, pick, allLabel) {
  const counts = {};
  for (const r of rows) if (r.club) counts[r.club] = (counts[r.club] || 0) + 1;
  const clubs = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  if (pick.club == null || (pick.club !== "" && !counts[pick.club])) pick.club = clubs[0] ?? "";
  const opts = clubs.map(k => Object.assign(document.createElement("option"), { value: k, textContent: `${clubName(k)} (${counts[k]})` }));
  if (allLabel) opts.unshift(Object.assign(document.createElement("option"), { value: "", textContent: allLabel }));
  sel.replaceChildren(...opts);
  sel.value = pick.club;
  return clubs;
}

function renderTrends() {
  const session = sessionsOf(shownClips()).find(s => s.key === trendsKey);
  if (!session) { closeTrendView(); return; }
  // Oldest first, numbered in the order they were hit. Swings left out (someone else's) don't count.
  const listed = [...session.clips].reverse();
  const all = listed.filter(c => !c.excluded).map((c, i) => ({ ...swingRow(c), order: i + 1 }));
  document.getElementById("t-title").textContent = `Trends · ${sessionTitle(session)}`;
  const left = listed.length - all.length, pending = all.filter(r => !r.body && swingPending(r.c)).length;
  document.getElementById("t-status").textContent = [
    `${all.length} swing${all.length === 1 ? "" : "s"}`,
    left ? `${left} left out` : "",
    pending ? `${pending} still being worked out on the server` : "",
  ].filter(Boolean).join(" · ");

  // Mixing clubs would mostly show the difference between clubs: one club at a time by default.
  const clubs = clubOptions(document.getElementById("t-club"), all, trendPick, "All clubs");
  document.getElementById("t-club-wrap").hidden = clubs.length < 2;
  const rows = trendPick.club ? all.filter(r => r.club === trendPick.club) : all;
  renderClubFix(rows);

  const fx = field(trendPick.x), fy = field(trendPick.y === "order" ? "path" : trendPick.y);
  fillSelect(document.getElementById("t-y"), byGroup(["Launch monitor", "Face-on", "Down the line"]), fy.key);
  fillSelect(document.getElementById("t-x"), [["", [field("order")]], ...byGroup(["Face-on", "Down the line", "Launch monitor"])], fx.key);

  drawScatter(rows, fx, fy);
  renderRanking(rows, fx, fy);
  renderTrendTable(rows, fx, fy);
}

/** "Change club…" for the swings shown: for when the club wasn't changed in Square's app. */
function renderClubFix(rows) {
  const box = document.getElementById("t-fix");
  const withShot = rows.filter(r => r.c.shot);
  if (!withShot.length) { box.replaceChildren(); return; }
  if (box.contains(document.activeElement)) return;   // don't swap it out while it's open
  const n = withShot.length;
  const sel = clubSelect(null, null);
  sel.prepend(Object.assign(document.createElement("option"), { value: "", textContent: "Change club…" }));
  sel.value = "";
  sel.title = `Set the club for the ${n} swing${n === 1 ? "" : "s"} shown`;
  sel.onchange = async () => {
    const club = sel.value;
    if (!club) return;
    if (!confirm(`Mark ${n === 1 ? "this swing" : `these ${n} swings`} as ${clubName(club)}?`)) { sel.value = ""; return; }
    // Each swing goes back to Square's club if that's what it said.
    const groups = {};
    for (const r of withShot) {
      const square = r.c.shot.squareClub || r.c.shot.club;
      (groups[square] = groups[square] || []).push(r.c.name);
    }
    sel.blur();
    trendPick.club = club;
    for (const square in groups) await setClub(groups[square], club, square);
    await loadTrendData();
    renderTrends();
  };
  box.replaceChildren(sel);
}

for (const [id, key] of [["t-y", "y"], ["t-x", "x"], ["t-club", "club"]]) {
  document.getElementById(id).onchange = e => {
    trendPick[key] = e.target.value;
    savePicks();
    renderTrends();
  };
}

/** Round tick positions covering [lo, hi]. */
function niceTicks(lo, hi, count = 5) {
  if (!(hi > lo)) { lo -= 1; hi += 1; }
  const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw)), e = raw / mag;
  const step = (e >= 7.5 ? 10 : e >= 3.5 ? 5 : e >= 1.5 ? 2 : 1) * mag;
  const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = a; v <= b + step / 2; v += step) ticks.push(Math.abs(v) < step / 1e6 ? 0 : v);
  return { lo: a, hi: b, ticks, dec: Math.max(0, -Math.floor(Math.log10(step) + 1e-9)) };
}

const padded = vs => {
  if (!vs.length) return [0, 1];
  const lo = Math.min(...vs), hi = Math.max(...vs), d = (hi - lo) * 0.08 || 1;
  return [lo - d, hi + d];
};

function svgEl(tag, attrs, parent) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  if (parent) parent.append(el);
  return el;
}

/** Fills a tooltip with [value, label] lines and a footer, and puts it beside (px, py) inside its card. */
function placeTip(tip, lines, foot, card, px, py) {
  tip.replaceChildren();
  for (const [value, label] of lines) {
    const d = document.createElement("div");
    d.append(Object.assign(document.createElement("b"), { textContent: value }), " " + label);
    tip.append(d);
  }
  if (foot) tip.append(Object.assign(document.createElement("div"), { textContent: foot }));
  tip.hidden = false;
  const box = card.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
  const left = px + 14 + tw > box.width ? px - tw - 14 : px + 14;
  tip.style.left = `${Math.max(4, Math.min(box.width - tw - 4, left))}px`;
  tip.style.top = `${Math.max(4, py - th / 2)}px`;
}

const timeOf = r => new Date(r.c.recorded).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });

function drawScatter(rows, fx, fy) {
  const svg = document.querySelector("#t-chart svg");
  const pts = rows.filter(r => r[fx.key] != null && r[fy.key] != null);
  const W = Math.max(280, svg.clientWidth || 600), H = 320, m = { l: 52, r: 16, t: 24, b: 44 };
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("aria-label", `${fieldName(fy)} against ${fieldName(fx)}, one dot per swing`);
  svg.replaceChildren();
  tipEl.hidden = true;
  const xs = pts.map(r => r[fx.key]), ys = pts.map(r => r[fy.key]);
  const X = niceTicks(...padded(xs)), Y = niceTicks(...padded(ys));
  const sx = v => m.l + (v - X.lo) / (X.hi - X.lo) * (W - m.l - m.r);
  const sy = v => H - m.b - (v - Y.lo) / (Y.hi - Y.lo) * (H - m.t - m.b);
  axes(svg, W, H, m, X, Y, sx, sy, v => v.toFixed(X.dec));
  svgEl("text", { x: m.l, y: 12, class: "t-title" }, svg).textContent = fieldName(fy);
  svgEl("text", { x: W - m.r, y: H - 6, "text-anchor": "end", class: "t-title" }, svg).textContent = fieldName(fx);

  const cor = SwingSummary.correlation(rows.map(r => r[fx.key]), rows.map(r => r[fy.key]));
  if (cor.r != null && cor.slope != null) {
    const a = Math.min(...xs), b = Math.max(...xs), at = x => cor.my + cor.slope * (x - cor.mx);
    svgEl("line", { x1: sx(a), x2: sx(b), y1: sy(at(a)), y2: sy(at(b)), class: "t-fit" }, svg);
  }

  for (const r of pts) svgEl("circle", { cx: sx(r[fx.key]), cy: sy(r[fy.key]), r: 5, class: "t-dot" }, svg);
  const ring = svgEl("circle", { r: 8, class: "t-ring", visibility: "hidden" }, svg);
  for (const r of pts) {
    const cx = sx(r[fx.key]), cy = sy(r[fy.key]);
    const hit = svgEl("circle", { cx, cy, r: 13, class: "t-hit", tabindex: 0, role: "button" }, svg);
    hit.setAttribute("aria-label", `Swing ${r.order}: ${fy.label} ${fmtField(fy, r[fy.key])}, ${fx.label} ${fmtField(fx, r[fx.key])}`);
    const show = () => {
      ring.setAttribute("cx", cx); ring.setAttribute("cy", cy); ring.setAttribute("visibility", "visible");
      const k = svg.getBoundingClientRect().width / W, off = svg.getBoundingClientRect().left - svg.parentElement.getBoundingClientRect().left;
      const top = svg.getBoundingClientRect().top - svg.parentElement.getBoundingClientRect().top;
      placeTip(tipEl, [[fmtField(fy, r[fy.key]), fieldName(fy)], [fmtField(fx, r[fx.key]), fieldName(fx)]],
               `Swing ${r.order} · ${timeOf(r)}${r.club ? " · " + clubName(r.club) : ""}`, svg.parentElement, off + cx * k, top + cy * k);
    };
    const hide = () => { ring.setAttribute("visibility", "hidden"); tipEl.hidden = true; };
    hit.addEventListener("pointerenter", show);
    hit.addEventListener("focus", show);
    hit.addEventListener("pointerleave", hide);
    hit.addEventListener("blur", hide);
    hit.addEventListener("click", () => open(r.c.name));
    hit.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(r.c.name); } });
  }

  const rEl = document.getElementById("t-r");
  rEl.replaceChildren();
  if (cor.n < 5 || cor.r == null) {
    rEl.textContent = `${cor.n} swing${cor.n === 1 ? "" : "s"} with both numbers. It takes at least 5 to say anything.`;
    return;
  }
  const out = Math.abs(cor.r) >= cor.needed;
  const words = Math.abs(cor.r) < 0.2 ? "no real link"
    : `more ${fx.label.toLowerCase()} goes with ${cor.r > 0 ? "more" : "less"} ${fy.label.toLowerCase()}`;
  const muted = Object.assign(document.createElement("span"), {
    className: "muted",
    textContent: ` · ${cor.n} swings · ${out ? "stands out from chance" : "could be chance"} (needs ±${cor.needed.toFixed(2)})`,
  });
  rEl.append(Object.assign(document.createElement("b"), { textContent: `r = ${fmtR(cor.r)}` }), ` · ${words}`, muted);
}

/** Gridlines and tick labels; `xLabel(v)` names each x tick (null: no x ticks). */
function axes(svg, W, H, m, X, Y, sx, sy, xLabel) {
  for (const v of Y.ticks) {
    svgEl("line", { x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v), class: v === 0 ? "t-zero" : "t-grid" }, svg);
    svgEl("text", { x: m.l - 6, y: sy(v) + 4, "text-anchor": "end", class: "t-axis" }, svg).textContent = v.toFixed(Y.dec);
  }
  if (!xLabel) return;
  for (const v of X.ticks) {
    if (v === 0) svgEl("line", { x1: sx(v), x2: sx(v), y1: m.t, y2: H - m.b, class: "t-zero" }, svg);
    svgEl("text", { x: sx(v), y: H - m.b + 16, "text-anchor": "middle", class: "t-axis" }, svg).textContent = xLabel(v);
  }
}

const fmtR = r => `${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(2)}`;

/** Every number on the other side (body vs launch monitor), ranked by how closely it goes with fy. */
function renderRanking(rows, fx, fy) {
  const others = FIELDS.filter(f => f.key !== "order" && !!f.shot !== !!fy.shot);
  document.getElementById("t-rank-title").textContent = `What goes with ${fy.label.toLowerCase()}`;
  const ranked = others
    .map(f => ({ f, ...SwingSummary.correlation(rows.map(r => r[f.key]), rows.map(r => r[fy.key])) }))
    .map(x => ({ ...x, r: x.n >= 5 ? x.r : null }))
    .sort((a, b) => (b.r == null ? -1 : Math.abs(b.r)) - (a.r == null ? -1 : Math.abs(a.r)));
  document.getElementById("t-rank").replaceChildren(...ranked.map(x => {
    const row = document.createElement("button");
    row.className = "t-row" + (x.f.key === fx.key ? " cur" : "") + (x.r == null ? " none" : "");
    const out = x.r != null && Math.abs(x.r) >= x.needed;
    const name = Object.assign(document.createElement("span"), { textContent: x.f.label });
    if (out) name.append(Object.assign(document.createElement("em"), { textContent: "stands out" }));
    const r = Object.assign(document.createElement("span"), { className: "r", textContent: x.r == null ? "–" : fmtR(x.r) });
    const bar = Object.assign(document.createElement("span"), { className: "t-bar" });
    if (x.r != null) {
      const fill = document.createElement("i"), tick = document.createElement("s");
      fill.style.width = `${Math.abs(x.r) * 100}%`;
      fill.classList.toggle("out", out);
      tick.style.left = `${Math.min(1, x.needed) * 100}%`;
      bar.append(fill, tick);
    }
    row.title = x.r == null ? `Fewer than 5 swings have ${x.f.label.toLowerCase()}` : `${x.n} swings`;
    row.append(name, r, bar);
    row.onclick = () => {
      trendPick.x = x.f.key;
      savePicks();
      renderTrends();
      document.getElementById("t-chart").scrollIntoView({ block: "nearest" });
    };
    return row;
  }));
}

/** Every swing, every number: the table twin of the chart. */
function renderTrendTable(rows, fx, fy) {
  const cols = FIELDS.filter(f => f.key !== "order");
  const head = document.createElement("tr");
  for (const t of ["#", "Time", "Club"]) head.append(Object.assign(document.createElement("th"), { textContent: t }));
  for (const f of cols) {
    const th = Object.assign(document.createElement("th"), { textContent: fieldName(f), title: f.group });
    th.classList.toggle("sel", f.key === fx.key || f.key === fy.key);
    head.append(th);
  }
  const thead = document.createElement("thead"), tbody = document.createElement("tbody");
  thead.append(head);
  for (const r of rows) {
    const tr = document.createElement("tr");
    for (const t of [r.order, timeOf(r), r.club ? clubName(r.club) : "–"]) {
      tr.append(Object.assign(document.createElement("td"), { textContent: t }));
    }
    for (const f of cols) {
      const pending = !f.shot && !r.body;
      tr.append(Object.assign(document.createElement("td"), {
        textContent: pending ? (swingPending(r.c) ? "…" : "–") : fmtField(f, r[f.key]),
      }));
    }
    tr.onclick = () => open(r.c.name);
    tbody.append(tr);
  }
  document.getElementById("t-table").replaceChildren(thead, tbody);
}

// ---- Progress: all sessions over time ----

// Headline numbers: the latest session against the ones before it.
const TILES = ["carry", "carrySpread", "offlineSpread", "faceToPathSpread", "strikeSpread", "smash",
               "earlyExt", "bendLoss", "tempo", "handsPlaneP6"];
// A camera counts as moved when the golfer's place or size in its picture changes this much
// between sessions (see summary.js framing): body numbers from before and after don't compare.
// (Within a session the golfer's place varies ~0.004 picture heights and size ~2%.)
const MOVED_SIZE = 0.06, MOVED_SHIFT = 0.02;
const dayOf = t => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/**
 * The club's sessions, oldest first: {key, start, rows, moved: {face, dtl}} where moved says the
 * camera had moved since the session before that used it.
 */
function progressSessions(club) {
  const out = [];
  for (const s of sessionsOf(shownClips()).reverse()) {
    const rows = [...s.clips].reverse().filter(c => !c.excluded).map(swingRow).filter(r => r.club === club);
    if (rows.length) out.push({ key: s.key, start: s.start, rows, moved: {} });
  }
  for (const cam of ["face", "dtl"]) {
    let prev = null;
    for (const s of out) {
      const frames = s.rows.map(r => r.rec && r.rec.setup && r.rec.setup[cam]).filter(Boolean);
      if (frames.length < 2) continue;
      const med = k => quantile(frames.map(f => f[k]).sort((a, b) => a - b), 0.5);
      const now = { h: med("h"), x: med("x"), y: med("y") };
      if (prev && (Math.abs(now.h - prev.h) / prev.h > MOVED_SIZE || Math.abs(now.x - prev.x) > MOVED_SHIFT
                   || Math.abs(now.y - prev.y) > MOVED_SHIFT)) s.moved[cam] = true;
      prev = now;
    }
  }
  return out;
}

/** The camera a body number is measured from ("face" / "dtl"), or null for launch monitor numbers. */
const cameraOf = f => f.shot ? null : SwingSummary.BODY.find(b => b.key === f.key)?.view ?? null;

function renderProgress() {
  const allRows = shownClips().filter(c => !c.excluded).map(swingRow);
  const clubs = clubOptions(document.getElementById("p-club"), allRows, progressPick, null);
  document.getElementById("p-period").value = progressPick.period;
  const club = progressPick.club;
  const days = Number(progressPick.period);
  const since = days ? Date.now() - days * 86400000 : -Infinity;
  const sessions = progressSessions(club).filter(s => s.start >= since);
  const pending = allRows.filter(r => !r.body && swingPending(r.c)).length;
  document.getElementById("p-status").textContent = !clubs.length ? "No swings with launch monitor numbers yet."
    : [`${sessions.length} session${sessions.length === 1 ? "" : "s"} with the ${clubName(club).toLowerCase()}`,
       pending ? `${pending} swing${pending === 1 ? "" : "s"} still being worked out on the server` : ""].filter(Boolean).join(" · ");

  const metricSel = document.getElementById("p-metric");
  fillSelect(metricSel, [["Consistency", SPREADS], ...byGroup(["Launch monitor", "Face-on", "Down the line"])], progressPick.metric);
  if (metricSel.value !== progressPick.metric) { progressPick.metric = "carry"; metricSel.value = "carry"; }

  renderTiles(sessions);
  drawOverTime(sessions, field(progressPick.metric));
  drawPattern(sessions);
  renderHandicap();
  renderSessionTable(sessions);
}

for (const [id, key] of [["p-club", "club"], ["p-period", "period"], ["p-metric", "metric"]]) {
  document.getElementById(id).onchange = e => {
    progressPick[key] = e.target.value;
    savePicks();
    renderProgress();
  };
}

/** The latest session's number against the median of the sessions before it (since the camera last moved). */
function renderTiles(sessions) {
  const box = document.getElementById("p-tiles");
  const latest = sessions[sessions.length - 1];
  const note = document.getElementById("p-tiles-note");
  if (!latest) { box.replaceChildren(); note.textContent = ""; return; }
  note.textContent = `${dayOf(latest.start)} (${latest.rows.length} swings) against the sessions before it in this period. `
    + "Changes smaller than the usual session-to-session difference are marked \"normal variation\".";
  box.replaceChildren(...TILES.map(key => {
    const f = field(key), cam = cameraOf(f);
    // Body numbers only compare since the camera that measures them last moved.
    let from = 0;
    if (cam) sessions.forEach((s, i) => { if (s.moved[cam]) from = i; });
    const series = sessions.slice(from).map(s => sessionValue(s.rows, f)?.med ?? null);
    const now = series[series.length - 1];
    const before = series.slice(0, -1).filter(v => v != null);
    const base = before.length ? quantile([...before].sort((a, b) => a - b), 0.5) : null;
    const tile = document.createElement("div");
    tile.className = "p-tile";
    const label = Object.assign(document.createElement("span"), { className: "p-label", textContent: f.label });
    const value = Object.assign(document.createElement("b"), { textContent: now == null ? "–" : fmtTile(f, now) });
    const delta = Object.assign(document.createElement("span"), { className: "p-delta" });
    if (now != null && base != null) {
      const d = now - base, bw = betterWorse(f, base, now);
      // Typical session-to-session difference, with enough sessions to know it.
      const noise = before.length >= 3 ? sd(before, 3) : null;
      const normal = noise != null && Math.abs(d) < noise;
      delta.textContent = `${d >= 0 ? "+" : "−"}${fmtTile(f, Math.abs(d)).replace(" : 1", "")} vs ${fmtTile(f, base)}`;
      if (bw && !normal) delta.append(" · ", Object.assign(document.createElement("em"), { className: bw, textContent: bw }));
      else if (normal) delta.append(" · normal variation");
    } else {
      delta.textContent = now == null ? "not enough swings" : cam && from > 0 ? "camera moved: no baseline yet" : "no earlier sessions";
    }
    tile.append(label, value, delta, sparkline(series));
    tile.title = `${fieldName(f)}${f.spread ? " (standard deviation of the session's shots)" : " (session median)"}. Click to chart it.`;
    tile.onclick = () => { progressPick.metric = key; savePicks(); renderProgress(); document.getElementById("p-chart").scrollIntoView({ block: "nearest" }); };
    return tile;
  }));
}

const fmtTile = (f, v) => f.unit === ":1" ? `${v.toFixed(1)} : 1`
  : `${v.toFixed(f.dec)}${f.unit === "°" ? "°" : f.unit ? " " + f.unit : ""}`;

function sparkline(series) {
  const pts = series.map((v, i) => [i, v]).filter(([, v]) => v != null);
  const svg = svgEl("svg", { viewBox: "0 0 100 24", class: "p-spark", preserveAspectRatio: "none", "aria-hidden": "true" });
  if (pts.length < 2) return svg;
  const lo = Math.min(...pts.map(p => p[1])), hi = Math.max(...pts.map(p => p[1])), n = series.length - 1 || 1;
  const x = i => 2 + i / n * 96, y = v => hi === lo ? 12 : 21 - (v - lo) / (hi - lo) * 18;
  svgEl("polyline", { points: pts.map(([i, v]) => `${x(i)},${y(v)}`).join(" "), class: "p-spark-line" }, svg);
  // The end dot is the latest session, only when it has a number.
  const [li, lv] = pts[pts.length - 1];
  if (li === series.length - 1) svgEl("circle", { cx: x(li), cy: y(lv), r: 2.5, class: "p-spark-end" }, svg);
  return svg;
}

/** One column per session: its swings as faint dots, the median (and middle half) in color, joined up. */
function drawOverTime(sessions, f) {
  const svg = document.querySelector("#p-chart svg");
  const W = Math.max(280, svg.clientWidth || 600), H = 300, m = { l: 52, r: 16, t: 24, b: 44 };
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("aria-label", `${fieldName(f)} per session over time`);
  svg.replaceChildren();
  pTipEl.hidden = true;
  const cols = sessions.map(s => ({ s, v: sessionValue(s.rows, f), swings: f.spread ? [] : s.rows.map(r => r[f.key]).filter(v => v != null) }));
  const ys = cols.flatMap(c => [...c.swings, ...(c.v ? [c.v.med] : [])]);
  const Y = niceTicks(...padded(ys));
  const n = Math.max(1, sessions.length);
  const step = (W - m.l - m.r) / n;
  const sx = i => m.l + step * (i + 0.5);
  const sy = v => H - m.b - (v - Y.lo) / (Y.hi - Y.lo) * (H - m.t - m.b);
  axes(svg, W, H, m, null, Y, null, sy, null);
  svgEl("text", { x: m.l, y: 12, class: "t-title" }, svg).textContent =
    fieldName(f) + (f.spread ? ", per session" : ", per session (median and middle half)");
  // Date labels, thinned to fit.
  const every = Math.ceil(n / Math.max(1, Math.floor((W - m.l - m.r) / 56)));
  cols.forEach((c, i) => {
    if (i % every === 0 || i === n - 1) {
      svgEl("text", { x: sx(i), y: H - m.b + 16, "text-anchor": "middle", class: "t-axis" }, svg).textContent = dayOf(c.s.start);
    }
    // The camera moved before this session: body numbers either side don't compare.
    const cam = cameraOf(f);
    if (cam && c.s.moved[cam]) {
      const x = sx(i) - step / 2;
      svgEl("line", { x1: x, x2: x, y1: m.t, y2: H - m.b, class: "p-break" }, svg);
      svgEl("text", { x: x + 4, y: m.t + 10, class: "t-axis" }, svg).textContent = "camera moved";
    }
  });
  if (!sessions.length) return;
  const jitter = k => ((k * 0.618) % 1 - 0.5) * Math.min(step * 0.5, 24);
  cols.forEach((c, i) => c.swings.forEach((v, k) => svgEl("circle", { cx: sx(i) + jitter(k), cy: sy(v), r: 2.5, class: "p-swing" }, svg)));
  const withV = cols.map((c, i) => [c, i]).filter(([c]) => c.v);
  if (!f.spread) for (const [c, i] of withV) svgEl("line", { x1: sx(i), x2: sx(i), y1: sy(c.v.q1), y2: sy(c.v.q3), class: "p-iqr" }, svg);
  if (withV.length > 1) svgEl("polyline", { points: withV.map(([c, i]) => `${sx(i)},${sy(c.v.med)}`).join(" "), class: "p-line" }, svg);
  for (const [c, i] of withV) svgEl("circle", { cx: sx(i), cy: sy(c.v.med), r: 5, class: "t-dot" }, svg);

  const ring = svgEl("circle", { r: 8, class: "t-ring", visibility: "hidden" }, svg);
  cols.forEach((c, i) => {
    const hit = svgEl("rect", { x: sx(i) - step / 2, y: m.t, width: step, height: H - m.t - m.b, class: "t-hit", tabindex: 0, role: "button" }, svg);
    const label = `${dayOf(c.s.start)}: ${c.v ? fmtTile(f, c.v.med) : "not enough swings"}`;
    hit.setAttribute("aria-label", label);
    const show = () => {
      const lines = c.v ? [[fmtTile(f, c.v.med), f.spread ? "spread" : "median"]] : [["–", "not enough swings"]];
      if (c.v && !f.spread) lines.push([`${fmtTile(f, c.v.q1)} – ${fmtTile(f, c.v.q3)}`, "middle half"]);
      if (c.v) { ring.setAttribute("cx", sx(i)); ring.setAttribute("cy", sy(c.v.med)); ring.setAttribute("visibility", "visible"); }
      const note = journal.notes[c.s.key];
      const box = svg.getBoundingClientRect(), card = svg.parentElement.getBoundingClientRect(), k = box.width / W;
      placeTip(pTipEl, lines, `${dayOf(c.s.start)} · ${c.s.rows.length} swings${note ? " · " + note : ""}`, svg.parentElement,
               box.left - card.left + sx(i) * k, box.top - card.top + (c.v ? sy(c.v.med) : H / 2) * k);
    };
    const hide = () => { ring.setAttribute("visibility", "hidden"); pTipEl.hidden = true; };
    hit.addEventListener("pointerenter", show);
    hit.addEventListener("focus", show);
    hit.addEventListener("pointerleave", hide);
    hit.addEventListener("blur", hide);
    hit.addEventListener("click", () => openTrends(c.s.key));
    hit.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openTrends(c.s.key); } });
  });
}

/** Where the shots finished (offline across, carry up): the latest session against the ones before. */
function drawPattern(sessions) {
  const svg = document.getElementById("p-pattern");
  const W = Math.max(280, svg.clientWidth || 600), H = 300, m = { l: 52, r: 16, t: 24, b: 44 };
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.replaceChildren();
  const shots = rows => rows.filter(r => r.carry != null && r.offline != null && r.carry > 0);
  const latest = sessions.length ? shots(sessions[sessions.length - 1].rows) : [];
  const before = shots(sessions.slice(0, -1).flatMap(s => s.rows));
  const all = [...latest, ...before];
  document.getElementById("p-pattern-legend").hidden = !all.length;
  if (!all.length) return;
  // Same scale both ways (yards), centered on straight.
  const half = Math.max(10, ...all.map(r => Math.abs(r.offline))) * 1.15;
  const Y = niceTicks(...padded(all.map(r => r.carry)));
  const X = niceTicks(-half, half);
  const sx = v => m.l + (v - X.lo) / (X.hi - X.lo) * (W - m.l - m.r);
  const sy = v => H - m.b - (v - Y.lo) / (Y.hi - Y.lo) * (H - m.t - m.b);
  axes(svg, W, H, m, X, Y, sx, sy, v => v === 0 ? "0" : `${Math.abs(v).toFixed(X.dec)} ${v < 0 ? "L" : "R"}`);
  svgEl("text", { x: m.l, y: 12, class: "t-title" }, svg).textContent = "Carry (yd)";
  svgEl("text", { x: W - m.r, y: H - 6, "text-anchor": "end", class: "t-title" }, svg).textContent = "Offline (yd)";
  for (const [rows, cls] of [[before, "p-before"], [latest, "p-latest"]]) {
    const e = ellipse(rows.map(r => r.offline), rows.map(r => r.carry));
    if (e) {
      const pts = [];
      for (let a = 0; a <= 64; a++) {
        const t = a / 64 * 2 * Math.PI, u = Math.cos(t) * e.a, v = Math.sin(t) * e.b;
        pts.push(`${sx(e.cx + u * Math.cos(e.th) - v * Math.sin(e.th))},${sy(e.cy + u * Math.sin(e.th) + v * Math.cos(e.th))}`);
      }
      svgEl("polygon", { points: pts.join(" "), class: cls + "-ring" }, svg);
    }
    for (const r of rows) svgEl("circle", { cx: sx(r.offline), cy: sy(r.carry), r: cls === "p-latest" ? 4 : 3, class: cls }, svg);
  }
}

/** The 1-standard-deviation ellipse of points (xs, ys): center, half-axes and angle; null if too few. */
function ellipse(xs, ys) {
  const n = xs.length;
  if (n < 5) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  sxx /= n - 1; syy /= n - 1; sxy /= n - 1;
  const tr = (sxx + syy) / 2, det = Math.sqrt(((sxx - syy) / 2) ** 2 + sxy ** 2);
  return { cx: mx, cy: my, a: Math.sqrt(tr + det), b: Math.sqrt(Math.max(0, tr - det)), th: 0.5 * Math.atan2(2 * sxy, sxx - syy) };
}

/** The handicap index over time, from what's typed in here (it isn't read from GHIN). */
function renderHandicap() {
  const entries = journal.handicap;
  const svg = document.getElementById("p-hcp");
  const W = Math.max(280, svg.clientWidth || 600), H = 180, m = { l: 44, r: 16, t: 16, b: 32 };
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.replaceChildren();
  svg.hidden = entries.length < 2;
  if (entries.length >= 2) {
    const ts = entries.map(e => new Date(e.date + "T12:00").getTime());
    const Y = niceTicks(...padded(entries.map(e => e.index)), 4);
    const t0 = Math.min(...ts), t1 = Math.max(...ts);
    const sx = t => m.l + (t1 > t0 ? (t - t0) / (t1 - t0) : 0.5) * (W - m.l - m.r);
    const sy = v => H - m.b - (v - Y.lo) / (Y.hi - Y.lo) * (H - m.t - m.b);
    axes(svg, W, H, m, null, Y, null, sy, null);
    svgEl("text", { x: sx(t0), y: H - 10, class: "t-axis" }, svg).textContent = dayOf(t0);
    svgEl("text", { x: sx(t1), y: H - 10, "text-anchor": "end", class: "t-axis" }, svg).textContent = dayOf(t1);
    svgEl("polyline", { points: entries.map((e, i) => `${sx(ts[i])},${sy(e.index)}`).join(" "), class: "p-line" }, svg);
    entries.forEach((e, i) => svgEl("circle", { cx: sx(ts[i]), cy: sy(e.index), r: 4, class: "t-dot" }, svg));
  }
  const list = document.getElementById("p-hcp-list");
  list.replaceChildren(...[...entries].reverse().slice(0, 6).map(e => {
    const row = document.createElement("div");
    row.className = "p-hcp-row";
    const del = Object.assign(document.createElement("button"), { className: "small", textContent: "Remove", title: "Remove this entry" });
    del.onclick = async () => { await postJournal("handicap", { date: e.date, index: null }); };
    row.append(Object.assign(document.createElement("b"), { textContent: e.index.toFixed(1) }),
               Object.assign(document.createElement("span"), { textContent: new Date(e.date + "T12:00").toLocaleDateString() }), del);
    return row;
  }));
  const date = document.getElementById("p-hcp-date");
  if (!date.value) date.value = new Date().toLocaleDateString("en-CA");
}

async function postJournal(what, body) {
  const res = await fetch("/api/journal/" + what, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) { showToast("Couldn't save that - is the server up to date?"); return; }
  await loadTrendData();
  renderTrendView();
}

document.getElementById("p-hcp-form").onsubmit = async e => {
  e.preventDefault();
  const date = document.getElementById("p-hcp-date").value, v = document.getElementById("p-hcp-index").value.trim();
  // A plus handicap is written +2.1 and stored as -2.1.
  const index = v.startsWith("+") ? -Number(v.slice(1)) : Number(v);
  if (!date || v === "" || Number.isNaN(index)) return;
  await postJournal("handicap", { date, index });
  document.getElementById("p-hcp-index").value = "";
};

/** Each session with the club: the headline numbers and its note. */
function renderSessionTable(sessions) {
  const cols = ["carry", "carrySpread", "offlineSpread", "earlyExt", "tempo"].map(field);
  const head = document.createElement("tr");
  for (const t of ["Session", "Swings", ...cols.map(fieldName), "Note"]) head.append(Object.assign(document.createElement("th"), { textContent: t }));
  const rows = [...sessions].reverse().map(s => {
    const tr = document.createElement("tr");
    const when = new Date(s.start).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    tr.append(Object.assign(document.createElement("td"), { textContent: when }),
              Object.assign(document.createElement("td"), { textContent: s.rows.length }));
    for (const f of cols) {
      const v = sessionValue(s.rows, f);
      tr.append(Object.assign(document.createElement("td"), { textContent: v ? fmtTile(f, v.med) : "–" }));
    }
    const note = journal.notes[s.key] || "";
    const td = document.createElement("td");
    td.className = "p-note";
    const edit = Object.assign(document.createElement("button"), { className: "small", textContent: note ? "Edit" : "Add note" });
    edit.onclick = async e => {
      e.stopPropagation();
      const text = prompt("Note for this session (what you worked on, how it felt):", note);
      if (text !== null) await postJournal("note", { key: s.key, note: text });
    };
    td.append(Object.assign(document.createElement("span"), { textContent: note }), edit);
    tr.append(td);
    tr.onclick = () => openTrends(s.key);
    tr.title = "Open this session's trends";
    return tr;
  });
  const thead = document.createElement("thead"), tbody = document.createElement("tbody");
  thead.append(head);
  tbody.append(...rows);
  document.getElementById("p-sessions").replaceChildren(thead, tbody);
}

// Charts are drawn to their width.
let viewWidth = 0;
new ResizeObserver(() => {
  const w = (trendsKey ? trendsBox : progressBox).clientWidth;
  if ((trendsKey || progressOpen) && w !== viewWidth) { viewWidth = w; renderTrendView(); }
}).observe(document.querySelector("main"));
