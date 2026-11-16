// How the practice positions in positions.ts and variant-positions.ts are written down.
import { type Cage, Layout } from "../core/layout.ts";
import { type State, parseGrid, stateOf } from "./state.ts";

/** A variant's rules, written down with a position or puzzle. None of them for standard Sudoku. */
export interface LayoutData {
  /** Diagonal: the two long diagonals are units too. */
  diagonal?: true;
  /** Jigsaw: the region (0 to 8) of each square, 81 digits. */
  regions?: string;
  /** Killer: the cages, see {@link encodeCages}. */
  cages?: string;
}

/** A position to practise on. */
export interface PositionData extends LayoutData {
  /** 81 digits, `0` for an empty square. */
  grid: string;
  solution: string;
  /** The candidates left, when earlier steps have already removed some: see {@link decodeCand}. */
  cand?: string;
}

/** A whole puzzle to solve. */
export interface PuzzleData extends LayoutData {
  givens: string;
  solution: string;
}

/** Candidate masks from two base-32 characters a cell. */
export function decodeCand(text: string): number[] {
  if (!/^[0-9a-v]{162}$/.test(text)) throw new RangeError("candidates are 162 base-32 characters");
  return Array.from({ length: 81 }, (_, i) => parseInt(text.slice(i * 2, i * 2 + 2), 32));
}

/** Killer cages as text: each cage's sum, a colon and its cells joined by dots, cages separated by spaces ("12:0.1.9 7:2.3"). */
export const encodeCages = (cages: readonly Cage[]): string => cages.map((c) => `${c.sum}:${c.cells.join(".")}`).join(" ");

/** The cages {@link encodeCages} wrote. */
export function decodeCages(text: string): Cage[] {
  if (!/^\d+:\d+(\.\d+)*( \d+:\d+(\.\d+)*)*$/.test(text)) throw new RangeError(`not a list of cages: ${text}`);
  return text.split(" ").map((cage) => {
    const [sum, cells] = cage.split(":");
    return { sum: Number(sum), cells: cells!.split(".").map(Number) };
  });
}

const LAYOUTS = new Map<string, Layout>();

/** The layout a position or puzzle is played under, built once per distinct layout. */
export function dataLayout(data: LayoutData): Layout {
  if (data.diagonal) return Layout.DIAGONAL;
  const key = data.regions !== undefined ? `r${data.regions}` : data.cages !== undefined ? `c${data.cages}` : "";
  if (key === "") return Layout.STANDARD;
  let layout = LAYOUTS.get(key);
  if (!layout) {
    layout = data.regions !== undefined ? Layout.jigsaw(parseGrid(data.regions)) : Layout.killer(decodeCages(data.cages!));
    LAYOUTS.set(key, layout);
  }
  return layout;
}

export const positionState = (p: PositionData): State => stateOf(parseGrid(p.grid), p.cand ? decodeCand(p.cand) : undefined, dataLayout(p));
