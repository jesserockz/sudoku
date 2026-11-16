// The variant finders (finders/variants.ts), and a soundness run of the Learn
// solver over generated variant puzzles.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CELLS } from "../src/core/geometry.ts";
import { type Cage, Layout, VARIANT_DIAGONAL, VARIANT_JIGSAW, VARIANT_KILLER } from "../src/core/layout.ts";
import { FALLBACK_JIGSAWS, buildClassicVariant, buildGradedVariant } from "../src/generator/variants.ts";
import {
  cageCombination, cagePointing, diagonalLocked, diagonalSingle, digitSets, jigsawSingle, leftoverSets, leftovers, removals, rule45, sumSets,
} from "../src/learn/finders/variants.ts";
import { positionState } from "../src/learn/positions-format.ts";
import { ALL, type State, apply, bit, isSolved, parseGrid, stateOf } from "../src/learn/state.ts";
import { nextStep } from "../src/learn/techniques.ts";
import { VARIANT_POSITIONS } from "../src/learn/variant-positions.ts";

const cell = (row: number, col: number): number => (row - 1) * 9 + (col - 1);
const mask = (...digits: number[]): number => digits.reduce((m, d) => m | bit(d), 0);
const EMPTY: number[] = new Array<number>(CELLS).fill(0);

const SOLUTION = parseGrid("215638479837954216964271538598346721146782953723519864681427395452193687379865142");

/** An empty board under `layout`, every cell with all nine candidates, then `change` applied to the candidates. */
function open(layout: Layout, change: (cand: number[]) => void = () => {}): State {
  const cand = new Array<number>(CELLS).fill(ALL);
  change(cand);
  return { grid: [...EMPTY], cand, layout };
}

/** A killer layout of `groups` (sums from {@link SOLUTION}), every other cell a cage of its own. */
function killer(groups: readonly (readonly number[])[]): Layout {
  const taken = new Set(groups.flat());
  const cages: Cage[] = [...groups, ...Array.from({ length: CELLS }, (_, c) => c).filter((c) => !taken.has(c)).map((c) => [c])]
    .map((cells) => ({ cells, sum: cells.reduce((s, c) => s + SOLUTION[c]!, 0) }));
  return Layout.killer(cages);
}

const JIGSAW = Layout.jigsaw(parseGrid(FALLBACK_JIGSAWS[0]!.regions));

test("removals: by digit, by cell, or both", () => {
  assert.equal(removals([{ cell: 1, digit: 5 }, { cell: 0, digit: 5 }]), "So 5 can be removed from R1C1 and R1C2.");
  assert.equal(removals([{ cell: 0, digit: 4 }, { cell: 0, digit: 1 }]), "So 1 and 4 can be removed from R1C1.");
  assert.equal(removals([{ cell: 1, digit: 3 }, { cell: 0, digit: 3 }, { cell: 9, digit: 5 }, { cell: 10, digit: 7 }]),
    "So you can remove 3 from R1C1 and R1C2, 5 from R2C1, and 7 from R2C2.");
});

test("digitSets: the sets of different digits that add up to a sum", () => {
  assert.deepEqual(digitSets(2, 3, ALL), [mask(1, 2)]);
  assert.deepEqual(digitSets(2, 10, mask(1, 9, 2, 8, 3)), [mask(2, 8), mask(1, 9)]);
  assert.deepEqual(digitSets(3, 7, mask(1, 2, 3)), []);
});

// Diagonal.

test("diagonalSingle: a digit with one place left on a diagonal; nothing off a Diagonal board", () => {
  const diagonal = Layout.DIAGONAL.units;
  const state = open(Layout.DIAGONAL, (cand) => {
    for (const c of diagonal[28]!) if (c !== cell(3, 7)) cand[c]! &= ~bit(5);
  });
  const steps = diagonalSingle(state);
  assert.equal(steps.length, 1);
  const step = steps[0]!;
  assert.equal(step.technique, "diagonalSingle");
  assert.deepEqual(step.place, { cell: cell(3, 7), digit: 5 });
  assert.deepEqual(step.units, [28]);
  assert.equal(step.reason[0], "Look at the diagonal from the top right and ask where its 5 can go.");
  assert.match(step.reason[1]!, /row, column, box or diagonal/);
  assert.deepEqual(diagonalSingle({ ...state, layout: undefined }), []);
  assert.deepEqual(diagonalSingle({ ...state, layout: JIGSAW }), []);
});

