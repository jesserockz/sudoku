import { CELLS, SIZE, colOf, rowOf } from "../core/geometry.ts";
import { BOX_REGIONS, type Cage, Layout, VARIANT_DIAGONAL, VARIANT_JIGSAW, VARIANT_KILLER, VARIANT_STANDARD, isVariant } from "../core/layout.ts";
import { DIFFICULTIES, EndlessPuzzle, MAX_ATTEMPTS, MAX_ENDLESS_NUMBER, endlessPuzzleSeed, isEndlessNumber } from "./generator.ts";
import { BANDS, endlessPuzzleSeedV2 } from "./generator-v2.ts";
import { type Grade, STUCK_LEVEL, grade } from "./grader.ts";
import { hasUniqueSolutionIn, randomSolutionIn } from "./layout-solver.ts";
import { SplitMix64, Xoshiro256StarStar } from "./random.ts";
import { randomSolution } from "./solver.ts";
import { GENERATOR_CLASSIC, GENERATOR_GRADED, generateEndlessVersion } from "./versions.ts";

/**
 * Endless puzzles of the Sudoku variants (Diagonal, Jigsaw, Killer).
 *
 * A puzzle is named `(generator, variant, tier, number)`. Variant 0 is
 * standard Sudoku and is exactly the existing endless series
 * ({@link generateEndlessVersion}). Every other variant is a pure function of
 * the endless seed and those four numbers, bit-identical in the Go port
 * (`server/internal/puzzle/variants.go`); the shared fixture
 * `testdata/variants.json` pins both.
 *
 * Generation follows the standard generators with the variant's rules:
 * - Classic: clue-count tiers. Diagonal and Jigsaw remove cells (keeping a
 *   unique solution under the variant's units) to 40/36/32/28/24 givens;
 *   Killer to {@link KILLER_GIVENS}, with cages from {@link KILLER_CAGES}.
 *   Up to {@link MAX_ATTEMPTS} attempts, the one with the fewest givens wins.
 * - Graded: the grader (`grader.ts`) under the variant's layout, the tiers'
 *   bands of `generator-v2.ts` (removal targets {@link GRADED_GIVENS}), up
 *   to {@link MAX_ATTEMPTS_VARIANT_GRADED} attempts and the same fallback as
 *   generator v2.
 */

/** "variant" in ASCII: mixed into the endless puzzle seed for variants other than 0. */
export const VARIANT_DOMAIN = 0x76617269616e74n;
/** "jigsaw" in ASCII: the derivation of a jigsaw puzzle's region layout from its puzzle seed. */
export const JIGSAW_DOMAIN = 0x6a6967736177n;
/** Layouts tried for a jigsaw puzzle before taking one of {@link FALLBACK_JIGSAWS}. */
export const MAX_JIGSAW_ATTEMPTS = 16;
/** Moves tried when reshaping the boxes into jigsaw regions. */
export const JIGSAW_MOVES = 600;
/** The node budget of the search for a jigsaw layout's first solution: a layout that needs more is rejected. */
export const JIGSAW_NODES = 2000;
/** The node budget of each uniqueness check while removing cells: a check over budget keeps the cell. */
export const REMOVAL_NODES = 3000;
/** Attempts of a Graded puzzle, per variant (0..3), before settling for the closest-to-band one. Killer attempts cost more. */
export const MAX_ATTEMPTS_VARIANT_GRADED: readonly number[] = [200, 200, 200, 30];
/**
 * Graded: the givens each tier (Easy to Diabolical) removes down to, per
 * variant (0..3; 0 is generator v2's {@link BANDS}). Chosen by measuring how
 * often an attempt lands in the tier's band: a minimal Diagonal or Jigsaw
 * puzzle is mostly beyond the grader, and Killer needs some givens to stay
 * gradable.
 */
export const GRADED_GIVENS: readonly (readonly number[])[] = [
  BANDS.map((b) => b.targetGivens),
  [38, 26, 25, 23, 24],
  [38, 25, 24, 24, 23],
  [44, 24, 6, 3, 3],
];

/** The cage sizes of a killer tier: each cage aims for a size drawn from `minSize..maxSize`. */
export interface CagePolicy {
  readonly minSize: number;
  readonly maxSize: number;
}

