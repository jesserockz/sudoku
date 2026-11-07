import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { AppStorage } from "../src/data/app-storage.ts";
import { MemoryStore } from "../src/data/store.ts";
import { Game } from "../src/game/game.ts";
import { type Puzzle, generateDay, generateEndless, puzzleTitle } from "../src/generator/generator.ts";
import { parseWeekSeed } from "../src/generator/week-seed.ts";
import { seedSettings as s } from "../src/serverless/seed.ts";
import { SeedRepository } from "../src/serverless/seed-repository.ts";

let now: number;
let store: MemoryStore;
const repo = () => new SeedRepository(store, () => now);

beforeEach(() => {
  now = Date.parse("2026-10-27T01:00:00Z");
  store = new MemoryStore();
});

function solved(p: { givens: string; solution: string }, ms: number): Game {
  let g = Game.create(p.givens).resume(0);
  for (let i = 0; i < 81; i++) if (p.givens[i] === "0") g = g.place(i, Number(p.solution[i]), ms);
  return g;
}

test("a seed plays the same week as the server with that secret", async () => {
  const r = repo();
  assert.equal(r.profile(), null);
  await r.use(s("test-secret-0123456789"));
  const week = await r.week();
  assert.equal(week.isoWeek, "2026-W44");
  assert.equal(week.seed, "e4d2e1e00e3549cc");
  assert.equal(r.today(), "2026-10-27");
  assert.deepEqual((await r.puzzles()).map((p) => p.givens), generateDay(parseWeekSeed(week.seed), 2, 5).map((p) => p.givens));
  assert.equal(r.profile()?.fingerprint, "#287caf");
});

test("the seed survives a restart, and leaving forgets it", async () => {
  await repo().use(s("rimu", 3, "Europe/London"));
  const again = repo();
  assert.deepEqual(again.profile()?.settings, s("rimu", 3, "Europe/London"));
  assert.equal((await again.puzzles()).length, 3);
  again.leave();
  assert.equal(repo().profile(), null);
});

test("profiles stored with defaults left out still read", () => {
  store.set("seed", JSON.stringify({ settings: { seed: "rimu" }, fingerprint: "#123456" }));
  assert.deepEqual(repo().profile(), { settings: s("rimu"), fingerprint: "#123456" });
});

test("the day follows the group's timezone", async () => {
  const r = repo();
  await r.use(s("rimu", 5, "America/Los_Angeles"));
  assert.equal(r.today(), "2026-10-26");
  assert.equal((await r.week()).dayOfWeek, 1);
});

test("games and history are kept per seed", async () => {
  const r = repo();
  await r.use(s("kauri"));
  const today = r.today();
  const easy = (await r.puzzles())[0]!;
  r.saveGame(today, 1, Game.create(easy.givens).resume(0).place(easy.givens.indexOf("0"), 1, 10), 10);
  r.complete(today, 2, solved((await r.puzzles())[1]!, 95_000));
  assert.ok(r.loadGame(today, easy));
  assert.deepEqual([...r.results().keys()], [2]);

  await r.use(s("totara"));
  assert.notEqual((await r.puzzles())[0]!.givens, easy.givens);
  assert.equal(r.loadGame(today, (await r.puzzles())[0]!), null);
  assert.equal(r.results().size, 0);
  assert.deepEqual(r.history(), []);

  await r.use(s("kauri"));
  assert.ok(r.loadGame(today, easy));
  assert.equal(r.results().get(2)?.elapsedMs, 95_000);
});

test("the first result for a game counts", async () => {
  const r = repo();
  await r.use(s("kauri"));
  const p = (await r.puzzles())[0]!;
  const first = r.complete(r.today(), 1, solved(p, 120_000));
  assert.deepEqual(r.complete(r.today(), 1, solved(p, 30_000)), first);
  assert.deepEqual(r.history().map((h) => h.elapsedMs), [120_000]);
  assert.equal(first.completedAt, "2026-10-27T01:00:00Z");
});

test("history is newest first, and old weeks' games are pruned", async () => {
  const r = repo();
  await r.use(s("kauri", 2));
  const monday = "2026-10-26";
  const tuesday = r.today();
  r.complete(monday, 1, solved((await r.puzzles(monday))[0]!, 61_000));
  r.complete(tuesday, 2, solved((await r.puzzles())[1]!, 62_000));
  r.complete(tuesday, 1, solved((await r.puzzles())[0]!, 63_000));
  assert.deepEqual(r.history().map((h) => [h.date, puzzleTitle(h.level, h.levels)]), [
    [tuesday, "Easy"], [tuesday, "Diabolical"], [monday, "Easy"],
  ]);
  r.saveGame(tuesday, 1, Game.create((await r.puzzles())[0]!.givens), 0);
  now = Date.parse("2026-11-03T01:00:00Z");
  const next = r.today();
  r.saveGame(next, 1, Game.create((await r.puzzles())[0]!.givens), 0);
  const keys = [...store.values.keys()].filter((k) => k.startsWith("seed-games-")).flatMap((k) => Object.keys(JSON.parse(store.get(k)!)));
  assert.deepEqual(keys, [`${next}/1`]);
  assert.equal(r.history().length, 3);
});

test("the summary lists the day's games", async () => {
  const r = repo();
  await r.use(s("test-secret-0123456789", 3));
  r.complete(r.today(), 1, solved((await r.puzzles())[0]!, 192_000));
  assert.equal(await r.summary(), "Sudoku 2026-10-27 #287caf\nEasy 3:12\nHard -\nDiabolical -\nSolved 1/3 in 3:12");
});

