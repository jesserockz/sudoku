import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeAdminResult, decodeAdminResults, decodeGameResult, decodeLeaderboard, decodeReplayDetail, decodeResultFlag,
} from "../src/api/models.ts";
import { decodeSavedGame } from "../src/data/app-storage.ts";
import { Game } from "../src/game/game.ts";
import { decodeReplay, decodeReplayEvent, type ReplayEvent } from "../src/game/replay.ts";

const puzzle = "530070000600195000098000060800060003400803001700020006060000280000419005000080079";
const solution = "534678912672195348198342567859761423426853791713924856961537284287419635345286179";
const digit = (i: number) => Number(solution[i]);
const empties = () => [...puzzle].flatMap((c, i) => (c === "0" ? [i] : []));
const ev = (a: ReplayEvent["a"], t: number, w: number, extra: Partial<ReplayEvent> = {}): ReplayEvent => ({ a, t, w, ...extra });

// Game

test("record appends events in order", () => {
  const g = Game.create(puzzle).record(ev("start", 0, 100)).record(ev("place", 500, 600, { c: 2, d: 4 }));
  assert.deepEqual(g.replay, [ev("start", 0, 100), ev("place", 500, 600, { c: 2, d: 4 })]);
  assert.deepEqual(Game.create(puzzle).replay, []);
});

test("a restored game puts a restore event before the first event recorded after it", () => {
  const saved = Game.create(puzzle).resume(0).record(ev("start", 0, 100)).save(1000);
  const restored = Game.restore(saved);
  assert.deepEqual(restored.replay, [ev("start", 0, 100)]);

  const first = restored.record(ev("place", 1000, 5000, { c: 2, d: 4 }));
  assert.deepEqual(first.replay, [ev("start", 0, 100), ev("restore", 1000, 5000), ev("place", 1000, 5000, { c: 2, d: 4 })]);
  const second = first.record(ev("erase", 1200, 5200, { c: 2 }));
  assert.deepEqual(second.replay.map((e) => e.a), ["start", "restore", "place", "erase"]);
  // The original isn't touched.
  assert.equal(restored.replay.length, 1);
});

test("the restore event waits for a record even when moves happen first, and survives undo and completion", () => {
  const restored = Game.restore(Game.create(puzzle).save(0)).resume(0);
  const moved = restored.place(2, 4, 10).toggleNote(3, 1).undo();
  assert.equal(moved.replay.length, 0);
  assert.deepEqual(moved.record(ev("undo", 10, 20)).replay.map((e) => e.a), ["restore", "undo"]);

  const [nearly, last] = nearlySolved(Game.restore(Game.create(puzzle).save(0)).resume(0));
  const done = nearly.place(last, digit(last), 777);
  assert.ok(done.isComplete);
  assert.deepEqual(done.record(ev("finish", 777, 900)).replay.map((e) => e.a), ["restore", "finish"]);
});

function nearlySolved(start: Game): [Game, number] {
  let g = start;
  const cells = empties();
  for (const i of cells.slice(0, -1)) g = g.place(i, digit(i), 0);
  return [g, cells[cells.length - 1]!];
}

test("the replay survives every game operation", () => {
  const recorded = Game.create(puzzle).resume(0).record(ev("start", 0, 1));
  const events = recorded.replay;
  let g = recorded.place(2, 4, 100);
  assert.equal(g.replay, events);
  g = g.toggleNote(3, 1);
  assert.equal(g.replay, events);
  g = g.erase(3);
  assert.equal(g.replay, events);
  g = g.undo();
  assert.equal(g.replay, events);
  g = g.clearAll();
  assert.equal(g.replay, events);
  g = g.pause(200);
  assert.equal(g.replay, events);
  g = g.resume(300);
  assert.equal(g.replay, events);
  const [nearly, last] = nearlySolved(g);
  assert.equal(nearly.replay, events);
  const done = nearly.place(last, digit(last), 400);
  assert.ok(done.isComplete);
  assert.equal(done.replay, events);
  assert.equal(done.pause(500).replay, events);
});

test("save includes the replay and restore reads it back", () => {
  const g = Game.create(puzzle).resume(0).record(ev("start", 0, 1)).record(ev("place", 5, 6, { c: 2, d: 4 }));
  const saved = g.save(10);
  assert.deepEqual(saved.replay, g.replay);
  assert.notEqual(saved.replay, g.replay);
  assert.deepEqual(Game.restore(saved).replay, g.replay);
  // A save from before replays were recorded restores with an empty one.
  const { replay: _, ...old } = saved;
  assert.deepEqual(Game.restore(old).replay, []);
});

// Storage

test("decodeSavedGame reads the replay when there is one", () => {
  const base = { givens: puzzle, entries: puzzle, notes: [], elapsedMs: 5, completed: false };
  const old = decodeSavedGame(base);
  assert.ok(!("replay" in old));
  const events = [ev("start", 0, 1), ev("place", 5, 6, { c: 2, d: 4 }), ev("notes", 6, 7, { on: true })];
  assert.deepEqual(decodeSavedGame({ ...base, replay: events }).replay, events);
  assert.deepEqual(decodeSavedGame({ ...base, replay: [] }).replay, []);
  assert.throws(() => decodeSavedGame({ ...base, replay: [{ a: "bogus", t: 0, w: 0 }] }), /unknown replay action/);
});

