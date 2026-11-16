import { CELLS, colOf, rowOf } from "../core/geometry.ts";
import { Layout } from "../core/layout.ts";
import { COMBOS } from "./layout-solver.ts";

/**
 * A deterministic, human-style technique grader.
 *
 * It solves a puzzle the way a person would, one step at a time, and reports
 * the hardest technique it needed. Candidates are 9-bit masks per cell (bit
 * `d - 1` set when digit `d` is still possible). Each step tries the
 * techniques in the fixed order of {@link TECHNIQUES}, applies only the FIRST
 * instance found, then starts again from the first technique. A technique
 * "applies" only if it places a digit or removes at least one candidate.
 *
 * Everything is integer and bitmask maths with fixed scan orders, so the Go
 * port (`server/internal/puzzle/grader.go`) matches it step for step. Any
 * change here that alters a step changes the grades, so the shared fixture
 * (`testdata/generator-v2.json`) pins it, and `testdata/variants.json` the
 * variant layouts.
 *
 * The grid's rules come from a {@link Layout} (standard by default): its units
 * are the houses, its peers (unit and cage mates) are the cells a cell "sees".
 * Diagonals and jigsaw regions are houses like boxes; fish stay row and column
 * based. Killer layouts add the cage techniques (see {@link KILLER_TECHNIQUES}).
 *
 * Scan orders, used everywhere below:
 * - Units are numbered as in the layout: 0..8 rows, 9..17 columns, 18..26
 *   regions (boxes or jigsaw regions), 27..28 diagonals; the cells of a unit,
 *   and the peers of a cell, ascend by cell index.
 * - Digits are scanned 1..9 (bit 0..8), cells 0..80.
 * - "Choose k of a list" enumerates the combinations in lexicographic order of
 *   list position, the list itself being in ascending order.
 *
 * The grid must be a valid puzzle (a solution exists). The grader never
 * removes a true candidate then, which is also why a combination that passes
 * the size pruning has exactly the digits (or cells) it should.
 */
export interface Technique {
  readonly name: string;
  /** 1 hidden single .. 6 simple colouring and XY-chain. */
  readonly level: number;
}

/** The techniques in the order they are tried. The index is the technique's id in {@link Grade.counts}. */
export const TECHNIQUES: readonly Technique[] = [
  { name: "hiddenSingle", level: 1 },
  { name: "nakedSingle", level: 2 },
  { name: "pointing", level: 3 },
  { name: "claiming", level: 3 },
  { name: "nakedPair", level: 4 },
  { name: "hiddenPair", level: 4 },
  { name: "nakedTriple", level: 4 },
  { name: "hiddenTriple", level: 4 },
  { name: "nakedQuad", level: 4 },
  { name: "hiddenQuad", level: 4 },
  { name: "xWing", level: 5 },
  { name: "swordfish", level: 5 },
  { name: "xyWing", level: 5 },
  { name: "xyzWing", level: 5 },
  { name: "simpleColouring", level: 6 },
  { name: "xyChain", level: 6 },
];

/**
 * The killer techniques, tried in this order (after {@link TECHNIQUES}' singles,
 * see {@link KILLER_TECHNIQUES}). Levels: cage combinations 2 (basic cage
 * arithmetic, like a naked single), the 45 rule 3 (like locked candidates).
 */
export const CAGE_TECHNIQUES: readonly Technique[] = [
  { name: "cageCombination", level: 2 },
  { name: "rule45", level: 3 },
  { name: "cagePointing", level: 5 },
  { name: "rule45Lines", level: 6 },
];

/** Technique ids (indices into {@link TECHNIQUES} then {@link CAGE_TECHNIQUES}) in the order a killer grid tries them. */
const KILLER_ORDER: readonly number[] = [0, 1, 16, 2, 3, 17, 18, 4, 5, 6, 7, 8, 9, 19, 10, 11, 12, 13, 14, 15];
const STANDARD_ORDER: readonly number[] = TECHNIQUES.map((_, i) => i);

/**
 * The techniques of a killer grid in the order they are tried: hidden single,
 * naked single, cage combination, pointing, claiming, 45 rule, then the rest of
 * {@link TECHNIQUES} in order. {@link Grade.counts} of a killer grid is indexed
 * by this list.
 */
export const KILLER_TECHNIQUES: readonly Technique[] = KILLER_ORDER.map((id) => [...TECHNIQUES, ...CAGE_TECHNIQUES][id]!);

