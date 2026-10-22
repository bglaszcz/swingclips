// drilllib.test.js: unit tests for SwingDrillLib.build (drilllib.js).
const test = require("node:test");
const assert = require("node:assert");
const Lib = require("../static/drilllib.js");

const MOMENTS = {
  rhythm: { id: "rhythm", tag: "RHYTHM", name: "Rhythm" },
  top: { id: "top", tag: "TOP", name: "Top of the swing" },
  downswing: { id: "downswing", tag: "DOWNSWING", name: "Downswing" },
  impact: { id: "impact", tag: "IMPACT", name: "Impact" },
};
function moment(f) {
  const pos = f && f.pos;
  if (pos === "p4") return MOMENTS.top;
  if (pos === "p5" || pos === "p6") return MOMENTS.downswing;
  if (pos === "p7") return MOMENTS.impact;
  return MOMENTS.rhythm;
}
const FIELDS = { leadHipP6: { pos: "p6" }, handsAhead: { pos: "p7" }, shoulderTop: { pos: "p4" }, handsPlaneP6: { pos: "p6" } };

const MOVES = {
  tempo: {
    more: { name: "an unhurried backswing", drill: "Tempo count: say it out loud. 10 balls.", thought: "Smooth back, go through." },
    less: { name: "a brisker backswing", drill: "just swing quicker to the top", thought: "\"Keep it moving.\"" },
  },
  leadHipP6: {
    more: { name: "the lead hip getting to the target at P6", drill: "Hip-to-the-stick drill: bump the hip to the stick. 10 balls.", thought: "Hip to the stick." },
    less: { name: "the lead hip staying back", drill: null, thought: "Stay back." },
  },
  handsAhead: {
    more: { name: "hands ahead at impact", drill: "Hip-to-the-stick drill: hands lead. 10 balls.", thought: "\u201cHands lead.\u201d" },
  },
  shoulderTop: {
    more: { name: "a fuller turn", drill: "Wall turn: back to the wall.", thought: "Turn your back." },
  },
  handsPlaneP6: {
    less: { name: "hands dropping in", drill: "Pump drill: pump twice.", thought: "Drop it in." },
  },
  noField: {
    more: { name: "something with no field", drill: "Zed drill: do it.", thought: "Zed." },
  },
};
const NAMED = { "handsPlaneP6:less": "pump" };
function drillId(move, aim) {
  const side = MOVES[move] && MOVES[move][aim];
  if (!side || !side.drill) return null;
  return NAMED[`${move}:${aim}`] || `move:${move}:${aim}`;
}
const plain = t => t && t.replace(/\bat P6\b/g, "in the downswing");

function input(extra = {}) {
  return Object.assign({
    moves: MOVES, drillId, sets: [], verdict: s => ({ text: `verdict ${s.count}`, level: s.count > 10 ? "clear" : "maybe" }),
    focus: null, current: null, plain, fields: FIELDS, moment,
  }, extra);
}
const find = (m, id) => m.drills.find(d => d.id === id);

test("one entry per move and way with a drill", () => {
  const m = Lib.build(input());
  assert.strictEqual(m.drills.length, 7);
  assert.ok(!find(m, "move:leadHipP6:less"));
});

test("name and how split, with and without ': '", () => {
  const m = Lib.build(input());
  const d = find(m, "move:leadHipP6:more");
  assert.strictEqual(d.name, "Hip-to-the-stick drill");
  assert.strictEqual(d.how, "Bump the hip to the stick. 10 balls.");
  const n = find(m, "move:tempo:less");
  assert.strictEqual(n.name, "Drill");
  assert.strictEqual(n.how, "just swing quicker to the top");
});

test("trains goes through plain; the thought loses its quotes and full stop", () => {
  const m = Lib.build(input());
  assert.strictEqual(find(m, "move:leadHipP6:more").trains, "the lead hip getting to the target in the downswing");
  assert.strictEqual(find(m, "move:tempo:more").thought, "Smooth back, go through");
  assert.strictEqual(find(m, "move:tempo:less").thought, "Keep it moving");
  assert.strictEqual(find(m, "move:handsAhead:more").thought, "Hands lead");
});

test("moment of a known and an unknown field", () => {
  const m = Lib.build(input());
  assert.strictEqual(find(m, "move:leadHipP6:more").moment.name, "Downswing");
  assert.strictEqual(find(m, "move:shoulderTop:more").moment.id, "top");
  assert.strictEqual(find(m, "move:noField:more").moment.id, "rhythm");
  assert.strictEqual(find(m, "move:tempo:more").moment.tag, "RHYTHM");
});

