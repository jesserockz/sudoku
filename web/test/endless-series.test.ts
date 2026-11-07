// Endless puzzles come in one numbered series per generator version (Classic, Graded), each with its own progress.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SudokuApi } from "../src/api/client.ts";
import {
  decodeAdminEndlessResult, decodeEndlessBoard, decodeEndlessProgress, decodeEndlessResult, decodeMyEndlessResults,
} from "../src/api/models.ts";
import { AppStorage, endlessGameKey, parseEndlessGameKey } from "../src/data/app-storage.ts";
import { EndlessPuzzleCache, endlessInProgressOf } from "../src/data/endless.ts";
import { SudokuRepository } from "../src/data/repository.ts";
import { endlessKey } from "../src/data/result-sync.ts";
import { MemoryStore } from "../src/data/store.ts";
import { Game } from "../src/game/game.ts";
import { generateEndless } from "../src/generator/generator.ts";
import { generateEndlessV2 } from "../src/generator/generator-v2.ts";
import { GENERATOR_CLASSIC, GENERATOR_GRADED, generateEndlessVersion } from "../src/generator/versions.ts";
import { parseWeekSeed } from "../src/generator/week-seed.ts";
import { seedSettings as s } from "../src/serverless/seed.ts";
import { SeedRepository } from "../src/serverless/seed-repository.ts";
import { AppController, type EndlessRef, type Host } from "../src/ui/controller.ts";
import { ENDLESS_SEED, FakeServer } from "./fake-server.ts";

const NOW = Date.parse("2026-10-27T01:00:00Z"); // Tuesday, 2026-W44
const REDIRECT = "https://sudoku.test/auth/callback";
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(done: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(done(), "condition never became true");
}

const C = GENERATOR_CLASSIC;
const G = GENERATOR_GRADED;
const ref = (generator: number, difficulty: number, number: number): EndlessRef => ({ generator, difficulty, number });
const seed = parseWeekSeed(ENDLESS_SEED);

function solveGame(p: { givens: string; solution: string }, ms = 60_000): Game {
  let g = Game.create(p.givens).resume(0);
  for (let i = 0; i < 81; i++) if (p.givens[i] === "0") g = g.place(i, Number(p.solution[i]), ms);
  assert.ok(g.isComplete);
  return g;
}

// Keys and puzzles

test("Classic keeps its old game key; other series are prefixed, and both parse back", () => {
  assert.equal(endlessGameKey(C, 2, 7), "2/7");
  assert.equal(endlessGameKey(G, 2, 7), "g2/2/7");
  assert.deepEqual(parseEndlessGameKey("2/7"), { generator: C, difficulty: 2, number: 7 });
  assert.deepEqual(parseEndlessGameKey("g2/2/7"), { generator: G, difficulty: 2, number: 7 });
  assert.equal(endlessKey({ generator: G, difficulty: 4, number: 12, elapsedMs: 1, completedAt: "x" }), "g2/4/12");
  assert.equal(endlessKey({ generator: C, difficulty: 4, number: 12, elapsedMs: 1, completedAt: "x" }), "4/12");
});

test("endlessInProgressOf reads both key styles, skips finished games and sorts by series", () => {
  const unfinished = Game.create(generateEndless(seed, 1, 1).givens).resume(0);
  const finished = solveGame(generateEndless(seed, 1, 2));
  const games = {
    "g2/1/3": unfinished.save(3000),
    "2/10": unfinished.save(1000),
    "g2/1/1": unfinished.save(2000),
    "2/9": unfinished.save(500),
    "1/2": finished.save(0),
  };
  assert.deepEqual(endlessInProgressOf(games).map((g) => [g.generator, g.difficulty, g.number, g.elapsedMs]), [
    [C, 2, 9, 500], [C, 2, 10, 1000], [G, 1, 1, 2000], [G, 1, 3, 3000],
  ]);
  assert.deepEqual(endlessInProgressOf(null), []);
});

