import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DIFFICULTIES, GENERATOR_VERSION, endlessPuzzleSeed, puzzleSeed, removeCells } from "../src/generator/generator.ts";
import {
  BANDS, GENERATOR_V2_VERSION, MAX_ATTEMPTS_V2, buildV2, endlessPuzzleSeedV2, generateEndlessV2, generateV2, puzzleSeedV2,
} from "../src/generator/generator-v2.ts";
import { Grader, STUCK_LEVEL, TECHNIQUES, grade } from "../src/generator/grader.ts";
import { Xoshiro256StarStar } from "../src/generator/random.ts";
import { randomSolution } from "../src/generator/solver.ts";
import { formatWeekSeed, parseWeekSeed } from "../src/generator/week-seed.ts";

interface Fixture {
  techniques: string[];
  daily: { weekSeed: string; day: number; level: number; levels: number; givens: string; solution: string; gradeLevel: number; attempts: number }[];
  endless: { seed: string; tier: number; number: number; givens: string; solution: string; gradeLevel: number; attempts: number }[];
  fallback: { seed: string; tier: number; maxAttempts: number; givens: string; solution: string; gradeLevel: number; attempts: number; trace: number[] }[];
  grader: { givens: string; solved: boolean; level: number; steps: number; counts: number[] }[];
}

// Shared with the server's Go tests (server/internal/puzzle/v2_test.go).
const fixture = JSON.parse(readFileSync(new URL("../../testdata/generator-v2.json", import.meta.url), "utf8")) as Fixture;
const digits = (s: string): number[] => [...s].map(Number);

test("fixture technique names match the grader's", () => {
  assert.deepEqual(fixture.techniques, TECHNIQUES.map((t) => t.name));
});

