// The Learn area's own view of a puzzle in progress: the digits placed so far
// and the candidates still open in each empty cell. Kept apart from the
// grader (generator/grader.ts), which is pinned to the server's and can't
// change: the finders here explain their steps, the grader only counts them.
import { CELLS, boxOf, boxes, colOf, cols, peers, rowOf, rows } from "../core/geometry.ts";
import { Layout, VARIANT_DIAGONAL, VARIANT_JIGSAW, VARIANT_KILLER } from "../core/layout.ts";

/** A digit in a cell: a candidate to remove, or a digit to place. */
export interface CellDigit {
  cell: number;
  digit: number;
}

/**
 * A position. `grid` has 81 digits, `0` for empty. `cand` has a 9-bit mask
 * per cell (bit `d - 1` for digit `d`), always `0` for a filled cell.
 * `layout` is a variant's rules (its extra units and cages); without it the
 * position is standard Sudoku.
 */
export interface State {
  readonly grid: readonly number[];
  readonly cand: readonly number[];
  readonly layout?: Layout;
}

/** The rules a position is played under. */
export const layoutOf = (state: State): Layout => state.layout ?? Layout.STANDARD;

/** How a cell takes part in a step, for highlighting. */
export type Role = "pattern" | "pivot" | "wing" | "see" | "colourA" | "colourB";

/** A highlighted cell. `digits` are the candidates of it that matter, if only some do. */
export interface Mark {
  cell: number;
  role: Role;
  digits?: number[];
}

/** One logical step: either a digit to place or candidates to remove, with the pattern that proves it. */
export interface Step {
  technique: string;
  /** The digit this step places, or `null` for a step that only removes candidates. */
  place: CellDigit | null;
  /** The candidates this step removes, by cell then digit. Empty when it places a digit. */
  eliminations: CellDigit[];
  /** The cells that make up the pattern. */
  marks: Mark[];
  /** The units to highlight (see {@link UNITS}). */
  units: number[];
  /** The argument in one to three sentences, in order; the last states the conclusion. */
  reason: string[];
  /** A first hint that points at where to look without giving the cells away. */
  nudge: string;
}

/** Finds every instance of one technique in a position, in a fixed order. */
export type Finder = (state: State) => Step[];

/** Every unit's cells: ids 0-8 are rows, 9-17 columns, 18-26 boxes. */
export const UNITS: readonly (readonly number[])[] = [...rows, ...cols, ...boxes];
export const rowUnit = (row: number): number => row;
export const colUnit = (col: number): number => 9 + col;
export const boxUnit = (box: number): number => 18 + box;
/** The units a cell belongs to: row, column, box (or region), then any diagonal of `layout`. */
export const unitsOf = (cell: number, layout: Layout = Layout.STANDARD): number[] =>
  layout.units.flatMap((cells, u) => (cells.includes(cell) ? [u] : []));

export const ALL = 0x1ff;
export const bit = (digit: number): number => 1 << (digit - 1);

/** The digits of a mask, ascending. */
export function digitsOf(mask: number): number[] {
  const out: number[] = [];
  for (let d = 1; d <= 9; d++) if (mask & bit(d)) out.push(d);
  return out;
}

/** How many digits a mask holds. */
export function count(mask: number): number {
  let n = 0;
  for (; mask; mask &= mask - 1) n++;
  return n;
}

/** Reads 81 characters, digits for filled cells and `0` or `.` for empty ones. */
export function parseGrid(text: string): number[] {
  if (!/^[0-9.]{81}$/.test(text)) throw new RangeError("a grid is 81 digits or dots");
  return Array.from(text, (ch) => (ch === "." ? 0 : Number(ch)));
}

/** The candidates the rules alone leave: every digit not already in a square the cell sees (its row, column, box, and any diagonal or cage of `layout`). */
export function basicCandidates(grid: readonly number[], layout: Layout = Layout.STANDARD): number[] {
  if (grid.length !== CELLS) throw new RangeError(`expected ${CELLS} cells, got ${grid.length}`);
  return grid.map((digit, i) => {
    if (digit !== 0) return 0;
    let mask = ALL;
    for (const p of layout.peers[i]!) if (grid[p] !== 0) mask &= ~bit(grid[p]!);
    return mask;
  });
}

