// Analysis's own views: What goes with what (one number against another, every swing a dot), Links at a
// glance (every move against every result), Over time, and One session (its swings, each one tap from
// its video). The other Analysis cards are Progress's, drawn in trends.js; Ball flight and Spread are
// drawn by flightgrid.js and distro.js. The numbers are explore.js's (SwingExplore) and helps.js's.
// Uses trends.js's globals (FIELDS, field, progressSessions, drawOverTime, svgEl, axes, placeTip...).
// One club at a time, or one club type (irons with irons, woods with woods: never the two together).

const aPick = { x: "handsPlaneP6", y: "carry", mode: "raw", color: "good", scope: "club", ot: "carry", seq: "carry",
                spread: "carry", sort: "order", dir: 1 };
try { Object.assign(aPick, JSON.parse(localStorage.getItem("analysis") || "{}")); } catch {}
const aSave = () => { try { localStorage.setItem("analysis", JSON.stringify(aPick)); } catch {} };

// Numbers worked out from Square's (explore.js), and a session's scores (sessionscore.js), as fields.
const A_EXTRA = SwingExplore.EXTRA.map(f => ({ key: f.key, label: f.label, unit: f.unit, group: "Launch monitor", shot: true,
                                               dec: DECIMALS[f.unit] ?? 1 }));
const A_RATES = [["goodRate", "Good shots"], ["onLineRate", "On line"], ["solidRate", "Solid strikes"]]
  .map(([key, label]) => ({ key, label, unit: "%", dec: 0, shot: true, group: "Session score",
    session: rows => { const v = aScore(rows)[key]; return v == null ? null : { med: v * 100, n: rows.length }; } }));
const aField = key => A_EXTRA.find(f => f.key === key) || A_RATES.find(f => f.key === key) || field(key);
const aShotFields = () => [...FIELDS.filter(f => f.shot), ...A_EXTRA];
const aBodyFields = () => FIELDS.filter(f => !f.shot && f.key !== "order");
const aLower = t => t.charAt(0).toLowerCase() + t.slice(1);

/** A number with its unit ("152.3 yd", "-2.1°"); `delta`: a difference, signed. */
function aNum(f, v, delta) {
  if (v == null) return "–";
  const n = v.toFixed(f.dec).replace(/^-(0(\.0+)?)$/, "$1");
  return (delta && v > 0 && Number(n) !== 0 ? "+" : "") + (f.unit === ":1" ? n : f.unit === "°" || f.unit === "%" ? n + f.unit : f.unit ? `${n} ${f.unit}` : n);
}

const aScore = rows => SwingSessionScore.score(rows, { clubs: goodShotData().clubs, name: r => r.c.name,
                                                       settings: goodSettings && goodSettings.settings });
const aSince = () => { const days = Number(progressPick.period); return days ? Date.now() - days * 86400000 : -Infinity; };

// The sessions Analysis is drawn from: the picked club's, in the period (set by renderAnalysis).
let aCtx = { sessions: [], club: null };

/** Each row gets its worked-out numbers, its good-shot verdict, its session and its place in it. */
function aDecorate(sessions) {
  const data = goodShotData();
  for (const s of sessions) {
    s.rows.forEach((r, i) => {
      Object.assign(r, SwingExplore.derive(r));
      const v = data.clubs[r.club] && data.clubs[r.club].verdicts[r.name];
      r.good = v ? v.good : null;
      r.fails = v && !v.good ? v.fails : null;
      r.sKey = s.key;
      r.order = i + 1;
    });
  }
  return sessions;
}

let aGroupCache = { sig: null, value: null };
/** Every session of a club type (irons / woods) in the period, decorated. */
function aGroupSessions(group) {
  const sig = `${dataSig}|${clips.length}|${group}|${progressPick.period}|${leaveOutShaky}`;
  if (aGroupCache.sig !== sig) aGroupCache = { sig, value: aDecorate(progressSessions(group).filter(s => s.start >= aSince())) };
  return aGroupCache.value;
}

/** Called by renderProgress when Analysis is open: draws the card on show. */
function renderAnalysis(sessions, club) {
  aCtx = { sessions: aDecorate(sessions), club };
  aRenderCard();
}

function aRenderCard() {
  if (!analysisOpen) return;
  const draw = { explore: renderExplore, links: renderLinks, overtime: renderOverTimeCard, session: renderSessionCard,
                 flight: renderFlight, spread: renderSpread }[analysisCard];
  if (draw) draw();
}

// Ball flight and Spread show on the rail once their scripts are there.
document.querySelector('#a-rail button[data-card="flight"]').hidden = typeof SwingFlightGrid === "undefined";
document.querySelector('#a-rail button[data-card="spread"]').hidden = typeof SwingDistro === "undefined";

// ---- From Analysis to a swing, and back ----

/** Opens a swing from Analysis; "Back to Analysis" on the swing returns to the same card. */
function openFromAnalysis(name) {
  const back = { card: analysisCard, session: analysisSession, scroll: analysisBox.scrollTop };
  open(name);
  analysisReturn = back;
  document.getElementById("a-back").hidden = false;
}
document.getElementById("a-back").onclick = async () => {
  const back = analysisReturn;
  if (!back) return;
  analysisSession = back.session;
  analysisCard = back.card;
  await openAnalysis();
  analysisBox.scrollTop = back.scroll;
};

/** Opens one session's swings in Analysis; `from`: the card to go back to. */
function openAnalysisSession(key, from) {
  analysisSession = { key, from: from || (analysisSession && analysisSession.from) || "sessions" };
  selectAnalysisCard("session");
  analysisBox.scrollTop = 0;
}

// ---- The swings behind a part of a chart ----

