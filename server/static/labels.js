// Labeling mode, for the scorecard (server/eval.py): mark by hand when each key moment happens, and
// where the joints, the club and the ball are, on the swing that's open. Press L (or Label) to start.
//
// Each clip's labels are saved as you go to /api/labels/<clip> (?pass=2 for a second pass, done
// days later without looking at the first, which measures how consistent the labels themselves are).
// Times are the start of the frame on screen, from the pose file, since phone clips drop frames;
// positions are shares of the upright picture, like the pose file's.
//
// Uses the review page's own state and helpers (index.html): video, video2, pose, partner, current,
// clips, positions, overlays, frameIndexAt, fitRect, jumpTo, partnerOffset, syncPartner, setSkeleton, setOverlay.
(function () {
  const EVENTS = [
    ["takeaway", "Takeaway", "T", "Takeaway"], ["p2", "P2 shaft parallel back", "2", "Shaft back"],
    ["p3", "P3 lead arm parallel back", "3", "Arm back"], ["p4", "P4 top", "4", "Top"],
    ["p5", "P5 lead arm parallel down", "5", "Arm down"], ["p6", "P6 shaft parallel down", "6", "Shaft down"],
    ["impact", "P7 impact", "7", "Impact"], ["p8", "P8 shaft parallel through", "8", "Through"],
  ];
  // The points, grouped as they're shown (indices into POINTS, which keeps the clicking order).
  const POINT_GROUPS = [["Golfer's left", [0, 1, 2, 6]], ["Golfer's right", [3, 4, 5, 7]], ["Club", [8, 9, 10]]];
  const KEYS_OPEN = "labelKeysOpen";
  const EVENT_KEYS = { t: "takeaway", 2: "p2", 3: "p3", 4: "p4", 5: "p5", 6: "p6", 7: "impact", i: "impact", 8: "p8" };
  // What gets clicked on a frame, in order. Left and right are the golfer's own.
  const POINTS = [
    ["l_shoulder", "Left shoulder", "LS"], ["l_elbow", "Left elbow", "LE"], ["l_wrist", "Left wrist", "LW"],
    ["r_shoulder", "Right shoulder", "RS"], ["r_elbow", "Right elbow", "RE"], ["r_wrist", "Right wrist", "RW"],
    ["l_hip", "Left hip", "LH"], ["r_hip", "Right hip", "RH"],
    ["grip", "Club: grip end", "G"], ["hosel", "Club: hosel", "Ho"], ["head", "Club: clubhead", "CH"],
  ];
  const LEFT_COLOR = "#22d3ee", RIGHT_COLOR = "#f472b6", CLUB_COLOR = "#facc15", BALL_COLOR = "#f97316";
  const SAVE_DELAY_MS = 500;

  const panel = document.getElementById("labelpanel");
  const button = document.getElementById("label-btn");
  const stages = document.getElementById("stages");

  let on = false;
  let labelPass = 1;
  let active = "main";          // which video clicks and keys go to: "main" or "dtl"
  let target = 0;               // index into POINTS of the next point to click
  let ballArmed = false;        // the next click places the ball
  let shownBefore = null;       // the tracker's overlays, hidden while labeling so they don't sway the labels
  let lastFrameKey = null;
  let labeledCount = null;
  let message = "";
  // `${clip}|${pass}` -> {doc, state: "loading" | "ready" | "saving" | "saved" | "error", timer}
  const docs = new Map();
  // What the server's label checks (labelcheck.py) say to fix, by clip: [{kind, t, points, event, text}].
  let fixes = new Map(), fixesTimer = null;
  const FIX_COLOR = "#ef4444";

  // ---- The clip on screen ----

  function activeClip() {
    if (active === "dtl" && partner) return { name: partner.name, pose: partner.pose, video: video2 };
    return { name: current, pose, video };
  }

  function clipInfo(name) {
    const c = clips.find(c => c.name === name);
    return c ? { name, angle: c.angle || "face", strike: c.strike ?? null } : { name, angle: "face", strike: null };
  }

  /** The start of the frame on screen in the active clip (s), or null before it's analyzed. */
  function frameTime() {
    const a = activeClip();
    if (!a.pose || !a.pose.frames.length) return null;
    return a.pose.frames[frameIndexAt(a.video.currentTime, a.pose)].t;
  }
  const frameKey = t => t.toFixed(6);

  // ---- Label files ----

  function entry(name) {
    if (!name) return null;
    const key = `${name}|${labelPass}`;
    let e = docs.get(key);
    if (!e) {
      e = { doc: null, state: "loading", timer: null, pass: labelPass };
      docs.set(key, e);
      fetch(`/api/labels/${encodeURIComponent(name)}?pass=${labelPass}`)
        .then(res => res.status === 404 ? null : res.ok ? res.json() : Promise.reject(new Error(res.statusText)))
        .then(doc => {
          e.doc = doc || { schema: 1, clip: clipInfo(name), partner: null, events: {}, ball: null, frames: {} };
          e.state = "ready";
        })
        .catch(err => { e.state = "error"; message = `Couldn't load labels: ${err.message}`; })
        .finally(() => { render(); redraw(); });
    }
    return e;
  }

  function activeDoc() {
    const e = entry(activeClip().name);
    return e && e.doc ? e : null;
  }

  /** Saves a clip's labels a moment after the last change. */
  function changed(e) {
    const c = clips.find(c => c.name === e.doc.clip.name);
    e.doc.clip = clipInfo(e.doc.clip.name);
    e.doc.partner = c && c.partner ? clipInfo(c.partner) : null;
    e.changes = (e.changes || 0) + 1;
    e.state = "saving";
    clearTimeout(e.timer);
    // One save at a time, each sending the labels as they are by then, so they land in order.
    e.timer = setTimeout(() => { e.saving = (e.saving || Promise.resolve()).then(() => save(e)); }, SAVE_DELAY_MS);
    render();
    redraw();
  }

  async function save(e) {
    const name = e.doc.clip.name, changes = e.changes;
    try {
      const res = await fetch(`/api/labels/${encodeURIComponent(name)}?pass=${e.pass}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(e.doc),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
      if (e.changes === changes) e.state = "saved";
      refreshCount();
      clearTimeout(fixesTimer);
      fixesTimer = setTimeout(loadFixes, 1200);
    } catch (err) {
      e.state = "error";
      message = `Not saved: ${err.message}`;
    }
    render();
  }

  function loadFixes() {
    fetch("/api/labels/summary", { cache: "no-store" }).then(r => r.ok ? r.json() : null).then(d => {
      if (!d) return;
      // Marked correct here but not yet saved (or the server's checks are older): left out all the same.
      const accepted = name => new Set((docs.get(`${name}|${labelPass}`)?.doc?.accepted) || []);
      fixes = new Map((d.clips || []).filter(c => c.pass === labelPass && c.clip)
        .map(c => [c.clip, (c.fixes || []).filter(f => !accepted(c.clip).has(f.key))]));
      render();
      redraw();
    }).catch(() => {});
  }

  /** The fixes on the frame at time t of clip `name`. */
  function fixesAt(name, t) {
    return (fixes.get(name) || []).filter(f => f.t != null && Math.abs(f.t - t) < 0.0008);
  }

  /**
   * "It's correct": the label is right and the check is wrong (the tracker is what's being measured).
   * Kept in the label file (labelcheck.py skips it) until the label it's about moves.
   */
  function acceptFix(name, f) {
    const e = entry(name);
    if (!e || !e.doc || !f.key) return;
    e.doc.accepted = [...new Set([...(e.doc.accepted || []), f.key])];
    fixes.set(name, (fixes.get(name) || []).filter(x => x.key !== f.key));
    message = "Marked correct: it won't be flagged again unless that label changes.";
    changed(e);
  }

  function unacceptAll(name) {
    const e = entry(name);
    if (!e || !e.doc) return;
    delete e.doc.accepted;
    message = "The checks you marked correct are back.";
    changed(e);
  }

  /** This swing's fixes with a frame to go to, in order: face-on first, then down the line. */
  function swingFixes() {
    const out = [];
    for (const [which, name] of [["main", current], ["dtl", partner && partner.name]]) {
      if (!name) continue;
      for (const f of fixes.get(name) || []) if (f.t != null) out.push({ ...f, which, name });
    }
    return out;
  }

  /** Goes to the next fix after the frame on screen (across both angles), wrapping round. */
  function nextFix() {
    const list = swingFixes();
    if (!list.length) return;
    const t = frameTime(), here = active === "main" ? 0 : 1;
    const key = f => [f.which === "main" ? 0 : 1, f.t];
    const after = list.find(f => { const [w, ft] = key(f); return w > here || (w === here && t != null && ft > t + 0.0008); });
    goTo((after || list[0]).which, (after || list[0]).t);
  }

  /** Shows the frame at time t (the clip's own seconds) of the "main" or "dtl" clip. */
  function goTo(which, t) {
    if (which !== active) setActive(which);
    const a = activeClip();
    if (!a.pose) return;
    const f = a.pose.frames;
    let i = 0;
    while (i + 1 < f.length && Math.abs(f[i + 1].t - t) <= Math.abs(f[i].t - t)) i++;
    showFrame(i);
  }

  function refreshCount() {
    fetch("/api/labels").then(r => r.json()).then(l => { labeledCount = (l[String(labelPass)] || []).length; render(); })
      .catch(() => {});
  }

  // ---- Suggested frames ----

  /** About a dozen frames worth labeling: spread over the swing, most of them in the downswing. */
  function suggestions() {
    const a = activeClip();
    if (!a.pose || !a.pose.frames.length) return [];
    const at = k => positions.find(p => p.key === k)?.t ?? null;
    const mid = (x, y) => x != null && y != null ? (x + y) / 2 : null;
    const plus = (x, d) => x != null ? x + d : null;
    let times;
    if (positions.length) {
      const [p1, p2, p3, p4, p5, p6, p7, p8] = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"].map(at);
      times = [p1, p2, p3, p4, p5, mid(p5, p6), p6, mid(p6, p7), p7, plus(p7, 0.03), p8, plus(p8, 0.15)];
    } else {
      const c = clips.find(c => c.name === current);
      const strike = c && c.strike != null ? c.strike : 2.0;
      times = Array.from({ length: 12 }, (_, k) => strike - 1.2 + k * (1.6 / 11));
    }
    const idx = new Set();
    for (const t of times) {
      if (t == null) continue;
      idx.add(frameIndexAt(a.video === video2 ? t + partnerOffset() : t, a.pose));
    }
    return [...idx].sort((x, y) => x - y);
  }

  function frameDone(doc, t) {
    const pts = doc.frames[frameKey(t)];
    return !!pts && POINTS.every(([k]) => pts[k]);
  }

  /** Shows frame i of the active clip. Down the line, the face-on video is moved so that the synced
   *  down-the-line one lands on it. */
  function showFrame(i) {
    const a = activeClip();
    const f = a.pose.frames;
    i = Math.max(0, Math.min(f.length - 1, i));
    const t = i + 1 < f.length ? (f[i].t + f[i + 1].t) / 2 : f[i].t + 0.001;
    if (a.video === video) { jumpTo(i); return; }
    video.pause();
    video.currentTime = Math.max(0, t - partnerOffset());
    syncPartner();
  }

  // ---- Actions ----

  function setEvent(key) {
    const e = activeDoc(), t = frameTime();
    if (!e || t == null) return;
    const label = EVENTS.find(ev => ev[0] === key)[1];
    if (e.doc.events[key] === t) {
      delete e.doc.events[key];
      message = `${label} cleared.`;
    } else {
      e.doc.events[key] = t;
      message = `${label} at ${t.toFixed(3)} s.`;
    }
    changed(e);
  }

  /** The first point not yet done on this frame, from `from` on (wrapping round). */
  function nextTarget(pts, from) {
    for (let k = 0; k < POINTS.length; k++) {
      const j = (from + k) % POINTS.length;
      if (!pts || !pts[POINTS[j][0]]) return j;
    }
    return from % POINTS.length;
  }

  function setPoint(value) {
    const e = activeDoc(), t = frameTime();
    if (!e || t == null) return;
    const key = frameKey(t);
    const pts = e.doc.frames[key] = e.doc.frames[key] || {};
    pts[POINTS[target][0]] = value;
    target = nextTarget(pts, target + 1);
    changed(e);
  }

  function clearPoint() {
    const e = activeDoc(), t = frameTime();
    if (!e || t == null) return;
    const key = frameKey(t), pts = e.doc.frames[key];
    if (!pts) return;
    // Back up to the last point placed, if the current one isn't placed yet.
    if (!pts[POINTS[target][0]]) {
      for (let k = 1; k <= POINTS.length; k++) {
        const j = (target - k + POINTS.length) % POINTS.length;
        if (pts[POINTS[j][0]]) { target = j; break; }
      }
    }
    delete pts[POINTS[target][0]];
    if (!Object.keys(pts).length) delete e.doc.frames[key];
    changed(e);
  }

  function onClick(ev, which) {
    if (!on) return;
    if (which !== active) { setActive(which); return; }
    const a = activeClip();
    if (!a.pose || !a.video.videoWidth) return;
    const dpr = window.devicePixelRatio || 1;
    const c = ev.currentTarget;
    const r = fitRect(c.width, c.height, a.video);
    const x = (ev.offsetX * dpr - r.x) / r.w, y = (ev.offsetY * dpr - r.y) / r.h;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    const xy = { x: Math.round(x * 1e5) / 1e5, y: Math.round(y * 1e5) / 1e5 };
    if (ballArmed) {
      const e = activeDoc();
      if (!e) return;
      e.doc.ball = xy;
      ballArmed = false;
      message = "Ball placed.";
      changed(e);
      return;
    }
    setPoint(ev.shiftKey ? { ...xy, blur: true } : xy);
  }

  function setActive(which) {
    if (which === "dtl" && !partner) return;
    active = which;
    lastFrameKey = null;
    render();
    redraw();
  }

  function setPass(n) {
    labelPass = n;
    lastFrameKey = null;
    refreshCount();
    render();
    redraw();
  }

  function setOn(v) {
    if (v && (!current || viewer.hidden)) return;
    on = v;
    stages.classList.toggle("labeling", on);
    panel.hidden = !on;
    button.classList.toggle("on", on);
    if (on) {
      video.pause();
      if (!partner) active = "main";
      shownBefore = { skeleton: showSkeleton, ...overlays };
      if (showSkeleton) setSkeleton(false);
      for (const k in overlays) if (overlays[k]) setOverlay(k, false);
      message = "";
      refreshCount();
      loadFixes();
    } else if (shownBefore) {
      if (shownBefore.skeleton) setSkeleton(true);
      for (const k in overlays) if (shownBefore[k]) setOverlay(k, true);
      shownBefore = null;
    }
    render();
    redraw();
  }

  // ---- Drawing over the video ----

  function drawOn(ctx, r, which, i) {
    if (!on) return;
    const name = which === "dtl" ? partner && partner.name : current;
    const p = which === "dtl" ? partner && partner.pose : pose;
    const e = entry(name);
    if (!p || !e || !e.doc) return;
    const t = p.frames[i].t;
    const pts = e.doc.frames[frameKey(t)] || {};
    const toPx = q => ({ x: r.x + q.x * r.w, y: r.y + q.y * r.h });
    const size = Math.max(5, r.w / 90), font = Math.max(12, r.w / 40);
    ctx.save();
    ctx.lineWidth = Math.max(1.5, r.w / 300);
    ctx.font = `600 ${font}px system-ui, sans-serif`;
    const club = ["grip", "hosel", "head"].map(k => pts[k]).filter(q => q && q.x != null).map(toPx);
    if (club.length > 1) {
      ctx.strokeStyle = CLUB_COLOR;
      ctx.beginPath();
      club.forEach((q, k) => k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y));
      ctx.stroke();
    }
    for (const [key, , tag] of POINTS) {
      const q = pts[key];
      if (!q || q.x == null) continue;
      const at = toPx(q);
      ctx.strokeStyle = ctx.fillStyle = key.startsWith("l_") ? LEFT_COLOR : key.startsWith("r_") ? RIGHT_COLOR : CLUB_COLOR;
      ctx.setLineDash(q.blur ? [4, 3] : []);
      ctx.beginPath();
      ctx.arc(at.x, at.y, size, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText(tag, at.x + size + 2, at.y - size);
    }
    if (e.doc.ball) {
      const b = toPx(e.doc.ball);
      ctx.strokeStyle = BALL_COLOR;
      ctx.beginPath();
      ctx.arc(b.x, b.y, size * 1.4, 0, 2 * Math.PI);
      ctx.stroke();
    }
    // What the label checks say to fix here: a red dashed ring round each point concerned.
    const toFix = fixesAt(name, t);
    if (toFix.length) {
      ctx.strokeStyle = FIX_COLOR;
      ctx.lineWidth = Math.max(2, r.w / 250);
      ctx.setLineDash([6, 4]);
      for (const key of new Set(toFix.flatMap(f => f.points || []))) {
        const q = key === "ball" ? e.doc.ball : pts[key];
        if (!q || q.x == null) continue;
        const at = toPx(q);
        ctx.beginPath();
        ctx.arc(at.x, at.y, size * 2.2, 0, 2 * Math.PI);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    const here = EVENTS.filter(([k]) => e.doc.events[k] === t).map(([, label]) => label);
    if (here.length) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
      const text = here.join(", ");
      ctx.fillRect(r.x + 8, r.y + r.h - font * 2.4, ctx.measureText(text).width + font, font * 1.8);
      ctx.fillStyle = "#fff";
      ctx.fillText(text, r.x + 8 + font / 2, r.y + r.h - font * 1.05);
    }
    if (which === active) {
      ctx.strokeStyle = CLUB_COLOR;
      ctx.lineWidth = 3;
      ctx.strokeRect(r.x + 1.5, r.y + 1.5, r.w - 3, r.h - 3);
      // What to click next, where the eyes are: a pill at the top of the picture.
      const next = ballArmed ? ["Ball", BALL_COLOR] : [POINTS[target][1], pointColor(POINTS[target][0])];
      const done = POINTS.filter(([k]) => pts[k]).length;
      const text = `Click: ${next[0]}   ${done}/${POINTS.length}`;
      const fs = Math.max(12, Math.min(18, r.w / 22)), pad = fs * 0.6, dot = fs * 0.45;
      ctx.font = `600 ${fs}px system-ui, sans-serif`;
      const w = ctx.measureText(text).width + pad * 3 + dot * 2, h = fs * 1.9;
      const x = r.x + (r.w - w) / 2, y = r.y + 10;
      ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, h / 2);
      ctx.fill();
      ctx.fillStyle = next[1];
      ctx.beginPath();
      ctx.arc(x + pad + dot, y + h / 2, dot, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillText(text, x + pad * 2 + dot * 2, y + h * 0.68);
    }
    ctx.restore();
    if (which === active && frameKey(t) !== lastFrameKey) {
      lastFrameKey = frameKey(t);
      target = nextTarget(pts, 0);
      render();
    }
  }

  // ---- The panel ----

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter(c => c != null));
    return node;
  }

  function chip(text, opts = {}) {
    const b = el("button", { className: "small" + (opts.on ? " on" : "") + (opts.done ? " done" : ""), textContent: text, title: opts.title || "" });
    if (opts.onclick) b.onclick = opts.onclick; else b.disabled = true;
    return b;
  }

  /** A segmented control: [label, isOn, onclick] per option. */
  function seg(options, aria) {
    const box = el("span", { className: "seg" });
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", aria);
    box.append(...options.map(([text, isOn, onclick, title]) => {
      const b = el("button", { className: isOn ? "on" : "", textContent: text, title: title || "" });
      b.onclick = onclick;
      return b;
    }));
    return box;
  }

  const kbd = k => el("kbd", { textContent: k });
  const pointColor = key => key.startsWith("l_") ? LEFT_COLOR : key.startsWith("r_") ? RIGHT_COLOR : CLUB_COLOR;

  /** "3 / 8" with a thin bar. */
  function meter(label, n, of) {
    const pct = of ? Math.round(n / of * 100) : 0;
    const bar = el("span", { className: "lp-bar" }, el("i"));
    bar.firstChild.style.width = pct + "%";
    return el("div", { className: "lp-meter" + (of && n >= of ? " full" : "") },
      el("span", { className: "lp-mlabel", textContent: label }), bar, el("b", { textContent: `${n}/${of}` }));
  }

  function render() {
    if (!on) return;
    const a = activeClip();
    const e = entry(a.name);
    const doc = e && e.doc;
    const t = frameTime();
    const kids = [];

    // ---- Header: pass, angle, save state, done ----
    const state = !e ? null : {
      loading: ["Loading…", ""], ready: null, saving: ["Saving…", ""], saved: ["✓ Saved", "ok"], error: ["Not saved", "bad"],
    }[e.state];
    kids.push(el("div", { className: "lp-head" },
      el("strong", { className: "lp-title", textContent: "Labeling" }),
      el("span", { className: "lp-group" }, el("span", { className: "lp-label", textContent: "Pass" }),
        seg([1, 2].map(n => [String(n), labelPass === n, () => setPass(n),
          n === 2 ? "A second pass, days later, without looking at the first: measures your own consistency" : "First pass"]), "Label pass")),
      partner ? el("span", { className: "lp-group" }, el("span", { className: "lp-label" }, "Angle ", kbd("D")),
        seg([["Face-on", active === "main", () => setActive("main")], ["Down the line", active === "dtl", () => setActive("dtl")]], "Angle to label")) : null,
      state ? el("span", { className: "pill lp-save " + state[1], textContent: state[0] }) : null,
      el("span", { className: "grow" }),
      labeledCount != null ? el("span", { className: "lp-label", textContent: `${labeledCount} clip${labeledCount === 1 ? "" : "s"} in pass ${labelPass}` }) : null,
      (() => { const b = el("button", { className: "primary small", title: "Leave labeling (L or Esc)" }, "Done ", kbd("L")); b.onclick = () => setOn(false); return b; })()));

    if (!a.pose) {
      kids.push(el("div", { className: "lp-empty", textContent: "This clip hasn't been analyzed yet. Labels are tied to its analyzed frames, so wait for it (a minute or so)." }));
      panel.replaceChildren(...kids);
      return;
    }
    if (!doc) {
      panel.replaceChildren(...kids);
      return;
    }

    const sugg = suggestions();
    const here = frameIndexAt(a.video.currentTime, a.pose);
    const pts = t == null ? {} : doc.frames[frameKey(t)] || {};
    const moments = EVENTS.filter(([k]) => doc.events[k] != null).length;
    const framesDone = sugg.filter(i => frameDone(doc, a.pose.frames[i].t)).length;
    const pointsHere = POINTS.filter(([k]) => pts[k]).length;

    // ---- Progress for this angle of the swing ----
    kids.push(el("div", { className: "lp-progress" },
      el("span", { className: "lp-angle", textContent: active === "dtl" ? "Down the line" : partner ? "Face-on" : "This clip" }),
      meter("Moments", moments, EVENTS.length),
      meter("Suggested frames", framesDone, sugg.length),
      el("div", { className: "lp-meter" + (doc.ball ? " full" : "") }, el("span", { className: "lp-mlabel", textContent: "Ball" }),
        el("b", { textContent: doc.ball ? "✓" : "–" }))));

    // ---- To fix (from the Labels page's checks) ----
    const fixHere = t == null ? [] : fixesAt(a.name, t);
    const all = swingFixes();
    if (all.length || fixHere.length) {
      const next = all.length ? el("button", { className: "small", title: "The next frame to fix in this swing (N)" }, `Next fix (${all.length}) `, kbd("N")) : null;
      if (next) next.onclick = nextFix;
      kids.push(el("div", { className: "lp-fix" },
        el("span", { className: "lp-fixicon", textContent: "!" }),
        el("div", { className: "lp-fixbody" },
          el("b", { textContent: fixHere.length ? "To fix on this frame" : `${all.length} frame${all.length === 1 ? "" : "s"} to fix in this swing` }),
          ...(fixHere.length ? [...new Map(fixHere.map(f => [f.text, f])).values()].map(f => {
            const row = el("div", { className: "lp-fixtext", textContent: f.text + " " });
            if (f.key) {
              const okBtn = el("button", { className: "small lp-fixok", textContent: "It's correct",
                title: "The label is right: stop flagging this (it comes back if you move this label)" });
              okBtn.onclick = () => acceptFix(a.name, f);
              row.append(okBtn);
            }
            return row;
          }) : [el("div", { className: "lp-fixtext", textContent: "Red rings mark the points to check." })])),
        next));
    }
    const nAccepted = (doc.accepted || []).length;
    if (nAccepted) {
      const back = el("button", { className: "small", textContent: "Bring back" });
      back.onclick = () => unacceptAll(a.name);
      kids.push(el("div", { className: "lp-accepted" },
        el("span", { textContent: `${nAccepted} check${nAccepted === 1 ? "" : "s"} marked correct on this angle` }), back));
    }

    // ---- Moments ----
    const tiles = EVENTS.map(([k, label, key, short]) => {
      const v = doc.events[k];
      const i = v == null ? null : frameIndexAt(v, a.pose);
      const flagged = (fixes.get(a.name) || []).some(f => f.event === k);
      const b = el("button", {
        className: "lp-moment" + (v != null ? " set" : "") + (v != null && v === t ? " here" : "") + (flagged ? " flag" : ""),
        title: `${label} (key ${key}${k === "impact" ? " or I" : ""})` + (v == null ? ": press the key on its frame, or click to mark this frame"
          : ": click to go there; press the key again on that frame to clear") + (flagged ? ". The Labels page says to check this one" : ""),
      }, el("span", { className: "lp-mkey", textContent: key }), el("span", { className: "lp-mname", textContent: short }),
         el("span", { className: "lp-mtime", textContent: v == null ? "not set" : `${v.toFixed(3)} s` }));
      b.onclick = i == null ? () => setEvent(k) : () => showFrame(i);
      return b;
    });
    kids.push(el("div", { className: "lp-section" },
      el("div", { className: "lp-shead" }, el("b", { textContent: "Key moments" }),
        el("span", { className: "lp-label" }, "Go to the frame, then press ", kbd("T"), " ", kbd("2"), "–", kbd("8"), " (", kbd("I"), " = impact)")),
      el("div", { className: "lp-moments" }, ...tiles)));

    // ---- Clubhead motion, for the takeaway ----
    kids.push(motionSection(a, doc, t));

    // ---- Points on this frame ----
    const nextText = ballArmed ? "the ball's middle (at address)" : POINTS[target][1];
    const nextColor = ballArmed ? BALL_COLOR : pointColor(POINTS[target][0]);
    const prompt = el("div", { className: "lp-prompt" },
      el("span", { className: "lp-dot" }), el("span", { textContent: "Click " }), el("b", { textContent: nextText }),
      el("span", { className: "lp-label", textContent: ` · ${pointsHere} of ${POINTS.length} on this frame` }));
    prompt.querySelector(".lp-dot").style.background = nextColor;
    const pointBtn = j => {
      const [k, label, tag] = POINTS[j];
      const q = pts[k];
      const mark = q ? q.hidden ? "✕" : q.blur ? "~" : "✓" : "";
      const b = el("button", { className: "lp-point" + (j === target && !ballArmed ? " on" : "") + (q ? " done" : ""),
        title: label + (q ? q.hidden ? " (can't see it)" : q.blur ? " (a blur)" : "" : "") },
        el("span", { className: "lp-dot" }), el("span", { textContent: tag }), mark ? el("span", { className: "lp-mark", textContent: mark }) : null);
      b.querySelector(".lp-dot").style.background = pointColor(k);
      b.onclick = () => { target = j; ballArmed = false; render(); };
      return b;
    };
    const ball = el("button", { className: "lp-point" + (ballArmed ? " on" : "") + (doc.ball ? " done" : ""),
      title: "B, then click the ball's middle (at address)" }, el("span", { className: "lp-dot" }), el("span", { textContent: "Ball" }),
      doc.ball ? el("span", { className: "lp-mark", textContent: "✓" }) : null);
    ball.querySelector(".lp-dot").style.background = BALL_COLOR;
    ball.onclick = () => { ballArmed = !ballArmed; render(); };
    kids.push(el("div", { className: "lp-section" },
      el("div", { className: "lp-shead" }, el("b", { textContent: "Points on this frame" }),
        el("span", { className: "lp-label" }, kbd("Shift"), "+click = a blur · ", kbd("X"), " can't see it · ", kbd("Tab"), " skip · ", kbd("⌫"), " undo")),
      prompt,
      el("div", { className: "lp-points" },
        ...POINT_GROUPS.map(([name, idx]) => el("div", { className: "lp-pgroup" },
          el("span", { className: "lp-label", textContent: name }), ...idx.map(pointBtn))),
        el("div", { className: "lp-pgroup" }, el("span", { className: "lp-label", textContent: "Ball" }), ball))));

    // ---- Suggested frames ----
    const prevI = [...sugg].reverse().find(i => i < here), nextI = sugg.find(i => i > here);
    const nav = (text, i, title) => { const b = el("button", { className: "small", title }, text); b.disabled = i == null; b.onclick = () => showFrame(i); return b; };
    kids.push(el("div", { className: "lp-section" },
      el("div", { className: "lp-shead" }, el("b", { textContent: "Suggested frames" }),
        el("span", { className: "lp-label", textContent: "About a dozen through the swing, most in the downswing. Green = all points done." })),
      el("div", { className: "lp-frames" },
        nav("‹ ", prevI, "Previous suggested frame ([)"),
        ...sugg.map((i, k) => {
          const b = el("button", { className: "lp-frame" + (i === here ? " on" : "") + (frameDone(doc, a.pose.frames[i].t) ? " done" : ""),
            textContent: String(k + 1), title: `Frame ${i + 1} at ${a.pose.frames[i].t.toFixed(3)} s` });
          b.onclick = () => showFrame(i);
          return b;
        }),
        nav(" ›", nextI, "Next suggested frame (])"))));
    const frames = kids[kids.length - 1].querySelector(".lp-frames");
    frames.firstChild.append(kbd("["));
    frames.lastChild.prepend(kbd("]"));

    if (message) kids.push(el("div", { className: "lp-msg", textContent: message }));

    // ---- Keys and tips, folded ----
    const tips = el("details", { className: "explain lp-tips" },
      el("summary", { textContent: "All keys and labeling tips" }),
      el("dl", { className: "keys" },
        el("dt", {}, kbd("T"), " ", kbd("2"), "–", kbd("8")), el("dd", { textContent: "Mark the moment on this frame (again to clear); 7 or I = impact" }),
        el("dt", {}, kbd("←"), " ", kbd("→")), el("dd", { textContent: "One frame back / on" + (partner ? " (of the angle being labeled)" : "") }),
        el("dt", {}, kbd("["), " ", kbd("]")), el("dd", { textContent: "Previous / next suggested frame" }),
        el("dt", {}, kbd("Tab")), el("dd", { textContent: "Skip to the next point (Shift+Tab back)" }),
        el("dt", {}, kbd("X")), el("dd", { textContent: "Can't see this point" }),
        el("dt", {}, kbd("⌫")), el("dd", { textContent: "Undo the last point" }),
        el("dt", {}, kbd("B")), el("dd", { textContent: "Place the ball" }),
        partner ? el("dt", {}, kbd("D")) : null, partner ? el("dd", { textContent: "Switch angle" }) : null,
        el("dt", {}, kbd("N")), el("dd", { textContent: "Next frame to fix" }),
        el("dt", {}, kbd("J"), " ", kbd("K")), el("dd", { textContent: "Older / newer swing (stays in labeling)" }),
        el("dt", {}, kbd("L"), " ", kbd("Esc")), el("dd", { textContent: "Done" })),
      el("ul", { className: "lp-tipl" },
        el("li", { textContent: "Left and right are the golfer's own: face-on, the golfer's left is on the picture's right." }),
        el("li", { textContent: "Takeaway is the first frame the clubhead leaves the ball (not the hands or a forward press): step until it moves; the Clubhead motion trace shows where it starts to rise. In a blurred frame, put the clubhead in the middle of the streak." }),
        el("li", { textContent: "The tracker's skeleton and numbers are hidden while you label, so they don't sway you; they come back when you're done." })));
    try { tips.open = localStorage.getItem(KEYS_OPEN) === "1"; } catch {}
    tips.addEventListener("toggle", () => { try { localStorage.setItem(KEYS_OPEN, tips.open ? "1" : "0"); } catch {} });
    kids.push(tips);
    panel.replaceChildren(...kids);
  }

  // ---- Clubhead motion (the takeaway) ----
  // How the box round the clubhead at address changes, frame by frame (/api/clubmotion: pose.py
  // clubhead_motion), from 0.65 s before the takeaway the key positions found to 0.35 s after: flat
  // while the club is still, rising as it leaves the ball. It marks the frame on screen and your
  // takeaway label, not a suggestion: step to the frame where the rise starts yourself.
  const motions = new Map();   // `${clip}|${quiet}` -> {state: "loading" | "ready" | "error", data, why}

  /** The detected takeaway in the active clip's time, or null. */
  function detectedTakeaway(a) {
    const tk = positions && positions.takeaway ? positions.takeaway.t : null;
    if (tk == null) return null;
    return a.video === video ? tk : tk + partnerOffset();
  }

  function motionFor(a) {
    const tk = detectedTakeaway(a);
    if (tk == null) return null;
    const quiet = Math.max(0.36, tk - 0.3), until = tk + 0.35;
    const key = `${a.name}|${quiet.toFixed(3)}`;
    let m = motions.get(key);
    if (!m) {
      m = { state: "loading" };
      motions.set(key, m);
      fetch(`/api/clubmotion/${encodeURIComponent(a.name)}?quiet=${quiet.toFixed(3)}&until=${until.toFixed(3)}`)
        .then(async res => res.ok ? res.json() : Promise.reject(new Error((await res.json().catch(() => ({}))).detail || res.statusText)))
        .then(data => { m.state = "ready"; m.data = data; })
        .catch(err => { m.state = "error"; m.why = err.message; })
        .finally(() => render());
    }
    return m;
  }

  function motionSection(a, doc, t) {
    const m = motionFor(a);
    const sec = el("div", { className: "lp-section" },
      el("div", { className: "lp-shead" }, el("b", { textContent: "Clubhead motion" }),
        el("span", { className: "lp-label", textContent: "Takeaway = the first frame of the rise: flat while the clubhead sits behind the ball. Click to go there; the green line is where the camera sees the rise start." })));
    if (!m) { sec.append(el("div", { className: "lp-label", textContent: "No takeaway found in this clip to look around." })); return sec; }
    if (m.state !== "ready") {
      sec.append(el("div", { className: "lp-label", textContent: m.state === "loading" ? "Working out the clubhead's motion (a few seconds)…" : `No trace: ${m.why}` }));
      return sec;
    }
    const canvas = el("canvas", { className: "lp-motion", height: 80 });
    sec.append(canvas);
    requestAnimationFrame(() => drawMotion(canvas, m.data, t, doc.events.takeaway));
    // Where the camera sees the rise start: the takeaway to use when in doubt (it lines the two
    // angles up with the ball within a frame; the pose tracker's shaft rule can be off by a few).
    const onset = m.data.onset;
    if (onset != null) {
      const i = frameIndexAt(onset, a.pose), at = a.pose.frames[i].t, lab = doc.events.takeaway;
      const row = el("div", { className: "lp-onset" });
      const diff = lab == null ? null : Math.round((lab - at) * 1000);
      row.append(el("span", { textContent: `Rise starts at ${at.toFixed(3)} s` + (diff == null ? "" : diff === 0 ? " · your takeaway is on it"
        : ` · your takeaway is ${Math.abs(diff)} ms ${diff > 0 ? "after" : "before"}`) }));
      if (lab !== at) {
        const use = el("button", { className: "small", textContent: "Use it as the takeaway" });
        use.onclick = () => {
          const e = activeDoc();
          if (!e) return;
          showFrame(i);
          e.doc.events.takeaway = at;
          message = `Takeaway at ${at.toFixed(3)} s (where the rise starts).`;
          changed(e);
        };
        row.append(use);
      }
      const go = el("button", { className: "small", textContent: "Go there" });
      go.onclick = () => showFrame(i);
      row.append(go);
      sec.append(row);
    }
    canvas.onclick = ev => {
      const r = canvas.getBoundingClientRect(), d = m.data;
      const at = d.t[0] + (ev.clientX - r.left) / r.width * (d.t[d.t.length - 1] - d.t[0]);
      showFrame(frameIndexAt(at, a.pose));
    };
    return sec;
  }

  function drawMotion(canvas, d, now, label) {
    // The rise's start, green; the label, yellow dashed; the frame on screen, the accent.
    const w = canvas.clientWidth || 300, h = canvas.height;
    canvas.width = w;
    const ctx = canvas.getContext("2d");
    const css = getComputedStyle(document.documentElement);
    const color = name => css.getPropertyValue(name).trim() || "#888";
    const t0 = d.t[0], t1 = d.t[d.t.length - 1];
    const lo = Math.min(...d.v), hi = Math.max(...d.v);
    const x = t => (t - t0) / (t1 - t0) * w, y = v => h - 4 - (v - lo) / Math.max(1e-6, hi - lo) * (h - 8);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = color("--line");
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    ctx.strokeStyle = color("--text");
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    d.t.forEach((t, i) => (i ? ctx.lineTo(x(t), y(d.v[i])) : ctx.moveTo(x(t), y(d.v[i]))));
    ctx.stroke();
    const mark = (t, col, dash) => {
      if (t == null || t < t0 || t > t1) return;
      ctx.strokeStyle = col;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(x(t) + 0.5, 0);
      ctx.lineTo(x(t) + 0.5, h);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    mark(d.onset, "#22c55e", [2, 2]);
    mark(label, CLUB_COLOR, [4, 3]);
    mark(now, color("--accent"), []);
  }

  // ---- Keys and clicks ----

  function stepActive(n) {
    const a = activeClip();
    if (!a.pose) return;
    showFrame(frameIndexAt(a.video.currentTime, a.pose) + n);
  }

  window.addEventListener("keydown", ev => {
    if (ev.target.closest && ev.target.closest("input, select, textarea")) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    const handled = () => { ev.preventDefault(); ev.stopImmediatePropagation(); };
    if (!on) {
      if (k === "l" && current && !viewer.hidden) { handled(); setOn(true); }
      return;
    }
    if (viewer.hidden) { setOn(false); return; }   // Trends or Progress took over the page
    if (k === "l" || k === "Escape") { handled(); setOn(false); return; }
    if ((k === "ArrowLeft" || k === "ArrowRight") && active === "dtl") { handled(); stepActive(k === "ArrowLeft" ? -1 : 1); return; }
    if (EVENT_KEYS[k]) { handled(); setEvent(EVENT_KEYS[k]); return; }
    if (k === "x") { handled(); setPoint({ hidden: true }); return; }
    if (k === "n") { handled(); nextFix(); return; }
    if (k === "Tab") { handled(); target = (target + (ev.shiftKey ? POINTS.length - 1 : 1)) % POINTS.length; render(); return; }
    if (k === "Backspace") { handled(); clearPoint(); return; }
    if (k === "b") { handled(); ballArmed = !ballArmed; render(); return; }
    if (k === "d") { handled(); setActive(active === "dtl" ? "main" : "dtl"); return; }
    if (k === "[" || k === "]") {
      handled();
      const a = activeClip();
      if (!a.pose) return;
      const here = frameIndexAt(a.video.currentTime, a.pose), list = suggestions();
      const to = k === "]" ? list.find(i => i > here) : [...list].reverse().find(i => i < here);
      if (to != null) showFrame(to);
    }
  }, true);

  document.getElementById("overlay").addEventListener("click", ev => onClick(ev, "main"));
  document.getElementById("overlay2").addEventListener("click", ev => onClick(ev, "dtl"));
  button.onclick = () => setOn(!on);

  window.Labels = {
    drawOn,
    /** Labeling mode on, for the swing on screen (the Labels view opens swings this way). */
    start(opts) {
      if (!on) setOn(true);
      if (!opts || opts.t == null) return;
      // The swing was just opened: wait for its analysis (and its other angle's) before going there.
      let tries = 0;
      const go = () => {
        const need = opts.angle === "dtl" ? partner && partner.pose : pose;
        if (need && need.frames && need.frames.length) goTo(opts.angle === "dtl" ? "dtl" : "main", opts.t);
        else if (tries++ < 50) setTimeout(go, 100);
      };
      go();
    },
    /** Another swing was opened: labels follow its clips, starting on the face-on angle. */
    opened() { active = "main"; lastFrameKey = null; ballArmed = false; message = ""; render(); },
  };
})();
