import { Board } from "../core/board.ts";
import { CELLS } from "../core/geometry.ts";
import { SplitMix64, Xoshiro256StarStar } from "./random.ts";
import { hasUniqueSolution, randomSolution } from "./solver.ts";

/** The five difficulty tiers, driven by a target number of givens, easiest first. */
export interface Difficulty {
  readonly name: string;
  readonly targetGivens: number;
}

export const DIFFICULTIES: readonly Difficulty[] = [
  { name: "Easy", targetGivens: 40 },
  { name: "Medium", targetGivens: 36 },
  { name: "Hard", targetGivens: 32 },
  { name: "Expert", targetGivens: 28 },
  { name: "Diabolical", targetGivens: 24 },
];

/** Output-changing edits to this file, the solver or the PRNGs must bump this (see below). */
export const GENERATOR_VERSION = 1;
/** Attempts before settling for the closest-to-target puzzle. */
export const MAX_ATTEMPTS = 8;
/** The default number of games per day. */
export const DEFAULT_LEVELS = 5;
/** The most games per day the server allows. */
export const MAX_LEVELS = 10;

/** "sudoku" in ASCII; separates this seed derivation from any other use of the week seed. */
const DOMAIN = 0x7375646f6b75n;

/**
 * The tier of game `level` (`1..levels`) on a day with `levels` games.
 *
 * Games are spread evenly across the five tiers, easiest first: game `i`
 * (0-based) of `n` gets tier `round(i * 4 / (n - 1))`, halves rounding up, in
 * exact integer arithmetic. So 5 games are one of each tier; 7 are Easy,
 * Medium, Medium, Hard, Expert, Expert, Diabolical; 10 are two of each; 3 are
 * Easy, Hard, Diabolical; 1 is Hard.
 */
export function difficultyFor(level: number, levels: number): Difficulty {
  checkLevels(levels);
  if (!(Number.isInteger(level) && level >= 1 && level <= levels)) throw new RangeError(`level must be 1..${levels}: ${level}`);
  if (levels === 1) return DIFFICULTIES[2]!;
  const i = level - 1;
  const last = DIFFICULTIES.length - 1;
  return DIFFICULTIES[Math.floor((2 * i * last + (levels - 1)) / (2 * (levels - 1)))]!;
}

/** A display name: the tier's name, numbered when the day has more than one game of it ("Medium 2"). */
export function puzzleTitle(level: number, levels: number): string {
  const difficulty = difficultyFor(level, levels);
  const same: number[] = [];
  for (let l = 1; l <= levels; l++) if (difficultyFor(l, levels) === difficulty) same.push(l);
  return same.length === 1 ? difficulty.name : `${difficulty.name} ${same.indexOf(level) + 1}`;
}

/** A generated puzzle: game `level` of `levels` on a day. Grids are 81-character strings (`0` = empty). */
export class Puzzle {
  readonly weekSeed: bigint;
  readonly dayOfWeek: number;
  readonly level: number;
  readonly levels: number;
  readonly difficulty: Difficulty;
  readonly givens: string;
  readonly solution: string;

  constructor(weekSeed: bigint, dayOfWeek: number, level: number, levels: number, givens: string, solution: string) {
    this.weekSeed = weekSeed;
    this.dayOfWeek = dayOfWeek;
    this.level = level;
    this.levels = levels;
    this.difficulty = difficultyFor(level, levels);
    this.givens = givens;
    this.solution = solution;
  }

  get givenCount(): number {
    return [...this.givens].filter((c) => c !== "0").length;
  }

  get title(): string {
    return puzzleTitle(this.level, this.levels);
  }

  board(): Board {
    return Board.parse(this.givens);
  }
}

/** The seed for one puzzle: every input passes through a full SplitMix64 mix. */
export function puzzleSeed(weekSeed: bigint, dayOfWeek: number, level: number): bigint {
  let h = SplitMix64.mix(DOMAIN + BigInt(GENERATOR_VERSION));
  h = SplitMix64.mix(h ^ BigInt.asUintN(64, weekSeed));
  h = SplitMix64.mix(h + BigInt(dayOfWeek));
  h = SplitMix64.mix(h + BigInt(level));
  return h;
}

/**
 * Deterministic puzzle generation: a pure function of
 * `(weekSeed, dayOfWeek, level, levels)` that gives bit-identical puzzles
 * everywhere. That's what gives the whole group the same daily puzzles, and
 * why the server never needs to store them.
 *
 * **Any change here, in the solver or in the PRNGs that changes output changes
 * everyone's puzzles.** The golden tests (`test/generator.test.ts`) catch that;
 * if a change is intentional, bump {@link GENERATOR_VERSION} and the goldens.
 *
 * 1. Derive a puzzle seed from the version, week seed, day and game number
 *    with SplitMix64, and seed xoshiro256** from it.
 * 2. Build a full grid by backtracking search, trying candidates in random order.
 * 3. Visit the cells in a random order, removing each one only if the puzzle
 *    still has a unique solution, until the tier's target given count is hit.
 * 4. If a pass ends above target, start again from a fresh grid, up to
 *    {@link MAX_ATTEMPTS} times, and keep the attempt with the fewest givens
 *    (the earliest on ties).
 */
export function generate(weekSeed: bigint, dayOfWeek: number, level: number, levels = DEFAULT_LEVELS): Puzzle {
  if (!(Number.isInteger(dayOfWeek) && dayOfWeek >= 1 && dayOfWeek <= 7)) {
    throw new RangeError(`dayOfWeek must be 1 (Monday) to 7 (Sunday): ${dayOfWeek}`);
  }
  const { targetGivens } = difficultyFor(level, levels);
  const random = new Xoshiro256StarStar(puzzleSeed(weekSeed, dayOfWeek, level));

  let best: { givens: number[]; solution: number[]; count: number } | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const solution = randomSolution(new Array<number>(CELLS).fill(0), random)!;
    const givens = removeCells(solution, targetGivens, random);
    const count = givens.filter((v) => v !== 0).length;
    if (!best || count < best.count) best = { givens, solution, count };
    if (count <= targetGivens) break;
  }
  return new Puzzle(weekSeed, dayOfWeek, level, levels, best!.givens.join(""), best!.solution.join(""));
}

/** All games for a day, in order (easiest first). */
export function generateDay(weekSeed: bigint, dayOfWeek: number, levels = DEFAULT_LEVELS): Puzzle[] {
  return Array.from({ length: levels }, (_, i) => generate(weekSeed, dayOfWeek, i + 1, levels));
}

export function checkLevels(levels: number): void {
  if (!(Number.isInteger(levels) && levels >= 1 && levels <= MAX_LEVELS)) {
    throw new RangeError(`levels must be 1..${MAX_LEVELS}: ${levels}`);
  }
}

function removeCells(solution: number[], target: number, random: Xoshiro256StarStar): number[] {
  const grid = solution.slice();
  const order = Array.from({ length: CELLS }, (_, i) => i);
  random.shuffle(order);
  let count = CELLS;
  for (const i of order) {
    if (count <= target) break;
    const digit = grid[i]!;
    grid[i] = 0;
    if (hasUniqueSolution(grid)) count--;
    else grid[i] = digit;
  }
  return grid;
}