const A_PICKED_MAX = 80;
/** Lists swings under the cards: `cols` are extra fields to show beside carry, offline and smash. */
function aShowPicked(rows, title, cols = []) {
  const box = document.getElementById("a-picked");
  const fields = [...new Set(["carry", "offline", "smash", ...cols])].map(aField);
  const clubs = new Set(rows.map(r => r.club)).size > 1;
  const head = document.createElement("tr");
  for (const t of ["When", ...(clubs ? ["Club"] : []), "Shot", ...fields.map(fieldName)]) head.append(pEl("th", null, t));
  const sorted = [...rows].sort((a, b) => b.t - a.t);
  const body = sorted.slice(0, A_PICKED_MAX).map(r => {
    const tr = document.createElement("tr");
    tr.append(pEl("td", null, `${dayOf(r.t)} ${timeOf(r)}`));
    if (clubs) tr.append(pEl("td", "l", clubName(r.club)));
    tr.append(aVerdictCell(r));
    for (const f of fields) tr.append(pEl("td", null, f.shot ? fmtField(f, r[f.key]) : aNum(f, r[f.key])));
    tr.onclick = () => openFromAnalysis(r.c.name);
    return tr;
  });
  const thead = document.createElement("thead"), tbody = document.createElement("tbody");
  thead.append(head);
  tbody.append(...body);
  document.getElementById("a-picked-table").replaceChildren(thead, tbody);
  document.getElementById("a-picked-title").textContent = title;
  document.getElementById("a-picked-note").textContent = `${rows.length} swing${rows.length === 1 ? "" : "s"}`
    + (rows.length > A_PICKED_MAX ? `, the newest ${A_PICKED_MAX} shown` : "") + " · tap one to open it";
  box.hidden = false;
  box.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
document.getElementById("a-picked-close").onclick = () => {
  document.getElementById("a-picked").hidden = true;
  aSel = null;
  aRenderCard();
};

/** "Good" or "Miss" (why on hover), or empty when the shot couldn't be judged. */
function aVerdictCell(r) {
  const td = pEl("td", "l" + (r.good ? " good" : ""), r.good == null ? "" : r.good ? "Good" : "Miss");
  if (r.fails && r.fails.length) td.title = r.fails.join("; ");
  return td;
}

// ---- A chart of dots ----

let aClipN = 0;
/**
 * One dot per point in box (.a-chart: an svg and a .tip). The nearest dot to the pointer shows its
 * numbers; a tap opens it.
 * @param pts [{x, y, row, cls}]
 * @param o {fx, fy: fields (titles, formats), delta: values are differences, xTick(v), line: {mx, my, slope},
 *   under(ctx): drawn below the dots, sel: Set of row names kept bright, onOpen(row), tip(p): {lines, foot},
 *   height, xRange, yRange, robust: a few far-off swings don't set the scale (they're drawn at the edge)}
 * @returns how many points are off the chart (drawn at its edge)
 */
function aScatter(box, pts, o) {
  const svg = box.querySelector("svg"), tip = box.querySelector(".tip");
  const W = Math.max(280, svg.clientWidth || 600), H = o.height || 340, m = { l: 52, r: 16, t: 24, b: 44 };
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("aria-label", `${fieldName(o.fy)} against ${fieldName(o.fx)}, one dot per swing`);
  svg.replaceChildren();
  tip.hidden = true;
  // The scale from the middle 96% of the swings and a margin, so one topped shot doesn't squash the rest.
  const span = vs => {
    if (!o.robust || vs.length < 20) return padded(vs);
    const s = [...vs].sort((a, b) => a - b), lo = quantile(s, 0.02), hi = quantile(s, 0.98), d = (hi - lo) * 0.35 || 1;
    return padded([Math.max(s[0], lo - d), Math.min(s[s.length - 1], hi + d)]);
  };
  const X = niceTicks(...(o.xRange || span(pts.map(p => p.x)))), Y = niceTicks(...(o.yRange || span(pts.map(p => p.y))));
  const within = (v, A) => Math.max(A.lo, Math.min(A.hi, v));
  const sx = v => m.l + (within(v, X) - X.lo) / (X.hi - X.lo) * (W - m.l - m.r);
  const sy = v => H - m.b - (within(v, Y) - Y.lo) / (Y.hi - Y.lo) * (H - m.t - m.b);
  const off = pts.filter(p => p.x < X.lo || p.x > X.hi || p.y < Y.lo || p.y > Y.hi).length;
  axes(svg, W, H, m, X, Y, sx, sy, o.xTick || (v => v.toFixed(X.dec)));
  const vs = o.delta ? " vs that day's usual" : "";
  svgEl("text", { x: m.l, y: 12, class: "t-title" }, svg).textContent = fieldName(o.fy) + vs;
  svgEl("text", { x: W - m.r, y: H - 6, "text-anchor": "end", class: "t-title" }, svg).textContent = fieldName(o.fx) + vs;
  if (!pts.length) {
    svgEl("text", { x: (m.l + W - m.r) / 2, y: H / 2, "text-anchor": "middle", class: "t-axis" }, svg).textContent = "No swings with both numbers";
    return 0;
  }
  // Lines and bands stay inside the plot.
  const clip = `a-clip-${++aClipN}`;
  svgEl("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b }, svgEl("clipPath", { id: clip }, svgEl("defs", {}, svg)));
  const under = svgEl("g", { "clip-path": `url(#${clip})` }, svg);
  if (o.under) o.under({ g: under, sx, sy, X, Y, W, H, m });
  if (o.line && o.line.slope != null) {
    const at = x => o.line.my + o.line.slope * (x - o.line.mx);
    const a = Math.max(X.lo, Math.min(...pts.map(p => p.x))), b = Math.min(X.hi, Math.max(...pts.map(p => p.x)));
    const yAt = v => H - m.b - (v - Y.lo) / (Y.hi - Y.lo) * (H - m.t - m.b);
    svgEl("line", { x1: sx(a), x2: sx(b), y1: yAt(at(a)), y2: yAt(at(b)), class: "t-fit" }, under);
  }
  // The colored dots on top of the grey ones.
  const order = [...pts].sort((p, q) => p.cls.startsWith("a-good") - q.cls.startsWith("a-good"));
  for (const p of order) {
    const dim = o.sel && !o.sel.has(p.row.name) ? " a-dim" : "";
    svgEl("circle", { cx: sx(p.x), cy: sy(p.y), r: o.r || 4.5, class: p.cls + dim }, svg);
  }
  if (o.over) o.over({ g: svg, sx, sy, X, Y, W, H, m });
  const ring = svgEl("circle", { r: 8, class: "t-ring", visibility: "hidden" }, svg);
  const pad = svgEl("rect", { x: m.l - 10, y: m.t - 10, width: W - m.l - m.r + 20, height: H - m.t - m.b + 20, class: "t-hit" }, svg);
  const nearest = e => {
    const b = svg.getBoundingClientRect(), px = (e.clientX - b.left) * W / b.width, py = (e.clientY - b.top) * H / b.height;
    let best = null, d = 28 * 28;
    for (const p of pts) {
      if (o.sel && !o.sel.has(p.row.name)) continue;
      const q = (sx(p.x) - px) ** 2 + (sy(p.y) - py) ** 2;
      if (q < d) { d = q; best = p; }
    }
    return best;
  };
  const hide = () => { ring.setAttribute("visibility", "hidden"); tip.hidden = true; pad.style.cursor = "default"; };
  pad.addEventListener("pointermove", e => {
    const p = nearest(e);
    if (!p) return hide();
    pad.style.cursor = "pointer";
    ring.setAttribute("cx", sx(p.x)); ring.setAttribute("cy", sy(p.y)); ring.setAttribute("visibility", "visible");
    const b = svg.getBoundingClientRect(), c = box.getBoundingClientRect(), t = o.tip(p);
    placeTip(tip, t.lines, t.foot, box, b.left - c.left + sx(p.x) * b.width / W, b.top - c.top + sy(p.y) * b.height / H);
  });
  pad.addEventListener("pointerleave", hide);
  pad.addEventListener("click", e => { const p = nearest(e); if (p && o.onOpen) o.onOpen(p.row); });
  return off;
}

/** A swing's line under a tooltip: when, the club when clubs are mixed, good or why not. */
function aSwingFoot(r, withClub) {
  return [`${dayOf(r.t)} ${timeOf(r)}`, withClub && r.club ? clubName(r.club) : "",
          r.good == null ? "" : r.good ? "good shot" : "not a good shot"].filter(Boolean).join(" · ");
}

function aLegend(el, items) {
  el.replaceChildren(...items.map(([cls, text]) => {
    const s = document.createElement("span");
    s.append(Object.assign(document.createElement("i"), { className: "p-key " + cls }), text);
    return s;
  }));
}

function aChips(el, items, onPick) {
  el.replaceChildren(...items.map(it => {
    const b = Object.assign(document.createElement("button"), { className: "small", type: "button", textContent: it.name });
    b.classList.toggle("on", !!it.on);
    if (it.title) b.title = it.title;
    b.onclick = () => onPick(it);
    return b;
  }));
}

// ---- What goes with what ----

let aSel = null;          // row names kept bright on the explorer (a third's swings), or null
let aRankAll = false;

const A_LOOKS = [
  { name: "Club speed into ball speed", x: "clubSpeed", y: "ballSpeed", title: "How much of your speed reaches the ball: the dashed lines are smash" },
  { name: "Face and path", x: "path", y: "face", title: "Where the face pointed against where the club was travelling: what makes the ball curve" },
  { name: "Strike and smash", x: "strikeOff", y: "smash", title: "What a strike away from the middle costs" },
  { name: "Start line and curve", x: "direction", y: "spinAxis", title: "Where the ball started against how it curved" },
  { name: "Attack angle and launch", x: "attack", y: "launch" },
];

function aSetExplore(change) {
  Object.assign(aPick, change);
  aSel = null;
  document.getElementById("a-picked").hidden = true;
  aSave();
  renderExplore();
}
document.getElementById("a-ex-y").onchange = e => aSetExplore({ y: e.target.value });
document.getElementById("a-ex-x").onchange = e => aSetExplore({ x: e.target.value });
for (const b of document.querySelectorAll("#a-ex-mode button")) b.onclick = () => aSetExplore({ mode: b.dataset.mode });
for (const b of document.querySelectorAll("#a-ex-color button")) b.onclick = () => aSetExplore({ color: b.dataset.color });

function renderExplore() {
  const { club } = aCtx;
  const group = SwingGoodShots.groupOf(club);
  const pooled = aPick.scope === "group" && !!group;
  const sessions = pooled ? aGroupSessions(group) : aCtx.sessions;
  // Several clubs only compare against each one's own usual.
  const mode = pooled ? "day" : aPick.mode;
  const rows = sessions.flatMap(s => s.rows);
  let fx = aField(aPick.x), fy = aField(aPick.y);
  if (fy.key === "order") fy = aField("carry");
  if (fx.key === "order" || fx.key === fy.key) fx = aField(fy.key === "handsPlaneP6" ? "earlyExt" : "handsPlaneP6");

  // The controls.
  const bodyGroups = byGroup(["Face-on", "Down the line"]);
  fillSelect(document.getElementById("a-ex-y"), [["Launch monitor", aShotFields()], ...bodyGroups], fy.key);
  fillSelect(document.getElementById("a-ex-x"), [...bodyGroups, ["Launch monitor", aShotFields()]], fx.key);
  aChips(document.getElementById("a-ex-outcomes"),
    SwingExplore.OUTCOMES.map(o => ({ ...o, on: o.key === fy.key, title: fieldName(aField(o.key)) })), o => aSetExplore({ y: o.key }));
  aChips(document.getElementById("a-ex-looks"),
    A_LOOKS.map(l => ({ ...l, on: l.x === fx.key && l.y === fy.key })), l => aSetExplore({ x: l.x, y: l.y }));
  const scope = document.getElementById("a-ex-scope");
  scope.replaceChildren(...[["club", club ? clubName(club) : "This club"],
    ["group", group === "woods" ? "Driver, woods and hybrids" : "All irons and wedges"]].map(([key, text]) => {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: text });
    b.classList.toggle("on", (pooled ? "group" : "club") === key);
    b.onclick = () => aSetExplore({ scope: key });
    return b;
  }));
  scope.hidden = !group;
  for (const b of document.querySelectorAll("#a-ex-mode button")) {
    b.classList.toggle("on", b.dataset.mode === mode);
    b.disabled = pooled && b.dataset.mode === "raw";
  }
  for (const b of document.querySelectorAll("#a-ex-color button")) b.classList.toggle("on", b.dataset.color === aPick.color);

  const groupOf = r => r.sKey + "|" + r.club;
  const raw = SwingExplore.points(rows, fx.key, fy.key, groupOf);
  const pts = mode === "day" ? SwingExplore.centered(raw) : raw;
  const fit = mode === "day" ? SwingExplore.fitWithin(raw) : SwingExplore.fit(raw);
  const latest = sessions.length ? sessions[sessions.length - 1].key : null;
  const shaky = r => isShaky(r, fx) || isShaky(r, fy);
  const lit = r => aPick.color === "latest" ? r.sKey === latest : r.good === true;
  for (const p of pts) p.cls = (lit(p.row) ? "a-good" : "a-miss") + (shaky(p.row) ? " hollow" : "");

  document.getElementById("a-ex-status").textContent = [pooled ? scope.lastChild.textContent : club ? clubName(club) : "",
    `${pts.length} swing${pts.length === 1 ? "" : "s"} with both numbers`,
    `${new Set(pts.map(p => p.row.sKey)).size} sessions`].filter(Boolean).join(" · ");

  const delta = mode === "day";
  const off = aScatter(document.getElementById("a-ex-chart"), pts, {
    fx, fy, delta, sel: aSel, robust: true, line: fit.r != null ? fit : null,
    under: ctx => exploreGuides(ctx, fx, fy, delta, pooled ? null : club, group),
    onOpen: r => openFromAnalysis(r.c.name),
    tip: p => ({
      lines: [[aNum(fy, p.y, delta) + (isShaky(p.row, fy) ? " ~" : ""), fy.label + (delta ? " vs usual" : "")],
              [aNum(fx, p.x, delta) + (isShaky(p.row, fx) ? " ~" : ""), fx.label + (delta ? " vs usual" : "")]],
      foot: aSwingFoot(p.row, pooled),
    }),
  });
  aLegend(document.getElementById("a-ex-legend"), [
    ...(aPick.color === "latest"
      ? [["p-latest", latest ? `Newest session (${dayOf(sessions[sessions.length - 1].start)})` : "Newest session"], ["a-key-miss", "Earlier sessions"]]
      : [["p-latest", "Good shots"], ["a-key-miss", "The rest"]]),
    ...(pts.some(p => shaky(p.row)) ? [["a-key-hollow", "Shaky number"]] : []),
  ]);
  if (off) document.getElementById("a-ex-legend").append(pEl("span", null, `${off} far-off swing${off === 1 ? "" : "s"} drawn at the edge`));

  // What the fit says, both ways of taking it.
  const stat = document.getElementById("a-ex-r");
  stat.replaceChildren();
  const line = (f, lead) => {
    const d = document.createElement("div");
    if (lead) d.className = "muted";
    if (f.r == null) { d.textContent = (lead || "") + `${f.n} swing${f.n === 1 ? "" : "s"} with both numbers: too few to say anything.`; return d; }
    const span = pEl("span", "muted", ` · ${f.n} swings · ${f.clear ? "stands out from chance" : "could be chance"} (needs ±${f.needed.toFixed(2)})`);
    d.append(lead || "", pEl("b", null, `r = ${fmtR(f.r)}`), ` · ${SwingExplore.words(f, fx.label, fy.label)}`, span);
    return d;
  };
  stat.append(line(fit, ""));
  const eff = fit.clear ? SwingExplore.effect(fit) : null;
  if (eff) {
    stat.append(pEl("div", null, `Each ${aNum(fx, eff.step)} more ${aLower(fx.label)}${delta ? " than your usual that day" : ""}: `
      + `${aLower(fy.label)} ${aNum(fy, eff.change, true)}.`));
  }
  if (!pooled) {
    const other = mode === "day" ? SwingExplore.fit(raw) : SwingExplore.fitWithin(raw);
    stat.append(line(other, mode === "day" ? "As measured: " : "Against that day's usual: "));
    const day = mode === "day" ? fit : other, meas = mode === "day" ? other : fit;
    if (meas.clear && !day.clear) {
      stat.append(pEl("div", "muted", "Take care: inside a session the link fades, so it may come from days differing (warm-up, where the cameras stood), not from the swing."));
    }
  }

  renderExploreThirds(pts, fx, fy, delta);
  renderExploreRank(rows, fx, fy, groupOf);
}

