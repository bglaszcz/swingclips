// Shutter test (button at the top): Auto against a fixed short shutter, without labels. Clips are
// grouped by camera and shutter setting, over all clips and per session, with the light, grain,
// flicker and sharpness the server measured from each (server/quality.py, as `quality` on each clip).
// Uses the page's globals: clips, sessionsOf, sessionTitle, showView (trends.js), renderList, closeTrendView.

const shutterBox = document.getElementById("shutter");
let shutterSig = "";

/** As quality.shutter_group: "Auto", "1/1000", "1/1000 (compensation)", or "unknown" (before capture app 0.4). */
function shutterGroup(cam) {
  if (!cam) return "unknown";
  let setting = cam.shutter || (cam.exposure === "auto" ? "Auto" : "unknown");
  if (setting !== "Auto" && cam.exposure && cam.exposure !== "manual" && cam.exposure !== "auto") setting += ` (${cam.exposure})`;
  return setting;
}

/** Sort order of the settings: Auto first, then by how short the shutter is. */
function shutterOrder(g) {
  if (g === "Auto") return 0;
  const m = g.match(/^1\/(\d+)/);
  return m ? +m[1] : 1e9;
}

function medianOf(values) {
  const v = values.filter(x => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const k = v.length >> 1;
  return v.length % 2 ? v[k] : (v[k - 1] + v[k]) / 2;
}

/** A list of clips as rows: one per camera angle and shutter setting, with the medians. */
function qualityGroups(list) {
  const groups = new Map();
  for (const c of list) {
    const key = `${c.angle}|${shutterGroup(c.camera)}`;
    if (!groups.has(key)) groups.set(key, { angle: c.angle, shutter: shutterGroup(c.camera), clips: [] });
    groups.get(key).clips.push(c);
  }
  return [...groups.values()].map(g => {
    const qs = g.clips.map(c => c.quality).filter(Boolean);
    const sharp = key => medianOf(qs.map(q => q.sharpness && q.sharpness[key]));
    return {
      ...g, measured: qs.length,
      speed: medianOf(g.clips.map(c => c.camera && c.camera.shutterSpeed)),
      iso: medianOf(g.clips.map(c => c.camera && c.camera.iso)),
      brightness: medianOf(qs.map(q => q.brightness)),
      noise: medianOf(qs.map(q => q.noise)),
      flicker: qs.filter(q => (q.warnings || []).includes("flicker")).length,
      address: sharp("p1"), p6: sharp("p6"), downswing: sharp("downswing"),
    };
  }).sort((a, b) => (a.angle === b.angle ? 0 : a.angle === "face" ? -1 : 1) || shutterOrder(a.shutter) - shutterOrder(b.shutter));
}

// Columns: [heading, value, digits, which way is better (for marking the best of a session)].
const Q_COLS = [
  ["Real shutter", r => r.speed && `1/${Math.round(r.speed)} s`],
  ["ISO", r => r.iso && Math.round(r.iso)],
  ["Clips", r => r.measured < r.clips.length ? `${r.measured} of ${r.clips.length}` : r.measured],
  ["Golfer", r => r.brightness, 0, "up"],
  ["Noise", r => r.noise, 1, "down"],
  ["Flicker", r => r.measured ? `${r.flicker} of ${r.measured}` : null],
  ["Sharp at address", r => r.address, 0],
  ["P6 / address", r => r.p6, 2, "up"],
  ["P5-P7 / address", r => r.downswing, 2, "up"],
];

function qualityHead(first) {
  const tr = document.createElement("tr");
  for (const t of [first, "Shutter", ...Q_COLS.map(c => c[0])]) tr.append(Object.assign(document.createElement("th"), { textContent: t }));
  const thead = document.createElement("thead");
  thead.append(tr);
  return thead;
}

/** Table rows for groups of one angle; with `mark`, the best of them per column is marked. */
function qualityRows(groups, mark) {
  const best = {};
  if (mark && groups.filter(g => g.measured).length > 1) {
    Q_COLS.forEach(([, get, , better], i) => {
      if (!better) return;
      const vs = groups.map(get).filter(v => typeof v === "number");
      if (vs.length > 1) best[i] = better === "up" ? Math.max(...vs) : Math.min(...vs);
    });
  }
  return groups.map((g, gi) => {
    const tr = document.createElement("tr");
    const cam = g.angle === "dtl" ? "Down the line" : "Face-on";
    tr.append(Object.assign(document.createElement("td"), { textContent: gi === 0 || groups[gi - 1].angle !== g.angle ? cam : "" }),
              Object.assign(document.createElement("td"), { textContent: g.shutter }));
    Q_COLS.forEach(([, get, digits], i) => {
      const v = get(g);
      const td = document.createElement("td");
      td.textContent = v == null ? "–" : typeof v === "number" && digits != null ? v.toFixed(digits) : v;
      if (i in best && v === best[i]) td.classList.add("best");
      if (i === 5 && g.flicker) td.classList.add("bad");
      tr.append(td);
    });
    return tr;
  });
}

function renderShutter() {
  const analyzed = clips.filter(c => c.pose === "done");
  const measured = analyzed.filter(c => c.quality).length;
  document.getElementById("q-status").textContent = analyzed.length
    ? `${measured} of ${analyzed.length} analyzed clips measured${measured < analyzed.length ? " (the server works through the rest)" : ""}`
    : "No analyzed clips yet.";

  const all = document.getElementById("q-all");
  const body = document.createElement("tbody");
  const groups = qualityGroups(analyzed);
  for (const angle of ["face", "dtl"]) body.append(...qualityRows(groups.filter(g => g.angle === angle), true));
  all.replaceChildren(qualityHead("Camera"), body);

  // Per session: the settings tried that session, side by side for each camera.
  const mixedBox = document.getElementById("q-mixed");
  const sessions = sessionsOf(analyzed).map(s => ({ s, groups: qualityGroups(s.clips) }))
    .filter(x => x.groups.some(g => g.measured));
  const mixed = x => ["face", "dtl"].some(a => x.groups.filter(g => g.angle === a && g.measured).length > 1);
  if (mixedBox.dataset.set !== "1") {
    mixedBox.checked = sessions.some(mixed);   // on by default once a session compared settings
    mixedBox.dataset.set = "1";
  }
  const shown = mixedBox.checked ? sessions.filter(mixed) : sessions;
  const tbody = document.createElement("tbody");
  for (const { s, groups: g } of shown) {
    const head = document.createElement("tr");
    head.className = "q-session";
    head.append(Object.assign(document.createElement("td"), { colSpan: 2 + Q_COLS.length, textContent: sessionTitle(s) }));
    tbody.append(head);
    for (const angle of ["face", "dtl"]) tbody.append(...qualityRows(g.filter(x => x.angle === angle), true));
  }
  if (!shown.length) {
    const tr = document.createElement("tr");
    tr.append(Object.assign(document.createElement("td"), {
      colSpan: 2 + Q_COLS.length,
      textContent: mixedBox.checked ? "No session has clips with more than one shutter setting yet." : "No measured clips yet.",
    }));
    tbody.append(tr);
  }
  document.getElementById("q-sessions").replaceChildren(qualityHead("Camera"), tbody);
}

function openShutter() {
  showView("shutter");
  renderList();
  shutterSig = "";
  shutterTick();
  shutterBox.scrollTop = 0;
  if (window.innerWidth < 900) shutterBox.scrollIntoView();
}

/** Called on each refresh of the clip list: keeps the view up to date as clips are measured. */
function shutterTick() {
  if (shutterBox.hidden) return;
  const sig = JSON.stringify(clips.map(c => [c.name, c.pose, c.quality, c.camera]));
  if (sig === shutterSig) return;
  shutterSig = sig;
  renderShutter();
}

document.getElementById("shutter-btn").onclick = () => shutterBox.hidden ? openShutter() : closeTrendView();
document.getElementById("q-close").onclick = () => closeTrendView();
document.getElementById("q-mixed").onchange = () => renderShutter();
