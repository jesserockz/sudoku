import assert from "node:assert/strict";
import { test } from "node:test";
import { removeCells } from "../src/generator/generator.ts";
import { Grader } from "../src/generator/grader.ts";
import { Xoshiro256StarStar } from "../src/generator/random.ts";
import { randomSolution } from "../src/generator/solver.ts";
import { chainMarks, strongLinks } from "../src/learn/finders/turbot.ts";
import { emptyRectangle, skyscraper, twoStringKite } from "../src/learn/finders/turbot.ts";
import { type State, type Step, bit, parseGrid } from "../src/learn/state.ts";

const rc = (row: number, col: number): number => row * 9 + col;
const T = (cell: number): number => rc(cell % 9, Math.floor(cell / 9)); // transpose

/** An empty grid where `digit` is a candidate in just `cells`. */
function only(digit: number, cells: readonly number[]): State {
  const cand = new Array<number>(81).fill(0);
  for (const c of cells) cand[c] = bit(digit);
  return { grid: new Array<number>(81).fill(0), cand };
}

const elims = (steps: Step[]): number[][] => steps.map((s) => s.eliminations.map((e) => e.cell));
const positionAt = (givens: string, steps: number): State => {
  const g = new Grader(parseGrid(givens));
  for (let i = 0; i < steps; i++) g.step();
  return { grid: [...g.grid], cand: [...g.cand] };
};

test("strongLinks lists each pair once, under its row or column", () => {
  // R1C1 and R1C2 share row 1 and box 1: one link, under the row.
  const links = strongLinks(only(3, [0, 1]), 3);
  assert.deepEqual(links, [{ unit: 0, a: 0, b: 1 }]);
  assert.deepEqual(strongLinks(only(3, [0, 1, 2]), 3), []);
});

test("chainMarks alternates the two colours starting with B", () => {
  assert.deepEqual(chainMarks([4, 5, 6], 2).map((m) => m.role), ["colourB", "colourA", "colourB"]);
});

test("skyscraper: two rows lined up in one column", () => {
  // Row 2 has 5 at C1 and C5, row 3 at C1 and C6; the roofs R2C5 and R3C6 share box 2; R1C4 sees both.
  const state = only(5, [rc(1, 0), rc(1, 4), rc(2, 0), rc(2, 5), rc(0, 3)]);
  const steps = skyscraper(state);
  assert.equal(steps.length, 1);
  const s = steps[0]!;
  assert.equal(s.technique, "skyscraper");
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
  assert.match(s.reason[2]!, /remove 5 from R1C4/);
  assert.match(s.nudge, /two rows/);
});

test("skyscraper: two columns", () => {
  // The transposed pattern.
  const cells = [rc(1, 0), rc(1, 4), rc(2, 0), rc(2, 5), rc(0, 3)].map(T);
  const steps = skyscraper(only(5, cells));
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0]!.eliminations.map((e) => e.cell), [T(rc(0, 3))]);
  assert.deepEqual(steps[0]!.units, [10, 11]);
  assert.match(steps[0]!.reason[2]!, /remove 5 from R4C1/);
  assert.match(steps[0]!.nudge, /two columns/);
});

test("skyscraper: no steps without a shared line, with two (an X-Wing), or without eliminations", () => {
  const noShare = [rc(1, 0), rc(1, 4), rc(2, 1), rc(2, 5), rc(0, 3)];
  assert.deepEqual(skyscraper(only(5, noShare)), []);
  const xWing = [rc(1, 0), rc(1, 4), rc(5, 0), rc(5, 4), rc(3, 4)];
  assert.deepEqual(skyscraper(only(5, xWing)), []);
  assert.deepEqual(skyscraper(only(5, [rc(1, 0), rc(1, 4), rc(2, 0), rc(2, 5)])), []);
});

test("skyscraper in a real position", () => {
  const state = positionAt("000010020706002050008600000000000902009070000630000400010908006803400500060000000", 30);
  const steps = skyscraper(state);
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0]!.eliminations, [{ cell: 39, digit: 8 }, { cell: 52, digit: 8 }]);
  assert.deepEqual(steps[0]!.marks.map((m) => m.cell), [49, 13, 15, 42]);
});

test("twoStringKite: a row and a column meeting in a box", () => {
  // Row 2 has 1 at C2 and C7, column 3 at R3 and R8; R2C2 and R3C3 share box 1; R8C7 sees both far ends.
  const state = only(1, [rc(1, 1), rc(1, 6), rc(2, 2), rc(7, 2), rc(7, 6)]);
  const steps = twoStringKite(state);
  assert.equal(steps.length, 1);
  const s = steps[0]!;
  assert.equal(s.technique, "twoStringKite");
  assert.deepEqual(s.eliminations, [{ cell: rc(7, 6), digit: 1 }]);
  assert.deepEqual(s.marks.map((m) => [m.cell, m.role]), [[rc(1, 6), "colourB"], [rc(1, 1), "colourA"], [rc(2, 2), "colourB"], [rc(7, 2), "colourA"]]);
  assert.deepEqual(s.units, [1, 11, 18]);
  assert.match(s.reason[0]!, /share box 1|both in box 1/);
  assert.match(s.reason[2]!, /remove 1 from R8C7/);
});

test("twoStringKite: skips shared cells, patterns inside one box and ones with nothing to remove", () => {
  // The row link R1C2-R1C3 and the column link R2C1-R3C1 sit in box 1, as does R2C2 that sees both far ends.
  assert.deepEqual(twoStringKite(only(1, [1, 2, 9, 18, 10])), []);
  // No eliminations.
  assert.deepEqual(twoStringKite(only(1, [rc(1, 1), rc(1, 6), rc(2, 2), rc(7, 2)])), []);
  // Row link inside the box, column link leaving it: the orientation with the far end R1C2 finds nothing, the other removes R8C3.
  const steps = twoStringKite(only(1, [1, 2, 9, rc(7, 0), rc(7, 2)]));
  assert.deepEqual(elims(steps), [[rc(7, 2)]]);
});

