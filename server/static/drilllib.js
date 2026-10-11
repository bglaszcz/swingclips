// Drill library (Tools > Drills): every drill the coach has (coach.js MOVES, both ways of each move),
// what it trains, how to do it, its swing thought, and what your own reps of it did (drillsets.js).
// build() makes the list from what drills-view.js hands it (no DOM); render() draws it: chips to
// filter (Yours, All, one per moment of the swing) and a card per drill.
//
// Works in the browser (window.SwingDrillLib) and in Node (module.exports).
(function (root) {
  const GROUP_ORDER = ["rhythm", "top", "downswing", "impact"];
  const FILTER_KEY = "drill-lib-filter";

  /** "Hip-to-the-stick drill: stand ..." -> {name, how}; a text with no ": " is all how. */
  function split(text) {
    const s = String(text || "");
    const i = s.indexOf(": ");
    if (i < 0) return { name: "Drill", how: s.trim() };
    const how = s.slice(i + 2).trim();
    return { name: s.slice(0, i).trim() || "Drill", how: how ? how[0].toUpperCase() + how.slice(1) : how };
  }

  /** A swing thought without its quotes or final full stop. */
  function bareThought(text) {
    let t = String(text || "").trim();
    t = t.replace(/^["'\u201c\u2018]+/, "").replace(/["'\u201d\u2019]+$/, "").trim();
    t = t.replace(/\.$/, "").trim();
    return t;
  }

  /**
   * The library from the page's data (drills-view.js input()): {drills, groups, mine, counts}.
   * Inside a group, and in `mine`: the focus's drill first, then drills you have sets with (newest
   * set first), then the rest by name.
   */
  function build(input) {
    const inp = input || {};
    const moves = inp.moves || {};
    const plain = typeof inp.plain === "function" ? inp.plain : (t => t);
    const fields = inp.fields || {};
    const momentOf = typeof inp.moment === "function" ? inp.moment
      : (() => ({ id: "rhythm", tag: "RHYTHM", name: "Rhythm" }));
    const verdictOf = typeof inp.verdict === "function" ? inp.verdict : (() => null);
    const sets = Array.isArray(inp.sets) ? inp.sets : [];
    const focus = inp.focus && inp.focus.move ? inp.focus : null;

    const drills = [];
    for (const move of Object.keys(moves)) {
      for (const aim of ["more", "less"]) {
        const side = moves[move] && moves[move][aim];
        if (!side || !side.drill) continue;
        const id = typeof inp.drillId === "function" ? inp.drillId(move, aim) : null;
        if (!id) continue;
        const { name, how } = split(side.drill);
        const mine = sets.filter(s => s && s.drill === id);
        // sets() is newest first; pick the newest by timestamp anyway.
        let newest = null;
        for (const s of mine) if (!newest || (s.timestamp || 0) > (newest.timestamp || 0)) newest = s;
        let last = null;
        if (newest) {
          const v = verdictOf(newest);
          last = {
            date: newest.dateFormatted || "",
            timestamp: newest.timestamp || 0,
            text: v && v.text ? v.text : "",
            level: v && v.level ? v.level : "few",
            firstClip: newest.firstClip || null,
          };
        }
        const m = momentOf(fields[move]) || { id: "rhythm", tag: "RHYTHM", name: "Rhythm" };
        drills.push({
          id, move, aim,
          name: plain(name),
          how: plain(how),
          trains: plain(side.name || ""),
          thought: bareThought(plain(side.thought || "")),
          moment: { id: m.id, tag: m.tag, name: m.name },
          isFocus: !!(focus && focus.move === move && focus.aim === aim),
          on: inp.current != null && inp.current === id,
          sets: mine.length,
          reps: mine.reduce((n, s) => n + (Number(s.count) || 0), 0),
          last,
        });
      }
    }

    const order = (a, b) => {
      if (a.isFocus !== b.isFocus) return a.isFocus ? -1 : 1;
      if (!!a.last !== !!b.last) return a.last ? -1 : 1;
      if (a.last && b.last && a.last.timestamp !== b.last.timestamp) return b.last.timestamp - a.last.timestamp;
      const byName = a.name.localeCompare(b.name);
      if (byName) return byName;
      return a.id.localeCompare(b.id);
    };

    const groups = [];
    for (const gid of GROUP_ORDER) {
      const inGroup = drills.filter(d => d.moment.id === gid).sort(order);
      if (inGroup.length) groups.push({ id: gid, name: inGroup[0].moment.name, drills: inGroup });
    }
    // A moment the four above don't name (never today) still gets its group, after them.
    for (const d of drills) {
      if (GROUP_ORDER.includes(d.moment.id) || groups.some(g => g.id === d.moment.id)) continue;
      groups.push({ id: d.moment.id, name: d.moment.name, drills: drills.filter(x => x.moment.id === d.moment.id).sort(order) });
    }

    const mine = drills.filter(d => d.isFocus || d.sets > 0).sort(order);
    return { drills, groups, mine, counts: { all: drills.length, tried: drills.filter(d => d.sets > 0).length } };
  }

  // ---- Drawing ----

  function el(doc, tag, cls, text) {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function readFilter() {
    try { return root.localStorage ? root.localStorage.getItem(FILTER_KEY) : null; } catch (e) { return null; }
  }
  function saveFilter(v) {
    try { if (root.localStorage) root.localStorage.setItem(FILTER_KEY, v); } catch (e) { /* private mode */ }
  }

  /** "3 sets, 34 reps · last Oct 5: clear carry-over into your swings" */
  function historyText(d) {
    const sets = `${d.sets} set${d.sets === 1 ? "" : "s"}`;
    const reps = `${d.reps} rep${d.reps === 1 ? "" : "s"}`;
    const last = d.last ? ` · last ${d.last.date}${d.last.text ? ": " + d.last.text : ""}` : "";
    return `${sets}, ${reps}${last}`;
  }

  function card(doc, d, opts) {
    const c = el(doc, "div", "dl-card" + (d.isFocus ? " dl-focus" : ""));
    c.dataset.id = d.id;
    const head = el(doc, "div", "dl-head");
    head.append(el(doc, "span", "dl-moment", d.moment.tag));
    if (d.isFocus) head.append(el(doc, "span", "dl-mark", "Your focus"));
    if (d.on) head.append(el(doc, "span", "dl-mark dl-on", "On now"));
    c.append(head);
    c.append(el(doc, "div", "dl-name", d.name));
    const tr = el(doc, "div", "dl-trains");
    tr.append(el(doc, "span", "dl-lab", "Trains: "), doc.createTextNode(d.trains));
    c.append(tr);
    c.append(el(doc, "div", "dl-how", d.how));
    if (d.thought) c.append(el(doc, "div", "dl-thought", `Swing thought: \u201c${d.thought}\u201d`));

    if (d.last) {
      const b = el(doc, "button", `dl-hist dl-${d.last.level || "few"}`, historyText(d));
      b.type = "button";
      b.title = "Open the first swing of that set";
      b.onclick = () => { if (opts.onOpen && d.last.firstClip) opts.onOpen(d.last.firstClip); };
      c.append(b);
    } else {
      c.append(el(doc, "div", "dl-hist dl-none-yet", "Not tried yet"));
    }

    const act = el(doc, "div", "dl-act");
    const btn = el(doc, "button", d.isFocus ? "small primary dl-do" : "small dl-make",
      d.isFocus ? "Do this drill" : "Make this my focus");
    btn.type = "button";
    btn.onclick = () => {
      if (d.isFocus) { if (opts.onStart) opts.onStart(d.id); }
      else if (opts.onFocus) opts.onFocus(d.move, d.aim);
    };
    act.append(btn);
    c.append(act);
    return c;
  }

  /** Draws the library into `box` (replacing what was there): chips, a count, the cards. */
  function render(box, model, opts) {
    if (!box || !model) return;
    opts = opts || {};
    const doc = box.ownerDocument || root.document;
    box.textContent = "";

    const chips = [];
    if (model.mine.length) chips.push({ id: "mine", name: "Yours", drills: model.mine });
    // All: the groups one after another, each in its own order.
    chips.push({ id: "all", name: "All", drills: [].concat(...model.groups.map(g => g.drills)) });
    for (const g of model.groups) chips.push({ id: g.id, name: g.name, drills: g.drills });

    const saved = readFilter();
    let chosen = chips.find(c => c.id === saved) ? saved : (model.mine.length && saved == null ? "mine" : "all");

    const bar = el(doc, "div", "dl-bar");
    const chipRow = el(doc, "div", "dl-chips");
    const count = el(doc, "span", "dl-count",
      `${model.counts.all} drill${model.counts.all === 1 ? "" : "s"} · ${model.counts.tried} tried`);
    bar.append(chipRow, count);
    const grid = el(doc, "div", "dl-grid");
    box.append(bar, grid);

    function draw() {
      chipRow.textContent = "";
      for (const c of chips) {
        const b = el(doc, "button", "dl-chip" + (c.id === chosen ? " active" : ""), `${c.name} (${c.drills.length})`);
        b.type = "button";
        b.dataset.filter = c.id;
        b.setAttribute("aria-pressed", c.id === chosen ? "true" : "false");
        b.onclick = () => { chosen = c.id; saveFilter(chosen); draw(); };
        chipRow.append(b);
      }
      grid.textContent = "";
      const pick = chips.find(c => c.id === chosen) || chips[0];
      for (const d of pick.drills) grid.append(card(doc, d, opts));
    }
    draw();
  }

  const api = { build, render, split, bareThought };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingDrillLib = api;
})(typeof window !== "undefined" ? window : globalThis);
