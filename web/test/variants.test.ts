import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CELLS, peers } from "../src/core/geometry.ts";
import {
  type Cage, DIAGONALS, Layout, VARIANTS, VARIANT_DIAGONAL, VARIANT_JIGSAW, VARIANT_KILLER, VARIANT_STANDARD, isVariant, variantName,
} from "../src/core/layout.ts";
import { removeCells } from "../src/generator/generator.ts";
import { CAGE_TECHNIQUES, Grader, KILLER_TECHNIQUES, TECHNIQUES, grade, techniquesFor } from "../src/generator/grader.ts";
import { ABORTED, cageDigits, countSolutionsIn, hasUniqueSolutionIn, randomSolutionIn } from "../src/generator/layout-solver.ts";
import { Xoshiro256StarStar } from "../src/generator/random.ts";
import { randomSolution } from "../src/generator/solver.ts";
import {
  FALLBACK_JIGSAWS, GRADED_GIVENS, KILLER_CAGES, VariantPuzzle, buildClassicVariant, buildGradedVariant, carveCages, generateEndlessVariant, jigsawLayout, relabel,
  removeCellsIn, reshapeRegions, variantPuzzleSeed,
} from "../src/generator/variants.ts";
import { generateEndlessVersion } from "../src/generator/versions.ts";
import { formatWeekSeed, parseWeekSeed } from "../src/generator/week-seed.ts";

interface LayoutCase {
  variant: number;
  regions?: string;
  cages?: Cage[];
}
interface Fixture {
  techniques: string[];
  killerTechniques: string[];
  puzzles: (LayoutCase & { generator: number; seed: string; tier: number; number: number; puzzleSeed: string; givens: string; solution: string; gradeLevel?: number })[];
  jigsaws: { seed: string; maxAttempts: number; regions: string; solution: string; attempts: number; fallback: boolean }[];
  cages: { tier: number; solution: string; seed: string; cages: Cage[] }[];
  classic: (LayoutCase & { seed: string; tier: number; givens: string; solution: string; attempts: number })[];
  fallback: (LayoutCase & { seed: string; tier: number; maxAttempts: number; givens: string; solution: string; gradeLevel: number; attempts: number })[];
  solver: (LayoutCase & { givens: string; nodeLimit: number; count: number })[];
  grader: (LayoutCase & { givens: string; solved: boolean; level: number; steps: number; counts: number[] })[];
}

// Shared with the server's Go tests (server/internal/puzzle/variants_test.go).
const fixture = JSON.parse(readFileSync(new URL("../../testdata/variants.json", import.meta.url), "utf8")) as Fixture;
const digits = (s: string): number[] => [...s].map(Number);
const empty = (): number[] => new Array<number>(CELLS).fill(0);

function layoutOf(c: LayoutCase): Layout {
  switch (c.variant) {
    case VARIANT_DIAGONAL: return Layout.DIAGONAL;
    case VARIANT_JIGSAW: return Layout.jigsaw(digits(c.regions!));
    case VARIANT_KILLER: return Layout.killer(c.cages!);
    default: return Layout.STANDARD;
  }
}

function connected(layout: Layout, g: number): boolean {
  const cells = layout.units[18 + g]!;
  const seen = new Set([cells[0]!]);
  const stack = [cells[0]!];
  while (stack.length > 0) {
    const v = stack.pop()!;
    for (const w of [v - 9, v + 9, v % 9 > 0 ? v - 1 : -1, v % 9 < 8 ? v + 1 : -1]) {
      if (cells.includes(w) && !seen.has(w)) {
        seen.add(w);
        stack.push(w);
      }
    }
  }
  return seen.size === 9;
}

test("fixture technique names match the grader's", () => {
  assert.deepEqual(fixture.techniques, TECHNIQUES.map((t) => t.name));
  assert.deepEqual(fixture.killerTechniques, KILLER_TECHNIQUES.map((t) => t.name));
  assert.equal(techniquesFor(Layout.DIAGONAL), TECHNIQUES);
  assert.equal(techniquesFor(Layout.killer(fixture.cages[0]!.cages)), KILLER_TECHNIQUES);
  assert.deepEqual(CAGE_TECHNIQUES.map((t) => [t.name, t.level]), [["cageCombination", 2], ["rule45", 3], ["cagePointing", 5], ["rule45Lines", 6]]);
});

