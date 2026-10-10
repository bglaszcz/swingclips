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

// ---- The focus as a goal: a target and a progress score (goal.js) ----

const pbFocus = () => journal.focus && journal.focus.move ? journal.focus : null;
const pbFocusClubs = f => f.scope ? (f.scope === "woods" ? "driver and woods" : "irons") : f.club ? clubName(f.club) : "every club";
/** "under 3.2 in" / "over 42°": the target in the move's own number. */
const pbTargetWords = (f, t) => `${t.side === "below" ? "under" : "over"} ${aNum(field(f.move), t.bound)}`;
const PB_TARGET_FROM = { own: "your own target", before: "your usual before you started", first: "your first session with it" };

function pbGoal(f) {
  const sessions = progressSessions(f.scope || f.club || "*"), p = SwingGoal.progress(sessions, f);
  if (!p) return null;
  // Sessions since the focus began where the camera that measures the move had moved: the move's
  // numbers either side don't compare, and neither do their scores.
  const cam = cameraOf(field(f.move)), moved = new Set(cam ? sessions.filter(s => s.moved[cam]).map(s => s.key) : []);
  for (const s of p.sessions) s.moved = s.since && moved.has(s.key);
  p.cameraMoved = p.sessions.some(s => s.moved);
  return p;
}

/** A score ring (0 to 1): `size` "mid" or "mini". */
function pbRing(rate, size, label) {
  const box = pEl("div", `pb-ring ${size}`);
  const svg = svgEl("svg", { viewBox: "0 0 120 120", role: "img", "aria-label": `${label}: ${rate == null ? "no swings yet" : Math.round(rate * 100) + "%"}` }, box);
  svgEl("circle", { class: "pb-ring-track", cx: 60, cy: 60, r: 50 }, svg);
  const arc = svgEl("circle", { class: "pb-ring-arc", cx: 60, cy: 60, r: 50, transform: "rotate(-90 60 60)" }, svg);
  arc.style.strokeDasharray = `${(rate || 0) * PB_RING} ${PB_RING}`;
  const num = pEl("div", "pb-ring-num");
  num.append(pEl("b", null, rate == null ? "–" : `${Math.round(rate * 100)}%`), pEl("span", null, label));
  box.append(num);
  return box;
}

/** Your own target for the focus, typed in; empty goes back to the usual before you started. */
async function pbSetTarget(f, t) {
  const fld = field(f.move), unit = fld.unit && fld.unit !== ":1" ? ` (${fld.unit})` : "";
  const text = prompt(`Your own target for ${lowerFirst(fld.label)}${unit}.\nA swing counts when it is ${f.aim === "more" ? "at or over" : "at or under"} this number. `
    + "Leave it empty to go back to your usual before you started.", t && t.from === "own" ? String(t.bound) : "");
  if (text === null) return;
  const v = text.trim() === "" ? null : Number(text.replace(",", "."));
  if (v !== null && !Number.isFinite(v)) { alert("That isn't a number."); return; }
  const body = { move: f.move, aim: f.aim, club: f.club || null, results: f.results || [], since: f.since };
  if (f.scope) body.scope = f.scope;
  if (v !== null) body.target = v;
  await setFocus(body);
  if (v !== null && (!journal.focus || journal.focus.target !== v)) alert("The server didn't keep the target: update the server (Tools), then set it again.");
}

