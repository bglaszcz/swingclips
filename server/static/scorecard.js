(function (root) {
  const Summary = root.SwingSummary || (typeof require !== "undefined" && require("./summary.js"));
  const Faults = root.SwingFaults || (typeof require !== "undefined" && require("./faults.js"));
  const FaultLinks = root.SwingFaultLinks || (typeof require !== "undefined" && require("./faultlinks.js"));
  const GoodShots = root.SwingGoodShots || (typeof require !== "undefined" && require("./goodshots.js"));
  const ShotStory = root.SwingShotStory || (typeof require !== "undefined" && require("./shotstory.js"));

  const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
  const PHASE_NAMES = {};
  if (ShotStory && ShotStory.PHASES) {
    for (const [k, v] of Object.entries(ShotStory.PHASES)) {
      PHASE_NAMES[k] = cap(v);
    }
  } else {
    Object.assign(PHASE_NAMES, {
      p1: "Setup",
      takeaway: "Takeaway",
      p2: "Early backswing",
      p3: "Backswing",
      p4: "Top of swing",
      p5: "Early downswing",
      p6: "Downswing",
      p7: "Impact",
      p8: "Follow-through"
    });
  }

  function faultSeverity(faultDef, value) {
    if (!faultDef || typeof faultDef.threshold !== 'number') return 1;
    const diff = Math.abs(value - faultDef.threshold);
    const scale = Math.abs(faultDef.threshold) || 10;
    if (diff > scale) return 3;
    if (diff > scale * 0.5) return 2;
    return 1;
  }

  /**
   * Builds the scorecard data for the UI.
   * @param positions from swing data
   * @param body map of metrics to values (null if trust is none)
   * @param trust map of metrics to trust objects
   * @param goodRanges map of metrics to good ranges
   * @param swingFaults array of faults from SwingFaults.faultsOf
   */
  function buildScorecard(positions, body, trust, goodRanges, swingFaults, strongLinks) {
    const phases = [];
    
    let nInside = 0;
    let nTotal = 0;
    let bestMetric = null;

    // Figure out which metrics go to which phase
    const phaseMetrics = {};
    for (const b of Summary.BODY) {
      if (b.key === 'tempo' || b.key === 'backswing' || b.key === 'downswing') continue;
      let p = b.pos;
      if (b.key === 'releaseArm') p = 'p6';
      if (!p) continue;
      if (!phaseMetrics[p]) phaseMetrics[p] = [];
      phaseMetrics[p].push(b);
    }

    // Build each phase tile
    for (const pos of positions) {
      const pk = pos.key;
      const metricsList = phaseMetrics[pk] || [];
      const metricDetails = [];
      
      let phaseColor = 'grey'; // defaults to grey if no metrics or all grey
      let hasGreen = false;
      let hasAmber = false;
      let hasRed = false;

      for (const f of metricsList) {
        const val = body[f.key];
        const t = trust[f.key];
        let color = 'grey';
        let goodStatus = null;

        if (val !== null && val !== undefined && t && t.level !== 'none') {
          const range = goodRanges && goodRanges[f.key];
          const place = GoodShots.place(val, range, f.unit);
          goodStatus = place;

          const metricLabel = (ShotStory && ShotStory.LABELS && ShotStory.LABELS[f.key]) || f.label;
          if (t.level === 'shaky') {
            color = 'grey';
          } else if (place.status === 'in') {
            color = 'green';
            hasGreen = true;
            nInside++;
            if (!bestMetric) bestMetric = { ...f, label: metricLabel };
          } else if (place.wide && (place.status === 'above' || place.status === 'below')) {
            color = 'amber';
            hasAmber = true;
          } else if (place.status === 'above' || place.status === 'below') {
            color = 'red';
            hasRed = true;
          } else {
            color = 'grey'; // e.g. "few" or "none"
          }

          if (place.status !== 'few' && place.status !== 'none' && t.level !== 'shaky') {
            nTotal++;
          }
        }

        const metricLabel = (ShotStory && ShotStory.LABELS && ShotStory.LABELS[f.key]) || f.label;
        metricDetails.push({
          key: f.key,
          label: metricLabel,
          value: val,
          unit: f.unit,
          trust: t,
          goodStatus: goodStatus,
          range: goodRanges ? goodRanges[f.key] : null,
          color: color
        });
      }

      if (hasRed) phaseColor = 'red';
      else if (hasAmber) phaseColor = 'amber';
      else if (hasGreen) phaseColor = 'green';

      phases.push({
        key: pk,
        name: PHASE_NAMES[pk] || pk,
        t: pos.t,
        index: pos.index,
        color: phaseColor,
        metrics: metricDetails
      });
    }

    // Map faults to phases and severity
    const faultsByPhase = swingFaults.map(sf => {
      let phase = 'p7';
      const fDef = Faults.FAULTS.find(f => f.key === sf.key);
      if (fDef) {
        const sm = Summary.BODY.find(b => b.key === sf.key);
        if (sm && sm.pos) phase = sm.pos;
        if (sf.key === 'releaseArm') phase = 'p6';
      }
      const linkNote = (strongLinks && FaultLinks && typeof FaultLinks.scorecardNote === "function")
        ? FaultLinks.scorecardNote(sf, strongLinks, swingFaults)
        : null;
      return {
        ...sf,
        phase: phase,
        phaseName: PHASE_NAMES[phase] || phase,
        severity: faultSeverity(fDef, sf.value),
        linkNote: linkNote
      };
    }).sort((a, b) => b.severity - a.severity);

    // Summary sentence
    let summarySentence = "";
    const topFault = faultsByPhase.length > 0 ? faultsByPhase[0] : null;

    // The label keeps its capitals (P5, X-factor): only the first letter is lowered.
    const best = bestMetric ? bestMetric.label[0].toLowerCase() + bestMetric.label.slice(1) : "";
    if (bestMetric && topFault) {
      summarySentence = `Best: ${best} is in your good range. Main thing: ${topFault.name}.`;
    } else if (bestMetric) {
      // "Solid" only when most of the readable numbers are inside the golfer's range.
      summarySentence = `Best: ${best} is in your good range.` + (nTotal > 0 && nInside / nTotal >= 0.8 ? " A very solid swing." : "");
    } else if (topFault) {
      summarySentence = `Main thing: ${topFault.name}.`;
    } else if (nTotal > 0) {
      summarySentence = `A consistent swing overall.`;
    } else {
      summarySentence = `Not enough good shots yet to show a trend.`;
    }

    return {
      phases,
      faults: faultsByPhase,
      summarySentence,
      nInside,
      nTotal
    };
  }

  const api = { buildScorecard, PHASE_NAMES, faultSeverity };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingScorecard = api;
})(typeof window !== "undefined" ? window : globalThis);
