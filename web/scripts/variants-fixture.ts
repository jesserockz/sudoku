/**
 * Regenerates `testdata/variants.json`, the golden fixture of the variant
 * engine shared by the web tests (`test/variants.test.ts`) and the server's
 * Go tests (`server/internal/puzzle/variants_test.go`).
 *
 *   node scripts/variants-fixture.ts
 *
 * The TypeScript engine is the reference: this script records its output,
 * and the Go port must match it. Regenerating is only right when a change to
 * the variant engine is intentional.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CELLS } from "../src/core/geometry.ts";
import { type Cage, Layout, VARIANT_DIAGONAL, VARIANT_JIGSAW, VARIANT_KILLER } from "../src/core/layout.ts";
import { KILLER_TECHNIQUES, TECHNIQUES, grade } from "../src/generator/grader.ts";
import { countSolutionsIn, randomSolutionIn } from "../src/generator/layout-solver.ts";
import { Xoshiro256StarStar } from "../src/generator/random.ts";
import { randomSolution } from "../src/generator/solver.ts";
import {
  GRADED_GIVENS, KILLER_CAGES, buildClassicVariant, buildGradedVariant, cagesPlayable, carveCages, dailyVariantRound, generateDailyVariant, generateEndlessVariant, jigsawLayout, relabel, removeCellsIn, variantPuzzleSeed,
} from "../src/generator/variants.ts";
import { formatWeekSeed, parseWeekSeed } from "../src/generator/week-seed.ts";

const OUT = fileURLToPath(new URL("../../testdata/variants.json", import.meta.url));

const str = (cells: readonly number[]): string => cells.join("");
const layoutJson = (layout: Layout): { regions?: string; cages?: readonly Cage[] } =>
  layout.variant === VARIANT_JIGSAW ? { regions: str(layout.regions) } : layout.variant === VARIANT_KILLER ? { cages: layout.cages } : {};

/** Every generator x variant x tier, two numbers each, plus variant 0 (which must be the standard series). */
const puzzles = ([[1, "9f2c4a1b7e30d5c8"], [2, "0123456789abcdef"]] as const).flatMap(([generator, seed]) =>
  [0, 1, 2, 3].flatMap((variant) =>
    [1, 2, 3, 4, 5].flatMap((tier) =>
      (variant === 0 ? [7] : [1, tier * 1000 + 3]).map((number) => {
        const p = generateEndlessVariant(generator, variant, parseWeekSeed(seed), tier, number);
        return {
          generator, variant, seed, tier, number, puzzleSeed: formatWeekSeed(variantPuzzleSeed(generator, variant, parseWeekSeed(seed), tier, number)),
          givens: p.givens, solution: p.solution, ...layoutJson(p.layout),
          ...(generator === 2 ? { gradeLevel: grade([...p.givens].map(Number), p.layout).level } : {}),
        };
      }),
    ),
  ),
);

/** The variant of the day, in both versions: every day of two weeks, between them all three variants and both tiers of each. */
const daily = ([1, 2] as const).flatMap((version) =>
  (["9f2c4a1b7e30d5c8", "0123456789abcdef"] as const).flatMap((seed) =>
    [1, 2, 3, 4, 5, 6, 7].map((day) => {
      const d = generateDailyVariant(parseWeekSeed(seed), day, version);
      return {
        version, weekSeed: seed, day, puzzleSeed: formatWeekSeed(dailyVariantRound(parseWeekSeed(seed), day, version).seed), variant: d.variant, tier: d.tier,
        givens: d.givens, solution: d.solution, ...layoutJson(d.layout), gradeLevel: grade([...d.givens].map(Number), d.layout).level,
      };
    }),
  ),
);

/** Jigsaw layouts: generated ones, and the fallback list (`maxAttempts` 0) for each `seed mod 4`. */
const jigsaws = [
  ...[1n, 2n, 3n, 0xdeadbeefn, 0xffffffffffffffffn].map((seed) => [seed, 16] as const),
  ...[4n, 5n, 6n, 7n].map((seed) => [seed, 0] as const),
].map(([seed, maxAttempts]) => {
  const j = jigsawLayout(seed, maxAttempts);
  return { seed: formatWeekSeed(seed), maxAttempts, regions: str(j.layout.regions), solution: str(j.solution), attempts: j.attempts, fallback: j.fallback };
});
// One that needed more than one attempt.
for (let s = 100n; ; s++) {
  const j = jigsawLayout(s);
  if (j.attempts < 2) continue;
  jigsaws.push({ seed: formatWeekSeed(s), maxAttempts: 16, regions: str(j.layout.regions), solution: str(j.solution), attempts: j.attempts, fallback: j.fallback });
  break;
}

