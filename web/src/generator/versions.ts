import { DEFAULT_LEVELS, type EndlessPuzzle, generateDay, generateEndless, type Puzzle } from "./generator.ts";
import { generateDayV2, generateEndlessV2 } from "./generator-v2.ts";

/** Generator version 1: puzzles by clue count (`generator.ts`). Players see it as "Classic". */
export const GENERATOR_CLASSIC = 1;
/** Generator version 2: puzzles graded by technique (`generator-v2.ts`). Players see it as "Graded". */
export const GENERATOR_GRADED = 2;

/** Every version the daily puzzles can use, in order. */
export const GENERATOR_VERSIONS: readonly number[] = [GENERATOR_CLASSIC, GENERATOR_GRADED];

export function isGeneratorVersion(version: number): boolean {
  return GENERATOR_VERSIONS.includes(version);
}

/**
 * A set of enabled generators, as the server and seed play keep it: the known versions in `versions`, ascending and
 * without duplicates. Throws a `TypeError` for an unknown version or an empty set.
 */
export function enabledGenerators(versions: readonly number[]): number[] {
  const unknown = versions.find((v) => !isGeneratorVersion(v));
  if (unknown !== undefined) throw new TypeError(`unsupported generator version: ${unknown}`);
  const enabled = GENERATOR_VERSIONS.filter((v) => versions.includes(v));
  if (enabled.length === 0) throw new TypeError("no generator is enabled");
  return enabled;
}

/** What players call a generator version. */
export function generatorName(version: number): string {
  switch (version) {
    case GENERATOR_CLASSIC: return "Classic";
    case GENERATOR_GRADED: return "Graded";
    default: return `Generator ${version}`;
  }
}

/** All games for a day with generator `version`, in order (easiest first). Throws a `RangeError` for an unknown version. */
export function generateDayVersion(version: number, weekSeed: bigint, dayOfWeek: number, levels = DEFAULT_LEVELS): Puzzle[] {
  switch (version) {
    case GENERATOR_CLASSIC: return generateDay(weekSeed, dayOfWeek, levels);
    case GENERATOR_GRADED: return generateDayV2(weekSeed, dayOfWeek, levels);
    default: throw new RangeError(`unknown generator version: ${version}`);
  }
}

/** Endless puzzle `number` of tier `tier` with generator `version`. Throws a `RangeError` for an unknown version. */
export function generateEndlessVersion(version: number, endlessSeed: bigint, tier: number, number: number): EndlessPuzzle {
  switch (version) {
    case GENERATOR_CLASSIC: return generateEndless(endlessSeed, tier, number);
    case GENERATOR_GRADED: return generateEndlessV2(endlessSeed, tier, number).puzzle;
    default: throw new RangeError(`unknown generator version: ${version}`);
  }
}
