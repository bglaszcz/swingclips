// Menus: a button (.menu-btn) that opens the list after it (.menu-pop). A pick closes the list, except
// in "stay" lists (the Show menu), which stay open to toggle several; a click elsewhere or Esc closes.
// The buttons inside keep their own ids and handlers (index.html, trends.js, labels.js …).
(function () {
  /**
   * The Show button's label: how many overlays are on among those offered here, "Show · 3 ▾". A
   * button hidden by its `hidden` attribute or by CSS (Angles shows only with Advanced data, and is
   * on by default) doesn't count, or the button reads "Show · 1" with nothing ticked in the list.
   */
  function showLabel(buttons, displayed) {
    const n = buttons.filter(b => !b.hidden && b.classList.contains("on") && displayed(b)).length;
    return `Show${n ? " · " + n : ""} ▾`;
  }
  if (typeof module === "object" && module.exports) module.exports = { showLabel };
  if (typeof document === "undefined") return;

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

  // The Show button says how many overlays are on: "Show · 3 ▾" (showLabel). Counted again when a
  // button changes, and when Advanced data is switched (the viewer's class) since that shows Angles.
  const showPop = document.getElementById("show-pop"), showBtn = document.getElementById("show-btn");
  if (showPop && showBtn) {
    const displayed = b => getComputedStyle(b).display !== "none";
    const count = () => { showBtn.textContent = showLabel([...showPop.querySelectorAll("button")], displayed); };
    new MutationObserver(count).observe(showPop, { attributes: true, subtree: true, attributeFilter: ["class", "hidden"] });
    const viewer = showBtn.closest("#viewer");
    if (viewer) new MutationObserver(count).observe(viewer, { attributes: true, attributeFilter: ["class"] });
    count();
  }
  window.closeMenus = closeMenus;
})();