test("generateEndlessVersion picks the generator, and the cache keeps the series apart", () => {
  assert.equal(generateEndlessVersion(C, seed, 3, 4).givens, generateEndless(seed, 3, 4).givens);
  assert.equal(generateEndlessVersion(G, seed, 3, 4).givens, generateEndlessV2(seed, 3, 4).puzzle.givens);
  assert.notEqual(generateEndlessVersion(C, seed, 3, 4).givens, generateEndlessVersion(G, seed, 3, 4).givens);
  assert.throws(() => generateEndlessVersion(3, seed, 3, 4), /unknown generator version: 3/);

  const cache = new EndlessPuzzleCache();
  const classic = cache.get(ENDLESS_SEED, C, 3, 4);
  const graded = cache.get(ENDLESS_SEED, G, 3, 4);
  assert.notEqual(classic.givens, graded.givens);
  assert.equal(cache.get(ENDLESS_SEED, G, 3, 4), graded);
  assert.equal(cache.get(ENDLESS_SEED, C, 3, 4).givens, classic.givens);
});

// Models and client

test("endless results and boards carry their series, and results from before it are Classic's", () => {
  const base = { difficulty: 2, number: 7, elapsedMs: 9000, completedAt: "2026-10-27T01:00:00Z" };
  assert.equal(decodeEndlessResult(base).generator, C);
  assert.equal(decodeEndlessResult({ ...base, generator: 2 }).generator, G);
  assert.throws(() => decodeEndlessResult({ ...base, generator: 3 }), /unsupported generator version: 3/);
  assert.deepEqual(decodeMyEndlessResults({ results: [base, { ...base, generator: 2 }] }).results.map((r) => r.generator), [C, G]);

  assert.equal(decodeEndlessProgress({ difficulties: [] }).generator, C);
  assert.equal(decodeEndlessProgress({ generator: 2, difficulties: [] }).generator, G);
  assert.equal(decodeEndlessBoard({ difficulty: 1, number: 1, entries: [] }).generator, C);
  assert.equal(decodeEndlessBoard({ generator: 2, difficulty: 1, number: 1, entries: [] }).generator, G);

  const admin = {
    userId: "u", displayName: "U", difficulty: 1, number: 2, elapsedMs: 5, completedAt: "c", submittedAt: "s", replay: "valid", replayError: "", flag: null,
  };
  assert.equal(decodeAdminEndlessResult(admin).generator, C);
  assert.equal(decodeAdminEndlessResult({ ...admin, generator: 2 }).generator, G);
});

test("the client asks for a series' leaderboards and sends the series with a result", async () => {
  const server = new FakeServer(() => NOW);
  const client = new SudokuApi("https://sudoku.test", async () => "dev:alice:Alice", server.fetch);
  const r = { generator: G, difficulty: 3, number: 4, elapsedMs: 8000, completedAt: "2026-10-27T01:00:00Z" };
  assert.deepEqual(await client.submitEndlessResult(r), { kind: "created", result: r });
  // The same number in the other series is another puzzle.
  const classic = { ...r, generator: C };
  assert.equal((await client.submitEndlessResult(classic)).kind, "created");
  assert.equal((await client.submitEndlessResult({ ...r, elapsedMs: 1 })).kind, "stored");
  assert.deepEqual((await client.myEndlessResults()).results.map((x) => x.generator), [G, C]);

  const graded = await client.endlessProgress(G);
  assert.equal(graded.generator, G);
  assert.equal(graded.difficulties[2]!.players[0]!.completed, 1);
  assert.equal((await client.endlessBoard(G, 3, 4)).generator, G);
  assert.deepEqual(server.requests.slice(-2).map((q) => q.url.pathname + q.url.search), [
    "/api/v1/endless/leaderboard?generator=2", "/api/v1/endless/leaderboard/3/4?generator=2",
  ]);
  assert.equal((await client.endlessBoard(C, 3, 4)).entries.length, 1);
  assert.equal(server.requests.at(-1)!.url.search, "?generator=1");
});

// Repository

async function repoEnv(): Promise<{ repo: SudokuRepository; server: FakeServer; store: MemoryStore }> {
  const server = new FakeServer(() => NOW);
  const store = new MemoryStore();
  const repo = new SudokuRepository(new AppStorage(store), REDIRECT, "", () => NOW, server.fetch);
  await repo.signInDev("https://sudoku.test", "alice", "Alice");
  return { repo, server, store };
}