/** The techniques of a layout in the order they are tried: {@link KILLER_TECHNIQUES} with cages, else {@link TECHNIQUES}. */
export function techniquesFor(layout: Layout): readonly Technique[] {
  return layout.cages.length > 0 ? KILLER_TECHNIQUES : TECHNIQUES;
}

/** The most unfilled cells in a set of innies or outies the 45 rule works on. */
export const MAX_RULE45_CELLS = 4;

/** The level reported for a puzzle the grader cannot finish. */
export const STUCK_LEVEL = 7;
/** The most cells in an XY-chain. */
export const MAX_CHAIN = 8;

export interface Grade {
  readonly solved: boolean;
  /** The hardest level used; {@link STUCK_LEVEL} if not solved, 0 if the grid was already complete. */
  readonly level: number;
  /** The number of steps (placements or eliminations) taken. */
  readonly steps: number;
  /** Steps taken per technique, indexed like {@link techniquesFor} the layout ({@link TECHNIQUES} for standard). */
  readonly counts: readonly number[];
}

const ALL = 0x1ff;
/** The most units a cell is in (a diagonal's centre: row, column, box and both diagonals). */
const MAX_LINKS = 5;

/** A cell set of the 45 rule with a known sum: innies or outies of a unit. */
interface SumSet {
  readonly cells: readonly number[];
  readonly sum: number;
}

/** Lookup tables for one layout, built once per layout. */
interface Tables {
  readonly units: readonly (readonly number[])[];
  readonly peers: readonly (readonly number[])[];
  /** `member[u * 81 + c]` is 1 when cell `c` is in unit `u`. */
  readonly member: Uint8Array;
  /** `sees[a * 81 + b]` is 1 when cells `a` and `b` are peers. */
  readonly sees: Uint8Array;
  /** For each unit from 18 on, the other units from 18 on that share at least two cells with it, ascending. */
  readonly overlaps: readonly (readonly number[])[];
  /** For each of units 0..26 of a killer layout: its innies then its outies (empty sets left out). */
  readonly rule45: readonly (readonly SumSet[])[];
  /** The same for 2 then 3 adjacent rows (from the top), then 2 then 3 adjacent columns (from the left). */
  readonly rule45Lines: readonly (readonly SumSet[])[];
  /** Technique ids in the order they are tried. */
  readonly order: readonly number[];
}

const TABLES = new WeakMap<Layout, Tables>();

function tablesFor(layout: Layout): Tables {
  let t = TABLES.get(layout);
  if (t === undefined) {
    t = buildTables(layout);
    TABLES.set(layout, t);
  }
  return t;
}

function buildTables(layout: Layout): Tables {
  const { units, peers, cages } = layout;
  const member = new Uint8Array(units.length * CELLS);
  units.forEach((cells, u) => cells.forEach((c) => (member[u * CELLS + c] = 1)));
  const sees = new Uint8Array(CELLS * CELLS);
  peers.forEach((list, a) => list.forEach((b) => (sees[a * CELLS + b] = 1)));
  const overlaps = units.map((cells, u) => {
    const list: number[] = [];
    if (u < 18) return list;
    for (let v = 18; v < units.length; v++) {
      if (v !== u && cells.filter((c) => member[v * CELLS + c] === 1).length >= 2) list.push(v);
    }
    return list;
  });
  /** The innies and outies of a set of whole units (`inside[c]` is 1 for its cells) adding up to `total`. */
  const sumSets = (inside: Uint8Array, total: number): SumSet[] => {
    let whole = 0;
    let partial = 0;
    const innies: number[] = [];
    const outies: number[] = [];
    for (const cage of cages) {
      const n = cage.cells.filter((c) => inside[c] === 1).length;
      if (n === cage.cells.length) whole += cage.sum;
      else if (n > 0) {
        partial += cage.sum;
        for (const c of cage.cells) (inside[c] === 1 ? innies : outies).push(c);
      }
    }
    if (innies.length === 0) return [];
    innies.sort((a, b) => a - b);
    outies.sort((a, b) => a - b);
    return [{ cells: innies, sum: total - whole }, { cells: outies, sum: whole + partial - total }];
  };
  const cellSet = (groups: readonly (readonly number[])[]): Uint8Array => {
    const inside = new Uint8Array(CELLS);
    for (const g of groups) for (const c of g) inside[c] = 1;
    return inside;
  };
  const rule45 = cages.length === 0 ? [] : units.slice(0, 27).map((cells) => sumSets(cellSet([cells]), 45));
  const rule45Lines: SumSet[][] = [];
  if (cages.length > 0) {
    for (const first of [0, 9]) {
      for (let span = 2; span <= 3; span++) {
        for (let u = first; u + span <= first + 9; u++) rule45Lines.push(sumSets(cellSet(units.slice(u, u + span)), 45 * span));
      }
    }
  }
  return { units, peers, member, sees, overlaps, rule45, rule45Lines, order: cages.length > 0 ? KILLER_ORDER : STANDARD_ORDER };
}

