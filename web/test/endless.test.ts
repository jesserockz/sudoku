import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiException, SudokuApi } from "../src/api/client.ts";
import {
  type EndlessResult, decodeEndlessBoard, decodeEndlessInfo, decodeEndlessProgress, decodeEndlessResult, decodeMyEndlessResults,
} from "../src/api/models.ts";
import { AppStorage } from "../src/data/app-storage.ts";
import { SudokuRepository } from "../src/data/repository.ts";
import { ResultSync, dailyKey, endlessKey } from "../src/data/result-sync.ts";
import { MemoryStore } from "../src/data/store.ts";
import { Game } from "../src/game/game.ts";
import { MAX_REPLAY_EVENTS } from "../src/game/replay.ts";
import { generateEndless } from "../src/generator/generator.ts";
import { parseWeekSeed } from "../src/generator/week-seed.ts";
import { SeedRepository } from "../src/serverless/seed-repository.ts";
import { AppController, ENDLESS_LABEL, type EndlessRef, type Host } from "../src/ui/controller.ts";
import { ENDLESS_SEED, FakeServer } from "./fake-server.ts";

const NOW = Date.parse("2026-10-27T01:00:00Z");
const REDIRECT = "https://sudoku.test/auth/callback";
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
/**
 * Waits for `done`, by the clock rather than a count of event loop turns: a sync waits on WebCrypto (the fake
 * server's week seed), which finishes on a worker thread and can take many turns on a slow CI runner.
 */
async function until(done: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(done(), "condition never became true");
}

// Models

test("decodeEndlessInfo lowercases a good seed and rejects a bad one", () => {
  assert.deepEqual(decodeEndlessInfo({ seed: "3242A2D84B0602B6" }), { seed: ENDLESS_SEED });
  assert.throws(() => decodeEndlessInfo({ seed: "not-a-seed" }));
  assert.throws(() => decodeEndlessInfo({}));
});

test("decodeEndlessResult keeps a replay when there is one", () => {
  const base = { generator: 1, difficulty: 2, number: 7, elapsedMs: 9000, completedAt: "2026-10-27T01:00:00Z" };
  assert.deepEqual(decodeEndlessResult(base), base);
  const replay = { version: 1, events: [{ t: 0, w: 1, a: "start" }] };
  assert.deepEqual(decodeEndlessResult({ ...base, replay }), { ...base, replay });
  assert.deepEqual(decodeMyEndlessResults({ results: [base] }), { results: [base] });
});

test("progress and board decoders default a missing suspicious flag to false", () => {
  const progress = decodeEndlessProgress({
    difficulties: [{
      difficulty: 1,
      players: [
        { rank: 1, userId: "a", displayName: "A", completed: 3, highest: 5 },
        { rank: 2, userId: "b", displayName: "B", completed: 1, highest: 1, suspicious: true },
      ],
    }],
  });
  assert.deepEqual(progress.difficulties[0]!.players.map((p) => p.suspicious), [false, true]);
  const board = decodeEndlessBoard({
    difficulty: 1, number: 5,
    entries: [{ rank: 1, userId: "a", displayName: "A", elapsedMs: 6000 }, { rank: 2, userId: "b", displayName: "B", elapsedMs: 7000, suspicious: true }],
  });
  assert.deepEqual(board.entries.map((e) => e.suspicious), [false, true]);
  assert.equal(board.number, 5);
});

// Result sync

test("result keys", () => {
  assert.equal(dailyKey({ date: "2026-10-27", level: 3, elapsedMs: 1, completedAt: "x" }), "2026-10-27/3");
  assert.equal(endlessKey({ generator: 1, difficulty: 4, number: 12, elapsedMs: 1, completedAt: "x" }), "4/12");
});

test("a sync with the endless key queues one result per puzzle and uploads it", async () => {
  const store = new AppStorage(new MemoryStore());
  const sent: EndlessResult[] = [];
  const sync = new ResultSync<EndlessResult>(store.endlessPending, async (r) => {
    sent.push(r);
    return { kind: "created", result: r };
  }, endlessKey);
  const a: EndlessResult = { generator: 1, difficulty: 1, number: 1, elapsedMs: 5000, completedAt: "x" };
  await sync.enqueue(a);
  await sync.enqueue({ ...a, elapsedMs: 9999 });
  await sync.enqueue({ ...a, number: 2 });
  assert.deepEqual(sync.pending().map((r) => r.number), [1, 2]);
  const report = await sync.flush();
  assert.equal(report.accepted.length, 2);
  assert.deepEqual(sent.map((r) => r.elapsedMs), [5000, 5000]);
  assert.deepEqual(sync.pending(), []);
});

