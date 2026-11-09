// Enabled generators: the server admin (or a seed's player) turns on Classic, Graded or both, straight away. With
// both on, players pick one with a switch on the Daily and Endless tabs; each generator has its own daily puzzles,
// saved games, results, leaderboard and stats.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiException, SudokuApi } from "../src/api/client.ts";
import { decodeDayResult, decodeGameResult, decodeGeneratorSettings, decodeMyResults, decodeWeek, weekPuzzles } from "../src/api/models.ts";
import { AppStorage, gameKey, gameKeyDate } from "../src/data/app-storage.ts";
import { SudokuRepository } from "../src/data/repository.ts";
import { dailyKey } from "../src/data/result-sync.ts";
import { MemoryStore } from "../src/data/store.ts";
import { Game } from "../src/game/game.ts";
import { generateDay } from "../src/generator/generator.ts";
import { generateDayV2, generateV2 } from "../src/generator/generator-v2.ts";
import {
  GENERATOR_CLASSIC, GENERATOR_GRADED, GENERATOR_VERSIONS, enabledGenerators, generateDayVersion, generatorName, isGeneratorVersion,
} from "../src/generator/versions.ts";
import { parseWeekSeed } from "../src/generator/week-seed.ts";
import { seedSettings as s, seedWeek } from "../src/serverless/seed.ts";
import { SeedRepository, decodeSeedGenerators } from "../src/serverless/seed-repository.ts";
import { AppController, type Host } from "../src/ui/controller.ts";
import { GENERATOR_CHOICES, generatorHelp, generatorsSummary, sameGenerators } from "../src/ui/generator.ts";
import { FakeServer } from "./fake-server.ts";

const C = GENERATOR_CLASSIC;
const G = GENERATOR_GRADED;
const NOW = Date.parse("2026-10-27T01:00:00Z"); // Tuesday 2026-10-27, in 2026-W44
const REDIRECT = "https://sudoku.test/auth/callback";
const SEED = "e4d2e1e00e3549cc";
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(done: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(done(), "condition never became true");
}

const week = (extra: object = {}) => ({
  isoWeek: "2026-W44", seed: SEED, weekStart: "2026-10-26", weekEnd: "2026-11-01", today: "2026-10-27", dayOfWeek: 2, timezone: "Pacific/Auckland",
  levels: 2, ...extra,
});

function solveGame(p: { givens: string; solution: string }, ms = 60_000): Game {
  let g = Game.create(p.givens).resume(0);
  for (let i = 0; i < 81; i++) if (p.givens[i] === "0") g = g.place(i, Number(p.solution[i]), ms);
  assert.ok(g.isComplete);
  return g;
}

// Versions

test("generator versions have names and dispatch to their generator", () => {
  assert.deepEqual(GENERATOR_VERSIONS.map(generatorName), ["Classic", "Graded"]);
  assert.equal(generatorName(7), "Generator 7");
  assert.deepEqual([0, 1, 2, 3].map(isGeneratorVersion), [false, true, true, false]);
  const seed = parseWeekSeed(SEED);
  const classic = generateDayVersion(C, seed, 2, 2);
  const graded = generateDayVersion(G, seed, 2, 2);
  assert.deepEqual(classic.map((p) => p.givens), generateDay(seed, 2, 2).map((p) => p.givens));
  assert.deepEqual(graded.map((p) => p.givens), generateDayV2(seed, 2, 2).map((p) => p.givens));
  assert.deepEqual(graded.map((p) => p.givens), [1, 2].map((l) => generateV2(seed, 2, l, 2).puzzle.givens));
  assert.notEqual(classic[0]!.givens, graded[0]!.givens);
  assert.throws(() => generateDayVersion(3, seed, 2, 2), /unknown generator version: 3/);
});

test("the day's games default to five levels in either generator", () => {
  const seed = parseWeekSeed(SEED);
  assert.equal(generateDayV2(seed, 1).length, 5);
  assert.equal(generateDayVersion(C, seed, 1).length, 5);
});

test("an enabled set is the known versions, ascending and without duplicates, and never empty", () => {
  assert.deepEqual(enabledGenerators([2, 1, 2]), [1, 2]);
  assert.deepEqual(enabledGenerators([2]), [2]);
  assert.throws(() => enabledGenerators([]), /no generator is enabled/);
  assert.throws(() => enabledGenerators([1, 3]), /unsupported generator version: 3/);
});

// Models and client

