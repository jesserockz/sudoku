// Chains of one digit built from strong links (units with two places left for
// the digit, so one of the two must be it): simple colouring and X-chains.
import { peers } from "../../core/geometry.ts";
import { type Finder, type Mark, type State, type Step, cellName, cellNames, commonPeers, eliminationsOf, sees, unitName } from "../state.ts";
import { type Link, chainMarks, strongLinks } from "./turbot.ts";

/** The strong links at each cell, as `[other cell, unit]`. */
function linkMap(links: readonly Link[]): Map<number, [number, number][]> {
  const map = new Map<number, [number, number][]>();
  for (const { unit, a, b } of links) {
    if (!map.has(a)) map.set(a, []);
    if (!map.has(b)) map.set(b, []);
    map.get(a)!.push([b, unit]);
    map.get(b)!.push([a, unit]);
  }
  return map;
}

/**
 * Simple colouring: the strong links of a digit that join up into a chain
 * are coloured alternately (the lowest cell is colour A). One colour is
 * the digit and the other is not. Two rules follow: if two cells of one colour
 * see each other, that colour is false; and a cell outside the chain that sees
 * both colours cannot be the digit. Same scope as the grader's: every
 * connected group of links, for each digit.
 */
export const simpleColouring: Finder = (state) => {
  const steps: Step[] = [];
  for (let digit = 1; digit <= 9; digit++) {
    const links = strongLinks(state, digit);
    const map = linkMap(links);
    const colour = new Map<number, number>();
    for (const start of [...map.keys()].sort((a, b) => a - b)) {
      if (colour.has(start)) continue;
      colour.set(start, 0);
      const queue = [start];
      for (let head = 0; head < queue.length; head++) {
        const v = queue[head]!;
        for (const [w] of map.get(v)!) {
          if (colour.has(w)) continue;
          colour.set(w, 1 - colour.get(v)!);
          queue.push(w);
        }
      }
      const cells = [...queue].sort((a, b) => a - b);
      const group: [number[], number[]] = [cells.filter((c) => colour.get(c) === 0), cells.filter((c) => colour.get(c) === 1)];
      const units = [...new Set(links.filter((l) => queue.includes(l.a)).map((l) => l.unit))];
      const marks: Mark[] = cells.map((cell) => ({ cell, role: colour.get(cell) === 0 ? "colourA" : "colourB", digits: [digit] }));
      const names = ["colour A", "colour B"];
      const intro = `Colour the ${digit}s of this chain in two colours, going along the rows, columns and boxes where ${digit} has only two places: ${cellNames(group[0])} in colour A and ${cellNames(group[1])} in colour B.`;
      const nudge = `Look at ${digit}: find squares joined in a chain by rows, columns or boxes where ${digit} has only two places left, and colour them in two colours.`;
      // Colour wrap: two cells of one colour see each other.
      for (const side of [0, 1]) {
        const mine = group[side]!;
        const pair = mine.flatMap((a, i) => mine.slice(i + 1).filter((b) => sees(a, b)).map((b): [number, number] => [a, b]))[0];
        if (!pair) continue;
        steps.push({
          technique: "simpleColouring",
          place: null,
          eliminations: eliminationsOf(state, mine, [digit]),
          marks,
          units,
          reason: [
            intro,
            `Exactly one of the two colours is the real ${digit}s, but ${cellName(pair[0])} and ${cellName(pair[1])} are both ${names[side]} and see each other, so they cannot both be ${digit}.`,
            `That makes ${names[side]} the wrong colour, so remove ${digit} from every ${names[side]} square: ${cellNames(mine)}.`,
          ],
          nudge,
        });
      }
      // Colour trap: a cell outside the chain sees both colours.
      const inGroup = new Set(cells);
      const trapped = [...Array(81).keys()].filter((t) => !inGroup.has(t) && state.cand[t]! & (1 << (digit - 1))
        && group[0].some((c) => sees(t, c)) && group[1].some((c) => sees(t, c)));
      if (trapped.length === 0) continue;
      const first = trapped[0]!;
      const seenA = group[0].find((c) => sees(first, c))!;
      const seenB = group[1].find((c) => sees(first, c))!;
      steps.push({
        technique: "simpleColouring",
        place: null,
        eliminations: eliminationsOf(state, trapped, [digit]),
        marks,
        units,
        reason: [
          intro,
          `Exactly one of the two colours is the real ${digit}s. ${cellName(first)} sees both ${cellName(seenA)} (colour A) and ${cellName(seenB)} (colour B)${trapped.length > 1 ? ", and so do the other squares named at the end" : ""}, so whichever colour is real, it would put a ${digit} in view of ${cellName(first)}.`,
          `So ${trapped.length > 1 ? "those squares cannot" : `${cellName(first)} cannot`} be ${digit}: remove ${digit} from ${cellNames(trapped)}.`,
        ],
        nudge,
      });
    }
  }
  return steps;
};

