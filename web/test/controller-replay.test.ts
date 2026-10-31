import assert from "node:assert/strict";
import { test } from "node:test";
import { AppStorage } from "../src/data/app-storage.ts";
import { SudokuRepository } from "../src/data/repository.ts";
import { MemoryStore } from "../src/data/store.ts";
import type { ReplayEvent } from "../src/game/replay.ts";
import type { Puzzle } from "../src/generator/generator.ts";
import type { SeedProfile } from "../src/serverless/seed-repository.ts";
import { SeedRepository } from "../src/serverless/seed-repository.ts";
import { AppController, type Host } from "../src/ui/controller.ts";
import { FakeServer } from "./fake-server.ts";

const NOW = Date.parse("2026-10-27T01:00:00Z");
const WALL = Date.parse("2026-10-27T01:00:00Z");
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Env {
  c: AppController;
  server: FakeServer;
  repo: SudokuRepository;
  /** The monotonic and wall clocks the host reports; assign to move them. */
  clock: { mono: number; wall: number };
}

async function env(admin: boolean | undefined): Promise<Env> {
  const server = new FakeServer(() => NOW);
  server.admin = admin;
  const repo = new SudokuRepository(new AppStorage(new MemoryStore()), "https://sudoku.test/auth/callback", "", () => NOW, server.fetch);
  await repo.signInDev("https://sudoku.test", "alice", "Alice");
  const clock = { mono: 10_000, wall: WALL };
  const host: Host = {
    location: { hash: "", pathname: "/", search: "", origin: "https://sudoku.test" } as Location,
    history: { replaceState: () => {} } as unknown as History,
    baseUri: () => "https://sudoku.test/",
    isVisible: () => true,
    nowMs: () => clock.mono,
    wallMs: () => clock.wall,
    reloadPage: () => {},
  };
  const c = new AppController(repo, new SeedRepository(new MemoryStore(), () => NOW), host);
  c.start();
  await settled();
  await settled();
  // start() kicks off a background sync that reloads the day when it ends; let it finish so it can't land mid-test.
  while (c.syncing) await settled();
  assert.equal(c.phase.kind, "ready");
  return { c, server, repo, clock };
}

const replayOf = (c: AppController, level = 1): readonly ReplayEvent[] => c.games.get(level)!.replay;
const puzzleOf = (c: AppController, level = 1): Puzzle => c.puzzle(level)!;
const emptyCells = (p: Puzzle) => [...p.givens].flatMap((g, i) => (g === "0" ? [i] : []));

// Recording

test("opening a puzzle stamps a start event once", async () => {
  const { c, clock } = await env(false);
  clock.wall = WALL + 5;
  c.openPuzzle(1);
  assert.deepEqual(replayOf(c), [{ t: 0, w: WALL + 5, a: "start" }]);
  assert.deepEqual(c.screen, { kind: "play", level: 1 });
  clock.wall = WALL + 99;
  c.openPuzzle(1);
  assert.equal(replayOf(c).length, 1);
});

test("an action is recorded with the game timer and the wall clock", async () => {
  const { c, clock } = await env(false);
  const p = puzzleOf(c);
  const [first, second] = emptyCells(p) as [number, number];
  c.openPuzzle(1);
  c.update(1, (g) => g.resume(clock.mono), { a: "resume" });
  clock.mono += 1234.6;
  clock.wall += 2000;
  c.update(1, (g) => g.place(first, Number(p.solution[first]), clock.mono), { a: "place", c: first, d: Number(p.solution[first]) });
  clock.mono += 500;
  clock.wall += 700;
  c.update(1, (g) => g.toggleNote(second, 3), { a: "noteAdd", c: second, d: 3 });
  assert.deepEqual(replayOf(c), [
    { t: 0, w: WALL, a: "start" },
    { t: 0, w: WALL, a: "resume" },
    { t: 1235, w: WALL + 2000, a: "place", c: first, d: Number(p.solution[first]) },
    { t: 1735, w: WALL + 2700, a: "noteAdd", c: second, d: 3 },
  ]);
});

test("a change without an action records nothing", async () => {
  const { c, clock } = await env(false);
  const p = puzzleOf(c);
  const cell = emptyCells(p)[0]!;
  c.openPuzzle(1);
  c.update(1, (g) => g.place(cell, 1, clock.mono));
  assert.equal(c.games.get(1)!.board.get(cell), 1);
  assert.equal(replayOf(c).length, 1);
});