test("a week lists its enabled generators; older servers give one generator, or none (Classic)", () => {
  assert.deepEqual(decodeWeek(week({ generators: [1, 2], generator: 1, pendingGenerator: null })).generators, [1, 2]);
  assert.deepEqual(decodeWeek(week({ generators: [2, 1] })).generators, [1, 2]);
  assert.deepEqual(decodeWeek(week({ generator: 2, pendingGenerator: { version: 1, fromWeek: "2026-W45" } })).generators, [2]);
  assert.deepEqual(decodeWeek(week()).generators, [1]);
  assert.ok(!("pendingGenerator" in decodeWeek(week({ generator: 2, pendingGenerator: null }))), "the pending change is gone");
  assert.throws(() => decodeWeek(week({ generators: [] })), /no generator is enabled/);
  assert.throws(() => decodeWeek(week({ generators: [3] })), /unsupported generator version: 3/);
  assert.throws(() => decodeWeek(week({ generator: 3 })), /unsupported generator version: 3/);
});

test("a week's puzzles come from the generator asked for", () => {
  const w = decodeWeek(week({ generators: [1, 2] }));
  const seed = parseWeekSeed(SEED);
  assert.deepEqual(weekPuzzles(w, C).map((p) => p.givens), generateDay(seed, 2, 2).map((p) => p.givens));
  assert.deepEqual(weekPuzzles(w, G).map((p) => p.givens), generateDayV2(seed, 2, 2).map((p) => p.givens));
  assert.deepEqual(weekPuzzles(w, G, "2026-10-26").map((p) => p.givens), generateDayV2(seed, 1, 2).map((p) => p.givens));
  assert.throws(() => weekPuzzles(w, G, "2026-11-02"), RangeError);
});

test("daily results carry their generator, and older ones have none", () => {
  const base = { level: 1, elapsedMs: 5, completedAt: "c" };
  assert.deepEqual(decodeDayResult({ ...base, generator: 2 }), { generator: 2, ...base });
  assert.deepEqual(decodeDayResult(base), base);
  assert.ok(!("generator" in decodeDayResult(base)));
  assert.throws(() => decodeDayResult({ ...base, generator: 0 }), /unsupported generator version: 0/);
  assert.equal(decodeGameResult({ ...base, date: "2026-10-27", generator: 2 }).generator, 2);
  assert.deepEqual(decodeMyResults({ date: "2026-10-27", results: [{ ...base, generator: 2 }, base] }).results.map((r) => r.generator), [2, undefined]);
});

test("the admin generator setting decodes as a set", () => {
  assert.deepEqual(decodeGeneratorSettings({ enabled: [2, 1] }), { enabled: [1, 2] });
  assert.throws(() => decodeGeneratorSettings({ enabled: [] }), /no generator/);
  assert.throws(() => decodeGeneratorSettings({ enabled: [5] }), /unsupported/);
  assert.throws(() => decodeGeneratorSettings({}), TypeError);
});

function api(server: FakeServer): SudokuApi {
  server.admin = true;
  return new SudokuApi("https://sudoku.test", async () => "dev:alice:Alice", server.fetch);
}

test("the client reads and sets the enabled generators", async () => {
  const server = new FakeServer(() => NOW);
  const client = api(server);
  assert.deepEqual(await client.adminGenerators(), { enabled: [1] });
  assert.deepEqual(await client.setGenerators([2, 1]), { enabled: [1, 2] });
  const put = server.requests.at(-1)!;
  assert.deepEqual([put.method, put.url.pathname, put.body], ["PUT", "/api/v1/admin/generator", '{"enabled":[2,1]}']);
  assert.deepEqual(server.generators, [1, 2]);
  const bad = client.setGenerators([]);
  await assert.rejects(bad, (e) => e instanceof ApiException && e.status === 400 && e.error?.code === "bad_request");
});

test("a non-admin is refused the generator endpoints", async () => {
  const server = new FakeServer(() => NOW);
  const client = api(server);
  server.admin = false;
  for (const call of [() => client.adminGenerators(), () => client.setGenerators([2])]) {
    await assert.rejects(call, (e) => e instanceof ApiException && e.status === 403);
  }
  server.admin = true;
  server.generatorStatus = 500;
  await assert.rejects(client.adminGenerators(), (e) => e instanceof ApiException && e.error?.message === "generator broke");
});

test("the client asks for one generator's leaderboard and stats", async () => {
  const server = new FakeServer(() => NOW);
  const client = api(server);
  await client.leaderboard();
  assert.equal(server.requests.at(-1)!.url.search, "");
  await client.leaderboard("2026-10-27");
  assert.equal(server.requests.at(-1)!.url.search, "?date=2026-10-27");
  await client.leaderboard("2026-10-27", 2);
  assert.equal(server.requests.at(-1)!.url.search, "?date=2026-10-27&generator=2");
  await client.leaderboard(undefined, 1);
  assert.equal(server.requests.at(-1)!.url.search, "?generator=1");

  assert.equal((await client.myStats()).generator, 1);
  assert.equal(server.requests.at(-1)!.url.search, "");
  assert.equal((await client.myStats(2)).generator, 2);
  assert.equal(server.requests.at(-1)!.url.search, "?generator=2");
  server.reportsGenerator = false;
  assert.equal((await client.myStats()).generator, 1);
});

