import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { EndlessResult, VariantDayResult } from "../src/api/models.ts";
import { AppStorage, type ParkedProgress } from "../src/data/app-storage.ts";
import { SudokuRepository } from "../src/data/repository.ts";
import { MemoryStore } from "../src/data/store.ts";
import { Game, type SavedGame } from "../src/game/game.ts";
import { SeedRepository } from "../src/serverless/seed-repository.ts";
import { AppController, type Host } from "../src/ui/controller.ts";
import { FakeServer } from "./fake-server.ts";

const REDIRECT = "https://sudoku.test/auth/callback";
const URL_ = "https://sudoku.test";
const NOW = Date.parse("2026-10-27T01:00:00Z");
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

let store: MemoryStore;
let server: FakeServer;
const clock = () => NOW;
const storage = () => new AppStorage(store);
const repo = () => new SudokuRepository(storage(), REDIRECT, "", clock, server.fetch);

beforeEach(() => {
  store = new MemoryStore();
  server = new FakeServer(clock);
});

/** A game with one cell filled and `ms` on its timer. */
function partial(givens: string, solution: string, ms: number, layout?: Parameters<typeof Game.create>[1]): SavedGame {
  const cell = [...givens].findIndex((g) => g === "0");
  return Game.create(givens, layout).resume(0).place(cell, Number(solution[cell]), 0).save(ms);
}

const endlessResult = (number: number, elapsedMs: number): EndlessResult => ({
  generator: 1, difficulty: 1, number, elapsedMs, completedAt: "2026-10-27T14:00:00+13:00",
});
const variantDayResult = (date: string, elapsedMs: number): VariantDayResult => ({ date, elapsedMs, completedAt: "2026-10-27T14:00:00+13:00" });

interface Seeded {
  daily: SavedGame;
  endless: SavedGame;
  variantDay: SavedGame;
  endlessKey: string;
  date: string;
}

/** Signed in as `sub` (dev auth) with a game of each kind in progress and a result of each kind queued offline. */
async function seed(r: SudokuRepository, sub = "alice"): Promise<Seeded> {
  await r.signInDev(URL_, sub, sub);
  const date = r.today();
  const p = r.puzzles(date, 1)![1]!;
  const daily = partial(p.givens, p.solution, 40_000);
  r.saveGame(1, date, p.level, Game.restore(daily), 0);
  const e = r.endlessPuzzle(1, 1, 2)!;
  const endless = partial(e.givens, e.solution, 50_000, e.layout);
  r.saveEndlessGame(1, 1, 2, Game.restore(endless, e.layout), 0);
  const v = r.variantDay(r.weekFor()!, date);
  const variantDay = partial(v.givens, v.solution, 60_000, v.layout);
  r.saveVariantDayGame(date, Game.restore(variantDay, v.layout), 0);
  server.online = false;
  const level1 = r.puzzles(date, 1)![0]!;
  let g = Game.create(level1.givens).resume(0);
  for (let i = 0; i < 81; i++) if (level1.givens[i] === "0") g = g.place(i, Number(level1.solution[i]), 90_000);
  await r.complete(1, date, 1, g);
  await r.endlessSync.enqueue(endlessResult(7, 70_000));
  await r.variantDaySync.enqueue(variantDayResult(date, 80_000));
  server.online = true;
  return { daily, endless, variantDay, endlessKey: "1/2", date };
}

function assertRestored(r: SudokuRepository, s: Seeded): void {
  const st = storage();
  assert.deepEqual(st.games.read()![`${s.date}/2`]!.elapsedMs, s.daily.elapsedMs);
  assert.deepEqual(st.games.read()![`${s.date}/2`], s.daily);
  assert.deepEqual(st.endlessGames.read()![s.endlessKey], s.endless);
  assert.deepEqual(st.variantDayGames.read()![s.date], s.variantDay);
  assert.equal(r.me()?.id, "alice");
  assert.equal(st.parkedProgress.read(), null);
}

function assertUploaded(s: Seeded): void {
  assert.deepEqual(server.stored.map((x) => x.level), [1]);
  assert.deepEqual(server.storedEndless.map((x) => x.number), [7]);
  assert.deepEqual(server.storedVariantDay.map((x) => x.date), [s.date]);
  const st = storage();
  assert.deepEqual([st.pending.read() ?? [], st.endlessPending.read() ?? [], st.variantDayPending.read() ?? []], [[], [], []]);
}

