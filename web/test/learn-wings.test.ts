import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { removeCells } from "../src/generator/generator.ts";
import { Grader } from "../src/generator/grader.ts";
import { Xoshiro256StarStar } from "../src/generator/random.ts";
import { randomSolution } from "../src/generator/solver.ts";
import { wWing, xyWing, xyzWing } from "../src/learn/finders/wings.ts";
import { type Finder, type State, bit, parseGrid, stateOf } from "../src/learn/state.ts";

/** An empty grid whose only candidates are the ones given, as digit lists by cell. */
function mk(cells: Record<number, number[]>): State {
  const cand = new Array<number>(81).fill(0);
  for (const [cell, digits] of Object.entries(cells)) cand[Number(cell)] = digits.reduce((m, d) => m | bit(d), 0);
  return { grid: new Array<number>(81).fill(0), cand };
}

const elim = (cell: number, digit: number): { cell: number; digit: number } => ({ cell, digit });

test("xyWing: pivot {1,2} with wings {1,3} and {2,3} removes 3 where both wings are seen", () => {
  const state = mk({ 0: [1, 2], 4: [1, 3], 18: [2, 3], 2: [3, 5], 22: [3, 4], 20: [3, 6], 3: [1, 2], 5: [5, 6], 6: [1, 2, 3], 7: [2, 4] });
  const steps = xyWing(state);
  assert.equal(steps.length, 1);
  const step = steps[0]!;
  assert.equal(step.technique, "xyWing");
  assert.equal(step.place, null);
  assert.deepEqual(step.eliminations, [elim(2, 3), elim(22, 3)]);
  assert.deepEqual(step.marks, [
    { cell: 0, role: "pivot", digits: [1, 2] },
    { cell: 4, role: "wing", digits: [1, 3] },
    { cell: 18, role: "wing", digits: [2, 3] },
  ]);
  assert.deepEqual(step.units, [0, 9]);
  assert.equal(step.reason.length, 3);
  assert.match(step.reason[0]!, /R1C1 can only be 1 or 2\. It sees R1C5, which can only be 1 or 3, and R3C1/);
  assert.match(step.reason[2]!, /3 can be removed from every square that sees both: R1C3 and R3C5\./);
  assert.ok(step.nudge.length > 0);
});

test("xyWing: needs a candidate to remove and matching wings", () => {
  assert.deepEqual(xyWing(mk({ 0: [1, 2], 4: [1, 3], 18: [2, 3] })), []);
  // The wings do not agree on z.
  assert.deepEqual(xyWing(mk({ 0: [1, 2], 4: [1, 3], 18: [2, 4], 2: [3, 4] })), []);
  assert.deepEqual(xyWing(stateOf(parseGrid(".".repeat(81)))), []);
});

test("xyzWing: pivot {1,2,3} with wings {1,3} and {2,3} removes 3 from cells seeing all three", () => {
  const state = mk({ 0: [1, 2, 3], 1: [1, 3], 9: [2, 3], 2: [3, 5], 20: [3, 4], 4: [3, 6] });
  const steps = xyzWing(state);
  assert.equal(steps.length, 1);
  const step = steps[0]!;
  assert.equal(step.technique, "xyzWing");
  assert.equal(step.place, null);
  assert.deepEqual(step.eliminations, [elim(2, 3), elim(20, 3)]);
  assert.deepEqual(step.marks, [
    { cell: 0, role: "pivot", digits: [1, 2, 3] },
    { cell: 1, role: "wing", digits: [1, 3] },
    { cell: 9, role: "wing", digits: [2, 3] },
  ]);
  assert.deepEqual(step.units, [0, 9]);
  assert.equal(step.reason.length, 3);
  assert.match(step.reason[2]!, /3 can be removed from R1C3 and R3C3\./);
  assert.ok(step.nudge.length > 0);
});

test("xyzWing: rejects wings that are not inside the pivot, equal wings and a lone cell to remove from", () => {
  assert.deepEqual(xyzWing(mk({ 0: [1, 2, 3], 1: [1, 3], 2: [1, 3], 3: [3, 5] })), []);
  assert.deepEqual(xyzWing(mk({ 0: [1, 2, 3], 1: [1, 5], 9: [2, 3], 2: [3, 5] })), []);
  assert.deepEqual(xyzWing(mk({ 0: [1, 2, 3], 1: [1, 2, 3], 9: [2, 3, 4], 2: [3, 5] })), []);
  // A valid wing pair with nothing left to remove.
  assert.deepEqual(xyzWing(mk({ 0: [1, 2, 3], 1: [1, 3], 9: [2, 3] })), []);
});

/**
 * Two {1,2} cells that don't see each other, R1C1 and R5C9, with a link on 1 in column 5 (R1C5 and R5C5),
 * and the cells seeing both holding a 2 to remove.
 */
const wState = (): Record<number, number[]> => ({ 0: [1, 2], 44: [1, 2], 4: [1, 5], 40: [1, 6], 8: [2, 5], 36: [2, 6] });

