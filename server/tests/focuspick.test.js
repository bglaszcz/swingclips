const test = require("node:test");
const assert = require("node:assert");
const FocusPick = require("../static/focuspick.js");
const Coach = require("../static/coach.js");
const Summary = require("../static/summary.js");

test("no fault side offered", () => {
  const all = FocusPick.allMoves();
  assert(all.length > 0, "should have moves");

  // Verify every returned item has no fault flag in Coach.MOVES
  for (const item of all) {
    const raw = Coach.MOVES[item.move] && Coach.MOVES[item.move][item.aim];
    assert(raw, `raw side exists for ${item.move} ${item.aim}`);
    assert.strictEqual(!!raw.fault, false, `${item.move} ${item.aim} should not have fault: true`);
  }

  // Specifically check known fault sides are not included
  const keys = all.map(m => `${m.move}:${m.aim}`);
  assert(!keys.includes("earlyExt:more"), "earlyExt:more is a fault");
  assert(!keys.includes("releaseArm:more"), "releaseArm:more is casting (a fault)");
  assert(!keys.includes("handsPlaneP6:more"), "handsPlaneP6:more is over the top (a fault)");
  assert(!keys.includes("leadHipP6:less"), "leadHipP6:less is a fault");
  assert(!keys.includes("trailHipTop:less"), "trailHipTop:less is a fault");
  assert(!keys.includes("handsAhead:less"), "handsAhead:less is a fault");
  assert(!keys.includes("lagP5:less"), "lagP5:less is a fault");
  assert(!keys.includes("bendLoss:less"), "bendLoss:less is a fault");
  assert(!keys.includes("headToBall:more"), "headToBall:more is diving (a fault)");

  // ArmsLed is not in summary.js BODY, so neither side should be included
  assert(!all.some(m => m.move === "armsLed"), "armsLed has no body metric");
});

test("every entry has a drill and a thought", () => {
  const all = FocusPick.allMoves();
  for (const item of all) {
    assert(item.name && typeof item.name === "string" && item.name.trim().length > 0,
      `missing name on ${item.move} ${item.aim}`);
    assert(item.how && typeof item.how === "string" && item.how.trim().length > 0,
      `missing how on ${item.move} ${item.aim}`);
    assert(item.drill && typeof item.drill === "string" && item.drill.trim().length > 0,
      `missing drill on ${item.move} ${item.aim}`);
    assert(item.thought && typeof item.thought === "string" && item.thought.trim().length > 0,
      `missing thought on ${item.move} ${item.aim}`);
  }
});

test("no P[1-8] in any name", () => {
  const all = FocusPick.allMoves();
  for (const item of all) {
    assert(!/P[1-8]/.test(item.name), `name "${item.name}" contains P-number for ${item.move} ${item.aim}`);
    assert(!/P[1-8]/.test(item.drill), `drill "${item.drill}" contains P-number for ${item.move} ${item.aim}`);
    assert(!/P[1-8]/.test(item.thought), `thought "${item.thought}" contains P-number for ${item.move} ${item.aim}`);
  }
});

test("moves are grouped by where they happen", () => {
  const groups = FocusPick.groupedMoves();
  const groupNames = groups.map(g => g.group);

  // Groups present
  assert(groupNames.includes("Top of swing"), "should have Top of swing group");
  assert(groupNames.includes("Downswing"), "should have Downswing group");
  assert(groupNames.includes("Impact"), "should have Impact group");
  assert(groupNames.includes("Tempo"), "should have Tempo group");

  // Every group has moves
  for (const g of groups) {
    assert(g.moves.length > 0, `group ${g.group} should have moves`);
    for (const m of g.moves) {
      assert.strictEqual(m.group, g.group, `item group matches parent group`);
    }
  }

  // Check specific members
  const topGroup = groups.find(g => g.group === "Top of swing");
  assert(topGroup.moves.some(m => m.move === "shoulderTop"), "shoulderTop in Top of swing");
  assert(topGroup.moves.some(m => m.move === "handsPlaneTop"), "handsPlaneTop in Top of swing");

  const downGroup = groups.find(g => g.group === "Downswing");
  assert(downGroup.moves.some(m => m.move === "releaseArm"), "releaseArm in Downswing");
  assert(downGroup.moves.some(m => m.move === "handsPlaneP6"), "handsPlaneP6 in Downswing");

  const impactGroup = groups.find(g => g.group === "Impact");
  assert(impactGroup.moves.some(m => m.move === "hipSway"), "hipSway in Impact");
  assert(impactGroup.moves.some(m => m.move === "earlyExt"), "earlyExt in Impact");

  const tempoGroup = groups.find(g => g.group === "Tempo");
  assert(tempoGroup.moves.some(m => m.move === "tempo"), "tempo in Tempo");
  assert(tempoGroup.moves.some(m => m.move === "backswing"), "backswing in Tempo");
  assert(tempoGroup.moves.some(m => m.move === "downswing"), "downswing in Tempo");
});
