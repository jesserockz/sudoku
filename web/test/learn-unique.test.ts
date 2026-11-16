import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { removeCells } from "../src/generator/generator.ts";
import { Grader } from "../src/generator/grader.ts";
import { Xoshiro256StarStar } from "../src/generator/random.ts";
import { randomSolution } from "../src/generator/solver.ts";
import { uniqueRectangle } from "../src/learn/finders/unique.ts";
import { type State, bit, parseGrid } from "../src/learn/state.ts";

/** An empty grid whose only candidates are the ones given, as digit lists by cell. */
function mk(cells: Record<number, number[]>): State {
  const cand = new Array<number>(81).fill(0);
  for (const [cell, digits] of Object.entries(cells)) cand[Number(cell)] = digits.reduce((m, d) => m | bit(d), 0);
  return { grid: new Array<number>(81).fill(0), cand };
}

// R1C1, R1C4, R2C1 and R2C4: a rectangle across boxes 1 and 2.
const RECT = { 0: [3, 8], 3: [3, 8], 9: [3, 8], 12: [3, 8, 5] };

test("uniqueRectangle: three {3,8} corners and a fourth with more lose 3 and 8 from the fourth", () => {
  const steps = uniqueRectangle(mk(RECT));
  assert.equal(steps.length, 1);
  const step = steps[0]!;
  assert.equal(step.technique, "uniqueRectangle");
  assert.equal(step.place, null);
  assert.deepEqual(step.eliminations, [{ cell: 12, digit: 3 }, { cell: 12, digit: 8 }]);
  assert.deepEqual(step.marks, [
    { cell: 0, role: "pattern", digits: [3, 8] },
    { cell: 3, role: "pattern", digits: [3, 8] },
    { cell: 9, role: "pattern", digits: [3, 8] },
    { cell: 12, role: "pivot", digits: [3, 8] },
  ]);
  assert.deepEqual(step.units, [18, 19]);
  assert.equal(step.reason.length, 3);
  assert.match(step.reason[0]!, /R1C1, R1C4 and R2C1 can each only be 3 or 8.*R2C4.*box 1 and box 2/);
  assert.match(step.reason[1]!, /only one solution/);
  assert.equal(step.reason[2], "So R2C4 is neither 3 nor 8: remove them from it.");
  assert.ok(step.nudge.length > 0);
});

test("uniqueRectangle: works for the odd corner at any position, in columns too", () => {
  // Rows 1 and 4 (boxes 1 and 4), columns 1 and 2: corners 0, 1, 27, 28; the odd one first.
  const steps = uniqueRectangle(mk({ 0: [1, 2, 9], 1: [1, 2], 27: [1, 2], 28: [1, 2] }));
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0]!.eliminations, [{ cell: 0, digit: 1 }, { cell: 0, digit: 2 }]);
  assert.deepEqual(steps[0]!.marks.map((m) => m.cell), [1, 27, 28, 0]);
  assert.deepEqual(steps[0]!.units, [18, 21]);
});

test("uniqueRectangle: needs two boxes, empty cells and the right candidates", () => {
  // All four corners in one box.
  assert.deepEqual(uniqueRectangle(mk({ 0: [3, 8], 1: [3, 8], 9: [3, 8], 10: [3, 8, 5] })), []);
  // Four boxes.
  assert.deepEqual(uniqueRectangle(mk({ 0: [3, 8], 4: [3, 8], 36: [3, 8], 40: [3, 8, 5] })), []);
  // A corner is filled.
  assert.deepEqual(uniqueRectangle({ ...mk(RECT), grid: Object.assign(new Array<number>(81).fill(0), { 0: 3 }) }), []);
  // No corner has extra candidates.
  assert.deepEqual(uniqueRectangle(mk({ 0: [3, 8], 3: [3, 8], 9: [3, 8], 12: [3, 8] })), []);
  // The three do not hold the same pair.
  assert.deepEqual(uniqueRectangle(mk({ ...RECT, 9: [3, 7] })), []);
  assert.deepEqual(uniqueRectangle(mk({ ...RECT, 9: [3, 8, 6] })), []);
  // The fourth lacks one of the pair.
  assert.deepEqual(uniqueRectangle(mk({ ...RECT, 12: [3, 5, 6] })), []);
});

const GIVENS = "000000020000439000000000050050003201900680000002700060400000000700000008006870510";

test("uniqueRectangle: a real position", () => {
  const g = new Grader(parseGrid(GIVENS));
  for (let i = 0; i < 50; i++) g.step();
  const steps = uniqueRectangle({ grid: [...g.grid], cand: [...g.cand] });
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0]!.eliminations, [{ cell: 59, digit: 1 }, { cell: 59, digit: 5 }]);
  assert.deepEqual(steps[0]!.marks.map((m) => m.cell), [49, 50, 58, 59]);
});

const fixture = JSON.parse(readFileSync(new URL("../../testdata/generator-v2.json", import.meta.url), "utf8")) as { grader: { givens: string }[] };

test("uniqueRectangle never removes a true candidate on proper puzzles", () => {
  const random = new Xoshiro256StarStar(555n);
  let fired = 0;
  const puzzles = fixture.grader.map((c) => parseGrid(c.givens)).map((givens) => ({ givens, solution: randomSolution(givens, random)! }));
  for (let n = 0; n < 24; n++) {
    const solution = randomSolution(new Array<number>(81).fill(0), random)!;
    puzzles.push({ givens: removeCells(solution, 20 + (n % 8), random), solution });
  }
  for (const { givens, solution } of puzzles) {
    const g = new Grader(givens);
    while (g.placed < 81) {
      for (const step of uniqueRectangle({ grid: [...g.grid], cand: [...g.cand] })) {
        fired++;
        assert.ok(step.eliminations.length > 0);
        for (const e of step.eliminations) assert.notEqual(solution[e.cell], e.digit, "removed a true candidate");
      }
      if (g.step() < 0) break;
    }
  }
  assert.ok(fired > 0);
});
