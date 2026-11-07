import assert from "node:assert/strict";
import { test } from "node:test";
import { AppStorage } from "../src/data/app-storage.ts";
import { SudokuRepository } from "../src/data/repository.ts";
import { MemoryStore } from "../src/data/store.ts";
import { generateEndless } from "../src/generator/generator.ts";
import { parseWeekSeed } from "../src/generator/week-seed.ts";
import { seedSettings as s } from "../src/serverless/seed.ts";
import { SeedRepository } from "../src/serverless/seed-repository.ts";
import { AppController, type EndlessRef, type Host } from "../src/ui/controller.ts";

const NOW = Date.parse("2026-10-27T01:00:00Z");
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
async function ready(c: AppController): Promise<void> {
  for (let i = 0; i < 500 && c.phase.kind !== "ready"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(c.phase.kind, "ready");
}

const REF: EndlessRef = { generator: 1, difficulty: 2, number: 3 };

interface Env {
  c: AppController;
  repo: SudokuRepository;
  seeds: SeedRepository;
  clock: { mono: number };
}

/** A controller playing a seed, signed out of any server, as for a static host. */
async function seedEnv(): Promise<Env> {
  const clock = { mono: 10_000 };
  const host: Host = {
    location: { hash: "", pathname: "/", search: "", origin: "http://localhost" } as Location,
    history: { replaceState: () => {} } as unknown as History,
    baseUri: () => "http://localhost/",
    isVisible: () => true,
    nowMs: () => clock.mono,
    wallMs: () => NOW,
    reloadPage: () => {},
  };
  const store = new MemoryStore();
  const repo = new SudokuRepository(new AppStorage(store), "http://localhost/auth/callback", "", () => NOW);
  const seeds = new SeedRepository(store, () => NOW);
  await seeds.use(s("test-secret-0123456789"));
  const c = new AppController(repo, seeds, host);
  c.start();
  await ready(c);
  assert.ok(c.seed);
  return { c, repo, seeds, clock };
}

/** Plays `ref`, leaving the last `leave` cells empty. Returns a function that places one more digit. */
function play(e: Env, ref: EndlessRef, leave = 0): () => void {
  const { c, clock } = e;
  c.openEndless(ref);
  assert.equal(c.screen.kind, "endless-play");
  const p = c.puzzleOf(ref)!;
  const cells = [...p.givens].flatMap((g, i) => (g === "0" ? [i] : []));
  c.update(ref, (g) => g.resume(clock.mono), { a: "resume" });
  const place = (cell: number): void => {
    clock.mono += 100;
    const d = Number(p.solution[cell]);
    c.update(ref, (g) => g.place(cell, d, clock.mono), { a: "place", c: cell, d });
  };
  cells.slice(0, cells.length - leave).forEach(place);
  const rest = cells.slice(cells.length - leave);
  return () => place(rest.shift()!);
}

test("seed play offers the endless tab with puzzles from the seed's endless seed", async () => {
  const { c } = await seedEnv();
  assert.ok(c.hasEndless);
  const summaries = c.endlessSummaries()!;
  assert.equal(summaries.length, 5);
  assert.deepEqual(summaries[0], { difficulty: 1, solved: 0, highest: 0, next: 1, inProgress: [] });
  c.openEndless(REF);
  // The same puzzle a server with that secret would give.
  assert.equal(c.puzzleOf(REF)!.givens, generateEndless(parseWeekSeed("3242a2d84b0602b6"), 2, 3).givens);
});

test("playing and solving an endless puzzle in seed play lands in the history, not on a server", async () => {
  const e = await seedEnv();
  const { c, seeds, repo } = e;
  const finish = play(e, REF, 1);
  assert.equal(c.endlessStatusOf(REF).kind, "in-progress");
  assert.deepEqual(c.endlessSummaries()![1]!.inProgress.map((g) => g.number), [3]);
  assert.equal(repo.endlessInProgress().length, 0, "the server's storage is untouched");
  assert.equal(seeds.endlessInProgress().length, 1);

  // Leaving the puzzle and opening it again resumes it.
  c.openToday();
  c.openEndless(REF);
  assert.equal(c.gameOf(REF)!.isComplete, false);

  finish();
  assert.equal(c.gameOf(REF)!.isComplete, true);
  await settled();
  assert.equal(c.endlessStatusOf(REF).kind, "done");
  assert.deepEqual(c.endlessHistory().map((r) => [r.difficulty, r.number]), [[2, 3]]);
  assert.deepEqual(c.endlessSummaries()![1], { difficulty: 2, solved: 1, highest: 3, next: 1, inProgress: [] });

  // See scores goes to History, as does the tab's Leaderboard.
  c.openScoresFor(REF);
  assert.equal(c.screen.kind, "history");
  c.openToday();
  c.openEndlessScores(1);
  assert.equal(c.screen.kind, "history");
  c.openToday();

  // Opening a solved puzzle whose game is gone goes to History too.
  c.openEndless({ generator: 1, difficulty: 1, number: 1 });
  c.openEndless(REF);
  assert.equal(c.screen.kind, "history");
});

test("the endless explainer pops up in seed play too, and its text has no leaderboard", async () => {
  const { c, repo } = await seedEnv();
  assert.equal(c.help, null);
  c.showHomeTab("endless");
  assert.equal(c.help, "endless");
  assert.equal(repo.endlessHelpSeen(), true);
  c.closeHelp();
  c.openHelp("endless");
  assert.equal(c.help, "endless");
});

test("a device that starts seed play on the endless tab gets the explainer once the seed is ready", async () => {
  const e = await seedEnv();
  e.repo.setHomeTab("endless");
  const again = new AppController(e.repo, e.seeds, {
    location: { hash: "", pathname: "/", search: "", origin: "http://localhost" } as Location,
    history: { replaceState: () => {} } as unknown as History,
    baseUri: () => "http://localhost/",
    isVisible: () => true,
    nowMs: () => e.clock.mono,
    wallMs: () => NOW,
    reloadPage: () => {},
  });
  again.start();
  await ready(again);
  assert.equal(again.help, "endless");
});

test("leaving the seed forgets the open endless puzzle and returns to the server's", async () => {
  const e = await seedEnv();
  play(e, REF, 1);
  e.c.leaveSeed();
  await settled();
  assert.equal(e.c.seed, null);
  assert.equal(e.c.gameOf(REF), null);
  // Without a server there are no endless puzzles to show.
  assert.equal(e.c.endlessSummaries(), null);
  e.c.openEndless(REF);
  assert.notEqual(e.c.screen.kind, "endless-play");
});
