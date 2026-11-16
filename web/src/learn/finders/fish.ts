// Basic fish: a digit confined to N lines that all fall in the same N crossing lines.
import { colOf, rowOf } from "../../core/geometry.ts";
import { type Finder, type Step, UNITS, cellNames, cellsWith, colUnit, eliminationsOf, listOf, rowUnit } from "../state.ts";

/** Every way to choose `k` items of `items`, in order of position. */
function combinations(items: readonly number[], k: number, start = 0, chosen: number[] = []): number[][] {
  if (chosen.length === k) return [chosen];
  const out: number[][] = [];
  for (let i = start; i < items.length; i++) out.push(...combinations(items, k, i + 1, [...chosen, items[i]!]));
  return out;
}

const LINES: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const SIZE_NAMES: readonly string[] = ["", "", "X-Wing", "Swordfish", "Jellyfish"];
const COUNT_WORDS: readonly string[] = ["", "", "two", "three", "four"];

/** "rows 2, 5 and 7" or "columns 3 and 8". */
const linesOf = (rows: boolean, lines: readonly number[]): string => `${rows ? "rows" : "columns"} ${listOf(lines.map((l) => l + 1))}`;

/**
 * Fish of `size` lines. Rows (then columns) are the base lines: those where
 * the digit has 2 to `size` places. When `size` of them have their places in
 * just `size` crossing (cover) lines, the digit must be in those cover lines
 * once per base line, so the cover lines lose it everywhere else.
 */
function fish(technique: string, size: number): Finder {
  return (state): Step[] => {
    const steps: Step[] = [];
    const name = SIZE_NAMES[size]!;
    for (let digit = 1; digit <= 9; digit++) {
      for (const rows of [true, false]) {
        const along = (line: number): number[] => cellsWith(state, UNITS[rows ? rowUnit(line) : colUnit(line)]!, digit);
        const across = (cell: number): number => (rows ? colOf(cell) : rowOf(cell));
        const bases = LINES.filter((line) => along(line).length >= 2 && along(line).length <= size);
        for (const lines of combinations(bases, size)) {
          const cells = lines.flatMap(along);
          const covers = [...new Set(cells.map(across))].sort((a, b) => a - b);
          if (covers.length !== size) continue;
          const others = covers.flatMap((cover) => UNITS[rows ? colUnit(cover) : rowUnit(cover)]!).filter((c) => !lines.includes(rows ? rowOf(c) : colOf(c)));
          const eliminations = eliminationsOf(state, others, [digit]);
          if (eliminations.length === 0) continue;
          const baseUnits = lines.map(rows ? rowUnit : colUnit);
          const coverUnits = covers.map(rows ? colUnit : rowUnit);
          steps.push({
            technique,
            place: null,
            eliminations,
            marks: cells.map((cell) => ({ cell, role: "pattern", digits: [digit] })),
            units: [...baseUnits, ...coverUnits],
            reason: [
              `Look at the ${digit}s in ${linesOf(rows, lines)}: each has at most ${COUNT_WORDS[size]!} places, and they all sit in ${linesOf(!rows, covers)} (${cellNames(cells)}).`,
              `That pattern is called ${name}: ${COUNT_WORDS[size]!} lines need ${COUNT_WORDS[size]!} ${digit}s, and the only room is in ${linesOf(!rows, covers)}, so those ${digit}s use up ${linesOf(!rows, covers)} completely.`,
              `So ${digit} can be removed from the rest of ${linesOf(!rows, covers)}: ${cellNames([...new Set(eliminations.map((e) => e.cell))])}.`,
            ],
            nudge: `Look for a ${digit} that is confined to ${COUNT_WORDS[size]!} ${rows ? "rows" : "columns"} sharing the same ${COUNT_WORDS[size]!} ${rows ? "columns" : "rows"}.`,
          });
        }
      }
    }
    return steps;
  };
}

/** A digit with two places in each of two rows (or columns), in the same two columns (or rows). */
export const xWing: Finder = fish("xWing", 2);
/** The same with three lines. */
export const swordfish: Finder = fish("swordfish", 3);
/** The same with four lines. */
export const jellyfish: Finder = fish("jellyfish", 4);
