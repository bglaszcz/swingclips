// The 4-week ball plan on Progress (ballplan.js draws it from GET /api/ballplan): today's session, the
// scoreboard and the plan week by week, above everything else. While the plan runs it is the one plan, so
// the focus's goal card steps aside (#progress.ballplan-on). Tools > 4-week ball plan (and /#ballplan, the
// Start page's link) opens Progress at it; the sessions themselves run from the Start page.
(function () {
  const box = document.getElementById("ballplan-progress");
  const btn = document.getElementById("ballplan-btn");
  const section = document.getElementById("progress");
  if (!box || !section || typeof SwingBallPlan === "undefined") return;
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  let model = null, loaded = 0;

  async function load(force) {
    if (!force && model && Date.now() - loaded < 30000) return;
    try {
      const r = await fetch("/api/ballplan", { cache: "no-store" });
      if (r.ok) {
        model = await r.json();
        loaded = Date.now();
      }
    } catch { /* drawn from what came last */ }
  }

  function draw() {
    const plan = model && model.plan;
    box.hidden = !plan;
    section.classList.toggle("ballplan-on", !!(plan && plan.active));
    if (!plan) return;
    SwingBallPlan.injectStyles(document);
    // This week's check only once it has a session of its own (the last session's otherwise says it all).
    const wk = plan.week ? (model.weeks || [])[plan.week - 1] : null;
    const week = wk && wk.check && wk.check.days.length > 1 ? wk : null;
    const today = model.today
      ? `<div class="bp-muted" style="margin-top: 6px;">Today: ${esc(model.today.title.toLowerCase())}. ${esc(SwingBallPlan.sessionsLine(model))}. ` +
        `The sessions run from the <a href="/start?do=ballplan">Start page</a>.</div>`
      : "";
    box.innerHTML = `<div class="bp-head"><strong>${esc(plan.name)}</strong><span class="bp-muted">${esc(SwingBallPlan.weekLine(model))}</span></div>` +
      `<div class="bp-muted" style="margin-top: 6px;">${esc(plan.why)}</div>${today}` +
      SwingBallPlan.checkHtml(model.checks && model.checks.last, SwingBallPlan.lastTitle(model)) +
      SwingBallPlan.checkHtml(week && week.check, `This week (week ${plan.week})`) +
      (plan.week > 1 ? SwingBallPlan.checkHtml(model.checks && model.checks.plan, "The plan so far") : "") +
      SwingBallPlan.boardHtml(model) + SwingBallPlan.weeksTableHtml(model);
  }

  async function refresh(force) {
    await load(force);
    draw();
  }

  // Drawn whenever Progress opens.
  const origShowView = window.showView || (typeof showView === "function" ? showView : null);
  if (origShowView) {
    window.showView = showView = function (which) {
      origShowView(which);
      if (which === "progress") refresh(false);
    };
  }

  if (btn) {
    btn.onclick = async () => {
      if (typeof openProgress === "function") await openProgress();
      await refresh(true);
      box.scrollIntoView({ block: "start" });
    };
  }
  refresh(true);
})();
