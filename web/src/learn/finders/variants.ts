// The variants' own techniques: the diagonals of Diagonal, the irregular
// regions of Jigsaw and the cages of Killer. Each finder returns nothing on a
// layout it doesn't belong to.
import { boxOf, colOf, rowOf } from "../../core/geometry.ts";
import { type Cage, type Layout, VARIANT_JIGSAW } from "../../core/layout.ts";
import { COMBOS } from "../../generator/layout-solver.ts";
import {
  ALL, type CellDigit, type Finder, type Mark, type State, type Step, bit, cellName, cellNames, cellsWith, count, digitsOf,
  eliminationsOf, layoutOf, listOf, unitName,
} from "../state.ts";
import { hiddenSingles } from "./singles.ts";

/** The most ways of filling a cage a reason lists one by one. */
const MAX_LISTED = 6;

/** "So 5 can be removed from R1C1 and R1C2", "So 1 and 4 can be removed from R1C1", or "So you can remove 3 from ..., and 5 from ...". */
export function removals(eliminations: readonly CellDigit[]): string {
  const digits = [...new Set(eliminations.map((e) => e.digit))].sort((a, b) => a - b);
  const cells = [...new Set(eliminations.map((e) => e.cell))].sort((a, b) => a - b);
  if (digits.length === 1) return `So ${digits[0]} can be removed from ${cellNames(cells)}.`;
  if (cells.length === 1) return `So ${listOf(digits)} can be removed from ${cellName(cells[0]!)}.`;
  const groups = digits.map((d) => `${d} from ${cellNames(eliminations.filter((e) => e.digit === d).map((e) => e.cell).sort((a, b) => a - b))}`);
  return `So you can remove ${groups.slice(0, -1).join(", ")}, and ${groups.at(-1)}.`;
}

/** Eliminations sorted by cell, then digit. */
const sorted = (eliminations: CellDigit[]): CellDigit[] => eliminations.sort((a, b) => a.cell - b.cell || a.digit - b.digit);

// Diagonal.

/** A digit with one place left on a long diagonal. */
export const diagonalSingle: Finder = (state) => hiddenSingles(state, "diagonalSingle", 27, layoutOf(state).units.length);

/**
 * Locked candidates with a diagonal: a digit's places (two or more) in a box
 * all lie on one diagonal, so it leaves the rest of that diagonal; or its
 * places on a diagonal all lie in one box, so it leaves the rest of the box.
 */
export const diagonalLocked: Finder = (state) => {
  const layout = layoutOf(state);
  if (!layout.diagonals) return [];
  const units = layout.units;
  const steps: Step[] = [];
  const step = (digit: number, places: number[], from: number, to: number, eliminations: CellDigit[]): Step => {
    const via = to >= 27 ? "on" : "in";
    return {
      technique: "diagonalLocked",
      place: null,
      eliminations,
      marks: places.map((cell) => ({ cell, role: "pattern", digits: [digit] })),
      units: [from, to],
      reason: [
        `Look at ${unitName(from)}: the ${digit} can only go in ${cellNames(places)}.`,
        `Those squares are all ${via} ${unitName(to)}, so the ${digit} of ${unitName(from)} has to be there, and no other square of ${unitName(to)} can have a ${digit}.`,
        removals(eliminations),
      ],
      nudge: `Look at where ${digit} can go ${from >= 27 ? "on" : "in"} ${unitName(from)}.`,
    };
  };
  for (let digit = 1; digit <= 9; digit++) {
    for (let box = 18; box < 27; box++) {
      const places = cellsWith(state, units[box]!, digit);
      if (places.length < 2) continue;
      for (const diagonal of [27, 28]) {
        if (!places.every((c) => units[diagonal]!.includes(c))) continue;
        const eliminations = eliminationsOf(state, units[diagonal]!.filter((c) => !units[box]!.includes(c)), [digit]);
        if (eliminations.length > 0) steps.push(step(digit, places, box, diagonal, eliminations));
      }
    }
    for (const diagonal of [27, 28]) {
      const places = cellsWith(state, units[diagonal]!, digit);
      if (places.length < 2) continue;
      const box = 18 + boxOf(places[0]!);
      if (!places.every((c) => 18 + boxOf(c) === box)) continue;
      const eliminations = eliminationsOf(state, units[box]!.filter((c) => !units[diagonal]!.includes(c)), [digit]);
      if (eliminations.length > 0) steps.push(step(digit, places, diagonal, box, eliminations));
    }
  }
  return steps;
};

