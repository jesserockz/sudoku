// Every technique the Learn area teaches, in the order a solver reaches for
// them: the easiest that applies is always the next step. Each variant has
// its own order: its techniques slot in, and the standard ones that aren't
// sound under its rules drop out.
import { type Layout, VARIANT_DIAGONAL, VARIANT_JIGSAW, VARIANT_KILLER } from "../core/layout.ts";
import { KILLER_TECHNIQUES, TECHNIQUES as GRADER_TECHNIQUES, techniquesFor } from "../generator/grader.ts";
import { xyChain } from "./finders/chains.ts";
import { simpleColouring, xChain } from "./finders/colouring.ts";
import { jellyfish, swordfish, xWing } from "./finders/fish.ts";
import { claiming, pointing } from "./finders/locked.ts";
import { crossHatch, fullHouse, hiddenSingle, nakedSingle } from "./finders/singles.ts";
import { hiddenPair, hiddenQuad, hiddenTriple, nakedPair, nakedQuad, nakedTriple } from "./finders/subsets.ts";
import { emptyRectangle, skyscraper, twoStringKite } from "./finders/turbot.ts";
import { uniqueRectangle } from "./finders/unique.ts";
import { cageCombination, cagePointing, diagonalLocked, diagonalSingle, jigsawSingle, leftovers, rule45 } from "./finders/variants.ts";
import { wWing, xyWing, xyzWing } from "./finders/wings.ts";
import { type Finder, type State, type Step, apply, isSolved, layoutOf } from "./state.ts";

export interface Technique {
  id: string;
  name: string;
  find: Finder;
  /** Whether its steps place a digit (the singles) rather than remove candidates. */
  places: boolean;
  /**
   * Its index in the grader's techniques (as `Grader.step()` returns it under
   * the layout the technique is taught on: `KILLER_TECHNIQUES` for the killer
   * ones), or -1 for one the grader doesn't use. See {@link graderStepOf} for
   * other layouts.
   */
  grader: number;
}

/**
 * The grader's name for a technique: it counts cross-hatching, full houses
 * and the variants' singles as hidden singles, and locked candidates with a
 * diagonal as pointing. It has no law of leftovers.
 */
function graderName(id: string): string {
  switch (id) {
    case "fullHouse": case "crossHatch": case "diagonalSingle": case "jigsawSingle": return "hiddenSingle";
    case "diagonalLocked": return "pointing";
    default: return id;
  }
}

/** The index `Grader.step()` returns under `layout` when it takes the same step as technique `t`, or -1 when it has no such technique. */
export const graderStepOf = (t: Pick<Technique, "id">, layout: Layout): number => techniquesFor(layout).findIndex((g) => g.name === graderName(t.id));

const technique = (id: string, name: string, find: Finder, places = false): Technique =>
  ({ id, name, find, places, grader: GRADER_TECHNIQUES.findIndex((g) => g.name === graderName(id)) });

const killerTechnique = (id: string, name: string, find: Finder, places = false): Technique =>
  ({ id, name, find, places, grader: KILLER_TECHNIQUES.findIndex((g) => g.name === id) });

export const TECHNIQUES: readonly Technique[] = [
  technique("fullHouse", "Full house", fullHouse, true),
  technique("crossHatch", "Cross-hatching", crossHatch, true),
  technique("hiddenSingle", "Hidden single", hiddenSingle, true),
  technique("nakedSingle", "Naked single", nakedSingle, true),
  technique("pointing", "Pointing", pointing),
  technique("claiming", "Claiming", claiming),
  technique("nakedPair", "Naked pair", nakedPair),
  technique("hiddenPair", "Hidden pair", hiddenPair),
  technique("nakedTriple", "Naked triple", nakedTriple),
  technique("hiddenTriple", "Hidden triple", hiddenTriple),
  technique("nakedQuad", "Naked quad", nakedQuad),
  technique("hiddenQuad", "Hidden quad", hiddenQuad),
  technique("xWing", "X-Wing", xWing),
  technique("swordfish", "Swordfish", swordfish),
  technique("jellyfish", "Jellyfish", jellyfish),
  technique("skyscraper", "Skyscraper", skyscraper),
  technique("twoStringKite", "2-String Kite", twoStringKite),
  technique("emptyRectangle", "Empty Rectangle", emptyRectangle),
  technique("xyWing", "XY-Wing", xyWing),
  technique("xyzWing", "XYZ-Wing", xyzWing),
  technique("wWing", "W-Wing", wWing),
  technique("uniqueRectangle", "Unique Rectangle", uniqueRectangle),
  technique("simpleColouring", "Simple colouring", simpleColouring),
  technique("xChain", "X-Chain", xChain),
  technique("xyChain", "XY-Chain", xyChain),
];