// Storage keys

test("Classic's daily games keep their keys, others are prefixed as endless ones are", () => {
  assert.equal(gameKey(C, "2026-10-27", 3), "2026-10-27/3");
  assert.equal(gameKey(G, "2026-10-27", 3), "g2/2026-10-27/3");
  assert.equal(gameKeyDate("2026-10-27/3"), "2026-10-27");
  assert.equal(gameKeyDate("g2/2026-10-27/3"), "2026-10-27");
  const r = { date: "2026-10-27", level: 3, elapsedMs: 1, completedAt: "c" };
  assert.equal(dailyKey({ ...r, generator: G }), "g2/2026-10-27/3");
  assert.equal(dailyKey({ ...r, generator: C }), "2026-10-27/3");
  assert.equal(dailyKey(r), "2026-10-27/3", "a result queued by an older app keys as it always did");
});

test("the player's pick is kept, and an unreadable one reads as none", () => {
  const store = new MemoryStore();
  const repo = new SudokuRepository(new AppStorage(store), REDIRECT);
  assert.equal(repo.generatorPick(), null);
  repo.setGeneratorPick(G);
  assert.equal(store.get("generator"), "2");
  assert.equal(new SudokuRepository(new AppStorage(store), REDIRECT).generatorPick(), G);
  store.set("generator", "7");
  assert.equal(repo.generatorPick(), null);
  // Signing out keeps it: it is the device's, not the account's.
  repo.setGeneratorPick(G);
  repo.signOut();
  assert.equal(repo.generatorPick(), G);
});

// The repository

function repoFor(server: FakeServer, store = new MemoryStore()): SudokuRepository {
  return new SudokuRepository(new AppStorage(store), REDIRECT, "", () => NOW, server.fetch);
}

test("the repository generates each generator's puzzles, cached per generator", async () => {
  const server = new FakeServer(() => NOW);
  server.levels = 2;
  server.generators = [1, 2];
  const r = repoFor(server);
  await r.signInDev("sudoku.test", "alice", "Alice");
  assert.deepEqual(r.weekFor()!.generators, [1, 2]);
  const seed = parseWeekSeed(r.weekFor()!.seed);
  const graded = r.puzzles(r.today(), G)!;
  assert.deepEqual(graded.map((p) => p.givens), generateDayV2(seed, 2, 2).map((p) => p.givens));
  assert.equal(r.puzzles(r.today(), G), graded, "the same puzzles are served from the cache");
  const classic = r.puzzles(r.today(), C)!;
  assert.deepEqual(classic.map((p) => p.givens), generateDay(seed, 2, 2).map((p) => p.givens));
  assert.equal(r.puzzles("2026-11-03", C), null, "outside the cached week");
});

test("games, results and the queue are kept per generator", async () => {
  const server = new FakeServer(() => NOW);
  server.levels = 2;
  server.generators = [1, 2];
  const store = new MemoryStore();
  const r = repoFor(server, store);
  await r.signInDev("sudoku.test", "alice", "Alice");
  const today = r.today();
  const [classic, graded] = [r.puzzles(today, C)![0]!, r.puzzles(today, G)![0]!];

  // Saved games: Classic keeps its key, Graded's is prefixed, and neither loads as the other.
  r.saveGame(C, today, 1, Game.create(classic.givens), 0);
  r.saveGame(G, today, 1, Game.create(graded.givens), 0);
  assert.deepEqual(Object.keys(JSON.parse(store.get("games")!)), [`${today}/1`, `g2/${today}/1`]);
  assert.ok(r.loadGame(C, today, classic));
  assert.ok(r.loadGame(G, today, graded));
  assert.equal(r.loadGame(G, today, classic), null);

  // Results carry the generator, are queued and uploaded per generator.
  server.online = false;
  const g = await r.complete(G, today, 1, solveGame(graded));
  assert.equal(g.generator, G);
  await r.complete(C, today, 1, solveGame(classic));
  await r.complete(G, today, 1, solveGame(graded, 1)); // the same puzzle again: the first one counts
  assert.deepEqual(r.pending().map((x) => [x.generator, x.level]), [[G, 1], [C, 1]]);
  assert.deepEqual([...r.pendingFor(today, G).keys()], [1]);
  assert.equal(r.pendingFor(today, C).get(1)!.generator, C);
  assert.equal(r.pendingFor("2026-10-26", G).size, 0);
  server.online = true;
  await r.refresh();
  assert.deepEqual(server.stored.map((x) => [x.generator, x.level]), [[G, 1], [C, 1]]);
  assert.deepEqual(JSON.parse(server.requests.find((x) => x.url.pathname === "/api/v1/results")!.body).generator, G);
  assert.equal(r.serverResults(today, G).get(1)!.generator, G);
  assert.equal(r.serverResults(today, C).get(1)!.generator, C);
  assert.equal(r.serverResults("2026-10-26", C).size, 0);
});

