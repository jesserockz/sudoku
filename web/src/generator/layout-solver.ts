import { CELLS } from "../core/geometry.ts";
import type { Layout } from "../core/layout.ts";
import type { Xoshiro256StarStar } from "./random.ts";

/**
 * Backtracking solver for any {@link Layout}: the solver of `solver.ts`
 * generalised to the layout's units and killer cages, with a stronger
 * branching rule (irregular jigsaw regions need it). Standard puzzles keep
 * using `solver.ts`.
 *
 * A cell's candidates are the digits missing from all its units, and, in a
 * cage, the digits not yet in the cage that can still be part of a set of
 * distinct digits filling the cage's empty cells to its sum ({@link COMBOS}).
 * Search branches on whichever has the fewest options: an empty cell's
 * candidates, or the places of a digit a unit is missing (see `search`),
 * trying them in order or in an order drawn from a generator.
 *
 * Every search can be given a node budget (calls of the search step). A search
 * over budget stops and reports {@link ABORTED}, deterministically: the Go port
 * (`server/internal/puzzle/layout_solver.go`) counts nodes the same way.
 */
const ALL = 0x1ff;
/** The result of a search that ran out of its node budget. */
export const ABORTED = -1;
/** The default node budget of a uniqueness check: a check over budget counts as "not unique". */
export const MAX_SEARCH_NODES = 200_000;

/**
 * `COMBOS[((n * 46) + sum) * 512 + avail]` is the union of every set of `n`
 * distinct digits drawn from the mask `avail` that adds up to `sum` (0..45),
 * `n` 0..9.
 */
export const COMBOS = new Uint16Array(10 * 46 * 512);
for (let set = 0; set < 512; set++) {
  let n = 0;
  let sum = 0;
  for (let d = 0; d < 9; d++) {
    if ((set & (1 << d)) !== 0) {
      n++;
      sum += d + 1;
    }
  }
  for (let avail = set; avail < 512; avail = (avail + 1) | set) COMBOS[(n * 46 + sum) * 512 + avail]! |= set;
}

/** The digits that can go in a cage with `empty` empty cells, `rest` left to add and the digits of `used` placed. */
export function cageDigits(empty: number, rest: number, used: number): number {
  if (rest < 0 || rest > 45) return 0;
  return COMBOS[(empty * 46 + rest) * 512 + (ALL & ~used)]!;
}

/** Counts the solutions of `cells` under `layout`, up to `limit`; {@link ABORTED} if the search needs more than `nodeLimit` steps. */
export function countSolutionsIn(layout: Layout, cells: ArrayLike<number>, limit = 2, nodeLimit = MAX_SEARCH_NODES): number {
  if (limit < 1) throw new RangeError("limit must be at least 1");
  const search = LayoutSearch.create(layout, cells);
  if (!search) return 0;
  search.limit = limit;
  search.nodeLimit = nodeLimit;
  search.run();
  return search.aborted ? ABORTED : search.count;
}

/** Whether `cells` has exactly one solution under `layout`, proved within `nodeLimit` steps. */
export function hasUniqueSolutionIn(layout: Layout, cells: ArrayLike<number>, nodeLimit = MAX_SEARCH_NODES): boolean {
  return countSolutionsIn(layout, cells, 2, nodeLimit) === 1;
}

/**
 * A complete grid valid under `layout` built from `cells` (typically empty),
 * with candidates tried in an order drawn from `random`; `null` if there is
 * none within `nodeLimit` steps.
 */
export function randomSolutionIn(layout: Layout, cells: ArrayLike<number>, random: Xoshiro256StarStar, nodeLimit = MAX_SEARCH_NODES): number[] | null {
  const search = LayoutSearch.create(layout, cells);
  if (!search) return null;
  search.limit = 1;
  search.random = random;
  search.nodeLimit = nodeLimit;
  search.run();
  return search.first;
}

function popcount(x: number): number {
  let n = 0;
  for (; x; x &= x - 1) n++;
  return n;
}

class LayoutSearch {
  readonly grid: Int32Array;
  /** Candidates of the empty cells at the current node. */
  readonly cand = new Int32Array(CELLS);
  readonly units: readonly (readonly number[])[];
  /** The units of each cell, `unitsOf[i]`. */
  readonly unitsOf: readonly number[][];
  readonly used: Int32Array;
  readonly cageOf: readonly number[];
  readonly cages: readonly (readonly number[])[];
  /** The candidates of the empty cells from their units only, at the current node. */
  readonly unitCand = new Int32Array(CELLS);
  readonly cageUsed: Int32Array;
  readonly cageRest: Int32Array;
  readonly cageEmpty: Int32Array;
  limit = 2;
  nodeLimit = MAX_SEARCH_NODES;
  nodes = 0;
  aborted = false;
  random: Xoshiro256StarStar | null = null;
  count = 0;
  first: number[] | null = null;

  private constructor(layout: Layout, grid: Int32Array) {
    this.grid = grid;
    this.units = layout.units;
    this.unitsOf = Array.from({ length: CELLS }, () => []);
    layout.units.forEach((cells, u) => cells.forEach((c) => this.unitsOf[c]!.push(u)));
    this.used = new Int32Array(layout.units.length);
    this.cageOf = layout.cageOf;
    this.cages = layout.cages.map((c) => c.cells);
    const k = layout.cages.length;
    this.cageUsed = new Int32Array(k);
    this.cageRest = Int32Array.from(layout.cages, (c) => c.sum);
    this.cageEmpty = Int32Array.from(layout.cages, (c) => c.cells.length);
  }

