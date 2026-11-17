// Wing techniques: patterns built from two-candidate cells that prove one
// digit must sit in one of two cells, so cells seeing both can't hold it.
import { peers } from "../../core/geometry.ts";
import {
  type CellDigit, type Finder, type State, type Step, UNITS, bit, cellName, cellNames, cellsWith, commonPeers, count, digitsOf, eliminationsOf,
  sees, unitName, unitsOf,
} from "../state.ts";

/** The first of `a`'s units that `b` is in too: the row, column or box that joins them. */
function sharedUnit(a: number, b: number): number {
  return unitsOf(a).find((u) => UNITS[u]!.includes(b))!;
}

const joined = (cells: readonly number[], pivot: number): number[] =>
  [...new Set(cells.map((c) => sharedUnit(pivot, c)))].sort((a, b) => a - b);

/**
 * XY-Wing: a pivot with two candidates {a, b} sees two wings {a, z} and
 * {b, z}. Whatever the pivot is, one wing becomes z, so a cell that sees both
 * wings can't be z.
 */
export const xyWing: Finder = (state) => {
  const steps: Step[] = [];
  for (let pivot = 0; pivot < 81; pivot++) {
    const pc = state.cand[pivot]!;
    if (count(pc) !== 2) continue;
    const near = peers[pivot]!;
    for (const w1 of near) {
      const c1 = state.cand[w1]!;
      if (count(c1) !== 2 || count(c1 & pc) !== 1) continue;
      for (const w2 of near) {
        const c2 = state.cand[w2]!;
        // w1 holds the pivot's lower shared digit, w2 the other: that fixes the order and avoids repeats.
        if (count(c2) !== 2 || count(c2 & pc) !== 1 || (c1 & pc) >= (c2 & pc) || (c1 & ~pc) !== (c2 & ~pc)) continue;
        const z = digitsOf(c1 & ~pc)[0]!;
        const eliminations = eliminationsOf(state, commonPeers([w1, w2]), [z]);
        if (eliminations.length === 0) continue;
        const [a, b] = digitsOf(pc) as [number, number];
        steps.push({
          technique: "xyWing",
          place: null,
          eliminations,
          marks: [
            { cell: pivot, role: "pivot", digits: [a, b] },
            { cell: w1, role: "wing", digits: digitsOf(c1) },
            { cell: w2, role: "wing", digits: digitsOf(c2) },
          ],
          units: joined([w1, w2], pivot),
          reason: [
            `${cellName(pivot)} can only be ${a} or ${b}. It sees ${cellName(w1)}, which can only be ${a} or ${z}, and ${cellName(w2)}, which can only be ${b} or ${z}.`,
            `If ${cellName(pivot)} is ${a}, then ${cellName(w1)} cannot be ${a} so it is ${z}. If ${cellName(pivot)} is ${b}, then ${cellName(w2)} cannot be ${b} so it is ${z}.`,
            `Either way one of ${cellName(w1)} and ${cellName(w2)} is ${z}, so ${z} can be removed from every square that sees both: ${removed(eliminations)}.`,
          ],
          nudge: "Look for a square with two candidates that sees two other two-candidate squares, all three sharing digits in a triangle.",
        });
      }
    }
  }
  return steps;
};

/**
 * XYZ-Wing: a pivot with three candidates {x, y, z} sees two wings {x, z} and
 * {y, z}. One of the three cells must be z, so a cell that sees all three
 * can't be z.
 */