test("fixture puzzles: every generator, variant and tier", () => {
  const seen = new Set<string>();
  for (const c of fixture.puzzles) {
    const at = `g${c.generator} v${c.variant} ${c.seed} tier ${c.tier} #${c.number}`;
    const seed = parseWeekSeed(c.seed);
    assert.equal(formatWeekSeed(variantPuzzleSeed(c.generator, c.variant, seed, c.tier, c.number)), c.puzzleSeed, at);
    const p = generateEndlessVariant(c.generator, c.variant, seed, c.tier, c.number);
    assert.ok(p instanceof VariantPuzzle);
    assert.deepEqual([p.givens, p.solution], [c.givens, c.solution], at);
    assert.deepEqual([p.generator, p.variant, p.tier, p.number, p.seed], [c.generator, c.variant, c.tier, c.number, seed]);
    const want = layoutOf(c);
    assert.deepEqual([p.layout.variant, p.layout.regions, p.layout.diagonals, p.layout.cages], [want.variant, want.regions, want.diagonals, want.cages], at);
    const solution = digits(c.solution);
    assert.ok(p.layout.isValid(solution) && !solution.includes(0), at);
    assert.ok(digits(c.givens).every((d, i) => d === 0 || d === solution[i]), at);
    if (c.generator === 2) assert.equal(grade(digits(c.givens), p.layout).level, c.gradeLevel, at);
    if (c.variant === VARIANT_STANDARD) {
      const std = generateEndlessVersion(c.generator, seed, c.tier, c.number);
      assert.deepEqual([p.givens, p.solution], [std.givens, std.solution]);
      assert.equal(p.layout, Layout.STANDARD);
    }
    seen.add(`${c.generator}/${c.variant}/${c.tier}`);
  }
  assert.equal(seen.size, 2 * VARIANTS.length * 5);
});

test("fixture jigsaw layouts, including every fallback", () => {
  for (const c of fixture.jigsaws) {
    const j = jigsawLayout(parseWeekSeed(c.seed), c.maxAttempts);
    assert.deepEqual([j.layout.regions.join(""), j.solution.join(""), j.attempts, j.fallback], [c.regions, c.solution, c.attempts, c.fallback], c.seed);
    assert.ok(j.layout.isValid(j.solution));
    for (let g = 0; g < 9; g++) assert.ok(connected(j.layout, g), `${c.seed} region ${g}`);
  }
  assert.equal(fixture.jigsaws.filter((c) => c.fallback).length, FALLBACK_JIGSAWS.length);
  assert.ok(fixture.jigsaws.some((c) => c.attempts > 1 && !c.fallback));
});

test("fixture killer cages", () => {
  for (const c of fixture.cages) {
    const cages = carveCages(digits(c.solution), new Xoshiro256StarStar(parseWeekSeed(c.seed)), KILLER_CAGES[c.tier - 1]!);
    assert.deepEqual(cages, c.cages);
    assert.ok(Layout.killer(cages).isValid(digits(c.solution)));
    assert.ok(cages.every((cage) => cage.cells.length <= KILLER_CAGES[c.tier - 1]!.maxSize));
  }
});

test("fixture Classic builds that retried", () => {
  for (const c of fixture.classic) {
    const b = buildClassicVariant(parseWeekSeed(c.seed), c.variant, c.tier);
    assert.deepEqual([b.givens, b.solution, b.grade, b.attempts], [c.givens, c.solution, null, c.attempts], c.seed);
    assert.deepEqual(b.layout.cages, layoutOf(c).cages);
    assert.ok(c.attempts > 1);
  }
});

test("fixture forced fallbacks of Graded variants", () => {
  for (const c of fixture.fallback) {
    const b = buildGradedVariant(parseWeekSeed(c.seed), c.variant, c.tier, c.maxAttempts);
    assert.deepEqual([b.givens, b.solution, b.grade!.level, b.attempts], [c.givens, c.solution, c.gradeLevel, c.attempts], c.seed);
    assert.deepEqual([b.layout.regions, b.layout.cages], [layoutOf(c).regions, layoutOf(c).cages]);
  }
});