test("pause and resume are recorded only when the timer actually changes", async () => {
  const { c, clock } = await env(false);
  c.openPuzzle(1);
  const actions = () => replayOf(c).map((e) => e.a);
  c.update(1, (g) => g.pause(clock.mono), { a: "pause" }); // never started: nothing stopped
  assert.deepEqual(actions(), ["start"]);
  c.update(1, (g) => g.resume(clock.mono), { a: "resume" });
  assert.deepEqual(actions(), ["start", "resume"]);
  c.update(1, (g) => g.resume(clock.mono), { a: "resume" }); // already running
  assert.deepEqual(actions(), ["start", "resume"]);
  clock.mono += 1000;
  c.update(1, (g) => g.pause(clock.mono), { a: "pause" });
  assert.deepEqual(actions(), ["start", "resume", "pause"]);
  c.update(1, (g) => g.pause(clock.mono), { a: "pause" }); // already stopped
  assert.deepEqual(actions(), ["start", "resume", "pause"]);
  assert.equal(replayOf(c)[2]!.t, 1000);
});

test("changes that do nothing record nothing", async () => {
  const { c, clock } = await env(false);
  const p = puzzleOf(c);
  const given = [...p.givens].findIndex((g) => g !== "0");
  c.openPuzzle(1);
  c.update(1, (g) => g.resume(clock.mono), { a: "resume" });
  const before = c.games.get(1);
  c.update(1, (g) => g.place(given, 1, clock.mono), { a: "place", c: given, d: 1 });
  c.update(1, (g) => g.undo(), { a: "undo" });
  c.update(1, (g) => g.erase(emptyCells(p)[0]!), { a: "erase", c: emptyCells(p)[0]! });
  c.update(1, (g) => g.clearAll(), { a: "clear" });
  assert.equal(c.games.get(1), before);
  assert.equal(replayOf(c).length, 2);
  // And a level with no game.
  c.update(5, (g) => g.undo(), { a: "undo" });
  assert.equal(c.games.has(5), false);
});

/** Plays level 1 through, leaving the last cell for the caller. */
function playAllButLast(e: Env): { cells: number[]; solution: string } {
  const { c, clock } = e;
  const p = puzzleOf(c);
  const cells = emptyCells(p);
  c.openPuzzle(1);
  c.update(1, (g) => g.resume(clock.mono), { a: "resume" });
  for (const cell of cells.slice(0, -1)) {
    clock.mono += 100;
    clock.wall += 150;
    c.update(1, (g) => g.place(cell, Number(p.solution[cell]), clock.mono), { a: "place", c: cell, d: Number(p.solution[cell]) });
  }
  return { cells, solution: p.solution };
}

test("the solving place is followed by a finish event at the completed time, and the result carries the replay", async () => {
  const e = await env(false);
  const { c, clock } = e;
  const { cells, solution } = playAllButLast(e);
  const last = cells[cells.length - 1]!;
  clock.mono += 333;
  clock.wall += 400;
  c.update(1, (g) => g.place(last, Number(solution[last]), clock.mono), { a: "place", c: last, d: Number(solution[last]) });
  const game = c.games.get(1)!;
  assert.ok(game.isComplete);
  const tail = replayOf(c).slice(-2);
  assert.deepEqual(tail.map((x) => x.a), ["place", "finish"]);
  assert.equal(tail[1]!.t, game.completedElapsedMs);
  assert.equal(tail[1]!.w, clock.wall);
  assert.equal(tail[0]!.c, last);
  await settled();
  const queued = e.repo.pending().length > 0 ? e.repo.pending() : [...e.server.stored];
  assert.deepEqual(queued[0]!.replay!.events, [...replayOf(c)]);
});

test("a solving change without an action records only the finish", async () => {
  const e = await env(false);
  const { c, clock } = e;
  const { cells, solution } = playAllButLast(e);
  const last = cells[cells.length - 1]!;
  const n = replayOf(c).length;
  c.update(1, (g) => g.place(last, Number(solution[last]), clock.mono));
  assert.deepEqual(replayOf(c).slice(n).map((x) => x.a), ["finish"]);
});

test("nothing is recorded once the game is complete", async () => {
  const e = await env(false);
  const { c, clock } = e;
  const { cells, solution } = playAllButLast(e);
  const last = cells[cells.length - 1]!;
  c.update(1, (g) => g.place(last, Number(solution[last]), clock.mono), { a: "place", c: last, d: Number(solution[last]) });
  const done = c.games.get(1)!;
  const n = done.replay.length;
  // A change that yields a new game, as an action on a finished one would.
  c.update(1, (g) => g.record({ t: 1, w: 1, a: "hidden" }).record({ t: 2, w: 2, a: "visible" }), { a: "resume" });
  const after = c.games.get(1)!;
  assert.equal(after.replay.length, n + 2);
  assert.deepEqual(after.replay.slice(n).map((x) => x.a), ["hidden", "visible"]);
  c.log(1, { a: "hidden" });
  assert.equal(c.games.get(1)!.replay.length, n + 2);
});

test("log records actions that don't change the board", async () => {
  const { c, clock } = await env(false);
  c.openPuzzle(1);
  c.update(1, (g) => g.resume(clock.mono), { a: "resume" });
  clock.mono += 250;
  clock.wall += 300;
  c.log(1, { a: "notes", on: true });
  c.log(1, { a: "hidden" });
  clock.wall += 1000;
  c.log(1, { a: "visible" });
  assert.deepEqual(replayOf(c).slice(2), [
    { t: 250, w: WALL + 300, a: "notes", on: true },
    { t: 250, w: WALL + 300, a: "hidden" },
    { t: 250, w: WALL + 1300, a: "visible" },
  ]);
});

