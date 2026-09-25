// Menus: a button (.menu-btn) that opens the list after it (.menu-pop). A pick closes the list, except
// in "stay" lists (the Show menu), which stay open to toggle several; a click elsewhere or Esc closes.
// The buttons inside keep their own ids and handlers (index.html, trends.js, labels.js …).
(function () {
  function closeMenus() {
    for (const pop of document.querySelectorAll(".menu-pop")) {
      pop.hidden = true;
      pop.previousElementSibling.classList.remove("open");
    }
  }
  for (const btn of document.querySelectorAll(".menu > .menu-btn")) {
    const pop = btn.nextElementSibling;
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const opening = pop.hidden;
      closeMenus();
      pop.hidden = !opening;
      btn.classList.toggle("open", opening);
    });
    if (!pop.classList.contains("stay")) {
      pop.addEventListener("click", e => { if (e.target.closest("button")) setTimeout(closeMenus); });
    }
  }
  document.addEventListener("click", e => { if (!e.target.closest(".menu-pop")) closeMenus(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeMenus(); });

  // The Show button says how many overlays are on: "Show · 3 ▾".
  const showPop = document.getElementById("show-pop"), showBtn = document.getElementById("show-btn");
  if (showPop && showBtn) {
    const count = () => {
      const n = [...showPop.querySelectorAll("button")].filter(b => !b.hidden && b.classList.contains("on")).length;
      showBtn.textContent = `Show${n ? " · " + n : ""} ▾`;
    };
    new MutationObserver(count).observe(showPop, { attributes: true, subtree: true, attributeFilter: ["class", "hidden"] });
    count();
  }
  window.closeMenus = closeMenus;
})();
