import assert from "node:assert/strict";
import { test } from "node:test";
import { SudokuApi } from "../src/api/client.ts";
import { decodeLeaderboard, decodeMyStats, decodeStreak } from "../src/api/models.ts";
import { AppStorage } from "../src/data/app-storage.ts";
import { SudokuRepository } from "../src/data/repository.ts";
import { MemoryStore } from "../src/data/store.ts";
import { seedSettings as s } from "../src/serverless/seed.ts";
import { SeedRepository } from "../src/serverless/seed-repository.ts";
import { AppController, type Host } from "../src/ui/controller.ts";
import { currentStreak, sparklinePoints, streakLabel, streakMarker, streakSummary } from "../src/ui/stats.ts";
import { FakeServer } from "./fake-server.ts";

const NOW = Date.parse("2026-10-27T01:00:00Z");
const REDIRECT = "https://sudoku.test/auth/callback";
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(done: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(done(), "condition never became true");
}

// Models and client

const GOOD = {
  today: "2026-10-27",
  streak: { current: 4, best: 12, lastDate: "2026-10-27" },
  daily: [{ difficulty: 1, completed: 2, bestMs: 5, averageMs: 7, recent: [{ date: "2026-10-26", level: 1, elapsedMs: 5 }] }],
  endless: [{ difficulty: 1, completed: 1, highest: 3, bestMs: 9, averageMs: 9 }],
};

test("decodeMyStats reads the stats, with null times when nothing is solved", () => {
  assert.deepEqual(decodeMyStats(GOOD), GOOD);
  const empty = decodeMyStats({
    ...GOOD,
    streak: { current: 0, best: 0, lastDate: null },
    daily: [{ difficulty: 2, completed: 0, bestMs: null, averageMs: null, recent: [] }],
    endless: [{ difficulty: 2, completed: 0, highest: 0 }],
  });
  assert.deepEqual(empty.streak, { current: 0, best: 0, lastDate: null });
  assert.deepEqual(empty.daily[0], { difficulty: 2, completed: 0, bestMs: null, averageMs: null, recent: [] });
  assert.deepEqual(empty.endless[0], { difficulty: 2, completed: 0, highest: 0, bestMs: null, averageMs: null });
  assert.equal(decodeStreak({ current: 1, best: 1 }).lastDate, null);
});

test("decodeMyStats rejects missing and badly typed fields", () => {
  assert.throws(() => decodeMyStats({ ...GOOD, today: "yesterday" }), TypeError);
  assert.throws(() => decodeMyStats({ ...GOOD, streak: undefined }), TypeError);
  assert.throws(() => decodeMyStats({ ...GOOD, streak: { current: "4", best: 12, lastDate: null } }), TypeError);
  assert.throws(() => decodeMyStats({ ...GOOD, streak: { current: 4, best: 12, lastDate: "nope" } }), TypeError);
  assert.throws(() => decodeMyStats({ ...GOOD, daily: {} }), TypeError);
  assert.throws(() => decodeMyStats({ ...GOOD, daily: [{ ...GOOD.daily[0], bestMs: "fast" }] }), TypeError);
  assert.throws(() => decodeMyStats({ ...GOOD, daily: [{ ...GOOD.daily[0], recent: [{ date: "2026-10-26", level: 1 }] }] }), TypeError);
  assert.throws(() => decodeMyStats({ ...GOOD, endless: [{ difficulty: 1, completed: 1, bestMs: null }] }), TypeError);
  assert.throws(() => decodeMyStats(null), TypeError);
});

test("leaderboard players carry a streak, which defaults to 0 for older servers", () => {
  const board = decodeLeaderboard({
    date: "2026-10-27", puzzles: [], total: { entries: [] },
    players: [{ userId: "a", displayName: "A", completedLevels: [1], streak: 5 }, { userId: "b", displayName: "B", completedLevels: [] }],
  });
  assert.deepEqual(board.players.map((p) => p.streak), [5, 0]);
  assert.throws(() => decodeLeaderboard({
    date: "2026-10-27", puzzles: [], total: { entries: [] }, players: [{ userId: "a", displayName: "A", completedLevels: [], streak: "5" }],
  }), TypeError);
});

test("the API client fetches /me/stats", async () => {
  const server = new FakeServer(() => NOW);
  server.stats = GOOD;
  const api = new SudokuApi("https://sudoku.test", async () => "dev:alice:Alice", server.fetch);
  assert.deepEqual(await api.myStats(), GOOD);
  assert.equal(server.requests.at(-1)!.url.pathname, "/api/v1/me/stats");
});

// Pure display helpers