test("log does nothing for a missing game", async () => {
  const { c } = await env(false);
  c.log(1, { a: "hidden" });
  assert.equal(c.games.has(1), false);
});

test("a game reloaded from storage gets a restore event before its next action", async () => {
  const e = await env(false);
  const { c, clock, repo } = e;
  c.openPuzzle(1);
  c.update(1, (g) => g.resume(clock.mono), { a: "resume" });
  const reloaded = repo.loadGame(c.today, puzzleOf(c))!;
  assert.deepEqual(reloaded.replay.map((x) => x.a), ["start", "resume"]);
  c.games.set(1, reloaded);
  clock.wall += 5000;
  c.log(1, { a: "visible" });
  assert.deepEqual(replayOf(c).map((x) => x.a), ["start", "resume", "restore", "visible"]);
});

// Admin screens

const key = { level: 1, userId: "bob" };
const result = { userId: "bob", displayName: "Bob", level: 1, elapsedMs: 5000, completedAt: "c", submittedAt: "s", replay: "valid", replayError: "", flag: null };

async function adminEnv(): Promise<Env> {
  const e = await env(true);
  const p = puzzleOf(e.c);
  e.server.adminResultsList = { date: "2026-10-27", levels: 5, results: [result] };
  e.server.adminReplayDetail = { ...result, date: "2026-10-27", levels: 5, givens: p.givens, events: [{ a: "start", t: 0, w: 1 }] };
  return e;
}

const requests = (e: Env, suffix: string) => e.server.requests.filter((r) => r.url.pathname.endsWith(suffix)).length;

test("the admin results screen opens for an admin and loads today", async () => {
  const e = await adminEnv();
  const { c } = e;
  assert.equal(c.me?.admin, true);
  assert.equal(c.adminResults, null);
  c.openAdminResults();
  assert.deepEqual(c.screen, { kind: "admin-results" });
  assert.equal(c.adminResults!.date, c.today);
  assert.ok(c.adminResults!.loading);
  await settled();
  await settled();
  assert.equal(c.adminResults!.data!.results.length, 1);
  assert.equal(e.server.requests.at(-1)!.url.search, `?date=${c.today}`);
});

test("the admin results screen is closed to non-admins and to serverless play", async () => {
  const plain = await env(false);
  plain.c.openAdminResults();
  assert.equal(plain.c.adminResults, null);
  assert.equal(plain.c.screen.kind, "today");

  const e = await adminEnv();
  e.c.seed = { name: "x" } as unknown as SeedProfile;
  e.c.openAdminResults();
  assert.equal(e.c.adminResults, null);
  assert.equal(e.c.screen.kind, "today");
});

test("opening a replay shows the replay screen and loads it with the digits hidden", async () => {
  const e = await adminEnv();
  const { c } = e;
  c.openAdminResults();
  await settled();
  c.openReplay(key);
  assert.deepEqual(c.screen, { kind: "replay" });
  assert.deepEqual(c.adminResults!.opened, key);
  await settled();
  await settled();
  assert.ok(c.adminResults!.viewer);
  assert.equal(c.adminResults!.viewer!.revealDigits, false);
  assert.equal(requests(e, "/replay"), 1);
});

test("openReplay without the results model does nothing", async () => {
  const e = await adminEnv();
  e.c.openReplay(key);
  assert.equal(e.c.screen.kind, "today");
  assert.equal(requests(e, "/replay"), 0);
});

test("going back from a replay keeps the model and its date and closes the viewer", async () => {
  const e = await adminEnv();
  const { c } = e;
  c.openAdminResults();
  await settled();
  await c.adminResults!.load("2026-10-25");
  const model = c.adminResults!;
  c.openReplay(key);
  await settled();
  await settled();
  assert.ok(model.viewer);
  const loads = requests(e, "/admin/results");
  c.openAdminResults();
  assert.equal(c.adminResults, model);
  assert.equal(model.date, "2026-10-25");
  assert.equal(model.viewer, null);
  assert.equal(model.opened, null);
  assert.deepEqual(c.screen, { kind: "admin-results" });
  await settled();
  assert.equal(requests(e, "/admin/results"), loads);
});

test("opening the results screen again from elsewhere starts a fresh model", async () => {
  const e = await adminEnv();
  const { c } = e;
  c.openAdminResults();
  const first = c.adminResults!;
  await settled();
  c.screen = { kind: "today" };
  c.openAdminResults();
  assert.notEqual(c.adminResults, first);
  // A replay screen with no model behind it is treated the same way.
  c.adminResults = null;
  c.screen = { kind: "replay" };
  c.openAdminResults();
  assert.ok(c.adminResults);
  assert.deepEqual(c.screen, { kind: "admin-results" });
  await settled();
});
