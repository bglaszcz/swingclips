// Practice (button at the top): pick one number and a range; after each swing the speaking phone says
// the number and whether it was in range (server/practice.py makes the sentence). The range can
// start from the middle half of your recent swings with a club. Below it, the log of what was said,
// per session, with the share in range.
// Uses the page's globals: showView, closeTrendView, loadTrendData, swingRow, quantile (trends.js),
// clips, shownClips, clubName, open, renderList, SESSION_GAP_MS.

const practiceBox = document.getElementById("practice");
const prEl = id => document.getElementById(id);
let prState = null;       // /api/practice: {config, metrics, log, listeners}
let prTimer = 0;
let prForm = null;        // what's in the form: {metric, club, min, max, streak}
// Swings the middle-half range is taken from: the latest this many with the club.
const PR_SUGGEST_N = 30, PR_SUGGEST_MIN = 5;
// A phone that asked for results within this many seconds is listening (it long-polls every ~20 s).
const PR_LISTENING_S = 40;
const PR_GROUPS = [["face", "Face-on"], ["dtl", "Down the line"], ["shot", "Launch monitor (Square)"]];

async function openPractice() {
  showView("practice");
  renderList();
  if (window.innerWidth < 900) practiceBox.scrollIntoView();
  await loadTrendData();   // the swings' body numbers, for the suggested range
  pollPractice();
}

async function loadPractice() {
  try {
    const res = await fetch("/api/practice");
    if (!res.ok) return;
    prState = await res.json();
  } catch { return; }
  if (!prForm) {
    const c = prState.config;
    // club: "" = any club; never chosen (null) = the most-hit one.
    prForm = { metric: c.metric, club: c.club ?? undefined, min: c.min, max: c.max, streak: c.streak };
  }
  renderPracticeForm();
  renderPracticeLog();
}

async function pollPractice() {
  clearTimeout(prTimer);
  if (practiceBox.hidden) return;
  await loadPractice();
  prTimer = setTimeout(pollPractice, 5000);
}

const prMetric = key => prState && prState.metrics.find(m => m.key === key);
const prFmt = (m, v) => v == null || !Number.isFinite(v) ? "–" : v.toFixed(m.dec);
const prUnit = m => m.unit === ":1" ? ": 1" : m.unit;

/** The middle half of the latest swings with the club: {n, lo, hi, med} or null. */
function practiceSuggestion(m, club) {
  const values = [];
  for (const c of shownClips()) {
    if (c.excluded || (club && (!c.shot || c.shot.club !== club))) continue;
    const r = swingRow(c);
    // swingRow leaves out a camera the camera check flags; an estimated P6 is left out here too.
    if (m.pos === "p6" && r.rec && r.rec.quality && r.rec.quality.p6Estimated) continue;
    const v = r[m.key];
    if (v != null && Number.isFinite(v)) values.push(v);
    if (values.length >= PR_SUGGEST_N) break;
  }
  if (values.length < PR_SUGGEST_MIN) return { n: values.length };
  values.sort((a, b) => a - b);
  const round = v => Number(v.toFixed(m.dec));
  return { n: values.length, lo: round(quantile(values, 0.25)), hi: round(quantile(values, 0.75)),
           med: quantile(values, 0.5) };
}