test("results without a generator belong to the week's default one", async () => {
  const server = new FakeServer(() => NOW);
  server.generators = [2];
  const store = new MemoryStore();
  const r = repoFor(server, store);
  await r.signInDev("sudoku.test", "alice", "Alice");
  const today = r.today();
  // A result an older version of the app queued, and one an older server reported.
  store.set("pending", JSON.stringify([{ date: today, level: 2, elapsedMs: 7, completedAt: "c" }]));
  store.set("results", JSON.stringify({ [today]: [{ level: 1, elapsedMs: 5, completedAt: "c" }] }));
  assert.equal(r.pendingFor(today, G).get(2)!.elapsedMs, 7);
  assert.equal(r.pendingFor(today, C).size, 0);
  assert.equal(r.serverResults(today, G).get(1)!.elapsedMs, 5);
  assert.equal(r.serverResults(today, C).size, 0);
  // Without a week for the date, Classic.
  store.set("week", null);
  assert.equal(r.pendingFor(today, C).get(2)!.elapsedMs, 7);
  assert.equal(r.serverResults(today, C).get(1)!.elapsedMs, 5);
  // The server stores it as its default generator's.
  server.stored.length = 0;
  store.set("pending", JSON.stringify([{ date: today, level: 2, elapsedMs: 7, completedAt: "c", replay: { version: 1, events: [] } }]));
  await r.flush();
  assert.equal(server.stored[0]!.generator, G);
});

test("a new week drops last week's games of every generator", async () => {
  let now = NOW;
  const server = new FakeServer(() => now);
  server.generators = [1, 2];
  const store = new MemoryStore();
  const r = new SudokuRepository(new AppStorage(store), REDIRECT, "", () => now, server.fetch);
  await r.signInDev("sudoku.test", "alice", "Alice");
  r.saveGame(C, r.today(), 1, Game.create(r.puzzles(r.today(), C)![0]!.givens), 0);
  r.saveGame(G, r.today(), 1, Game.create(r.puzzles(r.today(), G)![0]!.givens), 0);
  now += 7 * 24 * 3_600_000;
  await r.refresh();
  r.saveGame(G, r.today(), 2, Game.create(r.puzzles(r.today(), G)![1]!.givens), 0);
  assert.deepEqual(Object.keys(JSON.parse(store.get("games")!)), ["g2/2026-11-03/2"]);
});

test("an older server's week plays its one generator, and a cached week from an older app still reads", async () => {
  const server = new FakeServer(() => NOW);
  server.levels = 2;
  server.generators = [2];
  server.reportsGenerators = false;
  const store = new MemoryStore();
  const r = repoFor(server, store);
  await r.signInDev("sudoku.test", "alice", "Alice");
  assert.deepEqual(r.weekFor()!.generators, [2]);
  // What the #64 app stored: the generator and a pending change, no list.
  const { generators: _, ...stored } = JSON.parse(store.get("week")!);
  store.set("week", JSON.stringify({ ...stored, generator: 2, pendingGenerator: { version: 1, fromWeek: "2026-W45" } }));
  assert.deepEqual(repoFor(new FakeServer(() => NOW), store).weekFor()!.generators, [2]);
  store.set("week", JSON.stringify(stored));
  assert.deepEqual(repoFor(new FakeServer(() => NOW), store).weekFor()!.generators, [1]);
});

// Serverless play

test("a seed's enabled generators read from either format, the old schedule as its latest entry", () => {
  assert.deepEqual(decodeSeedGenerators([2, 1]), [1, 2]);
  assert.deepEqual(decodeSeedGenerators([2]), [2]);
  // The #64 schedule: a change still pending applies now.
  assert.deepEqual(decodeSeedGenerators([{ fromWeek: "0000-W00", version: 1 }, { fromWeek: "2026-W45", version: 2 }]), [2]);
  assert.deepEqual(decodeSeedGenerators([{ fromWeek: "2026-W45", version: 2 }, { fromWeek: "0000-W00", version: 1 }]), [2], "in any order");
  assert.deepEqual(decodeSeedGenerators([{ fromWeek: "0000-W00", version: 1 }, { fromWeek: "2026-W44", version: 2 }, { fromWeek: "2026-W45", version: 1 }]), [1]);
  assert.throws(() => decodeSeedGenerators([]), /no generator/);
  assert.throws(() => decodeSeedGenerators([3]), /unsupported/);
  assert.throws(() => decodeSeedGenerators([{ fromWeek: "0000-W00", version: 9 }]), /unsupported/);
  assert.throws(() => decodeSeedGenerators([{ fromWeek: "0000-W00", version: 1 }, 2]), TypeError);
  assert.throws(() => decodeSeedGenerators("nope"), TypeError);
});

