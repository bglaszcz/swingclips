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
  const weekCopied = document.getElementById("week-copied");
  const weekCards = document.getElementById("week-cards");

  let currentWeekStart = null;
  let currentSummary = null;
  let cachedData = null;

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

  function renderView() {
    if (!window.SwingWeek) return;
    if (!currentWeekStart) {
      currentWeekStart = SwingWeek.weekStartOf(new Date());
    }

    currentSummary = SwingWeek.weekSummary(cachedData || {}, currentWeekStart);

    if (weekTitle) {
      weekTitle.textContent = currentSummary.title;
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
    }
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

  function copyForCoach() {
    if (!currentSummary || !currentSummary.text) return;
    const text = currentSummary.text;
    const onSuccess = () => {
      if (weekCopyBtn) {
        const orig = weekCopyBtn.textContent;
        weekCopyBtn.textContent = "Copied";
        setTimeout(() => { weekCopyBtn.textContent = orig; }, 2000);
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
