// Yardage card view (Tools > Yardage card): opens the view, loads trend data,
// and hands the page's swing rows to SwingYardage.build and render.
(function () {
  const box = document.getElementById("yardage");
  const btn = document.getElementById("yardage-btn");
  const body = document.getElementById("yardage-body");
  const close = document.getElementById("yardage-close");
  const printBtn = document.getElementById("yardage-print");
  if (!box || !btn) return;

  const ready = () => typeof SwingYardage !== "undefined";
  btn.hidden = !ready();

  let period = "90";

  function render() {
    if (!ready() || box.hidden || !body) return;
    const rows = typeof shownClips === "function" && typeof swingRow === "function"
      ? shownClips().filter(c => !c.excluded).map(swingRow)
      : [];

    const nameOf = typeof clubName === "function" ? clubName : (c => c);
    const leftHanded = typeof golferLeftHanded === "function" ? golferLeftHanded() : false;
    const colors = typeof aClubColors === "function" ? aClubColors()
      : (typeof SwingClubSpread !== "undefined" ? SwingClubSpread.colors([...new Set(rows.map(r => r.club))]) : null);

    const model = SwingYardage.build(rows, {
      period,
      nameOf,
      leftHanded,
    });

    SwingYardage.render(body, model, {
      colors,
      nameOf,
      onPeriod: p => {
        period = p;
        render();
      },
    });
  }

  async function openYardage() {
    if (typeof showView === "function") showView("yardage");
    if (box) box.hidden = false;
    if (btn) btn.classList.add("on");
    const toolsBtn = document.getElementById("tools-btn");
    if (toolsBtn) toolsBtn.classList.add("on");

    if (typeof renderList === "function") renderList();
    if (typeof loadTrendData === "function") await loadTrendData();
    render();
  }

  // Wrap showView to toggle yardage view
  const origShowView = window.showView || (typeof showView === "function" ? showView : null);
  if (origShowView) {
    window.showView = showView = function (which) {
      origShowView(which);
      if (box) box.hidden = which !== "yardage";
      if (btn) btn.classList.toggle("on", which === "yardage");
      const toolsBtn = document.getElementById("tools-btn");
      if (toolsBtn && which === "yardage") toolsBtn.classList.add("on");
    };
  }

  // Wrap leaveTrendViews to close yardage view if open
  const origLeaveTrendViews = window.leaveTrendViews || (typeof leaveTrendViews === "function" ? leaveTrendViews : null);
  if (origLeaveTrendViews) {
    window.leaveTrendViews = leaveTrendViews = function () {
      if (box && !box.hidden) {
        if (typeof showView === "function") showView("swing");
        if (typeof renderList === "function") renderList();
        return;
      }
      origLeaveTrendViews();
    };
  }

  btn.onclick = openYardage;
  if (close) close.onclick = () => typeof closeTrendView === "function" ? closeTrendView() : (box.hidden = true);
  if (printBtn) printBtn.onclick = () => window.print();

  window.addEventListener("hashchange", () => {
    if (location.hash === "#yardage") openYardage();
  });

  window.renderYardageCard = render;
  window.openYardage = openYardage;
})();