test("a seed starts on Classic, changes straight away, and keeps its choice per seed", async () => {
  const store = new MemoryStore();
  const r = new SeedRepository(store, () => NOW);
  await r.use(s("test-secret-0123456789", 2));
  assert.deepEqual(r.generators(), [1]);
  assert.deepEqual((await r.week()).generators, [1]);
  r.setGenerators([2, 1]);
  assert.deepEqual(r.generators(), [1, 2]);
  assert.deepEqual((await r.week()).generators, [1, 2]);
  const key = `seed-generator-${r.profile()!.fingerprint.slice(1)}`;
  assert.equal(store.get(key), "[1,2]");
  assert.throws(() => r.setGenerators([]), /no generator/);
  assert.throws(() => r.setGenerators([3]), /unsupported/);
  assert.equal(store.get(key), "[1,2]", "nothing is stored for an invalid choice");

  // Another seed has its own; coming back finds this one's.
  await r.use(s("two", 2));
  assert.deepEqual(r.generators(), [1]);
  await r.use(s("test-secret-0123456789", 2));
  assert.deepEqual(r.generators(), [1, 2]);

  // A stored #64 schedule reads as its latest entry; something unreadable as Classic.
  store.set(key, JSON.stringify([{ fromWeek: "0000-W00", version: 1 }, { fromWeek: "2026-W45", version: 2 }]));
  assert.deepEqual(r.generators(), [2]);
  store.set(key, "{not json");
  assert.deepEqual(r.generators(), [1]);
  r.leave();
  assert.throws(() => r.generators(), /no seed is active/);
});

test("seed weeks list Classic unless told otherwise", async () => {
  const w = await seedWeek(s("test-secret-0123456789"), NOW);
  assert.deepEqual(w.generators, [1]);
});

test("seed play keeps games, history and the share text per generator", async () => {
  const store = new MemoryStore();
  const r = new SeedRepository(store, () => NOW);
  await r.use(s("test-secret-0123456789", 2));
  r.setGenerators([1, 2]);
  const today = r.today();
  const classic = (await r.puzzles(today, C))[0]!;
  const graded = (await r.puzzles(today, G))[0]!;
  const w = await r.week();
  assert.deepEqual(graded.givens, generateDayV2(parseWeekSeed(w.seed), 2, 2)[0]!.givens);
  assert.equal(await r.puzzles(today, G).then((p) => p[0]), graded, "cached");

  r.saveGame(C, today, 1, Game.create(classic.givens), 0);
  r.saveGame(G, today, 1, Game.create(graded.givens), 0);
  assert.ok(r.loadGame(C, today, classic));
  assert.ok(r.loadGame(G, today, graded));
  assert.equal(r.loadGame(C, today, graded), null);
  const fp = r.profile()!.fingerprint.slice(1);
  assert.deepEqual(Object.keys(JSON.parse(store.get(`seed-games-${fp}`)!)), [`${today}/1`, `g2/${today}/1`]);

  const first = r.complete(G, today, 1, solveGame(graded, 61_000));
  assert.equal(first.generator, G);
  assert.deepEqual(r.complete(G, today, 1, solveGame(graded, 1_000)), first, "the first result counts");
  r.complete(C, today, 2, solveGame((await r.puzzles(today, C))[1]!, 62_000));
  assert.deepEqual([...r.results(today, G).keys()], [1]);
  assert.deepEqual([...r.results(today, C).keys()], [2]);
  assert.deepEqual(r.history().map((x) => [x.generator, x.level]), [[C, 2], [G, 1]]);
  assert.equal(await r.summary(today, G), `Sudoku ${today} ${r.profile()!.fingerprint}\nEasy 1:01\nDiabolical -\nSolved 1/2 in 1:01`);

  // History from before there were several generators has none: Classic's.
  store.set(`seed-history-${fp}`, JSON.stringify([{ date: today, level: 1, levels: 2, elapsedMs: 5, completedAt: "c" }]));
  assert.equal(r.history()[0]!.generator, C);

  // A game next week drops this week's, of every generator.
  r.saveGame(G, "2026-11-03", 1, Game.create(graded.givens), 0);
  assert.deepEqual(Object.keys(JSON.parse(store.get(`seed-games-${fp}`)!)), ["g2/2026-11-03/1"]);
});

// Wording

test("the admin and seed cards offer Classic, Graded or both", () => {
  assert.deepEqual(GENERATOR_CHOICES.map((c) => [c.label, c.enabled]), [["Classic", [1]], ["Graded", [2]], ["Both", [1, 2]]]);
  assert.equal(sameGenerators([1, 2], [1, 2]), true);
  assert.equal(sameGenerators([1], [1, 2]), false);
  assert.equal(sameGenerators([1], [2]), false);
  assert.equal(generatorsSummary([2]), "Graded");
  assert.equal(generatorsSummary([1, 2]), "Classic and Graded");
});

