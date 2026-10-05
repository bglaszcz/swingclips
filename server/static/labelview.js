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
// The night worker's comparison (/api/night): how far it has got and where it disagrees.
let nightData = null;
// Disagreements smaller than this (ms, 3 frames at 240 fps) aren't listed; at most NIGHT_ROWS are. The
// two models differ by a steady amount at some positions (the key-position rules are tuned to the
// server's), so each is measured from the usual difference at that position and angle (the median).
const NIGHT_MIN_MS = 12.5, NIGHT_ROWS = 8;
const POSITION_NAMES = { p1: "Address", takeaway: "Takeaway", p7: "Impact" };

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

/** Opens a swing in labeling mode; opts {angle: "face" | "dtl", t} goes to that frame. */
function openForLabeling(name, opts) {
  open(name);
  // Labeling mode once the swing is on screen.
  setTimeout(() => window.Labels && Labels.start && Labels.start(opts), 50);
}

const pickedFilesCache = new Map(); // clipName -> { updated, hasPicked }

async function syncPickedCounts() {
  const p1Clips = (labelData?.clips || []).filter(r => r.pass === 1 && r.clip);
  const needed = p1Clips.filter(r => {
    const cached = pickedFilesCache.get(r.clip);
    return !cached || cached.updated !== r.updated;
  });
  if (!needed.length) return;
  await Promise.all(needed.map(async r => {
    try {
      const res = await fetch(`/api/labels/${encodeURIComponent(r.clip)}?pass=1`, { cache: "no-store" });
      if (res.ok) {
        const doc = await res.json();
        const hasPicked = Boolean(doc.picked && Object.keys(doc.picked).length > 0);
        pickedFilesCache.set(r.clip, { updated: r.updated, hasPicked });
      } else {
        pickedFilesCache.set(r.clip, { updated: r.updated, hasPicked: false });
      }
    } catch {
      pickedFilesCache.set(r.clip, { updated: r.updated, hasPicked: false });
    }
  }));
}

/** Unlabeled swings where the night worker and the server put a key position furthest apart, worst
 * first: {c, angle, key, ms, t}. Drops only (clip, position) pairs that have that event labeled. */
