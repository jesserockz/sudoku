// Single-digit patterns built from two strong links. A strong link (or
// conjugate pair) is a row, column or box where a digit has exactly two places
// left: one of the two must be the digit.
import { boxOf, colOf, rowOf } from "../../core/geometry.ts";
import {
  type Finder, type Mark, type State, type Step, UNITS, boxUnit, cellName, cellNames, cellsWith, commonPeers,
  eliminationsOf, has, unitName,
} from "../state.ts";

/** Two cells that are the only places for a digit in a unit. */
export interface Link {
  unit: number;
  a: number;
  b: number;
}

/**
 * Every strong link of `digit`, units ascending (rows, columns, boxes). A pair
 * sharing a row and a box is listed once, under its row (or column).
 */
export function strongLinks(state: State, digit: number): Link[] {
  const out: Link[] = [];
  const seen = new Set<number>();
  for (let unit = 0; unit < 27; unit++) {
    const places = cellsWith(state, UNITS[unit]!, digit);
    if (places.length !== 2) continue;
    const key = places[0]! * 81 + places[1]!;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ unit, a: places[0]!, b: places[1]! });
  }
  return out;
}

/** Marks for cells in chain order: even positions colourB, odd positions colourA. */
export function chainMarks(cells: readonly number[], digit: number): Mark[] {
  return cells.map((cell, i) => ({ cell, role: i % 2 === 1 ? "colourA" : "colourB", digits: [digit] }));
}

/** A skyscraper: two rows (or two columns) with two places for a digit, lined up at one end. */
export const skyscraper: Finder = (state) => {
  const steps: Step[] = [];
  for (let digit = 1; digit <= 9; digit++) {
    const links = strongLinks(state, digit);
    for (const columns of [false, true]) {
      const lines = links.filter((l) => (columns ? l.unit >= 9 && l.unit < 18 : l.unit < 9));
      const across = (cell: number): number => (columns ? rowOf(cell) : colOf(cell));
      const lineName = columns ? "column" : "row";
      const acrossName = columns ? "row" : "column";
      for (let i = 0; i < lines.length; i++) {
        for (let j = i + 1; j < lines.length; j++) {
          const p = [lines[i]!.a, lines[i]!.b];
          const q = [lines[j]!.a, lines[j]!.b];
          const shared: [number, number][] = [];
          for (const x of [0, 1]) for (const y of [0, 1]) if (across(p[x]!) === across(q[y]!)) shared.push([x, y]);
          if (shared.length !== 1) continue; // none: no pattern; two: an X-Wing
          const [x, y] = shared[0]!;
          const roof1 = p[1 - x!]!;
          const roof2 = q[1 - y!]!;
          const base1 = p[x!]!;
          const base2 = q[y!]!;
          const eliminations = eliminationsOf(state, commonPeers([roof1, roof2]), [digit]);
          if (eliminations.length === 0) continue;
          const u1 = unitName(lines[i]!.unit);
          const u2 = unitName(lines[j]!.unit);
          const shareName = `${acrossName} ${across(base1) + 1}`;
          steps.push({
            technique: "skyscraper",
            place: null,
            eliminations,
            marks: chainMarks([roof1, base1, base2, roof2], digit),
            units: [lines[i]!.unit, lines[j]!.unit],
            reason: [
              `Look at where ${digit} can go in ${u1} and ${u2}: only ${cellName(p[0]!)} and ${cellName(p[1]!)} in ${u1}, and only ${cellName(q[0]!)} and ${cellName(q[1]!)} in ${u2}.`,
              `${cellName(base1)} and ${cellName(base2)} are both in ${shareName}, so they cannot both be ${digit}. At least one of them is not ${digit}, and then its ${lineName} has to put its ${digit} at the other end, so at least one of ${cellName(roof1)} and ${cellName(roof2)} (the roof) is always ${digit}.`,
              `Any square that sees both ${cellName(roof1)} and ${cellName(roof2)} cannot be ${digit}, so remove ${digit} from ${cellNames(eliminations.map((e) => e.cell))}.`,
            ],
            nudge: `Look at two ${lineName}s where ${digit} has only two places each, with one place of each in the same ${acrossName}.`,
          });
        }
      }
    }
  }
  return steps;
};

/**
 * A two-string kite: a row and a column each with two places for a digit, with
 * one end of each in the same box. The two other ends are the kite's strings.
 */
