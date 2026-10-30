import { CELLS, boxOf, colOf, rowOf } from "../core/geometry.ts";
import type { Xoshiro256StarStar } from "./random.ts";

/**
 * Backtracking Sudoku solver on bitmasks.
 *
 * Grids are arrays of 81 values with `0` for empty. Search always picks the
 * empty cell with the fewest candidates (lowest index on ties) and tries digits
 * in ascending order (or in an order drawn from a generator), so results are
 * fully deterministic.
 */
const ROW = Int8Array.from({ length: CELLS }, (_, i) => rowOf(i));
const COL = Int8Array.from({ length: CELLS }, (_, i) => colOf(i));
const BOX = Int8Array.from({ length: CELLS }, (_, i) => boxOf(i));
const ALL = 0x1ff;

/** Counts solutions of `cells`, stopping as soon as `limit` are found. */
export function countSolutions(cells: ArrayLike<number>, limit = 2): number {
  if (limit < 1) throw new RangeError("limit must be at least 1");
  const search = Search.create(cells);
  if (!search) return 0;
  search.limit = limit;
  search.run();
  return search.count;
}

export function hasUniqueSolution(cells: ArrayLike<number>): boolean {
  return countSolutions(cells, 2) === 1;
}

/** The first solution in search order, or `null` if there is none. */
export function solve(cells: ArrayLike<number>): number[] | null {
  const search = Search.create(cells);
  if (!search) return null;
  search.limit = 1;
  search.run();
  return search.first;
}

/** A complete valid grid built from `cells` (typically empty), with candidates tried in an order drawn from `random`. */
export function randomSolution(cells: ArrayLike<number>, random: Xoshiro256StarStar): number[] | null {
  const search = Search.create(cells);
  if (!search) return null;
  search.limit = 1;
  search.random = random;
  search.run();
  return search.first;
}

function popcount(x: number): number {
  let n = 0;
  for (; x; x &= x - 1) n++;
  return n;
}

class Search {
  readonly grid: Int32Array;
  readonly rows = new Int32Array(9);
  readonly cols = new Int32Array(9);
  readonly boxes = new Int32Array(9);
  limit = 2;
  random: Xoshiro256StarStar | null = null;
  count = 0;
  first: number[] | null = null;

  private constructor(grid: Int32Array) {
    this.grid = grid;
  }

  /** A search over a copy of `cells`, or `null` if the givens already conflict. */
  static create(cells: ArrayLike<number>): Search | null {
    if (cells.length !== CELLS) throw new RangeError(`expected ${CELLS} cells, got ${cells.length}`);
    const s = new Search(Int32Array.from(cells));
    for (let i = 0; i < CELLS; i++) {
      const d = cells[i]!;
      if (d === 0) continue;
      if (!(d >= 1 && d <= 9)) throw new RangeError(`cell value out of range at ${i}: ${d}`);
      const bit = 1 << (d - 1);
      if ((s.rows[ROW[i]!]! | s.cols[COL[i]!]! | s.boxes[BOX[i]!]!) & bit) return null;
      s.rows[ROW[i]!]! |= bit;
      s.cols[COL[i]!]! |= bit;
      s.boxes[BOX[i]!]! |= bit;
    }
    return s;
  }

  run(): void {
    this.search();
  }

  /** Returns true when the search should stop. */
  private search(): boolean {
    const { grid, rows, cols, boxes } = this;
    let best = -1;
    let bestMask = 0;
    let bestCount = 10;
    for (let i = 0; i < CELLS; i++) {
      if (grid[i] !== 0) continue;
      const mask = ALL & ~(rows[ROW[i]!]! | cols[COL[i]!]! | boxes[BOX[i]!]!);
      const n = popcount(mask);
      if (n < bestCount) {
        best = i;
        bestMask = mask;
        bestCount = n;
        if (n <= 1) break;
      }
    }
    if (best < 0) {
      this.count++;
      if (this.first === null) this.first = Array.from(grid);
      return this.count >= this.limit;
    }
    if (bestCount === 0) return false;

    const digits: number[] = [];
    for (let mask = bestMask; mask !== 0; mask &= mask - 1) digits.push(31 - Math.clz32(mask & -mask) + 1);
    this.random?.shuffle(digits);
    for (const d of digits) if (this.tryDigit(best, d)) return true;
    return false;
  }

  private tryDigit(i: number, d: number): boolean {
    const bit = 1 << (d - 1);
    const r = ROW[i]!, c = COL[i]!, b = BOX[i]!;
    this.grid[i] = d;
    this.rows[r]! |= bit;
    this.cols[c]! |= bit;
    this.boxes[b]! |= bit;
    const stop = this.search();
    this.grid[i] = 0;
    this.rows[r]! ^= bit;
    this.cols[c]! ^= bit;
    this.boxes[b]! ^= bit;
    return stop;
  }
}
