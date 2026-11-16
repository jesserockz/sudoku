import assert from "node:assert/strict";
import { test } from "node:test";
import { removeCells } from "../src/generator/generator.ts";
import { Grader, TECHNIQUES } from "../src/generator/grader.ts";
import { Xoshiro256StarStar } from "../src/generator/random.ts";
import { randomSolution } from "../src/generator/solver.ts";
import { simpleColouring, xChain } from "../src/learn/finders/colouring.ts";
import { type State, bit, parseGrid } from "../src/learn/state.ts";

const rc = (row: number, col: number): number => row * 9 + col;

/** An empty grid where `digit` is a candidate in just `cells`. */
function only(digit: number, cells: readonly number[]): State {
  const cand = new Array<number>(81).fill(0);
  for (const c of cells) cand[c] = bit(digit);
  return { grid: new Array<number>(81).fill(0), cand };
}

const positionAt = (givens: string, steps: number): State => {
  const g = new Grader(parseGrid(givens));
  for (let i = 0; i < steps; i++) g.step();
  return { grid: [...g.grid], cand: [...g.cand] };
};
const cells = (steps: { eliminations: { cell: number; digit: number }[] }[]): number[][] => steps.map((s) => s.eliminations.map((e) => e.cell));

const SIMPLE_COLOURING = TECHNIQUES.findIndex((t) => t.name === "simpleColouring");

test("simpleColouring: colour wrap on colour A", () => {
  // Chain R1C1 = R1C6 = R5C6 = R5C2 = R2C2 (rows and columns); R1C1 and R2C2 (colour A) share box 1,
  // and R3C3 makes box 1 hold three places so it is not a link.
  const chain = [rc(0, 0), rc(0, 5), rc(4, 5), rc(4, 1), rc(1, 1)];
  const steps = simpleColouring(only(7, [...chain, rc(2, 2)]));
  assert.equal(steps.length, 1);
  const s = steps[0]!;
  assert.equal(s.technique, "simpleColouring");
  assert.equal(s.place, null);
  assert.deepEqual(s.eliminations, [rc(0, 0), rc(1, 1), rc(4, 5)].map((cell) => ({ cell, digit: 7 })));
  assert.deepEqual(s.marks, [
    { cell: rc(0, 0), role: "colourA", digits: [7] },
    { cell: rc(0, 5), role: "colourB", digits: [7] },
    { cell: rc(1, 1), role: "colourA", digits: [7] },
    { cell: rc(4, 1), role: "colourB", digits: [7] },
    { cell: rc(4, 5), role: "colourA", digits: [7] },
  ]);
  assert.deepEqual(s.units, [0, 4, 10, 14]);
  assert.equal(s.reason.length, 3);
  assert.match(s.reason[0]!, /^Colour the 7s of this chain in two colours/);
  assert.match(s.reason[0]!, /R1C1, R2C2 and R5C6 in colour A and R1C6 and R5C2 in colour B/);
  assert.match(s.reason[1]!, /R1C1 and R2C2 are both colour A and see each other/);
  assert.match(s.reason[2]!, /remove 7 from every colour A square: R1C1, R2C2 and R5C6/);
  assert.match(s.nudge, /Look at 7/);
});

test("simpleColouring: colour wrap on colour B", () => {
  // The same chain one row down with R1C1 joined on above it, so the lowest cell is colour A and R2C1 and R3C2 are colour B.
  const chain = [rc(0, 0), rc(1, 0), rc(1, 5), rc(5, 5), rc(5, 1), rc(2, 1)];
  const steps = simpleColouring(only(7, chain));
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0]!.eliminations.map((e) => e.cell), [rc(1, 0), rc(5, 5), rc(2, 1)].sort((a, b) => a - b));
  assert.match(steps[0]!.reason[1]!, /both colour B and see each other/);
  assert.match(steps[0]!.reason[2]!, /every colour B square/);
});

test("simpleColouring: nothing in a chain that neither wraps nor traps", () => {
  assert.deepEqual(simpleColouring(only(7, [rc(0, 0), rc(0, 5), rc(4, 5)])), []);
  assert.deepEqual(simpleColouring(only(7, [])), []);
});