/** `{ layout }` for a variant's layout, nothing for standard Sudoku, so standard positions keep their plain shape. */
const withLayout = (layout: Layout | undefined): { layout?: Layout } => (layout && layout !== Layout.STANDARD ? { layout } : {});

/** A position from its digits under `layout` (standard by default), with the rules' candidates unless `cand` is given. */
export function stateOf(grid: readonly number[], cand?: readonly number[], layout?: Layout): State {
  return { grid: [...grid], cand: cand ? [...cand] : basicCandidates(grid, layout), ...withLayout(layout) };
}

export const has = (state: State, cell: number, digit: number): boolean => (state.cand[cell]! & bit(digit)) !== 0;

/** The cells of `cells` that still have `digit` as a candidate. */
export const cellsWith = (state: State, cells: readonly number[], digit: number): number[] => cells.filter((c) => has(state, c, digit));

/** Whether two different cells share a row, column or box. */
export const sees = (a: number, b: number): boolean =>
  a !== b && (rowOf(a) === rowOf(b) || colOf(a) === colOf(b) || boxOf(a) === boxOf(b));

/** The cells that see every one of `cells`, ascending. */
export function commonPeers(cells: readonly number[]): number[] {
  return peers[cells[0]!]!.filter((p) => cells.every((c) => sees(p, c)));
}

export const isSolved = (state: State): boolean => state.grid.every((d) => d !== 0);

/** The position after a step: its digit placed (and removed from the cells that see it), or its candidates removed. */
export function apply(state: State, step: Pick<Step, "place" | "eliminations">): State {
  const grid = [...state.grid];
  const cand = [...state.cand];
  if (step.place) {
    const { cell, digit } = step.place;
    grid[cell] = digit;
    cand[cell] = 0;
    for (const p of layoutOf(state).peers[cell]!) cand[p]! &= ~bit(digit);
  }
  for (const { cell, digit } of step.eliminations) cand[cell]! &= ~bit(digit);
  return { grid, cand, ...withLayout(state.layout) };
}

/** The candidates of `digit` in `cells` that are still there, as eliminations. */
export function eliminationsOf(state: State, cells: readonly number[], digits: readonly number[]): CellDigit[] {
  const out: CellDigit[] = [];
  for (const cell of [...cells].sort((a, b) => a - b)) {
    for (const digit of digits) if (has(state, cell, digit)) out.push({ cell, digit });
  }
  return out;
}

// Names, as the lessons write them.

/** "R3C5": row 3, column 5. */
export const cellName = (cell: number): string => `R${rowOf(cell) + 1}C${colOf(cell) + 1}`;

/** The long diagonals' names (units 27 and 28), as the Diagonal lessons introduce them. */
export const DIAGONAL_NAMES: readonly string[] = ["the diagonal from the top left", "the diagonal from the top right"];

/** "row 3", "column 5", "box 4" ("region 4" on a jigsaw), or a diagonal's name. */
export function unitName(unit: number, layout: Layout = Layout.STANDARD): string {
  if (unit >= 27) return DIAGONAL_NAMES[unit - 27]!;
  const kind = unit < 9 ? "row" : unit < 18 ? "column" : layout.variant === VARIANT_JIGSAW ? "region" : "box";
  return `${kind} ${(unit % 9) + 1}`;
}

/** The kinds of unit a layout has, for the lessons' sentences: "row, column or box", "row, column or region", ... */
export function unitWords(layout: Layout): string {
  if (layout.variant === VARIANT_JIGSAW) return "row, column or region";
  if (layout.variant === VARIANT_DIAGONAL) return "row, column, box or diagonal";
  return "row, column or box";
}

/** What a square sees under a layout: its units, and on a killer its cage. */
export function peerWords(layout: Layout): string {
  return layout.variant === VARIANT_KILLER ? "row, column, box or cage" : unitWords(layout);
}

/** "a", "a and b" or "a, b and c" (or with `join` in place of "and"). */
export function listOf(items: readonly (string | number)[], join = "and"): string {
  if (items.length <= 1) return String(items[0] ?? "");
  return `${items.slice(0, -1).join(", ")} ${join} ${items.at(-1)}`;
}

/** "R3C5, R3C6 and R4C1". */
export const cellNames = (cells: readonly number[]): string => listOf(cells.map(cellName));
