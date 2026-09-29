// Trends: one session at a time (Trends on a session in the list) and all of them over time
// (Progress). The swings' body numbers come from the server (/api/swings, worked out with
// summary.js as each swing is analyzed); the launch monitor's come with the clips (/api/clips).
// Uses the page's globals: clips, sessionsOf, shownClips, sessionTitle, clubName, open, viewer, video,
// lightOf, trustCell, noiseTable. Each body number's trust is trust.js's (SwingTrust): numbers with
// no reading are left out everywhere; shaky ones are hollow / greyed, or left out with "Leave out shaky".
// Personal ranges from good shots (goodshots.js, SwingGoodShots) are worked out here too, for Progress,
// the swing page, Compare and practice mode (goodShotData, goodRange).

const trendsBox = document.getElementById("trends");
const progressBox = document.getElementById("progress");
const tipEl = document.getElementById("t-tip");
const pTipEl = document.getElementById("p-tip");
let trendsKey = null;     // the session shown in Trends, by its key (see sessionsOf)
let progressOpen = false;
let swingRecords = {};    // /api/swings: listed clip name -> {body, quality, setup} (or {error})
let journal = { handicap: [], notes: {} };
let goodSettings = null;  // /api/goodshots: {settings, defaults}: which shots count as good (goodshots.js)
let dataSig = "";         // what the open view was last drawn from
let trendDataLoaded = false, trendDataAt = 0;

const trendPick = { x: "earlyExt", y: "path", club: null };
try { Object.assign(trendPick, JSON.parse(localStorage.getItem("trends") || "{}"), { club: null }); } catch {}
const progressPick = { club: null, period: "90", metric: "earlyExt" };
try { Object.assign(progressPick, JSON.parse(localStorage.getItem("progress") || "{}"), { club: null }); } catch {}
let leaveOutShaky = false;   // Trends and Progress: shaky numbers left out, not just marked
try { leaveOutShaky = localStorage.getItem("leave-shaky") === "on"; } catch {}

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
    const [s, j, g] = await Promise.all([fetch("/api/swings"), fetch("/api/journal"), fetch("/api/goodshots")]);
    if (s.ok) {
      const got = await s.json();
      swingRecords = got.swings;
      if (got.noise) noiseTable = got.noise;
    }
    if (j.ok) journal = await j.json();
    if (g.ok) goodSettings = await g.json();
  } catch { return false; }
  trendDataLoaded = true;
  trendDataAt = Date.now();
  const sig = JSON.stringify([swingRecords, journal, clips, noiseTable, leaveOutShaky, goodSettings]);
  if (sig === dataSig) return false;
  dataSig = sig;
  return true;
}

/** Whether the server has (or is about to have) a swing's numbers. */
function swingPending(c) {
  const other = c.partner && clips.find(x => x.name === c.partner);
  return !swingRecords[c.name] && c.pose !== "failed" && (!other || other.pose !== "failed");
}

/**
 * A listed swing as a row: its launch monitor numbers and its body numbers (null until worked out).
 * r[key] is the body number as the charts and correlations use it: null with no reading (trust.js),
 * and also when shaky with "Leave out shaky" on. r.shown has every number with a reading, r.trust
 * each one's judgement; r.unseen the cameras that couldn't see the golfer.
 */
function swingRow(c) {
  const rec = swingRecords[c.name];
  const trust = rec && rec.body ? SwingTrust.forSwing(rec, lightOf(c.name), noiseTable) : null;
  let body = null, shown = null;
  if (trust) {
    body = {};
    shown = {};
    for (const f of SwingSummary.BODY) {
      const j = trust[f.key], v = rec.body[f.key];
      shown[f.key] = j.level === "none" ? null : v;
      body[f.key] = j.level === "none" || (leaveOutShaky && j.level === "shaky") ? null : v;
    }
  }
  const bad = cam => ((rec && rec.quality && rec.quality.camera && rec.quality.camera[cam]) || [])
    .some(code => SwingTrust.BAD_CAMERA.includes(code));
  const unseen = ["face", "dtl"].filter(bad);
  return { c, t: new Date(c.recorded).getTime(), club: c.shot ? c.shot.club : null, rec, body, shown, trust, unseen,
           ...SwingSummary.shotNumbers(c.shot), ...(body || {}) };
}

/** Whether row r's number for field f is shaky (a body number, trust.js). */
const isShaky = (r, f) => {
  const k = typeof f === "string" ? f : f?.key;
  return !!(r.trust && r.trust[k] && r.trust[k].level === "shaky");
};

// ---- Good shots: personal ranges (goodshots.js) ----

let goodCache = { sig: null, value: null };
/** Good shots and the body numbers' ranges on them, per club (SwingGoodShots.build), worked out once per data change. */
function goodShotData() {
  const sig = dataSig + "|" + clips.length;
  if (goodCache.sig === sig) return goodCache.value;
  const swings = shownClips().map(c => ({ name: c.name, t: new Date(c.recorded).getTime() / 1000, club: c.shot ? c.shot.club : null,
    excluded: c.excluded, shot: c.shot, record: swingRecords[c.name] || null, light: lightOf(c.name) }));
  goodCache = { sig, value: SwingGoodShots.build(swings, goodSettings && goodSettings.settings, noiseTable) };
  return goodCache.value;
}

/** A body number's range with a club, or null. */
function goodRange(club, key) {
  const c = club && goodShotData().clubs[club];
  return c ? c.ranges[key] : null;
}

/** The page shows one view at a time: a swing, one session's trends, progress, camera setup, or the shutter test. */
function showView(which) {
  if (window.Compare) Compare.close(true);
  trendsBox.hidden = which !== "trends";
  progressBox.hidden = which !== "progress";
  document.getElementById("setup").hidden = which !== "setup";
  document.getElementById("setup-btn").classList.toggle("on", which === "setup");
  document.getElementById("shutter").hidden = which !== "shutter";
  document.getElementById("shutter-btn").classList.toggle("on", which === "shutter");
  document.getElementById("practice").hidden = which !== "practice";
  document.getElementById("labelview").hidden = which !== "labelview";
  document.getElementById("labels-btn").classList.toggle("on", which === "labelview");
  document.getElementById("practice-btn").classList.toggle("on", which === "practice");
  viewer.hidden = which !== "swing" || !current;
  tipEl.hidden = pTipEl.hidden = true;
  if (which !== "swing") video.pause();
  if (which !== "trends") trendsKey = null;
  progressOpen = which === "progress";
  document.getElementById("progress-btn").classList.toggle("on", progressOpen);
  // The tabs: a session's trends belong to Swings; Labels and the shutter test are under Tools.
  document.getElementById("swings-btn").classList.toggle("on", which === "swing" || which === "trends");
  document.getElementById("tools-btn").classList.toggle("on", which === "shutter" || which === "labelview");
  document.body.dataset.view = which;
}

