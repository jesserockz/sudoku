// Maintenance mode: the admin switches it on, non-admins get 503 `maintenance`, and the app tells players the server is
// down (their scores wait in the queue) while admins play as usual with a reminder.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiException, SudokuApi } from "../src/api/client.ts";
import { decodeApiError, decodeAppConfig, decodeMaintenanceSettings } from "../src/api/models.ts";
import { AppStorage } from "../src/data/app-storage.ts";
import { SudokuRepository } from "../src/data/repository.ts";
import { MemoryStore } from "../src/data/store.ts";
import { Game } from "../src/game/game.ts";
import { SeedRepository } from "../src/serverless/seed-repository.ts";
import { AppController, CALLBACK_PATH, type Host } from "../src/ui/controller.ts";
import { backAround, backAroundOf, fromLocalInput, maintenanceError, PLAYER_TRY_LATER, toLocalInput } from "../src/ui/maintenance.ts";
import { FakeServer } from "./fake-server.ts";

const NOW = Date.parse("2026-10-27T01:00:00Z"); // Tuesday 2026-10-27 14:00 in Auckland
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const ORIGIN = "https://sudoku.test";
const UNTIL = "2026-10-27T05:00:00Z";
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

// Wording

test("an end time reads as the weekday and time in the viewer's locale and zone", () => {
  const now = new Date(NOW);
  const near = backAround(new Date("2026-10-27T02:00:00Z"), now, "en-NZ", "Pacific/Auckland");
  assert.match(near, /^Back around Tue,? 3:00\s?pm$/i);
  // Under six days away: still no date.
  assert.doesNotMatch(backAround(new Date(NOW + 5 * DAY), now, "en-NZ", "Pacific/Auckland"), /\b(Oct|Nov)\b/);
  // Further away the date is added.
  const far = backAround(new Date("2026-11-06T02:00:00Z"), now, "en-NZ", "Pacific/Auckland");
  assert.match(far, /^Back around \w{3},? 6 Nov,? 3:00\s?pm$/i);
  // Without a zone or locale it still formats (the viewer's own).
  assert.match(backAround(new Date(NOW + MINUTE), now), /^Back around /);
});

test("the end time is only mentioned when there is one", () => {
  const now = new Date(NOW);
  assert.equal(backAroundOf({ until: null }, now), null);
  assert.match(backAroundOf({ until: new Date(NOW + 60 * MINUTE) }, now)!, /^Back around /);
  assert.equal(maintenanceError({ until: null }, now), PLAYER_TRY_LATER);
  assert.match(maintenanceError({ until: new Date(NOW + 60 * MINUTE) }, now), /^The server is down for maintenance\. Back around .+\.$/);
});

test("datetime-local values are the viewer's local time to the minute", () => {
  const d = new Date(2026, 10, 17, 15, 5, 42);
  assert.equal(toLocalInput(d), "2026-11-17T15:05");
  assert.equal(fromLocalInput("2026-11-17T15:05")?.getTime(), new Date(2026, 10, 17, 15, 5).getTime());
  assert.equal(toLocalInput(new Date(2026, 0, 2, 3, 4)), "2026-01-02T03:04");
  assert.equal(fromLocalInput(""), null);
  assert.equal(fromLocalInput("not a date"), null);
});

// Models and client

test("a maintenance error carries when the server is expected back, when it says", () => {
  const body = (error: object) => ({ error: { code: "maintenance", message: "down", ...error } });
  assert.deepEqual(decodeApiError(body({ until: UNTIL })), { code: "maintenance", message: "down", until: new Date(UNTIL) });
  assert.deepEqual(decodeApiError(body({})), { code: "maintenance", message: "down" });
  assert.deepEqual(decodeApiError({ error: { code: "maintenance" } }), { code: "maintenance", message: "" });
  assert.deepEqual(decodeApiError(body({ until: null })), { code: "maintenance", message: "down" });
  // A display hint is never worth failing over.
  assert.deepEqual(decodeApiError(body({ until: "soon" })), { code: "maintenance", message: "down" });
  assert.deepEqual(decodeApiError(body({ until: 5 })), { code: "maintenance", message: "down" });
});