test("fixture solver counts, including aborted searches", () => {
  for (const c of fixture.solver) assert.equal(countSolutionsIn(layoutOf(c), digits(c.givens), 2, c.nodeLimit), c.count, c.givens);
  assert.ok(fixture.solver.some((c) => c.count === ABORTED));
});

test("fixture grader cases", () => {
  const killerUsed = new Set<number>();
  for (const c of fixture.grader) {
    const g = grade(digits(c.givens), layoutOf(c));
    assert.deepEqual({ solved: g.solved, level: g.level, steps: g.steps, counts: g.counts }, { solved: c.solved, level: c.level, steps: c.steps, counts: c.counts });
    if (c.variant === VARIANT_KILLER) g.counts.forEach((n, t) => n > 0 && killerUsed.add(t));
  }
  for (const name of CAGE_TECHNIQUES.map((t) => t.name)) assert.ok(killerUsed.has(KILLER_TECHNIQUES.findIndex((t) => t.name === name)), name);
});

test("variants and their names", () => {
  assert.deepEqual(VARIANTS.map(variantName), ["Standard", "Diagonal", "Jigsaw", "Killer"]);
  assert.equal(variantName(9), "Variant 9");
  assert.ok(isVariant(3) && !isVariant(4) && !isVariant(-1));
});

test("layouts: units, peers and checks", () => {
  assert.equal(Layout.STANDARD.units.length, 27);
  assert.equal(Layout.DIAGONAL.units.length, 29);
  assert.deepEqual(Layout.DIAGONAL.units.slice(27), DIAGONALS);
  assert.deepEqual(DIAGONALS, [[0, 10, 20, 30, 40, 50, 60, 70, 80], [8, 16, 24, 32, 40, 48, 56, 64, 72]]);
  assert.deepEqual(Layout.STANDARD.peers, peers);
  assert.equal(Layout.DIAGONAL.peers[40]!.length, 32);
  assert.ok(Layout.STANDARD.cageOf.every((k) => k === -1));
  assert.throws(() => Layout.jigsaw(new Array(80).fill(0)), RangeError);
  assert.throws(() => Layout.jigsaw([9, ...Layout.STANDARD.regions.slice(1)]), RangeError);
  assert.throws(() => Layout.jigsaw([1, ...Layout.STANDARD.regions.slice(1)]), RangeError);
  const whole = Array.from({ length: CELLS }, (_, i) => i);
  assert.throws(() => Layout.killer([{ cells: [], sum: 0 }]), RangeError);
  assert.throws(() => Layout.killer([{ cells: [81], sum: 1 }]), RangeError);
  assert.throws(() => Layout.killer([{ cells: [0, 0], sum: 1 }]), RangeError);
  assert.throws(() => Layout.killer([{ cells: [0], sum: 1 }]), RangeError);
  const k = Layout.killer([{ cells: whole.slice(9), sum: 360 }, { cells: [8, 7, 6, 5, 4, 3, 2, 1, 0], sum: 45 }]);
  assert.deepEqual([k.cages[0]!.cells[0], k.cageOf[80], k.peers[0]!.length, k.peers[9]!.length], [0, 1, 20, 74]);
  const full = digits("123456789456789123789123456214365897365897214897214365531642978642978531978531642");
  assert.ok(Layout.STANDARD.isValid(full) && !Layout.DIAGONAL.isValid(full));
  const apart = Layout.killer([{ cells: [0, 13], sum: 3 }, { cells: [...whole.slice(1, 13), ...whole.slice(14)], sum: 402 }]);
  assert.ok(!apart.isValid(full));
  const part = empty();
  part[0] = 1;
  part[13] = 1;
  assert.ok(!apart.isValid(part));
  part[13] = 2;
  assert.ok(apart.isValid(part));
});

