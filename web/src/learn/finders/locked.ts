// Locked candidates: a digit confined to the overlap of a box and a line.
import { boxOf, boxes, colOf, rowOf } from "../../core/geometry.ts";
import {
  type CellDigit, type Finder, type Step, UNITS, boxUnit, cellNames, cellsWith, colUnit, eliminationsOf,
  rowUnit, unitName,
} from "../state.ts";

/** The cells the eliminations are in, ascending and without repeats. */
const cellsOf = (eliminations: readonly CellDigit[]): number[] => [...new Set(eliminations.map((e) => e.cell))];

/**
 * Pointing: a digit's places in a box all lie in one row or column. The box
 * has to put that digit in one of them, so no other square of the line can
 * have it. Only digits with two or more places count (one place is a hidden
 * single).
 */
export const pointing: Finder = (state) => {
  const steps: Step[] = [];
  for (let digit = 1; digit <= 9; digit++) {
    for (let box = 0; box < 9; box++) {
      const places = cellsWith(state, boxes[box]!, digit);
      if (places.length < 2) continue;
      const row = rowOf(places[0]!);
      const col = colOf(places[0]!);
      let line: number;
      if (places.every((c) => rowOf(c) === row)) line = rowUnit(row);
      else if (places.every((c) => colOf(c) === col)) line = colUnit(col);
      else continue;
      const eliminations = eliminationsOf(state, UNITS[line]!.filter((c) => boxOf(c) !== box), [digit]);
      if (eliminations.length === 0) continue;
      steps.push({
        technique: "pointing",
        place: null,
        eliminations,
        marks: places.map((cell) => ({ cell, role: "pattern", digits: [digit] })),
        units: [boxUnit(box), line],
        reason: [
          `Look at ${unitName(boxUnit(box))}: the ${digit} can only go in ${cellNames(places)}.`,
          `Those squares are all in ${unitName(line)}, so the ${digit} of ${unitName(boxUnit(box))} has to be somewhere in ${unitName(line)}, and no other square of ${unitName(line)} can have a ${digit}.`,
          `So ${digit} can be removed from ${cellNames(cellsOf(eliminations))}.`,
        ],
        nudge: `Look at where ${digit} can go in ${unitName(boxUnit(box))}.`,
      });
    }
  }
  return steps;
};

/**
 * Claiming (box-line reduction): a digit's places in a row or column all lie
 * in one box. The line has to put that digit in one of them, so no other
 * square of the box can have it. Only digits with two or more places count.
 */
export const claiming: Finder = (state) => {
  const steps: Step[] = [];
  for (let digit = 1; digit <= 9; digit++) {
    for (let line = 0; line < 18; line++) {
      const places = cellsWith(state, UNITS[line]!, digit);
      if (places.length < 2) continue;
      const box = boxOf(places[0]!);
      if (!places.every((c) => boxOf(c) === box)) continue;
      const eliminations = eliminationsOf(state, boxes[box]!.filter((c) => !places.includes(c)), [digit]);
      if (eliminations.length === 0) continue;
      steps.push({
        technique: "claiming",
        place: null,
        eliminations,
        marks: places.map((cell) => ({ cell, role: "pattern", digits: [digit] })),
        units: [line, boxUnit(box)],
        reason: [
          `Look at ${unitName(line)}: the ${digit} can only go in ${cellNames(places)}.`,
          `Those squares are all in ${unitName(boxUnit(box))}, so the ${digit} of ${unitName(line)} has to be in ${unitName(boxUnit(box))}, and no other square of ${unitName(boxUnit(box))} can have a ${digit}.`,
          `So ${digit} can be removed from ${cellNames(cellsOf(eliminations))}.`,
        ],
        nudge: `Look at where ${digit} can go in ${unitName(line)}.`,
      });
    }
  }
  return steps;
};

