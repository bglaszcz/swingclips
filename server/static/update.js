// Tools > Update the server: what's new on GitHub, then a fast-forward pull and, when the change needs
// it, a restart (update.py says which). The page reloads once the server answers again.
(function () {
  const dlg = document.getElementById("update");
  const body = document.getElementById("update-body");
  const go = document.getElementById("update-go");
  const RESTART = {
    none: "Only the review page, docs or the laptop's scripts changed: no restart needed.",
    auto: "The server restarts itself: about half a minute. A clip being analyzed is analyzed again.",
    manual: "Start server.cmd changed, so restart by hand on the server: Stop server.cmd, then Start server.cmd.",
  };

  function el(tag, text, cls) {
    const e = document.createElement(tag);
    if (text != null) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  }

  function when(iso) {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function commitList(commits) {
    const ul = el("ul");
    for (const c of commits) {
      const li = el("li");
      const first = c.subject.length > 140 ? c.subject.slice(0, 140) + "…" : c.subject;
      li.append(el("span", first), " ", el("span", `${c.sha} · ${when(c.when)}`, "when"));
      li.title = c.subject;
      ul.append(li);
    }
    return ul;
  }

  async function answer(res) {
    let doc = null;
    try { doc = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok) throw new Error((doc && doc.detail) || `The server said ${res.status}`);
    return doc;
  }

  async function check() {
    go.hidden = true;
    body.replaceChildren(el("p", "Checking GitHub…"));
    let u;
    try {
      u = await answer(await fetch("/api/update"));
    } catch (e) {
      body.replaceChildren(el("p", "Couldn't check: " + e.message, "warn"));
      return;
    }
    if (!u.commits.length) {
      body.replaceChildren(el("p", `Up to date (${u.current}).`));
      return;
    }
    const n = u.commits.length;
    const parts = [el("p", `${n} update${n === 1 ? "" : "s"} on ${u.upstream} (now at ${u.current}):`),
                   commitList(u.commits), el("p", RESTART[u.restart] || "")];
    if (u.restart === "auto" && u.session) {
      parts.push(el("p", "A session is on: the restart pauses analysis and the phones' spoken checks for about half a minute.", "warn"));
    }
    if (u.ahead) parts.push(el("p", `The server's copy has ${u.ahead} commit(s) GitHub doesn't, so git will refuse to update it.`, "warn"));
    if (u.changed.length) parts.push(el("p", "Edited on the server (kept; git refuses if an update touches them): " + u.changed.join(", "), "note"));
    body.replaceChildren(...parts);
    go.textContent = u.restart === "auto" ? "Update and restart" : "Update";
    go.hidden = false;
  }

  // Wait for the server to go away (or 4 s), then for it to answer again; then reload.
  async function waitForRestart() {
    const started = Date.now();
    let gone = false;
    while (Date.now() - started < 150000) {
      await new Promise(r => setTimeout(r, 1000));
      let up = false;
      try { up = (await fetch("/api/time", { cache: "no-store" })).ok; } catch (e) { /* down */ }
      if (!up) gone = true;
      if (up && (gone || Date.now() - started > 4000)) { location.reload(); return; }
    }
    body.append(el("p", "The server hasn't come back after 2½ minutes. Check it on the server: Start server.cmd.", "warn"));
  }

  go.onclick = async () => {
    go.hidden = true;
    body.replaceChildren(el("p", "Updating…"));
    let u;
    try {
      u = await answer(await fetch("/api/update", { method: "POST" }));
    } catch (e) {
      body.replaceChildren(el("p", "The update didn't go through: " + e.message, "warn"));
      return;
    }
    const done = el("p", u.from === u.to ? `Already at ${u.to}.` : `Updated ${u.from} → ${u.to}.`);
    if (u.restarting) {
      body.replaceChildren(done, el("p", "Restarting the server… the page reloads when it's back."));
      waitForRestart();
    } else if (u.restart === "manual") {
      body.replaceChildren(done, el("p", RESTART.manual, "warn"));
    } else {
      body.replaceChildren(done, el("p", "Reloading the page…"));
      setTimeout(() => location.reload(), 800);
    }
  };

  document.getElementById("update-btn").onclick = () => {
    if (dlg.showModal) dlg.showModal();
    check();
  };
  document.getElementById("update-close").onclick = () => dlg.close();
  dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });
})();