/** Guide lines for pairs that have them: smash lines, face square to path, your good-shot range. */
function exploreGuides({ g, sx, sy, X, Y }, fx, fy, delta, club, group) {
  if (delta) return;
  const label = (x, y, text, anchor) => svgEl("text", { x, y, class: "a-ref-label", "text-anchor": anchor || "start" }, g).textContent = text;
  if (fx.key === "clubSpeed" && fy.key === "ballSpeed") {
    for (const k of group === "woods" ? [1.3, 1.4, 1.5] : [1.2, 1.3, 1.4]) {
      svgEl("line", { x1: sx(X.lo), y1: sy(X.lo * k), x2: sx(X.hi), y2: sy(X.hi * k), class: "a-ref" }, g);
      // The label where the line leaves the plot: its right end, or the top.
      const xe = Math.min(X.hi, Y.hi / k);
      label(sx(xe) - 4, sy(xe * k) + 12, `smash ${k.toFixed(1)}`, "end");
    }
  } else if (fx.key === "path" && fy.key === "face") {
    const lo = Math.max(X.lo, Y.lo), hi = Math.min(X.hi, Y.hi);
    if (hi > lo) {
      svgEl("line", { x1: sx(lo), y1: sy(lo), x2: sx(hi), y2: sy(hi), class: "a-ref" }, g);
      label(sx(hi) - 4, sy(hi) + 14, "face square to path: no curve", "end");
    }
    label(sx(X.lo) + 6, sy(Y.hi) + 14, "face open to the path: fades");
    label(sx(X.hi) - 6, sy(Y.lo) - 6, "face closed to the path: draws", "end");
  }
  // The middle half of this number on your good shots with the club (goodshots.js).
  const range = club && !fx.shot ? goodRange(club, fx.key) : null;
  if (range && range.enough) {
    svgEl("rect", { x: sx(range.q25), y: sy(Y.hi), width: Math.max(0, sx(range.q75) - sx(range.q25)), height: sy(Y.lo) - sy(Y.hi), class: "a-band" }, g);
    label(sx(range.q25) + 4, sy(Y.hi) + 12, "your good shots");
  }
}