/** Cage sizes per tier (Easy to Diabolical), both generators: bigger cages are harder. */
export const KILLER_CAGES: readonly CagePolicy[] = [
  { minSize: 1, maxSize: 3 },
  { minSize: 2, maxSize: 3 },
  { minSize: 2, maxSize: 4 },
  { minSize: 2, maxSize: 5 },
  { minSize: 3, maxSize: 5 },
];

/** Classic Killer: the givens each tier (Easy to Diabolical) removes down to. */
export const KILLER_GIVENS: readonly number[] = [24, 16, 10, 6, 5];

/**
 * Jigsaw layouts used, by puzzle seed (`seed mod 4`), only when
 * {@link MAX_JIGSAW_ATTEMPTS} generated layouts all fail:
 * each a region index per cell and a solution, as 81 characters.
 */
export const FALLBACK_JIGSAWS: readonly { readonly regions: string; readonly solution: string }[] = [
  { regions: "001111222000111522000011552333444552333444522363447555663477888677777788666668888", solution: "645379218927184635351826749184753926569218374793642581412967853238495167876531492" },
  { regions: "000011222033011122031111222034445552034444555333644855366678885667677788667777888", solution: "163459782512847693798213546954632871285791364376528419437986125649175238821364957" },
  { regions: "000411222000411222000411252334411255333441885333344855666778855666777885666777788", solution: "637258419541769238892134675356812794189347562724695381273481956415976823968523147" },
  { regions: "000002222030222212031111115033144815633348855633444855666644855666747885777777788", solution: "562481397379642518125836749758964123293157486946273851631598274487315962814729635" },
];

/** The seed of endless puzzle `number` of `tier` in `variant` with `generator`: the standard seed, then the variant mixed in (variants above 0 only). */
export function variantPuzzleSeed(generator: number, variant: number, endlessSeed: bigint, tier: number, number: number): bigint {
  let h: bigint;
  switch (generator) {
    case GENERATOR_CLASSIC: h = endlessPuzzleSeed(endlessSeed, tier, number); break;
    case GENERATOR_GRADED: h = endlessPuzzleSeedV2(endlessSeed, tier, number); break;
    default: throw new RangeError(`unknown generator version: ${generator}`);
  }
  if (variant === VARIANT_STANDARD) return h;
  return SplitMix64.mix(h ^ SplitMix64.mix(VARIANT_DOMAIN + BigInt(variant)));
}

/** The cell next to `i` in direction `dir` (0 up, 1 right, 2 down, 3 left), or -1 off the grid. */
function neighbour(i: number, dir: number): number {
  const r = rowOf(i) + [-1, 0, 1, 0][dir]!;
  const c = colOf(i) + [0, 1, 0, -1][dir]!;
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE ? r * SIZE + c : -1;
}

/** Whether the cells of region `g` are orthogonally connected. */
function connected(regions: readonly number[], g: number): boolean {
  const start = regions.indexOf(g);
  const seen = new Uint8Array(CELLS);
  const stack = [start];
  seen[start] = 1;
  let n = 0;
  while (stack.length > 0) {
    const v = stack.pop()!;
    n++;
    for (let dir = 0; dir < 4; dir++) {
      const w = neighbour(v, dir);
      if (w >= 0 && seen[w] === 0 && regions[w] === g) {
        seen[w] = 1;
        stack.push(w);
      }
    }
  }
  return n === SIZE;
}

/**
 * Reshapes the boxes into irregular regions: {@link JIGSAW_MOVES} tries, each
 * drawing a cell `a` and a direction (0 up, 1 right, 2 down, 3 left). If the
 * neighbour there is in another region B, a cell `c` drawn from the cells of
 * B (ascending) that touch `a`'s region A other than through `a` trades
 * places with `a`: `a` joins B and `c` joins A. A trade that leaves A or B not
 * orthogonally connected is undone. Every region keeps nine cells.
 */