test("fixture grader cases", () => {
  const levels = new Set<number>();
  const used = new Set<number>();
  for (const c of fixture.grader) {
    const g = grade(digits(c.givens));
    assert.deepEqual({ solved: g.solved, level: g.level, steps: g.steps, counts: g.counts }, { solved: c.solved, level: c.level, steps: c.steps, counts: c.counts });
    assert.equal(g.steps, g.counts.reduce((a, b) => a + b, 0));
    levels.add(g.level);
    g.counts.forEach((n, t) => n > 0 && used.add(t));
  }
  assert.deepEqual([...levels].sort(), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(used.size, TECHNIQUES.length);
});

test("fixture daily goldens", () => {
  for (const c of fixture.daily) {
    const at = `${c.weekSeed} day ${c.day} game ${c.level}/${c.levels}`;
    const r = generateV2(parseWeekSeed(c.weekSeed), c.day, c.level, c.levels);
    assert.equal(r.puzzle.givens, c.givens, `givens for ${at}`);
    assert.equal(r.puzzle.solution, c.solution, `solution for ${at}`);
    assert.equal(r.grade.level, c.gradeLevel, `level for ${at}`);
    assert.equal(r.attempts, c.attempts, `attempts for ${at}`);
    assert.deepEqual(grade(digits(c.givens)), r.grade);
  }
});

test("fixture endless goldens cover all five tiers", () => {
  assert.deepEqual([...new Set(fixture.endless.map((c) => c.tier))].sort(), [1, 2, 3, 4, 5]);
  for (const c of fixture.endless) {
    const at = `${c.seed} tier ${c.tier} #${c.number}`;
    const r = generateEndlessV2(parseWeekSeed(c.seed), c.tier, c.number);
    assert.equal(r.puzzle.givens, c.givens, `givens for ${at}`);
    assert.equal(r.puzzle.solution, c.solution, `solution for ${at}`);
    assert.equal(r.grade.level, c.gradeLevel, `level for ${at}`);
    assert.equal(r.attempts, c.attempts, `attempts for ${at}`);
    assert.equal(r.puzzle.difficulty, DIFFICULTIES[c.tier - 1]);
    assert.equal(r.puzzle.number, c.number);
  }
});

test("fixture forced-fallback goldens", () => {
  for (const c of fixture.fallback) {
    const r = buildV2(parseWeekSeed(c.seed), c.tier, c.maxAttempts);
    assert.equal(r.givens, c.givens);
    assert.equal(r.solution, c.solution);
    assert.equal(r.grade.level, c.gradeLevel);
    assert.equal(r.attempts, c.attempts);
    // The pattern of attempt levels is what exercises each fallback rule; the generator reaches the same ones.
    const band = BANDS[c.tier - 1]!;
    const inBand = (l: number): boolean => l >= band.minLevel && l <= band.maxLevel;
    assert.equal(inBand(r.grade.level), c.trace.some(inBand));
  }
  assert.ok(fixture.fallback.some((c) => c.trace.every((l) => l === STUCK_LEVEL)));
});

test("generated puzzles are valid, unique and graded in their band", () => {
  for (let tier = 1; tier <= 5; tier++) {
    for (let n = 1; n <= 4; n++) {
      const r = generateEndlessV2(0x1234n, tier, n);
      const solution = digits(r.puzzle.solution);
      const givens = digits(r.puzzle.givens);
      assert.ok(givens.every((d, i) => d === 0 || d === solution[i]));
      assert.ok(r.grade.solved);
      assert.deepEqual(grade(givens), r.grade);
      const band = BANDS[tier - 1]!;
      assert.ok(r.attempts < MAX_ATTEMPTS_V2);
      assert.ok(r.grade.level >= band.minLevel && r.grade.level <= band.maxLevel, `${band.name} #${n} graded ${r.grade.level}`);
    }
  }
});

test("v2 seeds use their own version and differ from v1", () => {
  assert.equal(GENERATOR_V2_VERSION, 2);
  assert.equal(GENERATOR_VERSION, 1);
  const seed = parseWeekSeed("9f2c4a1b7e30d5c8");
  assert.notEqual(puzzleSeedV2(seed, 1, 1), puzzleSeed(seed, 1, 1));
  assert.notEqual(endlessPuzzleSeedV2(seed, 1, 1), endlessPuzzleSeed(seed, 1, 1));
  assert.notEqual(formatWeekSeed(puzzleSeedV2(seed, 1, 1)), formatWeekSeed(puzzleSeedV2(seed, 1, 2)));
});

test("generateV2 and generateEndlessV2 check their arguments", () => {
  const seed = parseWeekSeed("9f2c4a1b7e30d5c8");
  for (const day of [0, 8, 1.5]) assert.throws(() => generateV2(seed, day, 1), RangeError);
  assert.throws(() => generateV2(seed, 1, 1, 11), RangeError);
  assert.throws(() => generateV2(seed, 1, 6, 5), RangeError);
  for (const tier of [0, 6, 1.5]) assert.throws(() => generateEndlessV2(seed, tier, 1), RangeError);
  for (const n of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => generateEndlessV2(seed, 1, n), RangeError);
  assert.equal(generateV2(seed, 1, 1, 1).puzzle.difficulty.name, "Hard");
});

test("bands accept the documented grader levels", () => {
  assert.deepEqual(BANDS.map((b) => [b.name, b.minLevel, b.maxLevel]), [
    ["Easy", 1, 1], ["Medium", 2, 2], ["Hard", 3, 4], ["Expert", 5, 5], ["Diabolical", 6, 6],
  ]);
  assert.deepEqual(BANDS.map((b) => b.name), DIFFICULTIES.map((d) => d.name));
});

test("the grader rejects malformed grids", () => {
  assert.throws(() => grade(new Array(80).fill(0)), RangeError);
  assert.throws(() => grade(new Array(81).fill(10)), RangeError);
  assert.throws(() => grade(new Array(81).fill(0.5)), RangeError);
});

test("an empty grid is stuck, a complete one needs no steps", () => {
  assert.deepEqual(grade(new Array(81).fill(0)), { solved: false, level: STUCK_LEVEL, steps: 0, counts: new Array(TECHNIQUES.length).fill(0) });
  const full = randomSolution(new Array<number>(81).fill(0), new Xoshiro256StarStar(5n))!;
  assert.deepEqual(grade(full), { solved: true, level: 0, steps: 0, counts: new Array(TECHNIQUES.length).fill(0) });
});

test("every grader step places a true digit and never removes a true candidate", () => {
  const random = new Xoshiro256StarStar(31337n);
  const used = new Set<number>();
  for (let n = 0; n < 250; n++) {
    const solution = randomSolution(new Array<number>(81).fill(0), random)!;
    const givens = removeCells(solution, [38, 30, 0, 0, 0][n % 5]!, random);
    const grader = new Grader(givens);
    for (;;) {
      const t = grader.step();
      if (t < 0) break;
      used.add(t);
      for (let i = 0; i < 81; i++) {
        if (grader.grid[i] !== 0) assert.equal(grader.grid[i], solution[i], `wrong placement at ${i}`);
        else assert.ok((grader.cand[i]! & (1 << (solution[i]! - 1))) !== 0, `true candidate removed at ${i} by ${TECHNIQUES[t]!.name}`);
      }
    }
  }
  assert.ok(used.size >= 12, `only ${used.size} techniques exercised`);
});