test("the explainer says which generator is used with a server, points to the switch with both, and to the seed card in seed play", () => {
  const one = generatorHelp({ enabled: [G], seed: false });
  assert.equal(one.title, "Classic and Graded puzzles");
  assert.deepEqual(one.levels.map((l) => l.name), ["Easy", "Medium", "Hard", "Expert", "Diabolical"]);
  assert.equal(one.intro[0], "Puzzles here use Graded.");
  assert.equal(one.intro.length, 3);
  assert.equal(one.outro[1], "Endless uses the same generator as the daily puzzles, with its own series numbered from #1.");
  for (const text of [...one.intro, ...one.outro]) {
    assert.doesNotMatch(text, /choose|choice|pick|switch|ask|both|next week/i, "players with a server and one generator have no say");
  }
  assert.equal(generatorHelp({ enabled: [C], seed: false }).intro[0], "Puzzles here use Classic.");

  const both = generatorHelp({ enabled: [C, G], seed: false });
  assert.equal(both.intro[0], "You can play Classic or Graded: pick with the switch on the Daily and Endless tabs.");
  assert.match(both.outro[1]!, /^Each generator has its own daily puzzles, Endless series, leaderboards and stats/);

  const seedOne = generatorHelp({ enabled: [C], seed: true });
  assert.equal(seedOne.intro[0], "This seed's puzzles use Classic.");
  assert.match(seedOne.outro[1]!, /^You choose the generators for this seed in the seed card: Classic, Graded or both\./);
  const seedBoth = generatorHelp({ enabled: [C, G], seed: true });
  assert.equal(seedBoth.intro[0], both.intro[0]);
  assert.equal(seedBoth.outro[1], seedOne.outro[1]);

  const unloaded = generatorHelp({ enabled: null, seed: false });
  assert.equal(unloaded.intro.length, 2, "no lead line before a week is loaded");
  assert.match(unloaded.intro[0]!, /^Classic decides/);
  assert.equal(unloaded.outro[1], one.outro[1]);

  for (const help of [one, both, seedOne, seedBoth, unloaded]) {
    for (const text of [help.title, ...help.intro, ...help.outro, ...help.levels.map((l) => l.text)]) {
      assert.ok(!text.includes("\u2014"), "no em dashes");
      assert.doesNotMatch(text, /next week|pending/i, "nothing waits for next week any more");
    }
  }
});

// The controller

function makeHost(): Host {
  return {
    location: { hash: "", pathname: "/", search: "", origin: "https://sudoku.test" } as Location,
    history: { replaceState: () => {} } as unknown as History,
    baseUri: () => "https://sudoku.test/",
    isVisible: () => true,
    nowMs: () => 10_000,
    wallMs: () => NOW,
    reloadPage: () => {},
  };
}

async function idle(c: AppController): Promise<void> {
  await settled();
  while (c.syncing) await settled();
  await settled();
}

async function env(configure: (server: FakeServer) => void = () => {}, store = new MemoryStore()) {
  const server = new FakeServer(() => NOW);
  server.levels = 2;
  configure(server);
  const repo = new SudokuRepository(new AppStorage(store), REDIRECT, "", () => NOW, server.fetch);
  await repo.signInDev("https://sudoku.test", "alice", "Alice");
  const seeds = new SeedRepository(new MemoryStore(), () => NOW);
  const c = new AppController(repo, seeds, makeHost());
  c.start();
  await idle(c);
  assert.equal(c.phase.kind, "ready");
  return { c, server, repo, seeds, store };
}

/** Solves today's game `level` of the generator in use through the controller. */
function solveToday(c: AppController, level: number): void {
  c.openPuzzle(level);
  const p = c.puzzle(level)!;
  c.update(level, (g) => g.resume(10_000), { a: "resume" });
  for (let i = 0; i < 81; i++) {
    if (p.givens[i] === "0") c.update(level, (g) => g.place(i, Number(p.solution[i]), 20_000), { a: "place", c: i, d: Number(p.solution[i]) });
  }
  assert.ok(c.games.get(level)!.isComplete);
}

test("with one generator enabled the controller plays it, whatever the player picked before", async () => {
  const store = new MemoryStore();
  store.set("generator", "1");
  const { c } = await env((server) => { server.generators = [2]; }, store);
  assert.deepEqual(c.generators, [G]);
  assert.equal(c.generator, G);
  assert.deepEqual(c.puzzles!.map((p) => p.givens), generateDayV2(parseWeekSeed(c.week!.seed), 2, 2).map((p) => p.givens));
  // A generator that isn't enabled can't be picked.
  await c.chooseGenerator(C);
  assert.equal(c.generator, G);
  assert.equal(store.get("generator"), "1");
});

