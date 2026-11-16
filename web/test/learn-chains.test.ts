import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { removeCells } from "../src/generator/generator.ts";
import { Grader, MAX_CHAIN } from "../src/generator/grader.ts";
import { Xoshiro256StarStar } from "../src/generator/random.ts";
import { randomSolution } from "../src/generator/solver.ts";
import { xyChain } from "../src/learn/finders/chains.ts";
import { type State, bit, parseGrid } from "../src/learn/state.ts";

/** An empty grid whose only candidates are the ones given, as digit lists by cell. */
function mk(cells: Record<number, number[]>): State {
  const cand = new Array<number>(81).fill(0);
  for (const [cell, digits] of Object.entries(cells)) cand[Number(cell)] = digits.reduce((m, d) => m | bit(d), 0);
  return { grid: new Array<number>(81).fill(0), cand };
}

test("xyChain: three cells make the classic wing", () => {
  // R1C1 {1,2} - R1C5 {2,3} - R5C5 {3,1}: if R1C1 is not 1 then R5C5 is.
  const steps = xyChain(mk({ 0: [1, 2], 4: [2, 3], 40: [1, 3], 36: [1, 7], 8: [1, 8] }));
  assert.equal(steps.length, 1);
  const step = steps[0]!;
  assert.equal(step.technique, "xyChain");
  assert.equal(step.place, null);
  assert.deepEqual(step.eliminations, [{ cell: 36, digit: 1 }]);
  assert.deepEqual(step.marks, [
    { cell: 0, role: "colourA", digits: [1, 2] },
    { cell: 4, role: "colourB", digits: [2, 3] },
    { cell: 40, role: "colourA", digits: [1, 3] },
  ]);
  assert.deepEqual(step.units, [0, 13]);
  assert.equal(step.reason.length, 3);
  assert.match(step.reason[0]!, /R1C1 \(1\/2\), R1C5 \(2\/3\), R5C5 \(1\/3\)/);
  assert.equal(step.reason[1], "If R1C1 is not 1 it is 2, so R1C5 is not 2 and must be 3, so R5C5 is not 3 and must be 1.");
  assert.match(step.reason[2]!, /either R1C1 or R5C5 is 1.*remove 1 from R5C1\./);
  assert.ok(step.nudge.length > 0);
});

test("xyChain: nothing without a digit to remove or a closing end", () => {
  assert.deepEqual(xyChain(mk({ 0: [1, 2], 4: [2, 3], 40: [1, 3] })), []);
  // The last cell does not hand back the first digit.
  assert.deepEqual(xyChain(mk({ 0: [1, 2], 4: [2, 3], 40: [3, 4], 36: [1, 7] })), []);
  // Two cells are not a chain.
  assert.deepEqual(xyChain(mk({ 0: [1, 2], 4: [1, 2], 8: [1, 7] })), []);
});

// A path of cells in which only consecutive ones see each other (found by search); the ends see 54 / 63.
const PATH = [0, 1, 28, 30, 12, 15, 25, 61, 71];

/** The first `length` cells of PATH as a chain of pairs {1,2}, {2,3}, ... closing with {length, 1}, and a cell with a 1 that sees both ends. */
function chainOf(length: number, target: number): State {
  const cells: Record<number, number[]> = { [target]: [1] };
  for (let i = 0; i < length; i++) cells[PATH[i]!] = [i + 1, i + 2 > length ? 1 : i + 2];
  return mk(cells);
}

test("xyChain: chains are at most MAX_CHAIN cells long", () => {
  assert.equal(MAX_CHAIN, 8);
  const eight = xyChain(chainOf(8, 54));
  assert.equal(eight.length, 1);
  assert.deepEqual(eight[0]!.marks.map((m) => m.cell), PATH.slice(0, 8));
  assert.deepEqual(eight[0]!.marks.map((m) => m.role), ["colourA", "colourB", "colourA", "colourB", "colourA", "colourB", "colourA", "colourB"]);
  assert.deepEqual(eight[0]!.eliminations, [{ cell: 54, digit: 1 }]);
  assert.deepEqual(xyChain(chainOf(9, 63)), []);
});

// Real positions and the cross-check with the grader.
const GIVENS = "000000020000439000000000050050003201900680000002700060400000000700000008006870510";

test("xyChain: a real position lists shortest chains first and never repeats eliminations", () => {
  const g = new Grader(parseGrid(GIVENS));
  for (let i = 0; i < 16; i++) g.step();
  const steps = xyChain({ grid: [...g.grid], cand: [...g.cand] });
  assert.ok(steps.length >= 2);
  const lengths = steps.map((s) => s.marks.length);
  assert.deepEqual(lengths, [...lengths].sort((a, b) => a - b));
  const keys = steps.map((s) => JSON.stringify(s.eliminations));
  assert.equal(new Set(keys).size, keys.length);
  for (const s of steps) {
    assert.deepEqual(s.eliminations, [...s.eliminations].sort((a, b) => a.cell - b.cell || a.digit - b.digit));
    assert.ok(s.marks.length >= 3 && s.marks.length <= MAX_CHAIN);
  }
});

const fixture = JSON.parse(readFileSync(new URL("../../testdata/generator-v2.json", import.meta.url), "utf8")) as { grader: { givens: string }[] };

function puzzles(): { givens: number[]; solution: number[] }[] {
  const random = new Xoshiro256StarStar(77n);
  const out = fixture.grader.map((c) => parseGrid(c.givens)).map((givens) => ({ givens, solution: randomSolution(givens, random)! }));
  for (let n = 0; n < 24; n++) {
    const solution = randomSolution(new Array<number>(81).fill(0), random)!;
    out.push({ givens: removeCells(solution, 20 + (n % 8), random), solution });
  }
  return out;
}

test("xyChain fires exactly where the grader's does and is sound", () => {
  let agreed = 0;
  for (const { givens, solution } of puzzles()) {
    const g = new Grader(givens);
    while (g.placed < 81) {
      const state: State = { grid: [...g.grid], cand: [...g.cand] };
      const peek = new Grader(givens);
      peek.grid.set(state.grid);
      peek.cand.set(state.cand);
      const t = peek.step();
      const steps = xyChain(state);
      if (t === 15) {
        assert.ok(steps.length > 0, "xyChain should fire");
        agreed++;
      }
      if (steps.length > 0) assert.ok(t >= 0, "grader found nothing");
      for (const step of steps) for (const e of step.eliminations) assert.notEqual(solution[e.cell], e.digit, "removed a true candidate");
      if (g.step() < 0) break;
    }
  }
  assert.ok(agreed > 0);
});