/** The result in the lowest, middle and highest third of the bottom number. */
function renderExploreThirds(pts, fx, fy, delta) {
  const table = document.getElementById("a-ex-bins"), title = document.getElementById("a-ex-bins-title");
  const parts = SwingExplore.parts(pts, 3);
  title.hidden = table.hidden = parts.length < 2;
  if (parts.length < 2) return;
  title.replaceChildren(`${fy.label} in each third of ${aLower(fx.label)}`, pEl("span", "note", "tap a row to list its swings"));
  const names = parts.length === 3 ? ["Lowest third", "Middle third", "Highest third"] : ["Lower half", "Upper half"];
  const lo = Math.min(...parts.map(p => p.q1)), hi = Math.max(...parts.map(p => p.q3)), w = hi - lo || 1;
  const head = document.createElement("tr");
  for (const t of [fx.label, "Swings", `${fy.label}: median and middle half`, "", "Good shots"]) head.append(pEl("th", null, t));
  const judged = parts.some(p => p.judged >= 3);
  if (!judged) head.lastChild.remove();
  const body = parts.map((p, i) => {
    const tr = document.createElement("tr");
    const names3 = new Set(p.rows.map(r => r.name));
    tr.classList.toggle("on", !!aSel && aSel.size === names3.size && [...names3].every(n => aSel.has(n)));
    const bar = pEl("span", "a-barcell"), mid = document.createElement("i"), tick = document.createElement("s");
    mid.style.left = `${(p.q1 - lo) / w * 100}%`;
    mid.style.width = `${Math.max(2, (p.q3 - p.q1) / w * 100)}%`;
    tick.style.left = `${(p.med - lo) / w * 100}%`;
    bar.append(mid, tick);
    const cell = pEl("td", "l");
    cell.append(bar, pEl("b", null, aNum(fy, p.med, delta)));
    tr.append(pEl("td", null, `${names[i]}: ${aNum(fx, p.lo, delta)} to ${aNum(fx, p.hi, delta)}`), pEl("td", null, `${p.n}`), cell,
      pEl("td", null, `${aNum(fy, p.q1, delta)} to ${aNum(fy, p.q3, delta)}`));
    if (judged) tr.append(pEl("td", null, p.judged >= 3 ? `${Math.round(p.good / p.judged * 100)}%` : "–"));
    tr.onclick = () => {
      aSel = names3;
      renderExplore();
      aShowPicked(p.rows, `${names[i]} of ${aLower(fx.label)}`, [fx.key, fy.key]);
    };
    return tr;
  });
  const thead = document.createElement("thead"), tbody = document.createElement("tbody");
  thead.append(head);
  tbody.append(...body);
  table.replaceChildren(thead, tbody);
}

