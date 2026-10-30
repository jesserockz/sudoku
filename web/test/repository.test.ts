import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { SudokuApi } from "../src/api/client.ts";
import type { GameResult } from "../src/api/models.ts";
import { OidcException, TokenSession, defaultLock, type TokenResponse } from "../src/api/oidc.ts";
import { AppStorage, type StoredTokens } from "../src/data/app-storage.ts";
import { SudokuRepository, SignInError, normalizeUrl } from "../src/data/repository.ts";
import { ResultSync, isUnauthorized } from "../src/data/result-sync.ts";
import { MemoryStore, StoredValue, list } from "../src/data/store.ts";
import { Game } from "../src/game/game.ts";
import { generateDay } from "../src/generator/generator.ts";
import { parseWeekSeed } from "../src/generator/week-seed.ts";
import { FakeServer } from "./fake-server.ts";

const REDIRECT = "https://sudoku.test/auth/callback";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let now: number;
let store: MemoryStore;
let server: FakeServer;
const clock = () => now;
const repo = () => new SudokuRepository(new AppStorage(store), REDIRECT, "", clock, server.fetch);

beforeEach(() => {
  now = Date.parse("2026-10-27T01:00:00Z"); // Tuesday 14:00 in Auckland
  store = new MemoryStore();
  server = new FakeServer(clock);
});

function solved(r: SudokuRepository, level: number, ms = 90_000): Game {
  const p = r.puzzles()!.find((x) => x.level === level)!;
  let g = Game.create(p.givens).resume(0);
  for (let i = 0; i < 81; i++) if (p.givens[i] === "0") g = g.place(i, Number(p.solution[i]), ms);
  assert.ok(g.isComplete);
  return g;
}

async function signInOidc(r: SudokuRepository): Promise<void> {
  const config = await r.fetchConfig("https://sudoku.test");
  await r.completeOidcSignIn(server.authorize(await r.beginOidcSignIn("https://sudoku.test", config.oidc!)));
}

test("sign-in fetches the week, and its puzzles play offline", async () => {
  const r = repo();
  assert.ok(!r.isSignedIn);
  assert.equal(r.puzzles(), null);
  await r.signInDev("sudoku.test", "alice", "Alice");
  assert.ok(r.isSignedIn);
  assert.deepEqual(r.me(), { id: "alice", displayName: "Alice" });
  assert.equal(r.settings().serverUrl, "https://sudoku.test");
  const puzzles = r.puzzles()!;
  assert.equal(puzzles.length, 5);
  // Offline, and from a fresh start: the cached week still plays.
  server.online = false;
  assert.deepEqual(repo().puzzles()!.map((p) => p.givens), puzzles.map((p) => p.givens));
  const week = repo().weekFor()!;
  assert.deepEqual(puzzles.map((p) => p.givens), generateDay(parseWeekSeed(week.seed), 2).map((p) => p.givens));
});

test("later days of the week play offline, but not the next week", async () => {
  await repo().signInDev("https://sudoku.test", "alice", "Alice");
  server.online = false;
  now += 5 * DAY; // Sunday
  assert.equal(repo().puzzles()!.length, 5);
  now += DAY; // next Monday
  assert.equal(repo().puzzles(), null);
  await assert.rejects(repo().refresh());
  server.online = true;
  await repo().refresh();
  assert.equal(repo().puzzles()!.length, 5);
});

test("results queue offline and upload later", async () => {
  const r = repo();
  await r.signInDev("https://sudoku.test", "alice", "Alice");
  server.online = false;
  const result = await r.complete(r.today(), 1, solved(r, 1));
  assert.match(result.completedAt, /^2026-10-27T14:00:00\+13:00$/);
  const offline = await r.flush();
  assert.ok(offline.failure instanceof TypeError);
  assert.deepEqual(repo().pending(), [result]);
  server.online = true;
  const report = await repo().refresh();
  assert.deepEqual(report.accepted, [result]);
  assert.deepEqual(repo().pending(), []);
  assert.deepEqual(server.stored, [result]);
  assert.equal(repo().serverResults(r.today()).get(1)?.elapsedMs, 90_000);
});