export function reshapeRegions(random: Xoshiro256StarStar, moves = JIGSAW_MOVES): number[] {
  const regions = BOX_REGIONS.slice();
  const list: number[] = [];
  for (let m = 0; m < moves; m++) {
    const a = random.nextInt(CELLS);
    const b = neighbour(a, random.nextInt(4));
    if (b < 0 || regions[b] === regions[a]) continue;
    const ra = regions[a]!;
    const rb = regions[b]!;
    list.length = 0;
    for (let c = 0; c < CELLS; c++) {
      if (regions[c] !== rb) continue;
      for (let dir = 0; dir < 4; dir++) {
        const w = neighbour(c, dir);
        if (w >= 0 && w !== a && regions[w] === ra) {
          list.push(c);
          break;
        }
      }
    }
    if (list.length === 0) continue;
    const c = list[random.nextInt(list.length)]!;
    regions[a] = rb;
    regions[c] = ra;
    if (!connected(regions, ra) || !connected(regions, rb)) {
      regions[a] = ra;
      regions[c] = rb;
    }
  }
  return regions;
}

/** A jigsaw puzzle's layout with a solution grid for it, and how it was found. */
export interface JigsawLayout {
  readonly layout: Layout;
  /** A complete grid valid under the layout. */
  readonly solution: number[];
  /** Generated layouts tried. */
  readonly attempts: number;
  /** Whether it is one of {@link FALLBACK_JIGSAWS}. */
  readonly fallback: boolean;
}

/**
 * The region layout of a jigsaw puzzle, with a solution, from its puzzle
 * seed. Attempt `a` (from 0) seeds xoshiro256** with
 * `mix(mix(seed ^ JIGSAW_DOMAIN) + a)`, reshapes the boxes
 * ({@link reshapeRegions}) and looks for a first solution with candidates in
 * random order within {@link JIGSAW_NODES} search nodes (not every layout has
 * one). The first layout with a solution wins. After `maxAttempts` failures it
 * is {@link FALLBACK_JIGSAWS}`[seed mod 4]`.
 */
export function jigsawLayout(seed: bigint, maxAttempts = MAX_JIGSAW_ATTEMPTS): JigsawLayout {
  const base = SplitMix64.mix(seed ^ JIGSAW_DOMAIN);
  const empty = new Array<number>(CELLS).fill(0);
  for (let a = 0; a < maxAttempts; a++) {
    const random = new Xoshiro256StarStar(SplitMix64.mix(BigInt.asUintN(64, base + BigInt(a))));
    const layout = Layout.jigsaw(reshapeRegions(random));
    const solution = randomSolutionIn(layout, empty, random, JIGSAW_NODES);
    if (solution !== null) return { layout, solution, attempts: a + 1, fallback: false };
  }
  const fallback = FALLBACK_JIGSAWS[Number(seed % BigInt(FALLBACK_JIGSAWS.length))]!;
  return { layout: Layout.jigsaw([...fallback.regions].map(Number)), solution: [...fallback.solution].map(Number), attempts: maxAttempts, fallback: true };
}

/** `solution` with its digits renamed by a permutation drawn from `random` (still valid under any layout without cages). */
export function relabel(solution: readonly number[], random: Xoshiro256StarStar): number[] {
  const perm = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  random.shuffle(perm);
  return solution.map((d) => perm[d - 1]!);
}

/**
 * Killer cages over a solution grid. The cells are visited in an order drawn
 * from `random`; each unassigned one starts a cage that aims for a size drawn
 * from `minSize..maxSize` and grows one cell at a time, the cell drawn from
 * the unassigned cells (ascending) next to the cage whose digit is not in it
 * yet, until it reaches its size or cannot grow. Then each cage smaller than
 * `minSize`, in the order made, joins the first (in the order made) adjacent
 * cage it fits into: at most `maxSize` cells together and no repeated digit.
 */
