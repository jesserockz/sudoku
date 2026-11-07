import { CELLS } from "../core/geometry.ts";
import {
  DEFAULT_LEVELS, DIFFICULTIES, DOMAIN, ENDLESS_DOMAIN, EndlessPuzzle, MAX_ENDLESS_NUMBER, Puzzle, checkLevels, difficultyFor, isEndlessNumber, removeCells,
} from "./generator.ts";
import { STUCK_LEVEL, grade } from "./grader.ts";
import type { Grade } from "./grader.ts";
import { SplitMix64, Xoshiro256StarStar } from "./random.ts";
import { randomSolution } from "./solver.ts";

/**
 * Generator v2: puzzles graded by technique instead of by clue count.
 *
 * Each attempt builds a random full grid, removes cells (see {@link BANDS} for
 * how far), and grades the result with the human-style grader
 * (`grader.ts`). The first attempt whose level falls in the tier's band is
 * the puzzle. Output is a pure function of the inputs, bit-identical in the Go
 * port (`server/internal/puzzle/v2.go`); the shared fixture
 * `testdata/generator-v2.json` pins both.
 *
 * Not used by the app yet.
 */

/** Seed-derivation version for v2 (v1 is `GENERATOR_VERSION` = 1). */
export const GENERATOR_V2_VERSION = 2;
/** Attempts before settling for the closest-to-band puzzle. */
export const MAX_ATTEMPTS_V2 = 200;

/** A difficulty tier of v2: the grader levels it accepts and how far cells are removed. */
export interface Band {
  readonly name: string;
  /** The lowest grader level accepted. */
  readonly minLevel: number;
  /** The highest grader level accepted. */
  readonly maxLevel: number;
  /** Clues to stop removing at; 0 removes until the puzzle is minimal. */
  readonly targetGivens: number;
}

/** The five tiers (Easy to Diabolical): level 1 hidden singles, 2 naked singles, 3 to 4 locked candidates and subsets, 5 fish and wings, 6 colouring and chains. */
export const BANDS: readonly Band[] = [
  { name: "Easy", minLevel: 1, maxLevel: 1, targetGivens: 38 },
  { name: "Medium", minLevel: 2, maxLevel: 2, targetGivens: 30 },
  { name: "Hard", minLevel: 3, maxLevel: 4, targetGivens: 0 },
  { name: "Expert", minLevel: 5, maxLevel: 5, targetGivens: 0 },
  { name: "Diabolical", minLevel: 6, maxLevel: 6, targetGivens: 0 },
];

/** A v2 puzzle with how it was graded and how many attempts it took. */
export interface Graded<P> {
  readonly puzzle: P;
  readonly grade: Grade;
  /** Attempts made (all of them, when none hit the band and a fallback was chosen). */
  readonly attempts: number;
}

/** How far `level`, which is outside the band, is from it. */
function distance(band: Band, level: number): number {
  return level < band.minLevel ? band.minLevel - level : level - band.maxLevel;
}

/** The seed for one v2 daily puzzle: v1's derivation with version 2. */
export function puzzleSeedV2(weekSeed: bigint, dayOfWeek: number, level: number): bigint {
  let h = SplitMix64.mix(DOMAIN + BigInt(GENERATOR_V2_VERSION));
  h = SplitMix64.mix(h ^ BigInt.asUintN(64, weekSeed));
  h = SplitMix64.mix(h + BigInt(dayOfWeek));
  h = SplitMix64.mix(h + BigInt(level));
  return h;
}

/** The seed for one v2 endless puzzle. */
export function endlessPuzzleSeedV2(endlessSeed: bigint, tier: number, number: number): bigint {
  let h = SplitMix64.mix(ENDLESS_DOMAIN + BigInt(GENERATOR_V2_VERSION));
  h = SplitMix64.mix(h ^ BigInt.asUintN(64, endlessSeed));
  h = SplitMix64.mix(h + BigInt(tier));
  h = SplitMix64.mix(h + BigInt(number));
  return h;
}

/**
 * Builds the puzzle for a puzzle seed and a tier (1..5): up to `maxAttempts`
 * times, a random full grid, cells removed to the band's target, then graded;
 * the first attempt whose level is in the band wins.
 *
 * If none is, the fallback is the non-stuck attempt whose level is nearest
 * the band (the easier one on equal distance, then the earliest). If every
 * attempt was stuck, it is the earliest. Exported for tests (a small
 * `maxAttempts` forces the fallback); callers use {@link generateV2} and
 * {@link generateEndlessV2}.
 */
export function buildV2(seed: bigint, tier: number, maxAttempts = MAX_ATTEMPTS_V2): { givens: string; solution: string; grade: Grade; attempts: number } {
  const band = BANDS[tier - 1]!;
  const random = new Xoshiro256StarStar(seed);
  let best: { givens: number[]; solution: number[]; grade: Grade } | null = null;
  let bestKey = 0;
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts++;
    const solution = randomSolution(new Array<number>(CELLS).fill(0), random)!;
    const givens = removeCells(solution, band.targetGivens, random);
    const g = grade(givens);
    if (g.level >= band.minLevel && g.level <= band.maxLevel) {
      best = { givens, solution, grade: g };
      break;
    }
    // Lower is better: a stuck attempt ranks last, then nearer the band, then easier.
    const key = g.level === STUCK_LEVEL ? 1000 : distance(band, g.level) * 10 + g.level;
    if (best === null || key < bestKey) {
      best = { givens, solution, grade: g };
      bestKey = key;
    }
  }
  return { givens: best!.givens.join(""), solution: best!.solution.join(""), grade: best!.grade, attempts };
}

/** {@link generate} for v2: game `level` of `levels` on a day. Not yet used by the app. */
export function generateV2(weekSeed: bigint, dayOfWeek: number, level: number, levels = DEFAULT_LEVELS): Graded<Puzzle> {
  if (!(Number.isInteger(dayOfWeek) && dayOfWeek >= 1 && dayOfWeek <= 7)) {
    throw new RangeError(`dayOfWeek must be 1 (Monday) to 7 (Sunday): ${dayOfWeek}`);
  }
  checkLevels(levels);
  const tier = DIFFICULTIES.indexOf(difficultyFor(level, levels)) + 1;
  const { givens, solution, grade, attempts } = buildV2(puzzleSeedV2(weekSeed, dayOfWeek, level), tier);
  return { puzzle: new Puzzle(weekSeed, dayOfWeek, level, levels, givens, solution), grade, attempts };
}

/** {@link generateEndless} for v2: number `number` of tier `tier` (1..5). Not yet used by the app. */
export function generateEndlessV2(endlessSeed: bigint, tier: number, number: number): Graded<EndlessPuzzle> {
  if (!(Number.isInteger(tier) && tier >= 1 && tier <= BANDS.length)) throw new RangeError(`difficulty must be 1..${BANDS.length}: ${tier}`);
  if (!isEndlessNumber(number)) throw new RangeError(`number must be 1..${MAX_ENDLESS_NUMBER}: ${number}`);
  const { givens, solution, grade, attempts } = buildV2(endlessPuzzleSeedV2(endlessSeed, tier, number), tier);
  return { puzzle: new EndlessPuzzle(endlessSeed, tier, number, givens, solution), grade, attempts };
}