test("diagonalLocked: a box's places on a diagonal clear the rest of the diagonal", () => {
  const units = Layout.DIAGONAL.units;
  const state = open(Layout.DIAGONAL, (cand) => {
    for (const c of units[18]!) if (c !== 0 && c !== 10) cand[c]! &= ~bit(3);
  });
  const steps = diagonalLocked(state);
  assert.equal(steps.length, 1);
  const step = steps[0]!;
  assert.equal(step.technique, "diagonalLocked");
  assert.equal(step.place, null);
  assert.deepEqual(step.units, [18, 27]);
  assert.deepEqual(step.marks, [{ cell: 0, role: "pattern", digits: [3] }, { cell: 10, role: "pattern", digits: [3] }]);
  assert.deepEqual(step.eliminations, units[27]!.filter((c) => c > 20).map((c) => ({ cell: c, digit: 3 })));
  assert.deepEqual(step.reason.slice(0, 2), [
    "Look at box 1: the 3 can only go in R1C1 and R2C2.",
    "Those squares are all on the diagonal from the top left, so the 3 of box 1 has to be there, and no other square of the diagonal from the top left can have a 3.",
  ]);
  assert.equal(step.nudge, "Look at where 3 can go in box 1.");
});

test("diagonalLocked: a diagonal's places in one box clear the rest of the box", () => {
  const units = Layout.DIAGONAL.units;
  const state = open(Layout.DIAGONAL, (cand) => {
    for (const c of units[28]!) if (c !== 8 && c !== 16) cand[c]! &= ~bit(7);
  });
  const steps = diagonalLocked(state);
  assert.equal(steps.length, 1);
  const step = steps[0]!;
  assert.deepEqual(step.units, [28, 20]);
  assert.deepEqual(step.eliminations.map((e) => e.cell), [6, 7, 15, 17, 25, 26]);
  assert.equal(step.reason[1], "Those squares are all in box 3, so the 7 of the diagonal from the top right has to be there, and no other square of box 3 can have a 7.");
  assert.equal(step.nudge, "Look at where 7 can go on the diagonal from the top right.");
});

test("diagonalLocked: nothing to remove, a single place, or not a Diagonal board", () => {
  const units = Layout.DIAGONAL.units;
  const state = open(Layout.DIAGONAL, (cand) => {
    // 2: locked both ways in box 1, with nothing left to remove either way.
    for (const c of units[18]!) if (c !== 0 && c !== 10) cand[c]! &= ~bit(2);
    for (const c of units[27]!) if (c > 20) cand[c]! &= ~bit(2);
    // 4: one place on the diagonal from the top right, and one in box 9.
    for (const c of units[28]!) if (c !== 40) cand[c]! &= ~bit(4);
    for (const c of units[26]!) if (c !== 80) cand[c]! &= ~bit(4);
  });
  assert.deepEqual(diagonalLocked(state), []);
  assert.deepEqual(diagonalLocked(open(Layout.STANDARD, (cand) => {
    for (const c of units[18]!) if (c !== 0 && c !== 10) cand[c]! &= ~bit(3);
  })), []);
});

// Jigsaw.

test("jigsawSingle: a digit with one place left in a region; nothing on other boards", () => {
  const region = JIGSAW.units[18 + 3]!;
  const state = open(JIGSAW, (cand) => {
    for (const c of region.slice(1)) cand[c]! &= ~bit(6);
  });
  const steps = jigsawSingle(state);
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0]!.place, { cell: region[0], digit: 6 });
  assert.deepEqual(steps[0]!.units, [21]);
  assert.equal(steps[0]!.reason[0], "Look at region 4 and ask where its 6 can go.");
  assert.match(steps[0]!.reason[1]!, /in its row, column or region,/);
  assert.deepEqual(jigsawSingle({ ...state, layout: Layout.DIAGONAL }), []);
});

test("leftoverSets: lines at an edge and the regions mostly inside them, with one to four squares left over", () => {
  const sets = leftoverSets(JIGSAW);
  assert.ok(sets.length > 0);
  for (const { lines, regions, a, b } of sets) {
    assert.equal(regions.length, lines.length);
    assert.equal(a.length, b.length);
    assert.ok(a.length >= 1 && a.length <= 4);
    const inLines = new Set(lines.flatMap((u) => JIGSAW.units[u]!));
    assert.ok(a.every((c) => inLines.has(c) && !regions.includes(JIGSAW.regions[c]!)));
    assert.ok(b.every((c) => !inLines.has(c) && regions.includes(JIGSAW.regions[c]!)));
  }
  // Rows and columns, one line and several.
  assert.ok(sets.some((s) => s.lines[0]! < 9) && sets.some((s) => s.lines[0]! >= 9));
  assert.ok(sets.some((s) => s.lines.length === 1) && sets.some((s) => s.lines.length > 1));
  // The standard boxes fill their rows exactly: nothing is left over.
  assert.deepEqual(leftoverSets(Layout.STANDARD), []);
});