test("the config reports maintenance; older servers don't, which is off", () => {
  const base = { timezone: "Pacific/Auckland", authMode: "dev" };
  assert.ok(!("maintenance" in decodeAppConfig(base)));
  assert.ok(!("maintenance" in decodeAppConfig({ ...base, maintenance: null })));
  assert.deepEqual(decodeAppConfig({ ...base, maintenance: { until: null } }).maintenance, { until: null });
  assert.deepEqual(decodeAppConfig({ ...base, maintenance: {} }).maintenance, { until: null });
  assert.deepEqual(decodeAppConfig({ ...base, maintenance: { until: UNTIL } }).maintenance, { until: new Date(UNTIL) });
  assert.deepEqual(decodeAppConfig({ ...base, maintenance: { until: "x" } }).maintenance, { until: null });
});

test("the admin setting decodes, with a strict end time", () => {
  assert.deepEqual(decodeMaintenanceSettings({ enabled: true, until: UNTIL }), { enabled: true, until: new Date(UNTIL) });
  assert.deepEqual(decodeMaintenanceSettings({ enabled: false, until: null }), { enabled: false, until: null });
  assert.deepEqual(decodeMaintenanceSettings({ enabled: false }), { enabled: false, until: null });
  assert.throws(() => decodeMaintenanceSettings({ enabled: true, until: "x" }), /not a timestamp: x/);
  assert.throws(() => decodeMaintenanceSettings({ until: null }), TypeError);
});

test("the client tells a maintenance 503 from another, and reads and sets the mode", async () => {
  const server = new FakeServer(() => NOW);
  const client = new SudokuApi(ORIGIN, async () => "dev:alice:Alice", server.fetch);
  server.maintenance = { until: UNTIL };
  await assert.rejects(client.week(), (e) => {
    assert.ok(e instanceof ApiException);
    assert.equal(e.status, 503);
    assert.equal(e.isMaintenance, true);
    assert.deepEqual(e.maintenanceUntil, new Date(UNTIL));
    return true;
  });
  server.maintenance = { until: null };
  await assert.rejects(client.week(), (e) => e instanceof ApiException && e.isMaintenance && e.maintenanceUntil === null);
  // Another 503 (e.g. the identity server being down) is not maintenance.
  const other = new ApiException(503, { code: "auth_unavailable", message: "x" });
  assert.equal(other.isMaintenance, false);
  assert.equal(other.maintenanceUntil, null);
  assert.equal(new ApiException(503, null).isMaintenance, false);

  server.maintenance = null;
  server.admin = true;
  assert.deepEqual(await client.adminMaintenance(), { enabled: false, until: null });
  assert.deepEqual(await client.setMaintenance(true, new Date(UNTIL)), { enabled: true, until: new Date(UNTIL) });
  assert.deepEqual(server.maintenance, { until: "2026-10-27T05:00:00.000Z" });
  assert.deepEqual(JSON.parse(server.requests.at(-1)!.body), { enabled: true, until: "2026-10-27T05:00:00.000Z" });
  assert.deepEqual(await client.setMaintenance(false, null), { enabled: false, until: null });
  assert.deepEqual(JSON.parse(server.requests.at(-1)!.body), { enabled: false, until: null });
  assert.equal(server.maintenance, null);
});

// The app

interface Env {
  c: AppController;
  server: FakeServer;
  repo: SudokuRepository;
  store: MemoryStore;
  clock: { now: number };
  host: Host;
}

function makeHost(clock: { now: number }, pathname = "/", href = ORIGIN + "/"): Host {
  return {
    location: { hash: "", pathname, href, search: "", origin: ORIGIN } as Location,
    history: { replaceState: () => {} } as unknown as History,
    baseUri: () => ORIGIN + "/",
    isVisible: () => true,
    nowMs: () => clock.now,
    wallMs: () => clock.now,
    reloadPage: () => {},
  };
}

