const { describe, it } = require("node:test");
const assert = require("node:assert");
const AICoach = require("../static/aicoach.js");

describe("SwingAICoach.brief", () => {
  it("formats a complete session brief with all sections under 4,000 words", () => {
    const input = {
      date: 1789123456,
      swings: 35,
      session: {
        start: 1789123456,
        rows: [
          { club: "I7", carry: 155, offline: 2, smash: 1.38, strikeV: 0 },
          { club: "DR", carry: 245, offline: -8, smash: 1.48, strikeV: 4 },
        ],
      },
      story: {
        headline: "A little better than last session",
        clubs: [
          { club: "I7", n: 20, goodRate: 0.65, note: "your best club today: 65% good with the 7 iron" },
          { club: "DR", n: 15, goodRate: 0.40, note: "struggled off the tee" },
        ],
        best: { name: "swing_face_1920x1080_240fps_1789123456.mp4", why: "Solid strike and on line" },
        fault: {
          readable: "Hips toward the ball at impact",
          count: 8,
          drill: "Chair drill: keep glutes against chair through impact",
          thought: "Stay in your posture",
        },
      },
      compare: {
        headline: "A little better than last session",
        items: [
          { label: "Good shots", now: 0.60, last: 0.50, usual: 0.55, unit: "%", change: "better", clear: true },
          { label: "On line", now: 0.75, last: 0.70, usual: 0.72, unit: "%", change: "same", clear: false },
          { label: "Solid strikes", now: 0.80, last: 0.80, usual: 0.82, unit: "%", change: "same", clear: false },
          { label: "Distance", now: 102.0, last: 98.0, usual: 100.0, unit: "% of usual", change: "better", clear: false },
        ],
      },
      focus: {
        move: "hipSway",
        aim: "more",
        club: "I7",
        since: "2026-10-01",
        evidence: [
          "More hip slide links to steeper attack angle (+0.8° per inch)",
          "Correlates with higher smash factor on 7 iron",
        ],
      },
      focusWorking: {
        head: "It's working",
        next: "You're making the move and smash followed over 3 sessions. Keep the drill going.",
        cls: "better",
      },
      focusCmp: {
        move: { key: "hipSway", before: 2.1, after: 3.4, change: 1.3, level: "clear" },
        results: [
          { key: "smash", before: 1.34, after: 1.39, change: 0.05, level: "clear" },
          { key: "strikeV", before: -4.0, after: 0.5, change: 4.5, level: "clear" },
        ],
      },
      programReport: "Gate 1: 8 of 10 passed. Median attack -3.8°. Finished with 7-iron.",
    };

    const brief = AICoach.brief(input);

    // Verify sections and contents
    assert.match(brief, /# Session/);
    assert.match(brief, /Date:/);
    assert.match(brief, /Total swings: 35/);
    assert.match(brief, /Clubs: 7 iron \(1 swings\), driver \(1 swings\)/);
    assert.match(brief, /Headline: A little better than last session/);
    assert.match(brief, /Club performance:/);
    assert.match(brief, /Best swing to rewatch: /);
    assert.doesNotMatch(brief, /.mp4/);   // no clip names go out
    assert.match(brief, /Top fault: Hips toward the ball at impact \(8 swings\)/);
    assert.match(brief, /Drill: Chair drill/);
    assert.match(brief, /Swing thought: Stay in your posture/);

    assert.match(brief, /# Against Earlier Sessions/);
    assert.match(brief, /Comparison summary: A little better than last session/);
    assert.match(brief, /Good shots: now 60%/);

    assert.match(brief, /# Current Focus/);
    assert.match(brief, /Focus: more of a hip bump toward the target \(7 iron\) since 2026-10-01 \(measured as hip slide at impact, aiming for more\)/);
    assert.match(brief, /Its drill: /);
    assert.match(brief, /Its swing thought: /);
    assert.match(brief, /Evidence for focus:/);
    assert.match(brief, /Focus status: It's working/);
    assert.match(brief, /Focus next step: You're making the move and smash followed/);
    assert.match(brief, /Move progress \(Hip slide at impact\):/);
    assert.match(brief, /Results following focus:/);

    assert.match(brief, /# Coach Program Run/);
    assert.match(brief, /Gate 1: 8 of 10 passed/);

    // Word count check
    const wordCount = brief.split(/\s+/).filter(Boolean).length;
    assert.ok(wordCount < 4000, `Word count was ${wordCount}`);
  });

  it("leaves out missing pieces without guessing", () => {
    // Only session, no compare, no focus, no program
    const input = {
      swings: 12,
      session: {
        rows: [{ club: "I7" }],
      },
    };

    const brief = AICoach.brief(input);
    assert.match(brief, /# Session/);
    assert.match(brief, /Total swings: 12/);
    assert.doesNotMatch(brief, /# Against Earlier Sessions/);
    assert.doesNotMatch(brief, /# Current Focus/);
    assert.doesNotMatch(brief, /# Coach Program Run/);
    assert.doesNotMatch(brief, /Top fault/);
  });

  it("formats strike heights as face-centred and avoids P-numbers", () => {
    const val0 = AICoach.formatMetricValue("strikeV", 0);
    assert.strictEqual(val0, "0.0 mm (face-centred)");

    const valHigh = AICoach.formatMetricValue("strikeV", 3.2);
    assert.strictEqual(valHigh, "+3.2 mm (face-centred)");

    const valLow = AICoach.formatMetricValue("strikeV", -5.5);
    assert.strictEqual(valLow, "-5.5 mm (face-centred)");

    // Ensure labels do not use P-numbers
    for (const [key, label] of Object.entries(AICoach.METRIC_LABELS)) {
      assert.doesNotMatch(label, /\bP[1-8]\b/, `Label for ${key} contains P-number: ${label}`);
    }
  });

  it("handles empty or null input safely", () => {
    assert.strictEqual(AICoach.brief(null), "");
    assert.strictEqual(AICoach.brief({}), "# Session");
  });
});

it("SwingAICoach.focusProgress: the move and its results since the focus started, kept to its club", () => {
  global.SwingSummary = require("../static/summary.js");
  const A = require("../static/aicoach.js");
  const day = d => new Date(`2026-10-${String(d).padStart(2, "0")}T12:00:00`).getTime();
  const sessions = [];
  for (let d = 1; d <= 12; d++) {
    const rows = [];
    for (let i = 0; i < 8; i++) {
      rows.push({ club: "I7", hipSway: (d < 6 ? 1 : 3) + (i % 3) * 0.1, shot: null });
      rows.push({ club: "DR", hipSway: 9, shot: null });       // another club: left out
    }
    sessions.push({ start: day(d), rows });
  }
  const got = A.focusProgress({ move: "hipSway", aim: "more", club: "I7", since: "2026-10-06", results: [] }, sessions);
  assert.equal(got.focusCmp.after, 7);
  assert.ok(got.focusCmp.move.after > got.focusCmp.move.before);
  assert.equal(got.focusCmp.move.good, true);
  assert.ok(got.focusWorking.head);
  assert.deepEqual(A.focusProgress(null, sessions), {});
});

describe("SwingAICoach.takeParts", () => {
  it("keeps bold as bold, drops other Markdown marks, never HTML", () => {
    const parts = AICoach.takeParts("**How it went**\nA solid session.\n## Next session\n- Drag drill <b>x</b>");
    assert.deepStrictEqual(parts.filter(p => p.bold).map(p => p.text), ["How it went", "Next session"]);
    const all = parts.map(p => p.text).join("");
    assert.ok(!all.includes("**") && !all.includes("##"));
    assert.ok(all.includes("• Drag drill <b>x</b>"));   // left as text: renderTake puts it in a text node
    assert.deepStrictEqual(AICoach.takeParts(""), []);
  });
});