/** Called when a swing is opened: back to the swing view. */
function leaveTrendViews() {
  if (!trendsKey && !progressOpen && document.getElementById("setup").hidden && document.getElementById("shutter").hidden
      && document.getElementById("practice").hidden && document.getElementById("labelview").hidden) return;
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

/** "5 swings' down-the-line numbers left out (camera)" for rows whose camera couldn't see the golfer. */
function unseenNote(rows) {
  const n = cam => rows.filter(r => r.unseen && r.unseen.includes(cam)).length;
  const parts = [["dtl", "down-the-line"], ["face", "face-on"]].filter(([cam]) => n(cam))
    .map(([cam, name]) => `${n(cam)} swing${n(cam) === 1 ? "'s" : "s'"} ${name} numbers left out (you were partly out of the picture)`);
  return parts.join(" · ");
}

// "Leave out shaky", in Trends and Progress alike.
for (const box of document.querySelectorAll(".leave-shaky")) {
  box.checked = leaveOutShaky;
  box.onchange = () => {
    leaveOutShaky = box.checked;
    for (const b of document.querySelectorAll(".leave-shaky")) b.checked = leaveOutShaky;
    try { localStorage.setItem("leave-shaky", leaveOutShaky ? "on" : "off"); } catch {}
    renderTrendView();
  };
}

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
    unseenNote(all),
    leaveOutShaky ? "shaky numbers left out" : "",
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

  // Hollow: a shaky number on either axis.
  const shakyWhy = r => [fx, fy].filter(f => isShaky(r, f)).map(f => `${f.label}: ${r.trust[f.key].text}`);
  for (const r of pts) {
    svgEl("circle", { cx: sx(r[fx.key]), cy: sy(r[fy.key]), r: 5, class: shakyWhy(r).length ? "t-dot hollow" : "t-dot" }, svg);
  }
  const ring = svgEl("circle", { r: 8, class: "t-ring", visibility: "hidden" }, svg);
  for (const r of pts) {
    const cx = sx(r[fx.key]), cy = sy(r[fy.key]);
    const hit = svgEl("circle", { cx, cy, r: 13, class: "t-hit", tabindex: 0, role: "button" }, svg);
    hit.setAttribute("aria-label", `Swing ${r.order}: ${fy.label} ${fmtField(fy, r[fy.key])}, ${fx.label} ${fmtField(fx, r[fx.key])}`);
    const show = () => {
      ring.setAttribute("cx", cx); ring.setAttribute("cy", cy); ring.setAttribute("visibility", "visible");
      const k = svg.getBoundingClientRect().width / W, off = svg.getBoundingClientRect().left - svg.parentElement.getBoundingClientRect().left;
      const top = svg.getBoundingClientRect().top - svg.parentElement.getBoundingClientRect().top;
      const mark = f => isShaky(r, f) ? " ~" : "";
      const why = shakyWhy(r);
      placeTip(tipEl, [[fmtField(fy, r[fy.key]) + mark(fy), fieldName(fy)], [fmtField(fx, r[fx.key]) + mark(fx), fieldName(fx)]],
               `Swing ${r.order} · ${timeOf(r)}${r.club ? " · " + clubName(r.club) : ""}${why.length ? " · shaky: " + why.join("; ") : ""}`,
               svg.parentElement, off + cx * k, top + cy * k);
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
      const td = document.createElement("td");
      if (f.shot) td.textContent = fmtField(f, r[f.key]);
      else if (!r.body) td.textContent = swingPending(r.c) ? "…" : "–";
      else trustCell(td, fmtField(f, r.shown[f.key]), r.trust[f.key]);
      tr.append(td);
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
// A camera counts as moved when the golfer's place or size in its picture changes enough between
// sessions (summary.js cameraMoved): body numbers from before and after don't compare.
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
      if (prev && SwingSummary.cameraMoved(prev, now)) s.moved[cam] = true;
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
  // The count up front; the caveats behind the ⓘ.
  const status = document.getElementById("p-status");
  const swings = sessions.reduce((n, s) => n + s.rows.length, 0);
  const caveats = [unseenNote(sessions.flatMap(s => s.rows)),
    pending ? `${pending} swing${pending === 1 ? "" : "s"} still being worked out on the server` : ""].filter(Boolean);
  status.textContent = !clubs.length ? "No swings with launch monitor numbers yet."
    : `${sessions.length} session${sessions.length === 1 ? "" : "s"} · ${swings} swings with the ${clubName(club).toLowerCase()}`
      + (caveats.length ? " ⓘ" : "");
  status.title = caveats.join("\n");

  const focusHere = journal.focus && journal.focus.club === club ? journal.focus : null;
  // Until a number is picked, the chart shows the focus move.
  if (!progressMetricPicked && focusHere) progressPick.metric = focusHere.move;
  const metricSel = document.getElementById("p-metric");
  fillSelect(metricSel, [["Consistency", SPREADS], ...byGroup(["Launch monitor", "Face-on", "Down the line"])], progressPick.metric);
  if (metricSel.value !== progressPick.metric) { progressPick.metric = "carrySpread"; metricSel.value = "carrySpread"; }

  const helps = helpsModel(club, sessions);
  renderTiles(sessions, club);
  renderCoach(club, helps);
  renderHelpsEvidence(club, sessions, helps);
  renderGoodShots(club);
  renderChips(focusHere);
  drawOverTime(sessions, field(progressPick.metric), focusHere);
  if (foldOpen("pattern")) drawPattern(sessions);
  if (foldOpen("hcp")) renderHandicap();
  renderSessionTable(sessions);
  renderGapping();
  renderWedges();
  renderProgressCombine();
  const latestHcp = journal.handicap[journal.handicap.length - 1];
  document.getElementById("p-hcp-now").textContent = latestHcp ? `${latestHcp.index.toFixed(1)} on ${dayOf(new Date(latestHcp.date + "T12:00"))}` : "";
}

async function renderProgressCombine() {
  const el = document.getElementById("p-combine-line");
  if (!el) return;
  el.hidden = true;
  el.textContent = "";
  try {
    const res = await fetch("/api/game");
    if (!res.ok) return;
    const data = await res.json();
    const combines = (data.log || []).filter(x => x.id === "combine" && x.summary);
    if (combines.length < 2) return;
    const first = combines[0], latest = combines[combines.length - 1];
    const fmt = v => v == null || !Number.isFinite(v) ? "–" : (v >= 0 ? "+" : "") + v.toFixed(2);
    el.textContent = `Combine: ${fmt(latest.summary.sgPerShot)} strokes a shot on ${dayOf(latest.started * 1000)}, first ${fmt(first.summary.sgPerShot)} on ${dayOf(first.started * 1000)}.`;
    el.hidden = false;
  } catch {}
}

// Set once a number is picked for the chart (the tiles, the chips or the list): then it stays.
let progressMetricPicked = false;
function pickMetric(key) {
  progressPick.metric = key;
  progressMetricPicked = true;
  savePicks();
  renderProgress();
}

for (const [id, key] of [["p-club", "club"], ["p-period", "period"], ["p-metric", "metric"]]) {
  document.getElementById(id).onchange = e => {
    if (key === "metric") return pickMetric(e.target.value);
    progressPick[key] = e.target.value;
    savePicks();
    renderProgress();
  };
}

// The folded cards (and "All numbers"): open or shut as last left, per browser.
const foldOpen = name => progressBox.querySelector(`details[data-fold="${name}"]`)?.open;
for (const d of progressBox.querySelectorAll("details[data-fold]")) {
  try { d.open = localStorage.getItem("fold-" + d.dataset.fold) === "open"; } catch {}
  d.addEventListener("toggle", () => {
    try { localStorage.setItem("fold-" + d.dataset.fold, d.open ? "open" : "shut"); } catch {}
    // Charts are drawn to their width, which a shut card doesn't have.
    if (d.open && progressOpen) renderProgress();
  });
}

/** Quick picks for the chart: the focus move and the results it's meant to change, then the usual consistency numbers. */
function renderChips(focus) {
  const keys = [];
  if (focus) keys.push(focus.move, ...(focus.results || []).map(k => HELPS_TREND_FIELD[k] || k));
  keys.push("carrySpread", "offlineSpread", "carry");
  const seen = new Set();
  const chips = keys.filter(k => FIELDS.some(f => f.key === k) || SPREADS.some(f => f.key === k))
    .filter(k => !seen.has(k) && seen.add(k)).map((k, i) => {
      const b = Object.assign(document.createElement("button"), { className: "small", type: "button",
        textContent: (focus && i === 0 ? "Focus: " : "") + field(k).label });
      b.classList.toggle("on", k === progressPick.metric);
      b.onclick = () => pickMetric(k);
      return b;
    });
  document.getElementById("p-chips").replaceChildren(...chips);
}

/**
 * A tile's numbers: the latest session's against the median of the sessions before it (since the
 * camera last moved), and whether the change is more than the usual session-to-session difference.
 */
function tileModel(sessions, key) {
  const f = field(key), cam = cameraOf(f), latest = sessions[sessions.length - 1];
  // Body numbers only compare since the camera that measures them last moved.
  let from = 0;
  if (cam) sessions.forEach((s, i) => { if (s.moved[cam]) from = i; });
  const series = sessions.slice(from).map(s => sessionValue(s.rows, f)?.med ?? null);
  const now = series[series.length - 1];
  const before = series.slice(0, -1).filter(v => v != null);
  const base = before.length ? quantile([...before].sort((a, b) => a - b), 0.5) : null;
  const d = now != null && base != null ? now - base : null;
  // Typical session-to-session difference, with enough sessions to know it.
  const noise = before.length >= 3 ? sd(before, 3) : null;
  const known = noise != null;
  const normal = d != null && known && Math.abs(d) < noise;
  const bw = d != null && known && !normal ? betterWorse(f, base, now) : null;
  return { key, f, cam, from, series, now, base, d, known, normal, bw, nBefore: before.length, shaky: tileShaky(f, latest.rows) };
}

// The results that open Progress: how far, how straight, how solid.
const HEAD_TILES = ["carry", "carrySpread", "offlineSpread", "smash"];

const lowerFirst = t => t.replace(/^./, c => c.toLowerCase());
const andList = xs => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/** One sentence on the latest session: what got better or worse than usual, the rest "as usual". */
function headline(models) {
  const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, { textContent: text });
  const name = m => lowerFirst(m.f.label);
  const said = m => `${name(m)} ${fmtTile(m.f, m.now)} vs ${fmtTile(m.f, m.base)}`;
  const cap = t => t.replace(/^./, c => c.toUpperCase());
  const moved = w => models.filter(m => m.bw === w);
  const usual = models.filter(m => m.d != null && m.known && !m.bw);
  const early = models.filter(m => m.d != null && !m.known);
  const out = [];
  const list = ms => andList(ms.map(said));
  if (!models.some(m => m.base != null)) {
    out.push("The first session in this period: nothing to compare it with yet.");
  } else {
    const better = moved("better"), worse = moved("worse");
    if (better.length) out.push(el("span", "better", "Better than usual: "), list(better) + ". ");
    if (worse.length) out.push(el("span", "worse", "Worse than usual: "), list(worse) + ". ");
    if (usual.length) out.push(`${usual.length === models.length ? "Everything" : cap(andList(usual.map(name)))} about as usual. `);
    // Not enough sessions to know the usual wobble: say so rather than colour it.
    if (early.length) {
      const n = Math.max(...early.map(m => m.nBefore));
      out.push(`Only ${n} earlier session${n === 1 ? "" : "s"} to compare with, too few to tell a real change from normal wobble: ${list(early)}.`);
    }
  }
  return out;
}

function renderTiles(sessions, club) {
  const box = document.getElementById("p-tiles"), more = document.getElementById("p-tiles-more");
  const latest = sessions[sessions.length - 1];
  const note = document.getElementById("p-tiles-note");
  const title = document.getElementById("p-today-title");
  const head = document.getElementById("p-headline");
  if (!latest) {
    box.replaceChildren(); more.replaceChildren(); note.textContent = "";
    title.textContent = "How did the last session go?";
    head.textContent = club ? `No sessions with the ${clubName(club).toLowerCase()} in this period.` : "";
    return;
  }
  title.textContent = `How did ${dayOf(latest.start)} go?`;
  note.textContent = `${dayOf(latest.start)} (${latest.rows.length} swings with the ${clubName(club).toLowerCase()}) against the median of the sessions before it in this period. `
    + "A change counts as better or worse only when it's bigger than the usual session-to-session difference (it takes 4 sessions to know that); "
    + "smaller ones are \"normal variation\". Spreads are the standard deviation of the session's shots. Tap a number to chart it below.";
  const heads = HEAD_TILES.map(k => tileModel(sessions, k));
  head.replaceChildren(...headline(heads));
  const top = (typeof SwingFaults !== "undefined" ? SwingFaults.sessionFaults(latest.rows, isShaky) : [])
    .filter(f => f.top).slice(0, 3);
  if (top.length) {
    const line = document.createElement("div");
    line.className = "p-faults";
    line.textContent = "Top faults: " + top.map(f => `${f.name} (${f.count} of ${f.total} swings)`).join(", ") + ".";
    head.append(line);
  }
  box.replaceChildren(...heads.map(tileEl));
  // The body numbers and the other spreads, only when asked for.
  more.replaceChildren(...(foldOpen("tiles-more") ? TILES.filter(k => !HEAD_TILES.includes(k)).map(k => tileEl(tileModel(sessions, k))) : []));

  function tileEl({ key, f, cam, from, series, now, base, d, known, normal, bw, shaky }) {
    const tile = document.createElement("div");
    tile.className = "p-tile";
    const label = Object.assign(document.createElement("span"), { className: "p-label", textContent: f.label });
    const value = Object.assign(document.createElement("b"), { textContent: now == null ? "–" : fmtTile(f, now) });
    if (now != null && shaky) trustCell(value, value.textContent, shaky);
    else if (now == null && !f.shot && latest.rows.some(r => r.body)) {
      // No number: say why, when every swing's was left out.
      const whys = latest.rows.map(r => r.trust && r.trust[f.key]).filter(Boolean);
      if (whys.length && whys.every(j => j.level === "none")) trustCell(value, "–", whys[0]);
      else if (whys.length && leaveOutShaky && whys.every(j => j.level !== "ok")) value.title = "Every swing's number was shaky (left out)";
    }
    const delta = Object.assign(document.createElement("span"), { className: "p-delta" });
    if (d != null) {
      delta.textContent = `${d >= 0 ? "+" : "−"}${fmtTile(f, Math.abs(d)).replace(" : 1", "")} vs ${fmtTile(f, base)}`;
      if (bw) delta.append(" · ", Object.assign(document.createElement("em"), { className: bw, textContent: bw }));
      else if (normal) delta.append(" · normal variation");
      else if (!known) delta.append(" · too early to judge");
    } else {
      delta.textContent = now == null ? "not enough swings" : cam && from > 0 ? "camera moved: no baseline yet" : "no earlier sessions";
    }
    tile.append(label, value, delta, sparkline(series));
    if (!shaky) tile.title = `${fieldName(f)}${f.spread ? " (standard deviation of the session's shots)" : " (session median)"}. Click to chart it.`;
    tile.onclick = () => { pickMetric(key); document.getElementById("p-chart").scrollIntoView({ block: "nearest" }); };
    return tile;
  }
}

/**
 * A tile's number is shaky when most of the latest session's swings that count toward it are:
 * a judgement (level "shaky", the most common reason) or null. Only body numbers.
 */
function tileShaky(f, rows) {
  if (f.shot || f.spread) return null;
  const used = rows.filter(r => r[f.key] != null && r.trust);
  const shaky = used.filter(r => isShaky(r, f));
  if (!used.length || shaky.length * 2 <= used.length) return null;
  const counts = {};
  for (const r of shaky) for (const w of r.trust[f.key].why) counts[w] = (counts[w] || 0) + 1;
  const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  return { level: "shaky", codes: [], why: top, text: `${shaky.length} of ${used.length} swings: ${top.join("; ")}` };
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

/** One column per session: its swings as faint dots, the median (and middle half) in color, joined up; and where the focus started. */
function drawOverTime(sessions, f, focus) {
  const svg = document.querySelector("#p-chart svg");
  const W = Math.max(280, svg.clientWidth || 600), H = 300, m = { l: 52, r: 16, t: 24, b: 44 };
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("aria-label", `${fieldName(f)} per session over time`);
  svg.replaceChildren();
  pTipEl.hidden = true;
  const cols = sessions.map(s => ({ s, v: sessionValue(s.rows, f),
    swings: f.spread ? [] : s.rows.filter(r => r[f.key] != null).map(r => ({ v: r[f.key], shaky: isShaky(r, f) })) }));
  const ys = cols.flatMap(c => [...c.swings.map(x => x.v), ...(c.v ? [c.v.med] : [])]);
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
  // The focus started before the first session on or after its day.
  if (focus) {
    const since = new Date(focus.since + "T00:00:00").getTime();
    const i = sessions.findIndex(s => s.start >= since);
    if (i >= 0) {
      const x = sx(i) - step / 2 + 2;
      svgEl("line", { x1: x, x2: x, y1: m.t, y2: H - m.b, class: "p-focus-line" }, svg);
      svgEl("text", { x: x + 4, y: m.t + 22, class: "p-focus-label" }, svg).textContent = "focus started";
    }
  }
  if (!sessions.length) return;
  const jitter = k => ((k * 0.618) % 1 - 0.5) * Math.min(step * 0.5, 24);
  cols.forEach((c, i) => c.swings.forEach((x, k) =>
    svgEl("circle", { cx: sx(i) + jitter(k), cy: sy(x.v), r: 2.5, class: x.shaky ? "p-swing hollow" : "p-swing" }, svg)));
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

// ---- Progress: my good shots with the club ----

// Separating numbers listed (largest first), and the settings form's fields: [part, key, label, unit].
const GOOD_TOP = 6;
const GOOD_FIELDS = [
  ["irons", "offlinePct", "Irons and wedges: offline within", "% of carry"],
  ["irons", "carryBelowPct", "carry no shorter than your median by", "%"],
  ["irons", "carryAbovePct", "no longer by", "%"],
  ["irons", "smashBelow", "smash no lower than your median by", ""],
  ["woods", "offlinePct", "Woods, hybrids, driver: offline within", "% of carry"],
  ["woods", "carryBelowPct", "carry no shorter than your median by", "%"],
  ["woods", "carryAbovePct", "no longer by", "%"],
  ["woods", "smashBelow", "smash no lower than your median by", ""],
  ["strike", "heelToeMm", "Strike within", "mm heel/toe of your usual spot"],
  ["strike", "highLowMm", "and within", "mm high/low"],
  ["", "minCount", "Smallest number of good shots for a range", "shots"],
];

/** The card: how many good shots, the numbers that most separate them from the rest, their ranges, and the rules. */
function renderGoodShots(club) {
  const data = goodShotData(), c = club ? data.clubs[club] : null, st = data.settings;
  const status = document.getElementById("p-good-status");
  const name = club ? clubName(club).toLowerCase() : "";
  if (!c) {
    status.textContent = club ? `No shots with the ${name} that could be judged (the putter isn't).` : "";
  } else {
    // Why the others weren't, by rule.
    const why = {};
    for (const v of Object.values(c.verdicts)) {
      for (const f of v.fails) { const k = f.split(/[ :]/)[0]; why[k] = (why[k] || 0) + 1; }
    }
    const top = Object.keys(why).sort((a, b) => why[b] - why[a]).map(k => `${k} ${why[k]}`);
    const base = c.baseline;
    status.textContent = `${c.good} good of ${c.shots} shots with the ${name}`
      + (base && base.carry != null ? ` · your median carry ${base.carry.toFixed(0)} yd${base.smash != null ? `, smash ${base.smash.toFixed(2)}` : ""}` : "")
      + (top.length ? ` · not good for: ${top.join(", ")}` : "");
  }
  renderSeparation(c, st.minCount, name);
  renderGoodRanges(c, name);
  renderGoodForm();
}

function renderSeparation(c, minCount, name) {
  const box = document.getElementById("p-good-sep");
  const items = c ? SwingGoodShots.separation(c, minCount) : [];
  const shown = items.filter(x => x.enough).slice(0, GOOD_TOP);
  if (!shown.length) {
    const best = items.reduce((m, x) => Math.max(m, Math.min(x.nGood, x.nRest)), 0);
    const x = items.find(i => Math.min(i.nGood, i.nRest) === best) || { nGood: 0, nRest: 0 };
    box.replaceChildren(Object.assign(document.createElement("div"), { className: "muted",
      textContent: `Not enough swings yet: ${x.nGood} good and ${x.nRest} other shots with the ${name || "club"} have body numbers; `
        + `it takes ${minCount} of each to compare them.` }));
    return;
  }
  const table = document.createElement("table");
  table.className = "p-good-table";
  const head = document.createElement("tr");
  for (const t of ["Number", "Good shots vs the rest", "Effect size (95% CI)", ""]) head.append(Object.assign(document.createElement("th"), { textContent: t }));
  table.append(head);
  // The ones that could be luck only when asked for.
  const strong = shown.filter(x => x.clear), luck = shown.length - strong.length;
  const all = separationAll;
  for (const x of all ? shown : strong) {
    const f = field(x.key);
    const tr = document.createElement("tr");
    const nameTd = Object.assign(document.createElement("td"), { textContent: f.label });
    if (x.shaky) { nameTd.classList.add("shaky"); nameTd.title = "Shaky: most of these numbers are (trust.js)"; }
    const way = x.diff > 0 ? "higher" : "lower";
    const desc = `${SwingGoodShots.amount(x.diff, f.unit)} ${way} (mean ${fmtField(f, x.meanGood)} vs ${fmtField(f, x.meanRest)}; ${x.nGood} vs ${x.nRest} swings)`;
    const gTd = Object.assign(document.createElement("td"), {
      textContent: `${fmtR(x.g)} (${fmtR(x.lo)} to ${fmtR(x.hi)})`,
      title: "Hedges' g: the difference in means in standard deviations. Around 0.2 is small, 0.5 medium, 0.8 large." });
    const bar = document.createElement("td");
    bar.append(ciBar(x.lo, x.g, x.hi));
    const verdict = Object.assign(document.createElement("em"), { textContent: x.clear ? "strong" : "maybe luck" });
    verdict.className = x.clear ? "better" : "muted";
    bar.append(" ", verdict);
    tr.append(nameTd, Object.assign(document.createElement("td"), { textContent: desc }), gTd, bar);
    table.append(tr);
  }
  const kids = strong.length || all ? [table] : [Object.assign(document.createElement("div"), { className: "muted",
    textContent: "No body number clearly sets the good shots apart yet." })];
  if (luck) {
    const more = Object.assign(document.createElement("button"), { className: "small", type: "button",
      textContent: all ? "Hide the ones that could be luck" : `Show ${luck} more that could be luck` });
    more.onclick = () => { separationAll = !all; renderSeparation(c, minCount, name); };
    kids.push(more);
  }
  box.replaceChildren(...kids);
}
let separationAll = false;

/** A confidence interval on a -2..2 scale, with 0 marked. */
function ciBar(lo, g, hi) {
  const svg = svgEl("svg", { viewBox: "0 0 100 12", class: "p-ci", "aria-hidden": "true" });
  const x = v => 50 + Math.max(-2, Math.min(2, v)) * 24;
  svgEl("line", { x1: 50, x2: 50, y1: 0, y2: 12, class: "t-zero" }, svg);
  svgEl("line", { x1: x(lo), x2: x(hi), y1: 6, y2: 6, class: "p-ci-line" }, svg);
  svgEl("circle", { cx: x(g), cy: 6, r: 3, class: "t-dot" }, svg);
  return svg;
}

function renderGoodRanges(c, name) {
  const table = document.getElementById("p-good-ranges");
  const head = document.createElement("tr");
  for (const t of ["Number", "Middle 50%", "Middle 80%", "Shots", ""]) head.append(Object.assign(document.createElement("th"), { textContent: t }));
  const rows = SwingSummary.BODY.map(b => {
    const r = c ? c.ranges[b.key] : null, tr = document.createElement("tr");
    tr.append(Object.assign(document.createElement("td"), { textContent: b.label }));
    if (!r || !r.enough) {
      tr.append(Object.assign(document.createElement("td"), { colSpan: 2, className: "muted", textContent: "not enough good shots yet" }),
                Object.assign(document.createElement("td"), { textContent: `${r ? r.n : 0} of ${r ? r.need : 8}` }), document.createElement("td"));
      return tr;
    }
    const a = Object.assign(document.createElement("td"), { textContent: SwingGoodShots.rangeText(r.q25, r.q75, b.unit) });
    const w = Object.assign(document.createElement("td"), { textContent: SwingGoodShots.rangeText(r.q10, r.q90, b.unit) });
    const note = Object.assign(document.createElement("td"), { textContent: r.reliable ? "" : "range not reliable", title: r.why });
    if (!r.reliable) { a.classList.add("shaky"); w.classList.add("shaky"); note.className = "muted"; }
    tr.append(a, w, Object.assign(document.createElement("td"), { textContent: r.n }), note);
    return tr;
  });
  table.replaceChildren(head, ...rows);
  document.getElementById("p-good-ranges-title").textContent = `Ranges on good shots${name ? " with the " + name : ""}`;
}

/** The rules form: filled from the server's settings, unless it's being edited. */
function renderGoodForm() {
  const form = document.getElementById("p-good-form");
  if (form.contains(document.activeElement)) return;
  const st = SwingGoodShots.withDefaults(goodSettings && goodSettings.settings);
  if (!form.dataset.built) {
    form.dataset.built = "1";
    const strike = Object.assign(document.createElement("label"), { className: "p-good-field" });
    strike.append(Object.assign(document.createElement("input"), { type: "checkbox", id: "pg-strike-on" }),
                  " Strike filter (where on the face, when Square reports it)");
    const fields = GOOD_FIELDS.map(([part, key, label, unit]) => {
      const l = Object.assign(document.createElement("label"), { className: "p-good-field" });
      l.append(label + " ", Object.assign(document.createElement("input"), { id: `pg-${part}-${key}`, inputmode: "decimal", size: 5 }), " " + unit);
      return l;
    });
    const buttons = Object.assign(document.createElement("div"), { className: "t-filters" });
    const save = Object.assign(document.createElement("button"), { className: "small", type: "submit", textContent: "Save rules" });
    const reset = Object.assign(document.createElement("button"), { className: "small", type: "button", textContent: "Back to the defaults" });
    reset.onclick = () => saveGoodSettings(goodSettings ? goodSettings.defaults : SwingGoodShots.DEFAULTS);
    buttons.append(save, reset, Object.assign(document.createElement("span"), { id: "pg-msg" }));
    form.append(...fields.slice(0, 8), strike, ...fields.slice(8), buttons);
    form.onsubmit = e => { e.preventDefault(); saveGoodSettings(readGoodForm()); };
  }
  for (const [part, key] of GOOD_FIELDS) document.getElementById(`pg-${part}-${key}`).value = part ? st[part][key] : st[key];
  document.getElementById("pg-strike-on").checked = st.strike.on;
}

function readGoodForm() {
  const s = { irons: {}, woods: {}, strike: { on: document.getElementById("pg-strike-on").checked } };
  for (const [part, key] of GOOD_FIELDS) {
    const v = Number(document.getElementById(`pg-${part}-${key}`).value.replace(",", "."));
    if (part) s[part][key] = v; else s[key] = v;
  }
  return s;
}

async function saveGoodSettings(s) {
  const msg = document.getElementById("pg-msg");
  try {
    const res = await fetch("/api/goodshots", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) });
    if (!res.ok) throw new Error((await res.json()).detail || res.status);
    goodSettings = await res.json();
    msg.textContent = "Saved.";
  } catch (e) {
    msg.textContent = `Couldn't save: ${e.message}`;
    return;
  }
  document.activeElement.blur();
  await loadTrendData();
  renderTrendView();
}

// ---- Progress: what helps, what hurts (helps.js) ----

// Links listed at most (strong first, then worth trying).
const HELPS_TOP = 15;
// Results worked out in helps.js, shown in Trends as the number they come from.
const HELPS_TREND_FIELD = { absOffline: "offline", absFaceToPath: "faceToPath" };
// How sure, in plain words (helps.js's labels).
const EVIDENCE = { confirmed: "Strong evidence", emerging: "Worth trying" };
const pEl = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});