/** Most strong links in an X-chain, which makes 8 cells like the grader's longest XY-chain. */
const MAX_LINKS = 4;

/**
 * An X-chain: one digit, a chain that goes strong link, weak link, strong
 * link ... and starts and ends on a strong link (2 to 4 strong links). One of
 * the two end cells must be the digit, so a cell that sees both ends loses it.
 * Shortest chains first, then digit and start cell; of chains with the same
 * eliminations only the shortest is kept.
 */
export const xChain: Finder = (state) => {
  const steps: Step[] = [];
  const kept = new Set<string>();
  const maps = Array.from({ length: 9 }, (_, i) => linkMap(strongLinks(state, i + 1)));
  for (let n = 2; n <= MAX_LINKS; n++) {
    for (let digit = 1; digit <= 9; digit++) {
      const map = maps[digit - 1]!;
      const walk = (path: number[], units: number[]): void => {
        const links = units.length;
        if (links === n) {
          const ends = [path[0]!, path.at(-1)!];
          const eliminations = eliminationsOf(state, commonPeers(ends).filter((c) => !path.includes(c)), [digit]);
          const key = `${digit}:${eliminations.map((e) => e.cell).join(",")}`;
          if (eliminations.length === 0 || kept.has(key)) return;
          kept.add(key);
          steps.push(chainStep(digit, path, units, eliminations));
          return;
        }
        for (const weak of peers[path.at(-1)!]!) {
          if (!map.has(weak) || path.includes(weak)) continue;
          for (const [strong, unit] of map.get(weak)!) {
            if (!path.includes(strong)) walk([...path, weak, strong], [...units, unit]);
          }
        }
      };
      for (const start of [...map.keys()].sort((a, b) => a - b)) {
        for (const [strong, unit] of map.get(start)!) walk([start, strong], [unit]);
      }
    }
  }
  return steps;
};

/** The step for an X-chain `path` (cells in order, pairs joined by the strong links in `units`). */
function chainStep(digit: number, path: number[], units: number[], eliminations: Step["eliminations"]): Step {
  let text = cellName(path[0]!);
  for (let i = 1; i < path.length; i++) text += `${i % 2 === 1 ? " = " : " - "}${cellName(path[i]!)}`;
  const first = cellName(path[0]!);
  const last = cellName(path.at(-1)!);
  return {
    technique: "xChain",
    place: null,
    eliminations,
    marks: chainMarks(path, digit),
    units,
    reason: [
      `Follow the ${digit}s along this chain: ${text}. An = joins the only two places for ${digit} in a unit (${units.map((u) => unitName(u)).join(", ")}), so one of them must be ${digit}, and a - joins two squares that see each other, so they cannot both be ${digit}.`,
      `If ${first} is not ${digit}, then ${cellName(path[1]!)} is, so ${cellName(path[2]!)} is not, and so on along the chain until ${last} has to be ${digit}. So at least one of ${first} and ${last} is ${digit}.`,
      `Any square that sees both ${first} and ${last} cannot be ${digit}, so remove ${digit} from ${cellNames(eliminations.map((e) => e.cell))}.`,
    ],
    nudge: `Look at ${digit}: follow squares where it has only two places in a unit, hopping between squares that see each other.`,
  };
}
