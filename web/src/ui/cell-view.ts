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