/** The focus card's head: the progress score, what it counts, each session as a bar. */
function goalHead(f) {
  const head = pEl("div", "pb-goal-head"), p = pbGoal(f), text = pEl("div", "pb-goal-text");
  if (!p) {
    head.append(pbRing(null, "mid", "Progress score"), text);
    text.append(pEl("div", null, "No progress score yet: it takes 5 swings with a reading of this move to set the target."));
    return head;
  }
  const t = p.target, latest = p.latest;
  head.append(pbRing(latest ? latest.rate : null, "mid", "Progress score"), text);
  const first = pEl("div");
  if (latest) {
    first.append(pEl("b", null, `${latest.k} of ${latest.n} swings`), ` on ${dayOf(latest.start)} were in your target: ${lowerFirst(field(f.move).label)} ${pbTargetWords(f, t)}.`);
    if (latest.n < SwingGoal.MIN_SESSION) first.append(" Too few swings to read much into.");
  } else first.append("No swings since you set it: hit some with the drill, then look here.");
  text.append(first);
  if (p.after.n) {
    const bits = [];
    if (p.before.n) bits.push(`Before you started: ${pbPct(p.before.rate)}`);
    bits.push(`since ${dayOf(new Date(f.since + "T12:00"))}: ${pbPct(p.after.rate)} of ${p.after.n} swings in ${p.after.sessions} session${p.after.sessions === 1 ? "" : "s"}`);
    if (p.best && p.after.sessions > 1) bits.push(`best session ${pbPct(p.best.rate)} (${dayOf(p.best.start)})`);
    text.append(pEl("div", "muted", bits.join(" · ").replace(/^s/, "S") + "."));
  }
  if (p.cameraMoved) {
    text.append(pEl("div", "pb-goal-warn", "A camera moved since you started (marked on the chart): the move reads differently from a new spot, "
      + "so scores either side of a move may not compare. Recalibrate after moving a tripod and set the focus's start again if it jumps."));
  }
  const tl = pEl("div", "muted", `Target: ${pbTargetWords(f, t)}, ${PB_TARGET_FROM[t.from]}. `);
  const own = Object.assign(document.createElement("button"), { className: "pb-link", type: "button", textContent: t.from === "own" ? "Change it" : "Set my own" });
  own.onclick = () => pbSetTarget(f, t);
  tl.append(own);
  text.append(tl);

  // One bar per session: the share of swings in the target, before (grey) and since.
  if (p.sessions.length > 1) {
    const box = pEl("div", "a-chart pb-goal-chart"), svg = svgEl("svg", { role: "img" }, box), tip = pEl("div", "tip");
    tip.hidden = true;
    box.append(tip);
    head.append(box);
    // Drawn once it is in the page: it needs its width.
    requestAnimationFrame(() => {
      const shown = p.sessions.slice(-18);
      const W = Math.max(240, svg.clientWidth || 520), H = 120, m = { l: 34, r: 8, t: 8, b: 20 };
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("aria-label", "The share of swings in your target, one bar per session");
      const sy = v => H - m.b - v * (H - m.t - m.b);
      for (const v of [0, 0.5, 1]) {
        svgEl("line", { x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v), class: "t-grid" }, svg);
        svgEl("text", { x: m.l - 6, y: sy(v) + 4, "text-anchor": "end", class: "t-axis" }, svg).textContent = `${v * 100}%`;
      }
      if (p.before.rate != null) svgEl("line", { x1: m.l, x2: W - m.r, y1: sy(p.before.rate), y2: sy(p.before.rate), class: "pb-goal-line" }, svg);
      const step = (W - m.l - m.r) / shown.length, bw = Math.min(26, step * 0.62);
      const every = Math.ceil(shown.length / Math.max(1, Math.floor((W - m.l - m.r) / 48)));
      shown.forEach((s, i) => {
        const x = m.l + step * (i + 0.5), y = sy(s.rate), last = s === latest;
        if (s.moved) svgEl("line", { x1: x - step / 2, x2: x - step / 2, y1: m.t, y2: H - m.b, class: "p-break" }, svg);
        svgEl("rect", { x: x - bw / 2, y, width: bw, height: Math.max(2, sy(0) - y), rx: 3,
          class: "pb-bar " + (last ? "latest" : s.since ? "since" : "before") + (s.n < SwingGoal.MIN_SESSION ? " thin" : "") }, svg);
        if (i % every === 0 || last) svgEl("text", { x, y: H - 5, "text-anchor": "middle", class: "t-axis" }, svg).textContent = dayOf(s.start);
        const hit = svgEl("rect", { x: x - step / 2, y: m.t, width: step, height: H - m.t - m.b, class: "t-hit", tabindex: 0, role: "button" }, svg);
        hit.setAttribute("aria-label", `${dayOf(s.start)}: ${s.k} of ${s.n} swings in the target`);
        const show = () => {
          const r = svg.getBoundingClientRect(), c = box.getBoundingClientRect();
          placeTip(tip, [[pbPct(s.rate), "in your target"], [`${s.k} of ${s.n}`, "swings"]],
            `${dayOf(s.start)} · ${s.since ? "since you started" : "before you started"}${s.moved ? " · a camera had moved" : ""}`,
            box, r.left - c.left + x * r.width / W, r.top - c.top + y * r.height / H);
        };
        const hide = () => { tip.hidden = true; };
        hit.addEventListener("pointerenter", show); hit.addEventListener("focus", show);
        hit.addEventListener("pointerleave", hide); hit.addEventListener("blur", hide);
        hit.addEventListener("click", () => openTrends(s.key));
      });
    });
  }
  // The latest session swing by swing: which swings were in the target (goal-live.js).
  const liveBox = pEl("div", "pb-goal-live");
  head.append(liveBox);
  requestAnimationFrame(() => renderFocusLive(liveBox, f));
  return head;
}

/**
 * The focus's latest session swing by swing, into `box`: the last swing's number and where it sat, the
 * count in the target, and each swing as a dot against it. Returns false when there is nothing to show.
 */