export function carveCages(solution: readonly number[], random: Xoshiro256StarStar, policy: CagePolicy): Cage[] {
  const { minSize, maxSize } = policy;
  const cageOf = new Array<number>(CELLS).fill(-1);
  const cages: number[][] = [];
  const order = Array.from({ length: CELLS }, (_, i) => i);
  random.shuffle(order);
  const options: number[] = [];
  const touches = (c: number, k: number): boolean => {
    for (let dir = 0; dir < 4; dir++) {
      const w = neighbour(c, dir);
      if (w >= 0 && cageOf[w] === k) return true;
    }
    return false;
  };
  const digits = (k: number): number => cages[k]!.reduce((m, c) => m | (1 << solution[c]!), 0);
  for (const s of order) {
    if (cageOf[s] !== -1) continue;
    const k = cages.length;
    const size = minSize + random.nextInt(maxSize - minSize + 1);
    cages.push([s]);
    cageOf[s] = k;
    while (cages[k]!.length < size) {
      const used = digits(k);
      options.length = 0;
      for (let c = 0; c < CELLS; c++) if (cageOf[c] === -1 && (used & (1 << solution[c]!)) === 0 && touches(c, k)) options.push(c);
      if (options.length === 0) break;
      const c = options[random.nextInt(options.length)]!;
      cages[k]!.push(c);
      cageOf[c] = k;
    }
  }
  for (let k = 0; k < cages.length; k++) {
    const cage = cages[k]!;
    if (cage.length === 0 || cage.length >= minSize) continue;
    for (let j = 0; j < cages.length; j++) {
      const other = cages[j]!;
      if (j === k || other.length === 0 || other.length + cage.length > maxSize || (digits(j) & digits(k)) !== 0) continue;
      if (!cage.some((c) => touches(c, j))) continue;
      for (const c of cage) cageOf[c] = j;
      other.push(...cage);
      cage.length = 0;
      break;
    }
  }
  return cages.filter((c) => c.length > 0).map((cells) => ({ cells, sum: cells.reduce((s, c) => s + solution[c]!, 0) }));
}

/** {@link removeCells} under a layout: cells in an order drawn from `random`, each removed if the puzzle stays provably unique, down to `target` givens. */
export function removeCellsIn(layout: Layout, solution: readonly number[], target: number, random: Xoshiro256StarStar, nodeLimit = REMOVAL_NODES): number[] {
  const grid = solution.slice();
  const order = Array.from({ length: CELLS }, (_, i) => i);
  random.shuffle(order);
  let count = CELLS;
  for (const i of order) {
    if (count <= target) break;
    const digit = grid[i]!;
    grid[i] = 0;
    if (hasUniqueSolutionIn(layout, grid, nodeLimit)) count--;
    else grid[i] = digit;
  }
  return grid;
}

/** One attempt's full grid and layout. */
interface Attempt {
  readonly layout: Layout;
  readonly solution: number[];
}

/** Makes each attempt's grid and layout for a variant puzzle. */
function boards(variant: number, seed: bigint, tier: number, random: Xoshiro256StarStar): () => Attempt {
  switch (variant) {
    case VARIANT_DIAGONAL:
      return () => ({ layout: Layout.DIAGONAL, solution: randomSolutionIn(Layout.DIAGONAL, new Array<number>(CELLS).fill(0), random, Number.MAX_SAFE_INTEGER)! });
    case VARIANT_JIGSAW: {
      const jigsaw = jigsawLayout(seed);
      return () => ({ layout: jigsaw.layout, solution: relabel(jigsaw.solution, random) });
    }
    default:
      return () => {
        const solution = randomSolution(new Array<number>(CELLS).fill(0), random)!;
        return { layout: Layout.killer(carveCages(solution, random, KILLER_CAGES[tier - 1]!)), solution };
      };
  }
}

/** A built variant puzzle: grids as 81-character strings, its layout, its grade (Graded only) and the attempts it took. */
export interface VariantBuild {
  readonly givens: string;
  readonly solution: string;
  readonly layout: Layout;
  readonly grade: Grade | null;
  readonly attempts: number;
}

/**
 * Classic variant puzzle from a puzzle seed and tier (1..5): up to
 * {@link MAX_ATTEMPTS} attempts, each a full grid (and layout) with cells
 * removed down to the tier's target; the first to reach it, or else the one
 * with the fewest givens (the earliest on ties), wins.
 */