test("weeks with more games spread the tiers", async () => {
  server.levels = 7;
  const r = repo();
  await r.signInDev("https://sudoku.test", "alice", "Alice");
  assert.deepEqual(r.puzzles()!.map((p) => p.title), ["Easy", "Medium 1", "Medium 2", "Hard", "Expert 1", "Expert 2", "Diabolical"]);
});

test("rejected results are dropped", async () => {
  const r = repo();
  await r.signInDev("https://sudoku.test", "alice", "Alice");
  server.rejectAll = true;
  await r.complete(r.today(), 1, solved(r, 1));
  const report = await r.flush();
  assert.equal(report.rejected.length, 1);
  assert.deepEqual(r.pending(), []);
  assert.equal(server.posts(), 1);
});

test("games persist, and games from other weeks are pruned", async () => {
  const r = repo();
  await r.signInDev("https://sudoku.test", "alice", "Alice");
  const p = r.puzzles()![0]!;
  const g = Game.create(p.givens).resume(0).place(p.givens.indexOf("0"), 1, 0);
  r.saveGame(r.today(), 1, g, 5000);
  const loaded = repo().loadGame(r.today(), p)!;
  assert.equal(loaded.board.toCompactString(), g.board.toCompactString());
  assert.equal(loaded.elapsedMs(0), 5000);
  // Another puzzle in the same slot (e.g. a changed generator) doesn't match.
  assert.equal(repo().loadGame(r.today(), r.puzzles()![1]!), null);
  now += 7 * DAY;
  await repo().refresh();
  assert.equal(repo().loadGame("2026-10-27", p), null);
  assert.equal(new AppStorage(store).games.read() !== null && Object.keys(new AppStorage(store).games.read()!).length, 0);
});

test("a failed sign-in restores the previous settings", async () => {
  server.online = false;
  await assert.rejects(repo().signInDev("https://sudoku.test", "alice", "Alice"));
  assert.ok(!repo().isSignedIn);
  server.online = true;
  await assert.rejects(repo().signInDev("https://sudoku.test", "bad:id", "Alice"), RangeError);
});

test("sign-out forgets user data but keeps the server", async () => {
  const r = repo();
  await r.signInDev("https://sudoku.test", "alice", "Alice");
  await r.complete(r.today(), 1, solved(r, 1));
  server.online = false;
  r.signOut();
  assert.ok(!r.isSignedIn);
  assert.equal(r.me(), null);
  assert.deepEqual(r.pending(), []);
  assert.equal(r.settings().serverUrl, "https://sudoku.test");
});

test("config and URL normalisation", async () => {
  assert.equal((await repo().fetchConfig("sudoku.test/")).authMode, "dev");
  assert.equal(normalizeUrl(" http://localhost:8080/ "), "http://localhost:8080");
  assert.equal(normalizeUrl("sudoku.example.com"), "https://sudoku.example.com");
});

test("OIDC sign-in uses PKCE and the redirect URI", async () => {
  server = new FakeServer(clock, "oidc");
  const r = repo();
  const config = await r.fetchConfig("https://sudoku.test");
  const url = new URL(await r.beginOidcSignIn("https://sudoku.test", config.oidc!));
  assert.equal(url.origin + url.pathname, "https://auth.test/o/authorize/");
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope"), "openid profile offline_access");
  await r.completeOidcSignIn(server.authorize(url.href));
  assert.ok(r.isSignedIn && !r.needsSignIn);
  assert.equal(r.me()?.id, "alice");
  assert.equal(r.puzzles()!.length, 5);
});

test("forged or stale redirects are rejected", async () => {
  server = new FakeServer(clock, "oidc");
  const r = repo();
  const config = await r.fetchConfig("https://sudoku.test");
  const url = await r.beginOidcSignIn("https://sudoku.test", config.oidc!);
  await assert.rejects(r.completeOidcSignIn(server.authorize(url, "forged")), SignInError);
  const again = await r.beginOidcSignIn("https://sudoku.test", config.oidc!);
  now += 16 * MINUTE;
  await assert.rejects(r.completeOidcSignIn(server.authorize(again)), /too long/);
  await assert.rejects(r.completeOidcSignIn(`${REDIRECT}?error=access_denied&error_description=No+thanks`), /No thanks/);
  assert.ok(!r.isSignedIn);
});