function popcount(x: number): number {
  let n = 0;
  for (; x; x &= x - 1) n++;
  return n;
}

/** The index (0..8) of the lowest set bit of a non-zero mask. */
const lowBit = (x: number): number => 31 - Math.clz32(x & -x);
/** Whether exactly one bit of `x` is set. */
const one = (x: number): boolean => x !== 0 && (x & (x - 1)) === 0;

/** Steps through the grading of one grid; {@link grade} runs it to the end. */
export class Grader {
  readonly layout: Layout;
  readonly grid = new Int32Array(CELLS);
  /** Candidate masks; 0 for a filled cell. */
  readonly cand = new Int32Array(CELLS);
  /** How many cells are filled. */
  placed = 0;
  readonly #list: number[] = [];
  readonly #pick: number[] = [];
  readonly #pos = new Int32Array(9);
  readonly #t: Tables;
  readonly #units: readonly (readonly number[])[];
  readonly #peers: readonly (readonly number[])[];
  readonly #member: Uint8Array;
  readonly #sees: Uint8Array;
  readonly #links = new Int32Array(CELLS * MAX_LINKS);
  readonly #linkCount = new Int32Array(CELLS);
  readonly #colour = new Int32Array(CELLS);
  readonly #stamp = new Int32Array(CELLS);
  readonly #queue = new Int32Array(CELLS);
  readonly #visited = new Uint8Array(CELLS);
  readonly #found = new Int32Array(CELLS);
  readonly #assign = new Int32Array(CELLS);
  readonly #lo = new Int32Array(CELLS + 1);
  readonly #hi = new Int32Array(CELLS + 1);

  constructor(cells: ArrayLike<number>, layout: Layout = Layout.STANDARD) {
    if (cells.length !== CELLS) throw new RangeError(`expected ${CELLS} cells, got ${cells.length}`);
    this.layout = layout;
    this.#t = tablesFor(layout);
    this.#units = this.#t.units;
    this.#peers = this.#t.peers;
    this.#member = this.#t.member;
    this.#sees = this.#t.sees;
    for (let i = 0; i < CELLS; i++) {
      const d = cells[i]!;
      if (!(Number.isInteger(d) && d >= 0 && d <= 9)) throw new RangeError(`cell value out of range at ${i}: ${d}`);
      if (d === 0) continue;
      this.grid[i] = d;
      this.placed++;
    }
    for (let i = 0; i < CELLS; i++) {
      if (this.grid[i] !== 0) continue;
      let used = 0;
      for (const p of this.#peers[i]!) if (this.grid[p] !== 0) used |= 1 << (this.grid[p]! - 1);
      this.cand[i] = ALL & ~used;
    }
  }

  /** Applies the first available step; returns the technique's index in {@link techniquesFor} the layout, or -1 when none applies. */
  step(): number {
    const order = this.#t.order;
    for (let t = 0; t < order.length; t++) if (this.#run(order[t]!)) return t;
    return -1;
  }

  #run(t: number): boolean {
    switch (t) {
      case 0: return this.#hiddenSingle();
      case 1: return this.#nakedSingle();
      case 2: return this.#pointing();
      case 3: return this.#claiming();
      case 4: return this.#nakedSubset(2);
      case 5: return this.#hiddenSubset(2);
      case 6: return this.#nakedSubset(3);
      case 7: return this.#hiddenSubset(3);
      case 8: return this.#nakedSubset(4);
      case 9: return this.#hiddenSubset(4);
      case 10: return this.#fish(2);
      case 11: return this.#fish(3);
      case 12: return this.#xyWing();
      case 13: return this.#xyzWing();
      case 14: return this.#simpleColouring();
      case 15: return this.#xyChain();
      case 16: return this.#cageCombination();
      case 17: return this.#rule45(this.#t.rule45);
      case 18: return this.#cagePointing();
      default: return this.#rule45(this.#t.rule45Lines);
    }
  }

  #place(i: number, bit: number): void {
    this.grid[i] = lowBit(bit) + 1;
    this.cand[i] = 0;
    this.placed++;
    for (const j of this.#peers[i]!) this.cand[j]! &= ~bit;
  }

  /** Removes the candidates in `mask` from cell `i`; true if any were there. */
  #elim(i: number, mask: number): boolean {
    if ((this.cand[i]! & mask) === 0) return false;
    this.cand[i]! &= ~mask;
    return true;
  }