// Jigsaw.

/** A digit with one place left in a jigsaw region. */
export const jigsawSingle: Finder = (state) => (layoutOf(state).variant === VARIANT_JIGSAW ? hiddenSingles(state, "jigsawSingle", 18, 27) : []);

const TIMES = ["once", "twice", "three times", "four times"];

/** "row 1", "rows 1 and 2", "rows 7 to 9". */
function linesName(lines: readonly number[]): string {
  const kind = lines[0]! < 9 ? "row" : "column";
  const first = (lines[0]! % 9) + 1;
  const last = (lines.at(-1)! % 9) + 1;
  if (lines.length === 1) return `${kind} ${first}`;
  return `${kind}s ${first} ${lines.length === 2 ? "and" : "to"} ${last}`;
}

/** Every digit in `cells`: the placed ones and the candidates of the empty ones. */
const possible = (state: State, cells: readonly number[]): number =>
  cells.reduce((m, c) => m | (state.grid[c] !== 0 ? bit(state.grid[c]!) : state.cand[c]!), 0);

/** One use of the law of leftovers: lines at an edge, the regions lying mostly inside them, and the squares left over on each side. */
export interface LeftoverSets {
  /** The rows or columns, as unit ids, ascending. */
  lines: number[];
  /** The regions (0 to 8), ascending. */
  regions: number[];
  /** The squares of the lines outside the regions. */
  a: number[];
  /** The squares of the regions outside the lines. */
  b: number[];
}

/**
 * Every use of the law of leftovers a jigsaw layout offers: `k` rows (or
 * columns) at an edge, `k` of 1 to 4, hold every digit `k` times, and so do
 * the regions lying mostly (five or more squares) inside them, when there are
 * exactly `k` of those. Only sides of one to four squares count. Top rows,
 * bottom rows, left columns, then right columns, fewest lines first.
 */
export function leftoverSets(layout: Layout): LeftoverSets[] {
  const out: LeftoverSets[] = [];
  for (const [first, dir] of [[0, 1], [8, -1], [9, 1], [17, -1]] as const) {
    for (let k = 1; k <= 4; k++) {
      const lines = Array.from({ length: k }, (_, i) => first + i * dir).sort((x, y) => x - y);
      const inLines = new Set(lines.flatMap((u) => layout.units[u]!));
      const regions = Array.from({ length: 9 }, (_, g) => g).filter((g) => layout.units[18 + g]!.filter((c) => inLines.has(c)).length >= 5);
      if (regions.length !== k) continue;
      const inRegions = new Set(regions.flatMap((g) => layout.units[18 + g]!));
      const a = [...inLines].filter((c) => !inRegions.has(c)).sort((x, y) => x - y);
      const b = [...inRegions].filter((c) => !inLines.has(c)).sort((x, y) => x - y);
      if (a.length >= 1 && a.length <= 4) out.push({ lines, regions, a, b });
    }
  }
  return out;
}

/**
 * The law of leftovers (see {@link leftoverSets}): the squares of the lines
 * outside the regions (A) and of the regions outside the lines (B) hold the
 * same digits, so each side can only hold what the other can.
 */