test("the repository plays, saves and queues each series on its own", async () => {
  const { repo, server } = await repoEnv();
  const unseeded = new SudokuRepository(new AppStorage(new MemoryStore()), REDIRECT, "", () => NOW, server.fetch);
  assert.equal(unseeded.endlessReady(), false);
  assert.equal(unseeded.endlessPuzzle(G, 1, 1), null);
  await repo.refresh();
  assert.equal(repo.endlessReady(), true);

  const classic = repo.endlessPuzzle(C, 2, 3)!;
  const graded = repo.endlessPuzzle(G, 2, 3)!;
  assert.equal(classic.givens, generateEndless(seed, 2, 3).givens);
  assert.equal(graded.givens, generateEndlessV2(seed, 2, 3).puzzle.givens);
  assert.notEqual(classic.givens, graded.givens);

  // Saved games live under their own keys, and only load for their own series.
  repo.saveEndlessGame(G, 2, 3, Game.create(graded.givens).resume(0), 4000);
  repo.saveEndlessGame(C, 2, 3, Game.create(classic.givens).resume(0), 1000);
  assert.deepEqual(repo.endlessInProgress().map((g) => [g.generator, g.difficulty, g.number, g.elapsedMs]), [[C, 2, 3, 1000], [G, 2, 3, 4000]]);
  assert.equal(repo.loadEndlessGame(G, graded)!.elapsedMs(9999), 4000);
  assert.equal(repo.loadEndlessGame(C, classic)!.elapsedMs(9999), 1000);
  assert.equal(repo.loadEndlessGame(G, classic), null, "nothing saved for this series' key");

  // Finishing the Graded one queues a Graded result, and the Classic game is not solved by it.
  const solved = solveGame(graded);
  repo.saveEndlessGame(G, 2, 3, solved, 5000);
  const result = await repo.completeEndless(G, 2, 3, solved);
  assert.equal(result.generator, G);
  assert.deepEqual([...repo.endlessSolved().keys()], ["g2/2/3"]);
  await repo.refresh();
  assert.deepEqual(server.storedEndless.map((r) => [r.generator, r.difficulty, r.number]), [[G, 2, 3]]);
  assert.deepEqual([...repo.endlessSolved()], [["g2/2/3", { elapsedMs: 60_000, synced: true }]]);
  // The finished game was pruned once the server had it; the other series' game stays.
  assert.deepEqual(repo.endlessInProgress().map((g) => [g.generator, g.number]), [[C, 3]]);
  assert.equal((await repo.endlessProgress(G)).difficulties[1]!.players[0]!.completed, 1);
  assert.equal((await repo.endlessProgress(C)).difficulties[1]!.players.length, 0);
  assert.equal((await repo.endlessBoard(G, 2, 3)).entries.length, 1);
  assert.equal((await repo.endlessBoard(C, 2, 3)).entries.length, 0);
});

test("results and games stored before the series existed are Classic's", async () => {
  const { repo, server, store } = await repoEnv();
  server.storedEndless.push({ difficulty: 1, number: 4, elapsedMs: 7000, completedAt: "x" });
  await repo.refresh();
  assert.deepEqual([...repo.endlessSolved()], [["1/4", { elapsedMs: 7000, synced: true }]]);
  store.set("endless-pending", JSON.stringify([{ difficulty: 2, number: 2, elapsedMs: 9000, completedAt: "x" }]));
  assert.deepEqual([...repo.endlessSolved().keys()], ["2/2", "1/4"]);
  assert.equal(repo.endlessSync.pending()[0]!.generator, C);
});

// Serverless play

