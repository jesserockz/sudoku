import assert from "node:assert/strict";
import { test } from "node:test";
import { CELLS } from "../src/core/geometry.ts";
import { crossHatch, fullHouse, hiddenSingle, nakedSingle } from "../src/learn/finders/singles.ts";
import { type State, bit, parseGrid, stateOf } from "../src/learn/state.ts";

const cell = (row: number, col: number): number => (row - 1) * 9 + (col - 1);

const SOLUTION = "215638479837954216964271538598346721146782953723519864681427395452193687379865142";
// A real position where the first technique that applies is a hidden single (two of them).
const HIDDEN = "200638409800904000004201008000340701000780050723510800001427005002193000370865100";
// A real position where the first technique that applies is cross-hatching (one box has a single place for a digit).
const HATCH = "060000040090074000380019050000000004100050003020038000700006005800021000600700100";

/** The solved grid with the given cells blanked. */
const blanked = (...cells: number[]): State => {
  const grid = parseGrid(SOLUTION);
  for (const c of cells) grid[c] = 0;
  return stateOf(grid);
};

/** An empty board where each listed cell has the listed candidates. */
function board(cells: Record<number, number[]>): State {
  const cand = new Array<number>(CELLS).fill(0);
  for (const [c, digits] of Object.entries(cells)) cand[Number(c)] = digits.reduce((m, d) => m | bit(d), 0);
  return { grid: new Array<number>(CELLS).fill(0), cand };
}

test("fullHouse: the last empty square of a unit takes the missing digit", () => {
  const steps = fullHouse(blanked(cell(1, 1)));
  assert.equal(steps.length, 1, "its row, column and box all point at one square: one step");
  const step = steps[0]!;
  assert.equal(step.technique, "fullHouse");
  assert.deepEqual(step.place, { cell: 0, digit: 2 });
  assert.deepEqual(step.eliminations, []);
  assert.deepEqual(step.marks, [{ cell: 0, role: "pattern" }]);
  assert.deepEqual(step.units, [0], "the first unit found, the row");
  assert.deepEqual(step.reason, [
    "Row 1 has only one empty square: R1C1.",
    "The only digit missing from row 1 is 2, so R1C1 is 2.",
  ]);
  assert.match(step.nudge, /one empty square/);
});

test("fullHouse: separate squares each give a step, in unit order", () => {
  // R1C1 and R5C6 share no unit. Each is alone in its row, column and box.
  const steps = fullHouse(blanked(cell(1, 1), cell(5, 6)));
  assert.deepEqual(steps.map((s) => s.place), [{ cell: 0, digit: 2 }, { cell: cell(5, 6), digit: 2 }]);
  assert.deepEqual(steps.map((s) => s.units), [[0], [4]]);
});

test("fullHouse: a column or box with one square left is named as such", () => {
  // Two empties in one row: each is alone in its column, not in its row.
  const cols = fullHouse(blanked(cell(1, 1), cell(1, 5)));
  assert.deepEqual(cols.map((s) => s.units), [[9], [13]]);
  assert.equal(cols[0]!.reason[0], "Column 1 has only one empty square: R1C1.");
  assert.equal(cols[0]!.reason[1], "The only digit missing from column 1 is 2, so R1C1 is 2.");
  // Four empties in a rectangle's corners: every row and column holds two, but each box one.
  const boxes = fullHouse(blanked(cell(1, 1), cell(1, 5), cell(4, 1), cell(4, 5)));
  assert.deepEqual(boxes.map((s) => s.units), [[18], [19], [21], [22]]);
  assert.deepEqual(boxes.map((s) => s.place), [
    { cell: cell(1, 1), digit: 2 }, { cell: cell(1, 5), digit: 3 }, { cell: cell(4, 1), digit: 5 }, { cell: cell(4, 5), digit: 4 },
  ]);
  assert.equal(boxes[0]!.reason[0], "Box 1 has only one empty square: R1C1.");
});

test("fullHouse: two empties that share every unit give nothing", () => {
  assert.deepEqual(fullHouse(blanked(cell(1, 1), cell(1, 2))).map((s) => s.units[0]), [9, 10], "only their columns have one left");
  assert.deepEqual(fullHouse(board({ [cell(1, 1)]: [1] })), [], "an empty board has no unit with one square left");
});

test("fullHouse: a square with no single candidate left gives nothing", () => {
  const state = blanked(cell(1, 1));
  const twoCandidates = { grid: state.grid, cand: state.cand.map((m, i) => (i === 0 ? bit(2) | bit(3) : m)) };
  assert.deepEqual(fullHouse(twoCandidates), []);
  const none = { grid: state.grid, cand: state.cand.map((m, i) => (i === 0 ? 0 : m)) };
  assert.deepEqual(fullHouse(none), []);
});