/** Signs in with dev auth (as an admin when `admin`) while the server is up, and starts a controller. */
async function env(admin = false, fetchOverride?: (server: FakeServer) => typeof fetch): Promise<Env> {
  const clock = { now: NOW };
  const server = new FakeServer(() => clock.now);
  server.admin = admin;
  const store = new MemoryStore();
  const fetcher = fetchOverride ? fetchOverride(server) : server.fetch;
  const repo = new SudokuRepository(new AppStorage(store), ORIGIN + "/auth/callback", "", () => clock.now, fetcher);
  await repo.signInDev(ORIGIN, admin ? "ann" : "alice", admin ? "Ann" : "Alice");
  const host = makeHost(clock);
  const c = new AppController(repo, new SeedRepository(new MemoryStore(), () => clock.now), host);
  c.start();
  await idle(c);
  assert.equal(c.phase.kind, "ready");
  assert.equal(c.maintenance, null);
  return { c, server, repo, store, clock, host };
}

async function idle(c: AppController): Promise<void> {
  await settled();
  while (c.syncing) await settled();
  await settled();
}

async function syncNow(c: AppController): Promise<void> {
  c.sync();
  await idle(c);
}

function solve(c: AppController, level = 1): void {
  c.openPuzzle(level);
  const p = c.puzzle(level)!;
  let g = Game.create(p.givens).resume(0);
  for (let i = 0; i < 81; i++) if (p.givens[i] === "0") g = g.place(i, Number(p.solution[i]), 60_000);
  c.update(level, () => g);
}

test("a player whose sync gets 503 maintenance keeps playing and is told the server is down", async () => {
  const { c, server } = await env();
  const puzzles = c.puzzles;
  assert.ok(puzzles);
  assert.equal(c.serverDown, null);
  assert.equal(c.backAround, null);
  server.maintenance = { until: UNTIL };
  await syncNow(c);
  assert.deepEqual(c.maintenance, { until: new Date(UNTIL) });
  assert.deepEqual(c.serverDown, { until: new Date(UNTIL) });
  assert.match(c.backAround!, /^Back around /);
  assert.equal(c.notice, null, "the banner says it, not a generic notice");
  assert.equal(c.puzzles, puzzles, "today's puzzles stay playable");
  assert.equal(c.needsSignIn, false);
  server.maintenance = { until: null };
  await syncNow(c);
  assert.deepEqual(c.maintenance, { until: null });
  assert.equal(c.backAround, null);
});

test("a score solved during maintenance stays queued, and uploads by itself once it is over", async () => {
  const { c, server, clock } = await env();
  server.maintenance = { until: null };
  await syncNow(c);
  assert.ok(c.maintenance);
  solve(c);
  await idle(c);
  c.openToday();
  assert.equal(c.statusOf(1).kind, "done");
  assert.equal((c.statusOf(1) as { synced: boolean }).synced, false);
  assert.equal(server.stored.length, 0);
  assert.equal(server.posts(), 0, "the sync never got as far as submitting");

  // Retried periodically while it lasts.
  const before = server.requests.length;
  clock.now += 31_000;
  c.tick();
  await idle(c);
  assert.ok(server.requests.length > before, "the tick retried");
  assert.ok(c.maintenance);
  assert.equal(server.stored.length, 0);

  // Over: the next tick clears the banner and the queue goes up.
  server.maintenance = null;
  c.tick();
  await idle(c);
  assert.equal(c.maintenance, null);
  assert.equal(server.stored.length, 1);
  assert.equal((c.statusOf(1) as { synced: boolean }).synced, true);
  assert.equal(c.notice, null);

  // No more retries once it is over.
  const settledRequests = server.requests.length;
  c.tick();
  await idle(c);
  assert.equal(server.requests.length, settledRequests);
});

test("a device with no puzzles for the week is told to try again later", async () => {
  const clock = { now: NOW };
  const server = new FakeServer(() => clock.now);
  server.maintenance = { until: UNTIL };
  const store = new MemoryStore();
  const storage = new AppStorage(store);
  storage.settings.write({ serverUrl: ORIGIN, devUser: { sub: "alice", name: "Alice" }, oidc: null });
  const repo = new SudokuRepository(storage, ORIGIN + "/auth/callback", "", () => clock.now, server.fetch);
  const c = new AppController(repo, new SeedRepository(new MemoryStore(), () => clock.now), makeHost(clock));
  c.start();
  await idle(c);
  assert.equal(c.puzzles, null);
  assert.deepEqual(c.serverDown, { until: new Date(UNTIL) });
  assert.equal(c.notice, null);
  // Nothing to play until the server is back; then everything arrives.
  server.maintenance = null;
  await syncNow(c);
  assert.equal(c.maintenance, null);
  assert.ok(c.puzzles);
});