test("tokens refresh, and a revoked session keeps offline play and queued results", async () => {
  server = new FakeServer(clock, "oidc");
  const r = repo();
  await signInOidc(r);
  now += 10 * MINUTE; // past the 5-minute access token
  await r.refresh();
  assert.equal(server.refreshGrants, 1);
  server.refreshRevoked = true;
  now += 10 * MINUTE;
  await r.complete(r.today(), 1, solved(r, 1));
  const report = await r.flush();
  assert.ok(isUnauthorized(report));
  assert.ok(r.isSignedIn && r.needsSignIn);
  assert.equal(r.pending().length, 1);
  assert.equal(r.puzzles()!.length, 5);
  // Signing in again uploads the queue.
  server.refreshRevoked = false;
  await signInOidc(r);
  assert.deepEqual(r.pending(), []);
  assert.equal(server.stored.length, 1);
});

test("the end-session URL carries the ID token", async () => {
  server = new FakeServer(clock, "oidc");
  const r = repo();
  await signInOidc(r);
  const url = new URL((await r.endSessionUrl("https://sudoku.test/"))!);
  assert.equal(url.searchParams.get("id_token_hint"), "id-alice");
  assert.equal(url.searchParams.get("post_logout_redirect_uri"), "https://sudoku.test/");
});

test("a different account starts fresh", async () => {
  server = new FakeServer(clock, "oidc");
  const r = repo();
  await signInOidc(r);
  server.online = false;
  await r.complete(r.today(), 1, solved(r, 1));
  server.online = true;
  server.oidcSub = "bob";
  server.rejectAll = true; // would show if alice's result were uploaded as bob's
  await signInOidc(r);
  assert.equal(r.me()?.id, "bob");
  assert.deepEqual(r.pending(), []);
  assert.equal(server.posts(), 0);
});

// The queue on its own.

const result = (level: number, date = "2026-10-26"): GameResult => ({ date, level, elapsedMs: 1000 * level, completedAt: `${date}T09:00:00+13:00` });

test("the result queue keeps one result per puzzle, in order, until the server takes it", async () => {
  const queue = new StoredValue(new MemoryStore(), "pending", (j) => list(j, (x) => x as GameResult));
  let fail = new Set<number>();
  const sent: number[] = [];
  const sync = new ResultSync(queue, async (r) => {
    sent.push(r.level);
    if (fail.has(r.level)) throw new TypeError("offline");
    return { kind: "created", result: r };
  });
  await sync.enqueue(result(1));
  await sync.enqueue({ ...result(1), elapsedMs: 5 });
  await sync.enqueue(result(2));
  await sync.enqueue(result(3));
  assert.deepEqual(sync.pending().map((r) => r.elapsedMs), [1000, 2000, 3000]);
  fail = new Set([2]);
  const report = await sync.flush();
  assert.deepEqual(report.accepted.map((r) => r.level), [1]);
  assert.deepEqual(report.remaining.map((r) => r.level), [2, 3]);
  assert.deepEqual(sync.pending().map((r) => r.level), [2, 3]);
  fail = new Set();
  await sync.flush();
  assert.deepEqual(sync.pending(), []);
  assert.equal(queue.read(), null);
  assert.deepEqual(sent, [1, 2, 2, 3]);
});

// Token refresh on its own.

test("token session: refresh margin, rotation and failures", async () => {
  let tokens: StoredTokens | null = null;
  let refreshes = 0;
  let failWith: Error | null = null;
  const { OidcException } = await import("../src/api/oidc.ts");
  const session = new TokenSession(
    () => tokens,
    (t) => { tokens = t; },
    async (rt) => {
      refreshes++;
      if (failWith) throw failWith;
      return { accessToken: `a${refreshes}`, expiresIn: 300, refreshToken: refreshes === 2 ? "r2" : null, idToken: null };
    },
    clock,
  );
  await session.signedIn({ accessToken: "a0", expiresIn: 300, refreshToken: "r1", idToken: "id" });
  assert.equal(await session.token(), "a0");
  now += 4.5 * MINUTE; // within the minute before expiry
  assert.equal(await session.token(), "a1");
  assert.equal(tokens!.refreshToken, "r1"); // kept when the provider omits it
  assert.equal(tokens!.idToken, "id");
  now += 5 * MINUTE;
  assert.equal(await session.token(), "a2");
  assert.equal(tokens!.refreshToken, "r2"); // rotated
  now += 5 * MINUTE;
  failWith = new TypeError("offline");
  assert.equal(await session.token(), "a2"); // the old token; the API decides
  failWith = new OidcException(400, "invalid_grant", null);
  assert.equal(await session.token(), null);
  assert.equal(tokens, null);
});

