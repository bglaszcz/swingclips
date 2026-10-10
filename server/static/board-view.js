// Progress's scoreboard: the session score ring, the five skills, strokes gained against a tour
// player, personal bests and the practice calendar. The numbers are board.js's (SwingBoard) and
// strokes.js's (SwingStrokes); drawn from renderProgress (trends.js), whose globals this uses.
// Irons or woods, as Progress's own switch says: never the two together.

const PB_RING = 2 * Math.PI * 50;
const pbPct = v => v == null ? "–" : `${Math.round(v * 100)}%`;
const pbSigned = (v, d = 2) => v == null ? "–" : `${v < 0 ? "−" : v > 0 ? "+" : ""}${Math.abs(v).toFixed(d)}`;
const pbMedian = xs => { const v = xs.filter(x => x != null).sort((a, b) => a - b); return v.length ? quantile(v, 0.5) : null; };
const pbCtx = () => ({ clubs: goodShotData().clubs, settings: goodSettings && goodSettings.settings });

/** From a Progress number to the swings behind it: Analysis, on the club most hit in the session. */
function pbOpenAnalysis(club, card, pick) {
  if (club) progressPick.club = club;
  if (pick) { Object.assign(aPick, { scope: "club", mode: "raw" }, pick); aSave(); }
  analysisCard = card;
  openAnalysis();
}
const pbTopClub = rows => {
  const n = {};
  for (const r of rows) if (r.club) n[r.club] = (n[r.club] || 0) + 1;
  return Object.keys(n).sort((a, b) => n[b] - n[a])[0] || null;
};

/** Called by renderProgress: `sessions` are the club type's in the period, oldest first. */
function renderBoard(sessions, group) {
  const ctx = pbCtx();
  const b = SwingBoard.board(sessions, ctx, { minShots: SwingSessionScore.MIN_JUDGED });
  renderBoardScore(b);
  renderBoardSkills(b, sessions);
  renderBoardStrokes(sessions, ctx, group);
  renderBoardRecords(progressSessions(group), ctx, group);
  renderBoardActivity();
}

function renderBoardScore(b) {
  const now = b ? b.score.now : null;
  document.getElementById("pb-score").textContent = now == null ? "–" : `${Math.round(now)}`;
  document.getElementById("pb-ring-arc").style.strokeDasharray = `${(now || 0) / 100 * PB_RING} ${PB_RING}`;
  const tick = document.getElementById("pb-ring-usual");
  const usual = b ? b.score.usual : null;
  tick.setAttribute("visibility", usual == null ? "hidden" : "visible");
  if (usual != null) tick.setAttribute("transform", `rotate(${usual * 3.6} 60 60)`);
  const line = document.getElementById("pb-score-line");
  line.replaceChildren();
  if (!b || now == null) return;
  const pill = (label, value) => { const p = pEl("span", "pb-pill", label + " "); p.append(pEl("b", null, value)); return p; };
  if (b.enough && b.score.last != null) {
    const d = Math.round(now) - Math.round(b.score.last);
    const p = pEl("span", "pb-pill");
    p.append(pEl("em", d > 0 ? "better" : d < 0 ? "worse" : "", d === 0 ? "level with" : `${Math.abs(d)} ${d > 0 ? "up" : "down"} on`), " last time");
    line.append(p);
  }
  if (b.score.last != null) line.append(pill("Last time", `${Math.round(b.score.last)}`));
  if (usual != null) line.append(pill("Usual", `${Math.round(usual)}`));
  if (b.score.best != null) line.append(pill("Best", `${Math.round(b.score.best)}`));
}

// Where a skill's swings are in Analysis.
const PB_SKILL_VIEW = {
  line: ["explore", { y: "absOffline" }], distance: ["explore", { y: "carry" }], solid: ["explore", { y: "smash" }],
  centred: ["strike", null], match: ["good", null],
};

