import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { AppStorage } from "../src/data/app-storage.ts";
import { MemoryStore } from "../src/data/store.ts";
import { Game } from "../src/game/game.ts";
import { type Puzzle, generateDay, puzzleTitle } from "../src/generator/generator.ts";
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

function solved(p: Puzzle, ms: number): Game {
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