// Storage

test("the home tab decoder rejects junk, and clearProgress forgets endless data", () => {
  const store = new MemoryStore();
  const s = new AppStorage(store);
  assert.equal(s.homeTab.read(), null);
  s.homeTab.write("endless");
  assert.equal(s.homeTab.read(), "endless");
  store.set("home-tab", JSON.stringify("weekly"));
  assert.equal(s.homeTab.read(), null);

  const r: EndlessResult = { generator: 1, difficulty: 1, number: 1, elapsedMs: 5000, completedAt: "x" };
  s.endless.write({ seed: ENDLESS_SEED });
  s.endlessResults.write([r]);
  s.endlessPending.write([r]);
  s.endlessGames.write({ "1/1": Game.create(generateEndless(parseWeekSeed(ENDLESS_SEED), 1, 1).givens).save(0) });
  s.clearProgress();
  assert.equal(s.endlessResults.read(), null);
  assert.equal(s.endlessPending.read(), null);
  assert.equal(s.endlessGames.read(), null);
  // The seed never changes, so it's kept.
  assert.deepEqual(s.endless.read(), { seed: ENDLESS_SEED });
});

// API client

function api(server: FakeServer): SudokuApi {
  return new SudokuApi("https://sudoku.test", async () => "dev:alice:Alice", server.fetch);
}

test("the endless player endpoints", async () => {
  const server = new FakeServer(() => NOW);
  const client = api(server);
  assert.deepEqual(await client.endless(), { seed: ENDLESS_SEED });
  assert.deepEqual(await client.myEndlessResults(), { results: [] });

  const r: EndlessResult = { generator: 1, difficulty: 3, number: 4, elapsedMs: 8000, completedAt: "2026-10-27T01:00:00Z" };
  assert.deepEqual(await client.submitEndlessResult(r), { kind: "created", result: r });
  assert.deepEqual(await client.submitEndlessResult({ ...r, elapsedMs: 1 }), { kind: "stored", result: r });
  assert.deepEqual((await client.myEndlessResults()).results, [r]);
  assert.equal((await client.endlessProgress(1)).difficulties[2]!.players[0]!.completed, 1);
  assert.deepEqual((await client.endlessBoard(1, 3, 4)).entries.map((e) => e.elapsedMs), [8000]);

  server.rejectAll = true;
  const rejected = await client.submitEndlessResult(r);
  assert.equal(rejected.kind, "rejected");
  assert.equal(rejected.kind === "rejected" && rejected.error?.code, "invalid_result");
  server.rejectAll = false;

  server.endlessResultsStatus = 503;
  await assert.rejects(client.submitEndlessResult(r), (e) => e instanceof ApiException && e.status === 503);
});

// Repository

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

const REF: EndlessRef = { generator: 1, difficulty: 1, number: 1 };
const done = (r: SudokuRepository, ref: EndlessRef = REF): Game => solveGame(r.endlessPuzzle(1, ref.difficulty, ref.number)!);

function solveGame(p: { givens: string; solution: string }, ms = 60_000): Game {
  let g = Game.create(p.givens).resume(0);
  for (let i = 0; i < 81; i++) if (p.givens[i] === "0") g = g.place(i, Number(p.solution[i]), ms);
  assert.ok(g.isComplete);
  return g;
}

test("endlessPuzzle is null until the seed is fetched, then cached", async () => {
  const { repo, server } = await repoEnv();
  const unseeded = new SudokuRepository(new AppStorage(new MemoryStore()), REDIRECT, "", () => NOW, server.fetch);
  assert.equal(unseeded.endlessPuzzle(1, 1, 1), null);
  assert.equal(unseeded.endlessSolved().size, 0);
  await repo.refresh();
  const p = repo.endlessPuzzle(1, 2, 3)!;
  const expected = generateEndless(parseWeekSeed(ENDLESS_SEED), 2, 3);
  assert.equal(p.givens, expected.givens);
  assert.equal(p.solution, expected.solution);
  assert.equal(repo.endlessPuzzle(1, 2, 3), p);
  assert.notEqual(repo.endlessPuzzle(1, 2, 4), p);
  assert.equal(repo.endlessPuzzle(1, 2, 3)!.givens, expected.givens);
  assert.equal(server.requests.filter((r) => r.url.pathname === "/api/v1/endless").length, 1);
});

