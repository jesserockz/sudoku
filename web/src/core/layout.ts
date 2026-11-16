import { CELLS, SIZE, boxOf } from "./geometry.ts";

/**
 * The rules of a Sudoku variant as data: which groups of cells ("units", each
 * holding 1 to 9 once) a grid has, and the killer cages.
 *
 * Units are numbered 0..8 rows, 9..17 columns, 18..26 regions (the 3x3 boxes,
 * or a jigsaw's irregular regions), then, for Diagonal, 27 the main diagonal
 * (top-left to bottom-right) and 28 the anti-diagonal (top-right to
 * bottom-left). The cells of a unit, and the peers of a cell, ascend by cell
 * index. The solver and grader (`src/generator/`) and the Go port
 * (`server/internal/puzzle/layout.go`) rely on these orders.
 */

/** The variants: 0 is standard Sudoku (the original endless series). */
export const VARIANT_STANDARD = 0;
/** Diagonal (X): the two long diagonals also hold 1 to 9. */
export const VARIANT_DIAGONAL = 1;
/** Jigsaw: nine irregular regions replace the boxes. */
export const VARIANT_JIGSAW = 2;
/** Killer: cages with sums, distinct digits within a cage. */
export const VARIANT_KILLER = 3;
/** Every variant, in order. */
export const VARIANTS: readonly number[] = [VARIANT_STANDARD, VARIANT_DIAGONAL, VARIANT_JIGSAW, VARIANT_KILLER];

export function isVariant(variant: number): boolean {
  return VARIANTS.includes(variant);
}

/** What players call a variant. */
export function variantName(variant: number): string {
  switch (variant) {
    case VARIANT_STANDARD: return "Standard";
    case VARIANT_DIAGONAL: return "Diagonal";
    case VARIANT_JIGSAW: return "Jigsaw";
    case VARIANT_KILLER: return "Killer";
    default: return `Variant ${variant}`;
  }
}

/** A killer cage: its cells (ascending) and the sum of their digits. */
export interface Cage {
  readonly cells: readonly number[];
  readonly sum: number;
}

/** The main diagonal (unit 27) and the anti-diagonal (unit 28), ascending. */
export const DIAGONALS: readonly (readonly number[])[] = [
  Array.from({ length: SIZE }, (_, i) => i * (SIZE + 1)),
  Array.from({ length: SIZE }, (_, i) => (i + 1) * (SIZE - 1)),
];

/** The 3x3 boxes as a region index per cell. */
export const BOX_REGIONS: readonly number[] = Array.from({ length: CELLS }, (_, i) => boxOf(i));

export class Layout {
  readonly variant: number;
  /** The region (0..8) of each cell: its box, or its jigsaw region. */
  readonly regions: readonly number[];
  /** Whether the two long diagonals are units (Diagonal). */
  readonly diagonals: boolean;
  /** The killer cages, ordered by their lowest cell; empty for the other variants. */
  readonly cages: readonly Cage[];
  /** Every unit's cells, numbered as described above. */
  readonly units: readonly (readonly number[])[];
  /** The other cells that cannot hold the same digit as each cell: sharing a unit or a cage. Ascending. */
  readonly peers: readonly (readonly number[])[];
  /** The index in {@link cages} of each cell's cage, or -1 without cages. */
  readonly cageOf: readonly number[];

  private constructor(variant: number, regions: readonly number[], diagonals: boolean, cages: readonly Cage[]) {
    this.variant = variant;
    this.regions = regions;
    this.diagonals = diagonals;
    this.cages = cages;
    const units: number[][] = [];
    for (let r = 0; r < SIZE; r++) units.push(Array.from({ length: SIZE }, (_, c) => r * SIZE + c));
    for (let c = 0; c < SIZE; c++) units.push(Array.from({ length: SIZE }, (_, r) => r * SIZE + c));
    for (let g = 0; g < SIZE; g++) units.push([]);
    for (let i = 0; i < CELLS; i++) units[2 * SIZE + regions[i]!]!.push(i);
    if (diagonals) units.push(...DIAGONALS.map((d) => d.slice()));
    this.units = units;
    const cageOf = new Array<number>(CELLS).fill(-1);
    cages.forEach((cage, k) => cage.cells.forEach((c) => (cageOf[c] = k)));
    this.cageOf = cageOf;
    const sees = Array.from({ length: CELLS }, () => new Uint8Array(CELLS));
    const link = (group: readonly number[]): void => {
      for (const a of group) for (const b of group) if (a !== b) sees[a]![b] = 1;
    };
    units.forEach(link);
    cages.forEach((cage) => link(cage.cells));
    this.peers = sees.map((row) => {
      const list: number[] = [];
      row.forEach((s, j) => s === 1 && list.push(j));
      return list;
    });
  }

  /** Standard Sudoku: rows, columns and boxes. */
  static readonly STANDARD: Layout = new Layout(VARIANT_STANDARD, BOX_REGIONS, false, []);
  /** Diagonal: standard plus the two long diagonals. */
  static readonly DIAGONAL: Layout = new Layout(VARIANT_DIAGONAL, BOX_REGIONS, true, []);

  /** Jigsaw: rows, columns and the regions given as a region index (0..8) per cell, nine cells each. */
  static jigsaw(regions: readonly number[]): Layout {
    if (regions.length !== CELLS) throw new RangeError(`expected ${CELLS} regions, got ${regions.length}`);
    const size = new Array<number>(SIZE).fill(0);
    for (const g of regions) {
      if (!(Number.isInteger(g) && g >= 0 && g < SIZE)) throw new RangeError(`region out of range: ${g}`);
      size[g]!++;
    }
    if (size.some((n) => n !== SIZE)) throw new RangeError(`every region must have ${SIZE} cells`);
    return new Layout(VARIANT_JIGSAW, regions.slice(), false, []);
  }

  /** Killer: standard units plus cages, which must cover every cell exactly once. Cages are reordered by lowest cell. */
  static killer(cages: readonly Cage[]): Layout {
    const seen = new Uint8Array(CELLS);
    const sorted = cages.map((cage) => {
      if (cage.cells.length === 0) throw new RangeError("a cage needs at least one cell");
      const cells = cage.cells.slice().sort((a, b) => a - b);
      for (const c of cells) {
        if (!(Number.isInteger(c) && c >= 0 && c < CELLS) || seen[c] === 1) throw new RangeError(`bad or repeated cage cell: ${c}`);
        seen[c] = 1;
      }
      return { cells, sum: cage.sum };
    });
    if (seen.includes(0)) throw new RangeError("cages must cover every cell");
    sorted.sort((a, b) => a.cells[0]! - b.cells[0]!);
    return new Layout(VARIANT_KILLER, BOX_REGIONS, false, sorted);
  }

  /** Whether every unit and cage of `cells` (81 values, 0 = empty) is free of repeats and no complete cage misses its sum. */
  isValid(cells: ArrayLike<number>): boolean {
    for (const unit of [...this.units, ...this.cages.map((c) => c.cells)]) {
      let seen = 0;
      for (const c of unit) {
        const d = cells[c]!;
        if (d === 0) continue;
        if ((seen & (1 << d)) !== 0) return false;
        seen |= 1 << d;
      }
    }
    return this.cages.every((cage) => cage.cells.some((c) => cells[c] === 0) || cage.cells.reduce((s, c) => s + cells[c]!, 0) === cage.sum);
  }
}