export const leftovers: Finder = (state) => {
  const layout = layoutOf(state);
  if (layout.variant !== VARIANT_JIGSAW) return [];
  const steps: Step[] = [];
  for (const { lines, regions, a, b } of leftoverSets(layout)) {
    const possA = possible(state, a);
    const possB = possible(state, b);
    const eliminations = sorted([
      ...eliminationsOf(state, a.filter((c) => state.grid[c] === 0), digitsOf(ALL & ~possB)),
      ...eliminationsOf(state, b.filter((c) => state.grid[c] === 0), digitsOf(ALL & ~possA)),
    ]);
    if (eliminations.length === 0) continue;
    const k = lines.length;
    const name = linesName(lines);
    const regionNames = k === 1 ? `region ${regions[0]! + 1}` : `regions ${listOf(regions.map((g) => g + 1))}`;
    const kind = lines[0]! < 9 ? "row" : "column";
    const plural = k === 1 ? "" : "s";
    const limits = [
      eliminations.some((e) => a.includes(e.cell)) && `${cellNames(b)} can only hold ${listOf(digitsOf(possB))}, so ${cellNames(a)} can't hold anything else.`,
      eliminations.some((e) => b.includes(e.cell)) && `${cellNames(a)} can only hold ${listOf(digitsOf(possA))}, so ${cellNames(b)} can't hold anything else.`,
    ].filter((text) => text !== false);
    steps.push({
      technique: "leftovers",
      place: null,
      eliminations,
      marks: [...a.map((cell): Mark => ({ cell, role: "colourA" })), ...b.map((cell): Mark => ({ cell, role: "colourB" }))],
      units: lines,
      reason: [
        `${capital(name)} hold${plural ? "" : "s"} every digit ${TIMES[k - 1]}, and so do${k === 1 ? "es" : ""} ${regionNames}, which lie${k === 1 ? "s" : ""} mostly inside ${k === 1 ? "it" : "them"}.`,
        `Take away the squares they share: what is left of the ${kind}${plural} (${cellNames(a)}) must hold the same digits as what is left of the region${plural} (${cellNames(b)}).`,
        limits.join(" "),
        removals(eliminations),
      ],
      nudge: `Compare ${name} with the region${plural} lying mostly inside ${k === 1 ? "it" : "them"}.`,
    });
  }
  return steps;
};

// Killer.

/** Every set of `n` different digits from the mask `avail` that adds up to `sum`, as masks, ascending. */
export function digitSets(n: number, sum: number, avail: number): number[] {
  const out: number[] = [];
  for (let set = 1; set <= ALL; set++) {
    if ((set & ~avail) !== 0 || count(set) !== n) continue;
    if (digitsOf(set).reduce((s, d) => s + d, 0) === sum) out.push(set);
  }
  return out;
}

/** "1+2+6". */
const setName = (set: number): string => digitsOf(set).join("+");

/** A cage in hand: its placed digits, its empty squares, and what they have left to make. */
interface CageState {
  cage: Cage;
  placed: number[];
  empty: number[];
  rest: number;
}

function cageState(state: State, cage: Cage): CageState {
  const placed = cage.cells.filter((c) => state.grid[c] !== 0).map((c) => state.grid[c]!);
  const empty = cage.cells.filter((c) => state.grid[c] === 0);
  return { cage, placed, empty, rest: cage.sum - placed.reduce((s, d) => s + d, 0) };
}

/** "The cage of R1C1 and R1C2 adds up to 12", with what it already holds and what its empty squares have left to make. */
function cageSentence({ cage, placed, empty, rest }: CageState): string {
  const name = `The cage of ${cellNames(cage.cells)} adds up to ${cage.sum}`;
  if (placed.length === 0) return `${name}, with no digit twice.`;
  return `${name}. It already holds ${listOf([...placed].sort((a, b) => a - b))}, so its ${empty.length} empty square${empty.length === 1 ? "" : "s"} must make ${rest} with different digits.`;
}

/**
 * The fillings of a cage's empty squares from their candidates: different
 * digits adding up to what is left. Returns the digits each square takes in
 * some filling, and the digit sets used.
 */
