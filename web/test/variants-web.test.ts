// The web app's side of the variants (Diagonal, Jigsaw, Killer): storage keys, the API's variant fields, games and
// boards under a layout, the repositories and the controller's Variants tab. The engine is in variants.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SudokuApi } from "../src/api/client.ts";
import {
  decodeAdminEndlessResult, decodeEndlessBoard, decodeEndlessProgress, decodeEndlessReplayDetail, decodeEndlessResult, decodeLayout, variantOf,
} from "../src/api/models.ts";
import { Board } from "../src/core/board.ts";
import { Layout, VARIANT_DIAGONAL, VARIANT_JIGSAW, VARIANT_KILLER, VARIANT_STANDARD } from "../src/core/layout.ts";
import { AppStorage, decodeVariantPick, endlessGameKey, parseEndlessGameKey } from "../src/data/app-storage.ts";
import { ENDLESS_CACHE_SIZE, EndlessPuzzleCache, endlessInProgressOf } from "../src/data/endless.ts";
import { SudokuRepository } from "../src/data/repository.ts";
import { endlessKey } from "../src/data/result-sync.ts";
import { MemoryStore } from "../src/data/store.ts";
import { Game } from "../src/game/game.ts";
import { generateEndlessVariant } from "../src/generator/variants.ts";
import { parseWeekSeed } from "../src/generator/week-seed.ts";
import { seedSettings } from "../src/serverless/seed.ts";
import { SeedRepository } from "../src/serverless/seed-repository.ts";
import { AdminResultsModel } from "../src/ui/admin-results.ts";
import { cellDecor, layoutClass } from "../src/ui/cell-view.ts";
import { AppController, type EndlessRef, type Host, VARIANTS_LABEL } from "../src/ui/controller.ts";
import { applyEvent, ReplayViewer } from "../src/ui/replay-viewer.ts";
import { VARIANT_PICKS, seriesName, variantRule, variantRuleSentence, variantsHelp } from "../src/ui/variants.ts";
import { ENDLESS_SEED, FakeServer } from "./fake-server.ts";

const NOW = Date.parse("2026-10-27T01:00:00Z");
const REDIRECT = "https://sudoku.test/auth/callback";
const SEED = parseWeekSeed(ENDLESS_SEED);
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(done: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(done(), "condition never became true");
}

/** Classic puzzles of each variant, cheap to generate. */
const diagonal = generateEndlessVariant(1, VARIANT_DIAGONAL, SEED, 1, 1);
const jigsaw = generateEndlessVariant(1, VARIANT_JIGSAW, SEED, 1, 1);
const killer = generateEndlessVariant(1, VARIANT_KILLER, SEED, 1, 1);

/** A filled grid that is right under standard rules but breaks the diagonals: the solution with two rows swapped. */
function standardOnly(solution: string): string {
  const rows = solution.match(/.{9}/g)!;
  // Rows 0 and 1 share a band, so boxes keep their digits; the diagonals don't.
  return [rows[1], rows[0], ...rows.slice(2)].join("");
}

// Names and wording

test("series names, rules and the explainer", () => {
  assert.equal(VARIANTS_LABEL, "Variants");
  assert.deepEqual(VARIANT_PICKS, [1, 2, 3]);
  assert.equal(seriesName(1, VARIANT_STANDARD), "Classic");
  assert.equal(seriesName(2, VARIANT_KILLER), "Graded Killer");
  assert.equal(seriesName(1, VARIANT_DIAGONAL), "Classic Diagonal");
  assert.equal(variantRule(VARIANT_DIAGONAL), "the two long diagonals also hold 1 to 9 once each.");
  assert.equal(variantRule(VARIANT_JIGSAW), "the bold shapes replace the 3x3 boxes; each holds 1 to 9 once.");
  assert.equal(variantRule(VARIANT_KILLER), "dashed cages show a sum: the digits in a cage add up to it and don't repeat.");
  assert.equal(variantRule(VARIANT_STANDARD), "every row, column and 3x3 box holds 1 to 9 once each.");
  assert.equal(variantRuleSentence(VARIANT_JIGSAW), "The bold shapes replace the 3x3 boxes; each holds 1 to 9 once.");

  const server = variantsHelp({ seed: false, bothGenerators: false });
  assert.equal(server.title, "How Variants works");
  assert.deepEqual(server.rules.map((r) => r.name), ["Diagonal", "Jigsaw", "Killer"]);
  assert.equal(server.rules[2]!.text, variantRule(VARIANT_KILLER));
  assert.match(server.outro[0]!, /five difficulties/);
  assert.match(server.outro[1]!, /Classic and Graded/);
  assert.doesNotMatch(server.outro[1]!, /switch/);
  assert.match(server.outro[2]!, /leaderboard/);
  const seed = variantsHelp({ seed: true, bothGenerators: true });
  assert.match(seed.outro[1]!, /switch/);
  assert.match(seed.outro[2]!, /History/);
  for (const text of [...server.intro, ...server.outro, ...seed.outro, ...server.rules.map((r) => r.text)]) assert.doesNotMatch(text, /\u2014/);
});

// Storage keys

