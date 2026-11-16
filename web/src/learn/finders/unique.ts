// Techniques that lean on the puzzle having exactly one solution.
import { boxOf } from "../../core/geometry.ts";
import { type Finder, type Step, boxUnit, cellName, cellNames, count, digitsOf, eliminationsOf } from "../state.ts";

/**
 * Unique Rectangle, type 1: four empty cells at the corners of a rectangle
 * across exactly two boxes, three of them with only {a, b} and the fourth with
 * a and b and more. If the fourth were a or b, the corners could be filled
 * with a and b either way round, giving two solutions, which a proper puzzle
 * never has. So the fourth is none of a and b. (The position must come from
 * a puzzle with one solution: the state does not record the givens, so all
 * four cells just have to be empty.)
 */
export const uniqueRectangle: Finder = (state) => {
  const steps: Step[] = [];
  for (let r1 = 0; r1 < 9; r1++) {
    for (let r2 = r1 + 1; r2 < 9; r2++) {
      for (let c1 = 0; c1 < 9; c1++) {
        for (let c2 = c1 + 1; c2 < 9; c2++) {
          const corners = [r1 * 9 + c1, r1 * 9 + c2, r2 * 9 + c1, r2 * 9 + c2];
          if (new Set(corners.map(boxOf)).size !== 2 || corners.some((c) => state.grid[c] !== 0)) continue;
          const odd = corners.findIndex((c) => count(state.cand[c]!) > 2);
          if (odd < 0) continue;
          const rest = corners.filter((_, i) => i !== odd);
          const mask = state.cand[rest[0]!]!;
          if (count(mask) !== 2 || rest.some((c) => state.cand[c] !== mask)) continue;
          const fourth = corners[odd]!;
          if ((state.cand[fourth]! & mask) !== mask) continue;
          const [a, b] = digitsOf(mask) as [number, number];
          const boxes = [...new Set(corners.map(boxOf))];
          steps.push({
            technique: "uniqueRectangle",
            place: null,
            eliminations: eliminationsOf(state, [fourth], [a, b]),
            marks: [
              ...rest.map((cell) => ({ cell, role: "pattern" as const, digits: [a, b] })),
              { cell: fourth, role: "pivot", digits: [a, b] },
            ],
            units: boxes.map(boxUnit),
            reason: [
              `${cellNames(rest)} can each only be ${a} or ${b}, and together with ${cellName(fourth)} they are the corners of a rectangle across box ${boxes[0]! + 1} and box ${boxes[1]! + 1}.`,
              `If ${cellName(fourth)} were ${a} or ${b}, the four corners could be filled with ${a} and ${b} in two different ways, swapping them over without breaking any rule. A proper puzzle has only one solution, so that can't be allowed.`,
              `So ${cellName(fourth)} is neither ${a} nor ${b}: remove them from it.`,
            ],
            nudge: "Look for three squares at the corners of a rectangle that all hold the same two candidates.",
          });
        }
      }
    }
  }
  return steps;
};
