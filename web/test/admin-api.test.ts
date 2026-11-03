import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiException, SudokuApi } from "../src/api/client.ts";
import { decodeMe, decodeRelease, decodeReleaseList, decodeUpdateStatus } from "../src/api/models.ts";
import { AppStorage } from "../src/data/app-storage.ts";
import { SudokuRepository } from "../src/data/repository.ts";
import { MemoryStore } from "../src/data/store.ts";
import { FakeServer } from "./fake-server.ts";

const release = {
  tag: "v1.3.0", version: "1.3.0", name: "v1.3.0", publishedAt: "2026-10-30T01:02:03Z", prerelease: false, latest: true,
  current: false, comparison: "newer", installable: true, notInstallableReason: "", url: "https://github.com/x/y/releases/tag/v1.3.0",
};
const status = {
  state: "downloading", action: "update", target: "v1.3.0", message: "Downloading", error: "", bytesDone: 5, bytesTotal: 10,
  startedAt: "2026-10-31T01:02:03Z", finishedAt: null, rollbackAvailable: true,
};

function api(server: FakeServer): SudokuApi {
  return new SudokuApi("https://sudoku.test", async () => "dev:alice:Alice", server.fetch);
}

test("me decodes admin, and a server that doesn't send it means false", () => {
  assert.equal(decodeMe({ id: "a", displayName: "A", admin: true }).admin, true);
  assert.equal(decodeMe({ id: "a", displayName: "A", admin: false }).admin, false);
  assert.equal(decodeMe({ id: "a", displayName: "A" }).admin, false);
  assert.throws(() => decodeMe({ id: "a", displayName: "A", admin: "yes" }), TypeError);
});

test("releases and update status decode, with optional fields defaulted", () => {
  assert.deepEqual(decodeRelease(release).comparison, "newer");
  const sparse = decodeRelease({ tag: "v1", version: "1", prerelease: true, latest: false, current: true, comparison: "unknown", installable: false });
  assert.deepEqual([sparse.name, sparse.publishedAt, sparse.notInstallableReason, sparse.url], ["", "", "", ""]);
  assert.throws(() => decodeRelease({ ...release, comparison: "sideways" }), /unknown comparison/);
  assert.deepEqual(decodeUpdateStatus(status).bytesTotal, 10);
  assert.deepEqual(decodeUpdateStatus({ state: "idle" }), {
    state: "idle", action: "", target: "", message: "", error: "", bytesDone: 0, bytesTotal: 0, startedAt: null, finishedAt: null, rollbackAvailable: false,
  });
  assert.throws(() => decodeUpdateStatus({ state: "exploding" }), /unknown update state/);
  const list = decodeReleaseList({ current: { version: "1.2.3", os: "linux", arch: "arm64", asset: "a" }, releases: [release], update: status });
  assert.equal(list.releases.length, 1);
  assert.equal(list.current.arch, "arm64");
  assert.equal(list.current.updatesWeb, false);
  assert.equal(decodeReleaseList({ current: { version: "1", os: "linux", arch: "arm64", asset: "a", updatesWeb: true }, releases: [], update: status }).current.updatesWeb, true);
});

test("the client calls the admin endpoints", async () => {
  const server = new FakeServer(() => 0);
  server.admin = true;
  server.adminReleases = { current: { version: "1.2.3", os: "linux", arch: "amd64", asset: "a" }, releases: [release], update: status };
  server.adminStatus = status;
  const c = api(server);

  assert.equal((await c.adminReleases()).releases[0]!.tag, "v1.3.0");
  assert.equal((await c.adminReleases(true)).releases.length, 1);
  assert.deepEqual(server.requests.map((r) => r.url.search), ["", "?prereleases=true"]);

  assert.equal((await c.adminUpdateStatus()).state, "downloading");

  assert.equal((await c.startUpdate("v1.3.0")).state, "downloading");
  assert.equal((await c.startUpdate("v1.0.0", true)).state, "downloading");
  const posts = server.requests.filter((r) => r.method === "POST" && r.url.pathname.endsWith("/update"));
  assert.deepEqual(posts.map((p) => JSON.parse(p.body)), [{ tag: "v1.3.0", allowDowngrade: false }, { tag: "v1.0.0", allowDowngrade: true }]);
  assert.equal(posts[0]!.headers.get("Content-Type"), "application/json");

  assert.equal((await c.rollback()).rollbackAvailable, true);
  const rollback = server.requests.at(-1)!;
  assert.equal(rollback.method, "POST");
  assert.equal(rollback.body, "");
  assert.equal(rollback.headers.get("Content-Type"), null);
  assert.equal(rollback.headers.get("Authorization"), "Bearer dev:alice:Alice");
});

test("a non-admin gets 403 as an ApiException with the server's message", async () => {
  const server = new FakeServer(() => 0);
  server.admin = false;
  const c = api(server);
  for (const call of [() => c.adminReleases(), () => c.adminUpdateStatus(), () => c.startUpdate("v1.0.0"), () => c.rollback()]) {
    await assert.rejects(call(), (e: unknown) => e instanceof ApiException && e.status === 403 && e.error?.message === "admin access required");
  }
});

test("the repository hands out the signed-in client", async () => {
  const server = new FakeServer(() => Date.parse("2026-10-27T01:00:00Z"));
  server.admin = true;
  const repo = new SudokuRepository(new AppStorage(new MemoryStore()), "https://sudoku.test/auth/callback", "", () => Date.parse("2026-10-27T01:00:00Z"), server.fetch);
  await repo.signInDev("sudoku.test", "alice", "Alice");
  assert.equal(repo.me()!.admin, true);
  assert.equal((await repo.api().adminUpdateStatus()).state, "idle");
});

test("the client calls the admin endless endpoints", async () => {
  const row = {
    userId: "u/1", displayName: "Una", difficulty: 2, number: 7, elapsedMs: 5000, completedAt: "c", submittedAt: "s",
    replay: "valid", replayError: "", flag: null,
  };
  const server = new FakeServer(() => 0);
  server.admin = true;
  server.adminEndlessList = { date: "2026-10-27", results: [row] };
  server.adminEndlessReplayDetail = { ...row, givens: "0".repeat(81), events: [] };
  server.adminEndlessFlagResult = row;
  const c = api(server);

  assert.equal((await c.adminEndlessResults("2026-10-27")).results[0]!.number, 7);
  assert.equal((await c.adminEndlessReplay(2, 7, "u/1")).events.length, 0);
  assert.equal((await c.flagEndlessResult(2, 7, "u/1", "odd")).difficulty, 2);
  assert.equal((await c.unflagEndlessResult(2, 7, "u/1")).userId, "u/1");
  const sent = server.requests.filter((r) => r.url.pathname.startsWith("/api/v1/admin/endless"));
  assert.deepEqual(sent.map((r) => [r.method, r.url.pathname + r.url.search]), [
    ["GET", "/api/v1/admin/endless/results?date=2026-10-27"],
    ["GET", "/api/v1/admin/endless/results/2/7/u%2F1/replay"],
    ["PUT", "/api/v1/admin/endless/results/2/7/u%2F1/flag"],
    ["DELETE", "/api/v1/admin/endless/results/2/7/u%2F1/flag"],
  ]);
  assert.deepEqual(JSON.parse(sent[2]!.body), { reason: "odd" });

  server.admin = false;
  await assert.rejects(c.adminEndlessResults("2026-10-27"), (e: unknown) => e instanceof ApiException && e.status === 403);
});