/**
 * Each move against each result, within the period's sessions with the club, in golf terms, and the
 * practice plan from them: each move to work on once, with the results it goes with. A move pulled
 * both ways by different results is a trade-off, not a drill.
 */
function helpsModel(club, sessions) {
  const input = sessions.map(s => ({ key: s.key, rows: s.rows.map(r => ({ ...r,
    shaky: Object.fromEntries(SwingSummary.BODY.map(f => [f.key, isShaky(r, f)])) })) }));
  const a = SwingHelps.analyze(input);
  const listed = a.links.filter(l => l.label !== "chance");
  const coached = listed.slice(0, HELPS_TOP).map(l => ({ l, c: SwingCoach.coach(l, club) })).filter(x => x.c);
  const byMove = new Map();
  for (const x of coached) {
    if (!x.c.aim) continue;
    const m = byMove.get(x.l.move) || { move: x.l.move, aims: new Set(), items: [] };
    m.aims.add(x.c.aim);
    m.items.push(x);
    byMove.set(x.l.move, m);
  }
  const moves = [...byMove.values()].slice(0, 3).map(m => ({ ...m, tradeOff: m.aims.size > 1, aim: m.items[0].c.aim,
    fix: m.items[0].c.fix, goals: [...new Set(m.items.map(x => x.c.goal))],
    label: m.items.some(x => x.l.label === "confirmed") ? "confirmed" : "emerging" }));
  return { a, listed, coached, moves };
}