test("maintenance found while the results upload leaves them queued and shows the banner", async () => {
  let blockResults = false;
  const { c, server } = await env(false, (s) => async (input, init) => {
    if (blockResults && String(input).endsWith("/api/v1/results")) {
      return new Response(JSON.stringify({ error: { code: "maintenance", message: "down", until: UNTIL } }), { status: 503, headers: { "Content-Type": "application/json" } });
    }
    return s.fetch(input, init);
  });
  solve(c);
  blockResults = true;
  await idle(c);
  assert.deepEqual(c.maintenance, { until: new Date(UNTIL) });
  assert.equal(c.notice, null);
  assert.equal(server.stored.length, 0);
  blockResults = false;
  await syncNow(c);
  assert.equal(c.maintenance, null);
  assert.equal(server.stored.length, 1);
});

test("another 503 on the queue is not maintenance", async () => {
  const { c, server } = await env();
  solve(c);
  server.resultsStatus = 503;
  await idle(c);
  assert.equal(c.maintenance, null);
  assert.match(c.notice!, /haven't uploaded/);
});

test("boards that need the server say it is down for maintenance, with the time", async () => {
  const { c, server } = await env();
  server.maintenance = { until: UNTIL };
  c.openScores();
  await idle(c);
  await settled();
  assert.match(c.leaderboardError!, /^The server is down for maintenance\. Back around .+\.$/);
  assert.ok(c.maintenance, "the app now knows");
  c.openStats();
  await settled();
  assert.match(c.statsError!, /^The server is down for maintenance\. Back around /);
  c.openEndlessScores(1);
  await settled();
  assert.match(c.leaderboardError!, /^The server is down for maintenance\. Back around /);

  server.maintenance = { until: null };
  c.openScores();
  await settled();
  assert.equal(c.leaderboardError, PLAYER_TRY_LATER);
  // Other errors keep their own words.
  server.maintenance = null;
  server.endlessBoardStatus = 500;
  c.openEndlessScores(1);
  await settled();
  assert.equal(c.leaderboardError, "board broke");
});

test("an admin is served as usual; the controller learns of maintenance from the config", async () => {
  const { c, server } = await env(true);
  assert.equal(c.me?.admin, true);
  server.maintenance = { until: UNTIL };
  await syncNow(c);
  assert.deepEqual(c.maintenance, { until: new Date(UNTIL) });
  assert.equal(c.serverDown, null, "no player banner or message for an admin");
  assert.equal(c.notice, null);
  assert.ok(c.puzzles);
  // The leaderboard works for them.
  c.openScores();
  await settled();
  assert.equal(c.leaderboardError, null);

  server.maintenance = null;
  await syncNow(c);
  assert.equal(c.maintenance, null);

  // An older server doesn't send the field: off.
  server.maintenance = { until: null };
  await syncNow(c);
  assert.ok(c.maintenance);
  server.reportsMaintenance = false;
  await syncNow(c);
  assert.equal(c.maintenance, null);
});

test("an admin whose config can't be fetched keeps the reminder as it was", async () => {
  let configDown = false;
  const { c, server } = await env(true, (s) => async (input, init) => {
    if (configDown && String(input).endsWith("/api/v1/config")) throw new TypeError("Failed to fetch");
    return s.fetch(input, init);
  });
  server.maintenance = { until: null };
  await syncNow(c);
  assert.ok(c.maintenance);
  configDown = true;
  server.maintenance = null;
  await syncNow(c);
  assert.deepEqual(c.maintenance, { until: null });
  assert.equal(c.notice, null, "not a sync failure");
});

test("the Admin page switching maintenance on and off updates the reminder at once", async () => {
  const { c, server } = await env(true);
  c.openAdmin();
  const model = c.admin!;
  await until(() => model.maintenance !== null && !model.maintenanceBusy);
  assert.equal(c.maintenance, null);
  await model.saveMaintenance(true, new Date(UNTIL));
  assert.deepEqual(server.maintenance, { until: "2026-10-27T05:00:00.000Z" });
  assert.deepEqual(c.maintenance, { until: new Date(UNTIL) });
  await model.saveMaintenance(false, null);
  assert.equal(c.maintenance, null);
  assert.equal(server.maintenance, null);
  // The controller tells subscribers.
  let changes = 0;
  c.addEventListener("change", () => changes++);
  c.maintenanceChanged({ enabled: true, until: null });
  assert.equal(changes, 1);
  assert.deepEqual(c.maintenance, { until: null });
  c.maintenanceChanged({ enabled: false, until: null });
  assert.equal(c.maintenance, null);
  model.dispose();
});

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(done(), "condition never became true");
}

