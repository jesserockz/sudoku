import { CELLS, boxOf, boxes, colOf, cols, peers, rowOf, rows } from "../core/geometry.ts";

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
 * (`testdata/generator-v2.json`) pins it.
 *
 * Scan orders, used everywhere below:
 * - Units are numbered 0..8 rows, 9..17 columns, 18..26 boxes; the cells of a
 *   unit, and the peers of a cell, ascend by cell index.
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
  /** Steps taken per technique, indexed like {@link TECHNIQUES}. */
  readonly counts: readonly number[];
}

const ALL = 0x1ff;
const UNITS: readonly number[][] = [...rows, ...cols, ...boxes];
/** `MEMBER[u * 81 + c]` is 1 when cell `c` is in unit `u`. */
const MEMBER = new Uint8Array(27 * CELLS);
/** `SEES[a * 81 + b]` is 1 when cells `a` and `b` share a unit (and differ). */
const SEES = new Uint8Array(CELLS * CELLS);
UNITS.forEach((cells, u) => cells.forEach((c) => (MEMBER[u * CELLS + c] = 1)));
peers.forEach((list, a) => list.forEach((b) => (SEES[a * CELLS + b] = 1)));

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
  readonly grid = new Int32Array(CELLS);
  /** Candidate masks; 0 for a filled cell. */
  readonly cand = new Int32Array(CELLS);
  /** How many cells are filled. */
  placed = 0;
  readonly #list: number[] = [];
  readonly #pick: number[] = [];
  readonly #pos = new Int32Array(9);
  readonly #links = new Int32Array(CELLS * 3);
  readonly #linkCount = new Int32Array(CELLS);
  readonly #colour = new Int32Array(CELLS);
  readonly #stamp = new Int32Array(CELLS);
  readonly #queue = new Int32Array(CELLS);
  readonly #visited = new Uint8Array(CELLS);

  constructor(cells: ArrayLike<number>) {
    if (cells.length !== CELLS) throw new RangeError(`expected ${CELLS} cells, got ${cells.length}`);
    const used = new Int32Array(27);
    for (let i = 0; i < CELLS; i++) {
      const d = cells[i]!;
      if (!(Number.isInteger(d) && d >= 0 && d <= 9)) throw new RangeError(`cell value out of range at ${i}: ${d}`);
      if (d === 0) continue;
      this.grid[i] = d;
      this.placed++;
      const bit = 1 << (d - 1);
      used[rowOf(i)]! |= bit;
      used[9 + colOf(i)]! |= bit;
      used[18 + boxOf(i)]! |= bit;
    }
    for (let i = 0; i < CELLS; i++) {
      if (this.grid[i] !== 0) continue;
      this.cand[i] = ALL & ~(used[rowOf(i)]! | used[9 + colOf(i)]! | used[18 + boxOf(i)]!);
    }
  }

  /** Applies the first available step; returns the technique's index, or -1 when none applies. */
  step(): number {
    for (let t = 0; t < TECHNIQUES.length; t++) if (this.#run(t)) return t;
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
      default: return this.#xyChain();
    }
  }

  #place(i: number, bit: number): void {
    this.grid[i] = lowBit(bit) + 1;
    this.cand[i] = 0;
    this.placed++;
    for (const j of peers[i]!) this.cand[j]! &= ~bit;
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
    for (const c of UNITS[from]!) if (MEMBER[except * CELLS + c] === 0 && this.#elim(c, bit)) any = true;
    return any;
  }

  /** Hidden single: units 0..26, digits 1..9; a digit with exactly one place in a unit goes there. */
  #hiddenSingle(): boolean {
    for (let u = 0; u < 27; u++) {
      for (let d = 0; d < 9; d++) {
        const bit = 1 << d;
        let at = -1;
        let n = 0;
        for (const c of UNITS[u]!) {
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
   * Pointing: boxes 0..8, digits 1..9; when a digit's places in a box share a
   * row (tried first) or a column, it goes from the rest of that line.
   */
  #pointing(): boolean {
    for (let b = 0; b < 9; b++) {
      for (let d = 0; d < 9; d++) {
        const bit = 1 << d;
        let rowMask = 0;
        let colMask = 0;
        for (const c of boxes[b]!) {
          if ((this.cand[c]! & bit) !== 0) {
            rowMask |= 1 << rowOf(c);
            colMask |= 1 << colOf(c);
          }
        }
        if (one(rowMask) && this.#elimOutside(lowBit(rowMask), 18 + b, bit)) return true;
        if (one(colMask) && this.#elimOutside(9 + lowBit(colMask), 18 + b, bit)) return true;
      }
    }
    return false;
  }

  /**
   * Claiming (box-line reduction): rows 0..8 then columns 0..8, digits 1..9;
   * when a digit's places in a line share a box, it goes from the rest of
   * that box.
   */
  #claiming(): boolean {
    for (let u = 0; u < 18; u++) {
      for (let d = 0; d < 9; d++) {
        const bit = 1 << d;
        let boxMask = 0;
        for (const c of UNITS[u]!) {
          if ((this.cand[c]! & bit) !== 0) boxMask |= 1 << boxOf(c);
        }
        if (one(boxMask) && this.#elimOutside(18 + lowBit(boxMask), u, bit)) return true;
      }
    }
    return false;
  }

  /**
   * Naked subset of size `k` (pair, triple, quad): units 0..26; among the
   * cells with 2..k candidates, the first combination of `k` cells whose
   * candidates together are exactly `k` digits removes those digits from the
   * unit's other cells.
   */
  #nakedSubset(k: number): boolean {
    for (let u = 0; u < 27; u++) {
      this.#list.length = 0;
      for (const c of UNITS[u]!) {
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
      for (const c of UNITS[u]!) if (!this.#pick.includes(c) && this.#elim(c, union)) any = true;
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
   * Hidden subset of size `k`: units 0..26; among the digits with 2..k places
   * in the unit, the first combination of `k` digits whose places together
   * are exactly `k` cells strips every other candidate from those cells.
   */
  #hiddenSubset(k: number): boolean {
    for (let u = 0; u < 27; u++) {
      this.#pos.fill(0);
      UNITS[u]!.forEach((c, p) => {
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
      for (let p = 0; p < 9; p++) if ((union & (1 << p)) !== 0 && this.#elim(UNITS[u]![p]!, ALL & ~digits)) any = true;
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
          UNITS[o * 9 + b]!.forEach((c, p) => {
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
        for (const c of UNITS[(1 - o) * 9 + p]!) {
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
      for (const w1 of peers[p]!) {
        const c1 = this.cand[w1]!;
        if (popcount(c1) !== 2 || !one(c1 & pivot)) continue;
        const z = c1 & ~pivot;
        const want = (pivot & ~c1) | z;
        for (const w2 of peers[p]!) {
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
    for (let t = 0; t < CELLS; t++) if (SEES[a * CELLS + t] === 1 && SEES[b * CELLS + t] === 1 && this.#elim(t, bit)) any = true;
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
      for (const w1 of peers[p]!) {
        const c1 = this.cand[w1]!;
        if (popcount(c1) !== 2 || (c1 & ~pivot) !== 0) continue;
        for (const w2 of peers[p]!) {
          const c2 = this.cand[w2]!;
          if (w2 <= w1 || popcount(c2) !== 2 || (c2 & ~pivot) !== 0 || c2 === c1) continue;
          const z = c1 & c2;
          let any = false;
          for (let t = 0; t < CELLS; t++) {
            if (SEES[p * CELLS + t] === 1 && SEES[w1 * CELLS + t] === 1 && SEES[w2 * CELLS + t] === 1 && this.#elim(t, z)) any = true;
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
      for (let u = 0; u < 27; u++) {
        let a = -1;
        let b = -1;
        let n = 0;
        for (const c of UNITS[u]!) {
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
    for (let i = 0; i < n; i++) if (this.#links[a * 3 + i] === b) return;
    this.#links[a * 3 + n] = b;
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
        const w = this.#links[v * 3 + i]!;
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
        if (this.#colour[queue[i]!] === colour && this.#colour[queue[j]!] === colour && SEES[queue[i]! * CELLS + queue[j]!] === 1) return true;
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
      for (let i = 0; i < size; i++) if (SEES[t * CELLS + queue[i]!] === 1) seen |= 1 << this.#colour[queue[i]!]!;
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
    for (const next of peers[cur]!) {
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
}

/** Grades a grid (81 values, 0 = empty): solves it with {@link Grader} until done or stuck. */
export function grade(cells: ArrayLike<number>): Grade {
  const grader = new Grader(cells);
  const counts = new Array<number>(TECHNIQUES.length).fill(0);
  let level = 0;
  let steps = 0;
  while (grader.placed < CELLS) {
    const t = grader.step();
    if (t < 0) return { solved: false, level: STUCK_LEVEL, steps, counts };
    counts[t]!++;
    steps++;
    level = Math.max(level, TECHNIQUES[t]!.level);
  }
  return { solved: true, level, steps, counts };
}
