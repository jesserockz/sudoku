import assert from "node:assert/strict";
import { test } from "node:test";
import { AppStorage } from "../src/data/app-storage.ts";
import { Mutex } from "../src/data/mutex.ts";
import { SudokuRepository } from "../src/data/repository.ts";
import { MemoryStore } from "../src/data/store.ts";
import { SeedRepository } from "../src/serverless/seed-repository.ts";
import { AppController, type Host } from "../src/ui/controller.ts";
import { FakeServer } from "./fake-server.ts";

const START = Date.parse("2026-10-27T01:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const REDIRECT = "https://sudoku.test/auth/callback";
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

const DIDNT_ACCEPT = "The server didn't accept your sign-in.";

interface Env {
  c: AppController;
  server: FakeServer;
  repo: SudokuRepository;
  store: MemoryStore;
  clock: { now: number; visible: boolean };
}

/** Signs in through the real OIDC flow against a fake Authentik-like provider and starts a controller on it. */
async function env(): Promise<Env> {
  const clock = { now: START, visible: true };
  const now = () => clock.now;
  const server = new FakeServer(now, "oidc");
  const store = new MemoryStore();
  const repo = new SudokuRepository(new AppStorage(store), REDIRECT, "", now, server.fetch);
  const config = await repo.fetchConfig("https://sudoku.test");
  await repo.completeOidcSignIn(server.authorize(await repo.beginOidcSignIn("https://sudoku.test", config.oidc!)));
  const host: Host = {
    location: { hash: "", pathname: "/", search: "", origin: "https://sudoku.test" } as Location,
    history: { replaceState: () => {} } as unknown as History,
    baseUri: () => "https://sudoku.test/",
    isVisible: () => clock.visible,
    nowMs: () => clock.now,
    wallMs: () => clock.now,
    reloadPage: () => {},
  };
  const c = new AppController(repo, new SeedRepository(new MemoryStore(), now), host);
  c.start();
  await idle(c);
  assert.equal(c.phase.kind, "ready");
  assert.equal(c.notice, null);
  assert.equal(c.needsSignIn, false);
  return { c, server, repo, store, clock };
}

/** Waits for the controller's fire-and-forget sync to finish. */
async function idle(c: AppController): Promise<void> {
  await settled();
  while (c.syncing) await settled();
  await settled();
}

async function syncNow(c: AppController): Promise<void> {
  c.sync();
  await idle(c);
}

/** What the home screen would show: the sign-in banner and the notice. */
const banners = (c: AppController): { signIn: boolean; notice: string | null } => ({ signIn: c.needsSignIn, notice: c.notice });

test("1. an expired access token is refreshed silently", async () => {
  const { c, server, clock } = await env();
  clock.now += 10 * MINUTE;
  await syncNow(c);
  assert.deepEqual(banners(c), { signIn: false, notice: null });
  assert.equal(server.refreshGrants, 1);
});

test("2. resumed with the sign-in server unreachable, then recovering", async () => {
  const { c, server, clock } = await env();
  clock.now += 5 * HOUR;
  server.idpOnline = false;
  await syncNow(c);
  assert.equal(c.needsSignIn, false);
  assert.ok(!c.notice?.includes("didn't accept"), String(c.notice));
  assert.ok(c.notice, "some notice explains the sync didn't happen");
  // The network is back: the periodic retry recovers with no banner at all.
  server.idpOnline = true;
  c.tick();
  await idle(c);
  assert.deepEqual(banners(c), { signIn: false, notice: null });
  assert.equal(server.refreshGrants, 1);
});

test("3. two tabs refreshing at once make one refresh grant", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const mutex = new Mutex();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: (_n: string, cb: () => Promise<unknown>) => mutex.run(cb) } } });
  try {
    const { server, store, repo, clock } = await env();
    const other = new SudokuRepository(new AppStorage(store), REDIRECT, "", () => clock.now, server.fetch);
    clock.now += 10 * MINUTE;
    await Promise.all([repo.refresh(), other.refresh()]);
    assert.equal(server.refreshGrants, 1);
    assert.equal(repo.needsSignIn, false);
    assert.equal(other.needsSignIn, false);
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test("4a. a server clock ahead of the provider: refresh once and retry, no notice", async () => {
  const { c, server, clock } = await env();
  server.skewMs = 2 * MINUTE;
  clock.now += 200_000; // the client still trusts the token (it refreshes at 4 minutes); the server doesn't
  await syncNow(c);
  assert.deepEqual(banners(c), { signIn: false, notice: null });
  assert.equal(server.refreshGrants, 1);
});

test("4b. a token the server forgot (key rotation): refresh once and retry, no notice", async () => {
  const { c, server } = await env();
  server.forgetAccessTokens();
  await syncNow(c);
  assert.deepEqual(banners(c), { signIn: false, notice: null });
  assert.equal(server.refreshGrants, 1);
});

test("5a. a lost rotation response ends the session with the sign-in banner only", async () => {
  const { c, server, clock } = await env();
  clock.now += 10 * MINUTE;
  server.loseTokenResponses = 1;
  await syncNow(c);
  assert.equal(server.refreshGrants, 1);
  assert.equal(c.needsSignIn, false);
  assert.ok(!c.notice?.includes("didn't accept"), String(c.notice));
  // The next refresh presents the refresh token the provider already revoked.
  clock.now += MINUTE;
  await syncNow(c);
  assert.deepEqual(banners(c), { signIn: true, notice: null });
});

test("5b. without rotation the same lost response keeps the user signed in", async () => {
  const { c, server, clock } = await env();
  server.refreshThresholdMs = 7 * DAY;
  clock.now += 10 * MINUTE;
  server.loseTokenResponses = 1;
  await syncNow(c);
  assert.equal(c.needsSignIn, false);
  clock.now += MINUTE;
  c.tick();
  await syncNow(c);
  assert.deepEqual(banners(c), { signIn: false, notice: null });
  assert.equal(server.refreshGrants, 2);
});

test("6. an expired refresh token shows only the sign-in banner", async () => {
  const { c, clock } = await env();
  clock.now += 31 * DAY;
  await syncNow(c);
  assert.deepEqual(banners(c), { signIn: true, notice: null });
});

for (const status of [429, 503]) {
  test(`7. the token endpoint answering ${status} keeps the session and retries later`, async () => {
    const { c, server, repo, clock } = await env();
    clock.now += 10 * MINUTE;
    server.tokenStatus = status;
    await syncNow(c);
    assert.equal(c.needsSignIn, false);
    assert.equal(repo.needsSignIn, false, "tokens were not cleared");
    assert.ok(!c.notice?.includes("didn't accept"), String(c.notice));
    assert.equal(server.refreshGrants, 0);
    server.tokenStatus = null;
    c.tick();
    await idle(c);
    assert.deepEqual(banners(c), { signIn: false, notice: null });
    assert.equal(server.refreshGrants, 1);
  });
}


test("a server that keeps refusing fresh tokens says so, without the sign-in banner", async () => {
  const { c, server } = await env();
  server.skewMs = DAY; // every token looks expired to the API server
  await syncNow(c);
  assert.deepEqual(banners(c), { signIn: false, notice: DIDNT_ACCEPT });
  assert.equal(server.refreshGrants, 1, "refreshed once, retried once, then gave up");
});

test("no sync starts while the page is hidden, and the next one after it is shown works", async () => {
  const { c, server, clock } = await env();
  clock.now += 10 * MINUTE;
  clock.visible = false;
  const requests = server.requests.length;
  await syncNow(c);
  c.tick();
  assert.equal(server.requests.length, requests);
  assert.equal(server.refreshGrants, 0);
  clock.visible = true;
  await syncNow(c);
  assert.equal(server.refreshGrants, 1);
  assert.deepEqual(banners(c), { signIn: false, notice: null });
});

test("a leaderboard fetch with an ended session or an unreachable sign-in server reads as a connection problem", async () => {
  const { c, server, clock } = await env();
  clock.now += 10 * MINUTE;
  server.tokenStatus = 503;
  c.openScores();
  await idle(c);
  assert.match(c.leaderboardError ?? "", /offline/i);
  server.tokenStatus = null;
  server.refreshRevoked = true;
  c.openScores();
  await idle(c);
  assert.equal(c.leaderboardError, "Your sign-in has expired.");
});
