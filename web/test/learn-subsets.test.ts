import assert from "node:assert/strict";
import { test } from "node:test";
import { CELLS } from "../src/core/geometry.ts";
import { Grader, TECHNIQUES } from "../src/generator/grader.ts";
import { removeCells } from "../src/generator/generator.ts";
import { Xoshiro256StarStar } from "../src/generator/random.ts";
import { randomSolution } from "../src/generator/solver.ts";
import { hiddenPair, hiddenQuad, hiddenTriple, nakedPair, nakedQuad, nakedTriple } from "../src/learn/finders/subsets.ts";
import { type Finder, type State, bit } from "../src/learn/state.ts";

const cell = (row: number, col: number): number => (row - 1) * 9 + (col - 1);

/** An empty board where each listed cell has the listed candidates. */
function board(cells: Record<number, number[]>): State {
  const cand = new Array<number>(CELLS).fill(0);
  for (const [c, digits] of Object.entries(cells)) cand[Number(c)] = digits.reduce((m, d) => m | bit(d), 0);
  return { grid: new Array<number>(CELLS).fill(0), cand };
}

const elim = (row: number, col: number, digit: number): { cell: number; digit: number } => ({ cell: cell(row, col), digit });

test("naked pair: two cells with the same two candidates clear them from the unit", () => {
  const state = board({
    [cell(1, 1)]: [1, 2], [cell(1, 2)]: [1, 2], [cell(1, 3)]: [1, 2, 3], [cell(1, 9)]: [2, 5, 6], [cell(1, 5)]: [3, 4, 5],
  });
  const steps = nakedPair(state);
  // The row finds it first; the box finds the same two cells but a smaller set to clear.
  assert.equal(steps.length, 2);
  const step = steps[0]!;
  assert.equal(step.technique, "nakedPair");
  assert.equal(step.place, null);
  assert.deepEqual(step.eliminations, [elim(1, 3, 1), elim(1, 3, 2), elim(1, 9, 2)]);
  assert.deepEqual(step.marks, [
    { cell: cell(1, 1), role: "pattern", digits: [1, 2] },
    { cell: cell(1, 2), role: "pattern", digits: [1, 2] },
  ]);
  assert.deepEqual(step.units, [0]);
  assert.equal(step.reason.length, 3);
  assert.match(step.reason[0]!, /R1C1 and R1C2 in row 1.*1 and 2/);
  assert.match(step.reason[1]!, /naked pair/);
  assert.match(step.reason[2]!, /R1C3 \(1 and 2\) and R1C9 \(2\)/);
  assert.match(step.nudge, /row 1.*2 squares.*2 digits/);
  assert.deepEqual(steps[1]!.eliminations, [elim(1, 3, 1), elim(1, 3, 2)]);
  assert.deepEqual(steps[1]!.units, [18]);
});

test("naked pair: the same pattern in a row and a box is one step tinting both", () => {
  const state = board({ [cell(1, 1)]: [1, 2], [cell(1, 2)]: [1, 2], [cell(1, 3)]: [1, 2, 3] });
  const steps = nakedPair(state);
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0]!.units, [0, 18]);
  assert.deepEqual(steps[0]!.eliminations, [elim(1, 3, 1), elim(1, 3, 2)]);
});

test("naked pair: ignores cells that are too big, unions that are too big and pairs with nothing to clear", () => {
  const state = board({
    [cell(1, 1)]: [1, 2], [cell(1, 2)]: [1, 3], [cell(1, 5)]: [1, 2, 3], [cell(1, 6)]: [1, 2, 3, 4],
    [cell(5, 5)]: [7, 8], [cell(5, 6)]: [7, 8], [cell(5, 7)]: [4, 5],
  });
  assert.deepEqual(nakedPair(state), []);
});

test("naked triple: three cells over three digits clear them from the unit", () => {
  const state = board({
    [cell(2, 5)]: [1, 2], [cell(5, 5)]: [2, 3], [cell(8, 5)]: [1, 3], [cell(9, 5)]: [3, 4, 5], [cell(1, 5)]: [1, 2, 3, 4],
  });
  const steps = nakedTriple(state);
  assert.equal(steps.length, 1);
  const step = steps[0]!;
  assert.equal(step.technique, "nakedTriple");
  assert.deepEqual(step.eliminations, [elim(1, 5, 1), elim(1, 5, 2), elim(1, 5, 3), elim(9, 5, 3)]);
  assert.deepEqual(step.marks.map((m) => m.cell), [cell(2, 5), cell(5, 5), cell(8, 5)]);
  assert.deepEqual(step.units, [13]);
  assert.match(step.reason[1]!, /naked triple/);
  assert.match(step.reason[2]!, /R1C5 \(1, 2 and 3\) and R9C5 \(3\)/);
});

test("naked quad: four cells over four digits clear them from the unit", () => {
  const state = board({
    [cell(4, 1)]: [1, 2], [cell(4, 2)]: [2, 3], [cell(4, 3)]: [3, 4], [cell(4, 7)]: [1, 4], [cell(4, 9)]: [4, 5, 9],
  });
  const steps = nakedQuad(state);
  // Row 4 holds it; the box only sees three of the cells.
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.technique, "nakedQuad");
  assert.deepEqual(steps[0]!.eliminations, [elim(4, 9, 4)]);
  assert.deepEqual(steps[0]!.units, [3]);
  assert.match(steps[0]!.reason[1]!, /naked quad/);
});

