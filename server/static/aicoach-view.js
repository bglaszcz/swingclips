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

  async function loadData() {
    if (typeof loadTrendData === "function") {
      await loadTrendData();
    }
    // 1. Status
    try {
      const st = await fetch("/api/coach/status").then(r => r.ok ? r.json() : null);
      const ready = st ? st.ready : false;
      const callsToday = st ? st.callsToday : 0;
      const cap = st ? st.cap : 10;
      const howToAdd = st ? st.howToAdd : "Make an API key at console.anthropic.com, paste it into anthropic-key.txt next to shots.jsonl (or set ANTHROPIC_API_KEY), then Tools > Update the server.";

      if (statusBadge) {
        statusBadge.textContent = ready ? "Key configured" : "No key";
        statusBadge.style.color = ready ? "var(--good, #4caf50)" : "var(--muted, #888)";
      }
      if (statusText) {
        statusText.textContent = ready
          ? `API key configured. Calls today: ${callsToday} of ${cap} daily cap.`
          : `No API key found. Calls today: ${callsToday} of ${cap} daily cap.`;
      }
      if (howToAddEl) {
        howToAddEl.textContent = howToAdd;
      }
    } catch (e) {
      console.warn("Error fetching coach status:", e);
    }

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
          let progReport = null;
          try {
            const prog = await fetch("/api/program/report").then(r => r.ok ? r.json() : null);
            if (prog && prog.text) progReport = prog.text;
          } catch {}

          latestBrief = SwingAICoach.brief({
            session: latest,
            earlier: earlier,
            story: story,
            compare: cmp,
            focus: typeof journal !== "undefined" ? journal.focus : null,
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