/** The evidence under "Why this?": every link, in golf terms, strongest first. */
function renderHelpsEvidence(club, sessions, h) {
  const status = document.getElementById("p-helps-status"), box = document.getElementById("p-helps-list");
  const name = club ? clubName(club).toLowerCase() : "club";
  const { a, listed, coached } = h;
  const counts = ["confirmed", "emerging"].map(k => [EVIDENCE[k].toLowerCase(), listed.filter(l => l.label === k).length]).filter(x => x[1]);
  status.textContent = !a.tested
    ? `not enough swings with body numbers yet: ${a.swings} with the ${name}; a link needs ${SwingHelps.MIN_PAIRS} in sessions of ${SwingHelps.MIN_IN_SESSION} or more.`
    : [`${a.swings} swings in ${a.sessions} session${a.sessions === 1 ? "" : "s"}`,
       counts.length ? counts.map(([k, n]) => `${n} ${k}`).join(", ") : "nothing stands out from chance yet",
       a.sessions < 5 ? "it takes 5 to 10 sessions of 20+ swings to say much" : ""].filter(Boolean).join(" · ");
  const list = pEl("div", "p-links");
  for (const { l, c } of coached) {
    const card = pEl("div", "p-link");
    const head = pEl("div", "p-link-head");
    head.append(pEl("span", `tag ${l.label}`, EVIDENCE[l.label] || l.label));
    if (l.helps != null) head.append(pEl("span", l.helps ? "helps" : "hurts", l.helps ? "Helps" : "Hurts"));
    head.append(pEl("span", null, `${c.when[0].toUpperCase() + c.when.slice(1)} → ${c.then}`));
    if (l.shaky) { head.classList.add("shaky"); head.title = "Shaky: most of the move's numbers are (trust.js)"; }
    card.append(head);
    const sub = pEl("div", "sub", `${SwingHelps.sentence(l)} · ${SwingHelps.support(l)}`);
    sub.title = `r ${fmtR(l.r)}, q ${l.q < 0.001 ? "<0.001" : l.q.toFixed(3)}`
      + (l.between ? ` · between sessions r ${fmtR(l.between.r)} over ${l.between.n}` : "");
    card.append(sub);
    if (!c.fix && c.why) card.append(pEl("div", "muted", c.why[0].toUpperCase() + c.why.slice(1) + "."));
    const see = pEl("button", "small", "See it in Trends");
    see.onclick = () => {
      const latest = sessions[sessions.length - 1];
      if (!latest) return;
      trendPick.x = l.move;
      trendPick.y = HELPS_TREND_FIELD[l.result] || l.result;
      trendPick.club = club;
      savePicks();
      openTrends(latest.key);
    };
    card.append(see);
    list.append(card);
  }
  box.replaceChildren(...(coached.length ? [list] : []));
}

