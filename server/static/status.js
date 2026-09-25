// Ready panel (top of the page): is everything set for a session? Each phone (connected, recording,
// mode and shutter, battery, uploads), Square (the laptop's heartbeat, Square's app, the last shot),
// the camera framing, the first swing's check, and the pose queue. Green when all is fine. Start and
// stop both phones (or one) from here: they do what their own Start/Stop button does.
// Everything comes from GET /api/status (server/status.py), every 2 s. Mounted on <div id="ready">.

(function () {
  const mount = document.getElementById("ready");
  if (!mount) return;
  const POLL_MS = 2000;
  const KEY = "swingclips.ready.open";

  const css = document.createElement("style");
  css.textContent = `
  #ready { --rd-ok: var(--accent, #1f8a4c); --rd-warn: var(--warn, #b45309); --rd-bad: #dc2626; --rd-off: var(--muted, #5d6b62);
           border-bottom: 1px solid var(--line); background: var(--panel); font-size: 13px; }
  @media (prefers-color-scheme: dark) { #ready { --rd-bad: #f87171; } }
  #ready .rd-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 6px 16px; }
  #ready .rd-toggle { background: none; border: 0; padding: 0; color: inherit; cursor: pointer; display: flex;
                      align-items: center; gap: 8px; font: inherit; min-width: 0; }
  #ready .rd-chev { width: 12px; color: var(--muted); transition: transform 0.15s; }
  #ready.open .rd-chev { transform: rotate(90deg); }
  #ready .rd-head { font-weight: 600; overflow-wrap: anywhere; text-align: left; }
  #ready .rd-chips { display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--muted); flex: 1; min-width: 0; }
  #ready .rd-chip { white-space: nowrap; }
  #ready .rd-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 5px;
                   background: var(--rd-off); vertical-align: 0; flex: none; }
  #ready .rd-dot.ok { background: var(--rd-ok); } #ready .rd-dot.warn { background: var(--rd-warn); }
  #ready .rd-dot.bad { background: var(--rd-bad); } #ready .rd-dot.off { background: transparent; border: 1px solid var(--rd-off); }
  #ready .rd-dot.big { width: 12px; height: 12px; }
  #ready .rd-actions { display: flex; gap: 6px; }
  #ready .rd-bar > .rd-actions { margin-left: auto; }
  #ready.open .rd-chips { display: none; }   /* the rows below say it all */
  #ready .rd-body { padding: 0 16px 8px; }
  #ready .rd-row { display: grid; grid-template-columns: 110px 1fr auto; gap: 4px 10px; align-items: start;
                   padding: 5px 0; border-top: 1px solid var(--line); }
  #ready .rd-label { font-weight: 600; white-space: nowrap; }
  #ready .rd-text { min-width: 0; overflow-wrap: anywhere; }
  #ready .rd-cmd { display: block; color: var(--muted); font-size: 12px; }
  #ready .rd-cmd.bad { color: var(--rd-bad); }
  #ready .rd-note { color: var(--muted); font-size: 12px; padding-top: 4px; }
  @media (max-width: 599px) {
    #ready .rd-row { grid-template-columns: 1fr auto; }
    #ready .rd-row .rd-text { grid-column: 1 / -1; grid-row: 2; }
  }`;
  document.head.appendChild(css);

  let open = false;
  try { open = localStorage.getItem(KEY) === "1"; } catch {}
  let last = null, timer = 0, note = "";

  mount.innerHTML = `
    <div class="rd-bar">
      <button class="rd-toggle" type="button" aria-expanded="false" title="Show or hide the details">
        <span class="rd-chev">▶</span><span class="rd-dot big"></span><span class="rd-head">Checking…</span></button>
      <span class="rd-chips"></span>
      <span class="rd-actions">
        <button class="small" data-action="start" data-angle="both" title="Start recording on both phones">Start both</button>
        <button class="small" data-action="stop" data-angle="both" title="Stop recording on both phones">Stop both</button>
      </span>
    </div>
    <div class="rd-body" hidden><div class="rd-rows"></div><div class="rd-note"></div></div>`;
  const $ = sel => mount.querySelector(sel);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function setOpen(v) {
    open = v;
    mount.classList.toggle("open", open);
    $(".rd-body").hidden = !open;
    $(".rd-toggle").setAttribute("aria-expanded", String(open));
    try { localStorage.setItem(KEY, open ? "1" : "0"); } catch {}
  }
  setOpen(open);
  $(".rd-toggle").onclick = () => setOpen(!open);

  mount.addEventListener("click", async e => {
    const b = e.target.closest("button[data-action]");
    if (!b) return;
    b.disabled = true;
    try {
      const res = await fetch("/api/phones/command", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: b.dataset.action, angle: b.dataset.angle }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) note = body.detail || `The server said ${res.status}`;
      else {
        const refused = (body.results || []).filter(r => r.state === "failed");
        note = refused.length ? refused.map(r => `${NAMES[r.angle]}: ${r.error}`).join(" · ") : "";
      }
    } catch {
      note = "Can't reach the server";
    }
    b.disabled = false;
    poll();
  });

  const NAMES = { face: "Face-on", dtl: "Down the line" };

  /** What a phone's latest command is doing, in words, while it's worth showing. */
  function commandText(c) {
    if (!c || c.age > 60) return null;
    const verb = c.action === "start" ? "start" : "stop";
    if (c.state === "queued" || c.state === "sent") return { text: c.action === "start" ? "Starting…" : "Stopping…" };
    if (c.state === "done") return c.age < 15 ? { text: c.action === "start" ? "Started" : "Stopped" } : null;
    return { text: `Couldn't ${verb}: ${c.error || "no reason given"}`, bad: true };
  }

  function render(s) {
    const dot = $(".rd-bar .rd-dot");
    if (!s) {
      dot.className = "rd-dot big bad";
      $(".rd-head").textContent = "Server not answering";
      $(".rd-chips").innerHTML = "";
      return;
    }
    dot.className = "rd-dot big " + s.level;
    $(".rd-head").textContent = s.headline;
    $(".rd-chips").innerHTML = s.rows.filter(r => r.level !== "off" || r.angle)
      .map(r => `<span class="rd-chip" title="${esc(r.text)}"><span class="rd-dot ${r.level}"></span>${esc(r.label)}</span>`).join("");
    $(".rd-rows").innerHTML = s.rows.map(r => {
      const p = r.angle && s.phones[r.angle];
      const cmd = p && commandText(p.command);
      const buttons = p ? `<span class="rd-actions">
          <button class="small" data-action="start" data-angle="${r.angle}"${p.connected ? "" : " disabled"}>Start</button>
          <button class="small" data-action="stop" data-angle="${r.angle}"${p.connected ? "" : " disabled"}>Stop</button></span>` : "<span></span>";
      return `<div class="rd-row"><span class="rd-label"><span class="rd-dot ${r.level}"></span>${esc(r.label)}</span>
        <span class="rd-text">${esc(r.text)}${cmd ? `<span class="rd-cmd${cmd.bad ? " bad" : ""}">${esc(cmd.text)}</span>` : ""}</span>${buttons}</div>`;
    }).join("");
    const bits = [];
    if (note) bits.push(note);
    bits.push(s.speaker ? `${NAMES[s.speaker]} phone speaks (Practice voice on).` : "No phone connected to speak.");
    if (s.combined && s.combined.age < 120) bits.push(`Said: “${s.combined.text}”`);
    const spoken = (s.session.spoken || []).filter(x => x.age < 600).slice(-2);
    for (const x of spoken) bits.push(`Said: “${x.text}”`);
    $(".rd-note").innerHTML = bits.map(esc).join("<br>");
  }

  async function poll() {
    clearTimeout(timer);
    if (document.hidden) return;
    try {
      const res = await fetch("/api/status");
      last = res.ok ? await res.json() : null;
    } catch {
      last = null;
    }
    render(last);
    timer = setTimeout(poll, POLL_MS);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
  poll();
})();
