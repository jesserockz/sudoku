import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { ApiException } from "../src/api/client.ts";
import type { Release, ReleaseList, UpdateStatus } from "../src/api/models.ts";
import {
  AdminModel, POLL_MS, RESTART_TIMEOUT_MS, actionLabel, describeError, flavourOf, formatBytes, progressFraction,
  type AdminApi, type AdminHost,
} from "../src/ui/admin.ts";

const rel = (tag: string, comparison: Release["comparison"], extra: Partial<Release> = {}): Release => ({
  tag, version: tag.replace(/^v/, ""), name: tag, publishedAt: "2026-10-30T01:02:03Z", prerelease: false, latest: false,
  current: comparison === "same", comparison, installable: true, notInstallableReason: "", url: "", ...extra,
});
const st = (state: UpdateStatus["state"], extra: Partial<UpdateStatus> = {}): UpdateStatus => ({
  state, action: state === "idle" ? "" : "update", target: "v1.3.0", message: "", error: "", bytesDone: 0, bytesTotal: 0,
  startedAt: null, finishedAt: null, rollbackAvailable: false, ...extra,
});
const apiError = (status: number, message = "") => new ApiException(status, message ? { code: "x", message } : null);

class FakeApi implements AdminApi {
  releases: Release[] = [rel("v1.3.0", "newer"), rel("v1.2.3", "same"), rel("v1.0.0", "older"), rel("v0.x", "unknown"), rel("v1.4.0-rc.1", "newer", { prerelease: true }), rel("v9", "newer", { installable: false })];
  update: UpdateStatus = st("idle");
  version = "1.2.3";
  calls: string[] = [];
  /** Statuses returned by successive polls (an Error is thrown); the last repeats. */
  polls: (UpdateStatus | Error)[] = [];
  startResult: UpdateStatus | Error = st("downloading");
  rollbackResult: UpdateStatus | Error = st("installing", { action: "rollback", target: "" });
  listError: Error | null = null;

  async adminReleases(pre: boolean): Promise<ReleaseList> {
    this.calls.push(`releases:${pre}`);
    if (this.listError) throw this.listError;
    return {
      current: { version: this.version, os: "linux", arch: "amd64", asset: "sudoku-server-linux-amd64" },
      releases: this.releases.filter((r) => pre || !r.prerelease),
      update: this.update,
    };
  }

  async adminUpdateStatus(): Promise<UpdateStatus> {
    this.calls.push("status");
    const next = this.polls.length > 1 ? this.polls.shift()! : this.polls[0]!;
    if (next instanceof Error) throw next;
    return next;
  }

  async startUpdate(tag: string, allowDowngrade: boolean): Promise<UpdateStatus> {
    this.calls.push(`update:${tag}:${allowDowngrade}`);
    if (this.startResult instanceof Error) throw this.startResult;
    return this.startResult;
  }

  async rollback(): Promise<UpdateStatus> {
    this.calls.push("rollback");
    if (this.rollbackResult instanceof Error) throw this.rollbackResult;
    return this.rollbackResult;
  }
}

let api: FakeApi;
let clock: number;
/** Versions the "server" reports per config poll (an Error rejects); the last repeats. */
let versions: (string | null | Error)[];
let host: AdminHost;
let sleeps: number[];

beforeEach(() => {
  api = new FakeApi();
  clock = 0;
  versions = ["1.2.3"];
  sleeps = [];
  host = {
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    serverVersion: async () => {
      const next = versions.length > 1 ? versions.shift()! : versions[0]!;
      if (next instanceof Error) throw next;
      return next;
    },
  };
});

const model = () => new AdminModel(api, host);
const net = () => new TypeError("Failed to fetch");

