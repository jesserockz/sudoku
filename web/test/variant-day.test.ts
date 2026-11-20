// The variant of the day: one extra daily puzzle (Diagonal, Jigsaw or Killer) with its own result queue, leaderboard and
// replays. Players only ever see its variant, never its generator or difficulty.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiException, SudokuApi } from "../src/api/client.ts";
import {
  decodeAdminResults, decodeMyResults, decodeVariantBoard, decodeVariantDayReplayDetail, decodeVariantDayResult,
} from "../src/api/models.ts";
import { AppStorage } from "../src/data/app-storage.ts";
import { SudokuRepository } from "../src/data/repository.ts";
import { MemoryStore } from "../src/data/store.ts";
import { VARIANT_DIAGONAL, VARIANT_JIGSAW, VARIANT_KILLER, Layout, variantName } from "../src/core/layout.ts";
import { VARIANT_DAY_CACHE_SIZE, VariantDayCache } from "../src/data/variant-day.ts";
import { dailyVariantOf, generateDailyVariant, generateEndlessVariant } from "../src/generator/variants.ts";
import { parseWeekSeed } from "../src/generator/week-seed.ts";
import { SeedRepository } from "../src/serverless/seed-repository.ts";
import { seedSettings } from "../src/serverless/seed.ts";
import { AppController, type Host, type VariantDayRef, isVariantDayRef } from "../src/ui/controller.ts";
import { preparingText, variantDayRow, variantDayTitle } from "../src/ui/variants.ts";
import { FakeServer } from "./fake-server.ts";

// Tuesday 2026-10-27, in 2026-W44: the day's variant of the day is Diagonal on the test server's week.
const NOW = Date.parse("2026-10-27T01:00:00Z");
const TODAY = "2026-10-27";
const REDIRECT = "https://sudoku.test/auth/callback";
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(done: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(done(), "condition never became true");
}
async function idle(c: AppController): Promise<void> {
  await settled();
  while (c.syncing) await settled();
  await settled();
}

const clock = { mono: 10_000 };
function makeHost(): Host {
  return {
    location: { hash: "", pathname: "/", search: "", origin: "https://sudoku.test" } as Location,
    history: { replaceState: () => {} } as unknown as History,
    baseUri: () => "https://sudoku.test/",
    isVisible: () => true,
    nowMs: () => clock.mono,
    wallMs: () => NOW,
    reloadPage: () => {},
  };
}

