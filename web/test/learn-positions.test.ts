// Checks every practice position and puzzle the Learn area ships with.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Layout, VARIANT_DIAGONAL, VARIANT_JIGSAW, VARIANT_KILLER } from "../src/core/layout.ts";
import { Grader } from "../src/generator/grader.ts";
import { hasUniqueSolutionIn } from "../src/generator/layout-solver.ts";
import { hasUniqueSolution, solve } from "../src/generator/solver.ts";
import { POSITIONS, PUZZLES } from "../src/learn/positions.ts";
import { type PositionData, type PuzzleData, dataLayout, decodeCand, positionState } from "../src/learn/positions-format.ts";
import { VARIANT_POSITIONS, VARIANT_PUZZLES } from "../src/learn/variant-positions.ts";
import { basicCandidates, bit, isSolved, parseGrid, stateOf } from "../src/learn/state.ts";
import { TECHNIQUES, VARIANT_TECHNIQUES, easierApplies, graderStepOf, solveByLogic, techniquesIn } from "../src/learn/techniques.ts";

test("every technique has four practice positions and nothing else is listed", () => {
  assert.deepEqual(Object.keys(POSITIONS), TECHNIQUES.map((t) => t.id));
  for (const t of TECHNIQUES) assert.equal(POSITIONS[t.id]!.length, 4, t.id);
});

test("no position is used twice", () => {
  // Two techniques may share a grid at different points of its solve, so the candidates count too.
  const all = Object.values(POSITIONS).flat().map((p) => p.grid + (p.cand ?? ""));
  assert.equal(new Set(all).size, all.length);
  for (const list of Object.values(POSITIONS)) assert.equal(new Set(list.map((p) => p.grid)).size, list.length);
});

for (const t of TECHNIQUES) {
  test(`${t.id} positions are sound and need the technique`, () => {
    for (const [i, p] of POSITIONS[t.id]!.entries()) {
      const at = `${t.id} #${i}`;
      const grid = parseGrid(p.grid);
      const solution = parseGrid(p.solution);
      assert.ok(hasUniqueSolution(grid), `${at}: one solution`);
      assert.deepEqual(solve(grid), solution, `${at}: the stored solution`);
      const state = positionState(p);
      const basic = basicCandidates(grid);
      for (let c = 0; c < 81; c++) {
        assert.equal(state.cand[c]! & ~basic[c]!, 0, `${at}: candidates within the rules at ${c}`);
        if (grid[c] === 0) assert.ok(state.cand[c]! & bit(solution[c]!), `${at}: the answer is still a candidate at ${c}`);
      }
      const steps = t.find(state);
      assert.ok(steps.length > 0, `${at}: the technique applies`);
      assert.equal(easierApplies(state, t.id), false, `${at}: nothing easier applies`);
      for (const step of steps) {
        assert.equal(step.technique, t.id);
        assert.equal(step.place !== null, t.places, `${at}: places or eliminates`);
        if (step.place) assert.equal(solution[step.place.cell], step.place.digit, `${at}: places the right digit`);
        else assert.ok(step.eliminations.length > 0, `${at}: removes something`);
        for (const e of step.eliminations) assert.notEqual(solution[e.cell], e.digit, `${at}: never removes the answer`);
        assert.ok(step.reason.length > 0 && step.nudge.length > 0, `${at}: explains itself`);
      }
      if (t.grader >= 0) {
        const grader = new Grader(grid);
        state.cand.forEach((m, c) => (grader.cand[c] = m));
        assert.equal(grader.step(), t.grader, `${at}: the grader takes the same technique`);
      }
    }
  });
}

test("placement positions come with the rules' own candidates", () => {
  for (const t of TECHNIQUES.filter((x) => x.places)) {
    for (const p of POSITIONS[t.id]!) assert.equal(p.cand, undefined, t.id);
  }
});

test("every technique but the full house ends in a whole puzzle whose hardest step it is", () => {
  assert.deepEqual(Object.keys(PUZZLES), TECHNIQUES.map((t) => t.id).filter((id) => id !== "fullHouse"));
  for (const [id, p] of Object.entries(PUZZLES)) {
    const givens = parseGrid(p.givens);
    assert.ok(hasUniqueSolution(givens), `${id}: one solution`);
    assert.deepEqual(solve(givens), parseGrid(p.solution), `${id}: the stored solution`);
    const { steps, end } = solveByLogic(stateOf(givens));
    assert.ok(isSolved(end), `${id}: solvable with the lessons' techniques`);
    assert.deepEqual(end.grid, parseGrid(p.solution));
    const order = TECHNIQUES.map((t) => t.id);
    const hardest = Math.max(...steps.map((s) => order.indexOf(s.technique)));
    assert.equal(order[hardest], id, `${id}: is the hardest step`);
  }
});

test("candidates decode from two base-32 characters a cell", () => {
  const text = "0v".repeat(80) + "00";
  const cand = decodeCand(text);
  assert.equal(cand.length, 81);
  assert.equal(cand[0], 31);
  assert.equal(cand[80], 0);
  assert.throws(() => decodeCand("0v"), RangeError);
  assert.throws(() => decodeCand("0w".repeat(81)), RangeError);
});

test("a position's state uses its candidates when it has them", () => {
  const plain = POSITIONS.fullHouse![0]!;
  assert.deepEqual(positionState(plain).cand, basicCandidates(parseGrid(plain.grid)));
  const pruned = Object.values(POSITIONS).flat().find((p) => p.cand)!;
  assert.deepEqual(positionState(pruned).cand, decodeCand(pruned.cand!));
});