function renderBoardSkills(b, sessions) {
  const radar = document.getElementById("pb-radar"), list = document.getElementById("pb-skill-list");
  const say = document.getElementById("pb-skills-say"), note = document.getElementById("pb-skills-note");
  radar.replaceChildren(); list.replaceChildren(); say.replaceChildren();
  note.textContent = "";
  if (!b) { say.textContent = "No sessions in this period."; radar.setAttribute("visibility", "hidden"); return; }
  const latest = sessions[sessions.length - 1];
  note.textContent = `${dayOf(b.latest.start)} against your usual`;
  const skills = b.skills.filter(s => s.now != null || s.usual != null);

  // The radar: one spoke per skill, 0 at the middle, 100% at the rim.
  radar.setAttribute("visibility", skills.length >= 3 ? "visible" : "hidden");
  if (skills.length >= 3) {
    const cx = 150, cy = 122, R = 80, n = skills.length;
    const at = (i, v) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; return [cx + Math.cos(a) * R * v, cy + Math.sin(a) * R * v]; };
    const ring = v => skills.map((_, i) => at(i, v).join(",")).join(" ");
    for (const v of [0.25, 0.5, 0.75, 1]) svgEl("polygon", { points: ring(v), class: "pb-radar-grid" }, radar);
    skills.forEach((_, i) => { const [x, y] = at(i, 1); svgEl("line", { x1: cx, y1: cy, x2: x, y2: y, class: "pb-radar-spoke" }, radar); });
    const shape = key => skills.map((s, i) => at(i, s[key] ?? 0).join(",")).join(" ");
    if (skills.every(s => s.usual != null)) svgEl("polygon", { points: shape("usual"), class: "pb-radar-usual" }, radar);
    if (skills.every(s => s.now != null)) {
      svgEl("polygon", { points: shape("now"), class: "pb-radar-now" }, radar);
      skills.forEach((s, i) => { const [x, y] = at(i, s.now); svgEl("circle", { cx: x, cy: y, r: 4, class: "pb-radar-dot" }, radar); });
    }
    skills.forEach((s, i) => {
      const [x, y] = at(i, 1.16), anchor = Math.abs(x - cx) < 8 ? "middle" : x > cx ? "start" : "end";
      const dy = y < cy - R * 0.5 ? -8 : y > cy + R * 0.5 ? 8 : 0;
      svgEl("text", { x, y: y + dy, "text-anchor": anchor, class: "pb-radar-label" }, radar).textContent = s.label;
      svgEl("text", { x, y: y + dy + 13, "text-anchor": anchor, class: "pb-radar-val" }, radar).textContent = pbPct(s.now);
    });
  }

  // The same five as rows: the share, a bar with your usual as the tick, the gap in points.
  const club = latest ? pbTopClub(latest.rows) : null;
  const gaps = [];
  for (const s of skills) {
    const row = Object.assign(document.createElement("button"), { className: "pb-skill", type: "button" });
    row.title = `${s.label}: ${s.hint}${s.n ? ` (${s.n} ${s.video ? "swings" : "shots"})` : ""}. Tap to see the swings in Analysis.`;
    const meter = pEl("span", "pb-meter"), fill = document.createElement("i");
    fill.style.width = `${Math.round((s.now || 0) * 100)}%`;
    meter.append(fill);
    if (s.usual != null) { const t = document.createElement("s"); t.style.left = `${Math.round(s.usual * 100)}%`; meter.append(t); }
    const delta = pEl("span", "p-delta");
    if (s.now != null && s.usual != null) {
      const d = Math.round(s.now * 100) - Math.round(s.usual * 100);
      // A gap worth a word: 10 points with enough shots behind it.
      const clear = b.enough && s.n >= SwingBoard.MIN_SHOTS && Math.abs(d) >= 10;
      if (clear) { gaps.push({ s, d }); delta.append(pEl("em", d > 0 ? "better" : "worse", `${d > 0 ? "+" : "−"}${Math.abs(d)}`), " vs usual"); }
      else delta.textContent = d === 0 ? "as usual" : `${d > 0 ? "+" : "−"}${Math.abs(d)} vs usual`;
    } else delta.textContent = s.now == null ? "no reading" : "nothing earlier";
    row.append(pEl("span", null, s.label), pEl("b", null, pbPct(s.now)), meter, delta);
    const [card, pick] = PB_SKILL_VIEW[s.key];
    row.onclick = () => pbOpenAnalysis(club, card, pick);
    list.append(row);
  }

  if (!b.enough) {
    say.textContent = `Only ${b.latest.n} shot${b.latest.n === 1 ? "" : "s"} with a verdict on ${dayOf(b.latest.start)}: too few to read much into.`;
  } else if (!gaps.length) {
    say.textContent = b.skills.some(s => s.usual != null) ? "Every skill within 10 points of your usual: a normal day." : "Nothing earlier to compare with yet.";
  } else {
    const down = gaps.filter(g => g.d < 0).sort((p, q) => p.d - q.d)[0], up = gaps.filter(g => g.d > 0).sort((p, q) => q.d - p.d)[0];
    const words = g => [pEl("b", null, lowerFirst(g.s.label)), ` (${pbPct(g.s.now)} against ${pbPct(g.s.usual)})`];
    if (down) say.append("Down most against your usual: ", ...words(down), ". ");
    if (up) say.append(down ? "Up most: " : "Up most against your usual: ", ...words(up), ".");
  }
}

