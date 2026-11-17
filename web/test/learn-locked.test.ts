import assert from "node:assert/strict";
import { test } from "node:test";
import { CELLS } from "../src/core/geometry.ts";
import { Grader, TECHNIQUES } from "../src/generator/grader.ts";
import { removeCells } from "../src/generator/generator.ts";
import { Xoshiro256StarStar } from "../src/generator/random.ts";
import { randomSolution } from "../src/generator/solver.ts";
import { claiming, pointing } from "../src/learn/finders/locked.ts";
import { type Finder, type State, bit } from "../src/learn/state.ts";

const cell = (row: number, col: number): number => (row - 1) * 9 + (col - 1);

/** An empty board where each listed cell has the listed candidates. */
function board(cells: Record<number, number[]>): State {
  const cand = new Array<number>(CELLS).fill(0);
  for (const [c, digits] of Object.entries(cells)) cand[Number(c)] = digits.reduce((m, d) => m | bit(d), 0);
  return { grid: new Array<number>(CELLS).fill(0), cand };
}

test("pointing: a digit confined to one row of a box leaves the rest of the row", () => {
  // 5 in box 1 only at R1C1 and R1C2; R1C6 and R2C5 also have 5 (only R1C6 is in the row).
  const state = board({ [cell(1, 1)]: [5, 6], [cell(1, 2)]: [5, 7], [cell(1, 6)]: [5, 8], [cell(2, 5)]: [5, 8], [cell(1, 4)]: [1, 2] });
  const steps = pointing(state);
  assert.equal(steps.length, 1);
  const step = steps[0]!;
  assert.equal(step.technique, "pointing");
  assert.equal(step.place, null);
  assert.deepEqual(step.eliminations, [{ cell: cell(1, 6), digit: 5 }]);
  assert.deepEqual(step.marks, [
    { cell: cell(1, 1), role: "pattern", digits: [5] },
    { cell: cell(1, 2), role: "pattern", digits: [5] },
  ]);
  assert.deepEqual(step.units, [18, 0]);
  assert.equal(step.reason.length, 3);
  assert.match(step.reason[0]!, /box 1.*R1C1 and R1C2/);
  assert.match(step.reason[2]!, /5 can be removed from R1C6/);
  assert.match(step.nudge, /5.*box 1/);
});

test("pointing: a digit confined to one column of a box leaves the rest of the column", () => {
  // 3 in box 5 only at R4C5 and R6C5; it is also at R1C5, R9C5 and R4C9.
  const state = board({
    [cell(4, 5)]: [3, 4], [cell(6, 5)]: [3, 9], [cell(1, 5)]: [3, 1], [cell(9, 5)]: [3, 2], [cell(4, 9)]: [3, 7],
  });
  const steps = pointing(state);
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0]!.eliminations, [{ cell: cell(1, 5), digit: 3 }, { cell: cell(9, 5), digit: 3 }]);
  assert.deepEqual(steps[0]!.units, [22, 13]);
  assert.match(steps[0]!.reason[2]!, /R1C5 and R9C5/);
});

test("pointing: skips a single place, a spread digit and a line with nothing to remove", () => {
  const state = board({
    // 1 has one place in box 1 (a hidden single, not pointing).
    [cell(1, 1)]: [1], [cell(1, 5)]: [1, 2],
    // 2 in box 1 spreads over two rows and two columns.
    [cell(2, 2)]: [2], [cell(3, 3)]: [2], [cell(2, 8)]: [2],
    // 3 in box 1 shares a row, but nothing else in that row has a 3.
    [cell(3, 1)]: [3], [cell(3, 2)]: [3],
  });
  assert.deepEqual(pointing(state), []);
});

test("claiming: a digit confined to one box of a row leaves the rest of the box", () => {
  // 7 in row 4 only at R4C1 and R4C3 (box 4); R5C2 also has 7 and R4C8 is outside the box.
  const state = board({ [cell(4, 1)]: [7, 8], [cell(4, 3)]: [7, 9], [cell(5, 2)]: [7, 1], [cell(6, 3)]: [7, 2], [cell(4, 8)]: [1] });
  const steps = claiming(state).filter((s) => s.units[0] === 3);
  assert.equal(steps.length, 1);
  const step = steps[0]!;
  assert.equal(step.technique, "claiming");
  assert.equal(step.place, null);
  assert.deepEqual(step.eliminations, [{ cell: cell(5, 2), digit: 7 }, { cell: cell(6, 3), digit: 7 }]);
  assert.deepEqual(step.marks, [
    { cell: cell(4, 1), role: "pattern", digits: [7] },
    { cell: cell(4, 3), role: "pattern", digits: [7] },
  ]);
  assert.deepEqual(step.units, [3, 21]);
  assert.match(step.reason[0]!, /row 4.*R4C1 and R4C3/);
  assert.match(step.reason[1]!, /box 4/);
  assert.match(step.reason[2]!, /7 can be removed from R5C2 and R6C3/);
  assert.match(step.nudge, /7.*row 4/);
});

test("claiming: works down a column and in digit order", () => {
  // 2 and 6 in column 9, each in box 9 only.
  const state = board({
    [cell(7, 9)]: [2, 6], [cell(8, 9)]: [2, 6], [cell(8, 7)]: [2, 6], [cell(9, 8)]: [6],
  });
  const steps = claiming(state).filter((s) => s.units[0] === 17);
  assert.deepEqual(steps.map((s) => [s.eliminations[0]!.digit, s.units]), [[2, [17, 26]], [6, [17, 26]]]);
  assert.deepEqual(steps[0]!.eliminations, [{ cell: cell(8, 7), digit: 2 }]);
  assert.deepEqual(steps[1]!.eliminations, [{ cell: cell(8, 7), digit: 6 }, { cell: cell(9, 8), digit: 6 }]);
});

test("claiming: skips a single place, a spread digit and a box with nothing to remove", () => {
  const state = board({
    [cell(1, 1)]: [1], [cell(2, 2)]: [1],
    [cell(1, 4)]: [2], [cell(1, 8)]: [2], [cell(2, 9)]: [2],
    [cell(1, 2)]: [3], [cell(1, 3)]: [3],
  });
  assert.deepEqual(claiming(state), []);
});

// Cross-check against the grader on real puzzles.

const finders: [string, Finder][] = [["pointing", pointing], ["claiming", claiming]];

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
  const hits = crossCheck(40, [24, 26, 28, 30], 2024n);
  assert.ok((hits.get("pointing") ?? 0) > 0);
  assert.ok((hits.get("claiming") ?? 0) > 0);
});