test("without a week the controller plays Classic", async () => {
  const { c } = await env((server) => { server.reportsGenerator = false; });
  assert.deepEqual(c.generators, [C]);
  await c.signOut();
  assert.equal(c.week, null);
  assert.deepEqual(c.generators, [C]);
  assert.equal(c.generator, C);
});

test("with both enabled the default is the first, and the switch picks the other for Daily and Endless", async () => {
  const { c, server, store } = await env((server) => { server.generators = [1, 2]; });
  assert.equal(c.generator, C);
  const classic = c.puzzles!.map((p) => p.givens);
  solveToday(c, 1);
  await idle(c);
  assert.equal(c.statusOf(1).kind, "done");

  await c.chooseGenerator(G);
  assert.equal(store.get("generator"), "2");
  assert.equal(c.generator, G);
  const graded = c.puzzles!.map((p) => p.givens);
  assert.deepEqual(graded, generateDayV2(parseWeekSeed(c.week!.seed), 2, 2).map((p) => p.givens));
  assert.notDeepEqual(graded, classic);
  assert.equal(c.statusOf(1).kind, "new", "Graded's game 1 is its own");
  assert.equal(c.endlessSummaries()![0]!.next, 1);

  // Offline, a solved Graded game is queued, shown as such, then uploaded with its generator.
  server.online = false;
  solveToday(c, 1);
  assert.deepEqual(c.screen, { kind: "play", generator: G, level: 1 });
  await until(() => !c.syncing && c.notice !== null);
  c.openToday();
  assert.deepEqual(c.statusOf(1), { kind: "done", elapsedMs: 10_000, synced: false });
  server.online = true;
  c.sync();
  await idle(c);
  assert.deepEqual(server.stored.map((r) => [r.generator, r.level]), [[C, 1], [G, 1]]);
  assert.deepEqual(c.statusOf(1), { kind: "done", elapsedMs: 10_000, synced: true });

  // Back to Classic: its game is still solved; the pick survives a restart.
  await c.chooseGenerator(C);
  assert.deepEqual(c.puzzles!.map((p) => p.givens), classic);
  assert.equal(c.statusOf(1).kind, "done");
  await c.chooseGenerator(G);
  const again = new AppController(new SudokuRepository(new AppStorage(store), REDIRECT, "", () => NOW, server.fetch),
    new SeedRepository(new MemoryStore(), () => NOW), makeHost());
  again.start();
  await idle(again);
  assert.equal(again.generator, G);
  assert.deepEqual(again.puzzles!.map((p) => p.givens), graded);

  // The admin turns Graded off: the pick no longer applies, and the default plays.
  server.generators = [1];
  again.sync();
  await idle(again);
  assert.equal(again.generator, C);
  assert.deepEqual(again.puzzles!.map((p) => p.givens), classic);
});

test("the daily leaderboard opens on the generator in use and switches between them", async () => {
  const { c, server } = await env((server) => { server.generators = [1, 2]; });
  c.showScoresGenerator(G); // not on the leaderboard: ignored
  assert.equal(c.screen.kind, "today");
  await c.chooseGenerator(G);
  c.openScores();
  assert.deepEqual(c.screen, { kind: "scores", date: c.today, tab: 0, generator: G });
  await until(() => c.leaderboard !== null);
  assert.equal(server.requests.at(-1)!.url.searchParams.get("generator"), "2");

  c.showScoresTab(1);
  c.showScoresGenerator(C);
  assert.deepEqual(c.screen, { kind: "scores", date: c.today, tab: 1, generator: C });
  await until(() => c.leaderboard !== null);
  assert.equal(server.requests.at(-1)!.url.searchParams.get("generator"), "1");

  // Moving through the days keeps the generator, and so does a retry after a failure.
  c.shiftScoresDate(-1);
  assert.deepEqual(c.screen, { kind: "scores", date: "2026-10-26", tab: 1, generator: C });
  await until(() => c.leaderboard !== null);
  assert.equal(server.requests.at(-1)!.url.searchParams.get("generator"), "1");
  server.online = false;
  c.openScores(0, c.today, G);
  await until(() => c.leaderboardError !== null);
  server.online = true;
  c.sync();
  await idle(c);
  await until(() => c.leaderboard !== null);
  assert.equal(server.requests.filter((r) => r.url.pathname === "/api/v1/leaderboard").at(-1)!.url.searchParams.get("generator"), "2");

  // "See scores" after a game goes to the generator in use.
  c.openScoresFor(2);
  assert.deepEqual(c.screen, { kind: "scores", date: c.today, tab: 2, generator: G });
});