function renderBoardStrokes(sessions, ctx, group) {
  const per = sessions.map(s => ({ s, x: SwingStrokes.session(s.rows, ctx) })).filter(p => p.x.n > 0);
  const latest = per[per.length - 1];
  const num = document.getElementById("pb-sg-now"), delta = document.getElementById("pb-sg-delta");
  const say = document.getElementById("pb-sg-say"), split = document.getElementById("pb-sg-split"), clubsBox = document.getElementById("pb-sg-clubs");
  const box = document.getElementById("pb-sg-chart"), svg = box.querySelector("svg"), tip = box.querySelector(".tip");
  document.getElementById("pb-sg-note").textContent = group === "woods" ? "tee shots on a 400 yd par 4; hybrids as approach shots"
    : "approach shots at your usual carry with each club";
  svg.replaceChildren(); say.replaceChildren(); split.replaceChildren(); clubsBox.replaceChildren(); delta.replaceChildren();
  tip.hidden = true;
  if (!latest) { num.textContent = "–"; document.getElementById("pb-sg-unit").textContent = "no shots to score in this period"; return; }
  const min = SwingBoard.MIN_SHOTS;
  const earlier = per.slice(0, -1).filter(p => p.x.n >= min);
  const usual = pbMedian(earlier.slice(-SwingBoard.USUAL).map(p => p.x.sg));
  num.textContent = pbSigned(latest.x.sg);
  document.getElementById("pb-sg-unit").textContent = `strokes per shot, ${dayOf(latest.s.start)} (${latest.x.n} shots)`;
  if (usual != null) {
    const d = latest.x.sg - usual;
    delta.append(`usual ${pbSigned(usual)}`);
    if (latest.x.n >= min && Math.abs(d) >= 0.05) delta.append(" · ", pEl("em", d > 0 ? "better" : "worse", d > 0 ? "better" : "worse"));
    else if (latest.x.n >= min) delta.append(" · about the same");
  }

  // One bar per session: below the line is behind a tour player.
  const shown = per.slice(-16);
  const W = Math.max(240, svg.clientWidth || 420), H = 150, m = { l: 40, r: 8, t: 12, b: 22 };
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("aria-label", "Strokes gained per shot against a tour player, one bar per session");
  const vs = shown.map(p => p.x.sg);
  const Y = niceTicks(Math.min(0, ...vs) - 0.02, Math.max(0.05, ...vs), 4);
  const sy = v => H - m.b - (v - Y.lo) / (Y.hi - Y.lo) * (H - m.t - m.b);
  axes(svg, W, H, m, null, Y, null, sy, null);
  const step = (W - m.l - m.r) / shown.length, bw = Math.min(26, step * 0.62);
  const every = Math.ceil(shown.length / Math.max(1, Math.floor((W - m.l - m.r) / 48)));
  shown.forEach((p, i) => {
    const x = m.l + step * (i + 0.5), y0 = sy(0), y1 = sy(p.x.sg), last = p === latest;
    svgEl("rect", { x: x - bw / 2, y: Math.min(y0, y1), width: bw, height: Math.max(2, Math.abs(y1 - y0)), rx: 3,
      class: "pb-bar" + (last ? " latest" : "") + (p.x.n < min ? " thin" : "") }, svg);
    if (i % every === 0 || last) svgEl("text", { x, y: H - 6, "text-anchor": "middle", class: "t-axis" }, svg).textContent = dayOf(p.s.start);
    const hit = svgEl("rect", { x: x - step / 2, y: m.t, width: step, height: H - m.t - m.b, class: "t-hit", tabindex: 0, role: "button" }, svg);
    hit.setAttribute("aria-label", `${dayOf(p.s.start)}: ${pbSigned(p.x.sg)} strokes per shot over ${p.x.n} shots`);
    const show = () => {
      const r = svg.getBoundingClientRect(), c = box.getBoundingClientRect();
      placeTip(tip, [[pbSigned(p.x.sg), "strokes per shot"], [`${p.x.n}`, "shots"]],
        `${dayOf(p.s.start)}${p.x.n < min ? " · few shots" : ""}`, box, r.left - c.left + x * r.width / W, r.top - c.top + Math.min(y0, y1) * r.height / H);
    };
    const hide = () => { tip.hidden = true; };
    hit.addEventListener("pointerenter", show); hit.addEventListener("focus", show);
    hit.addEventListener("pointerleave", hide); hit.addEventListener("blur", hide);
    hit.addEventListener("click", () => openTrends(p.s.key));
    hit.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openTrends(p.s.key); } });
  });

  // In words, then the period: what the misses cost, and each club.
  const ten = v => (Math.abs(v) * 10).toFixed(1);
  say.append(`Over 10 shots that is ${ten(latest.x.sg)} strokes ${latest.x.sg < 0 ? "behind" : "ahead of"} a tour player`
    + (usual != null ? ` (your usual: ${ten(usual)}${usual < 0 === latest.x.sg < 0 ? "" : usual < 0 ? " behind" : " ahead"}).` : "."));
  if (latest.x.prox != null && group !== "woods") {
    say.append(` Your middle shot finished ${latest.x.prox.toFixed(0)} yd from its target (${latest.x.proxPct.toFixed(0)}% of the distance).`);
  }
  const period = SwingStrokes.session(sessions.flatMap(s => s.rows), ctx);
  if (period.loss && period.loss.dirShare != null && period.miss.n >= min) {
    const dir = Math.round(period.loss.dirShare * 100), k = period.miss, share = x => Math.round(x / k.n * 100);
    split.append(pEl("div", "pb-sub", "What your misses cost"));
    split.lastChild.append(pEl("span", "note", `${k.n} approach shots in the period`));
    const bar = pEl("div", "pb-split"), a = pEl("i", "dir"), c = pEl("i", "len");
    a.style.width = `${dir}%`; c.style.width = `${100 - dir}%`;
    bar.append(a, c);
    const legend = pEl("div", "p-legend");
    for (const [cls, text] of [["pb-key-dir", `Left or right: ${dir}%`], ["pb-key-len", `Long or short: ${100 - dir}%`]]) {
      const sp = document.createElement("span");
      sp.append(Object.assign(document.createElement("i"), { className: "p-key " + cls }), text);
      legend.append(sp);
    }
    const sides = [["short", k.short], ["long", k.long], ["left", k.left], ["right", k.right]].sort((p, q) => q[1] - p[1]);
    const line = pEl("div", "note", `Of those shots ${share(k.on)}% finished on target; `);
    sides.forEach(([name, n], i) => line.append(i ? ", " : "", i === 0 ? pEl("b", null, `${share(n)}% ${name}`) : `${share(n)}% ${name}`));
    line.append(` (beyond ${SwingStrokes.MISS_PCT}% of the distance; a shot can miss both ways).`);
    split.append(bar, legend, line);
  }
  const clubs = period.byClub.filter(c => c.n >= SwingStrokes.MIN_SHOTS);
  if (clubs.length > 1) {
    const order = SwingGapping.sortClubs(clubs.map(c => c.club)), worst = [...clubs].sort((p, q) => p.sg - q.sg)[0];
    const max = Math.max(0.05, ...clubs.map(c => Math.abs(c.sg)));
    clubsBox.append(pEl("div", "pb-sub", "Club by club"));
    clubsBox.lastChild.append(pEl("span", "note", "strokes per shot in the period · tap a club to see its swings"));
    for (const code of order) {
      const c = clubs.find(x => x.club === code);
      const row = Object.assign(document.createElement("button"), { className: "pb-club" + (c === worst ? " worst" : ""), type: "button" });
      const meter = pEl("span", "pb-meter"), fill = document.createElement("i");
      fill.style.width = `${Math.round(Math.abs(c.sg) / max * 100)}%`;
      meter.append(fill);
      row.title = `${clubName(code)}: ${SwingStrokes.words(c.sg)} a tour player per shot over ${c.n} shots`
        + (c.prox != null ? `; the middle shot ${c.prox.toFixed(0)} yd from its target` : "");
      row.append(pEl("span", null, clubName(code)), pEl("span", "n", `${c.n}`), meter,
        pEl("b", null, pbSigned(c.sg)));
      row.onclick = () => pbOpenAnalysis(code, "explore", { y: "sg" });
      clubsBox.append(row);
    }
    if (worst.sg < 0) {
      clubsBox.append(pEl("div", "note", `Furthest behind: the ${clubWords(worst.club)}, ${Math.abs(worst.sg).toFixed(2)} strokes a shot over ${worst.n} shots.`));
    }
  }
}

