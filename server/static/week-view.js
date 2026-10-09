// server/static/week-view.js
// Week for coach view (Tools > Week for coach).
// Shows weekly summary cards: practice, ball flight, focus move, faults, what held up, games, notes.
// Uses SwingWeek (static/week.js), showView, closeTrendView, renderList.

(function () {
  const weekBox = document.getElementById("week");
  const weekClose = document.getElementById("week-close");
  const weekBtn = document.getElementById("week-btn");
  const weekTitle = document.getElementById("week-title");
  const weekPrevBtn = document.getElementById("week-prev-btn");
  const weekNextBtn = document.getElementById("week-next-btn");
  const weekCopyBtn = document.getElementById("week-copy-btn");
  const copyRunsWrap = document.getElementById("week-copy-runs-wrap");
  const copyRunsCb = document.getElementById("week-copy-runs-cb");
  const weekCopied = document.getElementById("week-copied");
  const weekCards = document.getElementById("week-cards");

  let currentWeekStart = null;
  let currentSummary = null;
  let cachedData = null;
  const runReports = {};

  let copyRunsPref = true;
  try {
    const saved = localStorage.getItem("week-copy-runs");
    if (saved !== null) copyRunsPref = saved === "1";
  } catch {}

  if (copyRunsCb) {
    copyRunsCb.checked = copyRunsPref;
    copyRunsCb.addEventListener("change", () => {
      copyRunsPref = copyRunsCb.checked;
      try { localStorage.setItem("week-copy-runs", copyRunsPref ? "1" : "0"); } catch {}
    });
  }

  async function loadData() {
    let swingsRaw = null;
    let journalRaw = null;
    let goodRaw = null;

    if (typeof loadTrendData === "function") {
      await loadTrendData();
    } else {
      const [sRes, jRes, gRes] = await Promise.all([
        fetch("/api/swings").then(r => r.ok ? r.json() : null).catch(() => null),
        fetch("/api/journal").then(r => r.ok ? r.json() : null).catch(() => null),
        fetch("/api/goodshots").then(r => r.ok ? r.json() : null).catch(() => null),
      ]);
      swingsRaw = sRes;
      journalRaw = jRes;
      goodRaw = gRes;
    }

    if (typeof clips === "undefined" || !clips || !clips.length) {
      try {
        const cRes = await fetch("/api/clips");
        if (cRes.ok) {
          const fetchedClips = await cRes.json();
          if (typeof clips !== "undefined") clips = fetchedClips;
          else window.clips = fetchedClips;
        }
      } catch {}
    }

    const [progData, gameData] = await Promise.all([
      fetch("/api/program").then(r => r.ok ? r.json() : null).catch(() => null),
      fetch("/api/game").then(r => r.ok ? r.json() : null).catch(() => null)
    ]);

    let sMap = (typeof swingRecords !== "undefined" && swingRecords) ? swingRecords : {};
    let nTable = (typeof noiseTable !== "undefined" && noiseTable) ? noiseTable : null;
    if (swingsRaw) {
      sMap = swingsRaw.swings || swingsRaw;
      if (swingsRaw.noise && !nTable) nTable = swingsRaw.noise;
    }

    cachedData = {
      clips: (typeof clips !== "undefined" && Array.isArray(clips)) ? clips : [],
      swings: sMap,
      journal: (typeof journal !== "undefined" && journal) ? journal : (journalRaw || {}),
      programLog: (progData && progData.log) || [],
      programs: (progData && progData.programs) || [],
      gameLog: (gameData && gameData.log) || [],
      goodSettings: (typeof goodSettings !== "undefined" && goodSettings) ? goodSettings : goodRaw,
      noiseTable: nTable
    };

    return cachedData;
  }

  function getWeekRuns() {
    if (!currentWeekStart) return [];
    const from = currentWeekStart.getTime(), to = from + 7 * 86400000;
    return ((cachedData && cachedData.programLog) || [])
      .filter(r => r.started * 1000 >= from && r.started * 1000 < to)
      .sort((a, b) => b.started - a.started);
  }

  function renderView(date) {
    if (!window.SwingWeek) return;
    if (date) {
      currentWeekStart = SwingWeek.weekStartOf(date);
    } else if (!currentWeekStart) {
      currentWeekStart = SwingWeek.weekStartOf(new Date());
    }

    currentSummary = SwingWeek.weekSummary(cachedData || {}, currentWeekStart);

    if (weekTitle) {
      weekTitle.textContent = currentSummary.title;
    }

    const runs = getWeekRuns();
    if (copyRunsWrap) {
      copyRunsWrap.hidden = runs.length === 0;
    }
    if (copyRunsCb) {
      copyRunsCb.checked = copyRunsPref;
    }

    if (weekCards) {
      weekCards.replaceChildren();
      if (!currentSummary.sections || currentSummary.sections.length === 0) {
        const emptyCard = document.createElement("div");
        emptyCard.className = "t-card note";
        emptyCard.style.padding = "16px";
        emptyCard.textContent = "No practice recorded for this week.";
        weekCards.append(emptyCard);
      } else {
        for (const sec of currentSummary.sections) {
          const card = document.createElement("div");
          card.className = "t-card week-card";

          const h = document.createElement("div");
          h.className = "week-card-title";
          h.textContent = sec.title;
          card.append(h);

          const ul = document.createElement("ul");
          ul.className = "week-card-lines";
          for (const line of sec.lines) {
            const li = document.createElement("li");
            li.textContent = line;
            ul.append(li);
          }
          card.append(ul);
          weekCards.append(card);
        }
      }
      renderRuns();
      renderCoachReview();
    }
  }

  function getWeekKey(d) {
    const dt = window.SwingWeek ? window.SwingWeek.weekStartOf(d) : new Date(d);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const day = String(dt.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  async function getFullWeekText() {
    if (!currentSummary || !currentSummary.text) return "";
    const runs = getWeekRuns();
    const shouldIncludeRuns = copyRunsCb && copyRunsWrap && !copyRunsWrap.hidden && copyRunsCb.checked && runs.length > 0;
    let fullText = currentSummary.text;

    if (shouldIncludeRuns) {
      const runsWithReports = await Promise.all(runs.map(async (r) => {
        let text = runReports[r.started];
        if (text == null) {
          try {
            const res = await fetch(`/api/program/report?started=${encodeURIComponent(r.started)}`);
            text = res.ok ? ((await res.json()) || {}).text || "" : "";
          } catch { text = ""; }
          runReports[r.started] = text;
        }
        return { name: r.name, started: r.started, day: r.day, date: r.date, text };
      }));
      if (window.SwingWeek && window.SwingWeek.joinWeekAndRuns) {
        fullText = window.SwingWeek.joinWeekAndRuns(currentSummary.text, runsWithReports);
      }
    }
    return fullText;
  }

  async function renderCoachReview() {
    if (!weekCards) return;
    const weekKey = getWeekKey(currentWeekStart);
    const card = document.createElement("div");
    card.className = "t-card week-card";
    card.id = "week-coach-review";
    weekCards.append(card);

    let note = null;
    try {
      const res = await fetch(`/api/coach/notes?session=${encodeURIComponent(weekKey)}&kind=week`);
      note = res.ok ? await res.json() : null;
    } catch {}

    if (getWeekKey(currentWeekStart) !== weekKey) return;
    drawCoachReview(card, weekKey, note);
  }

  function drawCoachReview(card, weekKey, note) {
    card.replaceChildren();
    if (note && note.text) {
      const fold = document.createElement("details");
      const sum = document.createElement("summary");
      sum.style.cursor = "pointer";
      sum.style.fontWeight = "600";
      sum.style.color = "var(--accent)";
      sum.textContent = "Coach's review of the week";
      fold.append(sum);

      const body = document.createElement("div");
      body.style.cssText = "margin-top: 10px; line-height: 1.5; font-size: 14px; white-space: pre-wrap;";
      if (window.SwingAICoach && window.SwingAICoach.renderTake) {
        SwingAICoach.renderTake(body, note.text);
      } else {
        body.textContent = note.text;
      }
      fold.append(body);

      const foot = document.createElement("div");
      foot.style.cssText = "margin-top: 12px; display: flex; align-items: center; gap: 8px;";
      const againBtn = document.createElement("button");
      againBtn.className = "small";
      againBtn.type = "button";
      againBtn.textContent = "Ask again";
      againBtn.onclick = async () => {
        againBtn.disabled = true;
        againBtn.textContent = "Asking…";
        try {
          const brief = await getFullWeekText();
          const res = await fetch("/api/coach/ask", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: "week", session: weekKey, brief, again: true }),
          }).then(r => r.ok ? r.json() : null);
          if (res && res.text) {
            drawCoachReview(card, weekKey, res);
          } else {
            alert((res && res.error) || "Could not get weekly review");
            againBtn.disabled = false;
            againBtn.textContent = "Ask again";
          }
        } catch (e) {
          alert("Error: " + e.message);
          againBtn.disabled = false;
          againBtn.textContent = "Ask again";
        }
      };
      foot.append(againBtn);
      fold.append(foot);
      card.append(fold);
    } else {
      const h = document.createElement("div");
      h.className = "week-card-title";
      h.textContent = "Coach's review of the week";

      const desc = document.createElement("div");
      desc.className = "muted";
      desc.style.fontSize = "13px";
      desc.textContent = "Have the AI coach read this week's text and give a review in at most 200 words.";

      const askBtn = document.createElement("button");
      askBtn.className = "small";
      askBtn.type = "button";
      askBtn.style.marginTop = "6px";
      askBtn.style.alignSelf = "flex-start";
      askBtn.textContent = "Ask the coach";
      askBtn.onclick = async () => {
        askBtn.disabled = true;
        askBtn.textContent = "Asking…";
        try {
          const brief = await getFullWeekText();
          const res = await fetch("/api/coach/ask", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: "week", session: weekKey, brief, again: false }),
          }).then(r => r.ok ? r.json() : null);
          if (res && res.text) {
            drawCoachReview(card, weekKey, res);
          } else {
            alert((res && res.error) || "Could not get weekly review");
            askBtn.disabled = false;
            askBtn.textContent = "Ask the coach";
          }
        } catch (e) {
          alert("Error: " + e.message);
          askBtn.disabled = false;
          askBtn.textContent = "Ask the coach";
        }
      };
      card.append(h, desc, askBtn);
    }
  }

  // The week's coach program runs, each with its full report (programs.py report) to read and copy:
  // the owner hits at the sim and reads at home, so the report lives here too, not only on the Start page.
  function renderRuns() {
    const runs = getWeekRuns();
    if (!runs.length) return;
    const card = document.createElement("div");
    card.className = "t-card week-card";
    const h = document.createElement("div");
    h.className = "week-card-title";
    h.textContent = runs.length === 1 ? "Coach program run" : `Coach program runs (${runs.length})`;
    card.append(h);
    for (const run of runs) {
      const when = new Date(run.started * 1000).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      const fold = document.createElement("details");
      const sum = document.createElement("summary");
      const passed = Object.values(run.results || {}).filter(v => v === "passed").length;
      sum.textContent = `${run.name}, ${when}: ${passed} of ${Object.keys(run.results || {}).length} gates passed`;
      const pre = document.createElement("pre");
      pre.className = "week-run-report";
      pre.textContent = "Loading…";
      const copy = document.createElement("button");
      copy.className = "small";
      copy.type = "button";
      copy.textContent = "Copy this run for coach";
      const load = async () => {
        if (runReports[run.started] != null) return runReports[run.started];
        let text = "";
        try {
          const r = await fetch(`/api/program/report?started=${encodeURIComponent(run.started)}`);
          text = r.ok ? ((await r.json()) || {}).text || "" : "";
        } catch { text = ""; }
        runReports[run.started] = text;
        pre.textContent = text || "No report for this run.";
        return text;
      };
      fold.addEventListener("toggle", () => { if (fold.open) load(); });
      copy.onclick = async () => { const t = await load(); if (t) copyText(t, copy); };
      fold.append(sum, copy, pre);
      card.append(fold);
    }
    weekCards.append(card);
  }

  async function openWeekView() {
    if (typeof showView === "function") showView("week");
    if (typeof renderList === "function") renderList();
    if (weekBox) {
      weekBox.scrollTop = 0;
      if (window.innerWidth < 900) weekBox.scrollIntoView();
    }
    if (!currentWeekStart && window.SwingWeek) {
      currentWeekStart = SwingWeek.weekStartOf(new Date());
    }
    await loadData();
    renderView();
  }

  async function copyForCoach() {
    if (!currentSummary || !currentSummary.text) return;
    const orig = weekCopyBtn ? weekCopyBtn.textContent : "";
    if (weekCopyBtn) weekCopyBtn.textContent = "Copying…";
    try {
      const fullText = await getFullWeekText();
      copyText(fullText, weekCopyBtn);
    } finally {
      if (weekCopyBtn) weekCopyBtn.textContent = orig;
    }
  }

  function copyText(text, btn) {
    const onSuccess = () => {
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(() => { btn.textContent = orig; }, 2000);
      }
      if (weekCopied) {
        weekCopied.textContent = "Copied to clipboard: paste into coach chat.";
        weekCopied.hidden = false;
        setTimeout(() => { weekCopied.hidden = true; }, 3000);
      }
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(onSuccess).catch(() => fallbackCopy(text, onSuccess));
    } else {
      fallbackCopy(text, onSuccess);
    }
  }

  function fallbackCopy(text, cb) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand("copy");
      if (cb) cb();
    } catch {}
    ta.remove();
  }

  if (weekBtn) {
    weekBtn.onclick = () => {
      if (weekBox && weekBox.hidden) openWeekView();
      else if (typeof closeTrendView === "function") closeTrendView();
    };
  }

  if (weekClose) {
    weekClose.onclick = () => {
      if (typeof closeTrendView === "function") closeTrendView();
    };
  }

  if (weekPrevBtn) {
    weekPrevBtn.onclick = () => {
      if (window.SwingWeek && currentWeekStart) {
        currentWeekStart = SwingWeek.prevWeekStart(currentWeekStart);
        renderView();
      }
    };
  }

  if (weekNextBtn) {
    weekNextBtn.onclick = () => {
      if (window.SwingWeek && currentWeekStart) {
        currentWeekStart = SwingWeek.nextWeekStart(currentWeekStart);
        renderView();
      }
    };
  }

  if (weekCopyBtn) {
    weekCopyBtn.onclick = copyForCoach;
  }

  window.openWeekView = openWeekView;
  window.loadWeekData = loadData;
  window.renderWeekView = renderView;
})();