// ---- Progress: my focus (focus.js) ----

async function setFocus(body) {
  try {
    const res = await fetch("/api/journal/focus", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json()).detail || res.status);
  } catch (e) {
    alert(`Couldn't save the focus: ${e.message}`);
    return;
  }
  await loadTrendData();
  renderTrendView();
  if (body.move) document.getElementById("p-focus").scrollIntoView({ block: "nearest" });
}

/** A number as the focus table shows it: a body move by its field, a result by helps.js's unit. */
function focusFmt(key, v) {
  if (v == null) return "–";
  const b = SwingSummary.BODY.find(f => f.key === key);
  if (b) return fmtField(field(key), v) + (b.unit && b.unit !== ":1" ? (b.unit === "°" ? "°" : " " + b.unit) : "");
  const r = SwingHelps.RESULTS.find(x => x.key === key);
  const dec = r && (r.unit === "rpm" ? 0 : r.unit === "" ? 2 : 1);
  return v.toFixed(dec ?? 1) + (r && r.unit ? (r.unit === "°" ? "°" : " " + r.unit) : "");
}
const focusLabel = key => (SwingSummary.BODY.find(f => f.key === key) || SwingHelps.RESULTS.find(r => r.key === key) || { label: key }).label;

/** The range that means "better than my usual" for the move: from the median of the latest swings toward the aim. */
function focusPracticeRange(f) {
  const vals = progressSessions(f.club).flatMap(s => s.rows).reverse().map(r => r[f.move]).filter(v => v != null).slice(0, PR_SUGGEST_N);
  if (vals.length < 5) return null;
  vals.sort((a, b) => a - b);
  const med = quantile(vals, 0.5), spread = quantile(vals, 0.9) - quantile(vals, 0.1);
  const dec = DECIMALS[field(f.move).unit] ?? 1, round = v => Number(v.toFixed(dec));
  return f.aim === "more" ? { min: round(med), max: round(med + 2 * spread) } : { min: round(med - 2 * spread), max: round(med) };
}