test("isFocus and on", () => {
  const m = Lib.build(input({ focus: { move: "leadHipP6", aim: "more", club: "7i" }, current: "pump" }));
  assert.strictEqual(find(m, "move:leadHipP6:more").isFocus, true);
  assert.strictEqual(find(m, "move:handsAhead:more").isFocus, false);
  assert.strictEqual(find(m, "pump").on, true);
  assert.strictEqual(find(m, "move:leadHipP6:more").on, false);
});

test("sets, reps and last from two sets of one drill", () => {
  const sets = [
    { drill: "move:leadHipP6:more", count: 12, timestamp: 200, dateFormatted: "Oct 5", firstClip: "b1" },
    { drill: "move:leadHipP6:more", count: 8, timestamp: 100, dateFormatted: "Oct 1", firstClip: "a1" },
    { drill: "pump", count: 10, timestamp: 150, dateFormatted: "Oct 3", firstClip: "p1" },
  ];
  const m = Lib.build(input({ sets }));
  const d = find(m, "move:leadHipP6:more");
  assert.strictEqual(d.sets, 2);
  assert.strictEqual(d.reps, 20);
  assert.deepStrictEqual(d.last, { date: "Oct 5", timestamp: 200, text: "verdict 12", level: "clear", firstClip: "b1" });
  assert.strictEqual(find(m, "move:tempo:more").last, null);
  assert.strictEqual(find(m, "move:tempo:more").sets, 0);
});

test("order in a group and in mine; counts", () => {
  const sets = [
    { drill: "pump", count: 10, timestamp: 300, dateFormatted: "Oct 6", firstClip: "p1" },
    { drill: "move:tempo:less", count: 5, timestamp: 100, dateFormatted: "Oct 1", firstClip: "t1" },
  ];
  // Downswing group: leadHipP6 more (focus) and the pump; Rhythm: tempo more, tempo less, noField.
  const m = Lib.build(input({ sets, focus: { move: "tempo", aim: "more" } }));
  assert.deepStrictEqual(m.groups.map(g => g.id), ["rhythm", "top", "downswing", "impact"]);
  const rhythm = m.groups[0].drills.map(d => d.id);
  // Focus first, then the one with a set, then the rest by name.
  assert.deepStrictEqual(rhythm, ["move:tempo:more", "move:tempo:less", "move:noField:more"]);
  const down = m.groups[2].drills.map(d => d.id);
  assert.deepStrictEqual(down, ["pump", "move:leadHipP6:more"]);
  assert.deepStrictEqual(m.mine.map(d => d.id), ["move:tempo:more", "pump", "move:tempo:less"]);
  assert.deepStrictEqual(m.counts, { all: 7, tried: 2 });
});

test("empty groups are left out; mine may be empty", () => {
  const moves = { tempo: MOVES.tempo };
  const m = Lib.build(input({ moves }));
  assert.deepStrictEqual(m.groups.map(g => g.id), ["rhythm"]);
  assert.deepStrictEqual(m.mine, []);
  assert.deepStrictEqual(m.counts, { all: 2, tried: 0 });
});

test("two moves whose drills share a name stay two entries", () => {
  const m = Lib.build(input());
  const same = m.drills.filter(d => d.name === "Hip-to-the-stick drill");
  assert.strictEqual(same.length, 2);
  assert.notStrictEqual(same[0].id, same[1].id);
});

test("the pump's id", () => {
  const m = Lib.build(input());
  const p = m.drills.find(d => d.move === "handsPlaneP6" && d.aim === "less");
  assert.strictEqual(p.id, "pump");
  assert.strictEqual(p.name, "Pump drill");
});

test("a way that is a fault gets no card", () => {
  const moves = Object.assign({}, MOVES, {
    earlyExt: {
      more: { name: "early extension", fault: true, drill: "Ground-push drill: stand up through the finish.", thought: "Push the ground." },
      less: { name: "keeping your hips back", drill: "Chair drill: backside on the chair.", thought: "Tush on the wall." },
    },
  });
  const m = Lib.build(input({ moves, drillId: (move, aim) => moves[move] && moves[move][aim] ? `move:${move}:${aim}` : null }));
  assert.ok(!find(m, "move:earlyExt:more"));
  assert.ok(find(m, "move:earlyExt:less"));
});