test("variant game keys: standard keys unchanged, variants prefixed, and both parse back", () => {
  assert.equal(endlessGameKey(1, 2, 7), "2/7");
  assert.equal(endlessGameKey(2, 2, 7, VARIANT_STANDARD), "g2/2/7");
  assert.equal(endlessGameKey(1, 2, 7, VARIANT_KILLER), "v3/2/7");
  assert.equal(endlessGameKey(2, 2, 7, VARIANT_DIAGONAL), "v1/g2/2/7");
  for (const [g, v] of [[1, 0], [2, 0], [1, 3], [2, 1]] as const) {
    assert.deepEqual(parseEndlessGameKey(endlessGameKey(g, 4, 12, v)), { generator: g, variant: v, difficulty: 4, number: 12 });
  }
  assert.equal(endlessKey({ generator: 2, variant: 2, difficulty: 1, number: 3, elapsedMs: 1, completedAt: "x" }), "v2/g2/1/3");
  assert.equal(endlessKey({ generator: 1, difficulty: 1, number: 3, elapsedMs: 1, completedAt: "x" }), "1/3");
});

test("the variant pick, its explainer flag and the Variants home tab are stored", () => {
  const store = new MemoryStore();
  const s = new AppStorage(store);
  s.homeTab.write("variants");
  assert.equal(s.homeTab.read(), "variants");
  assert.equal(decodeVariantPick(3), 3);
  assert.throws(() => decodeVariantPick(0), TypeError);
  assert.throws(() => decodeVariantPick(4), TypeError);
  s.variant.write(2);
  assert.equal(store.get("variant"), "2");
  store.set("variant", "0");
  assert.equal(s.variant.read(), null);
  s.variantsHelpSeen.write(true);
  assert.equal(store.get("variants-help-seen"), "true");
  // Device preferences: kept when the player's progress is forgotten.
  s.variant.write(1);
  s.clearUserData();
  assert.equal(s.variant.read(), 1);
  assert.equal(s.variantsHelpSeen.read(), true);
});

// API models

test("results, boards and admin results carry a variant, leaving standard Sudoku's out", () => {
  const base = { generator: 1, difficulty: 2, number: 7, elapsedMs: 9000, completedAt: "2026-10-27T01:00:00Z" };
  assert.deepEqual(decodeEndlessResult(base), base);
  assert.deepEqual(decodeEndlessResult({ ...base, variant: 0 }), base);
  assert.deepEqual(decodeEndlessResult({ ...base, variant: null }), base);
  assert.deepEqual(decodeEndlessResult({ ...base, variant: 3 }), { ...base, variant: 3 });
  assert.throws(() => decodeEndlessResult({ ...base, variant: 4 }), TypeError);
  assert.equal(variantOf(decodeEndlessResult(base)), 0);
  assert.equal(variantOf(decodeEndlessResult({ ...base, variant: 2 })), 2);

  assert.equal(decodeEndlessProgress({ generator: 2, variant: 1, difficulties: [] }).variant, 1);
  assert.equal(decodeEndlessProgress({ generator: 2, difficulties: [] }).variant, undefined);
  assert.equal(decodeEndlessBoard({ generator: 1, variant: 2, difficulty: 1, number: 1, entries: [] }).variant, 2);
  const admin = { ...base, userId: "a", displayName: "A", submittedAt: "s", replay: "valid", flag: null };
  assert.equal(decodeAdminEndlessResult({ ...admin, variant: 3 }).variant, 3);
  assert.equal("variant" in decodeAdminEndlessResult(admin), false);
});

test("decodeLayout builds each variant's layout, and replays carry it", () => {
  assert.equal(decodeLayout(VARIANT_STANDARD, null), Layout.STANDARD);
  assert.equal(decodeLayout(VARIANT_DIAGONAL, { regions: [], diagonals: true, cages: [] }), Layout.DIAGONAL);
  const j = decodeLayout(VARIANT_JIGSAW, { regions: jigsaw.layout.regions, diagonals: false, cages: [] });
  assert.deepEqual(j.regions, jigsaw.layout.regions);
  assert.equal(j.variant, VARIANT_JIGSAW);
  const k = decodeLayout(VARIANT_KILLER, { regions: killer.layout.regions, diagonals: false, cages: killer.layout.cages });
  assert.deepEqual(k.cages, killer.layout.cages);
  assert.throws(() => decodeLayout(VARIANT_KILLER, null), TypeError);
  assert.throws(() => decodeLayout(VARIANT_JIGSAW, { regions: [1, 2] }), RangeError);

  const detail = {
    generator: 1, difficulty: 1, number: 1, userId: "a", displayName: "A", elapsedMs: 1, completedAt: "c", submittedAt: "s", replay: "valid", flag: null,
    givens: killer.givens, events: [],
  };
  assert.equal("layout" in decodeEndlessReplayDetail(detail), false);
  const withLayout = decodeEndlessReplayDetail({ ...detail, variant: 3, layout: { regions: killer.layout.regions, diagonals: false, cages: killer.layout.cages } });
  assert.equal(withLayout.variant, 3);
  assert.deepEqual(withLayout.layout!.cages, killer.layout.cages);
});