test("Stats opens on the generator in use and can show the other one", async () => {
  const { c, server } = await env((server) => { server.generators = [1, 2]; });
  c.showStatsGenerator(C); // not on the Stats screen: ignored
  assert.equal(c.statsGenerator, null);
  await c.chooseGenerator(G);

  c.openStats();
  assert.equal(c.statsGenerator, G);
  await until(() => c.stats !== null);
  assert.equal(c.stats!.generator, G);
  assert.equal(server.requests.at(-1)!.url.search, "?generator=2");

  c.showStatsGenerator(C);
  assert.equal(c.stats, null, "the numbers are cleared while loading");
  await until(() => c.stats !== null);
  assert.equal(c.stats!.generator, C);
  assert.equal(c.statsGenerator, C);

  // A sync keeps the generator shown.
  c.sync();
  await idle(c);
  assert.equal(c.stats!.generator, C);

  // Opening the screen again goes back to the one in use.
  c.openToday();
  c.openStats();
  await until(() => c.stats !== null && c.statsGenerator === G);
  assert.equal(c.stats!.generator, G);

  server.statsStatus = 500;
  c.showStatsGenerator(C);
  await until(() => c.statsError !== null);
  assert.equal(c.statsError, "stats broke");
});

test("the Endless tab and its leaderboard follow the pick", async () => {
  const { c, server } = await env((server) => { server.generators = [1, 2]; });
  c.openEndlessScores(1);
  assert.deepEqual(c.screen, { kind: "endless-scores", generator: C, difficulty: 1, number: null });
  c.openToday();
  await c.chooseGenerator(G);
  c.openEndlessScores(1);
  assert.deepEqual(c.screen, { kind: "endless-scores", generator: G, difficulty: 1, number: null });
  await until(() => c.endlessProgress !== null);
  assert.equal(server.requests.at(-1)!.url.searchParams.get("generator"), "2");
  c.openToday();
  c.openEndless({ generator: G, difficulty: 1, number: 1 });
  c.update({ generator: G, difficulty: 1, number: 1 }, (g) => g.resume(10_000), { a: "resume" });
  c.openToday();
  await c.chooseGenerator(C);
  assert.deepEqual(c.endlessElsewhere().map((g) => [g.generator, g.number]), [[G, 1]]);
});

test("the admin page's generator change syncs the app", async () => {
  const { c, server } = await env((server) => {
    server.admin = true;
    server.generators = [1];
  });
  c.openAdmin();
  await until(() => c.admin!.generators !== null);
  await c.admin!.chooseGenerators([1, 2]);
  await idle(c);
  assert.deepEqual(server.generators, [1, 2]);
  assert.deepEqual(c.generators, [1, 2]);
});

test("serverless play changes the seed's generators straight away and has the switch with both", async () => {
  const { c, seeds } = await env();
  await c.setSeedGenerators([2]); // not playing a seed: nothing happens
  assert.deepEqual(c.generators, [C]);

  c.useSeed(s("test-secret-0123456789", 2));
  await until(() => c.phase.kind === "ready" && c.seed !== null && c.week !== null);
  assert.deepEqual(c.generators, [C]);
  const classic = c.puzzles!.map((p) => p.givens);

  await c.setSeedGenerators([G]);
  assert.deepEqual(c.generators, [G]);
  assert.equal(c.generator, G);
  const graded = c.puzzles!.map((p) => p.givens);
  assert.deepEqual(graded, generateDayV2(parseWeekSeed(c.week!.seed), 2, 2).map((p) => p.givens));
  await assert.rejects(c.setSeedGenerators([]), /no generator/);
  await assert.rejects(c.setSeedGenerators([5]), /unsupported generator version: 5/);
  assert.deepEqual(seeds.generators(), [G], "an invalid choice is refused before anything is stored");

  // Both: the switch picks one; solving records it per generator.
  await c.setSeedGenerators([C, G]);
  assert.equal(c.generator, C, "the first enabled, until the player picks");
  await c.chooseGenerator(C);
  assert.deepEqual(c.puzzles!.map((p) => p.givens), classic);
  solveToday(c, 1);
  assert.equal(seeds.results(c.today, C).get(1)!.generator, C);
  assert.equal(seeds.results(c.today, G).size, 0);
  assert.match(await c.resultsSummary(), /Solved 1\/2/);
  await c.chooseGenerator(G);
  assert.equal(c.statusOf(1).kind, "new");
  assert.match(await c.resultsSummary(), /Solved 0\/2/);
  await c.chooseGenerator(C);
  assert.deepEqual(c.statusOf(1), { kind: "done", elapsedMs: 10_000, synced: true }, "Classic's result and game are back");
  assert.ok(c.games.get(1)!.isComplete);

  // Leaving the seed goes back to the server's week; the setting itself stays with the seed.
  c.leaveSeed();
  assert.equal(seeds.profile(), null);
  await until(() => c.week !== null && c.seed === null);
  assert.deepEqual(c.generators, [C]);
});