test("signing out parks the user's progress and queued results, and the same user signing in again gets them back (dev)", async () => {
  const r = repo();
  const s = await seed(r);
  r.signOut();
  const st = storage();
  assert.equal(st.me.read(), null);
  assert.equal(st.games.read(), null);
  assert.equal(st.pending.read(), null);
  const parked = st.parkedProgress.read()!.alice!;
  assert.equal(parked.games[`${s.date}/2`]!.elapsedMs, 40_000);
  assert.equal(parked.endlessGames[s.endlessKey]!.elapsedMs, 50_000);
  assert.equal(parked.variantDayGames[s.date]!.elapsedMs, 60_000);
  assert.deepEqual([parked.pending.length, parked.endlessPending.length, parked.variantDayPending.length], [1, 1, 1]);

  const again = repo();
  await again.signInDev(URL_, "alice", "alice");
  assertRestored(again, s);
  assertUploaded(s);
});

test("the same user signing in again through OIDC gets their progress back, and a restart keeps it", async () => {
  server = new FakeServer(clock, "oidc");
  const r = repo();
  const config = await r.fetchConfig(URL_);
  const signIn = async (x: SudokuRepository): Promise<void> => x.completeOidcSignIn(server.authorize(await x.beginOidcSignIn(URL_, config.oidc!)));
  await signIn(r);
  const date = r.today();
  const p = r.puzzles(date, 1)![1]!;
  const daily = partial(p.givens, p.solution, 33_000);
  r.saveGame(1, date, 2, Game.restore(daily), 0);
  server.online = false;
  await r.endlessSync.enqueue(endlessResult(3, 1000));
  server.online = true;
  r.signOut();
  assert.ok(storage().parkedProgress.read()!.alice);
  await signIn(repo());
  assert.deepEqual(storage().games.read()![`${date}/2`], daily);
  assert.equal(server.storedEndless.length, 1);
  assert.equal(storage().parkedProgress.read(), null);
});

test("another account signing in sees nothing, the first user's entry stays, and they get it on a later sign-in", async () => {
  const s = await seed(repo());
  repo().signOut();

  const bob = repo();
  await bob.signInDev(URL_, "bob", "Bob");
  const st = storage();
  assert.equal(bob.me()?.id, "bob");
  assert.equal(st.games.read(), null);
  assert.equal(st.endlessGames.read(), null);
  assert.equal(st.variantDayGames.read(), null);
  assert.equal(server.stored.length, 0);
  assert.ok(st.parkedProgress.read()!.alice);

  // Bob has nothing to park, so signing out leaves Alice's entry alone and adds none of his.
  bob.signOut();
  assert.deepEqual(Object.keys(storage().parkedProgress.read()!), ["alice"]);

  // A third account's entry sits beside Alice's and survives hers being taken.
  const carol: ParkedProgress = { games: {}, endlessGames: {}, variantDayGames: {}, pending: [], endlessPending: [endlessResult(1, 1)], variantDayPending: [] };
  storage().parkedProgress.update((all) => ({ ...all, carol }));
  const alice = repo();
  await alice.signInDev(URL_, "alice", "alice");
  assert.deepEqual(storage().parkedProgress.read(), { carol });
  storage().parkedProgress.write(null);
  assertRestored(alice, s);
  assertUploaded(s);
});

test("parking replaces the user's older entry, and nothing is parked (or touched) when there is nothing to keep", async () => {
  const r = repo();
  await r.signInDev(URL_, "alice", "Alice");
  r.signOut();
  assert.equal(storage().parkedProgress.read(), null, "no empty entry");

  const s = await seed(repo());
  const st = storage();
  const stale: ParkedProgress = { games: {}, endlessGames: {}, variantDayGames: {}, pending: [], endlessPending: [endlessResult(1, 1)], variantDayPending: [] };
  st.parkedProgress.write({ alice: stale, carol: stale });
  st.parkProgress();
  const parked = storage().parkedProgress.read()!;
  assert.equal(parked.alice!.games[`${s.date}/2`]!.elapsedMs, 40_000, "replaced, not merged");
  assert.deepEqual(parked.alice!.endlessPending.map((x) => x.number), [7]);
  assert.deepEqual(parked.carol, stale, "other users' entries are left alone");

  // Nothing live to keep: the entry already parked stays as it is.
  st.games.write(null);
  st.endlessGames.write(null);
  st.variantDayGames.write(null);
  st.pending.write(null);
  st.endlessPending.write(null);
  st.variantDayPending.write(null);
  st.parkProgress();
  assert.deepEqual(storage().parkedProgress.read(), parked);
});

test("signing out before the user was ever known keeps today's behaviour: nothing is parked", () => {
  const st = storage();
  st.games.write({ "2026-10-27/1": { givens: "1".repeat(81), entries: "0".repeat(81), notes: [], elapsedMs: 5, completed: false } });
  st.settings.write({ serverUrl: URL_, devUser: null, oidc: null });
  repo().signOut();
  assert.equal(storage().games.read(), null);
  assert.equal(storage().parkedProgress.read(), null);
});