test("seed play keeps a series per generator, with its own history", async () => {
  const store = new MemoryStore();
  const seeds = new SeedRepository(store, () => NOW);
  assert.equal(seeds.endlessReady(), false);
  await seeds.use(s("test-secret-0123456789"));
  assert.equal(seeds.endlessReady(), false);
  assert.equal(seeds.endlessPuzzle(G, 1, 1), null);
  await seeds.loadEndless();
  assert.equal(seeds.endlessReady(), true);
  await seeds.use(s("rimu"));
  assert.equal(seeds.endlessReady(), false, "another seed has to load its own");
  await seeds.use(s("test-secret-0123456789"));

  const classic = seeds.endlessPuzzle(C, 1, 5)!;
  const graded = seeds.endlessPuzzle(G, 1, 5)!;
  assert.notEqual(classic.givens, graded.givens);
  assert.equal(graded.givens, generateEndlessV2(seed, 1, 5).puzzle.givens);

  seeds.saveEndlessGame(G, 1, 5, Game.create(graded.givens).resume(0), 2000);
  assert.equal(seeds.loadEndlessGame(C, graded), null);
  assert.equal(seeds.loadEndlessGame(G, graded)!.elapsedMs(5000), 2000);
  assert.deepEqual(seeds.endlessInProgress().map((g) => [g.generator, g.number]), [[G, 5]]);

  await seeds.completeEndless(G, 1, 5, solveGame(graded, 70_000));
  assert.deepEqual(seeds.endlessInProgress(), [], "solving drops the saved game");
  // The first result of each series counts, and the other series is still open.
  assert.equal((await seeds.completeEndless(G, 1, 5, solveGame(graded, 30_000))).elapsedMs, 70_000);
  assert.equal((await seeds.completeEndless(C, 1, 5, solveGame(classic, 30_000))).elapsedMs, 30_000);
  await seeds.completeEndless(C, 1, 2, solveGame(seeds.endlessPuzzle(C, 1, 2)!, 40_000));
  assert.deepEqual(seeds.endlessHistory().map((r) => [r.generator, r.number]), [[C, 2], [C, 5], [G, 5]]);
  assert.deepEqual([...seeds.endlessSolved().keys()], ["1/2", "1/5", "g2/1/5"]);

  // History from before the series existed has no generator, and is Classic's.
  const fingerprint = seeds.profile()!.fingerprint.slice(1);
  store.set(`seed-endless-history-${fingerprint}`, JSON.stringify([{ difficulty: 3, number: 1, elapsedMs: 1000, completedAt: "x" }]));
  assert.deepEqual(seeds.endlessHistory().map((r) => r.generator), [C]);
});

// Controller

interface Env {
  c: AppController;
  repo: SudokuRepository;
  server: FakeServer;
  clock: { mono: number };
}

async function startController(repo: SudokuRepository, seeds: SeedRepository, clock: { mono: number }): Promise<AppController> {
  const host: Host = {
    location: { hash: "", pathname: "/", search: "", origin: "https://sudoku.test" } as Location,
    history: { replaceState: () => {} } as unknown as History,
    baseUri: () => "https://sudoku.test/",
    isVisible: () => true,
    nowMs: () => clock.mono,
    wallMs: () => NOW,
    reloadPage: () => {},
  };
  const c = new AppController(repo, seeds, host);
  c.start();
  await until(() => c.phase.kind === "ready");
  await until(() => !c.syncing);
  await settled();
  return c;
}

async function env(configure: (server: FakeServer) => void = () => {}): Promise<Env> {
  const clock = { mono: 10_000 };
  const server = new FakeServer(() => NOW);
  configure(server);
  const repo = new SudokuRepository(new AppStorage(new MemoryStore()), REDIRECT, "", () => NOW, server.fetch);
  await repo.signInDev("https://sudoku.test", "alice", "Alice");
  const c = await startController(repo, new SeedRepository(new MemoryStore(), () => NOW), clock);
  return { c, repo, server, clock };
}

async function syncNow(c: AppController): Promise<void> {
  c.sync();
  await until(() => !c.syncing);
  await settled();
}

/** Plays `r`, leaving the last `leave` cells empty. Returns a function that places one more digit. */
function play(e: Env, r: EndlessRef, leave = 0): () => void {
  const { c, clock } = e;
  c.openEndless(r);
  assert.equal(c.screen.kind, "endless-play");
  const p = c.puzzleOf(r)!;
  const cells = [...p.givens].flatMap((g, i) => (g === "0" ? [i] : []));
  c.update(r, (g) => g.resume(clock.mono), { a: "resume" });
  const place = (cell: number): void => {
    clock.mono += 100;
    const d = Number(p.solution[cell]);
    c.update(r, (g) => g.place(cell, d, clock.mono), { a: "place", c: cell, d });
  };
  cells.slice(0, cells.length - leave).forEach(place);
  const rest = cells.slice(cells.length - leave);
  return () => place(rest.shift()!);
}