test("refresh fetches the seed once, stores the server's endless results and prunes finished games", async () => {
  const { repo, server } = await repoEnv();
  await repo.refresh();
  await repo.refresh();
  assert.equal(server.requests.filter((r) => r.url.pathname === "/api/v1/endless").length, 1);

  // Three games: finished and on the server (pruned), finished but not uploaded (kept), unfinished (kept).
  const doneGame = done(repo, { generator: 1, difficulty: 1, number: 1 });
  repo.saveEndlessGame(1, 1, 1, doneGame, 0);
  repo.saveEndlessGame(1, 1, 2, done(repo, { generator: 1, difficulty: 1, number: 2 }), 0);
  repo.saveEndlessGame(1, 2, 5, Game.create(repo.endlessPuzzle(1, 2, 5)!.givens), 0);
  server.storedEndless.push({ generator: 1, difficulty: 1, number: 1, elapsedMs: 60_000, completedAt: "x" });
  await repo.refresh();
  assert.deepEqual(repo.endlessInProgress().map((g) => `${g.difficulty}/${g.number}`), ["2/5"]);
  assert.equal(repo.loadEndlessGame(1, repo.endlessPuzzle(1, 1, 1)!), null);
  assert.ok(repo.loadEndlessGame(1, repo.endlessPuzzle(1, 1, 2)!));
  assert.deepEqual([...repo.endlessSolved()], [["1/1", { elapsedMs: 60_000, synced: true }]]);
});

test("refresh uploads queued endless results and merges the two reports", async () => {
  const { repo, server } = await repoEnv();
  await repo.refresh();
  const daily = solveDaily(repo);

  // Nothing wrong: both queues drain.
  await repo.complete(1, repo.today(), 1, daily);
  await repo.completeEndless(1, 1, 1, done(repo));
  let report = await repo.refresh();
  assert.equal(report.accepted.length, 2);
  assert.equal(report.failure, null);
  assert.equal(server.storedEndless.length, 1);

  // Both rejected.
  await repo.complete(1, repo.today(), 2, solveDaily(repo, 2));
  await repo.completeEndless(1, 1, 2, done(repo, { generator: 1, difficulty: 1, number: 2 }));
  server.rejectAll = true;
  report = await repo.refresh();
  assert.equal(report.rejected.length, 2);
  server.rejectAll = false;

  // The daily upload fails, and so does the endless one: the first failure is reported.
  await repo.complete(1, repo.today(), 3, solveDaily(repo, 3));
  await repo.completeEndless(1, 1, 3, done(repo, { generator: 1, difficulty: 1, number: 3 }));
  server.resultsStatus = 503;
  report = await repo.refresh();
  assert.ok(report.failure instanceof ApiException);
  assert.equal(report.remaining.length, 2);
  server.resultsStatus = null;

  // Only the endless upload fails.
  server.endlessResultsStatus = 502;
  report = await repo.refresh();
  assert.equal((report.failure as ApiException).status, 502);
  assert.equal(report.accepted.length, 1);
  assert.equal(report.remaining.length, 1);
});

function solveDaily(r: SudokuRepository, level = 1): Game {
  return solveGame(r.puzzles(r.today(), 1)!.find((p) => p.level === level)!);
}

test("the home tab defaults to daily and is remembered", async () => {
  const { repo, store } = await repoEnv();
  assert.equal(repo.homeTab(), "daily");
  repo.setHomeTab("endless");
  assert.equal(repo.homeTab(), "endless");
  assert.equal(new SudokuRepository(new AppStorage(store), REDIRECT, "", () => NOW, new FakeServer(() => NOW).fetch).homeTab(), "endless");
});

