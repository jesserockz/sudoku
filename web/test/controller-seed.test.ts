import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { MemoryStore } from "../src/data/store.ts";
import type { SudokuRepository } from "../src/data/repository.ts";
import { seedSettings as s, type SeedSettings } from "../src/serverless/seed.ts";
import { SeedRepository } from "../src/serverless/seed-repository.ts";
import { buildShareLink } from "../src/serverless/share-link.ts";
import { AppController, type Host } from "../src/ui/controller.ts";

const NOW = Date.parse("2026-10-27T01:00:00Z");

/** The wall clock the test host reports; tests move it by assigning. */
let wall = NOW;

function host(hash = ""): Host {
  return {
    location: { hash, pathname: "/", search: "", origin: "http://localhost" } as Location,
    history: { replaceState: () => {} } as unknown as History,
    baseUri: () => "http://localhost/",
    isVisible: () => true,
    nowMs: () => NOW,
    wallMs: () => wall,
  };
}

const fakeRepo = (isSignedIn = false) => ({ isSignedIn, today: () => "2026-10-27" }) as unknown as SudokuRepository;
const shareHash = (seed: string): string => "#" + buildShareLink("http://localhost/", s(seed)).split("#")[1];
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

function assertFailed(c: AppController, message: string): void {
  assert.equal(c.phase.kind, "seed-setup");
  assert.equal(c.seed, null);
  assert.ok(c.notice?.includes(`Couldn't start that seed: ${message}`), String(c.notice));
}

test("useSeed returns to setup when the seed can't be used", async () => {
  class Failing extends SeedRepository {
    override async use(_settings: SeedSettings): Promise<never> {
      throw new Error("no good");
    }
  }
  const c = new AppController(fakeRepo(), new Failing(new MemoryStore(), () => NOW), host());
  c.useSeed(s("rimu"));
  assert.equal(c.phase.kind, "loading");
  await settled();
  assertFailed(c, "no good");
});

test("a share link whose fingerprint can't be worked out returns to setup", async (t) => {
  const store = new MemoryStore();
  const seeds = new SeedRepository(store, () => NOW);
  await seeds.use(s("current"));
  const c = new AppController(fakeRepo(), seeds, host(shareHash("incoming")));
  const importKey = t.mock.method(crypto.subtle, "importKey", async () => {
    throw new Error("boom");
  });
  c.start();
  assert.equal(c.phase.kind, "loading");
  await settled();
  assertFailed(c, "boom");
  assert.equal(importKey.mock.callCount(), 1);
  mock.restoreAll();
});

test("a pasted share link while signed in fails the same way", async (t) => {
  const pasted = new AppController(fakeRepo(true), new SeedRepository(new MemoryStore(), () => NOW), host(shareHash("incoming")));
  t.mock.method(crypto.subtle, "importKey", async () => {
    throw new Error("boom");
  });
  pasted.onHashChange();
  await settled();
  assertFailed(pasted, "boom");
  mock.restoreAll();
});

test("a stored seed whose puzzles can't load is forgotten and setup is shown", async () => {
  class Broken extends SeedRepository {
    override async puzzles(): Promise<never> {
      throw new Error("bad zone");
    }
  }
  const store = new MemoryStore();
  await new SeedRepository(store, () => NOW).use(s("rimu"));
  const seeds = new Broken(store, () => NOW);
  assert.notEqual(seeds.profile(), null);
  const c = new AppController(fakeRepo(), seeds, host());
  c.start();
  await settled();
  assertFailed(c, "bad zone");
  assert.equal(seeds.profile(), null);
});
