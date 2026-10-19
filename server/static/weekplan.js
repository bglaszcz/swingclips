// This week (Start page section 1, and one line in Week for coach): how the week's practice stands
// across sessions, the focus's drill sets, the weekly Combine, and whether the focus has held.
// Weeks run Monday 00:00 to Sunday 24:00, local time.
//
// Works in the browser (window.SwingWeekPlan) and in Node (module.exports).
(function (root) {
  const MIN_SWINGS = 10;
  const DEFAULT_NEED = 3;
  const MIN_NEED = 2;
  const MAX_NEED = 5;
  const REPS_NEED = 2;

  const finite = v => typeof v === "number" && Number.isFinite(v);

  function dayStart(t) {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /** Monday 00:00:00.000 local time of the week `t` falls in. */
  function weekStartOf(t) {
    const d = new Date(dayStart(t));
    d.setDate(d.getDate() - (d.getDay() + 6) % 7);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function addDays(t, n) {
    const d = new Date(t);
    d.setDate(d.getDate() + n);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /** "This week (Oct 13 to 19)" or "This week (Sep 29 to Oct 5)". */
  function formatTitle(wStart) {
    const mon = new Date(wStart);
    const sun = new Date(addDays(wStart, 6));
    const sMon = mon.toLocaleDateString("en-US", { month: "short" });
    const sDay = mon.getDate();
    const eMon = sun.toLocaleDateString("en-US", { month: "short" });
    const eDay = sun.getDate();
    const range = sMon === eMon ? `${sMon} ${sDay} to ${eDay}` : `${sMon} ${sDay} to ${eMon} ${eDay}`;
    return `This week (${range})`;
  }

  /** Formats strokes gained per shot as gamesview.js gmSg does. */
  function gmSg(v) {
    if (!finite(v)) return "–";
    return ((v > 0 ? "+" : "") + v.toFixed(2)).replace(/^[+-]?0(\.0+)?$/, "0.00");
  }

  function clampNeed(n) {
    if (n == null || n === "" || typeof n === "boolean" || !finite(Number(n))) return DEFAULT_NEED;
    return Math.max(MIN_NEED, Math.min(MAX_NEED, Math.round(Number(n))));
  }

  function sessionTime(s) {
    if (!s) return 0;
    if (finite(s.start)) return s.start < 1e11 ? s.start * 1000 : s.start;
    if (Array.isArray(s.clips) && s.clips.length) {
      const oldest = s.clips[s.clips.length - 1];
      const t = oldest && (oldest.t || Date.parse(oldest.recorded));
      if (finite(t)) return t < 1e11 ? t * 1000 : t;
    }
    return 0;
  }

  function sessionSwings(s) {
    if (!s) return 0;
    if (Array.isArray(s.clips)) return s.clips.filter(c => !c || !c.excluded).length;
    if (finite(s.n)) return s.n;
    if (finite(s.swings)) return s.swings;
    if (Array.isArray(s.rows)) return s.rows.length;
    return 0;
  }

  function setTime(d) {
    if (!d) return 0;
    const t = finite(d.timestamp) ? d.timestamp : (finite(d.t) ? d.t : (d.date ? Date.parse(d.date) : 0));
    if (!finite(t) || t <= 0) return 0;
    return t < 1e11 ? t * 1000 : t;
  }

  /** Normalizes finished Combine entries from either /api/game log or SwingGames.gameHistory(log, "combine"), newest first. */
  function combineEntries(games) {
    const raw = Array.isArray(games) ? games : (games && Array.isArray(games.log) ? games.log : []);
    if (!raw.length) return [];
    const Games = root.SwingGames;
    // If raw looks like /api/game log (entries have .id) and SwingGames.gameHistory is available, use it.
    const hasIds = raw.some(e => e && typeof e.id === "string");
    const list = (hasIds && Games && typeof Games.gameHistory === "function")
      ? Games.gameHistory(raw, "combine")
      : raw.filter(e => e && (!e.id || e.id === "combine"));

    const out = [];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e) continue;
      if (e.how && e.how !== "done") continue;
      const tRaw = finite(e.started) ? e.started : (finite(e.timestamp) ? e.timestamp : (finite(e.t) ? e.t : 0));
      const startedMs = tRaw > 0 && tRaw < 1e11 ? tRaw * 1000 : tRaw;
      if (!(startedMs > 0)) continue;
      const sum = e.summary || {};
      const shots = finite(e.shots) ? e.shots : (finite(sum.shots) ? sum.shots : (Array.isArray(e.results) ? e.results.length : 0));
      const hits = finite(e.hits) ? e.hits : (finite(e.greens) ? e.greens : (finite(sum.greens) ? sum.greens : 0));
      const sgPerShot = finite(e.sgPerShot) ? e.sgPerShot : (finite(sum.sgPerShot) ? sum.sgPerShot : null);
      if (shots <= 0 && sgPerShot == null) continue;
      out.push({ startedMs, shots, hits, sgPerShot, order: i });
    }
    // If input came from raw log (chronological), sort newest first; if already newest first, timestamps sort newest first.
    out.sort((a, b) => (b.startedMs - a.startedMs) || (a.order - b.order));
    return out;
  }

  function buildForWeek(inp, wStart, nowMs, includeLast) {
    const wEnd = addDays(wStart, 7);
    const prevStart = addDays(wStart, -7);
    const need = clampNeed(inp.need);
    const focus = inp.focus && inp.focus.move ? inp.focus : null;

    // 1. Sessions this week with at least MIN_SWINGS swings (including a session still going once it has 10 swings).
    const sessions = Array.isArray(inp.sessions) ? inp.sessions : [];
    let sessHave = 0;
    for (const s of sessions) {
      const t = sessionTime(s);
      if (t >= wStart && t < wEnd && sessionSwings(s) >= MIN_SWINGS) sessHave++;
    }
    const sessDone = sessHave >= need;
    const items = [{
      id: "sessions",
      label: "Sessions",
      have: sessHave,
      need,
      done: sessDone,
      text: `${sessHave} of ${need} sessions${sessDone ? " \u2713" : ""}`,
    }];

    // 2. Reps (only with a focus whose drillId is not null).
    const Coach = root.SwingCoach;
    const DrillSets = root.SwingDrillSets;
    const drillIdFn = typeof inp.drillId === "function" ? inp.drillId : (Coach && typeof Coach.drillId === "function" ? Coach.drillId : null);
    const fDrill = !focus ? null
      : typeof inp.drillId === "string" ? inp.drillId
      : drillIdFn ? drillIdFn(focus.move, focus.aim) : null;

    if (focus && fDrill) {
      const allSets = Array.isArray(inp.drillSets) ? inp.drillSets : [];
      const weekSets = allSets
        .filter(d => d && d.drill === fDrill && setTime(d) >= wStart && setTime(d) < wEnd)
        .sort((a, b) => setTime(b) - setTime(a));
      const repsHave = weekSets.length;
      const repsDone = repsHave >= REPS_NEED;
      let vWords = "";
      if (weekSets.length) {
        const newest = weekSets[0];
        const verdictFn = typeof inp.verdict === "function" ? inp.verdict
          : (DrillSets && typeof DrillSets.verdict === "function" ? DrillSets.verdict : null);
        const v = newest.verdict != null ? newest.verdict : (verdictFn ? verdictFn(newest) : null);
        vWords = typeof v === "string" ? v : (v && v.text ? v.text : "");
      }
      items.push({
        id: "reps",
        label: "Reps",
        have: repsHave,
        need: REPS_NEED,
        done: repsDone,
        text: `${repsHave} of ${REPS_NEED} drill sets for your focus${vWords ? `: ${vWords}` : ""}`,
      });
    }

    // 3. Test: a Combine finished this week, need 1.
    const combines = combineEntries(inp.games);
    const weekCombines = combines.filter(c => c.startedMs >= wStart && c.startedMs < wEnd);
    const prevCombines = combines.filter(c => c.startedMs >= prevStart && c.startedMs < wStart);
    const earlierCombines = combines.filter(c => c.startedMs < wStart);
    const testHave = weekCombines.length;
    const testDone = testHave >= 1;
    let testText;
    if (!testDone) {
      testText = "Combine: not played yet this week";
    } else {
      const newest = weekCombines[0];
      const day = new Date(newest.startedMs).toLocaleDateString("en-US", { weekday: "short" });
      const scoreWords = `${gmSg(newest.sgPerShot)} strokes a shot vs tour`;
      let comp;
      if (prevCombines.length) {
        comp = `last week ${gmSg(prevCombines[0].sgPerShot)}`;
      } else if (!earlierCombines.length) {
        comp = "your first";
      } else {
        comp = `last time ${gmSg(earlierCombines[0].sgPerShot)}`;
      }
      testText = `Combine on ${day}: ${scoreWords} (${comp})`;
    }
    items.push({
      id: "test",
      label: "Combine",
      have: testHave,
      need: 1,
      done: testDone,
      text: testText,
    });

    // 4. Held (only with a focus): not counted in done/total.
    const Graduate = root.SwingGraduate;
    const held = focus ? (inp.held !== undefined ? inp.held : (Graduate && typeof Graduate.check === "function" ? Graduate.check(null) : null)) : null;
    if (focus) {
      const wordsFn = typeof inp.words === "function" ? inp.words
        : (Graduate && typeof Graduate.words === "function" ? Graduate.words : (h => (h && h.text) || ""));
      const heldDone = Boolean(held && held.state === "held");
      items.push({
        id: "held",
        label: "Focus",
        have: held && finite(held.run) ? held.run : (heldDone ? 3 : 0),
        need: held && finite(held.of) ? held.of : 3,
        done: heldDone,
        text: wordsFn(held) || "",
      });
    }

    const counted = items.filter(i => i.id !== "held");
    const done = counted.filter(i => i.done).length;
    const total = counted.length;

    const dayIdx = (new Date(nowMs).getDay() + 6) % 7;
    const daysLeft = 7 - dayIdx;

    let line = done >= total
      ? "All done this week."
      : `${done} of ${total} done this week, ${daysLeft} day${daysLeft === 1 ? "" : "s"} left.`;
    if (held && held.state === "held") {
      line += " Your focus has held: pick the next one on the review page (Progress).";
    }

    const last = includeLast ? buildForWeek(inp, prevStart, prevStart, false) : null;

    return {
      weekStart: wStart,
      title: formatTitle(wStart),
      daysLeft,
      items,
      done,
      total,
      line,
      last,
    };
  }

  /**
   * Builds the week plan model (pure, no DOM).
   */
  function build(input) {
    const inp = input || {};
    const nowMs = finite(inp.now) ? inp.now : Date.now();
    const wStart = weekStartOf(nowMs);
    return buildForWeek(inp, wStart, nowMs, true);
  }

  // ---- Drawing (Part 2) ----

  function el(doc, tag, cls, text) {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /**
   * Renders the compact This week card into `box`.
   * Collapsed to the head line while both phones are recording (`opts.recording`).
   */
  function render(box, model, opts) {
    if (!box || !model) return;
    opts = opts || {};
    const doc = box.ownerDocument || root.document;
    box.textContent = "";

    const head = el(doc, "div", "wp-head");
    const title = el(doc, "span", "wp-title", model.title);
    const sep = el(doc, "span", "wp-sep", " \u00b7 ");
    const line = el(doc, "span", "wp-line", model.line);
    head.append(title, sep, line);
    box.append(head);

    if (opts.recording) return;

    const list = el(doc, "div", "wp-items");
    for (const item of model.items || []) {
      const row = el(doc, "div", "wp-row" + (item.done ? " wp-done" : ""));
      row.dataset.id = item.id;
      const mark = el(doc, "span", "wp-mark", item.done ? "\u2713" : "\u25cb");
      mark.setAttribute("aria-hidden", "true");
      const text = el(doc, "span", "wp-text", item.text);
      row.append(mark, text);
      list.append(row);
    }
    box.append(list);

    const foot = el(doc, "div", "wp-foot");
    if (model.last) {
      foot.append(el(doc, "span", "wp-last", `Last week: ${model.last.done} of ${model.last.total}`));
    }
    const sessItem = (model.items || []).find(i => i.id === "sessions");
    const curNeed = sessItem ? sessItem.need : DEFAULT_NEED;
    const label = el(doc, "label", "wp-need-label", "Sessions a week: ");
    const sel = el(doc, "select", "wp-need");
    for (const n of [2, 3, 4, 5]) {
      const opt = el(doc, "option", null, String(n));
      opt.value = String(n);
      if (n === curNeed) opt.selected = true;
      sel.append(opt);
    }
    sel.value = String(curNeed);
    sel.onchange = () => {
      if (typeof opts.onNeed === "function") opts.onNeed(Number(sel.value));
    };
    label.append(sel);
    foot.append(label);
    box.append(foot);
  }

  const api = {
    MIN_SWINGS,
    DEFAULT_NEED,
    MIN_NEED,
    MAX_NEED,
    REPS_NEED,
    weekStartOf,
    gmSg,
    build,
    render,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingWeekPlan = api;
})(typeof window !== "undefined" ? window : globalThis);
