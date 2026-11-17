import assert from "node:assert/strict";
import { test } from "node:test";
import { CELLS } from "../src/core/geometry.ts";
import { TECHNIQUES as GRADER_TECHNIQUES } from "../src/generator/grader.ts";
import { type State, apply, isSolved, parseGrid, stateOf } from "../src/learn/state.ts";
import { TECHNIQUES, easierApplies, nextStep, solveByLogic, techniqueById } from "../src/learn/techniques.ts";

const IDS = [
  "fullHouse", "crossHatch", "hiddenSingle", "nakedSingle", "pointing", "claiming", "nakedPair", "hiddenPair", "nakedTriple",
  "hiddenTriple", "nakedQuad", "hiddenQuad", "xWing", "swordfish", "jellyfish", "skyscraper", "twoStringKite", "emptyRectangle",
  "xyWing", "xyzWing", "wWing", "uniqueRectangle", "simpleColouring", "xChain", "xyChain",
];

// A real position where the first technique that applies is a hidden single.
const HIDDEN = "200638409800904000004201008000340701000780050723510800001427005002193000370865100";
// A real puzzle whose hardest step is an XY-Wing, with its solution.
const XY_WING = "000030409800900000004201008000040701000080050023500800001007005002190000370865100";
const XY_WING_SOLUTION = "215638479837954216964271538598346721146782953723519864681427395452193687379865142";

const empty = (): State => stateOf(new Array<number>(CELLS).fill(0));

test("the techniques are in teaching order with unique ids and names", () => {
  assert.deepEqual(TECHNIQUES.map((t) => t.id), IDS);
  assert.equal(new Set(TECHNIQUES.map((t) => t.id)).size, TECHNIQUES.length);
  assert.equal(new Set(TECHNIQUES.map((t) => t.name)).size, TECHNIQUES.length);
  assert.ok(TECHNIQUES.every((t) => t.name.length > 0 && typeof t.find === "function"));
});

test("only the four singles place a digit", () => {
  assert.deepEqual(TECHNIQUES.filter((t) => t.places).map((t) => t.id), ["fullHouse", "crossHatch", "hiddenSingle", "nakedSingle"]);
});

test("grader: points at the grader's technique, counting full houses and cross-hatching as hidden singles", () => {
  const hidden = GRADER_TECHNIQUES.findIndex((t) => t.name === "hiddenSingle");
  assert.ok(hidden >= 0);
  for (const id of ["fullHouse", "crossHatch", "hiddenSingle"]) assert.equal(techniqueById(id).grader, hidden, id);
  for (const t of TECHNIQUES) {
    const name = t.id === "fullHouse" || t.id === "crossHatch" ? "hiddenSingle" : t.id;
    assert.equal(t.grader, GRADER_TECHNIQUES.findIndex((g) => g.name === name), t.id);
  }
  assert.equal(techniqueById("nakedSingle").grader, GRADER_TECHNIQUES.findIndex((g) => g.name === "nakedSingle"));
});

test("techniqueById finds a technique and throws a RangeError for an unknown id", () => {
  assert.equal(techniqueById("xWing").name, "X-Wing");
  assert.equal(techniqueById("xWing"), TECHNIQUES[12]);
  assert.throws(() => techniqueById("nope"), (e: unknown) => e instanceof RangeError && /unknown technique: nope/.test(e.message));
});

test("nextStep is the first step of the easiest technique that applies", () => {
  const state = stateOf(parseGrid(HIDDEN));
  const step = nextStep(state)!;
  assert.equal(step.technique, "hiddenSingle");
  assert.deepEqual(step, techniqueById("hiddenSingle").find(state)[0]);
  // No easier technique had anything to say.
  for (const id of ["fullHouse", "crossHatch"]) assert.deepEqual(techniqueById(id).find(state), []);
});

test("nextStep is null when nothing applies", () => {
  assert.equal(nextStep(empty()), null);
});

test("easierApplies: whether anything before a technique has a step", () => {
  const state = stateOf(parseGrid(HIDDEN));
  assert.equal(easierApplies(state, "fullHouse"), false, "nothing is easier than the first");
  assert.equal(easierApplies(state, "crossHatch"), false);
  assert.equal(easierApplies(state, "hiddenSingle"), false, "this one is the easiest that applies");
  assert.equal(easierApplies(state, "nakedSingle"), true, "a hidden single comes first");
  assert.equal(easierApplies(state, "xyChain"), true);
});

test("easierApplies throws for an id it never reaches", () => {
  assert.throws(() => easierApplies(empty(), "nope"), (e: unknown) => e instanceof RangeError && /unknown technique: nope/.test(e.message));
  // Even when an easier technique is found first, an unknown id is only seen once the search has run out; the first hit wins.
  assert.equal(easierApplies(stateOf(parseGrid(HIDDEN)), "nope"), true);
});

test("solveByLogic solves a puzzle with the techniques it needs and no harder ones", () => {
  const start = stateOf(parseGrid(XY_WING));
  const { steps, end } = solveByLogic(start);
  assert.equal(isSolved(end), true);
  assert.deepEqual(end.grid, Array.from(XY_WING_SOLUTION, Number));
  const used = new Set(steps.map((s) => s.technique));
  assert.ok(used.has("xyWing"), "the hardest step is an XY-Wing");
  const rank = (id: string): number => IDS.indexOf(id);
  assert.ok(steps.every((s) => rank(s.technique) <= rank("xyWing")));
  assert.equal(steps.filter((s) => s.place).length, start.grid.filter((d) => d === 0).length, "every empty square is placed by a step");
  // Replaying the steps from the start reaches the same end.
  const replay = steps.reduce<State>((s, step) => apply(s, step), start);
  assert.deepEqual(replay, end);
});

test("solveByLogic on a solved puzzle takes no steps", () => {
  const solved = stateOf(parseGrid(XY_WING_SOLUTION));
  const { steps, end } = solveByLogic(solved);
  assert.deepEqual(steps, []);
  assert.equal(end, solved);
});

test("solveByLogic stops where the techniques run out", () => {
  const start = empty();
  const { steps, end } = solveByLogic(start);
  assert.deepEqual(steps, []);
  assert.equal(end, start);
  assert.equal(isSolved(end), false);
  // A sparse board gets some way (or none) but never claims to be solved.
  const sparse = stateOf(parseGrid(XY_WING_SOLUTION.slice(0, 18) + "0".repeat(63)));
  assert.equal(isSolved(solveByLogic(sparse).end), false);
});
