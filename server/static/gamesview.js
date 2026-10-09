// Practice games (a card at the top of Practice): pick a game, and the speaking phone says a target
// ("110 yards"); once Square's shot is in it says how close the ball finished and the next target
// (server/games.py; targets and scoring in games.js). Below: the game in play, and each finished
// Combine's score so they can be compared week to week.
// Uses the page's globals: practiceBox, clubName (index.html / practice.js).

const gmEl = id => typeof document !== "undefined" ? document.getElementById(id) : null;
let gmState = null;   // /api/game: {game, games, log}

async function loadGames() {
  try {
    const res = await fetch("/api/game");
    if (!res.ok) return;
    gmState = await res.json();
  } catch { return; }
  renderGames();
}

// Matches HIT_WORDS in server/games.py (the game in play has g.hitWord, but past games need it too)
const HIT_WORDS = {
  driving: "in the fairway",
  shaping: "shaped as called",
  distance: "within 5 yards",
  holes: "on the green",
};

const gmSg = v => v == null || !Number.isFinite(v) ? "–" : ((v > 0 ? "+" : "") + v.toFixed(2)).replace(/^[+-]?0(\.0+)?$/, "0.00");
const gmYd = v => v == null || !Number.isFinite(v) ? "–" : Math.round(v) + " yd";
const gmDay = t => new Date(t * 1000).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

function gmCell(text, title) {
  return Object.assign(document.createElement("td"), { textContent: text, title: title || "" });
}

function wrapTable(table) {
  const wrap = document.createElement("div");
  wrap.style.overflowX = "auto";
  wrap.append(table);
  return wrap;
}

/** Formats a running strokes-gained score into plain words. */
function runningScoreWords(sg) {
  if (sg == null || !Number.isFinite(sg)) return "";
  const sign = sg >= 0 ? "+" : "";
  const numStr = sign + (Object.is(sg, -0) ? 0 : sg).toFixed(1);
  const abs = Math.abs(sg);
  let words = "";
  if (abs < 0.15) {
    words = "about even with a tour player so far";
  } else if (sg > 0) {
    if (abs < 0.7) words = "a bit better than a tour player so far";
    else if (abs < 1.2) words = "about a stroke better than a tour player so far";
    else if (abs < 1.7) words = "a little over a stroke better than a tour player so far";
    else if (abs < 2.5) words = "about two strokes better than a tour player so far";
    else words = `${abs.toFixed(1)} strokes better than a tour player so far`;
  } else {
    if (abs < 0.7) words = "a bit behind a tour player so far";
    else if (abs < 1.2) words = "about a stroke behind";
    else if (abs < 1.7) words = "a little over a stroke behind";
    else if (abs < 2.5) words = "about two strokes behind";
    else words = `${abs.toFixed(1)} strokes behind`;
  }
  return `${numStr}: ${words}`;
}

/** Formats a target description for best/worst target display. */
function formatTargetName(target) {
  if (target === 0 || target === "fairway") return "fairway";
  if (Number.isFinite(target)) return `${target} yd`;
  if (typeof target === "string") return target;
  if (target && typeof target === "object" && Number.isFinite(target.yards)) {
    return target.shot === 1 ? `hole ${target.hole} fairway` : `hole ${target.hole} (${target.yards} yd)`;
  }
  return String(target ?? "–");
}

/** Formats a summary sentence comparing the last finished game to the previous one of the same kind. */
function lastGameSummary(lastGame, prevGame) {
  if (!lastGame) return "No game in play.";
  const name = lastGame.name || "Game";
  const sum = lastGame.summary || {};
  let scorePart = "";

  if (lastGame.id === "shaping") {
    const greens = sum.greens ?? 0;
    const shots = sum.shots ?? 0;
    let comp = "";
    if (prevGame && prevGame.summary && prevGame.summary.shots > 0) {
      const pGreens = prevGame.summary.greens ?? 0;
      const pShots = prevGame.summary.shots;
      const rate = shots > 0 ? greens / shots : 0;
      const pRate = pGreens / pShots;
      const diff = rate - pRate;
      const word = diff > 0.05 ? "better than last time" : diff < -0.05 ? "worse than last time" : "about the same as last time";
      comp = `, ${word} (${pGreens}/${pShots})`;
    }
    scorePart = `${name}: ${greens} of ${shots} shaped as called${comp}`;
  } else {
    const sg = sum.sgTotal ?? 0;
    const sgStr = (sg >= 0 ? "+" : "") + sg.toFixed(1);
    let comp = "";
    if (prevGame && prevGame.summary && prevGame.summary.sgTotal != null) {
      const pSg = prevGame.summary.sgTotal;
      const pStr = (pSg >= 0 ? "+" : "") + pSg.toFixed(1);
      const diff = sg - pSg;
      const word = diff > 0.2 ? "better than last time" : diff < -0.2 ? "worse than last time" : "about the same as last time";
      comp = `, ${word} (${pStr})`;
    }
    scorePart = `${name}: ${sgStr}${comp}`;
  }

  // Best and worst target
  const byTarget = sum.byTarget || (typeof SwingGames !== "undefined" && lastGame.results ? SwingGames.summarize(lastGame.results).byTarget : []);
  const validTargets = (byTarget || []).filter(t => t.shots > 0);
  if (validTargets.length >= 2) {
    const sorted = [...validTargets].sort((a, b) => (b.sgPerShot ?? 0) - (a.sgPerShot ?? 0));
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    if (best.target !== worst.target) {
      return `${scorePart}. Best target ${formatTargetName(best.target)}, worst ${formatTargetName(worst.target)}.`;
    }
  }

  return `${scorePart}.`;
}

