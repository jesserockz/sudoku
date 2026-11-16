import assert from "node:assert/strict";
import { test } from "node:test";
import { CELLS } from "../src/core/geometry.ts";
import {
  ALL, UNITS, apply, basicCandidates, bit, boxUnit, cellName, cellNames, cellsWith, colUnit, commonPeers, count, digitsOf,
  eliminationsOf, has, isSolved, listOf, parseGrid, rowUnit, sees, stateOf, unitName, unitsOf,
} from "../src/learn/state.ts";

const cell = (row: number, col: number): number => (row - 1) * 9 + (col - 1);
const mask = (...digits: number[]): number => digits.reduce((m, d) => m | bit(d), 0);

const SOLUTION = "215638479837954216964271538598346721146782953723519864681427395452193687379865142";

test("units: 27 of nine cells, rows then columns then boxes", () => {
  assert.equal(UNITS.length, 27);
  assert.ok(UNITS.every((u) => u.length === 9));
  assert.deepEqual(UNITS[0], [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(UNITS[9], [0, 9, 18, 27, 36, 45, 54, 63, 72]);
  assert.deepEqual(UNITS[18], [0, 1, 2, 9, 10, 11, 18, 19, 20]);
  assert.equal(rowUnit(4), 4);
  assert.equal(colUnit(4), 13);
  assert.equal(boxUnit(4), 22);
  assert.deepEqual(unitsOf(cell(5, 6)), [4, 9 + 5, 18 + 4]);
});

test("bit, digitsOf and count describe a candidate mask", () => {
  assert.equal(bit(1), 1);
  assert.equal(bit(9), 256);
  assert.equal(ALL, mask(1, 2, 3, 4, 5, 6, 7, 8, 9));
  assert.deepEqual(digitsOf(0), []);
  assert.deepEqual(digitsOf(mask(9, 2, 5)), [2, 5, 9]);
  assert.equal(count(0), 0);
  assert.equal(count(mask(1, 4, 9)), 3);
  assert.equal(count(ALL), 9);
});

test("parseGrid reads digits and dots, and rejects anything else", () => {
  const grid = parseGrid(`5.${"0".repeat(78)}3`);
  assert.equal(grid.length, 81);
  assert.equal(grid[0], 5);
  assert.equal(grid[1], 0);
  assert.equal(grid[80], 3);
  assert.deepEqual(parseGrid(SOLUTION), Array.from(SOLUTION, Number));
  assert.throws(() => parseGrid("123"), RangeError);
  assert.throws(() => parseGrid("x".repeat(81)), RangeError);
  assert.throws(() => parseGrid("0".repeat(82)), RangeError);
});

test("basicCandidates leaves every digit the row, column and box do not hold", () => {
  const empty = basicCandidates(new Array<number>(CELLS).fill(0));
  assert.ok(empty.every((m) => m === ALL));
  const grid = new Array<number>(CELLS).fill(0);
  grid[cell(1, 1)] = 5;
  grid[cell(1, 9)] = 6;
  grid[cell(9, 1)] = 7;
  grid[cell(2, 2)] = 8;
  const cand = basicCandidates(grid);
  assert.equal(cand[cell(1, 1)], 0);
  assert.equal(cand[cell(1, 5)], ALL & ~mask(5, 6));
  assert.equal(cand[cell(5, 1)], ALL & ~mask(5, 7));
  assert.equal(cand[cell(3, 3)], ALL & ~mask(5, 8));
  assert.equal(cand[cell(5, 5)], ALL);
  assert.throws(() => basicCandidates([1, 2, 3]), /expected 81 cells, got 3/);
});

test("stateOf copies its input and uses the rules' candidates unless told otherwise", () => {
  const grid = parseGrid(SOLUTION.slice(0, 80) + "0");
  const state = stateOf(grid);
  assert.notEqual(state.grid, grid);
  assert.deepEqual(state.grid, grid);
  assert.deepEqual(state.cand, basicCandidates(grid));
  assert.equal(state.cand[80], mask(2));
  const cand = new Array<number>(CELLS).fill(0);
  cand[80] = mask(2, 3);
  const given = stateOf(grid, cand);
  assert.notEqual(given.cand, cand);
  assert.deepEqual(given.cand, cand);
});

test("has, cellsWith and eliminationsOf look at the candidates", () => {
  const cand = new Array<number>(CELLS).fill(0);
  cand[3] = mask(1, 2);
  cand[1] = mask(2);
  cand[7] = mask(2, 5);
  const state = { grid: new Array<number>(CELLS).fill(0), cand };
  assert.equal(has(state, 3, 1), true);
  assert.equal(has(state, 3, 3), false);
  assert.deepEqual(cellsWith(state, [7, 3, 1, 0], 2), [7, 3, 1]);
  assert.deepEqual(cellsWith(state, [0, 2], 2), []);
  assert.deepEqual(eliminationsOf(state, [7, 3, 1], [2, 1]), [
    { cell: 1, digit: 2 },
    { cell: 3, digit: 2 },
    { cell: 3, digit: 1 },
    { cell: 7, digit: 2 },
  ]);
  assert.deepEqual(eliminationsOf(state, [0], [1]), []);
});

test("sees: two different cells in one row, column or box", () => {
  assert.equal(sees(0, 0), false);
  assert.equal(sees(cell(1, 1), cell(1, 9)), true);
  assert.equal(sees(cell(1, 1), cell(9, 1)), true);
  assert.equal(sees(cell(1, 1), cell(3, 3)), true);
  assert.equal(sees(cell(1, 1), cell(2, 4)), false);
});

test("commonPeers: the cells that see every cell given, without those cells", () => {
  assert.deepEqual(commonPeers([cell(1, 1), cell(1, 2)]).filter((c) => c < 9), [2, 3, 4, 5, 6, 7, 8]);
  const both = commonPeers([cell(1, 1), cell(2, 2)]);
  assert.deepEqual(both, [cell(1, 2), cell(1, 3), cell(2, 1), cell(2, 3), cell(3, 1), cell(3, 2), cell(3, 3)].sort((a, b) => a - b));
  assert.deepEqual(commonPeers([cell(1, 1), cell(5, 5)]), [cell(1, 5), cell(5, 1)]);
  assert.ok(commonPeers([cell(1, 1)]).length === 20);
});

test("isSolved needs every cell filled", () => {
  assert.equal(isSolved(stateOf(parseGrid(SOLUTION))), true);
  assert.equal(isSolved(stateOf(parseGrid(SOLUTION.slice(0, 80) + "0"))), false);
});

test("apply places a digit and clears it from the cell and its peers", () => {
  const state = stateOf(new Array<number>(CELLS).fill(0));
  const next = apply(state, { place: { cell: cell(1, 1), digit: 5 }, eliminations: [] });
  assert.equal(next.grid[0], 5);
  assert.equal(next.cand[0], 0);
  assert.equal(next.cand[cell(1, 9)], ALL & ~mask(5));
  assert.equal(next.cand[cell(9, 1)], ALL & ~mask(5));
  assert.equal(next.cand[cell(3, 3)], ALL & ~mask(5));
  assert.equal(next.cand[cell(5, 5)], ALL);
  assert.equal(state.grid[0], 0, "the input is left alone");
  assert.equal(state.cand[0], ALL);
});

test("apply removes candidates and leaves the grid", () => {
  const state = stateOf(new Array<number>(CELLS).fill(0));
  const next = apply(state, { place: null, eliminations: [{ cell: 4, digit: 3 }, { cell: 4, digit: 9 }, { cell: 5, digit: 1 }] });
  assert.equal(next.cand[4], ALL & ~mask(3, 9));
  assert.equal(next.cand[5], ALL & ~mask(1));
  assert.deepEqual(next.grid, state.grid);
  assert.equal(state.cand[4], ALL);
});

test("names: cells, units and lists as the lessons write them", () => {
  assert.equal(cellName(0), "R1C1");
  assert.equal(cellName(cell(3, 5)), "R3C5");
  assert.equal(cellName(80), "R9C9");
  assert.equal(unitName(0), "row 1");
  assert.equal(unitName(8), "row 9");
  assert.equal(unitName(9), "column 1");
  assert.equal(unitName(17), "column 9");
  assert.equal(unitName(18), "box 1");
  assert.equal(unitName(26), "box 9");
  assert.equal(listOf([]), "");
  assert.equal(listOf(["a"]), "a");
  assert.equal(listOf([1, 2]), "1 and 2");
  assert.equal(listOf(["a", "b", "c"]), "a, b and c");
  assert.equal(cellNames([cell(3, 5), cell(3, 6), cell(4, 1)]), "R3C5, R3C6 and R4C1");
});