function nightDisagreements(swings) {
  const all = Object.entries((nightData && nightData.swings) || {});
  // The usual difference at each angle and position, over every swing compared.
  const usual = {};
  for (const [, angles] of all) for (const [angle, a] of Object.entries(angles))
    for (const [key, ms] of Object.entries(a.ms || {})) (usual[angle + key] = usual[angle + key] || []).push(ms);
  for (const k in usual) { const v = usual[k].sort((x, y) => x - y); usual[k] = (v[(v.length - 1) >> 1] + v[v.length >> 1]) / 2; }

  if (window.FramePicker && FramePicker.filterDisagreements) {
    return FramePicker.filterDisagreements(all, clips, labelData?.clips || [], usual, NIGHT_MIN_MS);
  }

  const byClip = new Map((labelData?.clips || []).filter(r => r.pass === 1).map(r => [r.clip, r]));
  const isLabeled = (clipName, ev) => {
    const r = byClip.get(clipName);
    if (!r) return false;
    return r.missing ? !r.missing.includes(ev) : (r.events === 8);
  };
  const getEvent = k => k === "p7" ? "impact" : (k === "p1" ? null : k);
  const out = [];
  for (const [main, angles] of all) {
    const c = clips.find(x => x.name === main);
    if (!c || c.excluded) continue;
    let best = null;
    for (const [angle, a] of Object.entries(angles)) {
      for (const [key, raw] of Object.entries(a.ms || {})) {
        if (key === "p1") continue;
        const ev = getEvent(key);
        if (!ev) continue;
        const targetName = angle === "dtl"
          ? (c.angle === "dtl" ? c.name : c.partner)
          : (c.angle === "face" ? c.name : c.partner);
        if (targetName && isLabeled(targetName, ev)) continue;
        const ms = raw - usual[angle + key];
        if (Math.abs(ms) >= NIGHT_MIN_MS && (!best || Math.abs(ms) > Math.abs(best.ms)) && a.t[key] != null)
          best = { c, angle, key, ms, t: a.t[key] };
      }
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => Math.abs(b.ms) - Math.abs(a.ms));
}

function renderNight(swings) {
  const status = document.getElementById("lv-night-status"), box = document.getElementById("lv-night");
  const countEl = document.getElementById("lv-night-count");
  if (!nightData) {
    status.textContent = "";
    if (countEl) countEl.textContent = "";
    box.replaceChildren(lvEl("span", { className: "lv-muted", textContent: "Not reached." }));
    return;
  }
  const seen = nightData.seen && nightData.seen.at
    ? ` · worker last asked ${fmtWhen(new Date(nightData.seen.at * 1000).toISOString())}` : " · no worker yet";
  status.textContent = `${nightData.done} of ${nightData.clips} clips done${seen}`;
  const rows = nightDisagreements(swings);

  const pickedCount = [...pickedFilesCache.values()].filter(x => x.hasPicked).length;
  if (countEl) {
    countEl.textContent = `${pickedCount} picked so far · ${rows.length} left`;
  }

  box.replaceChildren(...(rows.length ? rows.slice(0, NIGHT_ROWS).map(r => {
    const compare = lvEl("button", { className: "small", textContent: "Compare" });
    compare.onclick = () => {
      if (window.FramePicker) {
        FramePicker.open(r, rows, (clipName, ev, doc) => {
          pickedFilesCache.set(clipName, { updated: doc.updated, hasPicked: true });
          const rowInSummary = (labelData?.clips || []).find(c => c.pass === 1 && c.clip === clipName);
          if (rowInSummary) {
            rowInSummary.updated = doc.updated;
            if (rowInSummary.missing) {
              rowInSummary.missing = rowInSummary.missing.filter(m => m !== ev);
              rowInSummary.events = 8 - rowInSummary.missing.length;
            }
          }
          renderLabelView();
        });
      }
    };
    const go = lvEl("button", { className: "small", textContent: "Go" });
    go.onclick = () => openForLabeling(r.c.name, { angle: r.angle, t: r.t });
    const what = `${POSITION_NAMES[r.key] || r.key.toUpperCase()} ${Math.round(Math.abs(r.ms))} ms further apart than usual`
      + ` (${r.angle === "dtl" ? "down the line" : "face-on"})`;
    return lvEl("div", { className: "lv-work-line" },
      lvEl("span", { className: "lv-work-angle", textContent: fmtWhen(r.c.recorded) + (r.c.shot ? " · " + clubName(r.c.shot.club) : "") }),
      lvEl("span", { className: "lv-work-text", textContent: what }), compare, go);
  }) : [lvEl("span", { className: "lv-muted", textContent: nightData.done
    ? "No unlabeled swing where they disagree by 3 frames more than usual." : "Nothing compared yet." })]));
}

/** The worklist: every fix from the label checks, by swing and angle, with repeats of the same fix
 * (hips on 10 frames) on one line. Go opens the swing at the first of them in labeling mode, where
 * the points are ringed in red and Next fix (N) steps through the rest. */
function renderWorklist(rows, swings) {
  const box = document.getElementById("lv-work");
  const byClip = new Map(rows.filter(r => r.pass === 1 && r.clip).map(r => [r.clip, r]));
  const blocks = [];
  let frames = 0, swingsWith = 0;
  for (const s of swings) {
    const lines = [];
    for (const r of [s.face, s.dtl].filter(Boolean)) {
      const groups = new Map();
      for (const f of byClip.get(r.clip)?.fixes || []) {
        const key = f.kind + "|" + f.text;
        if (!groups.has(key)) groups.set(key, { f, ts: [] });
        if (f.t != null) groups.get(key).ts.push(f.t);
      }
      for (const { f, ts } of groups.values()) {
        const angle = r.angle === "dtl" ? "dtl" : "face";
        // The other angle isn't labeled: go there instead.
        const to = f.kind === "other" ? { angle: angle === "dtl" ? "face" : "dtl", t: 0 } : { angle, t: ts[0] ?? null };
        frames += Math.max(1, ts.length);
        const where = f.kind === "other" ? "" : ts.length > 1 ? ` · ${ts.length} frames` : ts.length ? ` · ${ts[0].toFixed(3)} s` : "";
        const go = lvEl("button", { className: "small", textContent: "Go" });
        go.onclick = () => openForLabeling(s.main, to);
        lines.push(lvEl("div", { className: "lv-work-line" },
          lvEl("span", { className: "lv-work-angle", textContent: s.hasDtl ? (angle === "dtl" ? "Down the line" : "Face-on") : "" }),
          lvEl("span", { className: "lv-work-text", textContent: f.text + where }), go));
      }
    }
    if (!lines.length) continue;
    swingsWith++;
    const title = (s.c ? fmtWhen(s.c.recorded) : s.main) + (s.c && s.c.shot ? " · " + clubName(s.c.shot.club) : "");
    blocks.push(lvEl("div", { className: "lv-work-swing" }, lvEl("div", { className: "lv-work-title", textContent: title }), ...lines));
  }
  document.getElementById("lv-work-count").textContent = blocks.length
    ? `${frames} frame(s) to look at on ${swingsWith} swing(s)` : "";
  box.replaceChildren(...(blocks.length ? blocks
    : [lvEl("span", { className: "lv-done", textContent: "Nothing to fix: every check passes." })]));
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

  renderWorklist(rows, swings);
  renderNight(swings);

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
    if (res.ok) {
      labelData = await res.json();
      await syncPickedCounts();
    }
    const night = await fetch("/api/night", { cache: "no-store" });
    if (night.ok) nightData = await night.json();
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
