import { CELLS, SIZE, colOf, rowOf } from "../core/geometry.ts";
import { type Layout, VARIANT_JIGSAW, VARIANT_STANDARD, variantName } from "../core/layout.ts";
import type { Game } from "../game/game.ts";

/**
 * What a board cell shows. Notes are the nine slots of the 3x3 note grid,
 * digit 1's top left to digit 9's bottom right, with `""` for no mark.
 */
export type CellView =
  | { kind: "given" | "entry" | "empty"; text: string }
  | { kind: "notes"; marks: string[] };

/**
 * What to draw in cell `i`. With `hideDigits` (the admin replay viewer), an
 * entered digit becomes `•` and notes become one `•` per mark in the first
 * slots, since a mark's own slot would give its digit away.
 */
export function cellView(game: Game, i: number, hideDigits: boolean): CellView {
  const digit = game.board.get(i);
  if (game.board.isGiven(i)) return { kind: "given", text: String(digit) };
  if (digit !== 0) return { kind: "entry", text: hideDigits ? "•" : String(digit) };
  const count = game.notes.get(i).length;
  if (count === 0) return { kind: "empty", text: "" };
  const marks = Array.from({ length: 9 }, (_, k) =>
    hideDigits ? (k < count ? "•" : "") : game.notes.has(i, k + 1) ? String(k + 1) : "");
  return { kind: "notes", marks };
}

/** How a screen reader names a cell's content: the digit, "hidden digit" or "empty" (notes aren't read). */
export function cellLabel(view: CellView): string {
  if (view.kind === "notes" || view.kind === "empty") return "empty";
  return view.text === "•" ? "hidden digit" : view.text;
}

/** The board's class for a variant's drawing (`layout-diagonal`, `layout-jigsaw`, `layout-killer`), or `null` for standard Sudoku. */
export function layoutClass(layout: Layout): string | null {
  return layout.variant === VARIANT_STANDARD ? null : `layout-${variantName(layout.variant).toLowerCase()}`;
}

/** How a variant's layout dresses cell `i`. */
export interface CellDecor {
  /**
   * `diag`: on a long diagonal (Diagonal). `jr` / `jb`: a jigsaw region border on the right / bottom. `cage`: in a
   * killer cage, with `ct`, `cr`, `cb` and `cl` on the sides where the cage ends (top, right, bottom, left), and
   * `has-sum` on the cage's first cell, which shows the sum.
   */
  classes: string[];
  /** The cage's sum, drawn in its first (top-left) cell; `null` elsewhere. */
  sum: number | null;
  /** How a screen reader names the cage, on its first cell (e.g. "cage of 3 adding to 12"); `null` elsewhere. */
  label: string | null;
}

/** The classes, cage sum and label for cell `i` under `layout` (nothing for standard Sudoku). */
export function cellDecor(layout: Layout, i: number): CellDecor {
  const r = rowOf(i);
  const c = colOf(i);
  const classes: string[] = [];
  if (layout.diagonals && (r === c || r + c === SIZE - 1)) classes.push("diag");
  if (layout.variant === VARIANT_JIGSAW) {
    if (c < SIZE - 1 && layout.regions[i] !== layout.regions[i + 1]) classes.push("jr");
    if (r < SIZE - 1 && layout.regions[i] !== layout.regions[i + SIZE]) classes.push("jb");
  }
  const k = layout.cageOf[i]!;
  if (k < 0) return { classes, sum: null, label: null };
  const outside = (j: number) => j < 0 || j >= CELLS || layout.cageOf[j] !== k;
  classes.push("cage");
  if (outside(i - SIZE)) classes.push("ct");
  if (c === SIZE - 1 || outside(i + 1)) classes.push("cr");
  if (outside(i + SIZE)) classes.push("cb");
  if (c === 0 || outside(i - 1)) classes.push("cl");
  const cage = layout.cages[k]!;
  if (cage.cells[0] !== i) return { classes, sum: null, label: null };
  classes.push("has-sum");
  return { classes, sum: cage.sum, label: `cage of ${cage.cells.length} adding to ${cage.sum}` };
}