async function env(configure: (server: FakeServer) => void = () => {}, store = new MemoryStore()) {
  clock.mono = 10_000;
  const server = new FakeServer(() => NOW);
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

/** Plays today's variant of the day through the controller, leaving the last `leave` cells empty. Returns a function that places one more digit. */
async function play(c: AppController, leave = 0): Promise<() => void> {
  await c.openVariantDay();
  assert.equal(c.screen.kind, "variant-day-play");
  const ref: VariantDayRef = { variantDay: true, variant: c.variantDayKind! };
  const p = c.puzzleOf(ref) as { givens: string; solution: string };
  const cells = [...p.givens].flatMap((g, i) => (g === "0" ? [i] : []));
  c.update(ref, (g) => g.resume(clock.mono), { a: "resume" });
  const place = (cell: number): void => {
    clock.mono += 100;
    const d = Number(p.solution[cell]);
    c.update(ref, (g) => g.place(cell, d, clock.mono), { a: "place", c: cell, d });
  };
  cells.slice(0, cells.length - leave).forEach(place);
  const rest = cells.slice(cells.length - leave);
  return () => place(rest.shift()!);
}

// The draw

test("the variant of the day is drawn from the week seed and the day, never standard Sudoku", () => {
  const seed = parseWeekSeed("9f2c4a1b7e30d5c8");
  const kinds = new Set<number>();
  for (let day = 1; day <= 7; day++) {
    const kind = dailyVariantOf(seed, day);
    assert.ok([VARIANT_DIAGONAL, VARIANT_JIGSAW, VARIANT_KILLER].includes(kind));
    kinds.add(kind);
  }
  // The same week seed on the same day always gives the same variant; another seed is another draw.
  assert.equal(dailyVariantOf(seed, 3), dailyVariantOf(seed, 3));
  assert.notDeepEqual(
    [1, 2, 3, 4, 5, 6, 7].map((d) => dailyVariantOf(seed, d)),
    [1, 2, 3, 4, 5, 6, 7].map((d) => dailyVariantOf(parseWeekSeed("0123456789abcdef"), d)),
  );
  assert.ok(kinds.size >= 2);
});

test("the variant of the day's puzzle belongs to its variant and is solved by its solution", () => {
  const d = generateDailyVariant(parseWeekSeed("0123456789abcdef"), 6, 1);
  assert.equal(d.variant, dailyVariantOf(parseWeekSeed("0123456789abcdef"), 6));
  assert.ok([4, 5].includes(d.tier));
  assert.ok([3, 4].includes(generateDailyVariant(parseWeekSeed("0123456789abcdef"), 6, 2).tier));
  assert.ok(d.layout.isValid([...d.solution].map(Number)));
});

test("the cache keeps the latest few puzzles and reuses them", () => {
  const cache = new VariantDayCache();
  const seed = "9f2c4a1b7e30d5c8";
  const first = cache.get(seed, "2026-10-26");
  assert.equal(cache.get(seed, "2026-10-26"), first);
  // 2026-10-26 is a Monday; days 2.. fill the cache past its size, dropping the oldest.
  ["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"].slice(0, VARIANT_DAY_CACHE_SIZE).forEach((d) => cache.get(seed, d));
  assert.notEqual(cache.get(seed, "2026-10-26"), first, "regenerated after being dropped");
  assert.deepEqual(cache.get(seed, "2026-10-26"), first);
});

test("the cache generates a date with the version of that date, also for the same day of the week", () => {
  const cache = new VariantDayCache();
  const seed = "9f2c4a1b7e30d5c8";
  // Two Thursdays, either side of the cutoff, share the cache key but for the version.
  const before = cache.get(seed, "2026-11-19");
  const from = cache.get(seed, "2026-11-26");
  assert.deepEqual(before, generateDailyVariant(parseWeekSeed(seed), 4, 1));
  assert.deepEqual(from, generateDailyVariant(parseWeekSeed(seed), 4, 2));
  assert.ok([4, 5].includes(before.tier) && [3, 4].includes(from.tier));
  assert.equal(cache.get(seed, "2026-11-19"), before);
});

// Wording

test("players see the variant of the day by its variant only", () => {
  for (const v of [VARIANT_DIAGONAL, VARIANT_JIGSAW, VARIANT_KILLER]) {
    const texts = [variantDayTitle(v), preparingText({ variantDay: true, variant: v })];
    assert.equal(texts[0], `${variantName(v)} of the day`);
    assert.equal(texts[1], `Preparing ${variantName(v)} of the day…`);
    for (const t of texts) assert.doesNotMatch(t, /Graded|Classic|Expert|Diabolical|Easy|Medium|Hard/);
  }
  assert.equal(preparingText({ generator: 2, variant: 3, difficulty: 4, number: 7 }), "Preparing Graded Killer Expert #7…");
  assert.equal(preparingText({ generator: 1, difficulty: 1, number: 2 }), "Preparing Classic Easy #2…");
});

test("the variant of the day's row says where it stands and offers play, resume or scores", () => {
  assert.deepEqual(variantDayRow({ kind: "new" }, false), { text: "Not started yet", action: "play" });
  assert.deepEqual(variantDayRow({ kind: "in-progress", elapsedMs: 65_000 }, false), { text: "In progress · 1:05", action: "resume" });
  assert.deepEqual(variantDayRow({ kind: "done", elapsedMs: 65_000, synced: true }, false), { text: "Solved in 1:05", action: "scores" });
  assert.deepEqual(variantDayRow({ kind: "done", elapsedMs: 65_000, synced: false }, false), { text: "Solved in 1:05 · not uploaded yet", action: "scores" });
  // Serverless play has no leaderboard.
  assert.deepEqual(variantDayRow({ kind: "done", elapsedMs: 65_000, synced: true }, true), { text: "Solved in 1:05", action: null });
});

// Models and the client

test("decoding results, boards and admin lists", () => {
  const result = { date: TODAY, variant: 3, elapsedMs: 5000, completedAt: "2026-10-27T01:00:00Z" };
  assert.deepEqual(decodeVariantDayResult(result), result);
  assert.deepEqual(decodeVariantDayResult({ ...result, variant: undefined }), { date: TODAY, elapsedMs: 5000, completedAt: result.completedAt });
  assert.deepEqual(decodeVariantDayResult({ ...result, replay: { version: 1, events: [] } }).replay, { version: 1, events: [] });
  assert.throws(() => decodeVariantDayResult({ ...result, variant: 0 }), /not a variant of the day/);
  assert.throws(() => decodeVariantDayResult({ ...result, variant: 4 }), /not a variant of the day/);

  assert.equal(decodeMyResults({ date: TODAY, results: [] }).variantDaily, null);
  assert.deepEqual(decodeMyResults({ date: TODAY, results: [], variantDaily: result }).variantDaily, result);

  const board = decodeVariantBoard({
    date: TODAY, variant: 2, entries: [
      { rank: 1, userId: "1", displayName: "A", elapsedMs: 9, suspicious: true, streak: 4 },
      { rank: 2, userId: "2", displayName: "B", elapsedMs: 9 },
    ],
  });
  assert.deepEqual(board.entries.map((e) => [e.rank, e.suspicious, e.streak]), [[1, true, 4], [2, false, 0]]);

  const admin = { userId: "1", displayName: "A", date: TODAY, variant: 1, elapsedMs: 9, completedAt: "c", submittedAt: "s", replay: "valid", replayError: "", flag: null };
  assert.deepEqual(decodeAdminResults({ date: TODAY, levels: 5, results: [] }).variantResults, []);
  assert.equal(decodeAdminResults({ date: TODAY, levels: 5, results: [], variantResults: [admin] }).variantResults[0]!.variantDay, true);
});

test("an admin replay of a variant of the day carries the puzzle's layout", () => {
  const givens = "0".repeat(80) + "1";
  const detail = (variant: number, layout: unknown) => decodeVariantDayReplayDetail({
    userId: "1", displayName: "A", date: TODAY, variant, elapsedMs: 9, completedAt: "c", submittedAt: "s", replay: "valid", replayError: "", flag: null,
    givens, events: [], layout,
  });
  assert.equal(detail(VARIANT_DIAGONAL, { regions: [], diagonals: true, cages: [] }).layout, Layout.DIAGONAL);
  const cages = generateEndlessVariant(1, VARIANT_KILLER, 1n, 1, 1).layout.cages;
  const killer = detail(VARIANT_KILLER, { regions: [], diagonals: false, cages });
  assert.deepEqual(killer.layout.cages, cages);
  assert.throws(() => decodeVariantDayReplayDetail({ ...({} as object), givens }), TypeError);
});

test("the client submits, lists and administers the variant of the day", async () => {
  const server = new FakeServer(() => NOW);
  server.admin = true;
  const api = new SudokuApi("https://sudoku.test", async () => "dev:alice:Alice", server.fetch);
  const result = { date: TODAY, elapsedMs: 70_000, completedAt: "2026-10-27T14:00:00+13:00" };
  const created = await api.submitVariantDayResult(result);
  assert.equal(created.kind, "created");
  assert.equal(created.kind === "created" && created.result.variant, VARIANT_DIAGONAL);
  assert.equal((await api.submitVariantDayResult(result)).kind, "stored");
  assert.equal((await api.myResults(TODAY)).variantDaily!.elapsedMs, 70_000);
  assert.equal((await api.myResults("2026-10-26")).variantDaily, null);
  server.variantBoardEntries = [{ rank: 1, userId: "alice", displayName: "Alice", elapsedMs: 70_000, suspicious: false, streak: 3 }];
  const board = await api.variantBoard(TODAY);
  assert.deepEqual([board.date, board.variant, board.entries[0]!.streak], [TODAY, VARIANT_DIAGONAL, 3]);
  assert.equal((await api.variantBoard()).date, TODAY);
  assert.equal(server.requests.at(-1)!.url.search, "");

  const admin = { userId: "alice", displayName: "Alice", date: TODAY, variant: 1, elapsedMs: 9, completedAt: "c", submittedAt: "s", replay: "valid", replayError: "", flag: null };
  server.adminVariantFlagResult = admin;
  server.adminVariantReplayDetail = { ...admin, givens: "0".repeat(80) + "1", events: [], layout: { regions: [], diagonals: true, cages: [] } };
  assert.equal((await api.adminVariantDayReplay(TODAY, "alice")).layout, Layout.DIAGONAL);
  assert.equal(server.requests.at(-1)!.url.pathname, `/api/v1/admin/variant-daily/results/${TODAY}/alice/replay`);
  assert.equal((await api.flagVariantDayResult(TODAY, "alice", "why")).variantDay, true);
  assert.deepEqual([server.requests.at(-1)!.method, server.requests.at(-1)!.body], ["PUT", '{"reason":"why"}']);
  assert.equal((await api.unflagVariantDayResult(TODAY, "a b")).variantDay, true);
  assert.deepEqual([server.requests.at(-1)!.method, server.requests.at(-1)!.url.pathname], ["DELETE", `/api/v1/admin/variant-daily/results/${TODAY}/a%20b/flag`]);

  // A server from before the variant of the day answers 404.
  server.hasVariantDay = false;
  await assert.rejects(api.variantBoard(TODAY), (e) => e instanceof ApiException && e.status === 404);
});

test("a server that rejects a replay's colour pens gets the result again without them", async () => {
  const server = new FakeServer(() => NOW);
  server.rejectColours = true;
  const api = new SudokuApi("https://sudoku.test", async () => "dev:alice:Alice", server.fetch);
  const outcome = await api.submitVariantDayResult({
    date: TODAY, elapsedMs: 70_000, completedAt: "c",
    replay: { version: 1, events: [{ a: "start", t: 0, w: 1 }, { a: "colour", t: 5, w: 2, c: 1, p: 1 }] } as never,
  });
  assert.equal(outcome.kind, "created");
  assert.equal(server.requests.filter((r) => r.url.pathname === "/api/v1/variant-daily/results").length, 2);
});

// The home card and play

test("the Daily tab's card names today's variant and follows the game from new to solved and uploaded", async () => {
  const { c, server, repo } = await env();
  const kind = c.variantDayKind!;
  assert.equal(kind, VARIANT_DIAGONAL);
  assert.deepEqual(c.variantDayStatus(), { kind: "new" });

  // Generating names the puzzle for a frame; the player never sees a generator or difficulty.
  const opening = c.openVariantDay();
  assert.deepEqual(c.preparing, { variantDay: true, variant: kind });
  assert.ok(isVariantDayRef(c.preparing!));
  await opening;
  assert.equal(c.preparing, null);
  assert.deepEqual(c.screen, { kind: "variant-day-play", date: TODAY, variant: kind });
  const ref: VariantDayRef = { variantDay: true, variant: kind };
  assert.equal(c.headingOf(ref), "Diagonal of the day");
  assert.doesNotMatch(c.headingOf(ref), /Classic|Graded|Expert|Diabolical/);
  assert.ok(c.puzzleOf(ref));
  assert.ok(c.gameOf(ref));
  // The play screen starts the clock, which saves the game.
  c.update(ref, (g) => g.resume(clock.mono), { a: "resume" });

  c.openToday();
  assert.equal(c.variantDayStatus().kind, "in-progress");
  // Its game is saved apart from the classic daily games.
  assert.ok(repo.variantDaySaved(TODAY));
  assert.equal(c.games.size, 0);

  // Resuming reuses the game that is open, without preparing it again.
  await c.openVariantDay();
  assert.equal(c.preparing, null);
  c.openToday();

  const finish = await play(c, 1);
  assert.equal(c.variantDayStatus().kind, "in-progress");
  finish();
  assert.equal(c.gameOf(ref)!.isComplete, true);
  assert.equal(c.variantDayStatus().kind, "done");
  await until(() => server.storedVariantDay.length === 1);
  await idle(c);
  assert.deepEqual(c.variantDayStatus(), { kind: "done", elapsedMs: c.gameOf(ref)!.completedElapsedMs!, synced: true });
  assert.equal(server.storedVariantDay[0]!.variant, kind);
  // The replay went up with the result, and the classic daily results are untouched.
  assert.ok(server.requests.some((r) => r.url.pathname === "/api/v1/variant-daily/results" && r.body.includes('"replay"')));
  assert.equal(server.stored.length, 0);
  assert.equal(repo.variantDaySync.pending().length, 0);

  // See scores goes to the daily leaderboard; so does the card's Scores button.
  c.openScoresFor(ref);
  assert.deepEqual(c.screen, { kind: "scores", date: TODAY, tab: 0, generator: c.generator });
  // The finished game is still open, so playing it again just shows the solved board.
  c.openToday();
  await c.openVariantDay();
  assert.equal(c.screen.kind, "variant-day-play");
});

test("a variant of the day solved elsewhere opens its leaderboard, and one finished here and not uploaded yet is done", async () => {
  const { c, server, repo } = await env((s) => { s.storedVariantDay.push({ date: TODAY, variant: 1, elapsedMs: 77_000, completedAt: "c" }); });
  // The sync during start fetched today's results.
  assert.deepEqual(repo.variantDaySolved(TODAY), { elapsedMs: 77_000, synced: true });
  assert.deepEqual(c.variantDayStatus(), { kind: "done", elapsedMs: 77_000, synced: true });
  await c.openVariantDay();
  assert.equal(c.screen.kind, "scores");
  assert.equal(server.requests.filter((r) => r.url.pathname === "/api/v1/variant-daily/results").length, 0);
});

test("offline, a finished variant of the day waits in its own queue and uploads later; 503 keeps it queued, 400 drops it", async () => {
  const { c, server, repo } = await env();
  server.online = false;
  const finish = await play(c, 0);
  void finish;
  await until(() => repo.variantDaySync.pending().length === 1);
  await idle(c);
  assert.equal(repo.variantDaySolved(TODAY)!.synced, false);
  assert.equal(c.variantDayStatus().kind, "done");
  assert.deepEqual(repo.pending(), [], "not in the daily queue");
  assert.equal(repo.endlessSync.pending().length, 0);

  server.online = true;
  server.variantDayResultsStatus = 503;
  c.sync();
  await idle(c);
  assert.equal(repo.variantDaySync.pending().length, 1, "a server error keeps it queued");
  assert.match(c.notice ?? "", /haven't uploaded yet/);

  server.variantDayResultsStatus = null;
  server.rejectAll = true;
  c.sync();
  await idle(c);
  assert.equal(repo.variantDaySync.pending().length, 0, "a rejected result is dropped");
  assert.match(c.notice ?? "", /rejected 1 result/);

  // A later refresh has no result of the server's to keep.
  server.rejectAll = false;
  c.sync();
  await idle(c);
  assert.equal(repo.variantDaySolved(TODAY), null);
  assert.equal(c.variantDayStatus().kind, "done", "the game on this device still knows it was solved");
});

test("maintenance keeps the finished variant of the day queued until the server is back", async () => {
  const { c, server, repo } = await env((s) => { s.admin = false; });
  server.maintenance = { until: null };
  await play(c, 0);
  await until(() => repo.variantDaySync.pending().length === 1);
  await idle(c);
  assert.ok(c.maintenance, "the sync learnt of the maintenance");
  assert.equal(repo.variantDaySync.pending().length, 1);
  assert.deepEqual(c.variantDayStatus(), { kind: "done", elapsedMs: c.gameOf({ variantDay: true, variant: 1 })!.completedElapsedMs!, synced: false });
  assert.equal(server.storedVariantDay.length, 0);

  server.maintenance = null;
  c.sync();
  await idle(c);
  assert.equal(server.storedVariantDay.length, 1);
  assert.equal(c.maintenance, null);
  assert.equal(c.variantDayStatus().kind === "done" && c.variantDayStatus().kind === "done" && (c.variantDayStatus() as { synced: boolean }).synced, true);
});

test("without a downloaded week there is no variant of the day to show", async () => {
  const { c } = await env();
  await c.signOut();
  assert.equal(c.week, null);
  assert.equal(c.variantDayKind, null);
  await c.openVariantDay();
  assert.equal(c.screen.kind, "today");
  assert.equal(c.preparing, null);
});

test("opening another puzzle while the variant of the day is being prepared lets the other one win", async () => {
  const { c } = await env();
  const opening = c.openVariantDay();
  assert.ok(c.preparing);
  c.preparing = null;
  await opening;
  assert.equal(c.screen.kind, "today");
});

test("a day's game is dropped once it is from another week, and sign-out forgets the open one", async () => {
  const store = new MemoryStore();
  const { c, repo } = await env(() => {}, store);
  await play(c, 1);
  assert.ok(repo.variantDaySaved(TODAY));
  // The server's week moves on: the old week's game can't be finished any more.
  const later = Date.parse("2026-11-02T20:00:00Z");
  const server = new FakeServer(() => later);
  const repo2 = new SudokuRepository(new AppStorage(store), REDIRECT, "", () => later, server.fetch);
  await repo2.signInDev("https://sudoku.test", "alice", "Alice");
  assert.equal(repo2.variantDaySaved(TODAY), null);

  await c.signOut();
  assert.equal(c.gameOf({ variantDay: true, variant: 1 }), null);
  assert.equal(c.puzzleOf({ variantDay: true, variant: 1 }), null);
});

// The leaderboard section

test("the daily leaderboard loads the variant of the day's board once per day, and again after a failure", async () => {
  const { c, server } = await env((s) => {
    s.variantBoardEntries = [{ rank: 1, userId: "alice", displayName: "Alice", elapsedMs: 70_000, suspicious: false, streak: 5 }];
  });
  const boards = () => server.requests.filter((r) => r.url.pathname === "/api/v1/variant-daily/leaderboard").length;
  c.openScores();
  await until(() => c.variantBoard !== null);
  assert.equal(boards(), 1);
  assert.deepEqual([c.variantBoard!.date, c.variantBoard!.variant, c.variantBoard!.entries[0]!.streak], [TODAY, VARIANT_DIAGONAL, 5]);
  await until(() => c.leaderboard !== null);

  // Another tab or generator is the same board; another day is another one.
  c.showScoresTab(1);
  c.openScores(2, TODAY, c.generator);
  await until(() => c.leaderboard !== null);
  assert.equal(boards(), 1);
  c.shiftScoresDate(-1);
  assert.equal(c.variantBoard, null, "loading");
  await until(() => c.variantBoard !== null);
  assert.equal(c.variantBoard!.date, "2026-10-26");
  assert.equal(boards(), 2);

  // A failure shows its message; the next sync retries it.
  server.variantBoardStatus = 500;
  c.shiftScoresDate(1);
  await until(() => c.variantBoardError !== null);
  assert.equal(c.variantBoard, null);
  assert.match(c.variantBoardError!, /board broke/);
  server.variantBoardStatus = null;
  c.sync();
  await idle(c);
  await until(() => c.variantBoard !== null);
  assert.equal(c.variantBoardError, null);

  // Offline the board needs the server.
  server.online = false;
  c.openScores(0, "2026-10-26");
  await until(() => c.variantBoardError !== null);
  assert.match(c.variantBoardError!, /offline/i);
  server.online = true;
});

test("a stale variant board answer is ignored, and maintenance shows its message", async () => {
  let release!: () => void;
  const { c, server } = await env((s) => { s.variantBoardGate = new Promise<void>((resolve) => { release = resolve; }); });
  c.openScores();
  c.shiftScoresDate(-1);
  release();
  await until(() => c.variantBoard !== null);
  assert.equal(c.variantBoard!.date, "2026-10-26", "only the latest request counts");

  server.maintenance = { until: null };
  server.admin = false;
  c.openScores(0, TODAY);
  await until(() => c.variantBoardError !== null);
  assert.match(c.variantBoardError!, /maintenance|try again/i);
  assert.ok(c.maintenance);
});

// Serverless

test("serverless play has the variant of the day too: local game, local history, no leaderboard", async () => {
  clock.mono = 10_000;
  const store = new MemoryStore();
  const repo = new SudokuRepository(new AppStorage(store), REDIRECT, "", () => NOW);
  const seeds = new SeedRepository(store, () => NOW);
  await seeds.use(seedSettings("test-secret-0123456789"));
  const c = new AppController(repo, seeds, makeHost());
  c.start();
  for (let i = 0; i < 500 && c.phase.kind !== "ready"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(c.seed);
  const kind = c.variantDayKind!;
  assert.ok([VARIANT_DIAGONAL, VARIANT_JIGSAW, VARIANT_KILLER].includes(kind));
  assert.equal(kind, dailyVariantOf(parseWeekSeed(c.week!.seed), 2));
  assert.deepEqual(c.variantDayStatus(), { kind: "new" });
  assert.deepEqual(c.variantDayHistory(), []);

  const finish = await play(c, 1);
  assert.equal(c.variantDayStatus().kind, "in-progress");
  assert.equal(repo.variantDaySaved(TODAY), null, "the server's storage is untouched");
  assert.ok(seeds.variantDaySaved(TODAY));
  finish();
  await settled();
  assert.equal(c.variantDayStatus().kind, "done");
  assert.deepEqual(c.variantDayHistory().map((r) => [r.date, r.variant]), [[TODAY, kind]]);
  // The saved game restores for its own puzzle, and for no other date.
  const puzzle = seeds.variantDay(c.week!, TODAY);
  assert.equal(seeds.loadVariantDayGame(TODAY, puzzle)!.isComplete, true);
  assert.equal(seeds.loadVariantDayGame("2026-10-28", puzzle), null);
  // Finishing twice keeps the first result.
  const game = c.gameOf({ variantDay: true, variant: kind })!;
  assert.equal((await seeds.completeVariantDay(TODAY, kind, game)).elapsedMs, game.completedElapsedMs);
  assert.equal(c.variantDayHistory().length, 1);
  assert.deepEqual(seeds.variantDaySolved(TODAY), { elapsedMs: game.completedElapsedMs, synced: true });

  // No leaderboard: scores open the history.
  c.openScoresFor({ variantDay: true, variant: kind });
  assert.equal(c.screen.kind, "history");
  c.openToday();

  // An unfinished game can't be stored as a result.
  await assert.rejects(seeds.completeVariantDay("2026-10-28", kind, (await import("../src/game/game.ts")).Game.create("1" + "0".repeat(80))), /isn't complete/);
  // Leaving the seed forgets the open game; a new week's seed drops saved games of other weeks.
  seeds.saveVariantDayGame("2026-11-03", game, 0);
  assert.equal(seeds.variantDaySaved(TODAY), null);
  assert.ok(seeds.variantDaySaved("2026-11-03"));
  c.leaveSeed();
  assert.equal(c.gameOf({ variantDay: true, variant: kind }), null);
});

test("history of another seed's variant of the day is empty before a seed is chosen", () => {
  const seeds = new SeedRepository(new MemoryStore(), () => NOW);
  assert.deepEqual(seeds.variantDayHistory(), []);
});

// Restarting, and the other puzzles' headings

test("a restarted app resumes the saved variant of the day, and ignores a saved game of another puzzle", async () => {
  const store = new MemoryStore();
  const { c, repo } = await env(() => {}, store);
  const finish = await play(c, 2);
  const ref: VariantDayRef = { variantDay: true, variant: c.variantDayKind! };
  const elapsed = c.gameOf(ref)!.elapsedMs(clock.mono);
  void finish;

  // A new session over the same storage: the card knows the game without generating the puzzle.
  const server = new FakeServer(() => NOW);
  const frames: number[] = [];
  const host = { ...makeHost(), nextFrame: async () => { frames.push(1); } };
  const repo2 = new SudokuRepository(new AppStorage(store), REDIRECT, "", () => NOW, server.fetch);
  const c2 = new AppController(repo2, new SeedRepository(new MemoryStore(), () => NOW), host);
  c2.start();
  await idle(c2);
  assert.deepEqual(c2.variantDayStatus(), { kind: "in-progress", elapsedMs: Math.round(elapsed) });
  await c2.openVariantDay();
  assert.deepEqual(frames, [1], "the host's frame is awaited while preparing");
  const resumed = c2.gameOf(ref)!;
  assert.equal(resumed.board.toCompactString(), c.gameOf(ref)!.board.toCompactString());
  assert.equal(resumed.isComplete, false);

  // A saved game that no longer matches today's puzzle starts afresh.
  repo.saveVariantDayGame(TODAY, resumed, 0);
  const stored = new AppStorage(store).variantDayGames.read()!;
  new AppStorage(store).variantDayGames.write({ [TODAY]: { ...stored[TODAY]!, givens: "1" + stored[TODAY]!.givens.slice(1).replace(/./, "0") } });
  const c3 = new AppController(new SudokuRepository(new AppStorage(store), REDIRECT, "", () => NOW, server.fetch), new SeedRepository(new MemoryStore(), () => NOW), makeHost());
  c3.start();
  await idle(c3);
  await c3.openVariantDay();
  assert.equal(c3.gameOf(ref)!.elapsedMs(clock.mono), 0, "a fresh game");
});

test("a solved game whose result the server rejected still shows as solved after a restart", async () => {
  const store = new MemoryStore();
  const { c, server } = await env((s) => { s.rejectAll = true; }, store);
  await play(c, 0);
  await until(() => server.requests.some((r) => r.url.pathname === "/api/v1/variant-daily/results"));
  await idle(c);
  const c2 = new AppController(new SudokuRepository(new AppStorage(store), REDIRECT, "", () => NOW, server.fetch), new SeedRepository(new MemoryStore(), () => NOW), makeHost());
  c2.start();
  await idle(c2);
  const status = c2.variantDayStatus();
  assert.equal(status.kind, "done");
  assert.equal(status.kind === "done" && status.synced, false);
});

test("an unfinished game cannot be queued as a result", async () => {
  const { c, repo } = await env();
  await c.openVariantDay();
  const game = c.gameOf({ variantDay: true, variant: 1 })!;
  await assert.rejects(repo.completeVariantDay(TODAY, 1, game), /isn't complete/);
});

test("a stale failing variant board request is ignored", async () => {
  let release!: () => void;
  const { c } = await env((s) => {
    s.variantBoardStatus = 500;
    s.variantBoardGate = new Promise<void>((resolve) => { release = resolve; });
  });
  c.openScores();
  c.shiftScoresDate(-1);
  release();
  await until(() => c.variantBoardError !== null);
  assert.equal(c.variantBoard, null);
});

test("the play screen's heading names the generator for daily games and series for endless puzzles, but not for the variant of the day", async () => {
  const { c } = await env((s) => { s.generators = [1, 2]; });
  await c.chooseGenerator(2);
  assert.equal(c.headingOf(1), "Graded · Easy");
  await c.openVariantDay();
  assert.equal(c.headingOf({ variantDay: true, variant: 1 }), "Diagonal of the day");
  c.openToday();
  const single = await env();
  assert.equal(single.c.headingOf(1), "Easy");
  await single.c.openEndless({ generator: 1, difficulty: 2, number: 3 });
  assert.equal(single.c.headingOf({ generator: 1, difficulty: 2, number: 3 }), "Classic · Medium #3");
});