// The variant lessons' positions and puzzles, checked with the Variants engine.

const layoutOfData = (p: PositionData | PuzzleData): Layout => dataLayout(p);

test("every variant technique has four practice positions on its own variant", () => {
  assert.deepEqual(Object.keys(VARIANT_POSITIONS), VARIANT_TECHNIQUES.map((t) => t.id));
  const variantOf: Record<string, number> = {
    diagonalSingle: VARIANT_DIAGONAL, diagonalLocked: VARIANT_DIAGONAL, jigsawSingle: VARIANT_JIGSAW, leftovers: VARIANT_JIGSAW,
    cageCombination: VARIANT_KILLER, rule45: VARIANT_KILLER, cagePointing: VARIANT_KILLER,
  };
  for (const t of VARIANT_TECHNIQUES) {
    assert.equal(VARIANT_POSITIONS[t.id]!.length, 4, t.id);
    for (const p of VARIANT_POSITIONS[t.id]!) assert.equal(layoutOfData(p).variant, variantOf[t.id], t.id);
    const puzzle = VARIANT_PUZZLES[t.id];
    if (puzzle) assert.equal(layoutOfData(puzzle).variant, variantOf[t.id], t.id);
  }
  const all = Object.values(VARIANT_POSITIONS).flat().map((p) => p.grid + (p.cand ?? ""));
  assert.equal(new Set(all).size, all.length);
});

test("killer positions and puzzles have no cage of one square", () => {
  for (const p of [...Object.values(VARIANT_POSITIONS).flat(), ...Object.values(VARIANT_PUZZLES)]) {
    const layout = layoutOfData(p);
    assert.ok(layout.cages.every((c) => c.cells.length >= 2));
  }
});

for (const t of VARIANT_TECHNIQUES) {
  test(`${t.id} positions are sound under their layout and need the technique`, () => {
    for (const [i, p] of VARIANT_POSITIONS[t.id]!.entries()) {
      const at = `${t.id} #${i}`;
      const layout = layoutOfData(p);
      const grid = parseGrid(p.grid);
      const solution = parseGrid(p.solution);
      assert.ok(hasUniqueSolutionIn(layout, grid), `${at}: one solution`);
      assert.ok(layout.isValid(solution) && solution.every((d) => d > 0), `${at}: the solution keeps the rules`);
      assert.ok(grid.every((d, c) => d === 0 || d === solution[c]), `${at}: the solution extends the grid`);
      const state = positionState(p);
      assert.equal(state.layout, layout);
      const basic = basicCandidates(grid, layout);
      for (let c = 0; c < 81; c++) {
        assert.equal(state.cand[c]! & ~basic[c]!, 0, `${at}: candidates within the rules at ${c}`);
        if (grid[c] === 0) assert.ok(state.cand[c]! & bit(solution[c]!), `${at}: the answer is still a candidate at ${c}`);
      }
      const steps = t.find(state);
      assert.ok(steps.length > 0, `${at}: the technique applies`);
      assert.equal(easierApplies(state, t.id), false, `${at}: nothing easier applies`);
      for (const step of steps) {
        assert.equal(step.technique, t.id);
        assert.equal(step.place !== null, t.places, `${at}: places or eliminates`);
        if (step.place) assert.equal(solution[step.place.cell], step.place.digit, `${at}: places the right digit`);
        else assert.ok(step.eliminations.length > 0, `${at}: removes something`);
        for (const e of step.eliminations) assert.notEqual(solution[e.cell], e.digit, `${at}: never removes the answer`);
        assert.ok(step.reason.length > 0 && step.nudge.length > 0, `${at}: explains itself`);
        assert.doesNotMatch(step.reason.join(" "), /[\u2013\u2014]/);
      }
      if (!t.places) assert.ok(Math.min(...steps.map((s) => s.eliminations.length)) <= 4, `${at}: a small exercise`);
      const g = graderStepOf(t, layout);
      if (g >= 0) {
        const grader = new Grader(grid, layout);
        state.cand.forEach((m, c) => (grader.cand[c] = m));
        assert.equal(grader.step(), g, `${at}: the grader takes the same technique`);
      }
    }
  });
}

test("every variant lesson's whole puzzle solves by the Learn techniques, with its technique the hardest", () => {
  assert.ok(Object.keys(VARIANT_PUZZLES).every((id) => VARIANT_TECHNIQUES.some((t) => t.id === id)));
  for (const [id, p] of Object.entries(VARIANT_PUZZLES)) {
    const layout = layoutOfData(p);
    const givens = parseGrid(p.givens);
    const solution = parseGrid(p.solution);
    assert.ok(hasUniqueSolutionIn(layout, givens), `${id}: one solution`);
    assert.ok(layout.isValid(solution) && solution.every((d) => d > 0), `${id}: the solution keeps the rules`);
    assert.ok(givens.every((d, c) => d === 0 || d === solution[c]), `${id}: the solution extends the givens`);
    const { steps, end } = solveByLogic(stateOf(givens, undefined, layout));
    assert.ok(isSolved(end), `${id}: solvable with the lessons' techniques`);
    assert.deepEqual(end.grid, solution);
    const order = techniquesIn(layout).map((t) => t.id);
    assert.equal(order[Math.max(...steps.map((s) => order.indexOf(s.technique)))], id, `${id}: is the hardest step`);
  }
});