test("the API client sends the variant on leaderboards and admin result routes, and leaves standard Sudoku's out", async () => {
  const server = new FakeServer(() => NOW);
  server.admin = true;
  server.adminEndlessReplayDetail = {
    generator: 1, variant: 1, difficulty: 1, number: 1, userId: "a", displayName: "A", elapsedMs: 1, completedAt: "c", submittedAt: "s",
    replay: "valid", flag: null, givens: diagonal.givens, events: [], layout: { regions: diagonal.layout.regions, diagonals: true, cages: [] },
  };
  server.adminEndlessFlagResult = { generator: 1, variant: 1, difficulty: 1, number: 1, userId: "a", displayName: "A", elapsedMs: 1, completedAt: "c", replay: "valid", flag: null };
  const api = new SudokuApi("https://sudoku.test", async () => "dev:alice:Alice", server.fetch);
  const last = () => server.requests.at(-1)!.url;
  assert.equal((await api.endlessProgress(2, 3)).variant, 3);
  assert.equal(last().search, "?generator=2&variant=3");
  await api.endlessProgress(2);
  assert.equal(last().search, "?generator=2");
  assert.equal((await api.endlessBoard(1, 2, 3, 1)).variant, 1);
  assert.equal(last().search, "?generator=1&variant=1");
  assert.equal((await api.adminEndlessReplay(1, 1, 1, "a", 1)).layout, Layout.DIAGONAL);
  assert.equal(last().search, "?generator=1&variant=1");
  await api.flagEndlessResult(1, 1, 1, "a", "why", 2);
  assert.equal(last().search, "?generator=1&variant=2");
  await api.unflagEndlessResult(1, 1, 1, "a", 3);
  assert.equal(last().search, "?generator=1&variant=3");
  await api.unflagEndlessResult(1, 1, 1, "a");
  assert.equal(last().search, "?generator=1");
});

// Boards and games under a layout

test("conflicts, wrong cages and solving follow the layout", () => {
  const swapped = Board.parse(standardOnly(diagonal.solution));
  assert.equal(swapped.isSolved, true);
  assert.deepEqual(swapped.conflicts(), []);
  assert.ok(swapped.conflicts(Layout.DIAGONAL).length > 0);
  assert.equal(swapped.solvedUnder(Layout.DIAGONAL), false);
  assert.equal(Board.parse(diagonal.solution).solvedUnder(Layout.DIAGONAL), true);
  assert.equal(Board.parse(diagonal.givens).solvedUnder(Layout.DIAGONAL), false);

  // Killer: a full cage with the wrong total is wrong; one with a gap isn't yet.
  const k = killer.layout;
  assert.deepEqual(Board.parse(killer.solution).wrongCages(k), []);
  assert.deepEqual(Board.parse(killer.givens).wrongCages(k), []);
  const cage = k.cages.findIndex((c) => c.cells.length >= 2 && c.cells.every((cell) => killer.givens[cell] === "0"));
  const cells = [...killer.solution].map(Number);
  const [a, b] = k.cages[cage]!.cells;
  // Swap two cells of the cage with digits from outside: same cells full, a different total.
  cells[a!] = cells[a!] === 9 ? 8 : 9;
  const off = Board.fromGivens(cells);
  assert.ok(off.wrongCages(k).includes(cage));
  assert.equal(off.solvedUnder(k), false);
  assert.ok(b !== undefined);
});

test("a game follows its layout: notes clear along diagonals, and the solve needs the variant's rules", () => {
  // The Diagonal solution with rows 0 and 1 and the centre cleared: under standard rules those two rows can be filled
  // either way round, under Diagonal only the right way.
  const open = new Set([...Array(18).keys(), 40]);
  const givens = [...diagonal.solution].map((d, i) => (open.has(i) ? "0" : d)).join("");
  const g = Game.create(givens, Layout.DIAGONAL).resume(0);
  assert.equal(g.layout, Layout.DIAGONAL);
  assert.equal(Game.create(givens).layout, Layout.STANDARD);
  // Cells 0 and 40 only share the main diagonal.
  assert.equal(g.toggleNote(40, 5).place(0, 5, 10).notes.has(40, 5), false);
  assert.equal(Game.create(givens).resume(0).toggleNote(40, 5).place(0, 5, 10).notes.has(40, 5), true);

  const fill = (game: Game, grid: string) => [...grid].reduce((x, d, i) => (open.has(i) ? x.place(i, Number(d), 100) : x), game);
  const wrong = standardOnly(diagonal.solution);
  assert.equal(fill(Game.create(givens).resume(0), wrong).isComplete, true);
  assert.equal(fill(g, wrong).isComplete, false);
  const solved = fill(g, diagonal.solution);
  assert.equal(solved.isComplete, true);
  assert.equal(solved.layout, Layout.DIAGONAL);

  // Restoring keeps the layout, and a saved "completed" game only counts as solved under it.
  const saved = solved.save(0);
  assert.equal(Game.restore(saved, Layout.DIAGONAL).isComplete, true);
  assert.equal(Game.restore(saved, Layout.DIAGONAL).layout, Layout.DIAGONAL);
  assert.equal(Game.restore(saved).layout, Layout.STANDARD);
  assert.equal(Game.restore({ ...saved, entries: wrong }, Layout.DIAGONAL).isComplete, false);
  assert.equal(Game.restore({ ...saved, entries: wrong }).isComplete, true);
  // Every other way of making a new game keeps the layout too.
  const steps = g.toggleNote(1, 1).undo().place(1, 1, 5).erase(1).clearAll().cycleColour(1).clearColours().pause(5).record({ t: 1, w: 1, a: "hidden" });
  assert.equal(steps.layout, Layout.DIAGONAL);
});

