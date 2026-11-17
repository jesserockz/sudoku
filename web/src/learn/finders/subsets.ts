// Naked and hidden subsets: N cells and N digits that lock onto each other inside one unit.
import {
  ALL, type CellDigit, type Finder, type State, type Step, UNITS, bit, cellName, cellNames, count, digitsOf, eliminationsOf, listOf,
  unitName,
} from "../state.ts";

/** Every way to choose `k` items of `items`, in order of position. */
function combinations<T>(items: readonly T[], k: number, start = 0, chosen: T[] = []): T[][] {
  if (chosen.length === k) return [chosen];
  const out: T[][] = [];
  for (let i = start; i < items.length; i++) out.push(...combinations(items, k, i + 1, [...chosen, items[i]!]));
  return out;
}

const SIZE_NAMES: readonly string[] = ["", "", "pair", "triple", "quad"];

/** "R1C2 (3 and 4), R1C5 (3)": what is removed, cell by cell. */
function removedBy(eliminations: readonly CellDigit[]): string {
  const cells = [...new Set(eliminations.map((e) => e.cell))];
  return listOf(cells.map((cell) => `${cellName(cell)} (${listOf(eliminations.filter((e) => e.cell === cell).map((e) => e.digit))})`));
}

/**
 * Collects the steps of a technique, keeping the first of any steps with the
 * same cells, digits and eliminations (a subset inside a row and a box is one
 * pattern) and tinting both units on it.
 */
class Collector {
  readonly steps: Step[] = [];
  readonly #seen = new Map<string, Step>();

  add(key: string, unit: number, step: Step): void {
    const known = this.#seen.get(key + JSON.stringify(step.eliminations));
    if (known) {
      known.units.push(unit);
      return;
    }
    this.#seen.set(key + JSON.stringify(step.eliminations), step);
    this.steps.push(step);
  }
}

/**
 * Naked subset: `size` cells of a unit, each with 2 to `size` candidates,
 * that between them have only `size` different digits. Those digits fill
 * those cells, so the unit's other cells lose them.
 */
function naked(technique: string, size: number): Finder {
  const name = SIZE_NAMES[size]!;
  return (state: State): Step[] => {
    const found = new Collector();
    for (let unit = 0; unit < 27; unit++) {
      const small = UNITS[unit]!.filter((c) => count(state.cand[c]!) >= 2 && count(state.cand[c]!) <= size);
      for (const cells of combinations(small, size)) {
        const union = cells.reduce((m, c) => m | state.cand[c]!, 0);
        if (count(union) !== size) continue;
        const digits = digitsOf(union);
        const eliminations = eliminationsOf(state, UNITS[unit]!.filter((c) => !cells.includes(c)), digits);
        if (eliminations.length === 0) continue;
        found.add(`${cells}|${digits}`, unit, {
          technique,
          place: null,
          eliminations,
          marks: cells.map((cell) => ({ cell, role: "pattern", digits: digitsOf(state.cand[cell]!) })),
          units: [unit],
          reason: [
            `Look at ${cellNames(cells)} in ${unitName(unit)}: between them they can only be ${listOf(digits)}.`,
            `That is a naked ${name}: ${size} squares that share just ${size} digits must use up all of them, so no other square of ${unitName(unit)} can be any of them.`,
            `So these can be removed: ${removedBy(eliminations)}.`,
          ],
          nudge: `Look at ${unitName(unit)} for ${size} squares that share only ${size} digits between them.`,
        });
      }
    }
    return found.steps;
  };
}

/**
 * Hidden subset: `size` digits of a unit, each with 2 to `size` places, whose
 * places together are only `size` cells. Those cells must hold those digits,
 * so they lose every other candidate.
 */
function hidden(technique: string, size: number): Finder {
  const name = SIZE_NAMES[size]!;
  return (state: State): Step[] => {
    const found = new Collector();
    for (let unit = 0; unit < 27; unit++) {
      const places = new Map<number, number[]>();
      for (let digit = 1; digit <= 9; digit++) {
        const at = UNITS[unit]!.filter((c) => (state.cand[c]! & bit(digit)) !== 0);
        if (at.length >= 2 && at.length <= size) places.set(digit, at);
      }
      for (const digits of combinations([...places.keys()], size)) {
        const cells = [...new Set(digits.flatMap((d) => places.get(d)!))].sort((a, b) => a - b);
        if (cells.length !== size) continue;
        const mask = digits.reduce((m, d) => m | bit(d), 0);
        const eliminations = eliminationsOf(state, cells, digitsOf(ALL & ~mask));
        if (eliminations.length === 0) continue;
        found.add(`${cells}|${digits}`, unit, {
          technique,
          place: null,
          eliminations,
          marks: cells.map((cell) => ({ cell, role: "pattern", digits })),
          units: [unit],
          reason: [
            `Look at ${unitName(unit)}: the digits ${listOf(digits)} can only go in ${cellNames(cells)}.`,
            `That is a hidden ${name}: ${size} digits that fit in only ${size} squares must fill them, so those squares cannot be anything else.`,
            `So these can be removed: ${removedBy(eliminations)}.`,
          ],
          nudge: `Look at ${unitName(unit)} for ${size} digits that can only go in the same ${size} squares.`,
        });
      }
    }
    return found.steps;
  };
}

/** Two cells with the same two candidates. */
export const nakedPair: Finder = naked("nakedPair", 2);
/** Three cells with only three digits between them. */
export const nakedTriple: Finder = naked("nakedTriple", 3);
/** Four cells with only four digits between them. */
export const nakedQuad: Finder = naked("nakedQuad", 4);
/** Two digits that fit only in the same two cells. */
export const hiddenPair: Finder = hidden("hiddenPair", 2);
/** Three digits that fit only in the same three cells. */
export const hiddenTriple: Finder = hidden("hiddenTriple", 3);
/** Four digits that fit only in the same four cells. */
export const hiddenQuad: Finder = hidden("hiddenQuad", 4);