function renderGames() {
  if (!gmState) return;
  const g = gmState.game;
  const sel = gmEl("gm-game");
  if (sel && !sel.options.length) {
    sel.replaceChildren(...(gmState.games || []).map(x =>
      Object.assign(document.createElement("option"), { value: x.id, textContent: x.name, title: x.describe })));
  }
  const curGameId = sel ? sel.value : null;
  const descEl = gmEl("gm-describe");
  if (descEl) descEl.textContent = (gmState.games.find(x => x.id === curGameId) || {}).describe || "";
  const startBtn = gmEl("gm-start");
  if (startBtn) startBtn.textContent = g ? "Start again" : "Start game";
  const stopBtn = gmEl("gm-stop");
  if (stopBtn) stopBtn.hidden = !g;

  const now = gmEl("gm-now");
  if (now) {
    if (!g) {
      const finished = (gmState.log || []).filter(x => x.summary && x.summary.shots > 0);
      const lastFinished = finished.length ? finished[finished.length - 1] : null;
      if (lastFinished) {
        const sameKind = finished.filter(x => x.id === lastFinished.id);
        const prevFinished = sameKind.length >= 2 ? sameKind[sameKind.length - 2] : null;
        const summaryText = lastGameSummary(lastFinished, prevFinished);
        const line = Object.assign(document.createElement("div"), {
          className: "gm-ended",
          textContent: summaryText
        });
        now.replaceChildren(
          line,
          ...(lastFinished.results && lastFinished.results.length ? [wrapTable(gmResultsTable([...lastFinished.results].reverse()))] : [])
        );
      } else {
        now.textContent = "No game in play.";
      }
    } else {
      const s = g.summary || {};
      const targetText = g.sayTarget || (Number.isFinite(g.target) ? `${g.target} yards` : String(g.target));
      const totalShots = g.options?.count || (typeof SwingGames !== "undefined" && SwingGames.GAMES && SwingGames.GAMES[g.id]?.plan ? SwingGames.GAMES[g.id].plan(g.options)?.length : null);
      const shotCountText = totalShots
        ? `Shot ${s.shots || 0} of ${totalShots}`
        : `${s.shots || 0} shot${s.shots === 1 ? "" : "s"}`;
      const runningScore = g.id === "shaping"
        ? `${s.greens || 0} shaped as called so far`
        : runningScoreWords(s.sgTotal);

      const targetEl = Object.assign(document.createElement("div"), {
        className: "gm-target-big",
        textContent: targetText
      });
      const scoreEl = Object.assign(document.createElement("div"), {
        className: "gm-score",
        textContent: !s.shots ? `${shotCountText} · No score yet` : `${shotCountText} · ${runningScore}`
      });

      now.replaceChildren(
        targetEl,
        scoreEl,
        ...(g.results && g.results.length ? [wrapTable(gmResultsTable([...g.results].reverse()))] : [])
      );
    }
  }

  // Setup fold memory for "How games are scored and past games"
  const gmFold = document.querySelector('#practice details[data-fold="games-scoring"]');
  if (gmFold && !gmFold._initFold) {
    gmFold._initFold = true;
    try { gmFold.open = localStorage.getItem("fold-games-scoring") === "open"; } catch {}
    gmFold.addEventListener("toggle", () => {
      try { localStorage.setItem("fold-games-scoring", gmFold.open ? "open" : "shut"); } catch {}
    });
  }

  // Past games history for the selected game.
  const hSel = gmEl("gm-history-game");
  if (hSel && !hSel.options.length && gmState.games) {
    hSel.replaceChildren(...gmState.games.map(x =>
      Object.assign(document.createElement("option"), { value: x.id, textContent: x.name })));
    hSel.value = "combine";
  }
  const selectedGame = (hSel && hSel.value) || "combine";
  const gameObj = (gmState.games || []).find(x => x.id === selectedGame);
  const gameName = (gameObj && gameObj.name) || (selectedGame === "combine" ? "Combine" : selectedGame);

  const history = typeof SwingGames !== "undefined" && SwingGames.gameHistory
    ? SwingGames.gameHistory(gmState.log, selectedGame)
    : [];

  const box = gmEl("gm-history");
  if (!box) return;
  const elements = [];
  if (!history.length) {
    elements.push(Object.assign(document.createElement("div"), {
      textContent: `No ${gameName} finished yet.`,
    }));
  } else {
    const hitWord = HIT_WORDS[selectedGame] || "on the green";
    const hitHeader = hitWord.charAt(0).toUpperCase() + hitWord.slice(1);
    const t = document.createElement("table");
    t.append(Object.assign(document.createElement("tr"), {}));
    t.rows[0].append(...["Day", "Shots", hitHeader, "Strokes a shot vs tour", "Ended"].map(h =>
      Object.assign(document.createElement("th"), { textContent: h })));
    for (const x of history) {
      const r = t.insertRow();
      r.append(gmCell(gmDay(x.started)), gmCell(String(x.shots)), gmCell(String(x.hits)),
        gmCell(gmSg(x.sgPerShot)), gmCell(x.how === "done" ? "finished" : x.how === "idle" ? "left unfinished" : "stopped"));
      if (history.best && x === history.best) {
        r.title = `Personal best: ${Math.round(x.hitShare * 100)}% ${hitWord}`;
      }
    }
    elements.push(wrapTable(t));
    if (selectedGame === "combine") {
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
        elements.push(wrapTable(bt));
      }
    }
  }

  // Clubs you pick by distance
  const clubRows = typeof SwingGames !== "undefined" && SwingGames.clubsByTarget
    ? SwingGames.clubsByTarget(gmState.log)
    : [];
  if (clubRows.length) {
    const det = document.createElement("details");
    det.style.marginTop = "12px";
    const sum = document.createElement("summary");
    sum.textContent = "Clubs you pick by distance";
    sum.style.cursor = "pointer";
    det.append(sum);

    const ct = document.createElement("table");
    ct.style.marginTop = "6px";
    ct.append(document.createElement("tr"));
    ct.rows[0].append(...["Target", "Clubs used", "Best club"].map(h =>
      Object.assign(document.createElement("th"), { textContent: h })));

    for (const r of clubRows) {
      const tr = ct.insertRow();
      const targetStr = r.target + " yd";
      const clubsUsed = r.clubs.map(c => `${c.club} x${c.shots}`).join(", ");
      const best = typeof SwingGames !== "undefined" && SwingGames.clubSuggestion
        ? SwingGames.clubSuggestion(r.clubs)
        : null;
      tr.append(gmCell(targetStr), gmCell(clubsUsed), gmCell(best || "–"));
    }
    det.append(wrapTable(ct));
    elements.push(det);
  }

  box.replaceChildren(...elements);
}