test("the Endless tab plays the series of the week's generator, and it follows the week", async () => {
  const e = await env((server) => { server.generator = 2; });
  const { c, server } = e;
  assert.equal(c.endlessGenerator, G);
  assert.deepEqual(c.endlessSummaries()![0], { difficulty: 1, solved: 0, highest: 0, next: 1, inProgress: [] });

  // Solve Graded #1 of Easy, and leave Graded #2 half done.
  const finish = play(e, ref(G, 1, 1), 1);
  finish();
  await until(() => e.repo.endlessSync.pending().length === 1 || server.storedEndless.length === 1);
  await until(() => !c.syncing);
  await settled();
  assert.deepEqual(server.storedEndless.map((r) => [r.generator, r.difficulty, r.number]), [[G, 1, 1]]);
  assert.equal(c.puzzleOf(ref(G, 1, 1))!.givens, generateEndlessV2(seed, 1, 1).puzzle.givens);
  play(e, ref(G, 1, 2), 3);
  c.openToday();
  assert.deepEqual(c.endlessSummaries()![0], { difficulty: 1, solved: 1, highest: 1, next: 2, inProgress: [{ number: 2, elapsedMs: c.endlessStatusOf(ref(G, 1, 2)).kind === "in-progress" ? e.repo.endlessInProgress()[0]!.elapsedMs : -1 }] });

  // The week flips back to Classic: that series starts at #1, and the unfinished Graded game is listed as elsewhere.
  server.generator = 1;
  await syncNow(c);
  assert.equal(c.endlessGenerator, C);
  assert.deepEqual(c.endlessSummaries()![0], { difficulty: 1, solved: 0, highest: 0, next: 1, inProgress: [] });
  assert.deepEqual(c.endlessElsewhere().map((g) => [g.generator, g.difficulty, g.number]), [[G, 1, 2]]);

  // Resuming it works, and it is still a Graded game.
  c.openEndless(ref(G, 1, 2));
  assert.deepEqual(c.screen, { kind: "endless-play", generator: G, difficulty: 1, number: 2 });
  assert.ok(c.gameOf(ref(G, 1, 2)));
  assert.equal(c.puzzleOf(ref(G, 1, 2))!.givens, generateEndlessV2(seed, 1, 2).puzzle.givens);

  // Back to Graded: progress is where it was.
  c.openToday();
  server.generator = 2;
  await syncNow(c);
  assert.equal(c.endlessGenerator, G);
  const back = c.endlessSummaries()![0]!;
  assert.deepEqual([back.solved, back.next, back.inProgress.map((g) => g.number)], [1, 2, [2]]);
  assert.deepEqual(c.endlessElsewhere(), []);
});

test("both series are played at once with the same numbers", async () => {
  const e = await env();
  const { c, server } = e;
  assert.equal(c.endlessGenerator, C);
  play(e, ref(C, 1, 1), 0);
  await until(() => server.storedEndless.length === 1);
  c.openToday();
  server.generator = 2;
  await syncNow(c);
  // #1 of Graded is a different, unsolved puzzle.
  assert.deepEqual(c.endlessStatusOf(ref(G, 1, 1)), { kind: "in-progress", elapsedMs: 0 });
  assert.equal(c.endlessStatusOf(ref(C, 1, 1)).kind, "done");
  assert.equal(c.endlessSummaries()![0]!.solved, 0);
  c.openEndless(ref(C, 1, 1));
  assert.equal(c.screen.kind, "endless-play", "Classic's #1 is solved here, so it replays");
  play(e, ref(G, 1, 1), 0);
  await until(() => server.storedEndless.length === 2);
  assert.deepEqual(server.storedEndless.map((r) => [r.generator, r.number]), [[C, 1], [G, 1]]);
  assert.equal(JSON.stringify(server.requests.filter((r) => r.url.pathname === "/api/v1/endless/results").map((r) => JSON.parse(r.body).generator)), "[1,2]");
});

test("an unknown series is not opened", async () => {
  const { c } = await env();
  c.openEndless(ref(3, 1, 1));
  assert.equal(c.screen.kind, "today");
  c.openEndless(ref(0, 1, 1));
  assert.equal(c.screen.kind, "today");
});

