(function (root) {
  const Summary = root.SwingSummary || (typeof require !== "undefined" && require("./summary.js"));
  const Faults = root.SwingFaults || (typeof require !== "undefined" && require("./faults.js"));
  const GoodShots = root.SwingGoodShots || (typeof require !== "undefined" && require("./goodshots.js"));
  const Trust = root.SwingTrust || (typeof require !== "undefined" && require("./trust.js"));

  const PHASE_NAMES = {
    p1: "Address",
    takeaway: "Takeaway",
    p2: "Halfway Back",
    p3: "Lead Arm Parallel",
    p4: "Top",
    p5: "Halfway Down",
    p6: "Delivery",
    p7: "Impact",
    p8: "Finish"
  };

  const PHASE_METRICS = {
    p1: ["tempo"],
    takeaway: ["backswing"],
    p4: ["shoulderTop", "pelvisTop", "handsPlaneTop", "handDepthTop", "handHeightTop", "xFactor"],
    p5: ["lagP5"],
    p6: ["handsPlaneP6", "shaftPlaneP6", "releaseArm"],
    p7: ["earlyExt", "hipSway", "bendLoss", "spineTiltImpact", "headToBall", "headRise", "headSway"]
  };

  function faultSeverity(faultDef, value) {
    const diff = Math.abs(value - faultDef.threshold);
    const scale = Math.abs(faultDef.threshold) || 10;
    if (diff > scale) return 3;
    if (diff > scale * 0.5) return 2;
    return 1;
  }

  function getFaultPhrase(key) {
    const map = {
      earlyExt: "your hips moving toward the ball",
      bendLoss: "standing up",
      handsPlaneP6: "coming over the top",
      headToBall: "your head moving toward the ball",
      hipSway: "your hips sliding",
      headRise: "your head moving up or down",
      releaseArm: "casting the club",
      lagP5: "casting"
    };
    return map[key] || "an issue";
  }

  function getGoodPhrase(key) {
    const map = {
      tempo: "a good tempo",
      backswing: "a nice backswing pace",
      shoulderTop: "a strong shoulder turn",
      pelvisTop: "a solid hip turn",
      xFactor: "a good coil",
      lagP5: "holding your lag well",
      hipSway: "a steady lower body",
      spineTiltImpact: "good posture at impact",
      earlyExt: "keeping your hips back"
    };
    return map[key] || "solid numbers";
  }

  /**
   * Builds the scorecard data for the UI.
   * @param swingData {record, light, club, positions}
   * @param goodRanges {ranges} from SwingGoodShots
   * @param noiseTable table from SwingTrust
   */
  function buildScorecard(swingData, goodRanges, noiseTable) {
    const phases = [];
    const hasTakeaway = swingData.positions.takeaway != null;
    const posKeys = ["p1"].concat(hasTakeaway ? ["takeaway"] : []).concat(["p2", "p3", "p4", "p5", "p6", "p7", "p8"]);

    const facts = Trust.factsOf(swingData.record, swingData.light);
    const body = swingData.record.body || {};

    let nInside = 0;
    let nTotal = 0;

    for (const pk of posKeys) {
      let posT = null;
      let posIndex = null;
      if (pk === "takeaway") {
        posT = swingData.positions.takeaway.t;
      } else {
        const p = swingData.positions.find(q => q.key === pk);
        if (!p) continue;
        posT = p.t;
        posIndex = p.index;
      }

      const metrics = PHASE_METRICS[pk] || [];
      const metricDetails = [];
      let phaseColor = 'grey'; // worst color
      let hasGreen = false;
      let hasAmber = false;
      let hasRed = false;
      let hasGrey = true;

      for (const mk of metrics) {
        const val = body[mk];
        const f = Summary.BODY.find(b => b.key === mk);
        if (!f) continue;
        const j = Trust.judge(f, facts, val, noiseTable, f.unit);
        let color = 'grey';
        let goodStatus = null;

        if (j.level === 'ok') {
          hasGrey = false;
          const range = goodRanges && goodRanges[mk];
          const place = GoodShots.place(val, range, f.unit);
          goodStatus = place;

          if (place.status === 'in') {
            color = 'green';
            hasGreen = true;
            nInside++;
          } else if (place.wide && (place.status === 'above' || place.status === 'below')) {
            color = 'amber';
            hasAmber = true;
          } else if (place.status === 'above' || place.status === 'below') {
            color = 'red';
            hasRed = true;
          } else {
            color = 'grey';
          }

          if (place.status !== 'few' && place.status !== 'none') {
            nTotal++;
          }
        }

        metricDetails.push({
          key: mk,
          label: f.label,
          value: val,
          unit: f.unit,
          trust: j,
          goodStatus: goodStatus,
          range: goodRanges ? goodRanges[mk] : null,
          color: color
        });
      }

      if (hasRed) phaseColor = 'red';
      else if (hasAmber) phaseColor = 'amber';
      else if (hasGreen) phaseColor = 'green';
      else if (metrics.length === 0) phaseColor = 'none';

      phases.push({
        key: pk,
        name: PHASE_NAMES[pk],
        t: posT,
        index: posIndex,
        color: phaseColor,
        metrics: metricDetails
      });
    }

    const swingFaults = Faults.faultsOf(swingData.record, (row, key) => {
      const f = Summary.BODY.find(b => b.key === key);
      const j = Trust.judge(f, facts, row.shown ? row.shown[key] : row[key], noiseTable, f.unit);
      return j.level === 'shaky';
    });

    const faultPhaseMap = {};
    for (const pm in PHASE_METRICS) {
      for (const m of PHASE_METRICS[pm]) {
        faultPhaseMap[m] = pm;
      }
    }

    const faultsByPhase = swingFaults.map(sf => {
      const fDef = Faults.FAULTS.find(f => f.key === sf.key);
      const phase = faultPhaseMap[sf.key] || 'p7';
      const severity = faultSeverity(fDef, sf.value);
      return {
        ...sf,
        phase: phase,
        phaseName: PHASE_NAMES[phase],
        severity: severity
      };
    }).sort((a, b) => b.severity - a.severity);

    let summarySentence = "";
    let bestMetric = null;
    
    // Find the best metric to praise
    for (const ph of phases) {
      for (const m of ph.metrics) {
        if (m.color === 'green') {
          bestMetric = m.key;
          break;
        }
      }
      if (bestMetric) break;
    }

    const topFault = faultsByPhase.length > 0 ? faultsByPhase[0] : null;

    if (bestMetric && topFault) {
      summarySentence = `${getGoodPhrase(bestMetric).charAt(0).toUpperCase() + getGoodPhrase(bestMetric).slice(1)}; the main thing is ${getFaultPhrase(topFault.key)}.`;
    } else if (bestMetric) {
      summarySentence = `${getGoodPhrase(bestMetric).charAt(0).toUpperCase() + getGoodPhrase(bestMetric).slice(1)}; a very solid swing.`;
    } else if (topFault) {
      summarySentence = `The main thing to work on is ${getFaultPhrase(topFault.key)}.`;
    } else if (nTotal > 0) {
      summarySentence = `A consistent swing overall.`;
    } else {
      summarySentence = `Not enough good shots yet to show a trend.`;
    }

    return {
      phases: phases.filter(p => p.color !== 'none'), // exclude phases with no mapped metrics or if desired we can keep them
      faults: faultsByPhase,
      summarySentence: summarySentence,
      nInside: nInside,
      nTotal: nTotal
    };
  }

  const api = { buildScorecard, PHASE_NAMES, PHASE_METRICS, faultSeverity };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SwingScorecard = api;
})(typeof window !== "undefined" ? window : globalThis);