/** Cages carved over a fixed grid with each tier's policy. */
const cageRandom = new Xoshiro256StarStar(777n);
const cageSolution = randomSolution(new Array<number>(CELLS).fill(0), cageRandom)!;
const cages = [
  ...KILLER_CAGES.map((policy, i) => ({ seed: BigInt(i + 1), policy })),
  // Singletons joining a cage of any size (3 to 3 cells), and one that no cage can take (kept: unplayable).
  { seed: 1n, policy: { minSize: 3, maxSize: 3 } },
  { seed: 4n, policy: { minSize: 1, maxSize: 1 } },
].map(({ seed, policy }) => ({ ...policy, solution: str(cageSolution), seed: formatWeekSeed(seed), cages: carveCages(cageSolution, new Xoshiro256StarStar(seed), policy) }));

/** Classic builds that needed more than one attempt (the first missed its target, or Killer cages were left with fewer than two empty cells). */
const classic = ([[VARIANT_KILLER, 5], [VARIANT_KILLER, 4], [VARIANT_KILLER, 1]] as const).map(([variant, tier]) => {
  for (let n = 1; ; n++) {
    const seed = variantPuzzleSeed(1, variant, 4242n, tier, n);
    const b = buildClassicVariant(seed, variant, tier);
    if (b.attempts < 2) continue;
    return { seed: formatWeekSeed(seed), variant, tier, maxAttempts: 8, givens: b.givens, solution: b.solution, ...layoutJson(b.layout), attempts: b.attempts };
  }
});

/** Classic Killer builds whose every attempt is unplayable (three allowed): the one with the fewest givens is kept. */
const classicUnplayable = ([1, 2] as const).map((tier) => {
  for (let n = 1; ; n++) {
    const seed = variantPuzzleSeed(1, VARIANT_KILLER, 4242n, tier, n);
    const b = buildClassicVariant(seed, VARIANT_KILLER, tier, 3);
    if (cagesPlayable(b.layout, [...b.givens].map(Number))) continue;
    return { seed: formatWeekSeed(seed), variant: VARIANT_KILLER as number, tier, maxAttempts: 3, givens: b.givens, solution: b.solution, ...layoutJson(b.layout), attempts: b.attempts };
  }
});

/** Forced fallbacks of a Graded variant build: a small `maxAttempts`. */
const fallback = ([[VARIANT_DIAGONAL, 4, 1], [VARIANT_DIAGONAL, 2, 3], [VARIANT_JIGSAW, 4, 2], [VARIANT_KILLER, 5, 2], [VARIANT_KILLER, 4, 1]] as const).map(([variant, tier, maxAttempts]) => {
  const seed = variantPuzzleSeed(2, variant, 4242n, tier, 1);
  const b = buildGradedVariant(seed, variant, tier, maxAttempts);
  return { seed: formatWeekSeed(seed), variant, tier, maxAttempts, givens: b.givens, solution: b.solution, ...layoutJson(b.layout), gradeLevel: b.grade!.level, attempts: b.attempts };
});

(classic as object[]).push(...classicUnplayable);

/** Graded Killer builds whose every attempt is unplayable (three allowed). */
const fallbackUnplayable = ([1, 2] as const).map((tier) => {
  for (let n = 1; ; n++) {
    const seed = variantPuzzleSeed(2, VARIANT_KILLER, 4242n, tier, n);
    const b = buildGradedVariant(seed, VARIANT_KILLER, tier, 3);
    if (cagesPlayable(b.layout, [...b.givens].map(Number))) continue;
    return { seed: formatWeekSeed(seed), variant: VARIANT_KILLER as number, tier, maxAttempts: 3, givens: b.givens, solution: b.solution, ...layoutJson(b.layout), gradeLevel: b.grade!.level, attempts: b.attempts };
  }
});
(fallback as object[]).push(...fallbackUnplayable);

/**
 * Graded variant builds with `untilSolvable`, whose first attempt (`maxAttempts` 1) is stuck or unplayable so more
 * attempts are made: the number is the one of `variantPuzzleSeed(2, variant, 4242n, tier, number)`.
 */
const untilSolvable = ([[VARIANT_KILLER, 3, 6], [VARIANT_KILLER, 3, 30], [VARIANT_DIAGONAL, 4, 5], [VARIANT_JIGSAW, 4, 36], [VARIANT_KILLER, 5, 2]] as const).map(([variant, tier, n]) => {
  const seed = variantPuzzleSeed(2, variant, 4242n, tier, n);
  const b = buildGradedVariant(seed, variant, tier, 1, true);
  return { seed: formatWeekSeed(seed), variant, tier, maxAttempts: 1, givens: b.givens, solution: b.solution, ...layoutJson(b.layout), gradeLevel: b.grade!.level, attempts: b.attempts };
});