test("the leaderboards are per series: the current one by default, any with an explicit series", async () => {
  const e = await env((server) => {
    server.generator = 2;
    server.storedEndless.push({ generator: 2, difficulty: 1, number: 3, elapsedMs: 5000, completedAt: "x" }, { difficulty: 1, number: 3, elapsedMs: 6000, completedAt: "x" });
  });
  const { c, server } = e;
  c.openEndlessScores(1);
  assert.deepEqual(c.screen, { kind: "endless-scores", generator: G, difficulty: 1, number: null });
  await until(() => c.endlessProgress !== null);
  assert.equal(c.endlessProgress!.generator, G);
  c.openEndlessScores(1, 3, C);
  assert.deepEqual(c.screen, { kind: "endless-scores", generator: C, difficulty: 1, number: 3 });
  await until(() => c.endlessBoard !== null);
  assert.equal(c.endlessBoard!.generator, C);
  assert.deepEqual(c.endlessBoard!.entries.map((x) => x.elapsedMs), [6000]);
  c.openEndlessScores(1, 3);
  await until(() => c.endlessBoard !== null);
  assert.deepEqual(c.endlessBoard!.entries.map((x) => x.elapsedMs), [5000]);

  // "See scores" after solving goes to the puzzle's own series, whatever the tab plays now.
  c.openScoresFor(ref(C, 2, 4));
  assert.deepEqual(c.screen, { kind: "endless-scores", generator: C, difficulty: 2, number: 4 });
  // A failed leaderboard is retried by the next sync, in its own series.
  server.endlessBoardStatus = 500;
  c.openEndlessScores(2, 4, C);
  await until(() => c.leaderboardError !== null);
  server.endlessBoardStatus = null;
  await syncNow(c);
  await until(() => c.endlessBoard !== null);
  assert.equal(c.endlessBoard!.generator, C);
  assert.equal(server.requests.at(-1)!.url.searchParams.get("generator"), "1");

  // Opening a puzzle the server already has for this series shows its scores in that series.
  await syncNow(c);
  c.openEndless(ref(G, 1, 3));
  assert.deepEqual(c.screen, { kind: "endless-scores", generator: G, difficulty: 1, number: 3 });
});

test("without a week the tab plays Classic", async () => {
  const { c } = await env();
  await c.signOut();
  assert.equal(c.week, null);
  assert.equal(c.endlessGenerator, C);
});

// Controller, serverless

test("seed play follows its own generator schedule for the Endless tab", async () => {
  const clock = { mono: 10_000 };
  let now = NOW;
  const store = new MemoryStore();
  const repo = new SudokuRepository(new AppStorage(store), REDIRECT, "");
  const seeds = new SeedRepository(store, () => now);
  await seeds.use(s("test-secret-0123456789"));
  seeds.setGenerator(G); // starts next week
  let c = await startController(repo, seeds, clock);
  assert.equal(c.endlessGenerator, C);

  // Solve a Classic puzzle and start a Graded-to-be one later.
  const e: Env = { c, repo, server: new FakeServer(() => now), clock };
  play(e, ref(C, 1, 1), 0);
  await settled();
  assert.deepEqual(c.endlessSummaries()![0], { difficulty: 1, solved: 1, highest: 1, next: 2, inProgress: [] });
  play(e, ref(C, 1, 2), 2);
  c.openToday();

  // Next week the schedule moves to Graded: a fresh series, and the unfinished Classic game is listed.
  now += 7 * 24 * 3_600_000;
  c = await startController(repo, seeds, clock);
  e.c = c;
  assert.equal(c.week!.generator, G);
  assert.equal(c.endlessGenerator, G);
  assert.deepEqual(c.endlessSummaries()![0], { difficulty: 1, solved: 0, highest: 0, next: 1, inProgress: [] });
  assert.deepEqual(c.endlessElsewhere().map((g) => [g.generator, g.number]), [[C, 2]]);
  const finish = play(e, ref(G, 1, 1), 1);
  finish();
  await settled();
  assert.equal(c.puzzleOf(ref(G, 1, 1))!.givens, generateEndlessV2(parseWeekSeed("3242a2d84b0602b6"), 1, 1).puzzle.givens);
  assert.deepEqual(c.endlessHistory().map((r) => [r.generator, r.number]), [[C, 1], [G, 1]]);
  // A seed has no leaderboard: the history, whatever the series.
  c.openEndlessScores(1, 1, G);
  assert.equal(c.screen.kind, "history");
});