  /** Removes digit `bit` from the cells of unit `from` that are not in unit `except`; true if any went. */
  #elimOutside(from: number, except: number, bit: number): boolean {
    let any = false;
    for (const c of this.#units[from]!) if (this.#member[except * CELLS + c] === 0 && this.#elim(c, bit)) any = true;
    return any;
  }

  /** Hidden single: every unit in order, digits 1..9; a digit with exactly one place in a unit goes there. */
  #hiddenSingle(): boolean {
    for (let u = 0; u < this.#units.length; u++) {
      for (let d = 0; d < 9; d++) {
        const bit = 1 << d;
        let at = -1;
        let n = 0;
        for (const c of this.#units[u]!) {
          if ((this.cand[c]! & bit) !== 0) {
            at = c;
            n++;
          }
        }
        if (n === 1) {
          this.#place(at, bit);
          return true;
        }
      }
    }
    return false;
  }

  /** Naked single: the lowest cell with exactly one candidate takes it. */
  #nakedSingle(): boolean {
    for (let i = 0; i < CELLS; i++) {
      if (one(this.cand[i]!)) {
        this.#place(i, this.cand[i]!);
        return true;
      }
    }
    return false;
  }

  /**
   * Pointing: units from 18 on (regions, then diagonals), digits 1..9; when a
   * digit's places in the unit share a row (tried first) or a column, it goes
   * from the rest of that line. Then, in ascending order, any other unit from
   * 18 on that overlaps this one in two or more cells (a box and a diagonal)
   * and holds all those places loses the digit outside this unit.
   */
  #pointing(): boolean {
    const units = this.#units;
    for (let u = 18; u < units.length; u++) {
      for (let d = 0; d < 9; d++) {
        const bit = 1 << d;
        let rowMask = 0;
        let colMask = 0;
        for (const c of units[u]!) {
          if ((this.cand[c]! & bit) !== 0) {
            rowMask |= 1 << rowOf(c);
            colMask |= 1 << colOf(c);
          }
        }
        if (one(rowMask) && this.#elimOutside(lowBit(rowMask), u, bit)) return true;
        if (one(colMask) && this.#elimOutside(9 + lowBit(colMask), u, bit)) return true;
        if (rowMask === 0) continue;
        for (const v of this.#t.overlaps[u]!) {
          if (units[u]!.every((c) => (this.cand[c]! & bit) === 0 || this.#member[v * CELLS + c] === 1) && this.#elimOutside(v, u, bit)) return true;
        }
      }
    }
    return false;
  }

  /**
   * Claiming (box-line reduction): rows 0..8 then columns 0..8, digits 1..9;
   * when a digit's places in a line share a region (box or jigsaw region), it
   * goes from the rest of that region.
   */
  #claiming(): boolean {
    const regions = this.layout.regions;
    for (let u = 0; u < 18; u++) {
      for (let d = 0; d < 9; d++) {
        const bit = 1 << d;
        let boxMask = 0;
        for (const c of this.#units[u]!) {
          if ((this.cand[c]! & bit) !== 0) boxMask |= 1 << regions[c]!;
        }
        if (one(boxMask) && this.#elimOutside(18 + lowBit(boxMask), u, bit)) return true;
      }
    }
    return false;
  }

  /**
   * Naked subset of size `k` (pair, triple, quad): every unit; among the
   * cells with 2..k candidates, the first combination of `k` cells whose
   * candidates together are exactly `k` digits removes those digits from the
   * unit's other cells.
   */
  #nakedSubset(k: number): boolean {
    for (let u = 0; u < this.#units.length; u++) {
      this.#list.length = 0;
      for (const c of this.#units[u]!) {
        const n = popcount(this.cand[c]!);
        if (n >= 2 && n <= k) this.#list.push(c);
      }
      if (this.#chooseNaked(u, k, 0, 0, 0)) return true;
    }
    return false;
  }

  #chooseNaked(u: number, k: number, start: number, depth: number, union: number): boolean {
    if (popcount(union) > k) return false;
    if (depth === k) {
      let any = false;
      for (const c of this.#units[u]!) if (!this.#pick.includes(c) && this.#elim(c, union)) any = true;
      return any;
    }
    for (let j = start; j < this.#list.length; j++) {
      const c = this.#list[j]!;
      this.#pick.length = depth;
      this.#pick.push(c);
      if (this.#chooseNaked(u, k, j + 1, depth + 1, union | this.cand[c]!)) return true;
    }
    return false;
  }

  /**
   * Hidden subset of size `k`: every unit; among the digits with 2..k places
   * in the unit, the first combination of `k` digits whose places together
   * are exactly `k` cells strips every other candidate from those cells.
   */
  #hiddenSubset(k: number): boolean {
    for (let u = 0; u < this.#units.length; u++) {
      this.#pos.fill(0);
      this.#units[u]!.forEach((c, p) => {
        for (let m = this.cand[c]!; m !== 0; m &= m - 1) this.#pos[lowBit(m)]! |= 1 << p;
      });
      this.#list.length = 0;
      for (let d = 0; d < 9; d++) {
        const n = popcount(this.#pos[d]!);
        if (n >= 2 && n <= k) this.#list.push(d);
      }
      if (this.#chooseHidden(u, k, 0, 0, 0, 0)) return true;
    }
    return false;
  }

  #chooseHidden(u: number, k: number, start: number, depth: number, union: number, digits: number): boolean {
    if (popcount(union) > k) return false;
    if (depth === k) {
      let any = false;
      for (let p = 0; p < 9; p++) if ((union & (1 << p)) !== 0 && this.#elim(this.#units[u]![p]!, ALL & ~digits)) any = true;
      return any;
    }
    for (let j = start; j < this.#list.length; j++) {
      const d = this.#list[j]!;
      if (this.#chooseHidden(u, k, j + 1, depth + 1, union | this.#pos[d]!, digits | (1 << d))) return true;
    }
    return false;
  }

  /**
   * Fish of size `n` (2 X-Wing, 3 Swordfish): digits 1..9, rows-based then
   * columns-based. Among the base lines (rows, or columns) with 2..n places
   * for the digit, the first combination of `n` lines whose places lie in
   * exactly `n` cover lines removes the digit from those cover lines outside
   * the base lines.
   */
  #fish(n: number): boolean {
    for (let d = 0; d < 9; d++) {
      const bit = 1 << d;
      for (let o = 0; o < 2; o++) {
        this.#list.length = 0;
        for (let b = 0; b < 9; b++) {
          let m = 0;
          this.#units[o * 9 + b]!.forEach((c, p) => {
            if ((this.cand[c]! & bit) !== 0) m |= 1 << p;
          });
          this.#pos[b] = m;
          const count = popcount(m);
          if (count >= 2 && count <= n) this.#list.push(b);
        }
        if (this.#chooseFish(o, bit, n, 0, 0, 0, 0)) return true;
      }
    }
    return false;
  }

  #chooseFish(o: number, bit: number, n: number, start: number, depth: number, union: number, bases: number): boolean {
    if (popcount(union) > n) return false;
    if (depth === n) {
      let any = false;
      for (let p = 0; p < 9; p++) {
        if ((union & (1 << p)) === 0) continue;
        for (const c of this.#units[(1 - o) * 9 + p]!) {
          const base = o === 0 ? rowOf(c) : colOf(c);
          if ((bases & (1 << base)) === 0 && this.#elim(c, bit)) any = true;
        }
      }
      return any;
    }
    for (let j = start; j < this.#list.length; j++) {
      const b = this.#list[j]!;
      if (this.#chooseFish(o, bit, n, j + 1, depth + 1, union | this.#pos[b]!, bases | (1 << b))) return true;
    }
    return false;
  }

  /**
   * XY-Wing: pivots 0..80 with two candidates; first wing among the pivot's
   * peers with two candidates sharing exactly one with the pivot (the other,
   * z, is not the pivot's); second wing among the peers with exactly the
   * pivot's other digit and z. z goes from every cell (ascending) that sees
   * both wings.
   */
  #xyWing(): boolean {
    for (let p = 0; p < CELLS; p++) {
      const pivot = this.cand[p]!;
      if (popcount(pivot) !== 2) continue;
      for (const w1 of this.#peers[p]!) {
        const c1 = this.cand[w1]!;
        if (popcount(c1) !== 2 || !one(c1 & pivot)) continue;
        const z = c1 & ~pivot;
        const want = (pivot & ~c1) | z;
        for (const w2 of this.#peers[p]!) {
          if (this.cand[w2] !== want) continue;
          if (this.#elimSeeing(w1, w2, z)) return true;
        }
      }
    }
    return false;
  }

  /** Removes digit `bit` from every cell that sees both `a` and `b`; true if any went. */
  #elimSeeing(a: number, b: number, bit: number): boolean {
    let any = false;
    const sees = this.#sees;
    for (let t = 0; t < CELLS; t++) if (sees[a * CELLS + t] === 1 && sees[b * CELLS + t] === 1 && this.#elim(t, bit)) any = true;
    return any;
  }

  /**
   * XYZ-Wing: pivots 0..80 with three candidates; pairs of distinct peers
   * (first below second) with two candidates each, both within the pivot's.
   * Their shared digit z goes from every cell that sees the pivot and both
   * wings.
   */
  #xyzWing(): boolean {
    for (let p = 0; p < CELLS; p++) {
      const pivot = this.cand[p]!;
      if (popcount(pivot) !== 3) continue;
      for (const w1 of this.#peers[p]!) {
        const c1 = this.cand[w1]!;
        if (popcount(c1) !== 2 || (c1 & ~pivot) !== 0) continue;
        for (const w2 of this.#peers[p]!) {
          const c2 = this.cand[w2]!;
          if (w2 <= w1 || popcount(c2) !== 2 || (c2 & ~pivot) !== 0 || c2 === c1) continue;
          const z = c1 & c2;
          let any = false;
          const sees = this.#sees;
          for (let t = 0; t < CELLS; t++) {
            if (sees[p * CELLS + t] === 1 && sees[w1 * CELLS + t] === 1 && sees[w2 * CELLS + t] === 1 && this.#elim(t, z)) any = true;
          }
          if (any) return true;
        }
      }
    }
    return false;
  }

  /**
   * Simple colouring: digits 1..9. The digit's strong links are the units
   * with exactly two places for it. Each connected group of links is coloured
   * alternately from its lowest cell (breadth first); groups in order of
   * lowest cell. For each group: colour wrap first (colour 0 then 1: two
   * cells of one colour that see each other make that colour false, so the
   * digit goes from all its cells), then colour trap (a cell outside the
   * group that sees both colours loses the digit).
   */
  #simpleColouring(): boolean {
    for (let d = 0; d < 9; d++) {
      const bit = 1 << d;
      this.#linkCount.fill(0);
      this.#colour.fill(-1);
      this.#stamp.fill(0);
      for (let u = 0; u < this.#units.length; u++) {
        let a = -1;
        let b = -1;
        let n = 0;
        for (const c of this.#units[u]!) {
          if ((this.cand[c]! & bit) === 0) continue;
          if (n === 0) a = c;
          else b = c;
          n++;
        }
        if (n === 2) {
          this.#link(a, b);
          this.#link(b, a);
        }
      }
      for (let s = 0; s < CELLS; s++) {
        if (this.#colour[s] !== -1 || this.#linkCount[s] === 0) continue;
        const size = this.#colourGroup(s);
        if (this.#wrap(size, bit)) return true;
        if (this.#trap(s, size, bit)) return true;
      }
    }
    return false;
  }

  #link(a: number, b: number): void {
    const n = this.#linkCount[a]!;
    for (let i = 0; i < n; i++) if (this.#links[a * MAX_LINKS + i] === b) return;
    this.#links[a * MAX_LINKS + n] = b;
    this.#linkCount[a] = n + 1;
  }

  /** Colours the group of `s` breadth first into the queue; returns its size. */
  #colourGroup(s: number): number {
    const queue = this.#queue;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    this.#colour[s] = 0;
    this.#stamp[s] = s + 1;
    while (head < tail) {
      const v = queue[head++]!;
      for (let i = 0; i < this.#linkCount[v]!; i++) {
        const w = this.#links[v * MAX_LINKS + i]!;
        if (this.#colour[w] !== -1) continue;
        this.#colour[w] = 1 - this.#colour[v]!;
        this.#stamp[w] = s + 1;
        queue[tail++] = w;
      }
    }
    return tail;
  }

  /** Colour wrap on the coloured group in the queue: a colour with two cells in view of each other is false. */
  #wrap(size: number, bit: number): boolean {
    for (let colour = 0; colour < 2; colour++) {
      if (!this.#seesItself(size, colour)) continue;
      for (let i = 0; i < size; i++) if (this.#colour[this.#queue[i]!] === colour) this.#elim(this.#queue[i]!, bit);
      return true;
    }
    return false;
  }

  /** Whether two cells of `colour` in the queue's group see each other. */
  #seesItself(size: number, colour: number): boolean {
    const queue = this.#queue;
    for (let i = 0; i < size; i++) {
      for (let j = i + 1; j < size; j++) {
        if (this.#colour[queue[i]!] === colour && this.#colour[queue[j]!] === colour && this.#sees[queue[i]! * CELLS + queue[j]!] === 1) return true;
      }
    }
    return false;
  }

  /** Colour trap on the coloured group in the queue (group id `s + 1`). */
  #trap(s: number, size: number, bit: number): boolean {
    const queue = this.#queue;
    let any = false;
    for (let t = 0; t < CELLS; t++) {
      if ((this.cand[t]! & bit) === 0 || this.#stamp[t] === s + 1) continue;
      let seen = 0;
      for (let i = 0; i < size; i++) if (this.#sees[t * CELLS + queue[i]!] === 1) seen |= 1 << this.#colour[queue[i]!]!;
      if (seen === 3 && this.#elim(t, bit)) any = true;
    }
    return any;
  }

  /**
   * XY-Chain: start cells 0..80 with two candidates; for each of the start's
   * digits x (low then high), a depth-first walk through bivalue peers
   * (ascending, unvisited) that contain the digit carried from the previous
   * cell, carrying the other one on. A chain of at least 3 and at most
   * {@link MAX_CHAIN} cells whose last cell carries x removes x from every
   * cell that sees both ends. The first elimination found wins.
   */
  #xyChain(): boolean {
    for (let s = 0; s < CELLS; s++) {
      const cs = this.cand[s]!;
      if (popcount(cs) !== 2) continue;
      const low = cs & -cs;
      for (const x of [low, cs ^ low]) {
        this.#visited[s] = 1;
        const hit = this.#extend(s, x, s, cs ^ x, 1);
        this.#visited[s] = 0;
        if (hit) return true;
      }
    }
    return false;
  }

  #extend(start: number, x: number, cur: number, carry: number, length: number): boolean {
    for (const next of this.#peers[cur]!) {
      const cn = this.cand[next]!;
      if (this.#visited[next] === 1 || popcount(cn) !== 2 || (cn & carry) === 0) continue;
      const other = cn ^ carry;
      if (length + 1 >= 3 && other === x && this.#elimSeeing(start, next, x)) return true;
      if (length + 1 < MAX_CHAIN) {
        this.#visited[next] = 1;
        const hit = this.#extend(start, x, next, other, length + 1);
        this.#visited[next] = 0;
        if (hit) return true;
      }
    }
    return false;
  }

  /**
   * Cage combination: cages in order (by lowest cell). The cage's empty cells
   * keep only the digits that appear in some way of filling them: one
   * candidate per cell, no repeat between cells that see each other, adding
   * up to the cage's sum less its filled digits. The first cage that loses a
   * candidate is the step.
   */
  #cageCombination(): boolean {
    for (const cage of this.layout.cages) if (this.#restrictSum(cage.cells, cage.sum)) return true;
    return false;
  }

  /**
   * The 45 rule: units 0..26 (rows, columns, boxes). A unit's digits add up
   * to 45, so the cells of the cages partly inside it that lie inside (the
   * innies) add up to 45 less the cages wholly inside; those that lie outside
   * (the outies) add up to the cages touching the unit less 45. Innies then
   * outies, each restricted like a cage (repeats allowed only between cells
   * that do not see each other) when 1 to {@link MAX_RULE45_CELLS} of their
   * cells are empty. The first set that loses a candidate is the step.
   */
  #rule45(groups: readonly (readonly SumSet[])[]): boolean {
    for (const sets of groups) {
      for (const set of sets) if (this.#restrictSum(set.cells, set.sum, MAX_RULE45_CELLS)) return true;
    }
    return false;
  }

  /**
   * Cage pointing: cages in order, digits 1..9. A digit every filling of the
   * cage must use (no set of distinct digits without it, drawn from the empty
   * cells' candidates, adds up to the rest of the sum) whose places in the
   * cage share a row, column or box (tried in that order) goes from the rest
   * of that unit.
   */
  #cagePointing(): boolean {
    const { cages, regions } = this.layout;
    for (let k = 0; k < cages.length; k++) {
      let rest = cages[k]!.sum;
      let used = 0;
      let avail = 0;
      let n = 0;
      for (const c of cages[k]!.cells) {
        if (this.grid[c] !== 0) {
          rest -= this.grid[c]!;
          used |= 1 << (this.grid[c]! - 1);
        } else {
          n++;
          avail |= this.cand[c]!;
        }
      }
      avail &= ~used;
      for (let m = avail; m !== 0; m &= m - 1) {
        const bit = m & -m;
        if (COMBOS[(n * 46 + rest) * 512 + (avail & ~bit)] !== 0) continue;
        let rowMask = 0;
        let colMask = 0;
        let boxMask = 0;
        for (const c of cages[k]!.cells) {
          if ((this.cand[c]! & bit) === 0) continue;
          rowMask |= 1 << rowOf(c);
          colMask |= 1 << colOf(c);
          boxMask |= 1 << regions[c]!;
        }
        if (one(rowMask) && this.#elimOutsideCage(lowBit(rowMask), k, bit)) return true;
        if (one(colMask) && this.#elimOutsideCage(9 + lowBit(colMask), k, bit)) return true;
        if (one(boxMask) && this.#elimOutsideCage(18 + lowBit(boxMask), k, bit)) return true;
      }
    }
    return false;
  }

  /** Removes digit `bit` from the cells of unit `u` outside cage `k`; true if any went. */
  #elimOutsideCage(u: number, k: number, bit: number): boolean {
    let any = false;
    for (const c of this.#units[u]!) if (this.layout.cageOf[c] !== k && this.#elim(c, bit)) any = true;
    return any;
  }

  /**
   * Restricts the empty cells among `cells` to the digits of some filling that
   * adds up to `sum` less the filled cells' digits (see
   * {@link #cageCombination}). Does nothing when no cell, or more than
   * `maxEmpty`, is empty. True if a candidate went.
   */
  #restrictSum(cells: readonly number[], sum: number, maxEmpty = CELLS): boolean {
    const list = this.#list;
    list.length = 0;
    let rest = sum;
    for (const c of cells) {
      if (this.grid[c] !== 0) rest -= this.grid[c]!;
      else list.push(c);
    }
    const n = list.length;
    if (n === 0 || n > maxEmpty) return false;
    // Suffix bounds for pruning: the least and most the cells from k on can add up to.
    this.#lo[n] = 0;
    this.#hi[n] = 0;
    for (let k = n - 1; k >= 0; k--) {
      const m = this.cand[list[k]!]!;
      this.#lo[k] = this.#lo[k + 1]! + lowBit(m) + 1;
      this.#hi[k] = this.#hi[k + 1]! + 31 - Math.clz32(m) + 1;
      this.#found[k] = 0;
    }
    this.#fill(0, rest);
    let any = false;
    for (let k = 0; k < n; k++) if (this.#elim(list[k]!, ALL & ~this.#found[k]!)) any = true;
    return any;
  }

  /** Depth-first fillings of `#list` from position `k` with `rest` left to add; true once every candidate is known to be used. */
  #fill(k: number, rest: number): boolean {
    const list = this.#list;
    const n = list.length;
    if (k === n) {
      let done = true;
      for (let j = 0; j < n; j++) {
        this.#found[j]! |= 1 << (this.#assign[j]! - 1);
        if (this.#found[j] !== this.cand[list[j]!]) done = false;
      }
      return done;
    }
    const c = list[k]!;
    for (let m = this.cand[c]!; m !== 0; m &= m - 1) {
      const d = lowBit(m) + 1;
      const left = rest - d;
      if (left < this.#lo[k + 1]! || left > this.#hi[k + 1]!) continue;
      let clash = false;
      for (let j = 0; j < k; j++) if (this.#assign[j] === d && this.#sees[list[j]! * CELLS + c] === 1) clash = true;
      if (clash) continue;
      this.#assign[k] = d;
      if (this.#fill(k + 1, left)) return true;
    }
    return false;
  }
}

/** Grades a grid (81 values, 0 = empty) under `layout` (standard by default): solves it with {@link Grader} until done or stuck. */
export function grade(cells: ArrayLike<number>, layout: Layout = Layout.STANDARD): Grade {
  const grader = new Grader(cells, layout);
  const techniques = techniquesFor(layout);
  const counts = new Array<number>(techniques.length).fill(0);
  let level = 0;
  let steps = 0;
  while (grader.placed < CELLS) {
    const t = grader.step();
    if (t < 0) return { solved: false, level: STUCK_LEVEL, steps, counts };
    counts[t]!++;
    steps++;
    level = Math.max(level, techniques[t]!.level);
  }
  return { solved: true, level, steps, counts };
}