/**
 * What the club's good shots say about a move, when they say it clearly: {agree, way} where agree
 * is whether the good shots had more of the move when the aim is more (or less when less).
 */
function goodShotsSay(club, move, aim) {
  const data = goodShotData(), c = club ? data.clubs[club] : null;
  if (!c) return null;
  const minCount = SwingGoodShots.withDefaults(data.settings).minCount;
  const x = SwingGoodShots.separation(c, minCount).find(i => i.key === move && i.enough && i.clear);
  if (!x) return null;
  return { agree: (x.diff > 0) === (aim === "more"), way: x.diff > 0 ? "higher" : "lower", label: lowerFirst(field(move).label) };
}

/** A note when the good shots agree with the move to work on, or point the other way. */
function goodShotsNote(club, move, aim) {
  const g = goodShotsSay(club, move, aim);
  if (!g) return null;
  return g.agree
    ? pEl("div", "p-focus-note agree", `Your good shots agree: they had the ${g.label} ${g.way} than the rest.`)
    : pEl("div", "p-focus-note", `Heads-up: your good shots point the other way (their ${g.label} was ${g.way} than the rest). `
      + "Give it a session or two with the drill and see which way the results go before trusting either.");
}

function badge(label, text) {
  return pEl("span", `p-badge ${label}`, text || EVIDENCE[label] || "");
}

