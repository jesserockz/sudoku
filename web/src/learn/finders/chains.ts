// Chains of two-candidate cells.
import { peers } from "../../core/geometry.ts";
import { MAX_CHAIN } from "../../generator/grader.ts";
import { type CellDigit, type Finder, type Mark, type State, type Step, UNITS, bit, cellName, cellNames, commonPeers, count, digitsOf, eliminationsOf, unitsOf } from "../state.ts";

/** A chain found by the walk: its cells in order, and the digit x that its two ends are both tied to. */
interface Chain {
  cells: number[];
  x: number;
  eliminations: CellDigit[];
}

/**
 * XY-Chain: a run of two-candidate cells, each seeing the next and sharing a
 * digit with it, from {x, ..} to {.., x}. If the first cell is not x it is its
 * other digit, which pushes the next cell to its other digit, and so on down
 * the chain until the last cell must be x. So one end is always x, and cells
 * seeing both ends can't be x. Chains are 3 to MAX_CHAIN cells (the grader's
 * limit), shortest first, one per distinct set of eliminations.
 */
export const xyChain: Finder = (state) => {
  const found = new Map<string, Chain>();
  const visited = new Set<number>();
  const path: number[] = [];

  /** Walks on from `cur`, which hands the digit `carry` on to the next cell. */
  function extend(x: number, carry: number): void {
    const cur = path.at(-1)!;
    for (const next of peers[cur]!) {
      const cn = state.cand[next]!;
      if (visited.has(next) || count(cn) !== 2 || (cn & bit(carry)) === 0) continue;
      const other = digitsOf(cn & ~bit(carry))[0]!;
      path.push(next);
      if (path.length >= 3 && other === x) {
        const eliminations = eliminationsOf(state, commonPeers([path[0]!, next]), [x]);
        const key = eliminations.map((e) => `${e.cell}:${e.digit}`).join(",");
        const known = found.get(key);
        if (eliminations.length > 0 && (!known || known.cells.length > path.length)) found.set(key, { cells: [...path], x, eliminations });
      }
      if (path.length < MAX_CHAIN) {
        visited.add(next);
        extend(x, other);
        visited.delete(next);
      }
      path.pop();
    }
  }

  for (let start = 0; start < 81; start++) {
    const mask = state.cand[start]!;
    if (count(mask) !== 2) continue;
    for (const x of digitsOf(mask)) {
      path.length = 0;
      path.push(start);
      visited.add(start);
      extend(x, digitsOf(mask & ~bit(x))[0]!);
      visited.delete(start);
    }
  }
  return [...found.values()].sort((a, b) => a.cells.length - b.cells.length).map((chain) => toStep(state, chain));
};

function toStep(state: State, { cells, x, eliminations }: Chain): Step {
  // digits[i] is the digit cell i hands on to cell i + 1; the last one is x.
  const handed: number[] = [];
  let carry = digitsOf(state.cand[cells[0]!]! & ~bit(x))[0]!;
  handed.push(carry);
  for (const cell of cells.slice(1)) {
    carry = digitsOf(state.cand[cell]! & ~bit(carry))[0]!;
    handed.push(carry);
  }
  const first = cellName(cells[0]!);
  const last = cellName(cells.at(-1)!);
  const walk = [`if ${first} is not ${x} it is ${handed[0]}`];
  for (let i = 1; i < cells.length; i++) {
    walk.push(`so ${cellName(cells[i]!)} is not ${handed[i - 1]} and must be ${handed[i]}`);
  }
  const marks: Mark[] = cells.map((cell, i) => ({ cell, role: i % 2 === 0 ? "colourA" : "colourB", digits: digitsOf(state.cand[cell]!) }));
  const units = new Set<number>();
  for (let i = 1; i < cells.length; i++) units.add(unitsOf(cells[i]!).find((u) => UNITS[u]!.includes(cells[i - 1]!))!);
  return {
    technique: "xyChain",
    place: null,
    eliminations,
    marks,
    units: [...units].sort((a, b) => a - b),
    reason: [
      `Follow this chain of squares that each have only two candidates: ${cells.map((c) => `${cellName(c)} (${digitsOf(state.cand[c]!).join("/")})`).join(", ")}. Each one sees the next and shares a digit with it.`,
      `${capital(walk.join(", "))}.`,
      `So either ${first} or ${last} is ${x}, and a square that sees both cannot be ${x}: remove ${x} from ${cellNames([...new Set(eliminations.map((e) => e.cell))])}.`,
    ],
    nudge: "Look for a chain of two-candidate squares, each sharing a digit with the next, whose two ends have the same digit.",
  };
}

const capital = (text: string): string => text[0]!.toUpperCase() + text.slice(1);