test("endlessSolved lists queued results, and the server's record wins", async () => {
  const { repo, server } = await repoEnv();
  await repo.refresh();
  assert.equal(repo.endlessSolved().size, 0);
  server.endlessResultsStatus = 500;
  await repo.completeEndless(1, 1, 1, done(repo));
  await repo.completeEndless(1, 1, 2, done(repo, { generator: 1, difficulty: 1, number: 2 }));
  await repo.refresh();
  assert.deepEqual(repo.endlessSolved().get("1/1"), { elapsedMs: 60_000, synced: false });
  // The server has a different time for 1/1; it wins.
  server.storedEndless.push({ generator: 1, difficulty: 1, number: 1, elapsedMs: 7000, completedAt: "x" });
  await repo.refresh();
  assert.deepEqual(repo.endlessSolved().get("1/1"), { elapsedMs: 7000, synced: true });
  assert.deepEqual(repo.endlessSolved().get("1/2"), { elapsedMs: 60_000, synced: false });
});

test("endlessInProgress is sorted by difficulty then number and skips finished games", async () => {
  const { repo } = await repoEnv();
  await repo.refresh();
  for (const [d, n] of [[3, 2], [1, 10], [3, 1], [1, 2]] as const) {
    repo.saveEndlessGame(1, d, n, Game.create(repo.endlessPuzzle(1, d, n)!.givens).resume(0), 5000);
  }
  repo.saveEndlessGame(1, 2, 1, done(repo, { generator: 1, difficulty: 2, number: 1 }), 0);
  assert.deepEqual(repo.endlessInProgress().map((g) => [g.difficulty, g.number, g.elapsedMs]), [[1, 2, 5000], [1, 10, 5000], [3, 1, 5000], [3, 2, 5000]]);
});

test("a saved endless game is only loaded if its givens match", async () => {
  const { repo } = await repoEnv();
  await repo.refresh();
  const p = repo.endlessPuzzle(1, 1, 1)!;
  assert.equal(repo.loadEndlessGame(1, p), null);
  repo.saveEndlessGame(1, 1, 1, Game.create(p.givens).resume(0), 1234);
  assert.equal(repo.loadEndlessGame(1, p)!.elapsedMs(9999), 1234);
  // The same key holding another puzzle's game.
  repo.saveEndlessGame(1, 1, 1, Game.create(repo.endlessPuzzle(1, 1, 2)!.givens), 0);
  assert.equal(repo.loadEndlessGame(1, p), null);
});