export function buildClassicVariant(seed: bigint, variant: number, tier: number): VariantBuild {
  const random = new Xoshiro256StarStar(seed);
  const next = boards(variant, seed, tier, random);
  const target = variant === VARIANT_KILLER ? KILLER_GIVENS[tier - 1]! : DIFFICULTIES[tier - 1]!.targetGivens;
  let best: { board: Attempt; givens: number[]; count: number } | null = null;
  let attempts = 0;
  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    const board = next();
    const givens = removeCellsIn(board.layout, board.solution, target, random);
    const count = givens.filter((v) => v !== 0).length;
    if (!best || count < best.count) best = { board, givens, count };
    if (count <= target) break;
  }
  return { givens: best!.givens.join(""), solution: best!.board.solution.join(""), layout: best!.board.layout, grade: null, attempts };
}

/**
 * Graded variant puzzle from a puzzle seed and tier (1..5): generator v2's
 * build under the variant. Up to `maxAttempts` attempts, each a full grid (and
 * layout) with cells removed to {@link GRADED_GIVENS} and graded under the
 * layout; the first in the band wins, else the non-stuck attempt nearest the
 * band (the easier on equal distance, then the earliest), else the earliest.
 */
export function buildGradedVariant(seed: bigint, variant: number, tier: number, maxAttempts = MAX_ATTEMPTS_VARIANT_GRADED[variant]!): VariantBuild {
  const band = BANDS[tier - 1]!;
  const random = new Xoshiro256StarStar(seed);
  const next = boards(variant, seed, tier, random);
  let best: { board: Attempt; givens: number[]; grade: Grade } | null = null;
  let bestKey = 0;
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts++;
    const board = next();
    const givens = removeCellsIn(board.layout, board.solution, GRADED_GIVENS[variant]![tier - 1]!, random);
    const g = grade(givens, board.layout);
    if (g.level >= band.minLevel && g.level <= band.maxLevel) {
      best = { board, givens, grade: g };
      break;
    }
    const key = g.level === STUCK_LEVEL ? 1000 : (g.level < band.minLevel ? band.minLevel - g.level : g.level - band.maxLevel) * 10 + g.level;
    if (best === null || key < bestKey) {
      best = { board, givens, grade: g };
      bestKey = key;
    }
  }
  return { givens: best!.givens.join(""), solution: best!.board.solution.join(""), layout: best!.board.layout, grade: best!.grade, attempts };
}

/** An endless puzzle of a variant: an {@link EndlessPuzzle} with its generator, variant and layout. */
export class VariantPuzzle extends EndlessPuzzle {
  readonly generator: number;
  readonly variant: number;
  readonly layout: Layout;

  constructor(generator: number, variant: number, layout: Layout, seed: bigint, tier: number, number: number, givens: string, solution: string) {
    super(seed, tier, number, givens, solution);
    this.generator = generator;
    this.variant = variant;
    this.layout = layout;
  }
}

/**
 * Endless puzzle `number` of tier `tier` (1..5) in `variant` (0..3) with
 * generator `generator` (1 Classic, 2 Graded). Variant 0 is
 * {@link generateEndlessVersion}'s puzzle, unchanged, with the standard
 * layout. Throws a `RangeError` for an unknown generator or variant, a tier
 * outside 1..5 or a number outside 1..2^53-1.
 */
export function generateEndlessVariant(generator: number, variant: number, endlessSeed: bigint, tier: number, number: number): VariantPuzzle {
  if (!isVariant(variant)) throw new RangeError(`unknown variant: ${variant}`);
  if (variant === VARIANT_STANDARD) {
    const p = generateEndlessVersion(generator, endlessSeed, tier, number);
    return new VariantPuzzle(generator, variant, Layout.STANDARD, endlessSeed, tier, number, p.givens, p.solution);
  }
  if (!(Number.isInteger(tier) && tier >= 1 && tier <= DIFFICULTIES.length)) throw new RangeError(`difficulty must be 1..${DIFFICULTIES.length}: ${tier}`);
  if (!isEndlessNumber(number)) throw new RangeError(`number must be 1..${MAX_ENDLESS_NUMBER}: ${number}`);
  const seed = variantPuzzleSeed(generator, variant, endlessSeed, tier, number);
  const b = generator === GENERATOR_CLASSIC ? buildClassicVariant(seed, variant, tier) : buildGradedVariant(seed, variant, tier);
  return new VariantPuzzle(generator, variant, b.layout, endlessSeed, tier, number, b.givens, b.solution);
}