test("layout solver edges", () => {
  assert.throws(() => countSolutionsIn(Layout.DIAGONAL, empty(), 0), RangeError);
  assert.throws(() => countSolutionsIn(Layout.DIAGONAL, new Array(80).fill(0)), RangeError);
  assert.throws(() => countSolutionsIn(Layout.DIAGONAL, [10, ...new Array(80).fill(0)]), RangeError);
  const clash = empty();
  clash[0] = 5;
  clash[10] = 5;
  assert.equal(countSolutionsIn(Layout.DIAGONAL, clash), 0);
  assert.equal(randomSolutionIn(Layout.DIAGONAL, clash, new Xoshiro256StarStar(1n)), null);
  assert.equal(randomSolutionIn(Layout.DIAGONAL, empty(), new Xoshiro256StarStar(1n), 3), null);
  const whole = Array.from({ length: CELLS }, (_, i) => i);
  const over = Layout.killer([{ cells: [0, 1], sum: 3 }, { cells: whole.slice(2), sum: 402 }]);
  const g = empty();
  g[0] = 5;
  assert.equal(countSolutionsIn(over, g, 1, 100), 0);
  assert.deepEqual([cageDigits(1, -1, 0), cageDigits(1, 46, 0), cageDigits(2, 3, 0)], [0, 0, 3]);
  // A standard layout searched by the layout solver agrees with solver.ts.
  const sol = randomSolution(empty(), new Xoshiro256StarStar(5n))!;
  assert.ok(hasUniqueSolutionIn(Layout.STANDARD, removeCells(sol, 30, new Xoshiro256StarStar(6n)), Number.MAX_SAFE_INTEGER));
});

test("generateEndlessVariant checks its arguments", () => {
  for (const [generator, variant, tier, number] of [
    [1, -1, 1, 1], [1, 4, 1, 1], [3, 0, 1, 1], [1, 1, 0, 1], [1, 1, 6, 1], [1, 1, 1.5, 1], [1, 1, 1, 0], [1, 1, 1, Number.MAX_SAFE_INTEGER + 1], [3, 1, 1, 1],
  ] as const) {
    assert.throws(() => generateEndlessVariant(generator, variant, 1n, tier, number), RangeError, `${generator} ${variant} ${tier} ${number}`);
  }
});

test("reshaped regions stay connected nine-cell regions", () => {
  const random = new Xoshiro256StarStar(3n);
  for (let n = 0; n < 20; n++) {
    const layout = Layout.jigsaw(reshapeRegions(random));
    for (let g = 0; g < 9; g++) assert.ok(connected(layout, g));
  }
  assert.deepEqual(reshapeRegions(new Xoshiro256StarStar(3n), 0), Layout.STANDARD.regions);
});

test("relabelled solutions stay valid", () => {
  const j = jigsawLayout(11n);
  const r = relabel(j.solution, new Xoshiro256StarStar(2n));
  assert.ok(j.layout.isValid(r));
  assert.notDeepEqual(r, j.solution);
});

test("every grader step under a variant places a true digit and never removes a true candidate", () => {
  const random = new Xoshiro256StarStar(4711n);
  for (let n = 0; n < 45; n++) {
    const variant = 1 + (n % 3);
    const tier = 1 + (n % 5);
    let layout: Layout;
    let solution: number[];
    if (variant === VARIANT_DIAGONAL) {
      layout = Layout.DIAGONAL;
      solution = randomSolutionIn(layout, empty(), random, Number.MAX_SAFE_INTEGER)!;
    } else if (variant === VARIANT_JIGSAW) {
      const j = jigsawLayout(BigInt(n));
      layout = j.layout;
      solution = j.solution;
    } else {
      solution = randomSolution(empty(), random)!;
      layout = Layout.killer(carveCages(solution, random, KILLER_CAGES[tier - 1]!));
    }
    const grader = new Grader(removeCellsIn(layout, solution, GRADED_GIVENS[variant]![tier - 1]!, random), layout);
    while (grader.step() >= 0) {
      for (let i = 0; i < CELLS; i++) {
        if (grader.grid[i] !== 0) assert.equal(grader.grid[i], solution[i]);
        else assert.ok((grader.cand[i]! & (1 << (solution[i]! - 1))) !== 0, `variant ${variant}: true candidate removed at ${i}`);
      }
    }
  }
});