test("server mode's storage is untouched", async () => {
  const r = repo();
  await r.use(s("kauri"));
  r.complete(r.today(), 1, solved((await r.puzzles())[0]!, 70_000));
  const storage = new AppStorage(store);
  assert.equal(storage.week.read(), null);
  assert.equal(storage.games.read(), null);
  assert.equal(storage.pending.read(), null);
});

// Endless

const ENDLESS_TEST_SEED = "3242a2d84b0602b6"; // the endless seed of "test-secret-0123456789"

test("endless puzzles come from the seed's endless seed, and only once it is loaded", async () => {
  const r = repo();
  await r.use(s("test-secret-0123456789"));
  assert.equal(r.endlessPuzzle(1, 1, 1), null, "not until loaded");
  await r.loadEndless();
  const p = r.endlessPuzzle(1, 2, 7)!;
  assert.equal(p.givens, generateEndless(parseWeekSeed(ENDLESS_TEST_SEED), 2, 7).givens);
  assert.equal(r.endlessPuzzle(1, 2, 7), p, "cached");
  await r.loadEndless();
  assert.equal(r.endlessPuzzle(1, 2, 7), p, "loading again changes nothing");
  // Another seed has to load its own before its puzzles are offered.
  await r.use(s("rimu"));
  assert.equal(r.endlessPuzzle(1, 2, 7), null);
  await r.loadEndless();
  assert.notEqual(r.endlessPuzzle(1, 2, 7)!.givens, p.givens);
  r.leave();
  assert.equal(r.endlessPuzzle(1, 2, 7), null, "nor without a seed");
  assert.deepEqual(r.endlessHistory(), []);
  assert.equal(r.endlessSolved().size, 0);
});

test("endless games resume, are never pruned, and are dropped once solved", async () => {
  const r = repo();
  await r.use(s("kauri"));
  await r.loadEndless();
  const p = r.endlessPuzzle(1, 3, 12)!;
  const other = r.endlessPuzzle(1, 1, 2)!;
  assert.equal(r.loadEndlessGame(1, p), null);
  const started = Game.create(p.givens).resume(0).place(p.givens.indexOf("0"), Number(p.solution[p.givens.indexOf("0")]), 5000);
  r.saveEndlessGame(1, 3, 12, started, 5000);
  r.saveEndlessGame(1, 1, 2, Game.create(other.givens).resume(0), 0);
  assert.equal(r.loadEndlessGame(1, p)?.elapsedMs(5000), 5000);
  assert.deepEqual(r.endlessInProgress().map((g) => [g.difficulty, g.number]), [[1, 2], [3, 12]]);
  // A game saved for different givens isn't loaded.
  assert.equal(r.loadEndlessGame(1, Object.assign(Object.create(Object.getPrototypeOf(p)), p, { givens: other.givens })), null);
  // A week later they are all still there.
  now += 14 * 24 * 3_600_000;
  assert.equal(r.endlessInProgress().length, 2);

  const finished = solved(p, 70_000);
  r.saveEndlessGame(1, 3, 12, finished, 70_000);
  const result = await r.completeEndless(1, 3, 12, finished);
  assert.deepEqual(result, { generator: 1, difficulty: 3, number: 12, elapsedMs: 70_000, completedAt: new Date(now).toISOString().replace(".000Z", "Z") });
  assert.equal(r.loadEndlessGame(1, p), null, "the finished game is dropped");
  assert.deepEqual(r.endlessInProgress().map((g) => [g.difficulty, g.number]), [[1, 2]]);
  assert.deepEqual([...r.endlessSolved()], [["3/12", { elapsedMs: 70_000, synced: true }]]);
});

test("the first endless result for a puzzle counts, and an unfinished game is refused", async () => {
  const r = repo();
  await r.use(s("kauri"));
  await r.loadEndless();
  const p = r.endlessPuzzle(1, 1, 1)!;
  const first = await r.completeEndless(1, 1, 1, solved(p, 60_000));
  assert.deepEqual(await r.completeEndless(1, 1, 1, solved(p, 30_000)), first);
  assert.deepEqual(r.endlessHistory().map((h) => h.elapsedMs), [60_000]);
  await assert.rejects(r.completeEndless(1, 1, 2, Game.create(p.givens)), /isn't complete/);
  r.leave();
  await assert.rejects(r.completeEndless(1, 1, 1, solved(p, 1)), /no seed is active/);
});

test("endless history is sorted, and kept per seed", async () => {
  const r = repo();
  await r.use(s("kauri"));
  await r.loadEndless();
  await r.completeEndless(1, 2, 3, solved(r.endlessPuzzle(1, 2, 3)!, 62_000));
  await r.completeEndless(1, 1, 5, solved(r.endlessPuzzle(1, 1, 5)!, 63_000));
  await r.completeEndless(1, 1, 2, solved(r.endlessPuzzle(1, 1, 2)!, 64_000));
  assert.deepEqual(r.endlessHistory().map((h) => [h.difficulty, h.number]), [[1, 2], [1, 5], [2, 3]]);
  assert.ok(store.get(`seed-endless-history-${r.profile()!.fingerprint.slice(1)}`));
  await r.use(s("totara"));
  assert.deepEqual(r.endlessHistory(), []);
  await r.use(s("kauri"));
  assert.equal(r.endlessHistory().length, 3);
});