function drillAndThought(fix) {
  const drill = pEl("div"); drill.append(pEl("b", null, "Drill: "), fix.drill);
  const thought = pEl("div"); thought.append(pEl("b", null, "Swing thought: "), `“${fix.thought}”`);
  return [drill, thought];
}

function focusButton(m, club, text) {
  const b = pEl("button", "small", text || "Make this my focus");
  b.onclick = () => setFocus({ move: m.move, aim: m.aim, club, results: [...new Set(m.items.map(x => x.l.result))] });
  return b;
}

/**
 * The card: one thing to work on. The focus when there is one (with how it's going), else the plan's
 * first move; the plan's other moves as alternatives; the evidence folded under "Why this?".
 */
function renderCoach(club, h) {
  const box = document.getElementById("p-focus-body");
  const name = club ? clubName(club).toLowerCase() : "club";
  const f = journal.focus;
  const plan = h.moves.filter(m => !m.tradeOff);
  const kids = [];
  let main = null;   // the plan move shown as the main thing, if any
  if (f && f.club !== club) {
    // The focus is with another club: a pointer to it, then this club's own suggestion.
    const mv = SwingCoach.MOVES[f.move], fix = mv && mv[f.aim], fname = clubName(f.club).toLowerCase();
    const row = pEl("div", "p-alt");
    const go = pEl("button", "small", `Show the ${fname}`);
    go.onclick = () => { progressPick.club = f.club; savePicks(); renderProgress(); };
    row.append(pEl("span", "muted", `Your focus is with the ${fname}: ${fix ? fix.name : focusLabel(f.move)}.`), go);
    kids.push(row);
  }
  if (f && f.club === club) {
    kids.push(...focusBlock(f, club, h));
  } else if (plan.length) {
    main = plan[0];
    const nameEl = pEl("div", "p-focus-name", `Work on ${main.fix.name}`);
    nameEl.append(badge(main.label));
    kids.push(pEl("div", "p-focus-kicker", `Suggested for the ${name}`), nameEl,
      pEl("div", null, `For ${main.goals.join("; ")}. ${main.fix.how}`), ...drillAndThought(main.fix));
    const note = goodShotsNote(club, main.move, main.aim);
    if (note) kids.push(note);
    if (main.label !== "confirmed") kids.push(pEl("div", "muted", "Not proven yet: try it for a session or two and see whether the numbers follow."));
    const buttons = pEl("div", "t-filters");
    buttons.append(focusButton(main, club));
    kids.push(buttons);
  } else {
    kids.push(pEl("div", "p-focus-name", "Nothing to work on yet"),
      pEl("div", "muted", h.a.tested
        ? `No move stands out from chance with the ${name} yet. Keep hitting balls: it takes 5 to 10 sessions of 20+ swings to say much.`
        : `Not enough swings with body numbers with the ${name} yet.`));
  }
  // The plan's other moves.
  const isFocus = m => f && f.move === m.move && f.aim === m.aim && f.club === club;
  const others = plan.filter(m => m !== main && !isFocus(m));
  if (others.length) {
    kids.push(pEl("div", "p-why-sub", main ? "Or" : "The numbers also point to"));
    for (const m of others) {
      const row = pEl("div", "p-alt");
      row.append(pEl("span", null, `Work on ${m.fix.name}`), badge(m.label), focusButton(m, club, f ? "Switch focus to this" : "Make this my focus"));
      kids.push(row);
    }
  }
  const trades = h.moves.filter(m => m.tradeOff);
  if (trades.length) {
    kids.push(pEl("div", "muted", "Keep steady: " + trades.map(m => SwingCoach.MOVES[m.move].what).join("; ")
      + " (it helps one result and hurts another)."));
  }
  box.replaceChildren(...kids);
}