test("twoStringKite in a real position", () => {
  const state = positionAt("790004010008030700036900000940800027060000301007000000000040006000590100000600900", 10);
  assert.deepEqual(twoStringKite(state).map((s) => s.eliminations), [[{ cell: 32, digit: 1 }], [{ cell: 49, digit: 6 }]]);
});

test("emptyRectangle: a box, a cross and a strong link outside it", () => {
  // Box 1 has 1 only in R1C2, R1C3, R2C1 and R3C1 (row 1 and column 1; the corner R1C1 is empty).
  // Row 6 has 1 only at R6C1 (on column 1) and R6C5. R1C5 is where row 1 meets column 5.
  const state = only(1, [rc(0, 1), rc(0, 2), rc(1, 0), rc(2, 0), rc(5, 0), rc(5, 4), rc(0, 4)]);
  const steps = emptyRectangle(state);
  assert.deepEqual(elims(steps), [[rc(0, 4)], [rc(5, 0)]]);
  const s = steps[0]!;
  assert.equal(s.technique, "emptyRectangle");
  assert.deepEqual(s.marks, [
    { cell: rc(0, 1), role: "pattern", digits: [1] },
    { cell: rc(0, 2), role: "pattern", digits: [1] },
    { cell: rc(1, 0), role: "pattern", digits: [1] },
    { cell: rc(2, 0), role: "pattern", digits: [1] },
    { cell: rc(5, 0), role: "colourB", digits: [1] },
    { cell: rc(5, 4), role: "colourA", digits: [1] },
  ]);
  assert.deepEqual(s.units, [18, 5]);
  assert.equal(s.reason.length, 3);
  assert.match(s.reason[0]!, /box 1: every place for 1 in it is on row 1 or on column 1/);
  assert.match(s.reason[1]!, /If R6C5 is 1, it sees R1C5/);
  assert.match(s.reason[2]!, /R1C5 cannot be 1/);
  // The same pattern read the other way round: a link in column 5, target R6C1.
  assert.deepEqual(steps[1]!.units, [18, 13]);
  assert.match(steps[1]!.reason[1]!, /it sees R6C1/);
  assert.deepEqual(steps[1]!.marks.slice(-2), [{ cell: rc(0, 4), role: "colourB", digits: [1] }, { cell: rc(5, 4), role: "colourA", digits: [1] }]);
});

test("emptyRectangle: the link must lie outside the box, on the cross, with the target outside the box and a candidate", () => {
  const box = [rc(0, 1), rc(0, 2), rc(1, 0), rc(2, 0)];
  // A link inside the box's rows (R2: R2C1 and R2C6).
  assert.deepEqual(emptyRectangle(only(1, [...box, rc(1, 5)])), []);
  // A link in row 6 touching neither line of the cross.
  assert.deepEqual(emptyRectangle(only(1, [...box, rc(5, 3), rc(5, 4)])), []);
  // A link whose far end is inside the box's columns (R6C2): that target would sit in the box.
  assert.deepEqual(emptyRectangle(only(1, [...box, rc(5, 0), rc(5, 1)])), []);
  // A link on the cross but whose target R1C5 holds no candidate.
  assert.deepEqual(emptyRectangle(only(1, [...box, rc(5, 0), rc(5, 4)])), []);
});

test("emptyRectangle ignores a single line of places (that is pointing) and cells outside a cross", () => {
  assert.deepEqual(emptyRectangle(only(1, [rc(0, 1), rc(0, 2), rc(5, 0), rc(5, 4), rc(0, 4)])), []);
  assert.deepEqual(emptyRectangle(only(1, [rc(1, 0), rc(2, 0), rc(5, 3), rc(5, 4), rc(0, 4)])), []);
  // Places spread over three rows and columns (no cross covers them).
  assert.deepEqual(emptyRectangle(only(1, [rc(0, 0), rc(1, 1), rc(2, 2), rc(5, 0), rc(5, 4)])), []);
});

test("emptyRectangle in a real position", () => {
  const state = positionAt("790004010008030700036900000940800027060000301007000000000040006000590100000600900", 10);
  const steps = emptyRectangle(state);
  assert.equal(steps.length, 4);
  assert.deepEqual(steps[0]!.eliminations, [{ cell: 32, digit: 1 }]);
});

test("steps are sound: they never remove a digit of the solution", () => {
  const random = new Xoshiro256StarStar(11n);
  let found = 0;
  for (let n = 0; n < 25; n++) {
    const solution = randomSolution(new Array<number>(81).fill(0), random)!;
    const g = new Grader(removeCells(solution, 22 + (n % 4), random));
    do {
      const state: State = { grid: [...g.grid], cand: [...g.cand] };
      for (const finder of [skyscraper, twoStringKite, emptyRectangle]) {
        for (const s of finder(state)) {
          found++;
          assert.ok(s.eliminations.length > 0);
          assert.equal(s.place, null);
          for (const e of s.eliminations) {
            assert.ok((state.cand[e.cell]! & bit(e.digit)) !== 0);
            assert.notEqual(solution[e.cell], e.digit, s.technique);
          }
          assert.ok(s.reason.length >= 2 && s.reason.length <= 3);
        }
      }
    } while (g.step() >= 0);
  }
  assert.ok(found > 0);
});
