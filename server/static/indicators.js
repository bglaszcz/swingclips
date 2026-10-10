// server/static/indicators.js
// Indicator tiles: one small tile per number, used on Analysis and under the video.
(function (root) {
  "use strict";

  const finite = v => typeof v === "number" && Number.isFinite(v);

  const STORAGE_KEY = "indicator-favs";
  const DEFAULT_FAVS = ["handsAhead", "hipSway", "earlyExt", "tempo"];
  const MAX_FAVS = 8;

  const MOMENTS = {
    rhythm: { id: "rhythm", tag: "RHYTHM", name: "Rhythm" },
    top: { id: "top", tag: "TOP", name: "Top of the swing" },
    downswing: { id: "downswing", tag: "DOWNSWING", name: "Downswing" },
    impact: { id: "impact", tag: "IMPACT", name: "Impact" },
  };
  // Aliases for pos codes
  MOMENTS.p4 = MOMENTS.top;
  MOMENTS.p5 = MOMENTS.downswing;
  MOMENTS.p6 = MOMENTS.downswing;
  MOMENTS.p7 = MOMENTS.impact;
  MOMENTS[""] = MOMENTS.rhythm;

  function moment(fieldOrPos) {
    if (!fieldOrPos) return MOMENTS.rhythm;
    const pos = typeof fieldOrPos === "string" ? fieldOrPos : fieldOrPos.pos;
    if (pos === "p4") return MOMENTS.top;
    if (pos === "p5" || pos === "p6") return MOMENTS.downswing;
    if (pos === "p7") return MOMENTS.impact;
    return MOMENTS.rhythm;
  }

  function isUsableRange(range) {
    return !!(range && range.enough && range.reliable !== false &&
      finite(range.q25) && finite(range.q75) &&
      finite(range.q10) && finite(range.q90) &&
      range.q75 >= range.q25 && range.q90 >= range.q10);
  }

  /**
   * Zone: "in" (q25..q75), "near" (q10..q90), "out", or null without a usable range / value.
   */
  function zone(value, range) {
    if (!finite(value) || !isUsableRange(range)) return null;
    if (value >= range.q25 && value <= range.q75) return "in";
    if (value >= range.q10 && value <= range.q90) return "near";
    return "out";
  }

  /**
   * Side: "low" (< q25), "high" (> q75), or null (inside q25..q75 or no range).
   */
  function side(value, range) {
    if (!finite(value) || !isUsableRange(range)) return null;
    if (value < range.q25) return "low";
    if (value > range.q75) return "high";
    return null;
  }

  /**
   * Read favorites from localStorage (or passed storage), capped at 8.
   */
  function favs(storage) {
    const st = storage !== undefined ? storage : (typeof localStorage !== "undefined" ? localStorage : null);
    if (!st) return [...DEFAULT_FAVS];
    try {
      const raw = typeof st.getItem === "function" ? st.getItem(STORAGE_KEY) : st[STORAGE_KEY];
      if (!raw) return [...DEFAULT_FAVS];
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.filter(x => typeof x === "string").slice(0, MAX_FAVS);
      }
    } catch {}
    return [...DEFAULT_FAVS];
  }

  /**
   * Toggle a favorite in storage, respecting the 8 cap.
   */
  function toggleFav(key, storage) {
    if (!key) return favs(storage);
    const current = favs(storage);
    const idx = current.indexOf(key);
    let next;
    if (idx >= 0) {
      next = current.filter(k => k !== key);
    } else {
      if (current.length >= MAX_FAVS) return current;
      next = [...current, key];
    }
    const st = storage !== undefined ? storage : (typeof localStorage !== "undefined" ? localStorage : null);
    if (st) {
      try {
        const val = JSON.stringify(next);
        if (typeof st.setItem === "function") st.setItem(STORAGE_KEY, val);
        else st[STORAGE_KEY] = val;
      } catch {}
    }
    return next;
  }

  function defaultFmt(field, v) {
    if (!finite(v)) return "–";
    const dec = (field && field.dec != null) ? field.dec : (Math.abs(v) < 10 ? 1 : 0);
    const unit = (field && field.unit) ? field.unit : "";
    return `${v.toFixed(dec)}${unit ? (unit === "°" || unit === "%" ? "" : " ") + unit : ""}`;
  }

  /**
   * Create an indicator tile element.
   * @param item { key, field, value, range, shaky }
   * @param opts { fmt, fav, onFav, onTap, document }
   */
  function tile(item, opts) {
    opts = opts || {};
    const doc = opts.document || (typeof document !== "undefined" ? document : null);
    if (!doc) throw new Error("SwingIndicators.tile requires a document");

    const key = item.key || (item.field && item.field.key) || "";
    const field = item.field || { key, label: key };
    const val = item.value;
    const range = item.range;
    const z = zone(val, range);
    const s = side(val, range);
    const m = moment(field);
    const fmt = opts.fmt || (v => defaultFmt(field, v));

    const btn = doc.createElement("button");
    btn.className = `in-tile${z ? ` in-zone-${z}` : " in-zone-none"}${opts.fav ? " is-fav" : ""}`;
    btn.type = "button";
    btn.dataset.key = key;
    if (z) btn.dataset.zone = z;

    // 1. Header: moment tag + favorite star
    const head = doc.createElement("div");
    head.className = "in-head";

    const tagEl = doc.createElement("span");
    tagEl.className = "in-moment";
    tagEl.textContent = m.tag;
    head.appendChild(tagEl);

    if (opts.fav !== undefined || typeof opts.onFav === "function") {
      const star = doc.createElement("span");
      star.className = `in-star${opts.fav ? " on" : ""}`;
      star.textContent = opts.fav ? "★" : "☆";
      star.title = opts.fav ? "Remove from favorites" : "Add to favorites";
      star.onclick = e => {
        e.stopPropagation();
        if (typeof opts.onFav === "function") opts.onFav(key);
      };
      head.appendChild(star);
    }
    btn.appendChild(head);

    // 2. Label (two lines at most)
    const labelEl = doc.createElement("div");
    labelEl.className = "in-label";
    labelEl.textContent = field.label || key;
    labelEl.title = field.label || key;
    btn.appendChild(labelEl);

    // 3. Value big
    const valRow = doc.createElement("div");
    valRow.className = "in-val-row";

    const valEl = doc.createElement("div");
    valEl.className = `in-val in-val-${z || "none"}`;
    valEl.textContent = finite(val) ? fmt(val) : "–";

    if (z === "in") valEl.style.color = "var(--accent)";
    else if (z === "near") valEl.style.color = "var(--warn)";
    else if (z === "out") valEl.style.color = "var(--bad)";
    else valEl.style.color = "var(--text)";

    valRow.appendChild(valEl);

    if (item.shaky) {
      const shakyEl = doc.createElement("span");
      shakyEl.className = "in-shaky";
      shakyEl.textContent = " ~";
      shakyEl.title = "Tracking noise or conditions could account for this number";
      valRow.appendChild(shakyEl);
    }
    btn.appendChild(valRow);

    // 4. Verbal state under value
    let stateText = "no range yet";
    if (z === "in") stateText = "in range";
    else if (z === "near") stateText = s === "low" ? "a little low" : (s === "high" ? "a little high" : "near range");
    else if (z === "out") stateText = s === "low" ? "low" : (s === "high" ? "high" : "out of range");

    const stateEl = doc.createElement("div");
    stateEl.className = `in-state in-state-${z || "none"}`;
    stateEl.textContent = stateText;
    btn.appendChild(stateEl);

    // 5. Track: q10..q90 span faint, q25..q75 solid, middle-half ends labelled, marker at value
    const trackSvg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    trackSvg.setAttribute("class", "in-track");
    trackSvg.setAttribute("viewBox", "0 0 140 26");
    trackSvg.setAttribute("role", "img");
    trackSvg.setAttribute("aria-hidden", "true");

    const xL = 14, xR = 126, wTrack = xR - xL;
    const yBar = 8, hBar = 4;

    if (isUsableRange(range)) {
      const q10 = range.q10, q25 = range.q25, q75 = range.q75, q90 = range.q90;
      const span = q90 > q10 ? (q90 - q10) : 1;
      const toX = v => xL + Math.max(0, Math.min(1, (v - q10) / span)) * wTrack;

      // Faint span q10..q90
      const faintRect = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
      faintRect.setAttribute("x", String(xL));
      faintRect.setAttribute("y", String(yBar));
      faintRect.setAttribute("width", String(wTrack));
      faintRect.setAttribute("height", String(hBar));
      faintRect.setAttribute("rx", "2");
      faintRect.setAttribute("fill", "var(--line-strong)");
      faintRect.setAttribute("opacity", "0.4");
      trackSvg.appendChild(faintRect);

      // Solid span q25..q75
      const x25 = toX(q25), x75 = toX(q75);
      const solidRect = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
      solidRect.setAttribute("x", String(x25));
      solidRect.setAttribute("y", String(yBar - 1));
      solidRect.setAttribute("width", String(Math.max(2, x75 - x25)));
      solidRect.setAttribute("height", String(hBar + 2));
      solidRect.setAttribute("rx", "2");
      solidRect.setAttribute("fill", "var(--text)");
      solidRect.setAttribute("opacity", "0.25");
      trackSvg.appendChild(solidRect);

      // Middle-half ends labels
      const txt25 = doc.createElementNS("http://www.w3.org/2000/svg", "text");
      txt25.setAttribute("x", String(x25));
      txt25.setAttribute("y", "23");
      txt25.setAttribute("font-size", "9");
      txt25.setAttribute("fill", "var(--muted)");
      txt25.setAttribute("text-anchor", x25 < 35 ? "start" : "middle");
      txt25.textContent = fmt(q25);
      trackSvg.appendChild(txt25);

      const txt75 = doc.createElementNS("http://www.w3.org/2000/svg", "text");
      txt75.setAttribute("x", String(x75));
      txt75.setAttribute("y", "23");
      txt75.setAttribute("font-size", "9");
      txt75.setAttribute("fill", "var(--muted)");
      txt75.setAttribute("text-anchor", x75 > 105 ? "end" : "middle");
      txt75.textContent = fmt(q75);
      trackSvg.appendChild(txt75);

      // Marker for value
      if (finite(val)) {
        const markerColor = z === "in" ? "var(--accent)" : (z === "near" ? "var(--warn)" : "var(--bad)");
        if (val < q10) {
          // Clamped to left end with small arrow pointing left
          const arrow = doc.createElementNS("http://www.w3.org/2000/svg", "path");
          arrow.setAttribute("d", `M ${xL} 10 L ${xL + 6} 6 L ${xL + 6} 14 Z`);
          arrow.setAttribute("fill", markerColor);
          trackSvg.appendChild(arrow);
        } else if (val > q90) {
          // Clamped to right end with small arrow pointing right
          const arrow = doc.createElementNS("http://www.w3.org/2000/svg", "path");
          arrow.setAttribute("d", `M ${xR} 10 L ${xR - 6} 6 L ${xR - 6} 14 Z`);
          arrow.setAttribute("fill", markerColor);
          trackSvg.appendChild(arrow);
        } else {
          // Inside q10..q90
          const xVal = toX(val);
          const circle = doc.createElementNS("http://www.w3.org/2000/svg", "circle");
          circle.setAttribute("cx", String(xVal));
          circle.setAttribute("cy", "10");
          circle.setAttribute("r", "4.5");
          circle.setAttribute("fill", markerColor);
          circle.setAttribute("stroke", "var(--panel)");
          circle.setAttribute("stroke-width", "1.5");
          trackSvg.appendChild(circle);
        }
      }
    } else {
      // Neutral track when no range
      const baseLine = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
      baseLine.setAttribute("x", String(xL));
      baseLine.setAttribute("y", String(yBar));
      baseLine.setAttribute("width", String(wTrack));
      baseLine.setAttribute("height", String(hBar));
      baseLine.setAttribute("rx", "2");
      baseLine.setAttribute("fill", "var(--line)");
      trackSvg.appendChild(baseLine);
    }
    btn.appendChild(trackSvg);

    // Tap action
    btn.onclick = () => {
      if (typeof opts.onTap === "function") opts.onTap(key);
    };

    return btn;
  }

  const api = {
    MOMENTS,
    DEFAULT_FAVS,
    MAX_FAVS,
    moment,
    isUsableRange,
    zone,
    side,
    favs,
    toggleFav,
    tile,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingIndicators = api;
})(typeof window !== "undefined" ? window : globalThis);