function renderPracticeForm() {
  if (!prState || !prForm) return;
  const c = prState.config;
  const sel = prEl("pr-metric");
  if (!sel.options.length) {
    sel.replaceChildren(...PR_GROUPS.map(([view, name]) => {
      const g = Object.assign(document.createElement("optgroup"), { label: name });
      for (const m of prState.metrics.filter(m => (m.kind === "shot" ? "shot" : m.view) === view)) {
        g.append(Object.assign(document.createElement("option"), {
          value: m.key, textContent: m.label + (m.noisy ? "  (noisy)" : ""), title: m.noisy || "" }));
      }
      return g;
    }));
  }
  sel.value = prForm.metric;
  const m = prMetric(prForm.metric);

  // Clubs from the launch monitor, most-hit first.
  const counts = {};
  for (const x of shownClips()) if (x.shot && x.shot.club) counts[x.shot.club] = (counts[x.shot.club] || 0) + 1;
  const clubs = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  if (prForm.club === undefined || (prForm.club && !counts[prForm.club])) prForm.club = clubs[0] ?? null;
  const clubSel = prEl("pr-club");
  const clubSig = JSON.stringify(counts);
  if (clubSel.dataset.sig !== clubSig) {   // not on every poll: that would close an open list
    clubSel.dataset.sig = clubSig;
    clubSel.replaceChildren(Object.assign(document.createElement("option"), { value: "", textContent: "Any club" }),
      ...clubs.map(k => Object.assign(document.createElement("option"), { value: k, textContent: `${clubName(k)} (${counts[k]})` })));
  }
  clubSel.value = prForm.club || "";

  if (document.activeElement !== prEl("pr-min")) prEl("pr-min").value = prForm.min ?? "";
  if (document.activeElement !== prEl("pr-max")) prEl("pr-max").value = prForm.max ?? "";
  prEl("pr-unit").textContent = prUnit(m);
  prEl("pr-streak").checked = prForm.streak;

  const s = practiceSuggestion(m, prForm.club);
  const withClub = prForm.club ? `with the ${clubName(prForm.club).toLowerCase()}` : "";
  prEl("pr-suggest").textContent = s.lo == null
    ? `Not enough swings ${withClub} with this number yet for a suggested range (${s.n} of ${PR_SUGGEST_MIN}).`
    : `Middle half of your last ${s.n} swings ${withClub}: ${prFmt(m, s.lo)} to ${prFmt(m, s.hi)} (median ${prFmt(m, s.med)}).`;
  prEl("pr-use").disabled = s.lo == null;
  if (m.noisy) prEl("pr-suggest").textContent += ` Noisy: ${m.noisy}.`;

  const changed = prForm.metric !== c.metric || prForm.min !== c.min || prForm.max !== c.max
    || prForm.streak !== c.streak || (prForm.club || null) !== (c.club || null);
  const state = prEl("pr-state");
  const cm = prMetric(c.metric);
  state.classList.toggle("on", c.on);
  state.textContent = c.on
    ? `On: ${cm.label} ${prFmt(cm, c.min)} to ${prFmt(cm, c.max)}${cm.unit && cm.unit !== ":1" ? " " + cm.unit : ""}`
    : "Off: nothing is spoken.";
  const toggle = prEl("pr-toggle");
  toggle.textContent = c.on ? "Stop practice" : "Start practice";
  toggle.classList.toggle("on", c.on);
  prEl("pr-save").hidden = !(c.on && changed);

  // Which phones are listening.
  const listening = Object.entries(prState.listeners || {}).filter(([, age]) => age <= PR_LISTENING_S).map(([a]) => a);
  const names = { face: "face-on", dtl: "down-the-line" };
  prEl("pr-status").textContent = listening.length
    ? `Speaking: the ${listening.map(a => names[a] || a).join(" and ")} phone`
    : "No phone is listening: open SwingClips on the face-on phone (Practice voice on).";
}

function readRange() {
  const num = id => { const v = parseFloat(prEl(id).value.replace(",", ".")); return Number.isFinite(v) ? v : null; };
  prForm.min = num("pr-min");
  prForm.max = num("pr-max");
}

async function savePractice(on) {
  readRange();
  const msg = prEl("pr-msg");
  msg.classList.remove("bad");
  if (prForm.min == null || prForm.max == null || prForm.min > prForm.max) {
    msg.textContent = "Set the range: a low number and a high number.";
    msg.classList.add("bad");
    return;
  }
  try {
    const res = await fetch("/api/practice", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...prForm, club: prForm.club ?? null, on }) });
    if (!res.ok) throw new Error((await res.json()).detail || res.status);
    prState.config = await res.json();
    msg.textContent = on ? "Saved. The next swing is spoken." : "Practice stopped.";
  } catch (e) {
    msg.textContent = `Couldn't save: ${e.message}`;
    msg.classList.add("bad");
  }
  renderPracticeForm();
}

