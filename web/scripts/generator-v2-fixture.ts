/**
 * Regenerates `testdata/generator-v2.json`, the golden fixture shared by the
 * web tests (`test/generator-v2.test.ts`) and the server's Go tests
 * (`server/internal/puzzle/v2_test.go`).
 *
 *   node scripts/generator-v2-fixture.ts
 *
 * The TypeScript generator is the reference: this script records its output,
 * and the Go port must match it. Regenerating is only right when a change to
 * the grader or generator v2 is intentional.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CELLS } from "../src/core/geometry.ts";
import { removeCells } from "../src/generator/generator.ts";
import { BANDS, buildV2, endlessPuzzleSeedV2, generateEndlessV2, generateV2 } from "../src/generator/generator-v2.ts";
import { TECHNIQUES, grade } from "../src/generator/grader.ts";
import { Xoshiro256StarStar } from "../src/generator/random.ts";
import { randomSolution } from "../src/generator/solver.ts";
import { formatWeekSeed, parseWeekSeed } from "../src/generator/week-seed.ts";

const OUT = fileURLToPath(new URL("../../testdata/generator-v2.json", import.meta.url));

const daily = ([
  ["9f2c4a1b7e30d5c8", 1, 5],
  ["9f2c4a1b7e30d5c8", 4, 7],
  ["0123456789abcdef", 3, 3],
  ["0123456789abcdef", 7, 10],
  ["ffffffffffffffff", 2, 1],
] as const).flatMap(([seed, day, levels]) =>
  Array.from({ length: levels }, (_, i) => {
    const { puzzle, grade: g, attempts } = generateV2(parseWeekSeed(seed), day, i + 1, levels);
    return { weekSeed: seed, day, level: i + 1, levels, givens: puzzle.givens, solution: puzzle.solution, gradeLevel: g.level, attempts };
  }),
);

const endless = ([
  ["9f2c4a1b7e30d5c8", 1],
  ["9f2c4a1b7e30d5c8", 2],
  ["0123456789abcdef", 3],
  ["0123456789abcdef", 4],
  ["ffffffffffffffff", 5],
] as const).flatMap(([seed, tier]) =>
  [1, 2, tier * 1000, Number.MAX_SAFE_INTEGER].map((number) => {
    const { puzzle, grade: g, attempts } = generateEndlessV2(parseWeekSeed(seed), tier, number);
    return { seed, tier, number, givens: puzzle.givens, solution: puzzle.solution, gradeLevel: g.level, attempts };
  }),
);

/** The grader levels of the first `maxAttempts` attempts of buildV2 for a seed, replayed from the same random stream. */
function trace(seed: bigint, tier: number, maxAttempts: number): number[] {
  const random = new Xoshiro256StarStar(seed);
  return Array.from({ length: maxAttempts }, () => {
    const solution = randomSolution(new Array<number>(CELLS).fill(0), random)!;
    return grade(removeCells(solution, BANDS[tier - 1]!.targetGivens, random)).level;
  });
}

/** Forced fallbacks: a small maxAttempts so no attempt (or only a late one) lands in the band. Each pattern is a tier and the levels the attempts reach. */
const fallbackPatterns: [tier: number, levels: number[]][] = [
  [5, [2]], // one attempt, far from the band
  [4, [7]], // one attempt, stuck
  [3, [5, 2]], // equal distance from Hard: the easier one wins
  [3, [2, 5]], // equal distance: the earlier (easier) one stays
  [4, [7, 7]], // every attempt stuck: the earliest
  [4, [7, 6]], // a stuck attempt is replaced by a non-stuck one
  [4, [6, 7]], // a non-stuck attempt is kept over a stuck one
  [5, [3, 4]], // nearer the band replaces
  [5, [4, 3]], // farther from the band does not replace
  [5, [3, 3]], // an equal attempt does not replace
  [1, [2, 3, 1]], // the last of three attempts is the first in band
];
const fallback = fallbackPatterns.map(([tier, levels]) => {
  for (let n = 1; ; n++) {
    const seed = endlessPuzzleSeedV2(4242n, tier, n);
    const got = trace(seed, tier, levels.length);
    if (got.join() !== levels.join()) continue;
    const r = buildV2(seed, tier, levels.length);
    return { seed: formatWeekSeed(seed), tier, maxAttempts: levels.length, givens: r.givens, solution: r.solution, gradeLevel: r.grade.level, attempts: r.attempts, trace: levels };
  }
});

/** Grader cases: one grid per level 0..7 and per technique (the first found that uses it), from a fixed stream of puzzles. */
const random = new Xoshiro256StarStar(20260101n);
const cases: { givens: string }[] = [];
const seenLevels = new Set<number>();
const seenTechniques = new Set<number>();
const full = randomSolution(new Array<number>(CELLS).fill(0), random)!.join("");
cases.push({ givens: full });
seenLevels.add(0);
for (let n = 0; seenLevels.size < 8 || seenTechniques.size < TECHNIQUES.length; n++) {
  if (n > 200000) throw new Error("grader coverage not reached");
  const solution = randomSolution(new Array<number>(CELLS).fill(0), random)!;
  const givens = removeCells(solution, [38, 30, 0, 0][n % 4]!, random);
  const g = grade(givens);
  const fresh = g.counts.some((c, t) => c > 0 && !seenTechniques.has(t)) || !seenLevels.has(g.level);
  if (!fresh) continue;
  g.counts.forEach((c, t) => c > 0 && seenTechniques.add(t));
  seenLevels.add(g.level);
  cases.push({ givens: givens.join("") });
}
const grader = cases.map(({ givens }) => {
  const g = grade([...givens].map(Number));
  return { givens, solved: g.solved, level: g.level, steps: g.steps, counts: g.counts };
});

const lines = (items: object[]): string => `[\n${items.map((c) => `    ${JSON.stringify(c)}`).join(",\n")}\n  ]`;
const out = `{
  "techniques": ${JSON.stringify(TECHNIQUES.map((t) => t.name))},
  "daily": ${lines(daily)},
  "endless": ${lines(endless)},
  "fallback": ${lines(fallback)},
  "grader": ${lines(grader)}
}
`;
writeFileSync(OUT, out);
console.log(`wrote ${OUT}: ${daily.length} daily, ${endless.length} endless, ${fallback.length} fallback, ${grader.length} grader`);