test("leftovers: each side keeps only what the other can hold", () => {
  const sets = leftoverSets(JIGSAW);
  for (const set of sets) {
    const { lines, a, b } = set;
    // A 9 that B can't hold leaves A; an 8 that A can't hold leaves B.
    const state = open(JIGSAW, (cand) => {
      for (const c of b) cand[c]! &= ~bit(9);
      for (const c of a) cand[c]! &= ~bit(8);
    });
    const step = leftovers(state).find((s) => s.units.join() === lines.join())!;
    assert.ok(step, `lines ${lines.join()}`);
    assert.equal(step.technique, "leftovers");
    assert.deepEqual(step.eliminations, [...a.map((c) => ({ cell: c, digit: 9 })), ...b.map((c) => ({ cell: c, digit: 8 }))].sort((x, y) => x.cell - y.cell));
    assert.deepEqual(step.marks.filter((m) => m.role === "colourA").map((m) => m.cell), a);
    assert.deepEqual(step.marks.filter((m) => m.role === "colourB").map((m) => m.cell), b);
    assert.equal(step.reason.length, 4);
    assert.equal(step.reason[2]!.split(" can only hold ").length, 3, "both sides are limited");
    const k = lines.length;
    const kind = lines[0]! < 9 ? "row" : "column";
    assert.match(step.reason[0]!, k === 1 ? new RegExp(`^${kind[0]!.toUpperCase()}${kind.slice(1)} \\d holds every digit once, and so does region \\d, which lies mostly inside it\\.$`)
      : new RegExp(`^${kind[0]!.toUpperCase()}${kind.slice(1)}s \\d (and|to) \\d hold every digit (twice|three times|four times), and so do regions .*, which lie mostly inside them\\.$`));
    assert.match(step.reason[1]!, new RegExp(`^Take away the squares they share: what is left of the ${kind}${k === 1 ? "" : "s"} \\(`));
    assert.match(step.nudge, new RegExp(`^Compare ${kind}s? .* with the regions? lying mostly inside (it|them)\\.$`));
  }
  // One side only: placed digits count as what a side holds.
  const { a, b } = sets[0]!;
  const one = open(JIGSAW, (cand) => {
    for (const c of b) cand[c]! &= ~bit(9);
  });
  const step = leftovers(one)[0]!;
  assert.deepEqual(step.eliminations, a.map((c) => ({ cell: c, digit: 9 })));
  assert.equal(step.reason[2]!.split(" can only hold ").length, 2);
  // With A filled in, B can only hold A's digits.
  const filled: State = { ...one, grid: one.grid.map((_, c) => (a.includes(c) ? 1 + a.indexOf(c) : 0)), cand: one.cand.map((m, c) => (a.includes(c) ? 0 : m)) };
  const fromB = leftovers(filled).find((s) => s.units.join() === sets[0]!.lines.join())!;
  assert.ok(fromB.eliminations.every((e) => b.includes(e.cell) && e.digit > a.length));
});

test("leftovers: nothing when both sides already match, or off a Jigsaw board", () => {
  assert.deepEqual(leftovers(open(JIGSAW)), []);
  assert.deepEqual(leftovers(open(Layout.STANDARD, (cand) => cand.fill(1))), []);
});

// Killer.

