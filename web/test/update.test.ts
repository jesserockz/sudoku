import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { MemoryStore } from "../src/data/store.ts";
import type { SudokuRepository } from "../src/data/repository.ts";
import { SeedRepository } from "../src/serverless/seed-repository.ts";
import { AppController, type Host } from "../src/ui/controller.ts";
import { watchForUpdates, type UpdateWorkers } from "../src/ui/update.ts";

class FakeWorkers implements UpdateWorkers {
  listeners: (() => void)[] = [];
  updates = 0;
  registration: { update(): Promise<unknown> } | undefined = { update: async () => void this.updates++ };
  controller: unknown;
  constructor(controller: unknown) {
    this.controller = controller;
  }
  addEventListener(_type: "controllerchange", listener: () => void): void {
    this.listeners.push(listener);
  }
  getRegistration(): Promise<{ update(): Promise<unknown> } | undefined> {
    return Promise.resolve(this.registration);
  }
  changed(): void {
    for (const l of this.listeners) l();
  }
}

test("the first install's controllerchange is not an update, later ones are, once", () => {
  const workers = new FakeWorkers(null);
  let n = 0;
  watchForUpdates(workers, () => n++);
  workers.changed();
  assert.equal(n, 0);
  workers.changed();
  assert.equal(n, 1);
  workers.changed();
  assert.equal(n, 1);
});

test("a page that already had a controller is notified on the first change, once", () => {
  const workers = new FakeWorkers({});
  let n = 0;
  watchForUpdates(workers, () => n++);
  workers.changed();
  workers.changed();
  assert.equal(n, 1);
});

test("the check asks the registration for a new worker", async () => {
  const workers = new FakeWorkers({});
  await watchForUpdates(workers, () => {})();
  assert.equal(workers.updates, 1);
});

test("the check does nothing without a registration", async () => {
  const workers = new FakeWorkers({});
  workers.registration = undefined;
  await watchForUpdates(workers, () => {})();
  assert.equal(workers.updates, 0);
});

test("the check swallows failures such as being offline", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const workers = new FakeWorkers({});
  workers.registration = { update: () => Promise.reject(new Error("offline")) };
  await watchForUpdates(workers, () => {})();
  assert.equal(warn.mock.callCount(), 1);
});

test("without service worker support nothing happens", async () => {
  await watchForUpdates(undefined, () => assert.fail("no update"))();
});

function controller(reloadPage: () => void): AppController {
  const host: Host = {
    location: { hash: "", pathname: "/", search: "", origin: "http://localhost" } as Location,
    history: { replaceState: () => {} } as unknown as History,
    baseUri: () => "http://localhost/",
    isVisible: () => true,
    nowMs: () => 0,
    wallMs: () => 0,
    reloadPage,
  };
  const repo = { isSignedIn: false, today: () => "2026-10-27" } as unknown as SudokuRepository;
  return new AppController(repo, new SeedRepository(new MemoryStore()), host);
}

test("updateReady flags the update and fires change once", () => {
  const c = controller(() => {});
  const onChange = mock.fn();
  c.addEventListener("change", onChange);
  assert.equal(c.updateAvailable, false);
  c.updateReady();
  c.updateReady();
  assert.equal(c.updateAvailable, true);
  assert.equal(onChange.mock.callCount(), 1);
});

test("applyUpdate reloads the page through the host", () => {
  const reloadPage = mock.fn();
  controller(reloadPage).applyUpdate();
  assert.equal(reloadPage.mock.callCount(), 1);
});