test("formatting helpers", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(progressFraction(st("downloading", { bytesDone: 5, bytesTotal: 10 })), 0.5);
  assert.equal(progressFraction(st("downloading", { bytesDone: 50, bytesTotal: 10 })), 1);
  assert.equal(progressFraction(st("downloading", { bytesDone: 5 })), null);
  assert.deepEqual(["newer", "same", "older", "unknown"].map((c) => flavourOf(rel("v1", c as Release["comparison"]))), ["update", "reinstall", "downgrade", "unknown"]);
  assert.deepEqual(
    (["newer", "same", "older", "unknown"] as const).map((c) => actionLabel(rel("v1.0.0", c))),
    ["Update to v1.0.0", "Reinstall v1.0.0", "Downgrade to v1.0.0", "Install v1.0.0"],
  );
});

test("errors read well", () => {
  assert.equal(describeError(apiError(403, "admin access required")), "Your account isn't an admin");
  assert.equal(describeError(apiError(401)), "Your session has expired. Sign in again.");
  assert.equal(describeError(apiError(409, "binary dir /opt not writable")), "binary dir /opt not writable");
  assert.equal(describeError(apiError(500)), "The server answered with an error (HTTP 500).");
  assert.match(describeError(net()), /Couldn't reach the server/);
});

test("loading lists releases, and prereleases are opt-in", async () => {
  const m = model();
  let changes = 0;
  m.addEventListener("change", () => changes++);
  await m.load();
  assert.equal(m.list!.releases.length, 5);
  assert.equal(m.list!.current.version, "1.2.3");
  assert.equal(m.loading, false);
  assert.equal(m.loadError, null);
  assert.deepEqual(m.progress, { kind: "none" });
  assert.ok(changes >= 2);

  await m.setIncludePrereleases(true);
  assert.equal(m.list!.releases.length, 6);
  await m.setIncludePrereleases(true); // no change: no request
  assert.deepEqual(api.calls, ["releases:false", "releases:true"]);
  assert.equal(m.canRollback, false);
});

test("changing prereleases drops a pending confirmation", async () => {
  const m = model();
  await m.load();
  m.choose("v1.3.0");
  await m.setIncludePrereleases(true);
  assert.equal(m.confirm, null);
});

test("a failed load shows why, and a non-admin is told so", async () => {
  api.listError = apiError(403, "admin access required");
  const m = model();
  await m.load();
  assert.equal(m.list, null);
  assert.equal(m.loadError, "Your account isn't an admin");
  assert.equal(m.loading, false);
  assert.equal(m.canRollback, false);
  assert.equal(m.working, false);
  // A retry that works clears the error.
  api.listError = null;
  await m.setIncludePrereleases(true);
  assert.equal(m.loadError, null);
});

test("choosing needs an installable release; only reinstall and downgrade are flagged", async () => {
  const m = model();
  await m.load();
  m.choose("nope");
  assert.equal(m.confirm, null);
  m.choose("v9"); // not installable
  assert.equal(m.confirm, null);

  m.choose("v1.3.0");
  const flavourNow = () => { const c = m.confirm; return c?.kind === "update" ? c.flavour : null; };
  assert.equal(flavourNow(), "update");
  m.cancel();
  assert.equal(m.confirm, null);

  for (const [tag, flavour] of [["v1.2.3", "reinstall"], ["v1.0.0", "downgrade"], ["v0.x", "unknown"]] as const) {
    m.choose(tag);
    assert.equal(flavourNow(), flavour);
  }
  // Nothing to confirm: no-op.
  m.cancel();
  await m.confirmAction();
  assert.deepEqual(api.calls, ["releases:false"]);
});

test("update flow: sends the tag without allowDowngrade, polls each second, then waits for the new version", async () => {
  api.startResult = st("downloading", { bytesDone: 0, bytesTotal: 100 });
  api.polls = [
    st("downloading", { bytesDone: 50, bytesTotal: 100 }),
    st("verifying"),
    st("installing"),
    st("restarting"),
  ];
  versions = [net(), net(), "1.2.3", "1.3.0"];
  const m = model();
  await m.load();
  const seen: string[] = [];
  m.addEventListener("change", () => seen.push(m.progress.kind));
  m.choose("v1.3.0");
  await m.confirmAction();

  assert.equal(api.calls.filter((c) => c.startsWith("update:"))[0], "update:v1.3.0:false");
  assert.deepEqual(m.progress, { kind: "done", message: "Updated to 1.3.0" });
  assert.equal(m.confirm, null);
  assert.equal(m.busy, false);
  assert.ok(seen.includes("running") && seen.includes("restarting"));
  assert.equal(sleeps.filter((ms) => ms === POLL_MS).length, sleeps.length);
  // The release list is refreshed after success.
  assert.equal(api.calls.at(-1), "releases:false");
  assert.equal(m.working, false);
});

test("downgrade and reinstall send allowDowngrade", async () => {
  api.polls = [st("failed", { error: "boom" })];
  const m = model();
  await m.load();
  m.choose("v1.0.0");
  await m.confirmAction();
  m.choose("v1.2.3");
  await m.confirmAction();
  m.choose("v0.x");
  await m.confirmAction();
  assert.deepEqual(api.calls.filter((c) => c.startsWith("update:")), ["update:v1.0.0:true", "update:v1.2.3:true", "update:v0.x:true"]);
});

test("a failure reported by the server is shown", async () => {
  api.polls = [st("failed", { error: "checksum mismatch" })];
  const m = model();
  await m.load();
  m.choose("v1.3.0");
  await m.confirmAction();
  assert.deepEqual(m.progress, { kind: "failed", message: "checksum mismatch" });
  assert.equal(m.working, false);
});

test("a failed status without an error text falls back to the message, then a default", async () => {
  api.startResult = st("failed", { message: "Download failed" });
  const m = model();
  await m.load();
  m.choose("v1.3.0");
  await m.confirmAction();
  assert.deepEqual(m.progress, { kind: "failed", message: "Download failed" });
  api.startResult = st("failed");
  m.choose("v1.3.0");
  await m.confirmAction();
  assert.deepEqual(m.progress, { kind: "failed", message: "The update failed." });
});

test("start errors are mapped, and nothing is polled", async () => {
  const m = model();
  await m.load();
  api.startResult = apiError(409, "Directory /opt must be writable by the service user");
  m.choose("v1.3.0");
  await m.confirmAction();
  assert.equal(m.error, "Directory /opt must be writable by the service user");
  assert.equal(m.confirm, null);
  assert.equal(m.busy, false);
  assert.deepEqual(m.progress, { kind: "none" });

  api.startResult = apiError(403);
  m.choose("v1.3.0");
  assert.equal(m.error, null); // choosing again clears it
  await m.confirmAction();
  assert.equal(m.error, "Your account isn't an admin");
  assert.equal(api.calls.includes("status"), false);
});

test("while working, nothing else can be started or chosen", async () => {
  const m = model();
  await m.load();
  api.polls = [st("failed", { error: "x" })];
  m.choose("v1.3.0");
  const first = m.confirmAction();
  assert.equal(m.busy, true);
  assert.equal(m.working, true);
  const second = m.confirmAction(); // ignored: busy
  m.choose("v1.0.0"); // ignored
  assert.equal(m.confirm?.kind === "update" && m.confirm.release.tag, "v1.3.0");
  await second;
  await first;
  assert.equal(api.calls.filter((c) => c.startsWith("update:")).length, 1);
});

test("a status poll that fails with a client error ends the job; a network or 5xx error means restarting", async () => {
  let m = model();
  await m.load();
  api.polls = [apiError(403)];
  m.choose("v1.3.0");
  await m.confirmAction();
  assert.deepEqual(m.progress, { kind: "failed", message: "Your account isn't an admin" });

  for (const err of [net(), apiError(502)]) {
    api.polls = [err];
    versions = ["1.3.0"];
    m = model();
    await m.load();
    m.choose("v1.3.0");
    await m.confirmAction();
    assert.deepEqual(m.progress, { kind: "done", message: "Updated to 1.3.0" });
  }
});

test("a restart that never arrives times out after two minutes", async () => {
  api.polls = [st("restarting")];
  versions = [net()];
  const m = model();
  await m.load();
  m.choose("v1.3.0");
  await m.confirmAction();
  assert.equal(m.progress.kind, "failed");
  assert.match((m.progress as { message: string }).message, /version 1\.3\.0 within 2 minutes/);
  assert.ok(clock >= RESTART_TIMEOUT_MS);
  assert.equal(m.working, false);
});

test("the old version still answering keeps waiting, and a server without a version never matches", async () => {
  api.polls = [st("restarting")];
  versions = ["1.2.3", null, "1.3.0"];
  const m = model();
  await m.load();
  m.choose("v1.3.0");
  await m.confirmAction();
  assert.deepEqual(m.progress, { kind: "done", message: "Updated to 1.3.0" });
});

test("reinstalling the same version needs the restart to be seen", async () => {
  // The server still says 1.2.3 and its status is still restarting: not done. Then a fresh process reports idle.
  api.startResult = st("installing", { target: "v1.2.3" });
  api.polls = [st("restarting", { target: "v1.2.3" }), st("restarting", { target: "v1.2.3" }), st("idle")];
  versions = ["1.2.3"];
  const m = model();
  await m.load();
  m.choose("v1.2.3");
  await m.confirmAction();
  assert.deepEqual(m.progress, { kind: "done", message: "Updated to 1.2.3" });
  assert.equal(api.calls.filter((c) => c === "status").length, 3);
});

test("reinstalling is done once the config request has failed, or the status request does", async () => {
  api.startResult = st("restarting", { target: "v1.2.3" });
  versions = [net(), "1.2.3"];
  let m = model();
  await m.load();
  m.choose("v1.2.3");
  await m.confirmAction();
  assert.equal(m.progress.kind, "done");

  api.polls = [net()];
  versions = ["1.2.3"];
  m = model();
  await m.load();
  m.choose("v1.2.3");
  await m.confirmAction();
  assert.equal(m.progress.kind, "done");
});

test("a status that is already idle means the new process is up", async () => {
  api.startResult = st("installing");
  api.polls = [st("idle", { target: "", action: "" })];
  versions = ["1.3.0"];
  const m = model();
  await m.load();
  m.choose("v1.3.0");
  await m.confirmAction();
  assert.deepEqual(m.progress, { kind: "done", message: "Updated to 1.3.0" });
});

test("rollback needs a previous binary and a confirmation, then waits for any other version", async () => {
  api.update = st("idle", { rollbackAvailable: true });
  api.polls = [st("restarting", { action: "rollback", target: "" })];
  versions = [net(), "1.2.3", "1.1.0"];
  const m = model();
  await m.load();
  assert.equal(m.canRollback, true);
  m.chooseRollback();
  assert.deepEqual(m.confirm, { kind: "rollback" });
  m.cancel();
  m.chooseRollback();
  await m.confirmAction();
  assert.ok(api.calls.includes("rollback"));
  assert.deepEqual(m.progress, { kind: "done", message: "Rolled back to 1.1.0" });
});

test("rollback with a known target waits for it; unavailable rollback is ignored; its errors are mapped", async () => {
  let m = model();
  await m.load();
  m.chooseRollback();
  assert.equal(m.confirm, null);

  api.update = st("idle", { rollbackAvailable: true });
  api.rollbackResult = st("restarting", { action: "rollback", target: "v1.1.0" });
  versions = ["1.1.0"];
  m = model();
  await m.load();
  m.chooseRollback();
  await m.confirmAction();
  assert.deepEqual(m.progress, { kind: "done", message: "Rolled back to 1.1.0" });

  api.rollbackResult = apiError(409, "no previous binary");
  m = model();
  await m.load();
  m.chooseRollback();
  await m.confirmAction();
  assert.equal(m.error, "no previous binary");
});

test("opening the page during an update picks it up", async () => {
  api.update = st("downloading", { bytesDone: 1, bytesTotal: 2 });
  api.polls = [st("restarting")];
  versions = ["1.3.0"];
  const m = model();
  await m.load();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(m.progress, { kind: "done", message: "Updated to 1.3.0" });
});

test("opening the page while restarting waits for the version; a stale failure is shown; load does not override progress", async () => {
  api.update = st("restarting");
  versions = ["1.3.0"];
  let m = model();
  await m.load();
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  assert.equal(m.progress.kind, "done");

  api.update = st("failed", { error: "checksum mismatch" });
  m = model();
  await m.load();
  assert.deepEqual(m.progress, { kind: "failed", message: "checksum mismatch" });
  await m.load(); // already showing progress: untouched
  assert.deepEqual(m.progress, { kind: "failed", message: "checksum mismatch" });

  api.update = st("failed", { message: "Download failed" });
  m = model();
  await m.load();
  assert.deepEqual(m.progress, { kind: "failed", message: "Download failed" });
  api.update = st("failed");
  m = model();
  await m.load();
  assert.deepEqual(m.progress, { kind: "failed", message: "The last update failed." });
});

test("disposing stops polling", async () => {
  api.polls = [st("downloading")];
  const m = model();
  await m.load();
  m.choose("v1.3.0");
  host.sleep = async () => { m.dispose(); };
  await m.confirmAction();
  assert.equal(m.progress.kind, "running");
  assert.equal(api.calls.filter((c) => c === "status").length, 0);

  // Disposed while waiting for the status answer, and while waiting for the version.
  const m2 = model();
  await m2.load();
  m2.choose("v1.3.0");
  host.sleep = async () => {};
  const original = api.adminUpdateStatus.bind(api);
  api.adminUpdateStatus = async () => { m2.dispose(); return original(); };
  await m2.confirmAction();
  assert.equal(m2.progress.kind, "running");

  api.adminUpdateStatus = original;
  api.polls = [st("restarting")];
  const m3 = model();
  await m3.load();
  m3.choose("v1.3.0");
  let first = true;
  host.sleep = async () => { if (!first) m3.dispose(); first = false; };
  await m3.confirmAction();
  assert.equal(m3.progress.kind, "restarting");

  const m4 = model();
  await m4.load();
  m4.choose("v1.3.0");
  versions = [net()];
  host.sleep = async () => {};
  host.serverVersion = async () => { m4.dispose(); throw net(); };
  await m4.confirmAction();
  assert.equal(m4.progress.kind, "restarting");

  const m5 = model();
  await m5.load();
  m5.choose("v1.3.0");
  host.serverVersion = async () => { m5.dispose(); return "1.3.0"; };
  await m5.confirmAction();
  assert.equal(m5.progress.kind, "restarting");

  // Same version: disposed during the extra status check.
  api.startResult = st("restarting", { target: "v1.2.3" });
  const m6 = model();
  await m6.load();
  m6.choose("v1.2.3");
  host.serverVersion = async () => "1.2.3";
  api.adminUpdateStatus = async () => { m6.dispose(); return st("idle"); };
  await m6.confirmAction();
  assert.equal(m6.progress.kind, "restarting");
});

test("a rollback that never changes the version times out; a status with no action counts as an update", async () => {
  api.update = st("idle", { rollbackAvailable: true });
  api.rollbackResult = st("restarting", { action: "rollback", target: "" });
  versions = ["1.2.3"];
  let m = model();
  await m.load();
  m.chooseRollback();
  await m.confirmAction();
  assert.match((m.progress as { message: string }).message, /report a new version within 2 minutes/);

  api.startResult = st("restarting", { action: "" });
  versions = ["1.3.0"];
  m = model();
  await m.load();
  m.choose("v1.3.0");
  await m.confirmAction();
  assert.deepEqual(m.progress, { kind: "done", message: "Updated to 1.3.0" });
});
