import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiException, SudokuApi } from "../src/api/client.ts";
import { AppStorage } from "../src/data/app-storage.ts";
import { SudokuRepository } from "../src/data/repository.ts";
import { MemoryStore } from "../src/data/store.ts";
import { Game } from "../src/game/game.ts";
import { MAX_REPLAY_EVENTS, REPLAY_VERSION, type ReplayEvent } from "../src/game/replay.ts";
import { FakeServer } from "./fake-server.ts";

const NOW = Date.parse("2026-10-27T01:00:00Z");
const puzzle = "530070000600195000098000060800060003400803001700020006060000280000419005000080079";
const givens = puzzle;
const adminResult = {
  userId: "u 1/x", displayName: "U", level: 2, elapsedMs: 5000, completedAt: "2026-10-27T10:00:00+13:00",
  submittedAt: "2026-10-27T10:00:01+13:00", replay: "valid", replayError: "", flag: null,
};
const flagged = { ...adminResult, flag: { reason: "fast", auto: false, flaggedAt: "2026-10-27T11:00:00Z", flaggedBy: { userId: "a", displayName: "A" } } };

function api(server: FakeServer): SudokuApi {
  return new SudokuApi("https://sudoku.test", async () => "dev:alice:Alice", server.fetch);
}

test("the client lists results, loads a replay and flags and unflags a result", async () => {
  const server = new FakeServer(() => NOW);
  server.admin = true;
  server.adminResultsList = { date: "2026-10-27", levels: 5, results: [adminResult] };
  server.adminReplayDetail = { ...adminResult, date: "2026-10-27", levels: 5, givens, events: [{ a: "start", t: 0, w: 1 }] };
  const c = api(server);

  const list = await c.adminResults("2026-10-27");
  assert.equal(list.results[0]!.userId, "u 1/x");
  const listRequest = server.requests.at(-1)!;
  assert.equal(listRequest.method, "GET");
  assert.equal(listRequest.url.pathname + listRequest.url.search, "/api/v1/admin/results?date=2026-10-27");

  const detail = await c.adminReplay("2026-10-27", 2, "u 1/x");
  assert.deepEqual(detail.events, [{ a: "start", t: 0, w: 1 }]);
  assert.equal(server.requests.at(-1)!.url.pathname, "/api/v1/admin/results/2026-10-27/2/u%201%2Fx/replay");

  server.adminFlagResult = flagged;
  const f = await c.flagResult("2026-10-27", 2, "u 1/x", "fast");
  assert.equal(f.flag?.reason, "fast");
  const put = server.requests.at(-1)!;
  assert.equal(put.method, "PUT");
  assert.equal(put.url.pathname, "/api/v1/admin/results/2026-10-27/2/u%201%2Fx/flag");
  assert.deepEqual(JSON.parse(put.body), { reason: "fast" });
  assert.equal(put.headers.get("Content-Type"), "application/json");
  assert.equal(put.headers.get("Authorization"), "Bearer dev:alice:Alice");

  server.adminFlagResult = adminResult;
  const u = await c.unflagResult("2026-10-27", 2, "u 1/x");
  assert.equal(u.flag, null);
  const del = server.requests.at(-1)!;
  assert.equal(del.method, "DELETE");
  assert.equal(del.url.pathname, "/api/v1/admin/results/2026-10-27/2/u%201%2Fx/flag");
  assert.equal(del.body, "");
  assert.equal(del.headers.get("Content-Type"), null);
});

test("a non-admin gets 403 from the results endpoints", async () => {
  const server = new FakeServer(() => NOW);
  server.admin = false;
  const c = api(server);
  const calls = [
    () => c.adminResults("2026-10-27"), () => c.adminReplay("2026-10-27", 1, "u"),
    () => c.flagResult("2026-10-27", 1, "u", ""), () => c.unflagResult("2026-10-27", 1, "u"),
  ];
  for (const call of calls) {
    await assert.rejects(call(), (e: unknown) => e instanceof ApiException && e.status === 403 && e.error?.message === "admin access required");
  }
});

test("submitting a result sends the replay in the body", async () => {
  const server = new FakeServer(() => NOW);
  const replay = { version: 1, events: [{ a: "start" as const, t: 0, w: 1 }] };
  const result = { date: "2026-10-27", level: 1, elapsedMs: 5, completedAt: "2026-10-27T14:00:00+13:00", replay };
  const posted = await api(server).submitResult(result);
  assert.deepEqual(JSON.parse(server.requests.at(-1)!.body), result);
  assert.equal(posted.kind, "created");
  assert.deepEqual(posted.kind === "created" && posted.result.replay, replay);
});

// Repository

const clock = () => NOW;
async function signedIn(): Promise<{ r: SudokuRepository; server: FakeServer }> {
  const server = new FakeServer(clock);
  const r = new SudokuRepository(new AppStorage(new MemoryStore()), "https://sudoku.test/auth/callback", "", clock, server.fetch);
  await r.signInDev("https://sudoku.test", "alice", "Alice");
  return { r, server };
}

/** A solved game restored from a save that already holds `events`. */
function solvedWith(r: SudokuRepository, events: ReplayEvent[]): Game {
  const p = r.puzzles()![0]!;
  const done = Game.restore({ givens: p.givens, entries: p.solution, notes: new Array<number>(81).fill(0), elapsedMs: 90_000, completed: true, replay: events });
  assert.ok(done.isComplete);
  return done;
}

test("complete queues the result with the game's replay", async () => {
  const { r } = await signedIn();
  const events: ReplayEvent[] = [{ a: "start", t: 0, w: 1 }, { a: "finish", t: 90_000, w: 91_000 }];
  const result = await r.complete(r.today(), 1, solvedWith(r, events));
  assert.deepEqual(result.replay, { version: REPLAY_VERSION, events });
  assert.deepEqual(r.pending(), [result]);
});

test("a replay with more than the maximum events is left out, but the maximum itself is kept", async () => {
  const { r } = await signedIn();
  const event = (i: number): ReplayEvent => ({ a: "hidden", t: 0, w: i });
  const max = await r.complete(r.today(), 1, solvedWith(r, Array.from({ length: MAX_REPLAY_EVENTS }, (_, i) => event(i))));
  assert.equal(max.replay?.events.length, MAX_REPLAY_EVENTS);
  const over = await r.complete(r.today(), 2, solvedWith(r, Array.from({ length: MAX_REPLAY_EVENTS + 1 }, (_, i) => event(i))));
  assert.ok(!("replay" in over));
  assert.ok(!("replay" in r.pending().find((p) => p.level === 2)!));
});
