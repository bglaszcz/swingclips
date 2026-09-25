// Labels (button at the top): how far the hand labeling for the scorecard has got. Progress toward
// the goals, which clubs, sessions, light and shutter settings the labeled swings cover, each labeled
// swing with what's done on each camera angle, possible slips the server spotted (labelcheck.py),
// and a few unlabeled swings worth doing next. Clicking a swing opens it in labeling mode.
// Uses the page's globals: clips, open, clubName, fmtWhen, sessionsOf, sessionTitle, showView,
// renderList, closeTrendView (trends.js), shutterGroup (shutter.js) and window.Labels (labels.js).

const labelBox = document.getElementById("labelview");
// The goals: key moments on both angles of 20 swings, and points on 10 of them.
const GOAL_MOMENTS = 20, GOAL_POINTS = 10;
// Frames with points for an angle to count as done (labeling mode suggests about a dozen).
const POINT_FRAMES = 8;
let labelData = null, labelSig = "", labelBusy = false;

function lvEl(tag, props, ...kids) {
  const e = Object.assign(document.createElement(tag), props || {});
  e.append(...kids.filter(k => k != null));
  return e;
}

/** Evening or day, from when the clip was recorded: the barn's light differs. */
function lightOf(c) {
  const h = new Date(c.recorded).getHours();
  return h >= 18 || h < 7 ? "Evening" : "Day";
}

/** The labeled swings: pass-1 label rows paired by swing, keyed by the face-on (main) clip. */
function labeledSwings(rows) {
  const byClip = new Map(rows.filter(r => r.pass === 1).map(r => [r.clip, r]));
  const swings = new Map();
  for (const r of byClip.values()) {
    const main = r.angle === "dtl" && r.partner ? r.partner : r.clip;
    if (swings.has(main)) continue;
    const c = clips.find(x => x.name === main) || clips.find(x => x.name === r.clip);
    const faceRow = byClip.get(main) || (r.angle !== "dtl" ? r : null);
    const dtlName = r.angle === "dtl" ? r.clip : r.partner;
    const dtlRow = dtlName ? byClip.get(dtlName) || null : null;
    const angles = [faceRow, dtlRow].filter(Boolean);
    const expected = dtlName ? 2 : 1;
    swings.set(main, {
      main, c, face: faceRow, dtl: dtlRow, hasDtl: !!dtlName,
      moments: angles.length === expected && angles.every(a => a.events === 8),
      points: angles.length === expected && angles.every(a => a.pointFrames >= POINT_FRAMES),
      issues: angles.flatMap(a => a.issues.map(i => ({ angle: a.angle, text: i }))),
      updated: angles.map(a => a.updated || "").sort().pop(),
    });
  }
  return [...swings.values()].sort((a, b) => (b.c ? b.c.recorded : "").localeCompare(a.c ? a.c.recorded : ""));
}

function bar(label, have, goal) {
  const pct = Math.min(100, Math.round(100 * have / goal));
  return lvEl("div", { className: "lv-bar" },
    lvEl("div", { className: "lv-bar-head" }, lvEl("span", { textContent: label }),
      lvEl("span", { className: "lv-muted", textContent: `${Math.min(have, goal)} of ${goal}${have > goal ? ` (${have})` : ""}` })),
    lvEl("div", { className: "lv-track" }, lvEl("div", { className: "lv-fill", style: `width: ${pct}%` })));
}

/** Chips counting labeled swings per value of `key`, with the values seen in all clips shown too. */
function coverage(title, swings, all, key) {
  const counts = new Map();
  for (const c of all) { const k = key(c); if (k) counts.set(k, counts.get(k) || 0); }
  for (const s of swings) if (s.c) { const k = key(s.c); if (k) counts.set(k, (counts.get(k) || 0) + 1); }
  const chips = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => lvEl("span", { className: "lv-chip" + (n === 0 ? " none" : n === 1 ? " few" : ""),
      textContent: `${k} ${n}` }));
  return lvEl("div", { className: "lv-cov" }, lvEl("span", { className: "lv-muted", textContent: title }), ...chips);
}

/** One angle's cell: "8/8 · 12 frames · ball", greyed when not labeled. */
function angleCell(row, exists) {
  if (!exists) return lvEl("td", { className: "lv-muted", textContent: "—" });
  if (!row) return lvEl("td", { className: "lv-todo", textContent: "not labeled" });
  const parts = [`${row.events}/8 moments`, `${row.pointFrames} frame${row.pointFrames === 1 ? "" : "s"}`];
  if (!row.ball) parts.push("no ball");
  const td = lvEl("td", { textContent: parts.join(" · ") });
  if (row.events === 8 && row.pointFrames >= POINT_FRAMES) td.classList.add("lv-done");
  if (row.missing && row.missing.length && row.missing.length < 8) td.title = "Missing: " + row.missing.join(", ");
  return td;
}

/** Unlabeled swings worth doing next: from the clubs, sessions, light and shutter least covered. */
function suggestions(swings) {
  const done = new Set(swings.map(s => s.main));
  const count = key => { const m = new Map(); for (const s of swings) if (s.c) { const k = key(s.c); m.set(k, (m.get(k) || 0) + 1); } return m; };
  const keys = [c => (c.shot && c.shot.club) || "?", c => c.recorded.slice(0, 10), lightOf, c => shutterGroup(c.camera)];
  const counts = keys.map(count);
  const candidates = clips.filter(c => !c.excluded && c.pose === "done" && c.angle !== "dtl" && !done.has(c.name)
    && (!c.partner || clips.some(p => p.name === c.partner && p.pose === "done")) && c.shot);
  const scored = candidates.map(c => ({ c, score: keys.reduce((s, k, i) => s + 1 / (1 + (counts[i].get(k(c)) || 0)), 0) }))
    .sort((a, b) => b.score - a.score || b.c.recorded.localeCompare(a.c.recorded));
  const out = [], perSession = new Map();
  for (const x of scored) {
    const day = x.c.recorded.slice(0, 13);
    if ((perSession.get(day) || 0) >= 2) continue;
    perSession.set(day, (perSession.get(day) || 0) + 1);
    out.push(x.c);
    if (out.length >= 5) break;
  }
  return out;
}