function gmTargetText(target) {
  if (target === 0 || target === "fairway") return "fairway";
  if (target === "draw" || target === "fade") return target;
  if (target && typeof target === "object") {
    if (typeof SwingGames !== "undefined" && SwingGames.GAMES && SwingGames.GAMES.holes) {
      return SwingGames.GAMES.holes.sayTarget(target);
    }
    return target.shot === 1
      ? `hole ${target.hole}, ${target.yards} yards: the fairway`
      : `hole ${target.hole}: ${target.yards} yards to go`;
  }
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
  const msgEl = gmEl("gm-msg");
  if (msgEl) msgEl.textContent = "";
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}) });
    if (!res.ok) {
      if (msgEl) msgEl.textContent = (await res.json().catch(() => ({}))).detail || "Didn't work";
      return;
    }
  } catch {
    if (msgEl) msgEl.textContent = "Can't reach the server";
    return;
  }
  await loadGames();
  if (typeof loadPractice === "function") loadPractice();   // starting a game turns practice off
}

if (typeof document !== "undefined") {
  const gSel = gmEl("gm-game");
  if (gSel) gSel.addEventListener("change", renderGames);
  const hSelEl = gmEl("gm-history-game");
  if (hSelEl) hSelEl.addEventListener("change", renderGames);
  const startBtn = gmEl("gm-start");
  if (startBtn) startBtn.addEventListener("click", () => gmPost("/api/game", { game: gmEl("gm-game")?.value }));
  const stopBtn = gmEl("gm-stop");
  if (stopBtn) stopBtn.addEventListener("click", () => gmPost("/api/game/stop"));
}

const api = {
  runningScoreWords,
  formatTargetName,
  lastGameSummary,
  loadGames,
  renderGames,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.SwingGamesView = api;