test("a game already live under the same key is kept unless the parked one has more time on it, and queues merge without duplicates", async () => {
  const r = repo();
  const s = await seed(r);
  const date = s.date;
  const parkedDaily = s.daily;
  r.signOut();

  const st = storage();
  // A live daily game with less time than the parked one loses to it; one with more time wins; an unrelated one stays.
  const other = { ...parkedDaily, elapsedMs: 99_000 };
  const less = { ...s.endless, elapsedMs: 1 };
  st.games.write({ [`${date}/2`]: { ...parkedDaily, elapsedMs: 10 }, [`${date}/3`]: other });
  st.endlessGames.write({ [s.endlessKey]: less, "1/9": s.endless });
  st.variantDayGames.write({ [date]: { ...s.variantDay, elapsedMs: 120_000 } });
  // Queues: the same puzzle queued again with another time (the live one wins), and a new one.
  st.pending.write([{ date, level: 1, elapsedMs: 5, completedAt: "2026-10-27T15:00:00+13:00" }]);
  st.endlessPending.write([endlessResult(7, 5), endlessResult(8, 6)]);
  st.variantDayPending.write([variantDayResult(date, 5)]);

  const again = repo();
  await again.signInDev(URL_, "alice", "alice");
  const after = storage();
  assert.equal(after.games.read()![`${date}/2`]!.elapsedMs, 40_000, "parked has more time");
  assert.equal(after.games.read()![`${date}/3`]!.elapsedMs, 99_000, "unrelated live game kept");
  assert.equal(after.endlessGames.read()![s.endlessKey]!.elapsedMs, 50_000);
  assert.equal(after.endlessGames.read()!["1/9"]!.elapsedMs, 50_000);
  assert.equal(after.variantDayGames.read()![date]!.elapsedMs, 120_000, "live has more time");
  assert.deepEqual(server.stored.map((x) => [x.level, x.elapsedMs]), [[1, 5]], "the live result won for the same puzzle");
  assert.deepEqual(server.storedEndless.map((x) => [x.number, x.elapsedMs]).sort(), [[7, 5], [8, 6]]);
  assert.deepEqual(server.storedVariantDay.map((x) => x.elapsedMs), [5]);
});

test("a corrupt parked record reads as nothing", () => {
  store.set("parked-progress", JSON.stringify({ alice: { games: 1 } }));
  assert.equal(storage().parkedProgress.read(), null);
  const ok: ParkedProgress = { games: {}, endlessGames: {}, variantDayGames: {}, pending: [], endlessPending: [], variantDayPending: [] };
  store.set("parked-progress", JSON.stringify({ alice: ok }));
  assert.deepEqual(storage().parkedProgress.read(), { alice: ok });
});

// The controller

function makeController(r: SudokuRepository, mono: { now: number }): AppController {
  const host: Host = {
    location: { hash: "", pathname: "/", search: "", origin: URL_ } as Location,
    history: { replaceState: () => {} } as unknown as History,
    baseUri: () => `${URL_}/`,
    isVisible: () => true,
    nowMs: () => mono.now,
    wallMs: () => NOW,
    reloadPage: () => {},
  };
  return new AppController(r, new SeedRepository(new MemoryStore(), clock), host);
}

async function idle(c: AppController): Promise<void> {
  await settled();
  while (c.syncing) await settled();
  await settled();
}

test("a game in progress survives AppController.signOut and signing in as the same user, timer included", async () => {
  const mono = { now: 10_000 };
  const r = repo();
  await r.signInDev(URL_, "alice", "Alice");
  const c = makeController(r, mono);
  c.start();
  await idle(c);
  c.openPuzzle(2);
  const p = c.puzzle(2)!;
  const cell = [...p.givens].findIndex((g) => g === "0");
  c.update(2, (g) => g.resume(mono.now), { a: "resume" });
  mono.now += 45_000;
  c.update(2, (g) => g.place(cell, Number(p.solution[cell]), mono.now), { a: "place", c: cell, d: Number(p.solution[cell]) });
  const before = c.games.get(2)!.elapsedMs(mono.now);
  assert.equal(before, 45_000);

  await c.signOut();
  assert.equal(c.games.size, 0);
  assert.equal(c.me, null);

  // Someone else on the device sees nothing of it.
  await c.signInDev("bob", "Bob");
  assert.equal(c.games.size, 0);
  await c.signOut();

  mono.now += 600_000;
  await c.signInDev("alice", "Alice");
  await idle(c);
  const game = c.games.get(2)!;
  assert.ok(game, "the game is back");
  assert.equal(game.board.get(cell), Number(p.solution[cell]));
  // The timer was paused with the saved time; it carries on from there instead of starting over.
  assert.equal(game.elapsedMs(mono.now), before);
  c.openPuzzle(2);
  assert.equal(c.games.get(2)!.elapsedMs(mono.now), before);
});