/** The variants' own techniques, in the order the lessons teach them. */
export const VARIANT_TECHNIQUES: readonly Technique[] = [
  technique("diagonalSingle", "Diagonal single", diagonalSingle, true),
  technique("diagonalLocked", "Diagonal locked candidates", diagonalLocked),
  technique("jigsawSingle", "Jigsaw single", jigsawSingle, true),
  technique("leftovers", "Law of leftovers", leftovers),
  killerTechnique("cageCombination", "Cage combination", cageCombination),
  killerTechnique("rule45", "45 rule", rule45, true),
  killerTechnique("cagePointing", "Cage pointing", cagePointing),
];

export function techniqueById(id: string): Technique {
  const found = TECHNIQUES.find((t) => t.id === id) ?? VARIANT_TECHNIQUES.find((t) => t.id === id);
  if (!found) throw new RangeError(`unknown technique: ${id}`);
  return found;
}

const ids = (list: string): Technique[] => list.split(" ").map(techniqueById);
/** The standard techniques from naked pairs on, without the unique rectangle: its uniqueness argument doesn't survive extra rules. */
const HARDER = TECHNIQUES.slice(TECHNIQUES.findIndex((t) => t.id === "nakedPair")).filter((t) => t.id !== "uniqueRectangle");

/** Each variant's techniques in order, by variant. */
const ORDERS: Record<number, readonly Technique[]> = {
  [VARIANT_DIAGONAL]: [...ids("fullHouse crossHatch hiddenSingle diagonalSingle nakedSingle pointing claiming diagonalLocked"), ...HARDER],
  // The other standard techniques assume 3 by 3 boxes, which a jigsaw doesn't have.
  [VARIANT_JIGSAW]: ids("fullHouse hiddenSingle jigsawSingle nakedSingle leftovers"),
  [VARIANT_KILLER]: [...ids("fullHouse crossHatch hiddenSingle nakedSingle cageCombination pointing claiming rule45 cagePointing"), ...HARDER],
};

/** The techniques that work under `layout`, easiest first. */
export const techniquesIn = (layout: Layout): readonly Technique[] => ORDERS[layout.variant] ?? TECHNIQUES;

/** The easiest step open in a position (under its layout's techniques), or `null` when no technique applies. */
export function nextStep(state: State): Step | null {
  for (const t of techniquesIn(layoutOf(state))) {
    const steps = t.find(state);
    if (steps.length > 0) return steps[0]!;
  }
  return null;
}

/** Whether any technique easier than `id` (in the position's layout's order) applies. */
export function easierApplies(state: State, id: string): boolean {
  for (const t of techniquesIn(layoutOf(state))) {
    if (t.id === id) return false;
    if (t.find(state).length > 0) return true;
  }
  throw new RangeError(`unknown technique: ${id}`);
}

/** Solves as far as the techniques go, returning each step taken and where it ended. */
export function solveByLogic(start: State): { steps: Step[]; end: State } {
  const steps: Step[] = [];
  let state = start;
  while (!isSolved(state)) {
    const step = nextStep(state);
    if (!step) break;
    steps.push(step);
    state = apply(state, step);
  }
  return { steps, end: state };
}