prEl("pr-metric").onchange = e => {
  prForm.metric = e.target.value;
  usePracticeSuggestion(true);
};
prEl("pr-club").onchange = e => {
  prForm.club = e.target.value;
  usePracticeSuggestion(false);
};
prEl("pr-min").oninput = prEl("pr-max").oninput = () => { readRange(); renderPracticeForm(); };
prEl("pr-streak").onchange = e => { prForm.streak = e.target.checked; renderPracticeForm(); };
prEl("pr-use").onclick = () => usePracticeSuggestion(false);
prEl("pr-toggle").onclick = () => savePractice(!prState.config.on);
prEl("pr-save").onclick = () => savePractice(true);
prEl("pr-test").onclick = async () => {
  const msg = prEl("pr-msg");
  try {
    const res = await fetch("/api/practice/test", { method: "POST" });
    msg.textContent = res.ok ? "Sent: the speaking phone should say \"Practice voice check\" within a second or two." : "Couldn't send it.";
  } catch { msg.textContent = "Couldn't reach the server."; }
};
prEl("pr-close").onclick = () => closeTrendView();
prEl("practice-btn").onclick = () => practiceBox.hidden ? openPractice() : closeTrendView();

/** Sets the range to the suggestion; on a new number with no suggestion, clears it to be typed in. */
function usePracticeSuggestion(newMetric) {
  const m = prMetric(prForm.metric);
  const s = practiceSuggestion(m, prForm.club);
  if (s.lo != null) { prForm.min = s.lo; prForm.max = s.hi; }
  else if (newMetric) { prForm.min = prForm.max = null; }
  prEl("pr-min").value = prForm.min ?? "";
  prEl("pr-max").value = prForm.max ?? "";
  renderPracticeForm();
}

// ---- Log ----

function renderPracticeLog() {
  const box = prEl("pr-log");
  const log = (prState.log || []).filter(e => !e.test);
  if (!log.length) { box.textContent = "Nothing spoken yet."; return; }
  // Newest session first, each newest swing first.
  const sessions = [];
  for (const e of [...log].reverse()) {
    const s = sessions[sessions.length - 1];
    if (s && (s.start - e.t) * 1000 < SESSION_GAP_MS) { s.entries.push(e); s.start = e.t; }
    else sessions.push({ entries: [e], start: e.t, end: e.t });
  }
  const time = t => new Date(t * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = t => new Date(t * 1000).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  box.replaceChildren(...sessions.slice(0, 12).map(s => {
    const div = Object.assign(document.createElement("div"), { className: "pr-session" });
    const head = Object.assign(document.createElement("div"), { className: "pr-shead" });
    head.append(Object.assign(document.createElement("strong"), { textContent: `${day(s.start)} · ${time(s.start)} – ${time(s.end)}` }));
    // Share in range, per target used in the session.
    const targets = new Map();
    for (const e of s.entries) {
      const k = `${e.metric}|${e.min}|${e.max}`;
      if (!targets.has(k)) targets.set(k, []);
      targets.get(k).push(e);
    }
    for (const es of targets.values()) {
      const m = prMetric(es[0].metric) || { label: es[0].metric, dec: 1, unit: "" };
      const read = es.filter(e => e.status !== "none"), inside = read.filter(e => e.status === "in");
      const none = es.length - read.length;
      head.append(Object.assign(document.createElement("span"), {
        textContent: `${m.label} ${prFmt(m, es[0].min)} to ${prFmt(m, es[0].max)}: `
          + (read.length ? `${inside.length} of ${read.length} in range (${Math.round(100 * inside.length / read.length)}%)` : "no readings")
          + (none ? `, ${none} no reading` : ""),
      }));
    }
    const table = Object.assign(document.createElement("table"), { className: "pr-log" });
    for (const e of s.entries) {
      const m = prMetric(e.metric) || { dec: 1, unit: "", low: "low", high: "high" };
      const tr = document.createElement("tr");
      const cls = e.status === "in" ? "pr-in" : e.status === "none" ? "pr-none" : "pr-out";
      const said = e.status === "in" ? "In range" : e.status === "none" ? (e.why === "no shot" ? "No shot" : "No reading")
        : `Out: ${m[e.status]}`;
      for (const [text, c] of [[time(e.t), ""], [e.value == null ? "–" : `${prFmt(m, e.value)} ${prUnit(m)}`.trim(), ""],
                               [said, cls], [e.status === "none" ? e.why || "" : e.streak >= 3 ? `${e.streak} in a row` : "", "pr-why"]]) {
        tr.append(Object.assign(document.createElement("td"), { textContent: text, className: c }));
      }
      tr.title = `Said: "${e.text}"`;
      tr.onclick = () => { if (clips.some(c => c.name === e.clip)) open(e.clip); };
      table.append(tr);
    }
    div.append(head, table);
    return div;
  }));
}