test("hiddenSingle: a digit with one place left in a row or column, with the digits that block the rest", () => {
  const steps = hiddenSingle(stateOf(parseGrid(HIDDEN)));
  assert.ok(steps.length >= 2);
  for (const s of steps) {
    assert.equal(s.technique, "hiddenSingle");
    assert.ok(s.units[0]! < 18, "a row or a column");
    assert.equal(s.eliminations.length, 0);
    assert.equal(s.marks[0]!.role, "pattern");
    assert.ok(s.marks.slice(1).every((m) => m.role === "see"));
  }
  const sorted = steps.map((s) => s.place!);
  for (const p of sorted) assert.equal(Array.from(SOLUTION, Number)[p.cell], p.digit, "each step places the right digit");
  const first = steps[0]!;
  const { cell: at, digit } = first.place!;
  assert.equal(first.marks[0]!.cell, at);
  assert.match(first.reason[0]!, new RegExp(`where its ${digit} can go`));
  assert.match(first.reason[2]!, new RegExp(`is the only place left for ${digit}`));
  assert.match(first.nudge, new RegExp(`Where can ${digit} go in (row|column) \\d\\?`));
  const blockerCells = first.marks.slice(1).map((m) => m.cell);
  assert.deepEqual(blockerCells, [...blockerCells].sort((a, b) => a - b), "blockers ascending");
  assert.ok(blockerCells.every((c) => HIDDEN[c] === String(digit)), "every blocker holds the digit");
});

test("crossHatch: only boxes are searched", () => {
  const state = stateOf(parseGrid(HATCH));
  const steps = crossHatch(state);
  assert.ok(steps.length > 0);
  assert.ok(steps.every((s) => s.technique === "crossHatch" && s.units[0]! >= 18 && s.units[0]! < 27));
  const first = steps[0]!;
  const { cell: at, digit } = first.place!;
  assert.equal(HATCH[at], "0");
  assert.match(first.reason[0]!, /Look at box \d and ask where its \d can go\./);
  assert.match(first.nudge, new RegExp(`Where can ${digit} go in box \\d\\?`));
  // Rows and columns are the other technique's business.
  assert.ok(hiddenSingle(state).every((s) => s.technique === "hiddenSingle" && s.units[0]! < 18));
});

test("a hidden single narrowed by candidates alone has no blocking digits to mark", () => {
  // 5 is a candidate only at R1C1 in row 1 and nowhere else, so nothing placed rules it out of the other squares.
  const state = board({ [cell(1, 1)]: [5, 6], [cell(1, 2)]: [6, 7] });
  const steps = hiddenSingle(state).filter((s) => s.place!.digit === 5);
  assert.deepEqual(steps.map((s) => s.units), [[0], [9]], "its row and its column");
  for (const step of steps) {
    assert.deepEqual(step.marks, [{ cell: 0, role: "pattern" }]);
    assert.deepEqual(step.place, { cell: 0, digit: 5 });
  }
});

test("hidden singles skip a digit with several places or none", () => {
  const state = board({ [cell(1, 1)]: [1, 2], [cell(1, 2)]: [1] });
  const inRow = hiddenSingle(state).filter((s) => s.units[0] === 0);
  assert.deepEqual(inRow.map((s) => s.place), [{ cell: 0, digit: 2 }], "1 fits two squares of row 1, 3 and up fit none");
});

test("nakedSingle: a cell whose only candidate is what its peers leave", () => {
  const state = blanked(cell(5, 5));
  const steps = nakedSingle(state);
  assert.equal(steps.length, 1);
  const step = steps[0]!;
  assert.equal(step.technique, "nakedSingle");
  assert.deepEqual(step.place, { cell: cell(5, 5), digit: 8 });
  assert.deepEqual(step.marks, [{ cell: cell(5, 5), role: "pattern" }]);
  assert.deepEqual(step.units, [4, 13, 22]);
  assert.deepEqual(step.reason, [
    "R5C5 shares its row, column and box (box 5) with 1, 2, 3, 4, 5, 6, 7 and 9.",
    "That leaves 8 as the only digit it can be.",
  ]);
  assert.match(step.nudge, /single digit/);
});

test("nakedSingle: a candidate pruned by other means is worded without the peers", () => {
  // An empty grid, so the rules alone would leave nine digits, yet this cell is down to one.
  const state = board({ [cell(2, 3)]: [7], [cell(2, 4)]: [3, 4], [cell(2, 5)]: [] });
  const steps = nakedSingle(state);
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0]!.place, { cell: cell(2, 3), digit: 7 });
  assert.deepEqual(steps[0]!.reason, ["R2C3 has one candidate left, so it is 7."]);
});

test("nakedSingle: lists steps in cell order and skips cells with several candidates", () => {
  const steps = nakedSingle(blanked(cell(1, 1), cell(9, 9)));
  assert.deepEqual(steps.map((s) => s.place!.cell), [0, 80]);
  const mixed = nakedSingle(board({ 0: [1, 2], 1: [3], 2: [] }));
  assert.deepEqual(mixed.map((s) => s.place), [{ cell: 1, digit: 3 }]);
});