function renderFocusLive(box, f) {
  const sessions = progressSessions(f.scope || f.club || "*"), t = SwingGoal.target(sessions, f);
  const since = new Date(f.since + "T00:00:00").getTime(), latest = [...sessions].reverse().find(s => s.start >= since);
  if (!t || !latest || typeof SwingGoalLive === "undefined") { box.replaceChildren(); return false; }
  const model = { ...SwingGoal.live(latest.rows, f, t), target: t };
  const mv = SwingCoach.MOVES[f.move], fix = mv && mv[f.aim], fld = field(f.move);
  const today = new Date(latest.start).toDateString() === new Date().toDateString();
  const newest = latest.rows[latest.rows.length - 1];
  SwingGoalLive.render(box, model, {
    title: `${today ? "Today" : dayOf(latest.start)}, swing by swing`,
    label: lowerFirst(fld.label), fmt: v => aNum(fld, v),
    thought: fix ? SwingShotStory.plain(fix.thought) : "",
    waiting: !!newest && !newest.body && swingPending(newest.c),
    onOpen: row => open(row.c.name),
  });
  return true;
}

/** Practice's card: the focus swing by swing, redrawn as each swing's numbers arrive. */
function renderPracticeFocus() {
  const box = document.getElementById("pr-focus-live"), f = pbFocus();
  if (!box) return;
  box.hidden = !f;
  if (!f) return;
  const mv = SwingCoach.MOVES[f.move], fix = mv && mv[f.aim];
  const head = pEl("div", "pb-head"), body = pEl("div", "pb-goal-live");
  head.append(pEl("strong", null, fix ? SwingShotStory.plain(fix.name).replace(/^./, c => c.toUpperCase()) : focusLabel(f.move)),
    pEl("span", "note", `your focus · ${pbFocusClubs(f)}`));
  box.replaceChildren(head, body);
  if (!renderFocusLive(body, f)) body.append(pEl("div", "note", "No swings since you set this focus yet: the first few set the picture."));
}

/** The strip at the top of Progress: the focus and its score, one tap from practising it; or a way to pick one. */
function renderGoalStrip(top) {
  const box = document.getElementById("pb-goal"), f = pbFocus(), text = pEl("div", "pb-goal-text"), actions = pEl("div", "pb-goal-actions");
  const toFocus = () => document.getElementById("p-focus").scrollIntoView({ block: "start", behavior: "smooth" });
  if (!f) {
    const main = top && top[0];
    text.append(pEl("div", "p-focus-kicker", "No focus yet"),
      pEl("div", "p-focus-name", main ? `The numbers point to ${SwingShotStory.plain(main.fix.name)}` : "Pick one thing to work on"),
      pEl("div", "muted", "Set a focus and this shows how many of your swings hit its target, session by session."));
    const see = pEl("button", "small primary", main ? "See why" : "Pick a focus");
    see.onclick = () => main ? toFocus() : focusPicker();
    const pick = pEl("button", "small", "Pick my own");
    pick.onclick = () => focusPicker();
    actions.append(see, ...(main ? [pick] : []));
    box.replaceChildren(pbRing(null, "mini", "Progress score"), text, actions);
    return;
  }
  const mv = SwingCoach.MOVES[f.move], fix = mv && mv[f.aim], p = pbGoal(f), latest = p && p.latest;
  text.append(pEl("div", "p-focus-kicker", `Your focus · ${pbFocusClubs(f)} · since ${dayOf(new Date(f.since + "T12:00"))}`),
    pEl("div", "p-focus-name", fix ? lowerFirst(SwingShotStory.plain(fix.name)).replace(/^./, c => c.toUpperCase()) : focusLabel(f.move)));
  text.append(pEl("div", "muted", !p ? "No progress score yet: it takes 5 swings with a reading of this move."
    : !latest ? "No swings since you set it yet."
    : `${latest.k} of ${latest.n} swings in your target on ${dayOf(latest.start)}`
      + (p.before.n ? ` · ${pbPct(p.before.rate)} before you started` : "") + ` · ${p.after.n} swings in ${p.after.sessions} session${p.after.sessions === 1 ? "" : "s"} since`));
  const practise = pEl("button", "small primary", "Practice this"), range = focusPracticeRange(f);
  practise.disabled = !range;
  practise.title = range ? "The phone says the number after each swing, and the swing thought after one out of the target" : "Not enough recent swings with this move to set a range";
  practise.onclick = async () => {
    const ok = await practiceFromFocus({ metric: f.move, club: f.club, min: range.min, max: range.max, cue: fix ? SwingShotStory.plain(fix.thought) : "" });
    if (!ok) alert("Practice mode can't speak this move (the face-on turns aren't reliable enough one swing at a time).");
  };
  const view = pEl("button", "small", "View progress");
  view.onclick = toFocus;
  actions.append(practise, view);
  box.replaceChildren(pbRing(latest ? latest.rate : null, "mini", "Progress score"), text, actions);
}