test("completeEndless queues the result with its replay, and refuses an unfinished game", async () => {
  const { repo, server } = await repoEnv();
  await repo.refresh();
  const p = repo.endlessPuzzle(1, 1, 1)!;
  await assert.rejects(repo.completeEndless(1, 1, 1, Game.create(p.givens)), /isn't complete/);

  const game = done(repo).record({ t: 1, w: 1, a: "hidden" });
  const result = await repo.completeEndless(1, 1, 1, game);
  assert.equal(result.elapsedMs, 60_000);
  assert.equal(result.completedAt, "2026-10-27T14:00:00+13:00");
  assert.equal(result.replay!.events.length, game.replay.length);
  assert.deepEqual(repo.endlessSync.pending(), [result]);

  // A replay too long to upload is left out.
  let long = done(repo, { generator: 1, difficulty: 1, number: 2 });
  for (let i = 0; i <= MAX_REPLAY_EVENTS; i++) long = long.record({ t: i, w: i, a: "hidden" });
  const noReplay = await repo.completeEndless(1, 1, 2, long);
  assert.equal(noReplay.replay, undefined);
  await repo.refresh();
  assert.equal(server.storedEndless.length, 2);
});

test("endlessProgress and endlessBoard fetch the leaderboards", async () => {
  const { repo, server } = await repoEnv();
  server.storedEndless.push({ generator: 1, difficulty: 2, number: 3, elapsedMs: 6500, completedAt: "x" });
  assert.equal((await repo.endlessProgress(1)).difficulties.length, 5);
  assert.deepEqual((await repo.endlessBoard(1, 2, 3)).entries.map((e) => e.elapsedMs), [6500]);
});

// Controller

interface Env {
  c: AppController;
  server: FakeServer;
  repo: SudokuRepository;
  clock: { now: number; mono: number; wall: number };
}

async function env(options: { offline?: boolean } = {}): Promise<Env> {
  const clock = { now: NOW, mono: 10_000, wall: NOW };
  const server = new FakeServer(() => clock.now);
  const storage = new AppStorage(new MemoryStore());
  const repo = new SudokuRepository(storage, REDIRECT, "", () => clock.now, server.fetch);
  await repo.signInDev("https://sudoku.test", "alice", "Alice");
  if (options.offline) {
    // Signed in, but the endless seed never arrived.
    storage.endless.write(null);
    server.online = false;
  }
  return { ...(await startController(repo, clock)), server, repo, clock };
}

async function startController(repo: SudokuRepository, clock: Env["clock"]): Promise<{ c: AppController }> {
  const host: Host = {
    location: { hash: "", pathname: "/", search: "", origin: "https://sudoku.test" } as Location,
    history: { replaceState: () => {} } as unknown as History,
    baseUri: () => "https://sudoku.test/",
    isVisible: () => true,
    nowMs: () => clock.mono,
    wallMs: () => clock.wall,
    reloadPage: () => {},
  };
  const c = new AppController(repo, new SeedRepository(new MemoryStore(), () => clock.now), host);
  c.start();
  await settled();
  await settled();
  while (c.syncing) await settled();
  assert.equal(c.phase.kind, "ready");
  return { c };
}

async function syncNow(c: AppController): Promise<void> {
  c.sync();
  await until(() => !c.syncing);
  await settled();
}

/** Plays `ref` and places every solution digit but the last `leave`. */
function play(e: Env, ref: EndlessRef, leave = 0): { cells: number[]; solution: string } {
  const { c, clock } = e;
  c.openEndless(ref);
  assert.equal(c.screen.kind, "endless-play");
  const p = c.puzzleOf(ref)!;
  const cells = [...p.givens].flatMap((g, i) => (g === "0" ? [i] : []));
  c.update(ref, (g) => g.resume(clock.mono), { a: "resume" });
  for (const cell of cells.slice(0, cells.length - leave)) {
    clock.mono += 100;
    const d = Number(p.solution[cell]);
    c.update(ref, (g) => g.place(cell, d, clock.mono), { a: "place", c: cell, d });
  }
  return { cells, solution: p.solution };
}

test("the endless label and the tab", async () => {
  assert.equal(ENDLESS_LABEL, "Endless");
  const e = await env();
  assert.equal(e.c.homeTab, "daily");
  assert.ok(e.c.hasEndless);
  e.c.showHomeTab("endless");
  assert.equal(e.c.homeTab, "endless");
  assert.equal(e.repo.homeTab(), "endless");
  // A new controller on the same repo starts on the remembered tab.
  const again = await startController(e.repo, e.clock);
  assert.equal(again.c.homeTab, "endless");
});

test("endlessSummaries is null until the seed has synced, then counts solved puzzles", async () => {
  const e = await env({ offline: true });
  const { c, server } = e;
  assert.equal(c.endlessSummaries(), null);
  assert.deepEqual(c.endlessStatusOf(REF), { kind: "new" });
  c.openEndless(REF); // no seed yet
  assert.equal(c.screen.kind, "today");
  server.online = true;
  await syncNow(c);
  const fresh = c.endlessSummaries()!;
  assert.equal(fresh.length, 5);
  assert.deepEqual(fresh[0], { difficulty: 1, solved: 0, highest: 0, next: 1, inProgress: [] });

  // Solved 1, 2 and 4 of Easy, and 7 of Hard; one game in progress in Easy.
  for (const [d, n] of [[1, 1], [1, 2], [1, 4], [3, 7]] as const) server.storedEndless.push({ generator: 1, difficulty: d, number: n, elapsedMs: 9000, completedAt: "x" });
  c.openEndless({ generator: 1, difficulty: 1, number: 9 });
  c.update({ generator: 1, difficulty: 1, number: 9 }, (g) => g.resume(c.nowMs()), { a: "resume" });
  c.openToday();
  await syncNow(c);
  const s = c.endlessSummaries()!;
  assert.deepEqual([s[0]!.solved, s[0]!.highest, s[0]!.next], [3, 4, 3]);
  assert.deepEqual(s[0]!.inProgress.map((g) => g.number), [9]);
  assert.deepEqual([s[2]!.solved, s[2]!.highest, s[2]!.next], [1, 7, 1]);
  assert.deepEqual([s[1]!.solved, s[1]!.highest, s[1]!.next], [0, 0, 1]);
});

test("openEndless ignores bad difficulties and numbers", async () => {
  const { c } = await env();
  for (const ref of [{ generator: 1, difficulty: 0, number: 1 }, { generator: 1, difficulty: 6, number: 1 }, { generator: 1, difficulty: 1, number: 0 }, { generator: 1, difficulty: 1, number: 1.5 }, { generator: 1, difficulty: 1, number: -3 }]) {
    c.openEndless(ref);
    assert.equal(c.screen.kind, "today");
  }
  c.openEndless({ generator: 1, difficulty: 5, number: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(c.screen, { kind: "endless-play", generator: 1, difficulty: 5, number: Number.MAX_SAFE_INTEGER });
});

test("opening an endless puzzle stamps one start event, and it resumes after playing another", async () => {
  const e = await env();
  const { c } = e;
  const a: EndlessRef = { generator: 1, difficulty: 2, number: 3 };
  const b: EndlessRef = { generator: 1, difficulty: 1, number: 1 };
  c.openEndless(a);
  assert.deepEqual(c.screen, { kind: "endless-play", generator: 1, difficulty: 2, number: 3 });
  assert.deepEqual(c.endlessStatusOf(a), { kind: "in-progress", elapsedMs: 0 });
  const g = c.gameOf(a)!;
  assert.deepEqual(g.replay.map((x) => x.a), ["start"]);
  c.openEndless(a);
  assert.equal(c.gameOf(a), g);
  assert.equal(c.puzzleOf(a)!.givens, e.repo.endlessPuzzle(1, 2, 3)!.givens);

  // Other puzzles have no open game.
  assert.equal(c.gameOf(b), null);
  assert.equal(c.puzzleOf(b), null);

  // Play a bit, switch away, come back: restored from storage with one start event.
  const cell = [...c.puzzleOf(a)!.givens].findIndex((x) => x === "0");
  c.update(a, (x) => x.resume(e.clock.mono), { a: "resume" });
  e.clock.mono += 2000;
  c.update(a, (x) => x.pause(e.clock.mono), { a: "pause" });
  c.openEndless(b);
  assert.equal(c.gameOf(a), null);
  assert.deepEqual(c.endlessStatusOf(a), { kind: "in-progress", elapsedMs: 2000 });
  c.openEndless(a);
  assert.notEqual(c.gameOf(a), g);
  assert.equal(c.gameOf(a)!.replay.filter((x) => x.a === "start").length, 1);
  assert.ok(cell >= 0);
});

test("changes to an endless game are saved, and a no-op change is ignored", async () => {
  const e = await env();
  const { c } = e;
  const ref: EndlessRef = { generator: 1, difficulty: 1, number: 2 };
  c.update(ref, (g) => g.resume(0), { a: "resume" }); // not open
  assert.equal(c.gameOf(ref), null);
  c.openEndless(ref);
  const before = c.gameOf(ref)!;
  c.update(ref, (g) => g, { a: "resume" });
  assert.equal(c.gameOf(ref), before);
  c.log(ref, { a: "notes", on: true });
  assert.deepEqual(c.gameOf(ref)!.replay.map((x) => x.a), ["start", "notes"]);
  assert.equal(e.repo.endlessInProgress().length, 1);
  c.log({ generator: 1, difficulty: 4, number: 4 }, { a: "hidden" });
  assert.equal(e.repo.endlessInProgress().length, 1);
});

test("finishing an endless puzzle uploads its result with the replay and shows it as done", async () => {
  const e = await env();
  const { c, server } = e;
  const ref: EndlessRef = { generator: 1, difficulty: 1, number: 1 };
  const { cells, solution } = play(e, ref, 1);
  assert.equal(c.endlessStatusOf(ref).kind, "in-progress");
  const last = cells[cells.length - 1]!;
  const d = Number(solution[last]);
  server.endlessResultsStatus = 500; // stays queued
  c.update(ref, (g) => g.place(last, d, e.clock.mono), { a: "place", c: last, d });
  assert.ok(c.gameOf(ref)!.isComplete);
  assert.deepEqual(c.gameOf(ref)!.replay.slice(-2).map((x) => x.a), ["place", "finish"]);
  assert.equal(c.endlessStatusOf(ref).kind, "done"); // before anything is queued
  await until(() => e.repo.endlessSync.pending().length === 1);
  await until(() => !c.syncing);
  await settled();
  const unsynced = c.endlessStatusOf(ref);
  assert.equal(unsynced.kind === "done" && unsynced.synced, false);
  assert.deepEqual(c.endlessSummaries()![0]!.solved, 1);

  server.endlessResultsStatus = null;
  await syncNow(c);
  assert.equal(server.storedEndless.length, 1);
  assert.deepEqual(server.storedEndless[0]!.replay!.events, [...c.gameOf(ref)!.replay]);
  const synced = c.endlessStatusOf(ref);
  assert.equal(synced.kind === "done" && synced.synced, true);
  // Replaying the solved puzzle shows it again rather than the scores.
  c.openEndless(ref);
  assert.equal(c.screen.kind, "endless-play");
  // A solved game takes no more logged actions.
  const n = c.gameOf(ref)!.replay.length;
  c.log(ref, { a: "hidden" });
  assert.equal(c.gameOf(ref)!.replay.length, n);
});

test("a finished game not yet uploaded is done even without a queued result", async () => {
  const e = await env();
  const { c } = e;
  const ref: EndlessRef = { generator: 1, difficulty: 1, number: 1 };
  c.openEndless(ref);
  const p = c.puzzleOf(ref)!;
  e.repo.saveEndlessGame(1, 1, 1, solveGame(p, 4321), 0);
  c.openEndless({ generator: 1, difficulty: 1, number: 2 });
  assert.deepEqual(c.endlessStatusOf(ref), { kind: "done", elapsedMs: 4321, synced: false });
});

test("a puzzle solved elsewhere opens its scores", async () => {
  const e = await env();
  const { c, server } = e;
  server.storedEndless.push({ generator: 1, difficulty: 2, number: 5, elapsedMs: 9000, completedAt: "x" });
  await syncNow(c);
  c.openEndless({ generator: 1, difficulty: 2, number: 5 });
  assert.deepEqual(c.screen, { kind: "endless-scores", generator: 1, difficulty: 2, number: 5 });
  await until(() => c.endlessBoard !== null);
  assert.deepEqual(c.endlessBoard!.entries.map((x) => x.elapsedMs), [9000]);
  assert.equal(c.gameOf({ generator: 1, difficulty: 2, number: 5 }), null);
});

test("openEndlessScores loads the progress, a puzzle's board, and reports failures", async () => {
  const e = await env();
  const { c, server } = e;
  server.storedEndless.push({ generator: 1, difficulty: 1, number: 3, elapsedMs: 8000, completedAt: "x" });
  c.openEndlessScores(1);
  assert.deepEqual(c.screen, { kind: "endless-scores", generator: 1, difficulty: 1, number: null });
  assert.equal(c.endlessProgress, null);
  await until(() => c.endlessProgress !== null);
  assert.equal(c.endlessProgress!.difficulties[0]!.players[0]!.completed, 1);
  assert.equal(c.leaderboardError, null);

  c.openEndlessScores(1, 3);
  assert.equal(c.endlessProgress, null);
  await until(() => c.endlessBoard !== null);
  assert.equal(c.endlessBoard!.number, 3);

  server.endlessBoardStatus = 500;
  c.openEndlessScores(1);
  await until(() => c.leaderboardError !== null);
  assert.equal(c.leaderboardError, "board broke");

  server.online = false;
  c.openEndlessScores(1, 3);
  await until(() => c.leaderboardError !== null);
  assert.match(c.leaderboardError!, /offline/);
});

test("a stale endless leaderboard response is ignored", async () => {
  const e = await env();
  const { c, server } = e;
  let release!: () => void;
  server.endlessBoardGate = new Promise<void>((r) => (release = r));
  c.openEndlessScores(1); // progress
  c.openEndlessScores(1, 2); // board, which replaces it
  release();
  await until(() => c.endlessBoard !== null);
  await settled();
  assert.equal(c.endlessProgress, null);
  assert.equal(c.leaderboardError, null);

  // The same for failures: only the latest request reports.
  server.endlessBoardGate = new Promise<void>((r) => (release = r));
  server.endlessBoardStatus = 500;
  c.openEndlessScores(1);
  c.openEndlessScores(2);
  release();
  await until(() => c.leaderboardError !== null);
  await settled();
  assert.equal(c.leaderboardError, "board broke");
  assert.equal(c.endlessProgress, null);
});

test("openScoresFor opens the right scores for both kinds of puzzle", async () => {
  const { c } = await env();
  c.openScoresFor({ generator: 1, difficulty: 3, number: 8 });
  assert.deepEqual(c.screen, { kind: "endless-scores", generator: 1, difficulty: 3, number: 8 });
  await until(() => c.endlessBoard !== null);
  c.openScoresFor(1);
  assert.equal(c.screen.kind, "scores");
  await settled();
  await settled();
});

test("gameOf and puzzleOf look up today's games by level", async () => {
  const { c } = await env();
  assert.equal(c.gameOf(1), null);
  c.openPuzzle(1);
  assert.equal(c.gameOf(1), c.games.get(1));
  assert.equal(c.puzzleOf(1), c.puzzle(1));
});

test("a sync does not reload the day while an endless puzzle is open, but does elsewhere", async () => {
  const e = await env();
  const { c } = e;
  const sentinel = Game.create(generateEndless(parseWeekSeed(ENDLESS_SEED), 1, 1).givens);
  c.games.set(99, sentinel);
  c.openEndless(REF);
  await syncNow(c);
  assert.equal(c.screen.kind, "endless-play");
  assert.equal(c.games.get(99), sentinel);
  c.openToday();
  await syncNow(c);
  assert.equal(c.games.has(99), false);
});

test("a sync retries an endless leaderboard that failed, and leaves a good one alone", async () => {
  const e = await env();
  const { c, server } = e;
  server.endlessBoardStatus = 500;
  c.openEndlessScores(1);
  await until(() => c.leaderboardError !== null);
  server.endlessBoardStatus = null;
  await syncNow(c);
  await until(() => c.endlessProgress !== null);
  assert.equal(c.leaderboardError, null);

  const progress = c.endlessProgress;
  await syncNow(c);
  assert.equal(c.endlessProgress, progress);
});

test("tick leaves an open endless puzzle alone when the day rolls over", async () => {
  const e = await env();
  const { c, clock, server } = e;
  const today = c.today;
  c.openEndless(REF);
  clock.now += 2 * 24 * 3600_000;
  const requests = server.requests.length;
  c.tick();
  assert.equal(c.today, today);
  assert.equal(server.requests.length, requests);
  assert.equal(c.screen.kind, "endless-play");
  c.screen = { kind: "today" };
  c.tick();
  assert.notEqual(c.today, today);
});

// The "how it works" explainers

test("the endless explainer pops up the first time the tab is shown, once per device", async () => {
  const e = await env();
  assert.equal(e.c.help, null);
  assert.equal(e.repo.endlessHelpSeen(), false);
  e.c.showHomeTab("endless");
  assert.equal(e.c.help, "endless");
  assert.equal(e.repo.endlessHelpSeen(), true);
  e.c.closeHelp();
  assert.equal(e.c.help, null);
  e.c.showHomeTab("daily");
  e.c.showHomeTab("endless");
  assert.equal(e.c.help, null, "only the first visit");
  const again = await startController(e.repo, e.clock);
  assert.equal(again.c.help, null, "nor after a reload");
});

test("a device that starts on the endless tab gets the explainer on start, and not over another screen", async () => {
  const e = await env();
  e.repo.setHomeTab("endless");
  const fresh = await startController(e.repo, e.clock);
  assert.equal(fresh.c.help, "endless");

  const other = await env();
  other.c.screen = { kind: "about" };
  other.c.showHomeTab("endless");
  assert.equal(other.c.help, null);
  assert.equal(other.repo.endlessHelpSeen(), false);
});

test("the explainers open from the About screen", async () => {
  const e = await env();
  e.c.openHelp("daily");
  assert.equal(e.c.help, "daily");
  e.c.openHelp("endless");
  assert.equal(e.c.help, "endless");
  e.c.openHelp("generators");
  assert.equal(e.c.help, "generators");
});