test("a killer game is solved only when every cage adds up", () => {
  const g = Game.create(killer.givens, killer.layout).resume(0);
  const done = [...killer.solution].reduce((x, d, i) => (killer.givens[i] === "0" ? x.place(i, Number(d), 100) : x), g);
  assert.equal(done.isComplete, true);
  // A peer in the same cage loses a placed digit's note.
  const cage = killer.layout.cages.find((c) => c.cells.length >= 2 && c.cells.every((cell) => killer.givens[cell] === "0"))!;
  const [x, y] = cage.cells as [number, number];
  const noted = g.toggleNote(y, 4).place(x, 4, 1);
  assert.equal(noted.notes.has(y, 4), false);
});

// Cell drawing

test("layoutClass and cellDecor dress each variant's cells", () => {
  assert.equal(layoutClass(Layout.STANDARD), null);
  assert.equal(layoutClass(Layout.DIAGONAL), "layout-diagonal");
  assert.equal(layoutClass(jigsaw.layout), "layout-jigsaw");
  assert.equal(layoutClass(killer.layout), "layout-killer");

  assert.deepEqual(cellDecor(Layout.STANDARD, 0), { classes: [], sum: null, label: null });
  assert.deepEqual(cellDecor(Layout.DIAGONAL, 0).classes, ["diag"]);
  assert.deepEqual(cellDecor(Layout.DIAGONAL, 8).classes, ["diag"]);
  assert.deepEqual(cellDecor(Layout.DIAGONAL, 40).classes, ["diag"]);
  assert.deepEqual(cellDecor(Layout.DIAGONAL, 1).classes, []);

  // Jigsaw: borders where the region changes, never on the grid's own edge.
  const regions = jigsaw.layout.regions;
  for (let i = 0; i < 81; i++) {
    const { classes } = cellDecor(jigsaw.layout, i);
    assert.equal(classes.includes("jr"), i % 9 < 8 && regions[i] !== regions[i + 1]);
    assert.equal(classes.includes("jb"), i < 72 && regions[i] !== regions[i + 9]);
  }
  // The boxes as a jigsaw: box borders exactly.
  const boxes = Layout.jigsaw(Layout.STANDARD.regions);
  assert.deepEqual(cellDecor(boxes, 2).classes, ["jr"]);
  assert.deepEqual(cellDecor(boxes, 20).classes, ["jr", "jb"]);
  assert.deepEqual(cellDecor(boxes, 8).classes, []);

  // Killer: every cell is in a cage, sides where it ends, the sum once per cage.
  let sums = 0;
  for (let i = 0; i < 81; i++) {
    const d = cellDecor(killer.layout, i);
    const k = killer.layout.cageOf[i]!;
    const cage = killer.layout.cages[k]!;
    assert.ok(d.classes.includes("cage"));
    assert.equal(d.classes.includes("ct"), i < 9 || killer.layout.cageOf[i - 9] !== k);
    assert.equal(d.classes.includes("cb"), i >= 72 || killer.layout.cageOf[i + 9] !== k);
    assert.equal(d.classes.includes("cl"), i % 9 === 0 || killer.layout.cageOf[i - 1] !== k);
    assert.equal(d.classes.includes("cr"), i % 9 === 8 || killer.layout.cageOf[i + 1] !== k);
    if (cage.cells[0] === i) {
      sums++;
      assert.equal(d.sum, cage.sum);
      assert.ok(d.classes.includes("has-sum"));
      assert.equal(d.label, `cage of ${cage.cells.length} adding to ${cage.sum}`);
    } else {
      assert.equal(d.sum, null);
      assert.equal(d.label, null);
    }
  }
  assert.equal(sums, killer.layout.cages.length);
  // A one-cell cage is closed on every side.
  const single = Layout.killer(Array.from({ length: 81 }, (_, i) => ({ cells: [i], sum: 5 })));
  assert.deepEqual(cellDecor(single, 40).classes, ["cage", "ct", "cr", "cb", "cl", "has-sum"]);
});

// The puzzle cache

test("the endless puzzle cache keeps the most recent puzzles of every variant", () => {
  const cache = new EndlessPuzzleCache();
  const p = cache.get(ENDLESS_SEED, 1, 1, 1, VARIANT_DIAGONAL);
  assert.equal(p.givens, diagonal.givens);
  assert.equal(p.layout, Layout.DIAGONAL);
  assert.equal(cache.get(ENDLESS_SEED, 1, 1, 1, VARIANT_DIAGONAL), p);
  assert.notEqual(cache.get(ENDLESS_SEED, 1, 1, 1), p);
  assert.equal(cache.get(ENDLESS_SEED, 1, 1, 1).layout, Layout.STANDARD);
  // Using p keeps it; filling the cache past its size drops the least recently used.
  for (let n = 2; n < ENDLESS_CACHE_SIZE; n++) cache.get(ENDLESS_SEED, 1, 1, n);
  assert.equal(cache.get(ENDLESS_SEED, 1, 1, 1, VARIANT_DIAGONAL), p);
  for (let n = 100; n < 100 + ENDLESS_CACHE_SIZE; n++) cache.get(ENDLESS_SEED, 1, 1, n);
  assert.notEqual(cache.get(ENDLESS_SEED, 1, 1, 1, VARIANT_DIAGONAL), p);
});

test("unfinished games are sorted by series, variant, difficulty then number", () => {
  const g = Game.create(diagonal.givens).save(1000);
  const games = { "v3/1/2": g, "1/5": g, "v1/1/9": g, "v1/1/3": g, "g2/1/1": g, "v1/g2/1/1": g, "v2/2/1": { ...g, completed: true } };
  assert.deepEqual(endlessInProgressOf(games).map((x) => endlessGameKey(x.generator, x.difficulty, x.number, x.variant)),
    ["1/5", "v1/1/3", "v1/1/9", "v3/1/2", "g2/1/1", "v1/g2/1/1"]);
});

