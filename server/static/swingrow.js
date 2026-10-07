// Helper functions for swing rows and good-shot data.
// Used by both the review page (trends.js) and the bay Start page (start.html).
//
// Works in the browser (window.SwingRow) and in Node (module.exports).
(function (root) {
  const Summary = root.SwingSummary || (typeof require !== "undefined" && require("./summary.js"));
  const Trust = root.SwingTrust || (typeof require !== "undefined" && require("./trust.js"));
  const Faults = root.SwingFaults || (typeof require !== "undefined" && require("./faults.js"));
  const Scorecard = root.SwingScorecard || (typeof require !== "undefined" && require("./scorecard.js"));
  const GoodShots = root.SwingGoodShots || (typeof require !== "undefined" && require("./goodshots.js"));

  function getClip(name, clipsMapOrList) {
    if (!name || !clipsMapOrList) return null;
    if (typeof clipsMapOrList === "function") return clipsMapOrList(name);
    if (typeof clipsMapOrList.get === "function") return clipsMapOrList.get(name);
    if (Array.isArray(clipsMapOrList)) return clipsMapOrList.find(x => x.name === name) || null;
    return clipsMapOrList[name] || null;
  }

  /** Each camera's light check for clip c: {face, dtl}. */
  function lightOf(c, clipsMapOrList) {
    if (!c) return { face: null, dtl: null };
    const partnerClip = c.partner ? getClip(c.partner, clipsMapOrList) : null;
    if (c.angle === "dtl") return { face: null, dtl: c.quality || null };
    return { face: c.quality || null, dtl: (partnerClip && partnerClip.quality) || null };
  }

  /**
   * A listed swing as a row: its launch monitor numbers and its body numbers (null until worked out).
   * r[key] is the body number as charts and faults use it: null with no reading (trust.js),
   * and also when shaky with leaveOutShaky on. r.shown has every number with a reading, r.trust
   * each one's judgement; r.unseen the cameras that couldn't see the golfer.
   */
  function row(c, records, clipsMapOrList, noiseTable, leaveOutShaky) {
    const rec = (records && records[c.name]) || null;
    const light = lightOf(c, clipsMapOrList);
    const trust = rec && rec.body && Trust ? Trust.forSwing(rec, light, noiseTable) : null;
    let body = null, shown = null;
    if (trust && Summary && Summary.BODY) {
      body = {};
      shown = {};
      for (const f of Summary.BODY) {
        const j = trust[f.key], v = rec.body[f.key];
        shown[f.key] = j && j.level === "none" ? null : v;
        body[f.key] = j && (j.level === "none" || (leaveOutShaky && j.level === "shaky")) ? null : v;
      }
    }
    const bad = cam => ((rec && rec.quality && rec.quality.camera && rec.quality.camera[cam]) || [])
      .some(code => Trust && Trust.BAD_CAMERA && Trust.BAD_CAMERA.includes(code));
    const unseen = ["face", "dtl"].filter(bad);
    const shotNums = c.shot && Summary && Summary.shotNumbers ? Summary.shotNumbers(c.shot) : {};
    return {
      c,
      name: c.name,
      t: new Date(c.recorded).getTime(),
      club: c.shot ? c.shot.club : null,
      rec,
      body,
      shown,
      trust,
      unseen,
      body3d: (rec && rec.body3d) || null,
      ...shotNums,
      ...(body || {})
    };
  }

  /** Whether row r's number for field f is shaky (a body number, trust.js). */
  function isShaky(r, f) {
    const k = typeof f === "string" ? f : f?.key;
    return !!(r && r.trust && r.trust[k] && r.trust[k].level === "shaky");
  }

  /**
   * Builds coachBody for SwingShotStory.card: body, trust, ranges and ranked faults.
   */
  function coachBody(r, ranges) {
    if (!r || !r.rec || !r.rec.body || !Faults) return null;
    const faults = Faults.faultsOf(r, (rowObj, key) => isShaky(rowObj, key));
    const severity = f => {
      if (!Scorecard || !Scorecard.faultSeverity || !Faults.FAULTS) return 0;
      const def = Faults.FAULTS.find(d => d.key === f.key && d.name === f.name);
      return Scorecard.faultSeverity(def, f.value);
    };
    const ranked = [...faults].sort((a, b) => severity(b) - severity(a));
    return {
      body: r.body,
      trust: r.trust,
      ranges: ranges || {},
      faults: ranked
    };
  }

  /** Builds good-shot data (SwingGoodShots.build) from clips and swing records. */
  function goodShotData(clips, records, settings, noiseTable, clipsMapOrList) {
    if (!GoodShots || !GoodShots.build) return null;
    const swings = (clips || []).map(c => ({
      name: c.name,
      t: new Date(c.recorded).getTime() / 1000,
      club: c.shot ? c.shot.club : null,
      excluded: c.excluded,
      shot: c.shot,
      record: (records && records[c.name]) || null,
      light: lightOf(c, clipsMapOrList || clips)
    }));
    return GoodShots.build(swings, settings, noiseTable);
  }

  const SESSION_GAP_MS = 45 * 60 * 1000;

  /** Newest-first clips -> newest-first sessions, each with its clips newest first. */
  function sessionsOf(list) {
    const out = [];
    for (const c of list || []) {
      const t = new Date(c.recorded).getTime();
      const s = out[out.length - 1];
      if (s && s.start - t < SESSION_GAP_MS) { s.clips.push(c); s.start = t; }
      else out.push({ clips: [c], start: t, end: t });
    }
    for (const s of out) s.key = s.clips[s.clips.length - 1].name;
    return out;
  }

  const api = { row, isShaky, coachBody, goodShotData, lightOf, sessionsOf, SESSION_GAP_MS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingRow = api;
})(typeof window !== "undefined" ? window : globalThis);
