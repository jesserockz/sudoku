// The four ways to place a digit: the steps every puzzle is finished with.
// On a variant's layout they use its units (a diagonal, a jigsaw region) and
// what each square sees (a diagonal, a cage too).
import { boxOf } from "../../core/geometry.ts";
import { Layout } from "../../core/layout.ts";
import {
  ALL, type Finder, type Mark, type State, type Step, bit, cellName, cellsWith, count, digitsOf, layoutOf, listOf, peerWords, unitName,
  unitWords, unitsOf,
} from "../state.ts";

const empties = (state: State, unit: number): number[] => layoutOf(state).units[unit]!.filter((c) => state.grid[c] === 0);

/** A unit (row, column, box, or a variant's region or diagonal) with one empty cell left. */
export const fullHouse: Finder = (state) => {
  const steps: Step[] = [];
  const seen = new Set<number>();
  const layout = layoutOf(state);
  for (let unit = 0; unit < layout.units.length; unit++) {
    const open = empties(state, unit);
    if (open.length !== 1 || seen.has(open[0]!)) continue;
    const cell = open[0]!;
    const digits = digitsOf(state.cand[cell]!);
    if (digits.length !== 1) continue;
    seen.add(cell);
    const digit = digits[0]!;
    steps.push({
      technique: "fullHouse",
      place: { cell, digit },
      eliminations: [],
      marks: [{ cell, role: "pattern" }],
      units: [unit],
      reason: [
        `${capital(unitName(unit, layout))} has only one empty square: ${cellName(cell)}.`,
        `The only digit missing from ${unitName(unit, layout)} is ${digit}, so ${cellName(cell)} is ${digit}.`,
      ],
      nudge: `One ${unitWords(layout)} has just one empty square left.`,
    });
  }
  return steps;
};

/** The placed digits `digit` that rule it out of some other empty cell of `unit`, for showing why it has one place left. */
function blockers(state: State, unit: number, digit: number, target: number): Mark[] {
  const out = new Set<number>();
  const peers = layoutOf(state).peers;
  for (const cell of empties(state, unit)) {
    if (cell === target) continue;
    const blocker = peers[cell]!.find((p) => state.grid[p] === digit);
    if (blocker !== undefined) out.add(blocker);
  }
  return [...out].sort((a, b) => a - b).map((cell) => ({ cell, role: "see" }));
}

/** Hidden singles of the units `from..to` of the state's layout: a digit with one place left in the unit. */
export function hiddenSingles(state: State, technique: string, from: number, to: number): Step[] {
  const steps: Step[] = [];
  const layout = layoutOf(state);
  for (let unit = from; unit < to; unit++) {
    for (let digit = 1; digit <= 9; digit++) {
      const places = cellsWith(state, layout.units[unit]!, digit);
      if (places.length !== 1) continue;
      const cell = places[0]!;
      const name = unitName(unit, layout);
      steps.push({
        technique,
        place: { cell, digit },
        eliminations: [],
        marks: [{ cell, role: "pattern" }, ...blockers(state, unit, digit, cell)],
        units: [unit],
        reason: [
          `Look at ${name} and ask where its ${digit} can go.`,
          `Every other empty square of ${name} already has a ${digit} in its ${peerWords(layout)}, or has had ${digit} ruled out.`,
          `${cellName(cell)} is the only place left for ${digit} in ${name}, so it is ${digit}.`,
        ],
        nudge: `Where can ${digit} go in ${name}?`,
      });
    }
  }
  return steps;
}

/** Cross-hatching: a digit with one place left in a box. */
export const crossHatch: Finder = (state) => hiddenSingles(state, "crossHatch", 18, 27);

/** A digit with one place left in a row or column. */
export const hiddenSingle: Finder = (state) => hiddenSingles(state, "hiddenSingle", 0, 18);

/** What a square shares its units (and cage) with, for a naked single's reason. */
function sharesWith(layout: Layout, cell: number, digits: readonly number[]): string {
  if (layout === Layout.STANDARD) return `${cellName(cell)} shares its row, column and box (box ${boxOf(cell) + 1}) with ${listOf(digits)}.`;
  return `The squares ${cellName(cell)} sees (those sharing its ${peerWords(layout)}) hold ${listOf(digits)}.`;
}

/** A cell with one candidate left. */
export const nakedSingle: Finder = (state) => {
  const steps: Step[] = [];
  const layout = layoutOf(state);
  for (let cell = 0; cell < 81; cell++) {
    const mask = state.cand[cell]!;
    if (count(mask) !== 1) continue;
    const digit = digitsOf(mask)[0]!;
    let seenMask = 0;
    for (const p of layout.peers[cell]!) if (state.grid[p] !== 0) seenMask |= bit(state.grid[p]!);
    const plain = (ALL & ~seenMask) === mask;
    steps.push({
      technique: "nakedSingle",
      place: { cell, digit },
      eliminations: [],
      marks: [{ cell, role: "pattern" }],
      units: unitsOf(cell, layout),
      reason: plain
        ? [sharesWith(layout, cell, digitsOf(seenMask)), `That leaves ${digit} as the only digit it can be.`]
        : [`${cellName(cell)} has one candidate left, so it is ${digit}.`],
      nudge: "One square has only a single digit it can still be.",
    });
  }
  return steps;
};

function capital(text: string): string {
  return text[0]!.toUpperCase() + text.slice(1);
}