test("hidden pair: two digits that fit only in the same two cells strip the others from them", () => {
  const state = board({
    [cell(1, 1)]: [1, 2, 3], [cell(1, 2)]: [1, 2, 4], [cell(1, 5)]: [3, 4], [cell(1, 9)]: [3, 5],
  });
  const steps = hiddenPair(state);
  assert.equal(steps.length, 1);
  const step = steps[0]!;
  assert.equal(step.technique, "hiddenPair");
  assert.equal(step.place, null);
  assert.deepEqual(step.eliminations, [elim(1, 1, 3), elim(1, 2, 4)]);
  assert.deepEqual(step.marks, [
    { cell: cell(1, 1), role: "pattern", digits: [1, 2] },
    { cell: cell(1, 2), role: "pattern", digits: [1, 2] },
  ]);
  // Also a hidden pair of box 1, with the same cells and the same removals: one step, two units.
  assert.deepEqual(step.units, [0, 18]);
  assert.equal(step.reason.length, 3);
  assert.match(step.reason[0]!, /row 1.*1 and 2.*R1C1 and R1C2/);
  assert.match(step.reason[1]!, /hidden pair/);
  assert.match(step.reason[2]!, /R1C1 \(3\) and R1C2 \(4\)/);
  assert.match(step.nudge, /row 1.*2 digits.*2 squares/);
});

test("hidden pair: ignores digits with one place or too many, and pairs with nothing to strip", () => {
  const state = board({
    // 3 and 4 live only in two cells that hold nothing else; 1 has one place; 2 has three places.
    [cell(5, 1)]: [3, 4], [cell(5, 2)]: [3, 4], [cell(5, 3)]: [1, 2], [cell(5, 4)]: [2], [cell(5, 5)]: [2],
  });
  assert.deepEqual(hiddenPair(state), []);
});

test("hidden triple: three digits that fit only in the same three cells", () => {
  const state = board({
    [cell(7, 4)]: [1, 2, 8], [cell(8, 5)]: [2, 3, 9], [cell(9, 6)]: [1, 3, 7], [cell(7, 8)]: [7, 8, 9], [cell(8, 8)]: [7, 9],
  });
  const steps = hiddenTriple(state);
  // Box 8 holds the triple (digits 1, 2, 3).
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.technique, "hiddenTriple");
  assert.deepEqual(steps[0]!.eliminations, [elim(7, 4, 8), elim(8, 5, 9), elim(9, 6, 7)]);
  assert.deepEqual(steps[0]!.marks.map((m) => m.cell), [cell(7, 4), cell(8, 5), cell(9, 6)]);
  assert.deepEqual(steps[0]!.marks[0]!.digits, [1, 2, 3]);
  assert.deepEqual(steps[0]!.units, [25]);
  assert.match(steps[0]!.reason[1]!, /hidden triple/);
});

test("hidden quad: four digits that fit only in the same four cells", () => {
  const state = board({
    [cell(1, 1)]: [1, 2], [cell(1, 3)]: [2, 3], [cell(1, 5)]: [3, 4], [cell(1, 7)]: [1, 4, 7], [cell(1, 9)]: [7, 8, 9],
  });
  const steps = hiddenQuad(state);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.technique, "hiddenQuad");
  assert.deepEqual(steps[0]!.eliminations, [elim(1, 7, 7)]);
  assert.deepEqual(steps[0]!.units, [0]);
  assert.match(steps[0]!.reason[1]!, /hidden quad/);
});

// Cross-check against the grader on real puzzles.

const finders: [string, Finder][] = [
  ["nakedPair", nakedPair], ["hiddenPair", hiddenPair], ["nakedTriple", nakedTriple], ["hiddenTriple", hiddenTriple],
  ["nakedQuad", nakedQuad], ["hiddenQuad", hiddenQuad],
];

/** Walks puzzles with the grader and checks each finder fires exactly when the grader's technique does. */
function crossCheck(count: number, targets: number[], seed: bigint): Map<string, number> {
  const random = new Xoshiro256StarStar(seed);
  const hits = new Map<string, number>();
  for (let n = 0; n < count; n++) {
    const solution = randomSolution(new Array<number>(CELLS).fill(0), random)!;
    const givens = removeCells(solution, targets[n % targets.length]!, random);
    const g = new Grader(givens);
    for (;;) {
      const state: State = { grid: Array.from(g.grid), cand: Array.from(g.cand) };
      const found = finders.map(([name, finder]) => ({ name, steps: finder(state), at: TECHNIQUES.findIndex((t) => t.name === name) }));
      const t = g.step();
      for (const { name, steps, at } of found) {
        // The grader takes the first technique that works, so a finder with steps means t <= its index.
        if (steps.length > 0) assert.ok(t >= 0 && t <= at, `${name} found steps but the grader's step was ${t}`);
        // And when the grader's step is this technique, the finder must have found it.
        if (t === at) {
          assert.ok(steps.length > 0, `grader used ${name} but the finder found nothing`);
          hits.set(name, (hits.get(name) ?? 0) + 1);
        }
        for (const step of steps) {
          assert.ok(step.eliminations.length > 0);
          // Never removes a candidate that is the real answer.
          for (const e of step.eliminations) assert.notEqual(solution[e.cell], e.digit);
        }
      }
      if (t < 0) break;
    }
  }
  return hits;
}

test("finders fire exactly when the grader's technique does", () => {
  const hits = crossCheck(120, [20, 22, 24, 26], 77n);
  assert.ok((hits.get("nakedPair") ?? 0) > 0);
  assert.ok((hits.get("hiddenPair") ?? 0) > 0);
});