export const twoStringKite: Finder = (state) => {
  const steps: Step[] = [];
  for (let digit = 1; digit <= 9; digit++) {
    const links = strongLinks(state, digit);
    const rowLinks = links.filter((l) => l.unit < 9);
    const colLinks = links.filter((l) => l.unit >= 9 && l.unit < 18);
    for (const r of rowLinks) {
      for (const c of colLinks) {
        for (const rIn of [r.a, r.b]) {
          for (const cIn of [c.a, c.b]) {
            const rOut = rIn === r.a ? r.b : r.a;
            const cOut = cIn === c.a ? c.b : c.a;
            if (rIn === cIn || boxOf(rIn) !== boxOf(cIn)) continue;
            if (new Set([rIn, rOut, cIn, cOut]).size < 4) continue;
            if (boxOf(rOut) === boxOf(rIn) && boxOf(cOut) === boxOf(rIn)) continue; // all in one box
            const eliminations = eliminationsOf(state, commonPeers([rOut, cOut]).filter((t) => t !== rIn && t !== cIn), [digit]);
            if (eliminations.length === 0) continue;
            const box = boxOf(rIn) + 1;
            steps.push({
              technique: "twoStringKite",
              place: null,
              eliminations,
              marks: chainMarks([rOut, rIn, cIn, cOut], digit),
              units: [r.unit, c.unit, boxUnit(boxOf(rIn))],
              reason: [
                `Look at ${unitName(r.unit)} and ${unitName(c.unit)}: ${digit} has only two places in each, ${cellName(r.a)} and ${cellName(r.b)} in the row, ${cellName(c.a)} and ${cellName(c.b)} in the column. ${cellName(rIn)} and ${cellName(cIn)} are both in box ${box}.`,
                `${cellName(rIn)} and ${cellName(cIn)} cannot both be ${digit}, since they share box ${box}. So if one of them is not ${digit}, the other end of its pair must be, which means at least one of ${cellName(rOut)} and ${cellName(cOut)} is always ${digit}.`,
                `Any square that sees both ${cellName(rOut)} and ${cellName(cOut)} cannot be ${digit}, so remove ${digit} from ${cellNames(eliminations.map((e) => e.cell))}.`,
              ],
              nudge: `Look at one row and one column where ${digit} has only two places each, with a place of each in the same box.`,
            });
          }
        }
      }
    }
  }
  return steps;
};

/**
 * An empty rectangle: every place for a digit in a box lies on one row and one
 * column of the box (a cross, whose middle may be empty), and a strong link
 * outside the box has one end on the cross's other line.
 */
export const emptyRectangle: Finder = (state) => {
  const steps: Step[] = [];
  for (let digit = 1; digit <= 9; digit++) {
    const links = strongLinks(state, digit);
    for (let box = 0; box < 9; box++) {
      const places = cellsWith(state, UNITS[boxUnit(box)]!, digit);
      const boxRows = [...new Set(UNITS[boxUnit(box)]!.map(rowOf))];
      const boxCols = [...new Set(UNITS[boxUnit(box)]!.map(colOf))];
      if (places.every((p) => rowOf(p) === rowOf(places[0]!)) || places.every((p) => colOf(p) === colOf(places[0]!))) continue; // a single line: pointing
      for (const row of boxRows) {
        for (const col of boxCols) {
          if (!places.every((p) => rowOf(p) === row || colOf(p) === col)) continue;
          for (const link of links) {
            if (link.unit >= 18) continue;
            const byRow = link.unit < 9;
            // A link in a row is hooked onto the cross's column, and the target lies on the cross's row (and vice versa).
            const line = byRow ? col : row;
            const targetLine = byRow ? row : col;
            const linkBand = byRow ? boxRows : boxCols;
            const otherBand = byRow ? boxCols : boxRows;
            if (linkBand.includes(link.unit % 9)) continue; // the link must lie outside the box
            for (const hook of [link.a, link.b]) {
              if ((byRow ? colOf(hook) : rowOf(hook)) !== line) continue;
              const far = hook === link.a ? link.b : link.a;
              const farAt = byRow ? colOf(far) : rowOf(far);
              if (otherBand.includes(farAt)) continue; // the target would be inside the box
              const target = byRow ? row * 9 + farAt : farAt * 9 + col;
              if (!has(state, target, digit)) continue;
              const rowName = `row ${row + 1}`;
              const colName = `column ${col + 1}`;
              const hinge = `${targetLine === row ? rowName : colName}`;
              const hooked = `${line === col ? colName : rowName}`;
              const linkName = unitName(link.unit);
              steps.push({
                technique: "emptyRectangle",
                place: null,
                eliminations: [{ cell: target, digit }],
                marks: [
                  ...places.map((cell): Mark => ({ cell, role: "pattern", digits: [digit] })),
                  { cell: hook, role: "colourB", digits: [digit] },
                  { cell: far, role: "colourA", digits: [digit] },
                ],
                units: [boxUnit(box), link.unit],
                reason: [
                  `Look at box ${box + 1}: every place for ${digit} in it is on ${rowName} or on ${colName}, so they line up along one row and one column, like a cross (the square where the two meet may be empty). Now look at ${linkName}, where ${digit} can go only in ${cellName(hook)} or ${cellName(far)}.`,
                  `If ${cellName(far)} is ${digit}, it sees ${cellName(target)}, so ${cellName(target)} is not ${digit}. If instead ${cellName(hook)} is ${digit}, it takes ${digit} out of all of ${hooked} in the box, so the box's ${digit} must sit on ${hinge}, and then it sees ${cellName(target)} along that line.`,
                  `Either way ${cellName(target)} cannot be ${digit}, so remove it.`,
                ],
                nudge: `Look at where ${digit} can go in box ${box + 1}, and at a row or column nearby with only two places for ${digit}.`,
              });
            }
          }
        }
      }
    }
  }
  return steps;
};