// Repositories

interface RepoEnv {
  repo: SudokuRepository;
  server: FakeServer;
  store: MemoryStore;
}

async function repoEnv(): Promise<RepoEnv> {
  const server = new FakeServer(() => NOW);
  const store = new MemoryStore();
  const repo = new SudokuRepository(new AppStorage(store), REDIRECT, "", () => NOW, server.fetch);
  await repo.signInDev("https://sudoku.test", "alice", "Alice");
  return { repo, server, store };
}

function solve(p: { givens: string; solution: string; layout: Layout }): Game {
  let g = Game.create(p.givens, p.layout).resume(0);
  for (let i = 0; i < 81; i++) if (p.givens[i] === "0") g = g.place(i, Number(p.solution[i]), 60_000);
  assert.ok(g.isComplete);
  return g;
}

test("the server repository keeps variant games, results and leaderboards apart from standard ones", async () => {
  const { repo, server, store } = await repoEnv();
  assert.equal(repo.variantPick(), null);
  repo.setVariantPick(3);
  assert.equal(repo.variantPick(), 3);
  assert.equal(repo.variantsHelpSeen(), false);
  repo.markVariantsHelpSeen();
  assert.equal(repo.variantsHelpSeen(), true);

  const p = repo.endlessPuzzle(1, 1, 1, VARIANT_KILLER)!;
  assert.equal(p.givens, killer.givens);
  assert.notEqual(repo.endlessPuzzle(1, 1, 1)!.givens, p.givens);

  // A saved game resumes with the puzzle's layout, and only for that variant.
  repo.saveEndlessGame(1, 1, 1, Game.create(p.givens, p.layout).resume(0), 2500, VARIANT_KILLER);
  assert.ok(JSON.parse(store.get("endless-games")!)["v3/1/1"]);
  const loaded = repo.loadEndlessGame(1, p)!;
  assert.equal(loaded.layout, p.layout);
  assert.equal(loaded.elapsedMs(0), 2500);
  assert.equal(repo.loadEndlessGame(1, repo.endlessPuzzle(1, 1, 1)!), null);
  assert.deepEqual(repo.endlessInProgress().map((g) => [g.variant, g.difficulty, g.number]), [[3, 1, 1]]);

  // The result carries the variant, uploads, and counts as that variant's.
  const result = await repo.completeEndless(1, 1, 1, solve(p), VARIANT_KILLER);
  assert.equal(result.variant, VARIANT_KILLER);
  assert.equal(repo.endlessSolved().get("v3/1/1")?.synced, false);
  const plain = await repo.completeEndless(1, 1, 1, solve(repo.endlessPuzzle(1, 1, 1)!));
  assert.equal("variant" in plain, false);
  await repo.refresh();
  assert.deepEqual(server.storedEndless.map((r) => r.variant), [3, undefined]);
  assert.deepEqual([...repo.endlessSolved().keys()].sort(), ["1/1", "v3/1/1"]);
  assert.equal(JSON.parse(server.requests.find((r) => r.url.pathname === "/api/v1/endless/results")!.body).variant, 3);

  assert.equal((await repo.endlessProgress(1, VARIANT_KILLER)).difficulties[0]!.players[0]!.completed, 1);
  assert.equal((await repo.endlessProgress(1, VARIANT_JIGSAW)).difficulties[0]!.players.length, 0);
  assert.deepEqual((await repo.endlessBoard(1, 1, 1, VARIANT_KILLER)).entries.map((e) => e.elapsedMs), [60_000]);
});