/** Solution counts with node budgets, including aborted searches. */
const solverCases = (() => {
  const random = new Xoshiro256StarStar(99n);
  const out: { variant: number; regions?: string; cages?: readonly Cage[]; givens: string; nodeLimit: number; count: number }[] = [];
  const jig = jigsawLayout(9n).layout;
  for (const layout of [Layout.DIAGONAL, jig]) {
    const sol = randomSolutionIn(layout, new Array<number>(CELLS).fill(0), random)!;
    const givens = removeCellsIn(layout, sol, 30, random);
    const loose = givens.map((d, i) => (i % 3 === 0 ? 0 : d));
    for (const [g, nodeLimit] of [[givens, 200000], [loose, 200000], [loose, 5], [new Array<number>(CELLS).fill(0), 50]] as const) {
      out.push({ variant: layout.variant, ...layoutJson(layout), givens: str(g), nodeLimit, count: countSolutionsIn(layout, g, 2, nodeLimit) });
    }
  }
  const sol = randomSolution(new Array<number>(CELLS).fill(0), random)!;
  const killer = Layout.killer(carveCages(sol, random, KILLER_CAGES[2]!));
  for (const [g, nodeLimit] of [[sol.map((d, i) => (i < 60 ? d : 0)), 200000], [new Array<number>(CELLS).fill(0), 1000]] as const) {
    out.push({ variant: VARIANT_KILLER, ...layoutJson(killer), givens: str(g), nodeLimit, count: countSolutionsIn(killer, g, 2, nodeLimit) });
  }
  return out;
})();

/**
 * Grader cases per variant: from a fixed stream of attempts (cells removed to
 * each tier's Graded target), every grid that uses a technique or reaches a
 * level not seen yet for its variant, until all are seen or the stream ends.
 */
const graderCases = (() => {
  const out: { variant: number; regions?: string; cages?: readonly Cage[]; givens: string; solved: boolean; level: number; steps: number; counts: number[] }[] = [];
  for (const variant of [VARIANT_DIAGONAL, VARIANT_JIGSAW, VARIANT_KILLER]) {
    const random = new Xoshiro256StarStar(20261116n + BigInt(variant));
    const levels = new Set<number>();
    const used = new Set<number>();
    const want = variant === VARIANT_KILLER ? KILLER_TECHNIQUES.length : TECHNIQUES.length;
    for (let n = 0; n < (variant === VARIANT_KILLER ? 600 : 1500) && (levels.size < 7 || used.size < want); n++) {
      const tier = (n % 5) + 1;
      let layout: Layout;
      let solution: number[];
      if (variant === VARIANT_DIAGONAL) {
        layout = Layout.DIAGONAL;
        solution = randomSolutionIn(layout, new Array<number>(CELLS).fill(0), random, Number.MAX_SAFE_INTEGER)!;
      } else if (variant === VARIANT_JIGSAW) {
        const j = jigsawLayout(BigInt(n));
        layout = j.layout;
        solution = relabel(j.solution, random);
      } else {
        solution = randomSolution(new Array<number>(CELLS).fill(0), random)!;
        layout = Layout.killer(carveCages(solution, random, KILLER_CAGES[tier - 1]!));
      }
      const givens = removeCellsIn(layout, solution, GRADED_GIVENS[variant]![tier - 1]! - (n % 3), random);
      const g = grade(givens, layout);
      if (levels.has(g.level) && g.counts.every((c, t) => c === 0 || used.has(t))) continue;
      levels.add(g.level);
      g.counts.forEach((c, t) => c > 0 && used.add(t));
      out.push({ variant, ...layoutJson(layout), givens: str(givens), solved: g.solved, level: g.level, steps: g.steps, counts: [...g.counts] });
    }
    const names = (variant === VARIANT_KILLER ? KILLER_TECHNIQUES : TECHNIQUES).map((t) => t.name);
    console.log(`variant ${variant}: levels ${[...levels].sort()} techniques missing: ${names.filter((_, t) => !used.has(t)).join(", ") || "none"}`);
  }
  return out;
})();

const lines = (items: object[]): string => `[\n${items.map((c) => `    ${JSON.stringify(c)}`).join(",\n")}\n  ]`;
const out = `{
  "techniques": ${JSON.stringify(TECHNIQUES.map((t) => t.name))},
  "killerTechniques": ${JSON.stringify(KILLER_TECHNIQUES.map((t) => t.name))},
  "puzzles": ${lines(puzzles)},
  "jigsaws": ${lines(jigsaws)},
  "cages": ${lines(cages)},
  "classic": ${lines(classic)},
  "fallback": ${lines(fallback)},
  "untilSolvable": ${lines(untilSolvable)},
  "daily": ${lines(daily)},
  "solver": ${lines(solverCases)},
  "grader": ${lines(graderCases)}
}
`;
writeFileSync(OUT, out);
console.log(`wrote ${OUT}: ${puzzles.length} puzzles, ${jigsaws.length} jigsaws, ${cages.length} cages, ${classic.length} classic, ${fallback.length} fallback, ${untilSolvable.length} untilSolvable, ${daily.length} daily, ${solverCases.length} solver, ${graderCases.length} grader`);