// Replay decoding

test("replay events decode, with optional fields", () => {
  assert.deepEqual(decodeReplayEvent({ a: "start", t: 0, w: 5 }), { a: "start", t: 0, w: 5 });
  assert.deepEqual(decodeReplayEvent({ a: "place", t: 1, w: 2, c: 3, d: 4, on: false }), { a: "place", t: 1, w: 2, c: 3, d: 4, on: false });
  assert.deepEqual(decodeReplayEvent({ a: "notes", t: 1, w: 2, c: null, on: true }), { a: "notes", t: 1, w: 2, on: true });
  assert.throws(() => decodeReplayEvent({ a: "teleport", t: 1, w: 2 }), /unknown replay action: teleport/);
  assert.throws(() => decodeReplayEvent({ a: "start", t: "1", w: 2 }), TypeError);
});

test("a replay decodes with its version and events", () => {
  assert.deepEqual(decodeReplay({ version: 1, events: [{ a: "finish", t: 9, w: 10 }] }), { version: 1, events: [{ a: "finish", t: 9, w: 10 }] });
  assert.throws(() => decodeReplay({ version: 1, events: {} }), TypeError);
});

// Models

const entry = { rank: 1, userId: "u", displayName: "U", elapsedMs: 5 };

test("leaderboard entries carry suspicious, which defaults to false", () => {
  const board = decodeLeaderboard({
    date: "2026-10-27",
    puzzles: [{ level: 1, entries: [{ ...entry, suspicious: true }, entry] }],
    total: { entries: [{ rank: 1, userId: "u", displayName: "U", totalMs: 9, suspicious: true }, { rank: 2, userId: "v", displayName: "V", totalMs: 10 }] },
    players: [],
  });
  assert.deepEqual(board.puzzles[0]!.entries.map((e) => e.suspicious), [true, false]);
  assert.deepEqual(board.total.entries.map((e) => e.suspicious), [true, false]);
});

test("a game result decodes its replay when it has one", () => {
  const base = { date: "2026-10-27", level: 1, elapsedMs: 5, completedAt: "2026-10-27T10:00:00+13:00" };
  assert.ok(!("replay" in decodeGameResult(base)));
  const replay = { version: 1, events: [{ a: "start", t: 0, w: 1 }] };
  assert.deepEqual(decodeGameResult({ ...base, replay }).replay, replay);
});

test("result flags decode, with the optional fields defaulted", () => {
  assert.deepEqual(decodeResultFlag({ flaggedAt: "2026-10-27T01:00:00Z" }), { reason: "", auto: false, flaggedAt: "2026-10-27T01:00:00Z", flaggedBy: null });
  assert.deepEqual(
    decodeResultFlag({ reason: "too fast", auto: true, flaggedAt: "x", flaggedBy: { userId: "a", displayName: "A" } }),
    { reason: "too fast", auto: true, flaggedAt: "x", flaggedBy: { userId: "a", displayName: "A" } },
  );
});

const adminResult = {
  userId: "u", displayName: "U", level: 2, elapsedMs: 5000, completedAt: "2026-10-27T10:00:00+13:00",
  submittedAt: "2026-10-27T10:00:01+13:00", replay: "valid", replayError: "", flag: null,
};

test("admin results decode, with the optional fields defaulted", () => {
  assert.deepEqual(decodeAdminResult(adminResult), adminResult);
  const sparse = decodeAdminResult({ userId: "u", displayName: "U", level: 2, elapsedMs: 1, completedAt: "c", replay: "none" });
  assert.deepEqual([sparse.submittedAt, sparse.replayError, sparse.flag], ["", "", null]);
  const flagged = decodeAdminResult({ ...adminResult, replay: "invalid", replayError: "bad", flag: { flaggedAt: "f", auto: true } });
  assert.deepEqual([flagged.replay, flagged.replayError, flagged.flag?.auto], ["invalid", "bad", true]);
  for (const status of ["valid", "invalid", "missing", "none"]) assert.equal(decodeAdminResult({ ...adminResult, replay: status }).replay, status);
  assert.throws(() => decodeAdminResult({ ...adminResult, replay: "maybe" }), /replay status/);
});

test("the admin results list decodes", () => {
  const list = decodeAdminResults({ date: "2026-10-27", levels: 5, results: [adminResult] });
  assert.deepEqual([list.date, list.levels, list.results.length], ["2026-10-27", 5, 1]);
  assert.throws(() => decodeAdminResults({ date: "nope", levels: 5, results: [] }));
});

test("a replay detail decodes the result, the givens and the events", () => {
  const detail = { ...adminResult, date: "2026-10-27", levels: 5, givens: puzzle, events: [{ a: "start", t: 0, w: 1 }] };
  const d = decodeReplayDetail(detail);
  assert.deepEqual([d.userId, d.date, d.levels, d.givens, d.events], ["u", "2026-10-27", 5, puzzle, [{ a: "start", t: 0, w: 1 }]]);
  const { events: _, ...noEvents } = detail;
  assert.deepEqual(decodeReplayDetail(noEvents).events, []);
  assert.throws(() => decodeReplayDetail({ ...detail, givens: "123" }), /81 digits/);
  assert.throws(() => decodeReplayDetail({ ...detail, givens: puzzle.replace(/0/g, ".") }), /81 digits/);
});