/** The focus: the move, drill and thought, how it's going since it started, and what to do next. */
function focusBlock(f, club, h) {
  const mv = SwingCoach.MOVES[f.move], fix = mv && mv[f.aim];
  const fname = clubName(f.club).toLowerCase();
  const kids = [pEl("div", "p-focus-kicker", `Your focus · ${fname} · since ${new Date(f.since + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}`)];
  const nameEl = pEl("div", "p-focus-name", fix ? `Work on ${fix.name}` : `${focusLabel(f.move)}: ${f.aim}`);
  const m = h.moves.find(x => x.move === f.move && !x.tradeOff && x.aim === f.aim);
  nameEl.append(m ? badge(m.label) : badge("none", "Not in the latest numbers"));
  kids.push(nameEl);
  if (fix) kids.push(...drillAndThought(fix));

  // How it's going, in a sentence; the numbers behind it folded.
  const cmp = SwingFocus.compare(progressSessions(f.club), f);
  const so = pEl("div", "p-focus-so");
  if (!cmp.after) {
    so.textContent = `No sessions with the ${fname} since it started yet: hit some balls with the drill, then look here.`;
    kids.push(so);
  } else {
    so.append(pEl("b", null, `So far (${cmp.after} session${cmp.after === 1 ? "" : "s"}): `));
    const parts = [cmp.move, ...cmp.results].map((x, i) => {
      const span = pEl("span", null, `${i === 0 ? "the move itself" : lowerFirst(focusLabel(x.key))}: ${SwingFocus.verdict(x)}`);
      if ((x.level === "clear" || x.level === "maybe") && x.good != null) span.className = x.good ? "better" : "worse";
      return span;
    });
    parts.forEach((p, i) => so.append(...(i ? ["; ", p] : [p])));
    so.append(".");
    kids.push(so);
    if (cmp.cameraMoved) kids.push(pEl("div", "p-focus-warn", "A camera moved since it started: the move's numbers either side may not compare."));
    const table = pEl("table", "p-focus-table");
    const head = pEl("tr");
    for (const t of ["", "Before", "Since", "Change", ""]) head.append(pEl("th", null, t));
    table.append(head);
    for (const x of [cmp.move, ...cmp.results]) {
      const tr = pEl("tr");
      const cls = x.level === "clear" || x.level === "maybe" ? (x.good === true ? "good" : x.good === false ? "bad" : "") : "muted";
      tr.append(pEl("td", null, (x === cmp.move ? "The move: " : "") + focusLabel(x.key)),
        pEl("td", null, focusFmt(x.key, x.before)), pEl("td", null, focusFmt(x.key, x.after)),
        pEl("td", null, x.change == null ? "–" : (t => x.change > 0 && !t.startsWith("+") ? "+" + t : t)(focusFmt(x.key, x.change))),
        pEl("td", cls, SwingFocus.verdict(x)));
      table.append(tr);
    }
    const nums = pEl("details", "explain");
    nums.append(pEl("summary", null, `The numbers: ${cmp.after} session${cmp.after === 1 ? "" : "s"} since, against ${cmp.before} before`));
    const wrap = pEl("div"); wrap.style.overflowX = "auto"; wrap.append(table);
    nums.append(wrap);
    kids.push(nums);
  }
  const note = goodShotsNote(f.club, f.move, f.aim);
  if (note) kids.push(note);

  const buttons = pEl("div", "t-filters");
  const practiceBtn = pEl("button", "small", "Practice this");
  const range = focusPracticeRange(f);
  practiceBtn.disabled = !range;
  practiceBtn.title = range ? `In range = ${f.aim === "more" ? "more" : "less"} than your usual (${range.min} to ${range.max}); the phone says the swing thought after a swing out of range`
    : "Not enough recent swings with this move to set a range";
  practiceBtn.onclick = async () => {
    const ok = await practiceFromFocus({ metric: f.move, club: f.club, min: range.min, max: range.max, cue: fix ? fix.thought : "" });
    if (!ok) alert("Practice mode can't speak this move (the face-on turns aren't reliable enough one swing at a time).");
  };
  const end = pEl("button", "small", "End this focus");
  end.onclick = () => { if (confirm("End this focus? It stays in the history.")) setFocus({ move: null }); };
  buttons.append(practiceBtn, end);
  kids.push(buttons);
  const past = (journal.focuses || []).slice(-3).reverse();
  if (past.length) {
    kids.push(pEl("div", "muted", "Before: " + past.map(p => `${(SwingCoach.MOVES[p.move] || {})[p.aim]?.name || p.move} (${p.since} to ${p.until})`).join("; ")));
  }
  return kids;
}

/** The card: bag mapping across all clubs hit in the period. */
function renderGapping() {
  if (typeof SwingGapping === "undefined") return;
  const box = document.getElementById("p-gapping-chart");
  const status = document.getElementById("p-gapping-status");
  if (!box) return;
  const allRows = shownClips().filter(c => !c.excluded).map(swingRow);
  const days = Number(progressPick.period);
  const since = days ? Date.now() - days * 86400000 : -Infinity;
  const analysis = SwingGapping.analyze(allRows, { since, clubNameFn: clubName });
  if (status) {
    const mapped = analysis.clubs.filter(c => c.enough).length;
    const parts = [
      `${analysis.clubs.length} club${analysis.clubs.length === 1 ? "" : "s"} (${mapped} mapped)`,
      `${analysis.totalShots} shot${analysis.totalShots === 1 ? "" : "s"}`,
    ];
    const overlaps = analysis.clubs.filter(c => c.gapFlag === "overlap").length;
    const bigGaps = analysis.clubs.filter(c => c.gapFlag === "big gap").length;
    if (overlaps) parts.push(`${overlaps} overlap${overlaps === 1 ? "" : "s"}`);
    if (bigGaps) parts.push(`${bigGaps} big gap${bigGaps === 1 ? "" : "s"}`);
    status.textContent = parts.join(" · ");
  }
  SwingGapping.render(box, analysis, {
    selectedClub: progressPick.club,
    onSelectClub: c => {
      progressPick.club = c;
      savePicks();
      renderProgress();
    },
  });
}

/** The card: each wedge's carry with a half, three-quarter and full swing (wedges.js). */
function renderWedges() {
  if (typeof SwingWedges === "undefined") return;
  const allRows = shownClips().filter(c => !c.excluded).map(swingRow);
  const days = Number(progressPick.period);
  const since = days ? Date.now() - days * 86400000 : -Infinity;
  const a = SwingWedges.analyze(allRows, { since, clubNameFn: clubName });
  document.getElementById("p-wedges-status").textContent = a.wedges.length
    ? `${a.wedges.length} wedge${a.wedges.length === 1 ? "" : "s"} · ${a.shots} shots` : "no wedge shots in this period";
  if (foldOpen("wedges")) SwingWedges.render(document.getElementById("p-wedges-table"), a);
}

// Charts are drawn to their width.
let viewWidth = 0;
new ResizeObserver(() => {
  const w = (trendsKey ? trendsBox : progressBox).clientWidth;
  if ((trendsKey || progressOpen) && w !== viewWidth) { viewWidth = w; renderTrendView(); }
}).observe(document.querySelector("main"));