test("wWing: two matching cells joined by a strong link remove the other digit where both are seen", () => {
  const steps = wWing(mk(wState()));
  assert.equal(steps.length, 1);
  const step = steps[0]!;
  assert.equal(step.technique, "wWing");
  assert.equal(step.place, null);
  assert.deepEqual(step.eliminations, [elim(8, 2), elim(36, 2)]);
  assert.deepEqual(step.marks, [
    { cell: 0, role: "wing", digits: [1, 2] },
    { cell: 44, role: "wing", digits: [1, 2] },
    { cell: 4, role: "pattern", digits: [1] },
    { cell: 40, role: "pattern", digits: [1] },
  ]);
  assert.deepEqual(step.units, [13]);
  assert.equal(step.reason.length, 3);
  assert.match(step.reason[0]!, /In column 5, 1 can only go in R1C5 or R5C5, and R1C5 sees R1C1 while R5C5 sees R5C9\./);
  assert.match(step.reason[2]!, /remove 2 from R1C9 and R5C1\./);
  assert.ok(step.nudge.length > 0);
});

test("wWing: finds the link when the lower cell of it sees the second wing", () => {
  // R3C1 and R5C9; link in box 3 (R1C9 sees R5C9, R3C7 sees R3C1).
  const steps = wWing(mk({ 18: [1, 2], 44: [1, 2], 8: [1, 5], 24: [1, 6], 26: [2, 5], 36: [2, 6] }));
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0]!.eliminations, [elim(26, 2), elim(36, 2)]);
  assert.deepEqual(steps[0]!.marks.map((m) => m.cell), [18, 44, 24, 8]);
  assert.deepEqual(steps[0]!.units, [20]);
});

test("wWing: no step when a condition fails", () => {
  const base = wState();
  // The two cells see each other (R1C1 and R1C9).
  assert.deepEqual(wWing(mk({ ...base, 44: [], 8: [1, 2] })), []);
  // The cells differ.
  assert.deepEqual(wWing(mk({ ...base, 44: [1, 3] })), []);
  // The link unit has three places for 1.
  assert.deepEqual(wWing(mk({ ...base, 13: [1, 7] })), []);
  // One end of the link doesn't see its wing (R5C5 replaced by R6C5, which sees neither).
  assert.deepEqual(wWing(mk({ ...base, 40: [], 49: [1, 6] })), []);
  // A link that is one of the wings' own rows only.
  assert.deepEqual(wWing(mk({ ...base, 4: [], 40: [] })), []);
  // Nothing to remove.
  assert.deepEqual(wWing(mk({ ...base, 8: [], 36: [] })), []);
});

// Real positions.
const GIVENS = "000000020000439000000000050050003201900680000002700060400000000700000008006870510";
const walk = (givens: string, steps: number): State => {
  const g = new Grader(parseGrid(givens));
  for (let i = 0; i < steps; i++) g.step();
  return { grid: [...g.grid], cand: [...g.cand] };
};

test("wWing: a real position", () => {
  const steps = wWing(walk(GIVENS, 36));
  assert.deepEqual(steps.map((s) => s.eliminations), [[elim(59, 5)], [elim(59, 1)]]);
  assert.deepEqual(steps[0]!.marks.map((m) => m.cell), [50, 56, 49, 58]);
});

// Cross-check with the grader and soundness against the solution.

const fixture = JSON.parse(readFileSync(new URL("../../testdata/generator-v2.json", import.meta.url), "utf8")) as { grader: { givens: string }[] };

/** Puzzles to walk: the fixture's and a few random ones, each with its solution. */
function puzzles(): { givens: number[]; solution: number[] }[] {
  const random = new Xoshiro256StarStar(2024n);
  const out: { givens: number[]; solution: number[] }[] = fixture.grader.map((c) => parseGrid(c.givens)).map((givens) => ({ givens, solution: randomSolution(givens, random)! }));
  for (let n = 0; n < 24; n++) {
    const solution = randomSolution(new Array<number>(81).fill(0), random)!;
    out.push({ givens: removeCells(solution, 20 + (n % 8), random), solution });
  }
  return out;
}

/** The index of the technique the grader would apply to this position (-1 if none). */
function graderTechnique(state: State, givens: number[]): number {
  const peek = new Grader(givens);
  peek.grid.set(state.grid);
  peek.cand.set(state.cand);
  return peek.step();
}

test("xyWing and xyzWing fire exactly where the grader's do; every wing step is sound", () => {
  const wings: [Finder, number][] = [[xyWing, 12], [xyzWing, 13]];
  const seen = new Set<string>();
  for (const { givens, solution } of puzzles()) {
    const g = new Grader(givens);
    while (g.placed < 81) {
      const state: State = { grid: [...g.grid], cand: [...g.cand] };
      const t = graderTechnique(state, givens);
      for (const [finder, index] of wings) {
        const steps = finder(state);
        if (t === index) assert.ok(steps.length > 0, `finder ${index} should fire`);
        if (steps.length > 0) assert.ok(t >= 0 && t <= index, `grader found nothing at or before ${index}`);
        if (t === index) seen.add(String(index));
      }
      for (const step of [...xyWing(state), ...xyzWing(state), ...wWing(state)]) {
        assert.ok(step.eliminations.length > 0);
        for (const e of step.eliminations) assert.notEqual(solution[e.cell], e.digit, `${step.technique} removed a true candidate`);
      }
      if (g.step() < 0) break;
    }
  }
  assert.deepEqual([...seen].sort(), ["12", "13"]);
});
