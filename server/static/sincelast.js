// Since last time helper: morning check summary of the last ended session
// and the night after it.
//
// Works in the browser (window.SwingSinceLast) and in Node (module.exports).
(function (root) {
  const SESSION_GAP_MS = 45 * 60 * 1000;
  const SESSION_END_MIN_GAP_MS = 30 * 60 * 1000;

  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function parseTime(v) {
    if (v == null) return null;
    if (typeof v === "number") return v < 1e11 ? v * 1000 : v;
    if (v instanceof Date) return v.getTime();
    if (typeof v === "string") {
      const t = Date.parse(v);
      return isNaN(t) ? null : t;
    }
    return null;
  }

  function clipTime(c) {
    if (!c) return 0;
    return parseTime(c.recorded) || parseTime(c._t) || 0;
  }

  function formatDate(t) {
    let d;
    if (typeof t === "string" && /^\d{4}-\d{2}-\d{2}/.test(t)) {
      const parts = t.slice(0, 10).split("-").map(Number);
      d = new Date(parts[0], parts[1] - 1, parts[2], 12);
    } else {
      d = new Date(t);
    }
    if (isNaN(d.getTime())) return "";
    return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  }

  /**
   * Groups clips into sessions (45-min gap), sorted chronologically.
   */
  function sessionsOf(clips) {
    if (!Array.isArray(clips) || !clips.length) return [];
    const valid = clips.filter(c => !c.excluded);
    if (!valid.length) return [];

    const sorted = [...valid].sort((a, b) => clipTime(a) - clipTime(b));

    const sessions = [];
    let cur = null;

    for (const c of sorted) {
      const t = clipTime(c);
      if (cur && t - cur.end < SESSION_GAP_MS) {
        cur.clips.push(c);
        cur.end = Math.max(cur.end, t);
      } else {
        cur = {
          start: t,
          end: t,
          clips: [c]
        };
        sessions.push(cur);
      }
    }

    for (const s of sessions) {
      s.swings = s.clips.filter(c => !(c.partner && c.angle !== "face"));
    }

    return sessions;
  }

  function parseNow(now) {
    if (now == null) return Date.now();
    if (now instanceof Date) return now.getTime();
    if (typeof now === "string") {
      const t = Date.parse(now);
      return isNaN(t) ? Date.now() : t;
    }
    if (typeof now === "number") {
      return now < 1e11 ? now * 1000 : now;
    }
    return Date.now();
  }

  /**
   * Generates morning-check summary of the last session and the night after it.
   *
   * @param {Object} inputs {clips, events, calib, night, improve, next}
   * @param {Date|number|string} [now] Current reference time (defaults to Date.now())
   * @returns {{ lines: Array<{kind: 'ok'|'warn'|'info', text: string, todo?: string, link?: string}>, headline: string }}
   */
  function summary(inputs, now) {
    inputs = inputs || {};
    const clips = inputs.clips || [];
    const events = inputs.events || [];
    const calib = inputs.calib || null;
    const improve = inputs.improve || null;
    const next = inputs.next || null;
    const nowMs = parseNow(now);

    const sessions = sessionsOf(clips);
    // Find the newest session before now that has ended (no clip in last 30 min)
    const ended = sessions.filter(s => s.swings.length > 0 && (nowMs - s.end) >= SESSION_END_MIN_GAP_MS);

    if (!ended.length) {
      return {
        headline: "No past sessions yet.",
        lines: []
      };
    }

    // Newest ended session
    ended.sort((a, b) => b.end - a.end);
    const session = ended[0];
    const total = session.swings.length;
    const lines = [];

    // 1. Angles: both angles vs one-angle swings
    let both = 0;
    let faceMisses = 0;
    let dtlMisses = 0;

    for (const c of session.swings) {
      if (c.partner) {
        both++;
      } else {
        if (c.angle === "dtl") {
          faceMisses++;
        } else {
          dtlMisses++;
        }
      }
    }

    const oneAngle = total - both;
    const oneAngleRate = total > 0 ? oneAngle / total : 0;

    if (oneAngleRate < 0.03) {
      const text = both === total
        ? `All ${total} swings had both angles`
        : `${both} of ${total} swings had both angles`;
      lines.push({ kind: "ok", text });
    } else {
      if (faceMisses > 0) {
        lines.push({
          kind: "warn",
          text: `Face-on missed ${faceMisses} of ${total} swings`,
          todo: "Check the face-on phone: app open, on the charger, mic not covered"
        });
      }
      if (dtlMisses > 0) {
        lines.push({
          kind: "warn",
          text: `Down-the-line missed ${dtlMisses} of ${total} swings`,
          todo: "Check the down-the-line phone: app open, on the charger, mic not covered"
        });
      }
    }

    // 2. Square paired: face-on (or lone) swings paired with a shot
    let paired = 0;
    for (const c of session.swings) {
      if (c.shot) paired++;
    }

    const pairedRate = total > 0 ? paired / total : 1;
    const pairedText = `Square paired ${paired} of ${total} swings with a shot`;

    if (pairedRate < 0.90) {
      lines.push({
        kind: "warn",
        text: pairedText,
        todo: "Check the Square app is open on the sim laptop and the watcher is running"
      });
    } else {
      lines.push({
        kind: "ok",
        text: pairedText
      });
    }

    // 3. No-swing clips in that session
    const eventList = Array.isArray(events)
      ? events
      : (events && Array.isArray(events.events))
        ? events.events
        : [];

    const sessionClipNames = new Set(session.clips.map(c => c.name).filter(Boolean));
    const startWin = session.start - 5 * 60 * 1000;
    const endWin = session.end + SESSION_GAP_MS;

    const noswingClips = new Set();
    let noswingAnonCount = 0;

    for (const e of eventList) {
      if (e.kind !== "noswing") continue;
      let inSession = false;
      if (e.clip && sessionClipNames.has(e.clip)) {
        inSession = true;
      } else {
        const tEv = parseTime(e.t || e.time || e.recorded);
        if (tEv != null && tEv >= startWin && tEv <= endWin) {
          inSession = true;
        }
      }

      if (inSession) {
        if (e.clip) {
          noswingClips.add(e.clip);
        } else {
          noswingAnonCount++;
        }
      }
    }

    const noswingCount = noswingClips.size + noswingAnonCount;

    if (noswingCount >= 5) {
      lines.push({
        kind: "warn",
        text: `${noswingCount} clips with no swing (false triggers)`
      });
    } else if (noswingCount > 0) {
      lines.push({
        kind: "info",
        text: `${noswingCount} clip${noswingCount === 1 ? "" : "s"} with no swing (false triggers)`
      });
    }

    // 4. Camera moved (from calib)
    if (calib) {
      if (calib.moved) {
        lines.push({
          kind: "warn",
          text: "Camera moved since calibration",
          todo: "Re-place the cameras on the Calibrate page",
          link: "/calibrate"
        });
      } else {
        lines.push({
          kind: "ok",
          text: "Cameras in place"
        });
      }
    }

    // 5. The night (from improve and next)
    if (improve && Array.isArray(improve.nights) && improve.nights.length > 0) {
      const n0 = improve.nights[0];
      const nStart = parseTime(n0.started);
      if (nStart == null || nStart >= session.end) {
        let sentence = "";
        if (n0.clips && n0.improve) {
          sentence = `Night: ${n0.clips} clips analyzed again; ${n0.improve}`;
        } else if (n0.improve) {
          sentence = `Night: ${n0.improve}`;
        } else if (n0.clips) {
          sentence = `Night: ${n0.clips} clips analyzed again`;
        }
        if (sentence) {
          lines.push({ kind: "info", text: sentence });
        }
      }
    }

    if (improve && Array.isArray(improve.candidates)) {
      const better = improve.candidates.find(c => c.status === "better");
      if (better) {
        lines.push({
          kind: "info",
          text: "A better club model is waiting: Tools > Night report",
          link: "/#nightreport"
        });
      }
    }

    const progress = inputs.progress !== undefined ? inputs.progress : (improve && improve.progress);
    if (progress) {
      const progText = clubProgressText(progress);
      if (progText) {
        const need = progress.need != null ? progress.need : 40;
        if (progress.newFrames >= need) {
          lines.push({
            kind: "info",
            text: progText
          });
        } else {
          lines.push({
            kind: "info",
            text: progText,
            link: "/#clubcheck",
            linkText: "Club check"
          });
        }
      }
    } else if (next && !next.due && next.why) {
      const m = next.why.match(/(\d+)\s+new club-labeled frames?.*?needs\s+(\d+)/i);
      if (m) {
        lines.push({
          kind: "info",
          text: `Club model: ${m[1]} of ${m[2]} new club frames for the next try (Tools > Club check)`,
          link: "/#clubcheck"
        });
      } else if (next.why.startsWith("Club model:")) {
        lines.push({
          kind: "info",
          text: next.why,
          link: "/#clubcheck"
        });
      }
    }

    // 6. Headline
    const warnCount = lines.filter(l => l.kind === "warn").length;
    const dateStr = formatDate(session.start);
    const swingStr = `${total} swing${total === 1 ? "" : "s"}`;
    const headline = warnCount > 0
      ? `Last session (${dateStr}, ${swingStr}): ${warnCount} thing${warnCount === 1 ? "" : "s"} to check.`
      : `Last session (${dateStr}, ${swingStr}): all good.`;

    return { headline, lines };
  }

  /**
   * Pure text helper for club model retraining progress:
   * - null when progress or newFrames is null/undefined
   * - "Club model: enough new frames: it trains tonight." when newFrames >= need
   * - "Club model: {newFrames} of {need} new club frames for the next training. Club check" when newFrames < need
   */
  function clubProgressText(progress) {
    if (!progress || progress.newFrames == null) return null;
    const need = progress.need != null ? progress.need : 40;
    if (progress.newFrames >= need) {
      return "Club model: enough new frames: it trains tonight.";
    }
    return `Club model: ${progress.newFrames} of ${need} new club frames for the next training. Club check`;
  }

  const SwingSinceLast = {
    summary,
    sessionsOf,
    formatDate,
    clubProgressText,
    SESSION_GAP_MS,
    SESSION_END_MIN_GAP_MS
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = SwingSinceLast;
  } else {
    root.SwingSinceLast = SwingSinceLast;
  }
})(typeof self !== "undefined" ? self : this);