  /** A search over a copy of `cells`, or `null` if the givens already break a rule (a repeat, or a cage they cannot complete to its sum). */
  static create(layout: Layout, cells: ArrayLike<number>): LayoutSearch | null {
    if (cells.length !== CELLS) throw new RangeError(`expected ${CELLS} cells, got ${cells.length}`);
    const s = new LayoutSearch(layout, Int32Array.from(cells));
    for (let i = 0; i < CELLS; i++) {
      const d = cells[i]!;
      if (d === 0) continue;
      if (!(d >= 1 && d <= 9)) throw new RangeError(`cell value out of range at ${i}: ${d}`);
      if ((s.mask(i) & (1 << (d - 1))) === 0) return null;
      s.set(i, d);
    }
    return s;
  }

  /** The digits the rules leave for empty cell `i` (ignoring what is in the cell). */
  mask(i: number): number {
    let taken = 0;
    for (const u of this.unitsOf[i]!) taken |= this.used[u]!;
    let mask = ALL & ~taken;
    const k = this.cageOf[i]!;
    if (k >= 0) mask &= cageDigits(this.cageEmpty[k]!, this.cageRest[k]!, this.cageUsed[k]!) & ~this.cageUsed[k]!;
    return mask;
  }

  set(i: number, d: number): void {
    const bit = 1 << (d - 1);
    this.grid[i] = d;
    for (const u of this.unitsOf[i]!) this.used[u]! |= bit;
    const k = this.cageOf[i]!;
    if (k >= 0) {
      this.cageUsed[k]! |= bit;
      this.cageRest[k]! -= d;
      this.cageEmpty[k]!--;
    }
  }

  clear(i: number, d: number): void {
    const bit = 1 << (d - 1);
    this.grid[i] = 0;
    for (const u of this.unitsOf[i]!) this.used[u]! ^= bit;
    const k = this.cageOf[i]!;
    if (k >= 0) {
      this.cageUsed[k]! ^= bit;
      this.cageRest[k]! += d;
      this.cageEmpty[k]!++;
    }
  }

  run(): void {
    this.search();
  }

  /**
   * Narrows the candidates of cage `k`'s empty cells: digit `d` stays in cell
   * `i` if it is not in the cage yet and the cage's other empty cells can take
   * distinct digits, not in the cage and not `d`, from their own candidates
   * (by units) that add up to the rest of the sum.
   */
  private refineCage(k: number): void {
    const empty = this.cageEmpty[k]!;
    if (empty === 0) return;
    const rest = this.cageRest[k]!;
    const free = ALL & ~this.cageUsed[k]!;
    for (const i of this.cages[k]!) {
      if (this.grid[i] !== 0) continue;
      let others = 0;
      for (const j of this.cages[k]!) if (j !== i && this.grid[j] === 0) others |= this.unitCand[j]!;
      let allowed = 0;
      for (let m = this.unitCand[i]! & free; m !== 0; m &= m - 1) {
        const bit = m & -m;
        const left = rest - (31 - Math.clz32(bit) + 1);
        if (empty === 1 ? left === 0 : left >= 0 && left <= 45 && COMBOS[((empty - 1) * 46 + left) * 512 + (others & free & ~bit)] !== 0) allowed |= bit;
      }
      this.cand[i] = allowed;
    }
  }

  /**
   * Returns true when the search should stop. Branches on the empty cell with
   * the fewest candidates (lowest index on ties), unless some unit has a
   * missing digit with fewer places (units in order, digits 1..9, first
   * strictly fewer wins), which then branches on those places, ascending.
   */
  private search(): boolean {
    if (++this.nodes > this.nodeLimit) {
      this.aborted = true;
      return true;
    }
    const { grid, cand, unitCand } = this;
    for (let i = 0; i < CELLS; i++) {
      if (grid[i] !== 0) continue;
      let taken = 0;
      for (const u of this.unitsOf[i]!) taken |= this.used[u]!;
      unitCand[i] = ALL & ~taken;
      cand[i] = unitCand[i]!;
    }
    for (let k = 0; k < this.cages.length; k++) this.refineCage(k);
    let best = -1;
    let bestCount = 10;
    for (let i = 0; i < CELLS; i++) {
      if (grid[i] !== 0) continue;
      const n = popcount(cand[i]!);
      if (n < bestCount) {
        best = i;
        bestCount = n;
        if (n === 0) return false;
      }
    }
    if (best < 0) {
      this.count++;
      if (this.first === null) this.first = Array.from(grid);
      return this.count >= this.limit;
    }
    let unit = -1;
    let unitDigit = 0;
    if (bestCount > 1) {
      for (let u = 0; u < this.units.length && bestCount > 1; u++) {
        const missing = ALL & ~this.used[u]!;
        for (let m = missing; m !== 0; m &= m - 1) {
          const bit = m & -m;
          let n = 0;
          for (const c of this.units[u]!) if (grid[c] === 0 && (cand[c]! & bit) !== 0) n++;
          if (n === 0) return false;
          if (n < bestCount) {
            unit = u;
            unitDigit = bit;
            bestCount = n;
          }
        }
      }
    }
    const options: number[] = [];
    if (unit < 0) {
      for (let mask = cand[best]!; mask !== 0; mask &= mask - 1) options.push(31 - Math.clz32(mask & -mask) + 1);
    } else {
      for (const c of this.units[unit]!) if (grid[c] === 0 && (cand[c]! & unitDigit) !== 0) options.push(c);
    }
    this.random?.shuffle(options);
    const d0 = 31 - Math.clz32(unitDigit) + 1;
    for (const o of options) {
      const [i, d] = unit < 0 ? [best, o] : [o, d0];
      this.set(i, d);
      const stop = this.search();
      this.clear(i, d);
      if (stop) return true;
    }
    return false;
  }
}
