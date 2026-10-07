// Night report view (Tools > Night report)
// Shows model candidate scores, worker progress, and past nights.
// Uses SwingNightReport (static/nightreport.js), showView, closeTrendView, renderList.

(function () {
  const nrBox = document.getElementById("nightreport");
  const nrClose = document.getElementById("nr-close");
  const nrBtn = document.getElementById("nightreport-btn");
  const nrStatus = document.getElementById("nr-status");
  const nrContent = document.getElementById("nr-content");

  let reportData = null;
  let nightProgressData = null;
  let isSampleMode = false;

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  /** "6:58 am" from an ISO time or the server's seconds since 1970 (/api/night seen.at). */
  function formatAskTime(iso) {
    if (!iso) return "";
    const d = new Date(typeof iso === "number" ? iso * 1000 : iso);
    if (isNaN(d.getTime())) return "";
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, "0");
    const ampm = h >= 12 ? "pm" : "am";
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${m} ${ampm}`;
  }

  function renderScoresTable(scores) {
    const rows = window.SwingNightReport ? SwingNightReport.compareRows(scores) : [];
    if (!rows || rows.length === 0) {
      return '<div class="note">No comparison scores recorded for this candidate.</div>';
    }

    let html = `
      <div style="overflow-x: auto;">
        <table class="nr-table">
          <thead>
            <tr>
              <th></th>
              <th>Before</th>
              <th>After</th>
              <th>Change</th>
            </tr>
          </thead>
          <tbody>
    `;

    for (const r of rows) {
      if (r.kind === "positions") {
        const wChg = r.within1.change;
        const wChgClass = wChg > 5 ? "nr-better" : wChg < -5 ? "nr-worse" : "nr-muted";
        const wChgStr = wChg != null ? `${wChg > 0 ? "+" : ""}${wChg.toFixed(1)}%` : "-";
        const wBefStr = r.within1.before != null ? `${r.within1.before.toFixed(1)}%` : "-";
        const wAftStr = r.within1.after != null ? `${r.within1.after.toFixed(1)}%` : "-";

        const pChg = r.p90.change;
        const pChgClass = pChg < -4.2 ? "nr-better" : pChg > 4.2 ? "nr-worse" : "nr-muted";
        const pChgStr = pChg != null ? `${pChg > 0 ? "+" : ""}${pChg.toFixed(1)} ms` : "-";
        const pBefStr = r.p90.before != null ? `${r.p90.before.toFixed(1)} ms` : "-";
        const pAftStr = r.p90.after != null ? `${r.p90.after.toFixed(1)} ms` : "-";

        html += `
          <tr class="nr-group"><td colspan="4" class="nr-item-label">${escapeHtml(r.label)}</td></tr>
          <tr>
            <td class="nr-metric-name">within 1 frame</td>
            <td>${wBefStr}</td>
            <td>${wAftStr}</td>
            <td class="${wChgClass}">${wChgStr}</td>
          </tr>
          <tr>
            <td class="nr-metric-name">90th pct</td>
            <td>${pBefStr}</td>
            <td>${pAftStr}</td>
            <td class="${pChgClass}">${pChgStr}</td>
          </tr>
        `;
      } else {
        const fChg = r.found.change;
        const fChgClass = fChg > 5 ? "nr-better" : fChg < -5 ? "nr-worse" : "nr-muted";
        const fChgStr = fChg != null ? `${fChg > 0 ? "+" : ""}${fChg.toFixed(1)}%` : "-";
        const fBefStr = r.found.before != null ? `${r.found.before.toFixed(1)}%` : "-";
        const fAftStr = r.found.after != null ? `${r.found.after.toFixed(1)}%` : "-";

        const unit = r.kind === "club" ? "°" : "%";
        const pChg = r.p90.change;
        const pChgClass = pChg < -4.2 ? "nr-better" : pChg > 4.2 ? "nr-worse" : "nr-muted";
        const pChgStr = pChg != null ? `${pChg > 0 ? "+" : ""}${pChg.toFixed(1)} ${unit}` : "-";
        const pBefStr = r.p90.before != null ? `${r.p90.before.toFixed(1)} ${unit}` : "-";
        const pAftStr = r.p90.after != null ? `${r.p90.after.toFixed(1)} ${unit}` : "-";

        html += `
          <tr class="nr-group"><td colspan="4" class="nr-item-label">${escapeHtml(r.label)}</td></tr>
          <tr>
            <td class="nr-metric-name">% found</td>
            <td>${fBefStr}</td>
            <td>${fAftStr}</td>
            <td class="${fChgClass}">${fChgStr}</td>
          </tr>
          <tr>
            <td class="nr-metric-name">90th pct</td>
            <td>${pBefStr}</td>
            <td>${pAftStr}</td>
            <td class="${pChgClass}">${pChgStr}</td>
          </tr>
        `;
      }
    }

    html += `
          </tbody>
        </table>
      </div>
    `;
    return html;
  }

  function renderTrainDetails(train) {
    if (!train) return "";
    const sigPart = train.labelsSig ? ` · sig ${escapeHtml(train.labelsSig)}` : "";
    return `
      <details class="nr-train">
        <summary>Training details</summary>
        <div class="note" style="margin-top: 6px;">
          Trained on ${train.swings} labeled swings (${(train.frames || 0).toLocaleString()} frames), evaluated on ${train.valSwings} validation swings · ${train.epochs} epochs · ${train.minutes} min${sigPart}
        </div>
      </details>
    `;
  }

  function buildWorkerProgress() {
    if (!nightProgressData) return "";
    const done = nightProgressData.done;
    const total = nightProgressData.clips;
    const seen = nightProgressData.seen;
    const parts = [];
    if (done != null && total != null) {
      parts.push(`${done} of ${total} clips analyzed by the night worker`);
    }
    if (seen && seen.at) {
      const askStr = formatAskTime(seen.at);
      if (askStr) parts.push(`last asked ${askStr}`);
    }
    if (parts.length === 0) return "";
    return `<div class="note nr-worker-progress">${escapeHtml(parts.join(" · "))}</div>`;
  }

  function render404View() {
    let html = `
      <div class="t-card">
        <div class="nr-headline"><strong>No night report yet: the night worker hasn't run the improve step.</strong></div>
        ${buildWorkerProgress()}
      </div>
      <div class="note nr-bottom-note">
        Scored on the labeled swings the model didn't train on (usually 8-10). Few swings: a difference of a frame or two can be chance. Labeling the swings on the Labels page's <button class="link-btn" id="nr-to-labels">"Where the two analyses disagree"</button> list gives the next night more to learn from.
      </div>
    `;
    nrContent.innerHTML = html;
    wireBottomLabelsLink();
  }

  function renderNightReportView() {
    if (!reportData) return;

    const headlineText = window.SwingNightReport ? SwingNightReport.headline(reportData) : "";
    const progressHtml = buildWorkerProgress();

    // 1. Headline card
    let html = `
      <div class="t-card">
        <div class="nr-headline">${escapeHtml(headlineText)}</div>
        ${progressHtml}
      </div>
    `;

    // 2. The newest candidate
    const candidates = reportData.candidates || [];
    const newest = candidates[0] || null;

    if (newest) {
      const statusClass = `nr-tag-${(newest.status || "").replace(/\s+/g, "-")}`;
      const verdictHtml = newest.verdict && newest.verdict.why
        ? `<div class="note nr-verdict">${escapeHtml(newest.verdict.why)}</div>`
        : "";
      const tableHtml = renderScoresTable(newest.scores);
      const trainHtml = renderTrainDetails(newest.train);

      let actionBtnHtml = "";
      if (newest.status === "better") {
        actionBtnHtml = `<div class="nr-action-row"><button class="primary nr-use-btn" data-id="${escapeHtml(newest.id)}">Use it</button></div>`;
      } else if (newest.status === "used before") {
        actionBtnHtml = `<div class="nr-action-row"><button class="small nr-use-btn" data-id="${escapeHtml(newest.id)}">Go back to this one</button></div>`;
      }

      const progressLineText = window.SwingNightReport ? SwingNightReport.progressLine(reportData.progress) : "";
      const almostSameText = window.SwingNightReport ? SwingNightReport.almostSameNote(candidates) : null;
      let progressSectionHtml = "";
      if (progressLineText) {
        progressSectionHtml += `<div class="note nr-progress-line" style="margin-top: 8px;">${escapeHtml(progressLineText)}</div>`;
      }
      if (almostSameText) {
        progressSectionHtml += `<div class="note nr-almost-same" style="margin-top: 4px;">${escapeHtml(almostSameText)}</div>`;
      }

      html += `
        <div class="t-card nr-candidate-card">
          <div class="nr-card-header">
            <strong>Model candidate: ${escapeHtml(newest.model || newest.id)}</strong>
            <span class="nr-tag ${statusClass}">${escapeHtml(newest.status)}</span>
          </div>
          <p class="nr-summary">${escapeHtml(newest.summary || "")}</p>
          ${verdictHtml}
          ${tableHtml}
          ${trainHtml}
          ${actionBtnHtml}
          ${progressSectionHtml}
        </div>
      `;
    } else if (reportData.progress) {
      const line = window.SwingNightReport ? SwingNightReport.progressLine(reportData.progress) : "";
      if (line) {
        html += `
          <div class="t-card">
            <div class="note nr-progress-line">${escapeHtml(line)}</div>
          </div>
        `;
      }
    }

    // 3. Earlier candidates, folded
    const earlier = candidates.slice(1);
    if (earlier.length > 0) {
      let earlierItems = "";
      for (const c of earlier) {
        const cStatusClass = `nr-tag-${(c.status || "").replace(/\s+/g, "-")}`;
        const cDate = window.SwingNightReport ? SwingNightReport.formatNightDate(c.made, false) : (c.made || "");
        const cVerdict = c.verdict && c.verdict.why ? `<div class="note nr-verdict">${escapeHtml(c.verdict.why)}</div>` : "";
        const cTable = renderScoresTable(c.scores);
        const cTrain = renderTrainDetails(c.train);
        const cAction = c.status === "used before"
          ? `<div class="nr-action-row"><button class="small nr-use-btn" data-id="${escapeHtml(c.id)}">Go back to this one</button></div>`
          : "";

        earlierItems += `
          <details class="nr-earlier-item">
            <summary class="nr-earlier-summary">
              <span class="nr-earlier-date">${escapeHtml(cDate)}</span>
              <span class="nr-tag ${cStatusClass}">${escapeHtml(c.status)}</span>
              <span class="nr-earlier-text">${escapeHtml(c.summary || "")}</span>
            </summary>
            <div class="nr-earlier-body">
              ${cVerdict}
              ${cTable}
              ${cTrain}
              ${cAction}
            </div>
          </details>
        `;
      }

      html += `
        <details class="t-card nr-fold-card">
          <summary><strong>Earlier candidates</strong> (${earlier.length})</summary>
          <div class="nr-earlier-list">
            ${earlierItems}
          </div>
        </details>
      `;
    }

    // 4. Nights, folded
    const nights = reportData.nights || [];
    if (nights.length > 0) {
      let nightLines = "";
      for (const n of nights) {
        const line = window.SwingNightReport ? SwingNightReport.nightLine(n) : "";
        nightLines += `<div class="nr-night-row">${escapeHtml(line)}</div>`;
      }

      html += `
        <details class="t-card nr-fold-card">
          <summary><strong>Past nights</strong> (${nights.length})</summary>
          <div class="nr-nights-list">
            ${nightLines}
          </div>
        </details>
      `;
    }

    // 5. Honest note at bottom with link to Labels view
    html += `
      <div class="note nr-bottom-note">
        Scored on the labeled swings the model didn't train on (usually 8-10). Few swings: a difference of a frame or two can be chance. Labeling the swings on the Labels page's <button class="link-btn" id="nr-to-labels">"Where the two analyses disagree"</button> list gives the next night more to learn from.
      </div>
    `;

    nrContent.innerHTML = html;
    wireUseButtons();
    wireBottomLabelsLink();
  }

  function wireBottomLabelsLink() {
    const toLabelsBtn = document.getElementById("nr-to-labels");
    if (toLabelsBtn) {
      toLabelsBtn.onclick = () => {
        if (typeof openLabelView === "function") {
          openLabelView();
        } else {
          const lBtn = document.getElementById("labels-btn");
          if (lBtn) lBtn.click();
        }
      };
    }
  }

  function wireUseButtons() {
    const btns = nrContent.querySelectorAll(".nr-use-btn");
    btns.forEach(btn => {
      btn.onclick = async () => {
        const id = btn.dataset.id;
        if (!id) return;
        const totalClips = (nightProgressData && nightProgressData.clips) || (window.clips && window.clips.length) || 0;
        const msg = `Use this club model? The server analyzes every clip again with it over the next idle hours (about ${totalClips} clips).`;
        if (!window.confirm(msg)) return;

        btn.disabled = true;
        await useCandidate(id);
      };
    });
  }

  async function useCandidate(id) {
    // The sample's candidates don't exist on the server: never send it a tap from sample mode.
    if (isSampleMode) { simulateUseInSample(id); return; }
    if (nrStatus) nrStatus.textContent = "Switching model…";
    try {
      const res = await fetch(`/api/improve/${encodeURIComponent(id)}/use`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      if (res.ok) {
        const data = await res.json();
        if (reportData) {
          if (data.inUse) reportData.inUse = data.inUse;
          if (data.deepLeft != null) reportData.deepLeft = data.deepLeft;
        }
        if (nrStatus) nrStatus.textContent = "";
        await loadNightReport();
      } else {
        const why = (await res.json().catch(() => ({}))).detail || res.statusText;
        if (nrStatus) nrStatus.textContent = `Not switched: ${why}`;
      }
    } catch (err) {
      if (nrStatus) nrStatus.textContent = `Not switched: the server didn't answer (${err.message})`;
    }
  }

  function simulateUseInSample(id) {
    if (!reportData) return;
    const cand = (reportData.candidates || []).find(c => c.id === id);
    const prevModel = reportData.inUse?.club;
    const totalClips = (nightProgressData && nightProgressData.clips) || (window.clips && window.clips.length) || 824;

    reportData.inUse = { club: cand?.model || id, since: new Date().toISOString() };
    reportData.deepLeft = totalClips;
    if (cand) cand.status = "in use";

    if (prevModel && reportData.candidates) {
      const prevCand = reportData.candidates.find(c => c.model === prevModel);
      if (prevCand) prevCand.status = "used before";
    }

    if (nrStatus) nrStatus.textContent = "";
    renderNightReportView();
  }

  async function loadNightReport() {
    if (nrStatus) nrStatus.textContent = "Loading…";

    const params = new URLSearchParams(window.location.search);
    isSampleMode = params.get("improve") === "sample";

    try {
      const nightPromise = fetch("/api/night", { cache: "no-store" })
        .then(r => r.ok ? r.json() : null)
        .catch(() => null);

      const improveUrl = isSampleMode ? "/static/improve-sample.json" : "/api/improve";
      const improvePromise = fetch(improveUrl, { cache: "no-store" });

      const [nightRes, improveRes] = await Promise.all([nightPromise, improvePromise]);
      nightProgressData = nightRes;

      if (improveRes.status === 404) {
        if (nrStatus) nrStatus.textContent = "";
        render404View();
        return;
      }

      if (!improveRes.ok) {
        if (nrStatus) nrStatus.textContent = "Failed to load report";
        nrContent.innerHTML = `<div class="t-card note">Error loading night report (${improveRes.status}).</div>`;
        return;
      }

      reportData = await improveRes.json();
      if (!reportData.progress) {
        try {
          const nextRes = await fetch("/api/improve/next", { cache: "no-store" });
          if (nextRes.ok) {
            const nextData = await nextRes.json();
            let newFrames = nextData.newFrames;
            let need = nextData.need;
            if (newFrames == null && typeof nextData.why === "string") {
              const m = /(\d+)\s+new club-labeled frames/.exec(nextData.why);
              if (m) newFrames = Number(m[1]);
              const mn = /\(needs\s+(\d+)\)/.exec(nextData.why);
              if (mn) need = Number(mn[1]);
            }
            if (newFrames != null || need != null) {
              reportData.progress = { newFrames: newFrames != null ? newFrames : null, need: need != null ? need : 40 };
            }
          }
        } catch (_) {}
      }
      if (nrStatus) nrStatus.textContent = "";
      renderNightReportView();
    } catch (e) {
      if (nrStatus) nrStatus.textContent = "";
      render404View();
    }
  }

  function openNightReport() {
    if (typeof showView === "function") showView("nightreport");
    if (typeof renderList === "function") renderList();
    if (nrBox) {
      nrBox.scrollTop = 0;
      if (window.innerWidth < 900) nrBox.scrollIntoView();
    }
    loadNightReport();
  }

  if (nrBtn) {
    nrBtn.onclick = () => {
      if (nrBox && nrBox.hidden) openNightReport();
      else if (typeof closeTrendView === "function") closeTrendView();
    };
  }

  if (nrClose) {
    nrClose.onclick = () => {
      if (typeof closeTrendView === "function") closeTrendView();
    };
  }

  window.openNightReport = openNightReport;
  window.loadNightReport = loadNightReport;
})();