test("streak text", () => {
  assert.equal(streakLabel(4), "4-day streak");
  const streak = { current: 4, best: 12, lastDate: "2026-10-27" };
  assert.equal(streakSummary(null, "2026-10-27"), null);
  assert.equal(streakSummary(streak, "2026-10-27"), "4-day streak · best 12");
  assert.equal(streakSummary({ ...streak, best: 4 }, "2026-10-27"), "4-day streak");
  assert.equal(streakSummary({ current: 0, best: 0, lastDate: null }, "2026-10-27"), "No streak yet");
  assert.equal(streakSummary({ current: 0, best: 3, lastDate: "2026-10-01" }, "2026-10-27"), "No streak yet · best 3");
});

test("a stored streak ends once its last counting day is before yesterday", () => {
  const streak = { current: 4, best: 12, lastDate: "2026-10-26" };
  assert.equal(currentStreak(streak, "2026-10-26"), 4);
  assert.equal(currentStreak(streak, "2026-10-27"), 4); // yesterday still counts: today isn't over
  assert.equal(currentStreak(streak, "2026-10-28"), 0);
  assert.equal(currentStreak({ current: 0, best: 0, lastDate: null }, "2026-10-28"), 0);
  assert.equal(streakSummary(streak, "2026-10-29"), "No streak yet · best 12");
});

test("the leaderboard marker shows from a 2-day streak", () => {
  assert.equal(streakMarker(0), null);
  assert.equal(streakMarker(1), null);
  assert.deepEqual(streakMarker(2), { text: "\u{1F525}2", title: "2-day streak" });
  assert.deepEqual(streakMarker(30), { text: "\u{1F525}30", title: "30-day streak" });
});

test("the sparkline puts the fastest time on top and needs two points", () => {
  assert.equal(sparklinePoints([], 100, 20), null);
  assert.equal(sparklinePoints([5], 100, 20), null);
  assert.equal(sparklinePoints([10, 20], 100, 20), "2,2 98,18"); // slower second time: line goes down
  assert.equal(sparklinePoints([20, 10, 15], 100, 20), "2,18 50,2 98,10");
  assert.equal(sparklinePoints([7, 7, 7], 100, 20), "2,10 50,10 98,10");
  assert.equal(sparklinePoints([1, 2, 4], 10, 10, 0), "0,0 5,3.3 10,10");
});

// Controller

interface Env {
  c: AppController;
  server: FakeServer;
  repo: SudokuRepository;
  store: MemoryStore;
  host: Host;
  seeds: SeedRepository;
}

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

/** Signed in against the fake server and started; `server.stats` (when given) is in place before the first sync. */
async function env(server = new FakeServer(() => NOW), store = new MemoryStore(), signIn = true): Promise<Env> {
  const repo = new SudokuRepository(new AppStorage(store), REDIRECT, "", () => NOW, server.fetch);
  if (signIn) await repo.signInDev("https://sudoku.test", "alice", "Alice");
  const host = makeHost();
  const seeds = new SeedRepository(new MemoryStore(), () => NOW);
  const c = new AppController(repo, seeds, host);
  c.start();
  await idle(c);
  assert.equal(c.phase.kind, "ready");
  return { c, server, repo, store, host, seeds };
}

const statsRequests = (server: FakeServer) => server.requests.filter((r) => r.url.pathname === "/api/v1/me/stats").length;

test("a sync fetches the stats and keeps the streak for the home page", async () => {
  const { c, server } = await env();
  assert.ok(statsRequests(server) >= 1);
  assert.deepEqual(c.streak, { current: 4, best: 12, lastDate: "2026-10-27" });
  assert.equal(c.streakText(), "4-day streak · best 12");
  assert.equal(c.stats!.daily[0]!.completed, 3);
  assert.equal(c.statsError, null);
});

test("the streak is restored from storage after a reload, with the server unreachable", async () => {
  const { store } = await env();
  const offline = new FakeServer(() => NOW);
  offline.online = false;
  const again = await env(offline, store, false);
  assert.deepEqual(again.c.streak, { current: 4, best: 12, lastDate: "2026-10-27" });
  assert.equal(again.c.streakText(), "4-day streak · best 12");
  assert.equal(again.c.stats, null);
});

test("a failing stats request neither fails the sync nor drops the stored streak", async () => {
  const { c, server } = await env();
  server.statsStatus = 500;
  c.sync();
  await idle(c);
  assert.equal(c.notice, null);
  assert.equal(c.streakText(), "4-day streak · best 12");
});

