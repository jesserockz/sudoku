import assert from "node:assert/strict";
import { test } from "node:test";
import { CELLS } from "../src/core/geometry.ts";
import { Grader, TECHNIQUES } from "../src/generator/grader.ts";
import { removeCells } from "../src/generator/generator.ts";
import { Xoshiro256StarStar } from "../src/generator/random.ts";
import { randomSolution } from "../src/generator/solver.ts";
import { jellyfish, swordfish, xWing } from "../src/learn/finders/fish.ts";
import { type Finder, type State, bit } from "../src/learn/state.ts";

const cell = (row: number, col: number): number => (row - 1) * 9 + (col - 1);

/** An empty board where `digit` is a candidate in exactly the given (row, column) cells. */
function places(digit: number, spots: [number, number][]): State {
  const cand = new Array<number>(CELLS).fill(0);
  for (const [r, c] of spots) cand[cell(r, c)] = bit(digit);
  return { grid: new Array<number>(CELLS).fill(0), cand };
}

const transpose = (spots: [number, number][]): [number, number][] => spots.map(([r, c]) => [c, r]);

test("xWing: two rows with the same two columns clear the columns", () => {
  const state = places(4, [[2, 3], [2, 7], [6, 3], [6, 7], [4, 3], [8, 7], [4, 5]]);
  const steps = xWing(state);
  assert.equal(steps.length, 1);
  const step = steps[0]!;
  assert.equal(step.technique, "xWing");
  assert.equal(step.place, null);
  assert.deepEqual(step.eliminations, [{ cell: cell(4, 3), digit: 4 }, { cell: cell(8, 7), digit: 4 }]);
  assert.deepEqual(step.marks, [
    { cell: cell(2, 3), role: "pattern", digits: [4] },
    { cell: cell(2, 7), role: "pattern", digits: [4] },
    { cell: cell(6, 3), role: "pattern", digits: [4] },
    { cell: cell(6, 7), role: "pattern", digits: [4] },
  ]);
  assert.deepEqual(step.units, [1, 5, 11, 15]);
  assert.equal(step.reason.length, 3);
  assert.match(step.reason[0]!, /4s in rows 2 and 6.*columns 3 and 7/);
  assert.match(step.reason[1]!, /X-Wing/);
  assert.match(step.reason[2]!, /4 can be removed.*R4C3 and R8C7/);
  assert.match(step.nudge, /4.*two rows.*two columns/);
});

test("xWing: works on columns too", () => {
  const state = places(9, transpose([[2, 3], [2, 7], [6, 3], [6, 7], [4, 3], [8, 7]]));
  const steps = xWing(state);
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0]!.eliminations, [{ cell: cell(3, 4), digit: 9 }, { cell: cell(7, 8), digit: 9 }]);
  assert.deepEqual(steps[0]!.units, [10, 14, 2, 6]);
  assert.match(steps[0]!.reason[0]!, /columns 2 and 6.*rows 3 and 7/);
  assert.match(steps[0]!.nudge, /two columns.*two rows/);
});

test("xWing: needs the lines to share columns and something to remove", () => {
  // Rows cover three columns; a row has three places; the pattern has nothing to clear.
  assert.deepEqual(xWing(places(4, [[2, 3], [2, 7], [6, 3], [6, 8]])), []);
  assert.deepEqual(xWing(places(4, [[2, 3], [2, 7], [2, 9], [6, 3], [6, 7], [4, 3]])), []);
  assert.deepEqual(xWing(places(4, [[2, 3], [2, 7], [6, 3], [6, 7]])), []);
});

test("swordfish: three rows over three columns, with rows of two or three places", () => {
  const state = places(2, [[1, 1], [1, 4], [4, 4], [4, 8], [7, 1], [7, 4], [7, 8], [2, 1], [5, 8], [9, 4]]);
  const steps = swordfish(state);
  assert.equal(steps.length, 1);
  const step = steps[0]!;
  assert.equal(step.technique, "swordfish");
  assert.deepEqual(step.eliminations, [{ cell: cell(2, 1), digit: 2 }, { cell: cell(5, 8), digit: 2 }, { cell: cell(9, 4), digit: 2 }]);
  assert.deepEqual(step.marks.map((m) => m.cell), [cell(1, 1), cell(1, 4), cell(4, 4), cell(4, 8), cell(7, 1), cell(7, 4), cell(7, 8)]);
  assert.deepEqual(step.units, [0, 3, 6, 9, 12, 16]);
  assert.match(step.reason[0]!, /2s in rows 1, 4 and 7.*columns 1, 4 and 8/);
  assert.match(step.reason[1]!, /Swordfish/);
  assert.match(step.nudge, /three rows.*three columns/);
});

test("swordfish: works on columns and ignores a fish of the wrong size", () => {
  const spots: [number, number][] = [[1, 1], [1, 4], [4, 4], [4, 8], [7, 1], [7, 8], [2, 1]];
  const steps = swordfish(places(2, transpose(spots)));
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0]!.eliminations, [{ cell: cell(1, 2), digit: 2 }]);
  assert.match(steps[0]!.reason[0]!, /columns 1, 4 and 7.*rows 1, 4 and 8/);
  // Four rows over four columns is no swordfish.
  assert.deepEqual(swordfish(places(2, [[1, 1], [1, 2], [3, 2], [3, 3], [5, 3], [5, 4], [7, 4], [7, 1], [9, 1]])), []);
});

test("jellyfish: four rows over four columns", () => {
  const state = places(6, [[1, 1], [1, 2], [3, 2], [3, 3], [5, 3], [5, 4], [7, 4], [7, 1], [9, 2], [8, 4]]);
  const steps = jellyfish(state);
  assert.equal(steps.length, 1);
  const step = steps[0]!;
  assert.equal(step.technique, "jellyfish");
  assert.deepEqual(step.eliminations, [{ cell: cell(8, 4), digit: 6 }, { cell: cell(9, 2), digit: 6 }]);
  assert.deepEqual(step.units, [0, 2, 4, 6, 9, 10, 11, 12]);
  assert.match(step.reason[0]!, /6s in rows 1, 3, 5 and 7.*columns 1, 2, 3 and 4/);
  assert.match(step.reason[1]!, /Jellyfish/);
  assert.match(step.reason[2]!, /R8C4 and R9C2/);
  assert.match(step.nudge, /four rows.*four columns/);
});

// Cross-check against the grader on real puzzles.

const finders: [string, Finder][] = [["xWing", xWing], ["swordfish", swordfish]];

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
      const jelly = jellyfish(state);
      const t = g.step();
      // Jellyfish is not in the grader, but like any fish it never removes a true candidate.
      for (const step of jelly) for (const e of step.eliminations) assert.notEqual(solution[e.cell], e.digit);
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
  const hits = crossCheck(60, [20, 22, 24, 26], 99n);
  assert.ok((hits.get("xWing") ?? 0) > 0);
});