export const xyzWing: Finder = (state) => {
  const steps: Step[] = [];
  for (let pivot = 0; pivot < 81; pivot++) {
    const pc = state.cand[pivot]!;
    if (count(pc) !== 3) continue;
    const near = peers[pivot]!;
    for (const w1 of near) {
      const c1 = state.cand[w1]!;
      if (count(c1) !== 2 || (c1 & ~pc) !== 0) continue;
      for (const w2 of near) {
        const c2 = state.cand[w2]!;
        if (w2 <= w1 || count(c2) !== 2 || (c2 & ~pc) !== 0 || c2 === c1) continue;
        const z = digitsOf(c1 & c2)[0]!;
        const eliminations = eliminationsOf(state, commonPeers([pivot, w1, w2]), [z]);
        if (eliminations.length === 0) continue;
        const x = digitsOf(c1 & ~bit(z))[0]!;
        const y = digitsOf(c2 & ~bit(z))[0]!;
        steps.push({
          technique: "xyzWing",
          place: null,
          eliminations,
          marks: [
            { cell: pivot, role: "pivot", digits: digitsOf(pc) },
            { cell: w1, role: "wing", digits: digitsOf(c1) },
            { cell: w2, role: "wing", digits: digitsOf(c2) },
          ],
          units: joined([w1, w2], pivot),
          reason: [
            `${cellName(pivot)} can be ${x}, ${y} or ${z}. It sees ${cellName(w1)}, which can only be ${x} or ${z}, and ${cellName(w2)}, which can only be ${y} or ${z}.`,
            `If ${cellName(pivot)} is ${x}, then ${cellName(w1)} is ${z}. If it is ${y}, then ${cellName(w2)} is ${z}. If it is ${z}, it is ${z} itself. So one of the three squares is always ${z}.`,
            `A square that sees all three of them cannot be ${z}, so ${z} can be removed from ${removed(eliminations)}.`,
          ],
          nudge: "Look for a three-candidate square that sees two squares with two candidates each, all sharing one digit.",
        });
      }
    }
  }
  return steps;
};

/**
 * W-Wing: two cells that can only be {a, b} and don't see each other, joined
 * by a strong link on a (a unit where a has just two places, one seeing each
 * cell). If one cell were a, the link forces the other to be b, so at least
 * one of them is b and cells seeing both can't be b.
 */
export const wWing: Finder = (state) => {
  const steps: Step[] = [];
  for (let first = 0; first < 81; first++) {
    const mask = state.cand[first]!;
    if (count(mask) !== 2) continue;
    for (let second = first + 1; second < 81; second++) {
      if (state.cand[second] !== mask || sees(first, second)) continue;
      const [lo, hi] = digitsOf(mask) as [number, number];
      for (const [a, b] of [[lo, hi], [hi, lo]] as const) {
        const eliminations = eliminationsOf(state, commonPeers([first, second]), [b]);
        if (eliminations.length === 0) continue;
        const link = findLink(state, first, second, a);
        if (!link) continue;
        const [p, q, unit] = link;
        steps.push({
          technique: "wWing",
          place: null,
          eliminations,
          marks: [
            { cell: first, role: "wing", digits: [a, b] },
            { cell: second, role: "wing", digits: [a, b] },
            { cell: p, role: "pattern", digits: [a] },
            { cell: q, role: "pattern", digits: [a] },
          ],
          units: [unit],
          reason: [
            `${cellName(first)} and ${cellName(second)} can each only be ${a} or ${b}, and they do not see each other. In ${unitName(unit)}, ${a} can only go in ${cellName(p)} or ${cellName(q)}, and ${cellName(p)} sees ${cellName(first)} while ${cellName(q)} sees ${cellName(second)}.`,
            `If ${cellName(first)} were ${a}, then ${cellName(p)} could not be ${a}, so ${cellName(q)} would be ${a} and ${cellName(second)} would have to be ${b}. The same works the other way round, so at least one of them is ${b}.`,
            `A square that sees both ${cellName(first)} and ${cellName(second)} therefore cannot be ${b}: remove ${b} from ${removed(eliminations)}.`,
          ],
          nudge: "Look for two matching two-candidate squares that don't see each other, and a row, column or box where one of their digits has only two places.",
        });
      }
    }
  }
  return steps;
};

/** A unit where `digit` has exactly two places, outside `first` and `second`, one seeing each of them: `[p, q, unit]` with p seeing `first`. */
function findLink(state: State, first: number, second: number, digit: number): [number, number, number] | null {
  for (let unit = 0; unit < 27; unit++) {
    const places = cellsWith(state, UNITS[unit]!, digit);
    if (places.length !== 2) continue;
    const [p, q] = places as [number, number];
    if ([p, q].some((c) => c === first || c === second)) continue;
    if (sees(p, first) && sees(q, second)) return [p, q, unit];
    if (sees(q, first) && sees(p, second)) return [q, p, unit];
  }
  return null;
}

/** The cells of some eliminations, as "R1C2, R3C4 and R5C6". */
const removed = (eliminations: readonly CellDigit[]): string => cellNames([...new Set(eliminations.map((e) => e.cell))]);
