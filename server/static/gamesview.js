// Practice games (a card at the top of Practice): pick a game, and the speaking phone says a target
// ("110 yards"); once Square's shot is in it says how close the ball finished and the next target
// (server/games.py; targets and scoring in games.js). Below: the game in play, and each finished
// Combine's score so they can be compared week to week.
// Uses the page's globals: practiceBox, clubName (index.html / practice.js).

const gmEl = id => document.getElementById(id);
let gmState = null;   // /api/game: {game, games, log}

async function loadGames() {
  try {
    const res = await fetch("/api/game");
    if (!res.ok) return;
    gmState = await res.json();
  } catch { return; }
  renderGames();
}

const gmSg = v => v == null || !Number.isFinite(v) ? "–" : (v >= 0 ? "+" : "") + v.toFixed(2);
const gmYd = v => v == null || !Number.isFinite(v) ? "–" : Math.round(v) + " yd";
const gmDay = t => new Date(t * 1000).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

function gmCell(text, title) {
  return Object.assign(document.createElement("td"), { textContent: text, title: title || "" });
}

function renderGames() {
  if (!gmState) return;
  const g = gmState.game;
  const sel = gmEl("gm-game");
  if (!sel.options.length) {
    sel.replaceChildren(...gmState.games.map(x =>
      Object.assign(document.createElement("option"), { value: x.id, textContent: x.name, title: x.describe })));
  }
  gmEl("gm-describe").textContent = (gmState.games.find(x => x.id === sel.value) || {}).describe || "";
  gmEl("gm-start").textContent = g ? "Start again" : "Start game";
  gmEl("gm-stop").hidden = !g;

  const now = gmEl("gm-now");
  if (!g) {
    now.textContent = "No game in play.";
  } else {
    const s = g.summary || {};
    const targetText = g.sayTarget || (Number.isFinite(g.target) ? `${g.target} yards` : String(g.target));
    now.replaceChildren(
      Object.assign(document.createElement("div"), { className: "gm-target",
        textContent: `${g.name}: next target ${targetText}` }),
      Object.assign(document.createElement("div"), { className: "note",
        textContent: !s.shots ? "No shots yet." : `${s.shots} shots, ${s.greens} ${g.hitWord || "on the green"}` +
          (g.id === "shaping" ? "" : `, ${gmSg(s.sgPerShot)} strokes a shot against tour`) +
          (s.mishits ? `, ${s.mishits} mishit${s.mishits > 1 ? "s" : ""}` : "") }),
      ...(g.results.length ? [gmResultsTable([...g.results].reverse())] : []));
  }

  // Finished Combines, newest first: the number to follow.
  const combines = gmState.log.filter(x => x.id === "combine" && x.summary).reverse();
  const box = gmEl("gm-history");
  if (!combines.length) { box.textContent = "No Combine finished yet."; return; }
  const t = document.createElement("table");
  t.append(Object.assign(document.createElement("tr"), {}));
  t.rows[0].append(...["Day", "Shots", "Greens", "Strokes a shot vs tour", "Ended"].map(h =>
    Object.assign(document.createElement("th"), { textContent: h })));
  for (const x of combines) {
    const r = t.insertRow();
    r.append(gmCell(gmDay(x.started)), gmCell(String(x.summary.shots)), gmCell(String(x.summary.greens)),
      gmCell(gmSg(x.summary.sgPerShot)), gmCell(x.how === "done" ? "finished" : x.how === "idle" ? "left unfinished" : "stopped"));
  }
  const elements = [t];
  const breakdown = typeof SwingGames !== "undefined" && SwingGames.combineBreakdown ? SwingGames.combineBreakdown(gmState.log) : null;
  if (breakdown && breakdown.targets && breakdown.targets.length) {
    const worstText = breakdown.worst && breakdown.worst.length
      ? breakdown.worst.map(w => `${w.target} yd ${gmSg(w.sgPerShot)} a shot`).join(", ")
      : "not enough shots yet";
    const line = Object.assign(document.createElement("div"), {
      className: "note",
      style: "margin: 12px 0 6px;",
      textContent: `Where you lose strokes (last 3 Combines): ${worstText}.`,
    });
    elements.push(line);
    const bt = document.createElement("table");
    bt.append(document.createElement("tr"));
    bt.rows[0].append(...["Target", "Shots", "Greens", "Strokes a shot"].map(h =>
      Object.assign(document.createElement("th"), { textContent: h })));
    for (const b of breakdown.targets) {
      const r = bt.insertRow();
      r.append(gmCell(b.target + " yd"), gmCell(String(b.shots)), gmCell(String(b.greens)), gmCell(gmSg(b.sgPerShot)));
    }
    elements.push(bt);
  }
  box.replaceChildren(...elements);
}

function gmTargetText(target) {
  if (target === 0 || target === "fairway") return "fairway";
  if (target === "draw" || target === "fade") return target;
  if (Number.isFinite(target)) return target + " yd";
  return String(target ?? "–");
}

function gmResultsTable(results) {
  const t = document.createElement("table");
  t.append(document.createElement("tr"));
  t.rows[0].append(...["Target", "Club", "Carry", "Finished", "Strokes vs tour"].map(h =>
    Object.assign(document.createElement("th"), { textContent: h })));
  for (const x of results.slice(0, 30)) {
    const r = t.insertRow();
    r.append(gmCell(gmTargetText(x.target)), gmCell(x.club ? clubName(x.club) : "–"), gmCell(gmYd(x.carry)),
      gmCell(x.verdict || (x.sg == null ? "mishit" : gmYd(x.dist) + (x.onGreen ? ", on the green" : ""))), gmCell(gmSg(x.sg)));
  }
  return t;
}

async function gmPost(url, body) {
  gmEl("gm-msg").textContent = "";
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}) });
    if (!res.ok) { gmEl("gm-msg").textContent = (await res.json().catch(() => ({}))).detail || "Didn't work"; return; }
  } catch { gmEl("gm-msg").textContent = "Can't reach the server"; return; }
  await loadGames();
  if (typeof loadPractice === "function") loadPractice();   // starting a game turns practice off
}

gmEl("gm-game").addEventListener("change", renderGames);
gmEl("gm-start").addEventListener("click", () => gmPost("/api/game", { game: gmEl("gm-game").value }));
gmEl("gm-stop").addEventListener("click", () => gmPost("/api/game/stop"));