function fillings(state: State, empty: readonly number[], rest: number): { found: number[]; sets: number[] } {
  const n = empty.length;
  const found = new Array<number>(n).fill(0);
  const sets = new Set<number>();
  const assign = new Array<number>(n).fill(0);
  const fill = (k: number, left: number, used: number): void => {
    if (k === n) {
      if (left !== 0) return;
      assign.forEach((d, j) => (found[j]! |= bit(d)));
      sets.add(used);
      return;
    }
    for (const d of digitsOf(state.cand[empty[k]!]! & ~used)) {
      if (d > left) break;
      assign[k] = d;
      fill(k + 1, left - d, used | bit(d));
    }
  };
  fill(0, rest, 0);
  return { found, sets: [...sets].sort((a, b) => a - b) };
}

/** The ways to fill a cage, for a cage combination's reason: each one, or how many there are. */
function waysText(sets: readonly number[], rest: number, squares: number): string {
  const make = `make ${rest} with ${squares} squares`;
  if (sets.length === 1) return `the only way to ${make} is ${setName(sets[0]!)}`;
  if (sets.length <= MAX_LISTED) return `the ways to ${make} are ${listOf(sets.map(setName))}`;
  return `there are ${sets.length} ways to ${make}`;
}

/**
 * Cage sums: the digits of a cage are all different and add up to its sum,
 * so each square keeps only the digits of some filling that fits the
 * candidates. One step per cage that loses a candidate.
 */
export const cageCombination: Finder = (state) => {
  const steps: Step[] = [];
  for (const cage of layoutOf(state).cages) {
    const c = cageState(state, cage);
    if (c.empty.length === 0) continue;
    const { found, sets } = fillings(state, c.empty, c.rest);
    const eliminations = sorted(c.empty.flatMap((cell, k) => eliminationsOf(state, [cell], digitsOf(state.cand[cell]! & ~found[k]!))));
    if (eliminations.length === 0) continue;
    const many = c.empty.length > 1;
    steps.push({
      technique: "cageCombination",
      place: null,
      eliminations,
      marks: c.empty.map((cell) => ({ cell, role: "pattern" })),
      units: [],
      reason: [
        cageSentence(c),
        many
          ? `With the digits ${c.placed.length > 0 ? "its empty squares" : "its squares"} can still hold, ${waysText(sets, c.rest, c.empty.length)}.`
          : `So ${cellName(c.empty[0]!)} must be ${c.rest}.`,
        removals(eliminations),
      ],
      nudge: `Work out which digits can add up to ${cage.sum} in the cage at ${cellName(cage.cells[0]!)}.`,
    });
  }
  return steps;
};

/** The innies or outies of a unit: cells with a known total. */
interface SumSet {
  cells: number[];
  sum: number;
  innies: boolean;
}

/** A unit's innies (its squares in cages crossing its edge) and outies (those cages' squares outside it), as the grader's 45 rule finds them. */
export function sumSets(layout: Layout, unit: number): { whole: number; total: number; sets: SumSet[] } {
  const inside = new Set(layout.units[unit]!);
  let whole = 0;
  let partial = 0;
  const innies: number[] = [];
  const outies: number[] = [];
  for (const cage of layout.cages) {
    const n = cage.cells.filter((c) => inside.has(c)).length;
    if (n === cage.cells.length) whole += cage.sum;
    else if (n > 0) {
      partial += cage.sum;
      for (const c of cage.cells) (inside.has(c) ? innies : outies).push(c);
    }
  }
  const sets = innies.length === 0 ? [] : [
    { cells: innies.sort((a, b) => a - b), sum: 45 - whole, innies: true },
    { cells: outies.sort((a, b) => a - b), sum: whole + partial - 45, innies: false },
  ];
  return { whole, total: whole + partial, sets };
}

/**
 * The 45 rule: a row, column or box adds up to 45, so its innies add up to
 * 45 less the cages wholly inside it, and its outies to the cages touching it
 * less 45. When one square of either set is empty, it is what the set has
 * left to make.
 */
