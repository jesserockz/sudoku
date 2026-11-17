/**
 * Mines practice positions for the Learn area: generates puzzles, solves them
 * with the Learn techniques, and records every position where a technique is
 * the easiest step open, plus the puzzles each technique is the hardest of.
 *
 *   node scripts/learn-mine.ts <first seed> <puzzles> <out.json>
 *   node scripts/learn-mine.ts --variant <1 Diagonal | 2 Jigsaw | 3 Killer> <first seed> <puzzles> <out.json>
 *
 * `scripts/learn-fixture.ts` picks from several runs of this and writes
 * `src/learn/positions.ts` (or, with `--variants`, `src/learn/variant-positions.ts`).
 *
 * With `--variant`, the puzzles come from the Variants generator (Classic and
 * Graded builds, every tier), are solved with the Learn techniques in that
 * variant's order, and only the variant techniques' positions are kept, each
 * with its layout. Killer layouts with a cage of one square are skipped.
 */
import { writeFileSync } from "node:fs";
import { Layout, VARIANT_JIGSAW, VARIANT_KILLER } from "../src/core/layout.ts";
import { removeCells } from "../src/generator/generator.ts";
import { Grader } from "../src/generator/grader.ts";
import { Xoshiro256StarStar } from "../src/generator/random.ts";
import { randomSolution } from "../src/generator/solver.ts";
import { buildClassicVariant, buildGradedVariant } from "../src/generator/variants.ts";
import { type LayoutData, encodeCages } from "../src/learn/positions-format.ts";
import { type State, type Step, apply, basicCandidates, isSolved, stateOf } from "../src/learn/state.ts";
import { TECHNIQUES, VARIANT_TECHNIQUES, graderStepOf, techniquesIn } from "../src/learn/techniques.ts";

export interface MinedPosition {
  technique: string;
  /** A variant's layout, and the solution (variant runs only). */
  layout?: LayoutData;
  solution?: string;
  seed: number;
  grid: string;
  /** Candidate masks, two base-32 characters a cell; empty when they are the rules' own. */
  cand: string;
  empty: number;
  /** How many instances of the technique the position holds. */
  found: number;
  eliminations: number;
  marks: number;
  /** Whether the grader takes the matching technique next (variant runs, which keep positions where it doesn't too). */
  agrees?: boolean;
}

export interface MinedPuzzle {
  hardest: string;
  layout?: LayoutData;
  seed: number;
  givens: string;
  solution: string;
  /** Steps taken per technique id. */
  used: Record<string, number>;
}

const CAP = 400;
const PUZZLE_CAP = 60;

export const encodeCand = (cand: readonly number[]): string => cand.map((m) => m.toString(32).padStart(2, "0")).join("");

/** Whether the grader, given the same candidates (under the same layout), takes the same technique next. */
function graderAgrees(state: State, index: number): boolean {
  const g = new Grader(state.grid, state.layout);
  state.cand.forEach((m, i) => (g.cand[i] = m));
  return g.step() === index;
}

function main(): void {
  const [first, puzzles, out] = [Number(process.argv[2]), Number(process.argv[3]), process.argv[4]!];
  const positions = new Map<string, MinedPosition[]>();
  const hardest = new Map<string, MinedPuzzle[]>();
  let disagreements = 0;
  let stuck = 0;
  for (let seed = first; seed < first + puzzles; seed++) {
    const random = new Xoshiro256StarStar(BigInt(seed));
    const solution = randomSolution(new Array<number>(81).fill(0), random)!;
    const givens = removeCells(solution, seed % 5 === 0 ? 30 : seed % 5 === 1 ? 26 : 0, random);
    let state = stateOf(givens);
    const used: Record<string, number> = {};
    let top = -1;
    let basic = true;
    while (!isSolved(state)) {
      let step: Step | null = null;
      let index = -1;
      let found = 0;
      for (let t = 0; t < TECHNIQUES.length; t++) {
        const steps = TECHNIQUES[t]!.find(state);
        if (steps.length > 0) {
          step = steps[0]!;
          index = t;
          found = steps.length;
          break;
        }
      }
      if (!step) break;
      const technique = TECHNIQUES[index]!;
      const agrees = technique.grader < 0 || graderAgrees(state, technique.grader);
      if (!agrees) disagreements++;
      const list = positions.get(technique.id) ?? [];
      positions.set(technique.id, list);
      if (agrees && list.length < CAP && (!technique.places || basic) && list.at(-1)?.seed !== seed) {
        list.push({
          technique: technique.id, seed, grid: state.grid.join(""),
          cand: basic && encodeCand(state.cand) === encodeCand(basicCandidates(state.grid)) ? "" : encodeCand(state.cand),
          empty: state.grid.filter((d) => d === 0).length, found,
          eliminations: step.eliminations.length, marks: step.marks.length,
        });
      }
      if (step.place === null) basic = false;
      used[technique.id] = (used[technique.id] ?? 0) + 1;
      top = Math.max(top, index);
      state = apply(state, step);
    }
    if (!isSolved(state)) {
      stuck++;
      continue;
    }
    const id = TECHNIQUES[top]!.id;
    const list = hardest.get(id) ?? [];
    hardest.set(id, list);
    if (list.length < PUZZLE_CAP) list.push({ hardest: id, seed, givens: givens.join(""), solution: solution.join(""), used });
  }
  writeFileSync(out, JSON.stringify({ positions: [...positions.values()].flat(), puzzles: [...hardest.values()].flat() }));
  const summary = TECHNIQUES.map((t) => `${t.id} ${positions.get(t.id)?.length ?? 0}/${hardest.get(t.id)?.length ?? 0}`).join(", ");
  console.log(`seeds ${first}..${first + puzzles - 1}: ${summary}; stuck ${stuck}, grader disagreements ${disagreements}`);
}