test("simpleColouring: colour trap with one square", () => {
  const state = positionAt("790004010008030700036900000940800027060000301007000000000040006000590100000600900", 10);
  const steps = simpleColouring(state);
  assert.equal(steps.length, 1);
  const s = steps[0]!;
  assert.deepEqual(s.eliminations, [{ cell: 49, digit: 6 }]);
  assert.deepEqual(s.marks.map((m) => [m.cell, m.role]), [[4, "colourA"], [6, "colourB"], [14, "colourB"], [16, "colourA"], [52, "colourB"]]);
  assert.match(s.reason[1]!, /R6C5 sees both R1C5 \(colour A\) and R6C8 \(colour B\), so whichever colour is real/);
  assert.equal(s.reason[2], "So R6C5 cannot be 6: remove 6 from R6C5.");
});

test("simpleColouring: colour trap with several squares", () => {
  const state = positionAt("073920000040000300008001000600300900030050060007000200760490003000708620000000090", 31);
  const steps = simpleColouring(state);
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0]!.eliminations, [{ cell: 38, digit: 2 }, { cell: 73, digit: 2 }]);
  assert.match(steps[0]!.reason[1]!, /and so do the other squares named at the end/);
  assert.match(steps[0]!.reason[2]!, /^So those squares cannot be 2: remove 2 from R5C3 and R9C2\.$/);
});

test("simpleColouring: colour wrap in a real position", () => {
  const steps = simpleColouring(positionAt("000420600020050000806000007500068040000000901097000000080010000003002800100004070", 20));
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0]!.eliminations.map((e) => e.cell), [17, 19, 36, 56, 60]);
  assert.match(steps[0]!.reason[1]!, /R7C3 and R7C7 are both colour B/);
});

/** Random puzzles walked with the grader, calling `visit` on every position along the way. */
function walk(seed: bigint, puzzles: number, visit: (state: State, solution: number[], nextTechnique: number) => void): void {
  const random = new Xoshiro256StarStar(seed);
  for (let n = 0; n < puzzles; n++) {
    const solution = randomSolution(new Array<number>(81).fill(0), random)!;
    const g = new Grader(removeCells(solution, 22 + (n % 4), random));
    for (;;) {
      const state: State = { grid: [...g.grid], cand: [...g.cand] };
      // Which technique the grader would use here, found on a copy.
      const peek = new Grader(state.grid);
      state.cand.forEach((mask, i) => (peek.cand[i] = mask));
      const next = peek.step();
      visit(state, solution, next);
      if (g.step() < 0) break;
    }
  }
}

test("simpleColouring agrees with the grader", () => {
  let fired = 0;
  walk(5n, 40, (state, _solution, next) => {
    const steps = simpleColouring(state);
    // Where the grader reaches simple colouring it must find one; where it gets past it (to XY-chain or stuck) there is none.
    if (next === SIMPLE_COLOURING) {
      fired++;
      assert.ok(steps.length > 0);
    } else if (next > SIMPLE_COLOURING || next < 0) {
      assert.deepEqual(steps, []);
    }
    for (const s of steps) assert.ok(s.eliminations.length > 0);
  });
  assert.ok(fired > 3);
});

test("simpleColouring steps are sound", () => {
  walk(7n, 25, (state, solution) => {
    for (const s of simpleColouring(state)) {
      for (const e of s.eliminations) {
        assert.ok((state.cand[e.cell]! & bit(e.digit)) !== 0);
        assert.notEqual(solution[e.cell], e.digit);
      }
      assert.ok(s.reason.length === 3);
    }
  });
});