export const rule45: Finder = (state) => {
  const layout = layoutOf(state);
  if (layout.cages.length === 0) return [];
  const steps: Step[] = [];
  for (let unit = 0; unit < 27; unit++) {
    const { whole, total, sets } = sumSets(layout, unit);
    for (const set of sets) {
      const empty = set.cells.filter((c) => state.grid[c] === 0);
      if (empty.length !== 1) continue;
      const cell = empty[0]!;
      const others = set.cells.filter((c) => c !== cell);
      const held = others.reduce((s, c) => s + state.grid[c]!, 0);
      const digit = set.sum - held;
      const name = unitName(unit);
      const one = set.cells.length === 1;
      const what = set.innies
        ? `${one ? "its one square in a cage that crosses its edge, the innie" : "its squares in cages that cross its edge, the innies"} ${cellNames(set.cells)}, ${one ? "is" : "add up to"} 45 - ${whole} = ${set.sum}`
        : `${one ? "their one square outside it, the outie" : "their squares outside it, the outies"} ${cellNames(set.cells)}, ${one ? "is" : "add up to"} ${total} - 45 = ${set.sum}`;
      steps.push({
        technique: "rule45",
        place: { cell, digit },
        eliminations: [],
        marks: set.cells.map((c) => ({ cell: c, role: "pattern" })),
        units: [unit],
        reason: [
          set.innies
            ? `${capital(name)} adds up to 45, and ${whole > 0 ? `the cages lying wholly inside it add up to ${whole}` : "no cage lies wholly inside it"}.`
            : `The cages that reach into ${name} add up to ${total}, and ${name} itself adds up to 45.`,
          `So ${what}.`,
          others.length > 0
            ? `${cellNames(others)} already ${others.length === 1 ? "holds" : "hold"} ${held}, so ${cellName(cell)} is ${set.sum} - ${held} = ${digit}.`
            : `So ${cellName(cell)} is ${digit}.`,
        ],
        nudge: `Add up the cages around ${name}.`,
      });
    }
  }
  return steps;
};

/**
 * Cage pointing: a digit every filling of a cage must use, whose places in
 * the cage all share a row, column or box, leaves the rest of that unit
 * outside the cage.
 */
export const cagePointing: Finder = (state) => {
  const layout = layoutOf(state);
  const steps: Step[] = [];
  for (const cage of layout.cages) {
    const c = cageState(state, cage);
    const avail = c.empty.reduce((m, cell) => m | state.cand[cell]!, 0);
    for (const digit of digitsOf(avail)) {
      if (COMBOS[(c.empty.length * 46 + c.rest) * 512 + (avail & ~bit(digit))] !== 0) continue;
      const places = cellsWith(state, c.empty, digit);
      const units = [rowOf(places[0]!), 9 + colOf(places[0]!), 18 + boxOf(places[0]!)];
      for (const unit of units) {
        if (!places.every((p) => layout.units[unit]!.includes(p))) continue;
        const eliminations = eliminationsOf(state, layout.units[unit]!.filter((p) => layout.cageOf[p] !== layout.cageOf[cage.cells[0]!]), [digit]);
        if (eliminations.length === 0) continue;
        const name = unitName(unit);
        steps.push({
          technique: "cagePointing",
          place: null,
          eliminations,
          marks: places.map((cell) => ({ cell, role: "pattern", digits: [digit] })),
          units: [unit],
          reason: [
            cageSentence(c),
            `With the digits its squares can still hold, every way to do that uses a ${digit}: ${listOf(digitSets(c.empty.length, c.rest, avail).map(setName), "or")}.`,
            `Inside the cage, ${digit} can only go in ${cellNames(places)}, ${places.length === 1 ? "which is" : "which are all"} in ${name}, so no other square of ${name} can be ${digit}.`,
            removals(eliminations),
          ],
          nudge: `Which digit must the cage at ${cellName(cage.cells[0]!)} use?`,
        });
      }
    }
  }
  return steps;
};

function capital(text: string): string {
  return text[0]!.toUpperCase() + text.slice(1);
}