test("signing out forgets maintenance", async () => {
  const { c, server } = await env();
  server.maintenance = { until: null };
  await syncNow(c);
  assert.ok(c.maintenance);
  await c.signOut();
  assert.equal(c.maintenance, null);
});

test("an OIDC sign-in during maintenance still signs in and shows the banner", async () => {
  const clock = { now: NOW };
  const server = new FakeServer(() => clock.now, "oidc");
  const store = new MemoryStore();
  const repo = new SudokuRepository(new AppStorage(store), ORIGIN + "/auth/callback", "", () => clock.now, server.fetch);
  const config = await repo.fetchConfig(ORIGIN);
  const redirect = server.authorize(await repo.beginOidcSignIn(ORIGIN, config.oidc!));
  server.maintenance = { until: UNTIL };
  const c = new AppController(repo, new SeedRepository(new MemoryStore(), () => clock.now), makeHost(clock, CALLBACK_PATH, redirect));
  c.start();
  await until(() => c.phase.kind === "ready");
  await idle(c);
  assert.deepEqual(c.maintenance, { until: new Date(UNTIL) });
  assert.equal(c.notice, null, "not 'couldn't sync yet'");
  assert.equal(c.needsSignIn, false);
});

test("an OIDC sign-in that fails to sync for another reason still says so", async () => {
  const clock = { now: NOW };
  const server = new FakeServer(() => clock.now, "oidc");
  const failing: typeof fetch = async (input, init) => (String(input).endsWith("/api/v1/me") ? new Response("{}", { status: 500 }) : server.fetch(input, init));
  const repo = new SudokuRepository(new AppStorage(new MemoryStore()), ORIGIN + "/auth/callback", "", () => clock.now, failing);
  const config = await repo.fetchConfig(ORIGIN);
  const redirect = server.authorize(await repo.beginOidcSignIn(ORIGIN, config.oidc!));
  const c = new AppController(repo, new SeedRepository(new MemoryStore(), () => clock.now), makeHost(clock, CALLBACK_PATH, redirect));
  c.start();
  await until(() => c.phase.kind === "ready");
  await idle(c);
  assert.equal(c.maintenance, null);
  assert.equal(c.notice, "Signed in, but couldn't sync yet.");
});

test("a sign-in that fails over an existing session keeps its own message", async () => {
  const clock = { now: NOW };
  const server = new FakeServer(() => clock.now, "oidc");
  const repo = new SudokuRepository(new AppStorage(new MemoryStore()), ORIGIN + "/auth/callback", "", () => clock.now, server.fetch);
  const config = await repo.fetchConfig(ORIGIN);
  await repo.completeOidcSignIn(server.authorize(await repo.beginOidcSignIn(ORIGIN, config.oidc!)));
  const c = new AppController(repo, new SeedRepository(new MemoryStore(), () => clock.now), makeHost(clock, CALLBACK_PATH, ORIGIN + "/auth/callback?code=x&state=y"));
  c.start();
  await until(() => c.phase.kind === "ready");
  assert.match(c.notice!, /Sign-in failed/);
  assert.equal(c.maintenance, null);
});