const A_RANK_TOP = 8;
/** Every number on the other side (body against launch monitor), ranked by how closely it goes with fy inside sessions. */
function renderExploreRank(rows, fx, fy, groupOf) {
  const others = fy.shot ? aBodyFields() : aShotFields();
  document.getElementById("a-ex-rank-title").replaceChildren(`What goes with ${aLower(fy.label)}`,
    pEl("span", "note", "each swing against that day's usual · tap one to chart it"));
  const ranked = others.map(f => ({ f, ...SwingExplore.fitWithin(SwingExplore.points(rows, f.key, fy.key, groupOf)) }))
    .map(x => ({ ...x, r: x.n >= SwingExplore.MIN_POINTS ? x.r : null }))
    .sort((a, b) => (b.r == null ? -1 : Math.abs(b.r)) - (a.r == null ? -1 : Math.abs(a.r)));
  const shown = aRankAll ? ranked : ranked.slice(0, A_RANK_TOP);
  const box = document.getElementById("a-ex-rank");
  box.replaceChildren(...shown.map(x => {
    const row = document.createElement("button");
    row.className = "t-row" + (x.f.key === fx.key ? " cur" : "") + (x.r == null ? " none" : "");
    const name = pEl("span", null, x.f.label);
    if (x.clear) name.append(pEl("em", null, "stands out"));
    const bar = pEl("span", "t-bar");
    if (x.r != null) {
      const fill = document.createElement("i"), tick = document.createElement("s");
      fill.style.width = `${Math.abs(x.r) * 100}%`;
      fill.classList.toggle("out", x.clear);
      tick.style.left = `${Math.min(1, x.needed) * 100}%`;
      bar.append(fill, tick);
    }
    row.title = x.r == null ? `Too few swings have ${aLower(x.f.label)}` : `${x.n} swings in ${x.groups} sessions`;
    row.append(name, pEl("span", "r", x.r == null ? "–" : fmtR(x.r)), bar);
    row.onclick = () => { aSetExplore({ x: x.f.key }); document.getElementById("a-ex-chart").scrollIntoView({ block: "nearest" }); };
    return row;
  }));
  if (ranked.length > A_RANK_TOP) {
    const more = Object.assign(document.createElement("button"), { className: "small", type: "button",
      textContent: aRankAll ? "Show fewer" : `Show all ${ranked.length}` });
    more.onclick = () => { aRankAll = !aRankAll; renderExplore(); };
    box.append(more);
  }
}

// ---- Links at a glance ----

// The results across the top (helps.js RESULTS keys).
const A_LINK_RESULTS = ["carry", "ballSpeed", "smash", "clubSpeed", "absOffline", "absFaceToPath", "path", "face", "attack", "strikeH", "strikeV"];
const A_LINK_NAMES = { absOffline: "Offline, either side", absFaceToPath: "Curve, either way", strikeH: "Strike heel/toe", strikeV: "Strike high/low" };

let aLinksCache = { sig: null, value: null };
function aLinks() {
  const { sessions, club } = aCtx;
  const sig = `${dataSig}|${clips.length}|${club}|${progressPick.period}|${leaveOutShaky}`;
  if (aLinksCache.sig === sig) return aLinksCache.value;
  const input = sessions.map(s => ({ key: s.key, start: s.start, rows: s.rows.map(r => ({ ...r,
    shaky: Object.fromEntries(SwingSummary.BODY.map(f => [f.key, isShaky(r, f)])) })) }));
  aLinksCache = { sig, value: SwingHelps.analyze(input) };
  return aLinksCache.value;
}

/** A link in plain words: "Each 1 in more hands to plane in the downswing than your usual that day: carry 2.3 yd shorter". */
function aLinkSentence(l) {
  const mv = field(l.move), rs = SwingHelps.RESULTS.find(r => r.key === l.result);
  const amount = aNum({ unit: rs.unit, dec: DECIMALS[rs.unit] ?? 1 }, Math.abs(l.effect));
  return `Each ${aNum(mv, Number(l.step.toPrecision(3)))} more ${aLower(mv.label)} than your usual that day: `
    + `${aLower(A_LINK_NAMES[rs.key] || rs.label)} ${amount} ${l.effect >= 0 ? rs.more : rs.less}`;
}