const PB_REC_FMT = {
  score: v => `${Math.round(v)}`, streak: v => `${v}`, carry: v => `${v.toFixed(0)} yd`, speed: v => `${v.toFixed(1)} mph`,
  sg: v => pbSigned(v), hcp: v => v.toFixed(1),
};

function renderBoardRecords(sessions, ctx, group) {
  const list = document.getElementById("pb-records-list"), all = document.getElementById("pb-records-all"), more = document.getElementById("pb-records-more");
  document.getElementById("pb-records-note").textContent = `all time · ${group === "woods" ? "driver, woods and hybrids" : "irons and wedges"}`;
  const recs = SwingBoard.records(sessions, ctx);
  // The best session against a tour player.
  const latest = sessions.length ? sessions[sessions.length - 1].key : null;
  let bestSg = null;
  for (const s of sessions) {
    const x = SwingStrokes.session(s.rows, ctx);
    if (x.n >= SwingBoard.MIN_SHOTS && (!bestSg || x.sg > bestSg.value)) {
      bestSg = { key: "sg", label: "Best against a tour player", value: x.sg, t: s.start, session: s.key, isNew: s.key === latest && sessions.length > 1 };
    }
  }
  const tile = r => {
    const t = Object.assign(document.createElement("button"), { className: "pb-rec", type: "button" });
    t.append(pEl("span", "p-label", r.label + (r.club ? `, ${clubWords(r.club)}` : "")), pEl("b", null, PB_REC_FMT[r.key](r.value)),
      pEl("span", "when", r.sub || dayOf(r.t)));
    if (r.isNew) t.append(pEl("span", "pb-new", "New"));
    if (r.name) { t.title = "Open this swing"; t.onclick = () => open(r.name); }
    else if (r.session) { t.title = "Open this session"; t.onclick = () => openTrends(r.session); }
    else t.style.cursor = "default";
    return t;
  };
  const first = key => (group === "woods" && recs.find(r => r.key === key && r.club === "DR")) || recs.find(r => r.key === key);
  // Speed is the driver's and woods' game: with irons it stays under "Every club".
  const main = [first("score"), bestSg, first("streak"), first("carry"), group === "woods" ? first("speed") : null].filter(Boolean);
  const hcp = journal.handicap[journal.handicap.length - 1];
  if (hcp) {
    const start = journal.handicap[0], d = hcp.index - start.index;
    main.push({ key: "hcp", label: "Handicap index", value: hcp.index,
      sub: journal.handicap.length > 1 && Math.abs(d) >= 0.05 ? `${d < 0 ? "down" : "up"} ${Math.abs(d).toFixed(1)} since ${dayOf(new Date(start.date + "T12:00"))}`
        : dayOf(new Date(hcp.date + "T12:00")) });
  }
  list.replaceChildren(...(main.length ? main.map(tile) : [pEl("div", "note", "Nothing yet: bests show once a session has 8 shots with a verdict.")]));
  const rest = recs.filter(r => (r.key === "carry" || r.key === "speed") && !main.includes(r));
  more.hidden = !rest.length;
  all.replaceChildren(...rest.map(tile));
}