/** Two TokenSessions over one shared store, like two tabs. */
function twoTabs(lock: ReturnType<typeof defaultLock> | undefined, refresh: (rt: string) => Promise<TokenResponse>) {
  let tokens: StoredTokens | null = { accessToken: "old", refreshToken: "r1", idToken: null, expiresAtEpochMs: now + 10_000 };
  const make = () => new TokenSession(() => tokens, (t) => { tokens = t; }, refresh, clock, 60_000, lock);
  return { a: make(), b: make(), get tokens() { return tokens; }, set tokens(t) { tokens = t; } };
}

test("token session: a shared lock makes two tabs refresh once", async () => {
  let refreshes = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const shared = <T,>(section: () => Promise<T>): Promise<T> => {
    const r = tail.then(section);
    tail = r.catch(() => undefined);
    return r;
  };
  const tabs = twoTabs(shared, async (rt) => {
    refreshes++;
    if (rt !== "r1") throw new OidcException(400, "invalid_grant", null);
    await Promise.resolve();
    return { accessToken: "new", expiresIn: 300, refreshToken: "r2", idToken: null };
  });
  assert.deepEqual(await Promise.all([tabs.a.token(), tabs.b.token()]), ["new", "new"]);
  assert.equal(refreshes, 1);
  assert.equal(tabs.tokens!.refreshToken, "r2");
});

test("token session: refresh token rotated by another tab does not log out", async () => {
  const tabs = twoTabs(undefined, async () => {
    // The other tab rotates the token while our request is in flight.
    tabs.tokens = { accessToken: "theirs", refreshToken: "r2", idToken: null, expiresAtEpochMs: now + 300_000 };
    throw new OidcException(400, "invalid_grant", null);
  });
  assert.equal(await tabs.a.token(), "theirs");
  assert.equal(tabs.tokens!.refreshToken, "r2");
});

test("token session: a genuine invalid_grant still ends the session", async () => {
  const tabs = twoTabs(undefined, async () => { throw new OidcException(400, "invalid_grant", null); });
  assert.equal(await tabs.a.token(), null);
  assert.equal(tabs.tokens, null);
});

test("token session: a rejection after the tokens were cleared elsewhere ends the session", async () => {
  const tabs = twoTabs(undefined, async () => {
    tabs.tokens = null;
    throw new OidcException(400, "invalid_grant", null);
  });
  assert.equal(await tabs.a.token(), null);
});

test("default lock uses navigator.locks when present, else the mutex", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const requested: string[] = [];
  try {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { locks: { request: (name: string, cb: () => Promise<unknown>) => { requested.push(name); return cb(); } } },
    });
    assert.equal(await defaultLock("x")(async () => 1), 1);
    assert.deepEqual(requested, ["x"]);
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    assert.equal(await defaultLock("x")(async () => 2), 2);
    assert.deepEqual(requested, ["x"]);
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: undefined });
    assert.equal(await defaultLock()(async () => 3), 3);
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test("the API client sends the bearer token and reports errors", async () => {
  const api = new SudokuApi("https://sudoku.test/", async () => "dev:alice:Alice", server.fetch);
  assert.equal((await api.me()).displayName, "Alice");
  assert.equal(server.requests.at(-1)!.headers.get("Authorization"), "Bearer dev:alice:Alice");
  const anonymous = new SudokuApi("https://sudoku.test", async () => null, server.fetch);
  await assert.rejects(anonymous.week(), (e: { status: number; error: { code: string } }) => e.status === 401 && e.error.code === "unauthorized");
});