function openForLabeling(name) {
  open(name);
  // Labeling mode once the swing is on screen.
  setTimeout(() => window.Labels && Labels.start && Labels.start(), 50);
}

function renderLabelView() {
  const status = document.getElementById("lv-status");
  if (!labelData) { status.textContent = "Loading…"; return; }
  const rows = labelData.clips || [];
  const swings = labeledSwings(rows);
  const moments = swings.filter(s => s.moments).length, points = swings.filter(s => s.points).length;
  const overall = Math.round(50 * Math.min(1, moments / GOAL_MOMENTS) + 50 * Math.min(1, points / GOAL_POINTS));
  const issues = swings.reduce((n, s) => n + s.issues.length, 0);
  status.textContent = `${overall}% of the way · ${swings.length} swing(s) labeled` + (issues ? ` · ${issues} thing(s) to check` : "");

  const summary = document.getElementById("lv-summary");
  const all = clips.filter(c => c.angle !== "dtl" && c.shot);
  summary.replaceChildren(
    bar(`Key moments on both angles (goal ${GOAL_MOMENTS} swings)`, moments, GOAL_MOMENTS),
    bar(`Points on both angles, ${POINT_FRAMES}+ frames each (goal ${GOAL_POINTS} swings)`, points, GOAL_POINTS),
    coverage("Club", swings, all, c => c.shot ? clubName(c.shot.club) : null),
    coverage("Light", swings, all, lightOf),
    coverage("Shutter", swings, all, c => shutterGroup(c.camera)),
    coverage("Day", swings, all, c => new Date(c.recorded).toLocaleDateString(undefined, { month: "short", day: "numeric" })),
    lvEl("div", { className: "note", textContent: "Numbers are labeled swings; amber is one, grey is none yet. "
      + "Spread labels over clubs, light and sessions: a few from each is worth more than many from one." }));

  const table = document.getElementById("lv-table");
  const head = lvEl("tr", {}, ...["When", "Club", "Face-on", "Down the line", "To check"].map(t => lvEl("th", { textContent: t })));
  const body = lvEl("tbody");
  for (const s of swings) {
    const tr = lvEl("tr", { title: "Open in labeling mode" });
    tr.onclick = () => openForLabeling(s.main);
    const when = s.c ? fmtWhen(s.c.recorded) : s.main;
    const club = s.c && s.c.shot ? clubName(s.c.shot.club) : "";
    const check = lvEl("td", { className: "lv-issues" });
    if (s.issues.length) {
      check.append(...s.issues.map(i => lvEl("div", { textContent: (s.hasDtl ? (i.angle === "dtl" ? "DTL: " : "Face: ") : "") + i.text })));
    } else if (s.moments && s.points) {
      check.append(lvEl("span", { className: "lv-done", textContent: "✓ done" }));
    } else if (s.moments) {
      check.append(lvEl("span", { className: "lv-muted", textContent: "moments done" }));
    }
    tr.append(lvEl("td", { textContent: when + (s.c ? "" : " (in the trash)") }), lvEl("td", { textContent: club }),
              angleCell(s.face, true), angleCell(s.dtl, s.hasDtl), check);
    body.append(tr);
  }
  if (!swings.length) body.append(lvEl("tr", {}, lvEl("td", { colSpan: 5, textContent: "Nothing labeled yet: open a swing and press L." })));
  table.replaceChildren(lvEl("thead", {}, head), body);

  const next = suggestions(swings);
  const nextBox = document.getElementById("lv-next");
  nextBox.replaceChildren(...(next.length ? next.map(c => {
    const b = lvEl("button", { className: "small", textContent: `${fmtWhen(c.recorded)} · ${clubName(c.shot.club)}`
      + ` · ${lightOf(c).toLowerCase()} · ${shutterGroup(c.camera)}` });
    b.onclick = () => openForLabeling(c.name);
    return b;
  }) : [lvEl("span", { className: "lv-muted", textContent: "No unlabeled swings with a shot and both angles analyzed." })]));

  const p2 = rows.filter(r => r.pass === 2).length;
  document.getElementById("lv-pass2").textContent = p2
    ? `Pass 2 (your own consistency): ${p2} clip(s) labeled a second time.` : "";
}

async function loadLabelView() {
  if (labelBusy) return;
  labelBusy = true;
  try {
    const res = await fetch("/api/labels/summary", { cache: "no-store" });
    if (res.ok) labelData = await res.json();
  } catch {}
  labelBusy = false;
  renderLabelView();
}

function openLabelView() {
  showView("labelview");
  renderList();
  labelSig = "";
  labelViewTick();
  labelBox.scrollTop = 0;
  if (window.innerWidth < 900) labelBox.scrollIntoView();
}

/** Called on each refresh of the clip list: reloads when clips change (labels save as you go). */
function labelViewTick() {
  if (labelBox.hidden) return;
  const sig = JSON.stringify(clips.map(c => [c.name, c.pose, c.shot && c.shot.club]));
  if (sig === labelSig && labelData) { loadLabelView(); return; }
  labelSig = sig;
  loadLabelView();
}

document.getElementById("labels-btn").onclick = () => labelBox.hidden ? openLabelView() : closeTrendView();
document.getElementById("lv-close").onclick = () => closeTrendView();
