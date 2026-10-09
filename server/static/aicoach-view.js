// AI coach view (Tools > AI coach)
(function () {
  const coachBox = document.getElementById("aicoach");
  const coachClose = document.getElementById("aicoach-close");
  const coachBtn = document.getElementById("aicoach-btn");
  const statusBadge = document.getElementById("aicoach-status-badge");
  const statusText = document.getElementById("aicoach-status-text");
  const howToAddEl = document.getElementById("aicoach-how-to-add");
  const briefEl = document.getElementById("aicoach-brief-text");
  const copyBtn = document.getElementById("aicoach-copy-brief");
  const copiedMsg = document.getElementById("aicoach-copied");
  const notesList = document.getElementById("aicoach-notes-list");

  if (!coachBox) return;

  if (coachBtn) {
    coachBtn.onclick = () => {
      if (typeof showView === "function") showView("aicoach");
      loadData();
    };
  }

  if (coachClose) {
    coachClose.onclick = () => {
      if (typeof closeTrendView === "function") closeTrendView();
      else coachBox.hidden = true;
    };
  }

  if (copyBtn) {
    copyBtn.onclick = async () => {
      if (!briefEl || !briefEl.textContent) return;
      try {
        await navigator.clipboard.writeText(briefEl.textContent);
        if (copiedMsg) {
          copiedMsg.hidden = false;
          setTimeout(() => { copiedMsg.hidden = true; }, 2000);
        }
      } catch (e) {
        console.warn("Failed to copy brief:", e);
      }
    };
  }

  const $id = id => document.getElementById(id);
  let st = null;

  /** The setup card from /api/coach/status: providers (with whether each has a key), the model in use. */
  async function renderSetup() {
    try { st = await fetch("/api/coach/status").then(r => r.ok ? r.json() : null); } catch { st = null; }
    if (!st) return;
    const sel = $id("aicoach-provider");
    sel.replaceChildren(...st.providers.map(p => Object.assign(document.createElement("option"),
      { value: p.id, textContent: p.name + (p.hasKey ? " (key saved)" : "") })));
    sel.value = st.provider;
    const showProvider = () => {
      const p = st.providers.find(x => x.id === sel.value) || {};
      $id("aicoach-baseurl-row").hidden = sel.value !== "other";
      $id("aicoach-baseurl").value = st.baseUrl || "";
      $id("aicoach-key").value = "";
      $id("aicoach-key-note").textContent = p.hasKey
        ? "A key is saved for this provider: leave the box empty to keep it, or paste a new one."
        : `No key yet: make one at ${p.keys}, then paste it here.`;
    };
    sel.onchange = () => { showProvider(); fillModels(sel.value, null); };
    showProvider();
    if (statusBadge) {
      statusBadge.textContent = st.ready ? "Ready" : "Not set up";
      statusBadge.style.color = st.ready ? "var(--accent)" : "var(--muted)";
    }
    if (statusText) {
      const name = (st.providers.find(x => x.id === st.provider) || {}).name || st.provider;
      statusText.textContent = st.ready
        ? `Using ${name}, model ${st.model}. Calls today: ${st.callsToday} of ${st.cap}.`
        : `Not set up yet: pick a provider, paste its API key and pick a model. Calls today: ${st.callsToday} of ${st.cap}.`;
    }
    $id("aicoach-save").onclick = save;
    $id("aicoach-model").onchange = async () => {
      await post({ provider: sel.value, model: $id("aicoach-model").value });
      await renderSetup();
    };
    fillModels(st.provider, st.model);
  }

  /** The provider's models, from its own list (needs its key); the one in use selected. */
  async function fillModels(provider, current) {
    const ms = $id("aicoach-model"), note = $id("aicoach-model-note");
    ms.replaceChildren(Object.assign(document.createElement("option"), { value: "", textContent: "Loading the provider's models…" }));
    let got = null;
    try { got = await fetch("/api/coach/models?provider=" + encodeURIComponent(provider)).then(r => r.json()); } catch {}
    const models = (got && got.models) || [];
    if (current && !models.includes(current)) models.unshift(current);
    ms.replaceChildren(Object.assign(document.createElement("option"), { value: "", textContent: models.length ? "Pick a model" : "No models yet" }),
      ...models.map(m => Object.assign(document.createElement("option"), { value: m, textContent: m })));
    ms.value = current || "";
    note.textContent = got && got.error ? got.error
      : "Newest models are usually the best: the coach needs good judgment more than speed.";
  }

  async function post(body) {
    const res = await fetch("/api/coach/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.status);
    return res.json();
  }

  async function save() {
    const provider = $id("aicoach-provider").value, key = $id("aicoach-key").value.trim();
    const body = { provider };
    if (key) body.key = key;
    if (provider === "other") body.baseUrl = $id("aicoach-baseurl").value.trim();
    try { await post(body); } catch (e) { $id("aicoach-key-note").textContent = `Couldn't save: ${e.message}`; return; }
    await renderSetup();
  }

  async function loadData() {
    if (typeof loadTrendData === "function") {
      await loadTrendData();
    }
    // 1. Which AI: provider, key (write-only), model from the provider's own list.
    await renderSetup();

    // 2. Latest session brief
    try {
      let latestBrief = "";
      if (typeof SwingAICoach !== "undefined") {
        let all = [];
        if (typeof progressSessions === "function") {
          all = progressSessions("*");
        }
        if (all.length > 0) {
          const latest = all[all.length - 1];
          const earlier = all.slice(0, -1);
          let cmp = null;
          const data = typeof goodShotData === "function" ? goodShotData() : { clubs: {} };
          if (typeof SwingSessionScore !== "undefined") {
            cmp = SwingSessionScore.compare(all.map(s => ({ start: s.start, key: s.key, rows: s.rows })), {
              clubs: data.clubs,
              settings: typeof goodSettings !== "undefined" ? goodSettings.settings : null,
              name: r => (r.c ? r.c.name : r.name),
            });
          }
          let story = null;
          if (typeof SwingSessionStory !== "undefined") {
            story = SwingSessionStory.story(latest, earlier, {
              clubs: data.clubs,
              settings: typeof goodSettings !== "undefined" ? goodSettings.settings : null,
              name: r => (r.c ? r.c.name : r.name),
            });
          }
          const progReport = typeof coachProgramReport === "function" ? await coachProgramReport(latest.start) : null;

          latestBrief = SwingAICoach.brief({
            session: latest,
            earlier: earlier,
            story: story,
            compare: cmp,
            ...(typeof coachFocusInput === "function" ? coachFocusInput() : {}),
            programReport: progReport,
          });
        }
      }
      if (briefEl) {
        briefEl.textContent = latestBrief || "No session data available yet.";
      }
    } catch (e) {
      if (briefEl) briefEl.textContent = "Error building session brief.";
    }

    // 3. Kept notes
    try {
      const notes = await fetch("/api/coach/notes").then(r => r.ok ? r.json() : []);
      if (notesList) {
        notesList.replaceChildren();
        if (Array.isArray(notes) && notes.length > 0) {
          for (const n of notes) {
            const card = document.createElement("div");
            card.style.cssText = "background: var(--bg-card, #222); padding: 12px; border-radius: 6px; border: 1px solid var(--border, #333);";

            const head = document.createElement("div");
            head.style.cssText = "display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 13px;";
            const dateStr = n.t ? new Date(n.t * 1000).toLocaleString() : (n.session || "");
            const dateSpan = document.createElement("strong");
            dateSpan.textContent = dateStr;
            const metaSpan = document.createElement("span");
            metaSpan.className = "muted";
            const tokens = n.usage && n.usage.input_tokens ? ` (${n.usage.input_tokens} in / ${n.usage.output_tokens} out tokens)` : "";
            metaSpan.textContent = `${n.model || ""}${tokens}`;
            head.append(dateSpan, metaSpan);

            const body = document.createElement("div");
            body.style.cssText = "white-space: pre-wrap; line-height: 1.5; font-size: 14px;";
            body.textContent = n.text || "";

            card.append(head, body);
            notesList.append(card);
          }
        } else {
          const empty = document.createElement("div");
          empty.className = "muted";
          empty.textContent = "No kept notes yet. The coach reads your session after it ends when an API key is configured.";
          notesList.append(empty);
        }
      }
    } catch (e) {
      if (notesList) {
        notesList.innerHTML = '<div class="muted">Could not load kept notes.</div>';
      }
    }
  }

  window.SwingAICoachView = { load: loadData };
})();