test("xChain: two strong links", () => {
  // Rows 2 and 3 have 5 only at C1/C5 and C1/C6: R2C5 = R2C1 - R3C1 = R3C6, so R1C4 (seeing both ends) loses 5.
  // The same chain read backwards from R3C6 gives the same removal and is dropped.
  const steps = xChain(only(5, [rc(1, 0), rc(1, 4), rc(2, 0), rc(2, 5), rc(0, 3)]));
  assert.equal(steps.length, 1);
  const s = steps[0]!;
  assert.equal(s.technique, "xChain");
  assert.equal(s.place, null);
  assert.deepEqual(s.eliminations, [{ cell: rc(0, 3), digit: 5 }]);
  assert.deepEqual(s.marks, [
    { cell: rc(1, 4), role: "colourB", digits: [5] },
    { cell: rc(1, 0), role: "colourA", digits: [5] },
    { cell: rc(2, 0), role: "colourB", digits: [5] },
    { cell: rc(2, 5), role: "colourA", digits: [5] },
  ]);
  assert.deepEqual(s.units, [1, 2]);
  assert.equal(s.reason.length, 3);
  assert.match(s.reason[0]!, /this chain: R2C5 = R2C1 - R3C1 = R3C6\./);
  assert.match(s.reason[0]!, /\(row 2, row 3\)/);
  assert.match(s.reason[1]!, /If R2C5 is not 5, then R2C1 is, so R3C1 is not/);
  assert.match(s.reason[1]!, /at least one of R2C5 and R3C6 is 5/);
  assert.match(s.reason[2]!, /remove 5 from R1C4\.$/);
  assert.match(s.nudge, /Look at 5/);
});

test("xChain: nothing when no cell sees both ends, or the chain has no way on", () => {
  assert.deepEqual(xChain(only(5, [rc(1, 0), rc(1, 4), rc(2, 0), rc(2, 5)])), []);
  assert.deepEqual(xChain(only(5, [rc(1, 0), rc(1, 4)])), []);
});

test("xChain: three and four strong links in real positions", () => {
  const three = xChain(positionAt("000010020706002050008600000000000902009070000630000400010908006803400500060000000", 30));
  assert.deepEqual(three.map((s) => s.marks.length), [4, 4, 4, 6, 6, 6, 6, 6]);
  const first3 = three.find((s) => s.marks.length === 6)!;
  assert.deepEqual(first3.eliminations, [{ cell: 30, digit: 8 }]);
  assert.match(first3.reason[0]!, /R1C4 = R1C9 - R2C7 = R5C7 - R5C2 = R4C2\./);
  assert.deepEqual(first3.units, [0, 15, 10]);
  assert.deepEqual(first3.marks.map((m) => m.role), ["colourB", "colourA", "colourB", "colourA", "colourB", "colourA"]);

  const four = xChain(positionAt("080600000002000006000005209708050690001000000000049007600020500003001000200000170", 17));
  const first4 = four.find((s) => s.marks.length === 8)!;
  assert.deepEqual(first4.eliminations.map((e) => [e.cell, e.digit]), [[9, 4], [10, 4], [12, 4], [16, 4]]);
  assert.match(first4.reason[0]!, /R2C6 = R9C6 - R8C4 = R8C2 - R4C2 = R4C9 - R5C7 = R2C7\./);
  assert.match(first4.reason[2]!, /remove 4 from R2C1, R2C2, R2C4 and R2C8\./);
  assert.equal(four.filter((s) => s.marks.length > 8).length, 0);
});

test("xChain steps are sound, shortest first, and never repeat a removal", () => {
  let chains = 0;
  walk(9n, 25, (state, solution) => {
    const steps = xChain(state);
    let last = 0;
    const seen = new Set<string>();
    for (const s of steps) {
      chains++;
      assert.ok(s.marks.length >= 4 && s.marks.length <= 8 && s.marks.length % 2 === 0);
      assert.ok(s.marks.length >= last);
      last = s.marks.length;
      const digit = s.marks[0]!.digits![0]!;
      const key = `${digit}:${s.eliminations.map((e) => e.cell).join(",")}`;
      assert.ok(!seen.has(key));
      seen.add(key);
      assert.ok(s.eliminations.length > 0);
      assert.equal(new Set(s.marks.map((m) => m.cell)).size, s.marks.length);
      for (const e of s.eliminations) {
        assert.equal(e.digit, digit);
        assert.ok((state.cand[e.cell]! & bit(e.digit)) !== 0);
        assert.notEqual(solution[e.cell], e.digit);
      }
    }
  });
  assert.ok(chains > 0);
});
