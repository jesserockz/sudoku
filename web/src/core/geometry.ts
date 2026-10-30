/**
 * Fixed geometry of a classic 9x9 Sudoku grid.
 *
 * Cells are addressed by a flat index `0..80` in row-major order:
 * `index = row * 9 + col`. Boxes are numbered `0..8` left-to-right,
 * top-to-bottom.
 */
export const SIZE = 9;
export const BOX = 3;
export const CELLS = SIZE * SIZE;

export function index(row: number, col: number): number {
  if (!(row >= 0 && row < SIZE && col >= 0 && col < SIZE)) throw new RangeError(`row/col out of range: (${row}, ${col})`);
  return row * SIZE + col;
}

export const rowOf = (i: number): number => Math.floor(i / SIZE);
export const colOf = (i: number): number => i % SIZE;
export const boxOf = (i: number): number => Math.floor(rowOf(i) / BOX) * BOX + Math.floor(colOf(i) / BOX);

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/** Cell indices of each row, column and box, in ascending order. */
export const rows: readonly number[][] = range(SIZE).map((r) => range(SIZE).map((c) => r * SIZE + c));
export const cols: readonly number[][] = range(SIZE).map((c) => range(SIZE).map((r) => r * SIZE + c));
export const boxes: readonly number[][] = range(SIZE).map((b) => {
  const r0 = Math.floor(b / BOX) * BOX;
  const c0 = (b % BOX) * BOX;
  return range(SIZE).map((k) => (r0 + Math.floor(k / BOX)) * SIZE + c0 + (k % BOX));
});

/** The 20 cells sharing a row, column or box with each cell, ascending. */
export const peers: readonly number[][] = range(CELLS).map((i) =>
  range(CELLS).filter((j) => j !== i && (rowOf(j) === rowOf(i) || colOf(j) === colOf(i) || boxOf(j) === boxOf(i))),
);