test("cageCombination: a cage keeps the digits of the ways that still fit", () => {
  // A cage of R1C1 and R1C2 adding to 3 (SOLUTION has 2 and 1 there).
  const layout = killer([[0, 1]]);
  const state: State = { grid: [...EMPTY], cand: EMPTY.map((_, c) => (c === 0 || c === 1 ? ALL : 0)), layout };
  const steps = cageCombination(state);
  assert.equal(steps.length, 1);
  const step = steps[0]!;
  assert.equal(step.technique, "cageCombination");
  assert.deepEqual(step.eliminations.filter((e) => e.cell === 0).map((e) => e.digit), [3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(step.marks, [{ cell: 0, role: "pattern" }, { cell: 1, role: "pattern" }]);
  assert.deepEqual(step.reason, [
    "The cage of R1C1 and R1C2 adds up to 3, with no digit twice.",
    "With the digits its squares can still hold, the only way to make 3 with 2 squares is 1+2.",
    "So you can remove 3 from R1C1 and R1C2, 4 from R1C1 and R1C2, 5 from R1C1 and R1C2, 6 from R1C1 and R1C2, 7 from R1C1 and R1C2, 8 from R1C1 and R1C2, and 9 from R1C1 and R1C2.",
  ]);
  assert.equal(step.nudge, "Work out which digits can add up to 3 in the cage at R1C1.");
});

test("cageCombination: placed digits, a last square, several ways or many, and cages with nothing to remove", () => {
  // R1C3..R1C5 add up to 5 + 6 + 3 = 14, with 6 placed: 8 left in two squares.
  const layout = killer([[2, 3, 4], [9, 10], [18, 19, 20, 21, 22], [27, 28, 29, 30, 31]]);
  const grid = [...EMPTY];
  grid[3] = 6;
  grid[9] = 8;
  const cand = EMPTY.map(() => 0);
  cand[2] = mask(1, 2, 3, 4, 5, 9);
  cand[4] = mask(1, 2, 3, 5, 7);
  cand[10] = ALL & ~bit(8);
  // R3C1..R3C5 add up to 9 + 6 + 4 + 2 + 7 = 28. With R3C1 down to 9, the rest make 19 with four of 1 to 8: seven ways.
  cand[18] = bit(9);
  for (const c of [19, 20, 21, 22]) cand[c] = ALL;
  for (const c of [27, 28, 29, 30, 31]) cand[c] = mask(3, 4, 5, 8, 9); // Add up to 5 + 9 + 8 + 3 + 4 = 29: only those five.
  const steps = cageCombination({ grid, cand, layout });
  const by = (first: number) => steps.find((s) => s.marks[0]!.cell === first)!;
  const pair = by(2);
  assert.equal(pair.reason[0], "The cage of R1C3, R1C4 and R1C5 adds up to 14. It already holds 6, so its 2 empty squares must make 8 with different digits.");
  assert.equal(pair.reason[1], "With the digits its empty squares can still hold, the ways to make 8 with 2 squares are 3+5 and 1+7.");
  assert.deepEqual(pair.eliminations, [{ cell: 2, digit: 2 }, { cell: 2, digit: 4 }, { cell: 2, digit: 9 }, { cell: 4, digit: 1 }, { cell: 4, digit: 2 }]);
  const last = by(10);
  assert.equal(last.reason[0], "The cage of R2C1 and R2C2 adds up to 11. It already holds 8, so its 1 empty square must make 3 with different digits.");
  assert.equal(last.reason[1], "So R2C2 must be 3.");
  assert.equal(last.reason[2], "So 1, 2, 4, 5, 6, 7 and 9 can be removed from R2C2.");
  const many = by(18);
  assert.equal(many.reason[1], "With the digits its squares can still hold, there are 7 ways to make 28 with 5 squares.");
  assert.equal(many.reason[2], "So 9 can be removed from R3C2, R3C3, R3C4 and R3C5.");
  assert.equal(steps.some((s) => s.marks[0]!.cell === 27), false, "nothing to remove");
  // A cage with every square filled has nothing to say.
  const full = { grid: [...SOLUTION], cand: [...EMPTY], layout };
  assert.deepEqual(cageCombination(full), []);
  assert.deepEqual(cageCombination(open(Layout.STANDARD)), []);
});

test("sumSets: a unit's innies and outies, as the grader's 45 rule finds them", () => {
  const layout = killer([[0, 1], [2, 3], [9, 10], [11, 12], [18, 19], [20, 21]]);
  const box = sumSets(layout, 18);
  assert.equal(box.whole, 2 + 1 + 8 + 3 + 9 + 6);
  assert.deepEqual(box.sets.map((s) => s.cells), [[2, 11, 20], [3, 12, 21]]);
  assert.deepEqual(box.sets.map((s) => s.sum), [45 - box.whole, box.total - 45]);
  assert.equal(box.sets[0]!.sum, 5 + 7 + 4);
  assert.equal(box.sets[1]!.sum, 6 + 9 + 2);
  // A unit no cage crosses has none.
  assert.deepEqual(sumSets(killer([]), 0).sets, []);
});

test("rule45: the last empty innie or outie is what its set has left to make", () => {
  const layout = killer([[0, 1], [2, 3], [9, 10], [11, 12], [18, 19], [20, 21]]);
  const innie = { grid: SOLUTION.map((d, c) => (c === 2 ? 0 : d)), cand: EMPTY.map((_, c) => (c === 2 ? mask(5, 7) : 0)), layout };
  const step = rule45(innie).find((s) => s.units[0] === 18)!;
  assert.equal(step.technique, "rule45");
  assert.deepEqual(step.place, { cell: 2, digit: 5 });
  assert.deepEqual(step.marks.map((m) => m.cell), [2, 11, 20]);
  assert.deepEqual(step.reason, [
    "Box 1 adds up to 45, and the cages lying wholly inside it add up to 29.",
    "So its squares in cages that cross its edge, the innies R1C3, R2C3 and R3C3, add up to 45 - 29 = 16.",
    "R2C3 and R3C3 already hold 11, so R1C3 is 16 - 11 = 5.",
  ]);
  assert.equal(step.nudge, "Add up the cages around box 1.");
  const outie = { grid: SOLUTION.map((d, c) => (c === 3 ? 0 : d)), cand: EMPTY.map((_, c) => (c === 3 ? mask(6, 7) : 0)), layout };
  const out = rule45(outie).find((s) => s.units[0] === 18)!;
  assert.deepEqual(out.place, { cell: 3, digit: 6 });
  assert.deepEqual(out.reason, [
    "The cages that reach into box 1 add up to 62, and box 1 itself adds up to 45.",
    "So their squares outside it, the outies R1C4, R2C4 and R3C4, add up to 62 - 45 = 17.",
    "R2C4 and R3C4 already hold 11, so R1C4 is 17 - 11 = 6.",
  ]);
});

test("rule45: a single innie or outie, one placed partner, and a unit with no cage inside", () => {
  const blank = (layout: Layout, ...cells: number[]): State =>
    ({ grid: SOLUTION.map((d, c) => (cells.includes(c) ? 0 : d)), cand: EMPTY.map((_, c) => (cells.includes(c) ? ALL : 0)), layout });
  // Row 1: R1C1..R1C8 is one cage, R1C9 and R2C9 another.
  const single = killer([[0, 1, 2, 3, 4, 5, 6, 7], [8, 17]]);
  const innie = rule45(blank(single, 8)).find((s) => s.units[0] === 0)!;
  assert.deepEqual(innie.place, { cell: 8, digit: 9 });
  assert.deepEqual(innie.reason.slice(1), ["So its one square in a cage that crosses its edge, the innie R1C9, is 45 - 36 = 9.", "So R1C9 is 9."]);
  const outie = rule45(blank(single, 17)).find((s) => s.units[0] === 0)!;
  assert.deepEqual(outie.place, { cell: 17, digit: 6 });
  assert.deepEqual(outie.reason.slice(1), ["So their one square outside it, the outie R2C9, is 51 - 45 = 6.", "So R2C9 is 6."]);
  // Row 1 again, with two innies: R1C8 and R1C9.
  const pair = killer([[0, 1, 2, 3, 4, 5, 6], [7, 16], [8, 17]]);
  const partner = rule45(blank(pair, 7)).find((s) => s.units[0] === 0)!;
  assert.deepEqual(partner.place, { cell: 7, digit: 7 });
  assert.equal(partner.reason[2], "R1C9 already holds 9, so R1C8 is 16 - 9 = 7.");
  // Row 5 lies across nine cages of two, each reaching into row 6: no cage lies wholly inside it.
  const across = killer(Array.from({ length: 9 }, (_, c) => [36 + c, 45 + c]));
  const row = rule45(blank(across, 40)).find((s) => s.units[0] === 4)!;
  assert.equal(row.reason[0], "Row 5 adds up to 45, and no cage lies wholly inside it.");
  assert.equal(row.reason[2], "R5C1, R5C2, R5C3, R5C4, R5C6, R5C7, R5C8 and R5C9 already hold 37, so R5C5 is 45 - 37 = 8.");
  // Two empty squares in a set: nothing from it; and no cages: nothing.
  assert.deepEqual(rule45(blank(pair, 7, 8, 16, 17)).filter((s) => s.units[0] === 0), []);
  assert.deepEqual(rule45(open(Layout.STANDARD)), []);
});

test("cagePointing: a digit every filling needs, lined up in the cage, leaves the rest of the line", () => {
  // R1C1 and R1C2 add up to 3: both need 1 and 2. A 1 elsewhere in row 1, a 2 elsewhere in box 1.
  const layout = killer([[0, 1]]);
  const cand = EMPTY.map(() => 0);
  cand[0] = mask(1, 2);
  cand[1] = mask(1, 2);
  // Their own cages of one need the solution's digit there: 8 and 6.
  cand[5] = mask(1, 8);
  cand[19] = mask(2, 6);
  const steps = cagePointing({ grid: [...EMPTY], cand, layout });
  assert.deepEqual(steps.map((s) => [s.units, s.eliminations]), [[[0], [{ cell: 5, digit: 1 }]], [[18], [{ cell: 19, digit: 2 }]]]);
  const step = steps[0]!;
  assert.equal(step.technique, "cagePointing");
  assert.deepEqual(step.marks, [{ cell: 0, role: "pattern", digits: [1] }, { cell: 1, role: "pattern", digits: [1] }]);
  assert.deepEqual(step.reason, [
    "The cage of R1C1 and R1C2 adds up to 3, with no digit twice.",
    "With the digits its squares can still hold, every way to do that uses a 1: 1+2.",
    "Inside the cage, 1 can only go in R1C1 and R1C2, which are all in row 1, so no other square of row 1 can be 1.",
    "So 1 can be removed from R1C6.",
  ]);
  assert.equal(step.nudge, "Which digit must the cage at R1C1 use?");
});

test("cagePointing: one place in a column, placed digits, and digits not every filling needs", () => {
  // R1C1, R2C1 and R3C1 add up to 2 + 8 + 9 = 19, with 8 placed: 11 left in two squares from {2, 4, 9}: only 2+9.
  const layout = killer([[0, 9, 18]]);
  const grid = [...EMPTY];
  grid[9] = 8;
  const cand = EMPTY.map(() => 0);
  cand[0] = mask(2, 4);
  cand[18] = mask(4, 9);
  cand[45] = mask(4, 7, 9);
  cand[27] = mask(2, 4, 5);
  const steps = cagePointing({ grid, cand, layout });
  const nine = steps.find((s) => s.eliminations[0]!.digit === 9)!;
  assert.deepEqual(nine.units, [9]);
  assert.deepEqual(nine.eliminations, [{ cell: 45, digit: 9 }]);
  assert.equal(nine.reason[0], "The cage of R1C1, R2C1 and R3C1 adds up to 19. It already holds 8, so its 2 empty squares must make 11 with different digits.");
  assert.equal(nine.reason[2], "Inside the cage, 9 can only go in R3C1, which is in column 1, so no other square of column 1 can be 9.");
  assert.ok(steps.every((s) => s.eliminations.every((e) => e.digit !== 4)), "4 isn't needed");
  assert.deepEqual(cagePointing(open(Layout.STANDARD)), []);
});

test("the variant finders explain the mined positions without dashes", () => {
  for (const [id, list] of Object.entries(VARIANT_POSITIONS)) {
    for (const p of list) {
      const state = positionState(p);
      const step = nextStep(state)!;
      assert.equal(step.technique, id);
      assert.doesNotMatch([...step.reason, step.nudge].join(" "), /[\u2013\u2014]/);
    }
  }
});

// Soundness: the Learn solver never contradicts a generated puzzle's solution.

for (const variant of [VARIANT_DIAGONAL, VARIANT_JIGSAW, VARIANT_KILLER]) {
  test(`variant ${variant}: no Learn step contradicts the solution of a generated puzzle`, () => {
    let taken = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const tier = 1 + (seed % 5);
      const build = seed % 2 === 0 ? buildClassicVariant(BigInt(seed * 7919), variant, tier) : buildGradedVariant(BigInt(seed * 7919), variant, tier);
      const solution = Array.from(build.solution, Number);
      let state = stateOf(Array.from(build.givens, Number), undefined, build.layout);
      for (let step = nextStep(state); step; step = isSolved(state) ? null : nextStep(state)) {
        if (step.place) assert.equal(solution[step.place.cell], step.place.digit, `${seed}: ${step.technique} places the answer`);
        for (const e of step.eliminations) assert.notEqual(solution[e.cell], e.digit, `${seed}: ${step.technique} keeps the answer`);
        state = apply(state, step);
        taken++;
      }
    }
    assert.ok(taken > 0, "the solver had something to check");
  });
}