function renderLinks() {
  const { club } = aCtx;
  const a = aLinks();
  const moves = aBodyFields(), results = A_LINK_RESULTS.map(k => SwingHelps.RESULTS.find(r => r.key === k));
  const rows = SwingExplore.grid(a.links, moves.map(f => f.key), A_LINK_RESULTS).filter(r => r.cells.some(Boolean));
  const shownLinks = rows.flatMap(r => r.cells).filter(l => l && l.label !== "chance");
  const strong = shownLinks.filter(l => l.label === "confirmed").length;
  document.getElementById("a-links-status").textContent = !rows.length
    ? `Not enough swings with the ${club ? clubWords(club) : "club"} in this period yet (it takes ${SwingHelps.MIN_PAIRS} with both numbers).`
    : `${club ? clubName(club) : ""} · ${a.swings} swings in ${a.sessions} sessions · ${strong} strong, ${shownLinks.length - strong} worth a look`;
  const wrap = document.getElementById("a-links-wrap"), box = document.getElementById("a-links-grid"), tip = wrap.querySelector(".tip");
  box.replaceChildren();
  tip.hidden = true;
  document.getElementById("a-links-legend").replaceChildren();
  document.getElementById("a-links-note").textContent = "";
  if (!rows.length) return;

  const lw = 250, cw = 46, ch = 24, top = 96, W = lw + cw * results.length + 8, H = top + ch * rows.length + 6;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img",
    "aria-label": "Each body move against each result: how closely they go together" }, box);
  results.forEach((rs, j) => {
    const x = lw + cw * j + cw / 2;
    const t = svgEl("text", { x, y: top - 8, class: "a-col-label", transform: `rotate(-40 ${x} ${top - 8})` }, svg);
    t.textContent = A_LINK_NAMES[rs.key] || rs.label;
  });
  const hide = () => { tip.hidden = true; };
  rows.forEach((row, i) => {
    const y = top + ch * i, mv = field(row.move);
    svgEl("text", { x: lw - 8, y: y + ch / 2 + 4, "text-anchor": "end", class: "a-row-label" }, svg).textContent = mv.label;
    row.cells.forEach((l, j) => {
      const x = lw + cw * j;
      if (!l) { svgEl("rect", { x, y, width: cw, height: ch, class: "a-cell none" }, svg); return; }
      const kind = l.helps == null ? "link" : l.helps ? "helps" : "hurts";
      const sure = l.label !== "chance";
      const cell = svgEl("rect", { x, y, width: cw, height: ch, rx: 3, class: `a-cell ${kind}`, tabindex: 0, role: "button",
        "fill-opacity": (0.06 + Math.min(1, Math.abs(l.r) / 0.5) * (sure ? 0.5 : 0.22)).toFixed(2) }, svg);
      const mark = kind === "helps" ? "▲" : kind === "hurts" ? "▼" : l.r > 0 ? "+" : "−";
      const said = `${mv.label} and ${aLower(A_LINK_NAMES[l.result] || results[j].label)}: `
        + (sure ? `${aLinkSentence(l)} (${EVIDENCE[l.label].toLowerCase()})` : "could be chance");
      cell.setAttribute("aria-label", said);
      if (sure) {
        svgEl("text", { x: x + cw / 2, y: y + ch / 2 + 3.5, "text-anchor": "middle", class: "a-cell-text" }, svg)
          .textContent = `${mark} ${Math.abs(l.r).toFixed(2).replace(/^0/, "")}`;
      }
      if (l.label === "confirmed") svgEl("rect", { x: x + 2, y: y + 2, width: cw - 4, height: ch - 4, rx: 2, class: "a-cell-sure" }, svg);
      const show = () => {
        const b = svg.getBoundingClientRect(), c = wrap.getBoundingClientRect();
        placeTip(tip, [[`r = ${fmtR(l.r)}`, `${mv.label} with ${aLower(A_LINK_NAMES[l.result] || results[j].label)}`],
                       [`${l.n}`, `swings in ${l.sessions} sessions`]],
          sure ? `${aLinkSentence(l)} · ${EVIDENCE[l.label].toLowerCase()}, ${SwingHelps.support(l)}` : "Could be chance: too weak to tell from luck",
          wrap, b.left - c.left + x + cw / 2, b.top - c.top + y + ch / 2);
        tip.style.whiteSpace = "normal";
        tip.style.maxWidth = "320px";
      };
      const go = () => { aPick.scope = "club"; aSetExploreFromLink(l); };
      cell.addEventListener("pointerenter", show);
      cell.addEventListener("focus", show);
      cell.addEventListener("pointerleave", hide);
      cell.addEventListener("blur", hide);
      cell.addEventListener("click", go);
      cell.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
  });

  // The legend, and the strongest links in words.
  const legend = document.getElementById("a-links-legend");
  legend.replaceChildren(...[["▲", "went with a better result"], ["▼", "with a worse one"], ["+ −", "a link with no better or worse way"],
                             ["▢", "outlined: strong evidence"]].map(([mark, text]) => {
    const s = document.createElement("span");
    s.append(pEl("b", null, mark), text);
    return s;
  }));
  const top3 = shownLinks.filter(l => A_LINK_RESULTS.includes(l.result)).sort((p, q) => p.q - q.q).slice(0, 3);
  const note = document.getElementById("a-links-note");
  note.replaceChildren(...(top3.length
    ? [pEl("div", null, "The clearest links:"), ...top3.map(l => pEl("div", null, `${aLinkSentence(l)} (${EVIDENCE[l.label].toLowerCase()}).`))]
    : [pEl("div", null, "Nothing stands out from chance yet with this club in this period: more swings, or a longer period, will tell.")]));
}

/** From a square of the grid to its swings on the explorer, taken the way the grid takes them. */
function aSetExploreFromLink(l) {
  Object.assign(aPick, { x: l.move, y: l.result, mode: "day" });
  aSel = null;
  aSave();
  selectAnalysisCard("explore");
  analysisBox.scrollTop = 0;
}

// ---- Over time ----

const A_OT_CHIPS = ["goodRate", "carry", "smash", "offlineSpread", "faceToPathSpread", "strikeSpread", "clubSpeed"];
document.getElementById("a-ot-metric").onchange = e => { aPick.ot = e.target.value; aSave(); renderOverTimeCard(); };

function renderOverTimeCard() {
  const { sessions, club } = aCtx;
  let f = aField(aPick.ot);
  if (f.key === "order") f = aField("carry");
  fillSelect(document.getElementById("a-ot-metric"), [["Session score", A_RATES], ["Launch monitor", aShotFields()],
    ["Consistency", SPREADS], ...byGroup(["Face-on", "Down the line"])], f.key);
  aChips(document.getElementById("a-ot-chips"), A_OT_CHIPS.map(k => ({ key: k, name: aField(k).label, on: k === f.key })),
    it => { aPick.ot = it.key; aSave(); renderOverTimeCard(); });
  document.getElementById("a-ot-status").textContent = [club ? clubName(club) : "",
    `${sessions.length} session${sessions.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
  const box = document.getElementById("a-ot-chart");
  drawOverTime(sessions, f, null, { svg: box.querySelector("svg"), tip: box.querySelector(".tip"),
                                    onPick: key => openAnalysisSession(key, "overtime") });
}

// ---- One session ----

const A_FROM = { sessions: "Every session", overtime: "Over time", flight: "Ball flight", spread: "Spread", explore: "What goes with what" };
const A_SESS_COLS = ["carry", "offline", "smash", "clubSpeed", "faceToPath", "attack", "strikeH"];
document.getElementById("a-sess-metric").onchange = e => { aPick.seq = e.target.value; aSave(); renderSessionCard(); };

function renderSessionCard() {
  const { sessions, club } = aCtx;
  const crumb = document.getElementById("a-sess-crumb");
  const from = (analysisSession && analysisSession.from) || "sessions";
  const back = Object.assign(document.createElement("button"), { className: "small", type: "button", textContent: `← ${A_FROM[from] || "Back"}` });
  back.onclick = () => selectAnalysisCard(from);
  const i = analysisSession ? sessions.findIndex(s => s.key === analysisSession.key) : -1;
  const s = sessions[i];
  const parts = ["a-sess-tiles", "a-sess-legend", "a-sess-table"].map(id => document.getElementById(id));
  if (!s) {
    crumb.replaceChildren(back, pEl("span", "note", `No swings with the ${club ? clubWords(club) : "club"} in that session in this period: pick another club or a longer period.`));
    for (const el of parts) el.replaceChildren();
    for (const id of ["a-sess-pattern", "a-sess-seq"]) document.querySelector(`#${id} svg`).replaceChildren();
    return;
  }
  const when = new Date(s.start).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const step = (text, to, title) => {
    const b = Object.assign(document.createElement("button"), { className: "small", type: "button", textContent: text, title });
    b.disabled = !sessions[to];
    b.onclick = () => openAnalysisSession(sessions[to].key);
    return b;
  };
  const story = Object.assign(document.createElement("button"), { className: "small", type: "button", textContent: "Session story",
    title: "This session's story and trends, every club" });
  story.onclick = () => openTrends(s.key);
  crumb.replaceChildren(back, pEl("strong", null, `${when} · ${clubName(club)} · ${s.rows.length} swing${s.rows.length === 1 ? "" : "s"}`),
    pEl("span", "note grow", journal.notes[s.key] || ""), step("‹ Older", i - 1, "The session before"), step("Newer ›", i + 1, "The session after"), story);

  // The session against the usual of the others in the period.
  const others = sessions.filter(o => o !== s);
  const usual = get => { const v = others.map(get).filter(x => x != null).sort((a, b) => a - b); return v.length ? quantile(v, 0.5) : null; };
  const sc = aScore(s.rows);
  const tile = (label, now, usualV, fmt, way, sub) => {
    const t = pEl("div", "p-tile");
    const delta = pEl("span", "p-delta", [sub, usualV != null ? `usual ${fmt(usualV)}` : ""].filter(Boolean).join(" · "));
    // A handful of swings says little: no verdict under the session score's own minimum.
    if (now != null && usualV != null && way && fmt(now) !== fmt(usualV) && s.rows.length >= SwingSessionScore.MIN_JUDGED_CLUB) {
      const better = way === "up" ? now > usualV : now < usualV;
      delta.append(" · ", pEl("em", better ? "better" : "worse", better ? "better" : "worse"));
    }
    t.append(pEl("span", "p-label", label), pEl("b", null, now == null ? "–" : fmt(now)), delta);
    return t;
  };
  const pct = v => `${Math.round(v * 100)}%`;
  const med = (rows, k) => spreadOf(rows.map(r => r[k]))?.med ?? null;
  const fC = aField("carry"), fS = aField("smash"), fO = aField("offlineSpread"), fF = aField("faceToPathSpread");
  parts[0].replaceChildren(
    tile("Good shots", sc.goodRate, usual(o => aScore(o.rows).goodRate), pct, "up", sc.judged ? `${sc.good} of ${sc.judged}` : ""),
    tile("Carry", med(s.rows, "carry"), usual(o => med(o.rows, "carry")), v => aNum(fC, v), "up", "median"),
    tile("Smash", med(s.rows, "smash"), usual(o => med(o.rows, "smash")), v => aNum(fS, v), "up", "median"),
    tile("Offline spread", sessionValue(s.rows, fO)?.med ?? null, usual(o => sessionValue(o.rows, fO)?.med ?? null), v => aNum(fO, v), "down", ""),
    tile("Face-to-path spread", sessionValue(s.rows, fF)?.med ?? null, usual(o => sessionValue(o.rows, fF)?.med ?? null), v => aNum(fF, v), "down", ""));
  for (const t of parts[0].children) t.style.cursor = "default";

  const cls = r => (r.good ? "a-good" : "a-miss");
  const openRow = r => openFromAnalysis(r.c.name);
  // Where the shots finished: offline across, carry up.
  const fOff = aField("offline"), shots = s.rows.filter(r => r.carry > 0 && r.offline != null);
  const half = Math.max(10, ...shots.map(r => Math.abs(r.offline))) * 1.15;
  aScatter(document.getElementById("a-sess-pattern"), shots.map(r => ({ x: r.offline, y: r.carry, row: r, cls: cls(r) })), {
    fx: fOff, fy: fC, height: 240, xRange: [-half, half], robust: true, onOpen: openRow,
    xTick: v => v === 0 ? "0" : `${Math.abs(v)} ${v < 0 ? "L" : "R"}`,
    tip: p => ({ lines: [[aNum(fC, p.y), "carry"], [`${aNum(fOff, Math.abs(p.x))} ${p.x < 0 ? "left" : "right"}`, "offline"]],
                 foot: `Swing ${p.row.order} · ${timeOf(p.row)}${p.row.good == null ? "" : p.row.good ? " · good shot" : " · not a good shot"}` }),
  });

  // One number through the session, in the order the shots were hit: warming up, tiring, a change that took.
  let fq = aField(aPick.seq);
  if (fq.key === "order" || fq.session || fq.spread) fq = fC;
  fillSelect(document.getElementById("a-sess-metric"), [["Launch monitor", aShotFields()], ...byGroup(["Face-on", "Down the line"])], fq.key);
  const seq = s.rows.filter(r => r[fq.key] != null);
  const roll = SwingExplore.rolling(seq.map(r => r[fq.key]), 7);
  const range = !fq.shot ? goodRange(club, fq.key) : null;
  aScatter(document.getElementById("a-sess-seq"), seq.map(r => ({ x: r.order, y: r[fq.key], row: r,
    cls: cls(r) + (isShaky(r, fq) ? " hollow" : "") })), {
    fx: { label: "Swing", unit: "", dec: 0 }, fy: fq, height: 240, xRange: [0.5, Math.max(2, s.rows.length) + 0.5], robust: true, onOpen: openRow,
    xTick: v => Number.isInteger(v) && v >= 1 ? String(v) : "",
    under: ({ g, sx, sy, X }) => {
      if (range && range.enough) {
        svgEl("rect", { x: sx(X.lo), y: sy(range.q75), width: sx(X.hi) - sx(X.lo), height: Math.max(0, sy(range.q25) - sy(range.q75)), class: "a-band" }, g);
      }
      const line = seq.map((r, k) => roll[k] == null ? null : `${sx(r.order)},${sy(roll[k])}`).filter(Boolean);
      if (line.length > 1) svgEl("polyline", { points: line.join(" "), class: "a-roll" }, g);
    },
    tip: p => ({ lines: [[(fq.shot ? fmtField(fq, p.y) : aNum(fq, p.y)) + (isShaky(p.row, fq) ? " ~" : ""), fq.label]],
                 foot: `Swing ${p.row.order} · ${timeOf(p.row)}${p.row.good == null ? "" : p.row.good ? " · good shot" : " · not a good shot"}` }),
  });
  aLegend(parts[1], [["p-latest", "Good shots"], ["a-key-miss", "The rest"],
    ...(range && range.enough ? [["a-key-band", "Your good-shot range"]] : [])]);
  parts[1].append(pEl("span", null, "Line: the middle of the last 7 swings"));

  // Every swing, sortable.
  const cols = [...new Set([...A_SESS_COLS, fq.key])].map(aField);
  const sortKey = aPick.sort, dir = aPick.dir;
  const sorted = [...s.rows].sort((a, b) => {
    const va = sortKey === "good" ? (a.good == null ? null : +a.good) : a[sortKey], vb = sortKey === "good" ? (b.good == null ? null : +b.good) : b[sortKey];
    if (va == null || vb == null) return (va == null) - (vb == null);
    return (va - vb) * dir;
  });
  const head = document.createElement("tr");
  for (const [key, text] of [["order", "#"], ["t", "Time"], ["good", "Shot"], ...cols.map(f => [f.key, fieldName(f)])]) {
    const th = pEl("th", "sort" + (key === sortKey ? " sorted" : "") + (key === "good" ? " l" : ""), text + (key === sortKey ? (dir > 0 ? " ↑" : " ↓") : ""));
    th.onclick = () => { aPick.dir = key === aPick.sort ? -aPick.dir : (key === "order" || key === "t" ? 1 : -1); aPick.sort = key; aSave(); renderSessionCard(); };
    head.append(th);
  }
  const body = sorted.map(r => {
    const tr = document.createElement("tr");
    tr.append(pEl("td", null, `${r.order}`), pEl("td", null, timeOf(r)), aVerdictCell(r));
    for (const f of cols) {
      const td = document.createElement("td");
      if (f.shot) td.textContent = fmtField(f, r[f.key]);
      else if (!r.body) td.textContent = swingPending(r.c) ? "…" : "–";
      else trustCell(td, fmtField(f, r.shown[f.key]), r.trust[f.key]);
      tr.append(td);
    }
    tr.onclick = () => openRow(r);
    return tr;
  });
  const thead = document.createElement("thead"), tbody = document.createElement("tbody");
  thead.append(head);
  tbody.append(...body);
  parts[2].replaceChildren(thead, tbody);
}

// ---- Ball flight (flightgrid.js) and Spread (distro.js) ----

function renderFlight() {
  if (typeof SwingFlightGrid === "undefined") return;
  const { sessions, club } = aCtx;
  // A left-hander's draw curves right: the names swap sides (leadSide is the page's, "left" for a right-hander).
  const a = SwingFlightGrid.analyze(sessions, { club, leftHanded: leadSide === "right" });
  document.getElementById("a-flight-status").textContent = a.status || "";
  SwingFlightGrid.render(document.getElementById("a-flight"), a, {
    club, clubWords: club ? clubWords(club) : "club", dayOf,
    onPick: (rows, title) => aShowPicked(rows, title, ["direction", "spinAxis"]),
    onOpen: openFromAnalysis,
    onSession: key => openAnalysisSession(key, "flight"),
  });
}

document.getElementById("a-spread-metric").onchange = e => { aPick.spread = e.target.value; aSave(); renderSpread(); };
function renderSpread() {
  if (typeof SwingDistro === "undefined") return;
  const { sessions, club } = aCtx;
  let f = aField(aPick.spread);
  if (f.key === "order" || f.session || f.spread) f = aField("carry");
  fillSelect(document.getElementById("a-spread-metric"), [["Launch monitor", aShotFields()], ...byGroup(["Face-on", "Down the line"])], f.key);
  const range = !f.shot && club ? goodRange(club, f.key) : null;
  const a = SwingDistro.analyze(sessions, f.key, { range: range && range.enough ? range : null });
  document.getElementById("a-spread-status").textContent = a.status || "";
  SwingDistro.render(document.getElementById("a-spread"), a, {
    field: f, fmt: (v, delta) => aNum(f, v, delta), dayOf,
    onPick: (rows, title) => aShowPicked(rows, title, [f.key]),
    onOpen: openFromAnalysis,
    onSession: key => openAnalysisSession(key, "spread"),
  });
}
