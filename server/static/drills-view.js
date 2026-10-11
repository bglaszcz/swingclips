// Drill library (Tools > Drills): every drill the coach has (coach.js MOVES), what it trains, how to do
// it, and what your own reps of it did (drillsets.js). drilllib.js builds the list and draws it
// (SwingDrillLib.build / render); this file opens the view and hands it the page's data and actions.
// The menu's button shows once drilllib.js is there.
(function () {
  const box = document.getElementById("drills"), btn = document.getElementById("drills-btn");
  const body = document.getElementById("drills-body"), close = document.getElementById("drills-close");
  if (!box || !btn) return;
  const ready = () => typeof SwingDrillLib !== "undefined";
  btn.hidden = !ready();

  /** What SwingDrillLib.build takes: the coach's moves, your drill sets, the focus, the drill that's on. */
  function input() {
    return {
      moves: SwingCoach.MOVES,
      drillId: SwingCoach.drillId,
      sets: SwingDrillSets.sets(clips, swingRecords, { noiseTable }),
      verdict: SwingDrillSets.verdict,
      focus: journal && journal.focus && journal.focus.move ? journal.focus : null,
      current: typeof prDrill !== "undefined" && prDrill ? prDrill.drill : null,
      plain: SwingShotStory.plain,
      fields: SwingIndicators.KNOWN_FIELDS,
      moment: SwingIndicators.moment,
    };
  }

  function render() {
    if (!ready() || box.hidden) return;
    SwingDrillLib.render(body, SwingDrillLib.build(input()), {
      // A drill belongs to a move: working on it means making that move the focus (Progress's own picker).
      onFocus: async (move, aim) => { await openProgress(); focusPicker(move, aim); },
      // The focus's own drill: Practice, with the reps switched on (board-view.js).
      onStart: async id => { await openPractice(); setPracticeDrill(id); },
      // A set's first swing.
      onOpen: name => open(name),
    });
  }

  async function openDrills() {
    showView("drills");
    renderList();
    await loadTrendData();
    if (typeof loadPracticeDrill === "function") await loadPracticeDrill();
    render();
  }

  btn.onclick = openDrills;
  if (close) close.onclick = () => closeTrendView();
  window.renderDrillLibrary = render;
})();