test("seed play keeps variant games and history per variant", async () => {
  const store = new MemoryStore();
  const seeds = new SeedRepository(store, () => NOW);
  const profile = await seeds.use(seedSettings("test-secret-0123456789"));
  await seeds.loadEndless();
  const fp = profile.fingerprint.replace(/^#/, "");
  const p = seeds.endlessPuzzle(1, 1, 1, VARIANT_JIGSAW)!;
  assert.equal(p.givens, jigsaw.givens);
  seeds.saveEndlessGame(1, 1, 1, Game.create(p.givens, p.layout), 0, VARIANT_JIGSAW);
  assert.ok(JSON.parse(store.get(`seed-endless-games-${fp}`)!)["v2/1/1"]);
  assert.equal(seeds.loadEndlessGame(1, p)!.layout, p.layout);
  assert.deepEqual(seeds.endlessInProgress().map((g) => g.variant), [VARIANT_JIGSAW]);

  const first = await seeds.completeEndless(1, 1, 1, solve(p), VARIANT_JIGSAW);
  assert.equal(first.variant, VARIANT_JIGSAW);
  assert.deepEqual(seeds.endlessInProgress(), []);
  // The first result counts; a standard solve of the same number is its own.
  assert.deepEqual(await seeds.completeEndless(1, 1, 1, solve(p), VARIANT_JIGSAW), first);
  const standard = await seeds.completeEndless(1, 1, 1, solve(seeds.endlessPuzzle(1, 1, 1)!));
  assert.equal("variant" in standard, false);
  await seeds.completeEndless(1, 1, 2, solve(seeds.endlessPuzzle(1, 1, 2, VARIANT_DIAGONAL)!), VARIANT_DIAGONAL);
  assert.deepEqual(seeds.endlessHistory().map((r) => variantOf(r)), [0, 1, 2]);
  assert.deepEqual([...seeds.endlessSolved().keys()], ["1/1", "v1/1/2", "v2/1/1"]);
});

// Controller

interface Env {
  c: AppController;
  server: FakeServer;
  repo: SudokuRepository;
  clock: { now: number; mono: number; wall: number };
  /** Frames the controller is waiting on (with a `nextFrame` host); `flush` lets them all through. */
  frames: (() => void)[];
}

async function env(options: { offline?: boolean; frames?: boolean } = {}): Promise<Env> {
  const clock = { now: NOW, mono: 10_000, wall: NOW };
  const server = new FakeServer(() => clock.now);
  const storage = new AppStorage(new MemoryStore());
  const repo = new SudokuRepository(storage, REDIRECT, "", () => clock.now, server.fetch);
  await repo.signInDev("https://sudoku.test", "alice", "Alice");
  if (options.offline) {
    storage.endless.write(null);
    server.online = false;
  }
  const frames: (() => void)[] = [];
  const host: Host = {
    location: { hash: "", pathname: "/", search: "", origin: "https://sudoku.test" } as Location,
    history: { replaceState: () => {} } as unknown as History,
    baseUri: () => "https://sudoku.test/",
    isVisible: () => true,
    nowMs: () => clock.mono,
    wallMs: () => clock.wall,
    reloadPage: () => {},
    ...(options.frames ? { nextFrame: () => new Promise<void>((resolve) => frames.push(resolve)) } : {}),
  };
  const c = new AppController(repo, new SeedRepository(new MemoryStore(), () => clock.now), host);
  c.start();
  await settled();
  while (c.syncing) await settled();
  await until(() => !c.syncing);
  return { c, server, repo, clock, frames };
}

async function syncNow(c: AppController): Promise<void> {
  c.sync();
  await until(() => !c.syncing);
  await settled();
}

test("the variant pick defaults to Diagonal, ignores standard and unknown variants, and is remembered", async () => {
  const { c, repo } = await env();
  assert.equal(c.variant, VARIANT_DIAGONAL);
  let changes = 0;
  c.addEventListener("change", () => changes++);
  c.chooseVariant(VARIANT_STANDARD);
  c.chooseVariant(9);
  assert.equal(changes, 0);
  c.chooseVariant(VARIANT_KILLER);
  assert.equal(c.variant, VARIANT_KILLER);
  assert.equal(repo.variantPick(), VARIANT_KILLER);
  assert.equal(changes, 1);
});

test("the Variants tab explains itself once, separately from Endless", async () => {
  const { c, repo } = await env();
  c.showHomeTab("variants");
  assert.equal(c.help, "variants");
  assert.ok(repo.variantsHelpSeen());
  assert.equal(repo.endlessHelpSeen(), false);
  c.closeHelp();
  c.showHomeTab("daily");
  c.showHomeTab("variants");
  assert.equal(c.help, null);
  c.showHomeTab("endless");
  assert.equal(c.help, "endless");
  c.closeHelp();
  c.openHelp("variants");
  assert.equal(c.help, "variants");
});

test("openEndless shows a variant as preparing for a frame, then opens it", async () => {
  const e = await env({ frames: true });
  const { c } = e;
  const ref: EndlessRef = { generator: 1, variant: VARIANT_DIAGONAL, difficulty: 1, number: 1 };
  const opening = c.openEndless(ref);
  assert.deepEqual(c.preparing, ref);
  assert.equal(c.screen.kind, "today");
  e.frames.shift()!();
  await opening;
  assert.equal(c.preparing, null);
  assert.deepEqual(c.screen, { kind: "endless-play", generator: 1, variant: VARIANT_DIAGONAL, difficulty: 1, number: 1 });
  assert.equal(c.puzzleOf(ref)!.givens, diagonal.givens);
  assert.equal(c.gameOf(ref)!.layout, Layout.DIAGONAL);
  assert.equal(c.gameOf({ ...ref, variant: VARIANT_STANDARD }), null);
  // Already open: no waiting.
  await c.openEndless(ref);
  assert.equal(c.preparing, null);

  // A second open before the frame wins over the first.
  const a = c.openEndless({ ...ref, number: 2 });
  const b = c.openEndless({ ...ref, number: 3 });
  e.frames.splice(0).forEach((f) => f());
  await Promise.all([a, b]);
  assert.deepEqual(c.screen, { kind: "endless-play", generator: 1, variant: VARIANT_DIAGONAL, difficulty: 1, number: 3 });

  // Unknown variants are refused.
  await c.openEndless({ ...ref, variant: 7 });
  assert.equal((c.screen as { number?: number }).number, 3);
});

test("a variant can't open before the endless seed has synced", async () => {
  const { c } = await env({ offline: true });
  let changes = 0;
  c.addEventListener("change", () => changes++);
  await c.openEndless({ generator: 1, variant: VARIANT_KILLER, difficulty: 1, number: 1 });
  assert.equal(c.screen.kind, "today");
  assert.equal(c.preparing, null);
  assert.equal(changes, 2);
  assert.equal(c.endlessSummaries(VARIANT_KILLER), null);
});

/** Plays `ref` and places every solution digit but the last `leave`. */
async function play(e: Env, ref: EndlessRef, leave = 0): Promise<void> {
  const { c, clock } = e;
  await c.openEndless(ref);
  assert.equal(c.screen.kind, "endless-play");
  const p = c.puzzleOf(ref)!;
  const cells = [...p.givens].flatMap((g, i) => (g === "0" ? [i] : []));
  c.update(ref, (g) => g.resume(clock.mono), { a: "resume" });
  for (const cell of cells.slice(0, cells.length - leave)) {
    clock.mono += 100;
    const d = Number(p.solution[cell]);
    c.update(ref, (g) => g.place(cell, d, clock.mono), { a: "place", c: cell, d });
  }
}

test("the Variants tab plays each variant's own series: progress, unfinished games and uploads", async () => {
  const e = await env();
  const { c, server } = e;
  const k1: EndlessRef = { generator: 1, variant: VARIANT_KILLER, difficulty: 1, number: 1 };
  await play(e, k1);
  assert.ok(c.gameOf(k1)!.isComplete);
  await until(() => server.storedEndless.length === 1);
  assert.equal(server.storedEndless[0]!.variant, VARIANT_KILLER);
  await syncNow(c);

  // Killer Easy moves on to #2; the other variants and standard Endless are untouched.
  assert.deepEqual(c.endlessSummaries(VARIANT_KILLER)![0], { difficulty: 1, solved: 1, highest: 1, next: 2, inProgress: [] });
  assert.equal(c.endlessSummaries(VARIANT_JIGSAW)![0]!.next, 1);
  assert.equal(c.endlessSummaries()![0]!.next, 1);
  assert.deepEqual(c.endlessStatusOf(k1), { kind: "done", elapsedMs: c.gameOf(k1)!.completedElapsedMs!, synced: true });

  // Unfinished games: a Jigsaw one shows on the Killer tab's "elsewhere", not on Endless; a standard Graded one only on Endless.
  const j3: EndlessRef = { generator: 1, variant: VARIANT_JIGSAW, difficulty: 1, number: 3 };
  await play(e, j3, 5);
  const k4: EndlessRef = { generator: 1, variant: VARIANT_KILLER, difficulty: 1, number: 4 };
  await play(e, k4, 5);
  e.repo.saveEndlessGame(2, 1, 2, Game.create(e.repo.endlessPuzzle(2, 1, 2)!.givens), 0);
  c.openToday();
  assert.deepEqual(c.endlessSummaries(VARIANT_KILLER)![0]!.inProgress.map((g) => g.number), [4]);
  assert.deepEqual(c.endlessElsewhere(VARIANT_KILLER).map((g) => [g.variant, g.number]), [[VARIANT_JIGSAW, 3]]);
  assert.deepEqual(c.endlessElsewhere(VARIANT_JIGSAW).map((g) => [g.variant, g.number]), [[VARIANT_KILLER, 4]]);
  assert.deepEqual(c.endlessElsewhere().map((g) => [g.generator, g.variant, g.number]), [[2, 0, 2]]);
  assert.deepEqual(c.endlessElsewhere(VARIANT_DIAGONAL).map((g) => g.variant), [VARIANT_JIGSAW, VARIANT_KILLER]);

  // Solved, and its finished game dropped once the server had it: opening it again shows its scores.
  await c.openEndless(k1);
  assert.deepEqual(c.screen, { kind: "endless-scores", generator: 1, variant: VARIANT_KILLER, difficulty: 1, number: 1 });
});

test("a variant solved elsewhere opens its scores, and its leaderboards are the variant's", async () => {
  const e = await env();
  const { c, server } = e;
  server.storedEndless.push({ generator: 1, variant: VARIANT_DIAGONAL, difficulty: 2, number: 5, elapsedMs: 7000, completedAt: "x" });
  await syncNow(c);
  await c.openEndless({ generator: 1, variant: VARIANT_DIAGONAL, difficulty: 2, number: 5 });
  assert.deepEqual(c.screen, { kind: "endless-scores", generator: 1, variant: VARIANT_DIAGONAL, difficulty: 2, number: 5 });
  await until(() => c.endlessBoard !== null);
  assert.equal(c.endlessBoard!.variant, VARIANT_DIAGONAL);
  assert.deepEqual(c.endlessBoard!.entries.map((x) => x.elapsedMs), [7000]);
  assert.match(server.requests.at(-1)!.url.search, /variant=1/);

  c.openEndlessScores(2, null, 1, VARIANT_DIAGONAL);
  await until(() => c.endlessProgress !== null);
  assert.equal(c.endlessProgress!.difficulties[1]!.players[0]!.highest, 5);

  // A failed board retries with the same variant after the next sync.
  server.endlessBoardStatus = 500;
  c.openEndlessScores(2, null, 1, VARIANT_JIGSAW);
  await until(() => c.leaderboardError !== null);
  server.endlessBoardStatus = null;
  await syncNow(c);
  await until(() => c.endlessProgress !== null);
  assert.deepEqual(c.screen, { kind: "endless-scores", generator: 1, variant: VARIANT_JIGSAW, difficulty: 2, number: null });
  assert.match(server.requests.filter((r) => r.url.pathname === "/api/v1/endless/leaderboard").at(-1)!.url.search, /variant=2/);

  // "See scores" after a variant solve opens that variant's board.
  const ref: EndlessRef = { generator: 1, variant: VARIANT_KILLER, difficulty: 1, number: 2 };
  await play(e, ref);
  c.openScoresFor(ref);
  assert.deepEqual(c.screen, { kind: "endless-scores", generator: 1, variant: VARIANT_KILLER, difficulty: 1, number: 2 });
});

test("seed play has the Variants tab too, without a server", async () => {
  const clock = { mono: 10_000 };
  const host: Host = {
    location: { hash: "", pathname: "/", search: "", origin: "http://localhost" } as Location,
    history: { replaceState: () => {} } as unknown as History,
    baseUri: () => "http://localhost/",
    isVisible: () => true,
    nowMs: () => clock.mono,
    wallMs: () => NOW,
    reloadPage: () => {},
  };
  const store = new MemoryStore();
  const repo = new SudokuRepository(new AppStorage(store), "http://localhost/auth/callback", "", () => NOW);
  const seeds = new SeedRepository(store, () => NOW);
  await seeds.use(seedSettings("test-secret-0123456789"));
  const c = new AppController(repo, seeds, host);
  c.start();
  await until(() => c.phase.kind === "ready");
  const ref: EndlessRef = { generator: 1, variant: VARIANT_DIAGONAL, difficulty: 1, number: 1 };
  await c.openEndless(ref);
  // The same puzzle a server with that secret would give.
  assert.equal(c.puzzleOf(ref)!.givens, diagonal.givens);
  const p = c.puzzleOf(ref)!;
  c.update(ref, (g) => g.resume(clock.mono), { a: "resume" });
  for (let i = 0; i < 81; i++) {
    if (p.givens[i] !== "0") continue;
    clock.mono += 100;
    const d = Number(p.solution[i]);
    c.update(ref, (g) => g.place(i, d, clock.mono), { a: "place", c: i, d });
  }
  await until(() => c.endlessHistory().length === 1);
  assert.equal(c.endlessHistory()[0]!.variant, VARIANT_DIAGONAL);
  assert.equal(c.endlessSummaries(VARIANT_DIAGONAL)![0]!.next, 2);
  c.openScoresFor(ref);
  assert.equal(c.screen.kind, "history");
});

// Admin replays

test("admin endless results are keyed by variant, and a variant's replay plays under its layout", async () => {
  const calls: string[] = [];
  const result = {
    generator: 1, variant: VARIANT_DIAGONAL, difficulty: 1, number: 1, userId: "a", displayName: "A", elapsedMs: 1, completedAt: "c", submittedAt: "s",
    replay: "valid" as const, replayError: "", flag: null,
  };
  const plain = { ...result, variant: undefined };
  delete plain.variant;
  const events = [...diagonal.givens].flatMap((d, i) => (d === "0" ? [{ t: 1, w: 1, a: "place" as const, c: i, d: Number(diagonal.solution[i]) }] : []));
  const api = {
    adminResults: async () => { throw new Error("unused"); },
    adminReplay: async () => { throw new Error("unused"); },
    flagResult: async () => { throw new Error("unused"); },
    unflagResult: async () => { throw new Error("unused"); },
    adminEndlessResults: async (date: string) => ({ date, results: [result, plain] }),
    adminEndlessReplay: async (g: number, d: number, n: number, u: string, v?: number) => {
      calls.push(`replay ${g} ${d} ${n} ${u} ${v}`);
      return { ...result, givens: diagonal.givens, events, layout: Layout.DIAGONAL };
    },
    flagEndlessResult: async (g: number, d: number, n: number, u: string, reason: string, v?: number) => {
      calls.push(`flag ${g} ${d} ${n} ${u} ${reason} ${v}`);
      return { ...result, flag: { reason, auto: false, flaggedBy: null, flaggedAt: "f" } };
    },
    unflagEndlessResult: async (g: number, d: number, n: number, u: string, v?: number) => {
      calls.push(`unflag ${g} ${d} ${n} ${u} ${v}`);
      return plain;
    },
  };
  const model = new AdminResultsModel(api, "2026-10-27");
  await model.setMode("endless");
  // The two results differ only by variant.
  assert.equal(model.find(result), result);
  assert.equal(model.find({ ...plain }), plain);

  await model.open(result);
  assert.deepEqual(model.opened, { generator: 1, variant: VARIANT_DIAGONAL, difficulty: 1, number: 1, userId: "a" });
  const viewer = model.viewer!;
  assert.equal(viewer.game.layout, Layout.DIAGONAL);
  viewer.seek(viewer.endMs);
  assert.equal(viewer.game.isComplete, true);
  await model.flag(result, "why");
  assert.equal(model.find(result)!.flag!.reason, "why");
  assert.equal(model.find(plain)!.flag, null);
  await model.unflag(plain);
  await model.open(plain);
  assert.deepEqual(model.opened, { generator: 1, difficulty: 1, number: 1, userId: "a" });
  assert.deepEqual(calls, ["replay 1 1 1 a 1", "flag 1 1 1 a why 1", "unflag 1 1 1 a 0", "replay 1 1 1 a 0"]);

  // A standard replay (no layout) plays under standard rules, and a reload keeps the layout.
  const standard = new ReplayViewer({ ...plain, givens: diagonal.givens, events: [] });
  assert.equal(standard.game.layout, Layout.STANDARD);
  assert.equal(applyEvent(Game.create(diagonal.givens, Layout.DIAGONAL), { t: 0, w: 0, a: "restore" }).layout, Layout.DIAGONAL);
});