test("a streak that has ended is not shown as current", async () => {
  const server = new FakeServer(() => NOW);
  server.stats = { ...GOOD, streak: { current: 4, best: 12, lastDate: "2026-10-20" } };
  const { c } = await env(server);
  assert.equal(c.streakText(), "No streak yet · best 12");
});

test("an old server without stats leaves the streak unknown", async () => {
  const server = new FakeServer(() => NOW);
  server.statsStatus = 404;
  const { c } = await env(server);
  assert.equal(c.streak, null);
  assert.equal(c.streakText(), null);
  assert.equal(c.notice, null);
});

test("signing out clears the streak and stats, in memory and in storage", async () => {
  const { c, store } = await env();
  assert.ok(store.get("streak"));
  await c.signOut();
  assert.equal(c.streak, null);
  assert.equal(c.stats, null);
  assert.equal(c.streakText(), null);
  assert.equal(store.get("streak"), null);
});

test("seed play never fetches or shows stats", async () => {
  const { c, server } = await env();
  const before = statsRequests(server);
  c.useSeed(s("test-secret-0123456789"));
  await until(() => c.phase.kind === "ready" && c.seed !== null);
  assert.equal(c.streak, null);
  assert.equal(c.streakText(), null);
  c.sync();
  await settled();
  c.openStats();
  assert.equal(c.screen.kind, "today");
  assert.equal(statsRequests(server), before);
});

test("openStats loads the stats", async () => {
  const { c, server } = await env();
  server.stats = { ...GOOD, streak: { current: 1, best: 2, lastDate: "2026-10-27" } };
  c.openStats();
  assert.deepEqual(c.screen, { kind: "stats" });
  assert.equal(c.stats, null);
  await until(() => c.stats !== null);
  assert.deepEqual(c.stats!.streak, { current: 1, best: 2, lastDate: "2026-10-27" });
  assert.equal(c.statsError, null);
  assert.equal(c.streak!.current, 1);
});

test("openStats reports an API error or being offline, and a sync retries it", async () => {
  const { c, server } = await env();
  server.statsStatus = 500;
  c.openStats();
  await until(() => c.statsError !== null);
  assert.equal(c.statsError, "stats broke");
  assert.equal(c.stats, null);

  server.statsStatus = null;
  server.online = false;
  c.openStats();
  await until(() => c.statsError !== null);
  assert.match(c.statsError!, /offline/);

  // Back online: the next sync loads the stats again.
  server.online = true;
  c.sync();
  await idle(c);
  await until(() => c.stats !== null);
  assert.equal(c.statsError, null);
});

test("a sync leaves a loaded Stats screen alone", async () => {
  const { c, server } = await env();
  c.openStats();
  await until(() => c.stats !== null);
  const before = statsRequests(server);
  c.sync();
  await idle(c);
  assert.equal(statsRequests(server), before + 1); // the sync's own refresh only
  assert.equal(c.statsError, null);
});

test("a stale stats response is ignored", async () => {
  const { c, server } = await env();
  let release!: () => void;
  server.statsGate = new Promise<void>((r) => (release = r));
  server.stats = { ...GOOD, streak: { current: 9, best: 9, lastDate: "2026-10-27" } };
  c.openStats();
  server.stats = { ...GOOD, streak: { current: 3, best: 9, lastDate: "2026-10-27" } };
  c.openStats(); // replaces the first request
  release();
  await until(() => c.stats !== null);
  await settled();
  assert.equal(c.stats!.streak.current, 3);

  // The same for failures.
  server.statsGate = new Promise<void>((r) => (release = r));
  server.statsStatus = 500;
  c.openStats();
  c.openStats();
  release();
  await until(() => c.statsError !== null);
  await settled();
  assert.equal(c.statsError, "stats broke");
  assert.equal(c.stats, null);
});

test("leaderboard players keep their streaks through the repository", async () => {
  const { c, server } = await env();
  server.leaderboardPlayers = [{ userId: "alice", displayName: "Alice", completedLevels: [1], streak: 6 }];
  c.openScores();
  await until(() => c.leaderboard !== null);
  assert.equal(c.leaderboard!.players[0]!.streak, 6);
});

test("signing in shows the streak without waiting for another sync", async () => {
  const server = new FakeServer(() => NOW);
  const repo = new SudokuRepository(new AppStorage(new MemoryStore()), REDIRECT, "", () => NOW, server.fetch);
  const c = new AppController(repo, new SeedRepository(new MemoryStore(), () => NOW), makeHost());
  await c.signInDev("alice", "Alice");
  await until(() => c.streak !== null);
  assert.equal(c.streakText(), "4-day streak · best 12");
  assert.equal(c.phase.kind, "ready");
});