test("the real coach: 44 drills, every name and how, no P-numbers on screen", () => {
  const Coach = require("../static/coach.js");
  const Ind = require("../static/indicators.js");
  const Story = require("../static/shotstory.js");
  const m = Lib.build({
    moves: Coach.MOVES, drillId: Coach.drillId, sets: [], verdict: () => null, focus: null, current: null,
    plain: Story.plain, fields: Ind.KNOWN_FIELDS, moment: Ind.moment,
  });
  // 52 before Oct 20 2026, with the 10 ways coach.js marks as faults (ground-push, post-and-rotate...).
  assert.strictEqual(m.drills.length, 44);
  assert.strictEqual(m.counts.all, 44);
  assert.ok(!m.drills.some(d => Coach.MOVES[d.move][d.aim].fault));
  for (const d of m.drills) {
    assert.ok(d.name, `${d.id} has a name`);
    assert.ok(d.how, `${d.id} has a how`);
    for (const k of ["trains", "how", "thought"]) assert.ok(!/\bP[1-8]\b/.test(d[k]), `${d.id} ${k}: ${d[k]}`);
  }
  assert.strictEqual(m.groups.reduce((n, g) => n + g.drills.length, 0), 44);
});


test("bestRep is populated in build from sets, preferring furthest the drill's way", () => {
  const sets = [
    {
      drill: "move:leadHipP6:more",
      count: 10,
      bestRep: { clip: "c1", value: 2.2, metric: "leadHipP6", aim: "more" },
    },
    {
      drill: "move:leadHipP6:more",
      count: 10,
      bestRep: { clip: "c2", value: 2.9, metric: "leadHipP6", aim: "more" },
    },
    {
      drill: "pump",
      count: 5,
      bestRep: { clip: "p_low", value: -1.5, metric: "handsPlane", aim: "less" },
    },
    {
      drill: "pump",
      count: 5,
      bestRep: { clip: "p_high", value: 0.2, metric: "handsPlane", aim: "less" },
    },
  ];
  const m = Lib.build(input({ sets }));
  const hip = find(m, "move:leadHipP6:more");
  assert.ok(hip.bestRep);
  assert.strictEqual(hip.bestRep.clip, "c2");
  assert.strictEqual(hip.bestRep.value, 2.9);

  const pump = find(m, "pump");
  assert.ok(pump.bestRep);
  assert.strictEqual(pump.bestRep.clip, "p_low");
  assert.strictEqual(pump.bestRep.value, -1.5);

  const tempo = find(m, "move:tempo:more");
  assert.strictEqual(tempo.bestRep, null);
});

test("render shows 'Watch your best rep' button when bestRep exists, and 'No rep of yours yet' when absent", () => {
  function fakeDoc() {
    function node(tag) {
      let _text = "";
      return {
        tagName: tag.toUpperCase(),
        className: "",
        dataset: {},
        children: [],
        onclick: null,
        type: "",
        title: "",
        attributes: {},
        setAttribute(k, v) { this.attributes[k] = v; },
        getAttribute(k) { return this.attributes[k]; },
        appendChild(c) { this.children.push(c); return c; },
        append(...kids) { for (const k of kids) if (k) this.children.push(k); },
        get textContent() { return _text; },
        set textContent(v) {
          _text = v;
          if (v === "") this.children = [];
        }
      };
    }
    return {
      createElement(tag) { return node(tag); },
      createTextNode(t) { return { nodeType: 3, textContent: t }; },
    };
  }

  function findAllByClass(node, cls) {
    const res = [];
    function walk(n) {
      if (!n) return;
      if (n.className && n.className.split(" ").includes(cls)) res.push(n);
      if (n.children) n.children.forEach(walk);
    }
    walk(node);
    return res;
  }

  const doc = fakeDoc();
  const box = doc.createElement("div");
  box.ownerDocument = doc;

  const sets = [
    {
      drill: "move:leadHipP6:more",
      count: 10,
      bestRep: { clip: "rep_hip_best", value: 3.0, metric: "leadHipP6", aim: "more" }
    }
  ];
  const model = Lib.build(input({ sets, focus: { move: "tempo", aim: "more" } }));
  let openedClip = null;
  Lib.render(box, model, {
    onOpen: clip => { openedClip = clip; }
  });

  const demoButtons = findAllByClass(box, "dl-demo");
  assert.ok(demoButtons.length > 0);

  // The one with bestRep has button text "Watch your best rep" and clickable onOpen
  const hipDemo = demoButtons.find(b => b.tagName === "BUTTON" && b.textContent === "Watch your best rep");
  assert.ok(hipDemo, "Watch your best rep button rendered");
  hipDemo.onclick();
  assert.strictEqual(openedClip, "rep_hip_best");

  // The ones without bestRep render "No rep of yours yet"
  const noRepDemos = demoButtons.filter(b => b.textContent === "No rep of yours yet");
  assert.ok(noRepDemos.length > 0, "No rep of yours yet rendered for drills without reps");
});
