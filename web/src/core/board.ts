import { CELLS, peers } from "./geometry.ts";

export const EMPTY = 0;

/**
 * An immutable 9x9 Sudoku board: the puzzle's givens plus the player's entries.
 *
 * Values are `1..9`, with `0` meaning empty. Given cells can't be changed.
 * Every mutation returns a new Board, which keeps it safe to hold as UI state.
 */
export class Board {
  readonly #cells: Uint8Array;
  readonly #given: readonly boolean[];

  private constructor(cells: Uint8Array, given: readonly boolean[]) {
    this.#cells = cells;
    this.#given = given;
  }

  /** A puzzle from 81 characters: `1`-`9` are givens, `0` or `.` are empty. Whitespace is ignored. */
  static parse(puzzle: string): Board {
    const values = parseCells(puzzle);
    return new Board(values, Array.from(values, (v) => v !== EMPTY));
  }

  /** A puzzle from cell values (`0` = empty); every non-zero value is a given. */
  static fromGivens(values: ArrayLike<number>): Board {
    if (values.length !== CELLS) throw new RangeError(`expected ${CELLS} cells, got ${values.length}`);
    const cells = Uint8Array.from(values, (v) => {
      if (!Number.isInteger(v) || v < 0 || v > 9) throw new RangeError("cell values must be 0..9");
      return v;
    });
    return new Board(cells, Array.from(cells, (v) => v !== EMPTY));
  }

  /**
   * Restores a board in progress from its `puzzle` (givens) and the player's
   * `entries` (same format; values in given cells must match or be empty).
   */
  static restore(puzzle: string, entries: string): Board {
    const board = Board.parse(puzzle);
    const values = parseCells(entries);
    const cells = board.#cells.slice();
    for (let i = 0; i < CELLS; i++) {
      if (board.#given[i]) {
        if (values[i] !== EMPTY && values[i] !== cells[i]) throw new RangeError(`entry at ${i} overwrites a given`);
      } else {
        cells[i] = values[i]!;
      }
    }
    return new Board(cells, board.#given);
  }

  get(i: number): number {
    return this.#cells[checkIndex(i)]!;
  }

  isGiven(i: number): boolean {
    return this.#given[checkIndex(i)]!;
  }

  isEmpty(i: number): boolean {
    return this.get(i) === EMPTY;
  }

  /** A board with `digit` (`1..9`, or `0` to clear) placed at `i`. */
  with(i: number, digit: number): Board {
    checkIndex(i);
    if (!Number.isInteger(digit) || digit < EMPTY || digit > 9) throw new RangeError(`digit out of range: ${digit}`);
    if (this.#given[i]) throw new Error(`cell ${i} is a given`);
    if (this.#cells[i] === digit) return this;
    const next = this.#cells.slice();
    next[i] = digit;
    return new Board(next, this.#given);
  }

  cleared(i: number): Board {
    return this.with(i, EMPTY);
  }

  /** Whether `digit` could go at `i` without repeating a digit in its row, column or box. */
  canPlace(i: number, digit: number): boolean {
    checkIndex(i);
    if (!Number.isInteger(digit) || digit < 1 || digit > 9) throw new RangeError(`digit out of range: ${digit}`);
    return !peers[i]!.some((p) => this.#cells[p] === digit);
  }

  /** Whether the cell holds a digit that also appears in one of its peers. */
  hasConflict(i: number): boolean {
    const d = this.get(i);
    return d !== EMPTY && peers[i]!.some((p) => this.#cells[p] === d);
  }

  /** Indices of every filled cell whose digit repeats in a row, column or box, ascending. */
  conflicts(): number[] {
    const out: number[] = [];
    for (let i = 0; i < CELLS; i++) if (this.hasConflict(i)) out.push(i);
    return out;
  }

  get filledCount(): number {
    return this.#cells.reduce((n, v) => n + (v !== EMPTY ? 1 : 0), 0);
  }

  get givenCount(): number {
    return this.#given.filter(Boolean).length;
  }

  get isFull(): boolean {
    return !this.#cells.includes(EMPTY);
  }

  /** Every cell filled with no repeated digit in any row, column or box. */
  get isSolved(): boolean {
    return this.isFull && this.conflicts().length === 0;
  }

  /** The values as a copy (index order, `0` = empty). */
  toArray(): number[] {
    return Array.from(this.#cells);
  }

  /** A board holding only the givens. */
  givensOnly(): Board {
    return new Board(this.#cells.map((v, i) => (this.#given[i] ? v : EMPTY)), this.#given);
  }

  /** 81 characters, `1`-`9` for digits and `0` for empty cells. */
  toCompactString(): string {
    return this.#cells.join("");
  }

  /** Givens only, in the same format as {@link toCompactString}. */
  givensString(): string {
    return this.givensOnly().toCompactString();
  }

  equals(other: Board): boolean {
    return this.toCompactString() === other.toCompactString() && this.givensString() === other.givensString();
  }
}

function parseCells(s: string): Uint8Array {
  const chars = s.replace(/\s/g, "");
  if (chars.length !== CELLS) throw new RangeError(`expected ${CELLS} cells, got ${chars.length}`);
  return Uint8Array.from(chars, (c, i) => {
    if (c === "." || c === "0") return EMPTY;
    if (c >= "1" && c <= "9") return c.charCodeAt(0) - 48;
    throw new RangeError(`invalid cell '${c}' at ${i}`);
  });
}

function checkIndex(i: number): number {
  if (!Number.isInteger(i) || i < 0 || i >= CELLS) throw new RangeError(`cell index out of range: ${i}`);
  return i;
}