function renderBoardActivity() {
  const sessions = sessionsOf(shownClips()).map(s => ({ key: s.key, start: s.start, n: s.clips.filter(c => !c.excluded).length }));
  const a = SwingBoard.activity(sessions, Date.now(), 12);
  document.getElementById("pb-activity-note").textContent = "every club · the last 12 weeks";
  const stat = (value, label) => { const d = pEl("div", "pb-stat"); d.append(pEl("b", null, value), pEl("span", null, label)); return d; };
  const usual = a.usual ? ` (usual ${Math.round(a.usual.swings)})` : "";
  document.getElementById("pb-activity-stats").replaceChildren(
    stat(`${a.week.sessions}`, `session${a.week.sessions === 1 ? "" : "s"} this week`),
    stat(`${a.week.swings}`, `swings this week${usual}`),
    stat(`${a.streak}`, `week${a.streak === 1 ? "" : "s"} in a row`));

  const wrap = document.getElementById("pb-cal-wrap"), svg = document.getElementById("pb-cal"), tip = wrap.querySelector(".tip");
  svg.replaceChildren();
  tip.hidden = true;
  const cell = 15, gap = 3, left = 22, top = 14, W = left + a.weeks.length * (cell + gap), H = top + 7 * (cell + gap);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  ["Mon", "", "Wed", "", "Fri", "", "Sun"].forEach((d, k) => {
    if (d) svgEl("text", { x: 0, y: top + k * (cell + gap) + cell - 3, class: "pb-cal-label" }, svg).textContent = d;
  });
  const keyOf = new Map(sessions.map(s => [SwingBoard.dayStart(s.start), s.key]));
  const today = SwingBoard.dayStart(Date.now());
  let month = -1;
  a.weeks.forEach((week, i) => {
    const x = left + i * (cell + gap), m = new Date(week[0].t).getMonth();
    if (m !== month) {
      month = m;
      svgEl("text", { x, y: 9, class: "pb-cal-label" }, svg).textContent = new Date(week[0].t).toLocaleDateString(undefined, { month: "short" });
    }
    week.forEach((d, k) => {
      const y = top + k * (cell + gap);
      const r = svgEl("rect", { x, y, width: cell, height: cell, rx: 3,
        class: "pb-day" + (d.future ? " future" : d.swings ? " on" : "") + (d.t === today ? " today" : "") }, svg);
      if (d.future) return;
      if (d.swings) r.setAttribute("fill-opacity", (0.25 + 0.75 * d.swings / a.max).toFixed(2));
      const when = new Date(d.t).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      r.setAttribute("aria-label", `${when}: ${d.swings} swings`);
      r.addEventListener("pointerenter", () => {
        const b = svg.getBoundingClientRect(), c = wrap.getBoundingClientRect(), s = b.width / W;
        placeTip(tip, d.swings ? [[`${d.swings}`, "swings"], [`${d.sessions}`, `session${d.sessions === 1 ? "" : "s"}`]] : [["No", "practice"]],
          when, wrap, b.left - c.left + (x + cell) * s, b.top - c.top + (y + cell / 2) * s);
      });
      r.addEventListener("pointerleave", () => { tip.hidden = true; });
      if (d.swings && keyOf.has(d.t)) r.addEventListener("click", () => openTrends(keyOf.get(d.t)));
    });
  });
  const legend = document.getElementById("pb-cal-legend");
  legend.replaceChildren(pEl("span", null, "Fewer swings"));
  for (const o of [0.25, 0.5, 0.75, 1]) {
    const k = Object.assign(document.createElement("i"), { className: "p-key pb-key-day" });
    k.style.opacity = o;
    legend.lastChild.append(k);
  }
  legend.lastChild.append("more");
  legend.append(pEl("span", null, `${a.total.swings} swings in ${a.total.sessions} sessions so far`));
}