/** Regions renumbered by their first square, reading order, so "region 1" is the one holding R1C1, as the lessons describe. */
export function canonicalRegions(regions: readonly number[]): number[] {
  const order: number[] = [];
  for (const g of regions) if (!order.includes(g)) order.push(g);
  return regions.map((g) => order.indexOf(g));
}

/** How a layout is written down with a position. */
export function layoutData(layout: Layout): LayoutData {
  if (layout.diagonals) return { diagonal: true };
  if (layout.variant === VARIANT_JIGSAW) return { regions: layout.regions.join("") };
  return { cages: encodeCages(layout.cages) };
}

/** The puzzle of `seed` in `variant`: Classic and Graded builds in turn, tiers 1 to 5 in turn. Jigsaw regions renumbered. */
function variantPuzzle(seed: number, variant: number): { givens: number[]; solution: number[]; layout: Layout } {
  const tier = 1 + (seed % 5);
  const build = Math.floor(seed / 5) % 2 === 0 ? buildClassicVariant(BigInt(seed), variant, tier) : buildGradedVariant(BigInt(seed), variant, tier);
  const layout = variant === VARIANT_JIGSAW ? Layout.jigsaw(canonicalRegions(build.layout.regions)) : build.layout;
  return { givens: Array.from(build.givens, Number), solution: Array.from(build.solution, Number), layout };
}

function mineVariant(variant: number, first: number, puzzles: number, out: string): void {
  const own = new Set(VARIANT_TECHNIQUES.map((t) => t.id));
  const positions = new Map<string, MinedPosition[]>();
  const hardest = new Map<string, MinedPuzzle[]>();
  let disagreements = 0;
  let stuck = 0;
  let skipped = 0;
  for (let seed = first; seed < first + puzzles; seed++) {
    const { givens, solution, layout } = variantPuzzle(seed, variant);
    if (variant === VARIANT_KILLER && layout.cages.some((c) => c.cells.length === 1)) {
      skipped++;
      continue;
    }
    const order = techniquesIn(layout);
    const data = layoutData(layout);
    let state = stateOf(givens, undefined, layout);
    const used: Record<string, number> = {};
    let top = -1;
    let basic = true;
    while (!isSolved(state)) {
      const index = order.findIndex((t) => t.find(state).length > 0);
      if (index < 0) break;
      const technique = order[index]!;
      const steps = technique.find(state);
      const step = steps[0]!;
      if (own.has(technique.id)) {
        const g = graderStepOf(technique, layout);
        const agrees = g < 0 || graderAgrees(state, g);
        if (!agrees) disagreements++;
        const list = positions.get(technique.id) ?? [];
        positions.set(technique.id, list);
        // Placements are shown without notes, so they start from the rules' candidates, except the 45 rule, which doesn't need notes.
        const plain = !technique.places || basic || technique.id === "rule45";
        if (list.length < CAP && plain && list.at(-1)?.seed !== seed) {
          list.push({
            technique: technique.id, layout: data, agrees, solution: solution.join(""), seed, grid: state.grid.join(""),
            cand: basic && encodeCand(state.cand) === encodeCand(basicCandidates(state.grid, layout)) ? "" : encodeCand(state.cand),
            empty: state.grid.filter((d) => d === 0).length, found: steps.length,
            eliminations: Math.min(...steps.map((s) => s.eliminations.length)), marks: step.marks.length,
          });
        }
      }
      if (step.place === null) basic = false;
      used[technique.id] = (used[technique.id] ?? 0) + 1;
      top = Math.max(top, index);
      state = apply(state, step);
    }
    if (!isSolved(state)) {
      stuck++;
      continue;
    }
    const id = order[top]!.id;
    if (!own.has(id)) continue;
    const list = hardest.get(id) ?? [];
    hardest.set(id, list);
    if (list.length < PUZZLE_CAP) list.push({ hardest: id, layout: data, seed, givens: givens.join(""), solution: solution.join(""), used });
  }
  writeFileSync(out, JSON.stringify({ positions: [...positions.values()].flat(), puzzles: [...hardest.values()].flat() }));
  const summary = [...own].map((id) => `${id} ${positions.get(id)?.length ?? 0}/${hardest.get(id)?.length ?? 0}`).join(", ");
  console.log(`variant ${variant} seeds ${first}..${first + puzzles - 1}: ${summary}; stuck ${stuck}, skipped ${skipped}, grader disagreements ${disagreements}`);
}

if (import.meta.main) {
  if (process.argv[2] === "--variant") mineVariant(Number(process.argv[3]), Number(process.argv[4]), Number(process.argv[5]), process.argv[6]!);
  else main();
}
