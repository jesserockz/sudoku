import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiException, SudokuApi } from "../src/api/client.ts";
import { decodeGeneratorInfo, decodePendingGenerator, decodeWeek, weekPuzzles } from "../src/api/models.ts";
import { AppStorage } from "../src/data/app-storage.ts";
import { SudokuRepository } from "../src/data/repository.ts";
import { MemoryStore } from "../src/data/store.ts";
import { generateDay } from "../src/generator/generator.ts";
import { generateDayV2, generateV2 } from "../src/generator/generator-v2.ts";
import { GENERATOR_CLASSIC, GENERATOR_GRADED, GENERATOR_VERSIONS, generateDayVersion, generatorName, isGeneratorVersion } from "../src/generator/versions.ts";
import { parseWeekSeed } from "../src/generator/week-seed.ts";
import { FIRST_WEEK, INITIAL_SCHEDULE, choose, decodeSchedule, pendingFor, versionFor } from "../src/serverless/generator-schedule.ts";
import { seedSettings as s, seedWeek } from "../src/serverless/seed.ts";
import { SeedRepository } from "../src/serverless/seed-repository.ts";
import { AppController, type Host } from "../src/ui/controller.ts";
import { generatorHelp, generatorSummary, historyLine, pendingLine, pendingNotice } from "../src/ui/generator.ts";
import { FakeServer } from "./fake-server.ts";

const NOW = Date.parse("2026-10-27T01:00:00Z"); // Tuesday 2026-10-27, in 2026-W44
const NEXT_WEEK = Date.parse("2026-11-03T01:00:00Z"); // 2026-W45
const REDIRECT = "https://sudoku.test/auth/callback";
const SEED = "e4d2e1e00e3549cc";
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(done: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(done(), "condition never became true");
}

const week = (extra: object = {}) => ({
  isoWeek: "2026-W44", seed: SEED, weekStart: "2026-10-26", weekEnd: "2026-11-01", today: "2026-10-27", dayOfWeek: 2, timezone: "Pacific/Auckland",
  levels: 2, ...extra,
});

// Versions

test("generator versions have names and dispatch to their generator", () => {
  assert.deepEqual(GENERATOR_VERSIONS.map(generatorName), ["Classic", "Graded"]);
  assert.equal(generatorName(7), "Generator 7");
  assert.deepEqual([0, 1, 2, 3].map(isGeneratorVersion), [false, true, true, false]);
  const seed = parseWeekSeed(SEED);
  const classic = generateDayVersion(GENERATOR_CLASSIC, seed, 2, 2);
  const graded = generateDayVersion(GENERATOR_GRADED, seed, 2, 2);
  assert.deepEqual(classic.map((p) => p.givens), generateDay(seed, 2, 2).map((p) => p.givens));
  assert.deepEqual(graded.map((p) => p.givens), generateDayV2(seed, 2, 2).map((p) => p.givens));
  assert.deepEqual(graded.map((p) => p.givens), [1, 2].map((l) => generateV2(seed, 2, l, 2).puzzle.givens));
  assert.notEqual(classic[0]!.givens, graded[0]!.givens);
  assert.throws(() => generateDayVersion(3, seed, 2, 2), /unknown generator version: 3/);
});

test("the day's games default to five levels in either generator", () => {
  const seed = parseWeekSeed(SEED);
  assert.equal(generateDayV2(seed, 1).length, 5);
  assert.equal(generateDayVersion(GENERATOR_CLASSIC, seed, 1).length, 5);
});

// Models and client

test("a week reports its generator and any pending change, and an older server means Classic", () => {
  const old = decodeWeek(week());
  assert.equal(old.generator, 1);
  assert.equal(old.pendingGenerator, null);
  const now = decodeWeek(week({ generator: 2, pendingGenerator: { version: 1, fromWeek: "2026-W45" } }));
  assert.equal(now.generator, 2);
  assert.deepEqual(now.pendingGenerator, { version: 1, fromWeek: "2026-W45" });
  assert.equal(decodeWeek(week({ generator: 1, pendingGenerator: null })).pendingGenerator, null);
  assert.throws(() => decodeWeek(week({ generator: 3 })), /unsupported generator version: 3/);
  assert.throws(() => decodeWeek(week({ pendingGenerator: { version: 9, fromWeek: "2026-W45" } })), /unsupported/);
  assert.throws(() => decodeWeek(week({ pendingGenerator: { version: 2 } })), TypeError);
  assert.throws(() => decodePendingGenerator(null), TypeError);
});

test("a week's puzzles come from the generator the week uses", () => {
  const classic = weekPuzzles(decodeWeek(week()));
  const graded = weekPuzzles(decodeWeek(week({ generator: 2 })));
  const seed = parseWeekSeed(SEED);
  assert.deepEqual(classic.map((p) => p.givens), generateDay(seed, 2, 2).map((p) => p.givens));
  assert.deepEqual(graded.map((p) => p.givens), generateDayV2(seed, 2, 2).map((p) => p.givens));
});

test("the admin generator info decodes, with the first entry having no week", () => {
  const info = decodeGeneratorInfo({
    active: 2, pending: { version: 1, fromWeek: "2026-W46" }, schedule: [{ fromWeek: null, version: 1 }, { fromWeek: "2026-W45", version: 2 }],
  });
  assert.deepEqual(info, {
    active: 2, pending: { version: 1, fromWeek: "2026-W46" }, schedule: [{ fromWeek: null, version: 1 }, { fromWeek: "2026-W45", version: 2 }],
  });
  assert.equal(decodeGeneratorInfo({ active: 1, pending: null, schedule: [] }).pending, null);
  assert.throws(() => decodeGeneratorInfo({ active: 5, pending: null, schedule: [] }), /unsupported/);
  assert.throws(() => decodeGeneratorInfo({ active: 1, pending: null, schedule: [{ fromWeek: null, version: 0 }] }), /unsupported/);
  assert.throws(() => decodeGeneratorInfo({ active: 1, pending: null }), TypeError);
});

function api(server: FakeServer): SudokuApi {
  server.admin = true;
  return new SudokuApi("https://sudoku.test", async () => "dev:alice:Alice", server.fetch);
}

test("the client reads, schedules and cancels the generator", async () => {
  const server = new FakeServer(() => NOW);
  const client = api(server);
  assert.deepEqual(await client.adminGenerator(), { active: 1, pending: null, schedule: [{ fromWeek: null, version: 1 }] });

  const scheduled = await client.setGenerator(2);
  assert.deepEqual(scheduled.pending, { version: 2, fromWeek: "2026-W45" });
  const put = server.requests.at(-1)!;
  assert.deepEqual([put.method, put.url.pathname, put.body], ["PUT", "/api/v1/admin/generator", '{"version":2}']);

  // Choosing the version already in use cancels, as does DELETE.
  assert.equal((await client.setGenerator(1)).pending, null);
  await client.setGenerator(2);
  const cancelled = await client.cancelGenerator();
  assert.equal(cancelled.pending, null);
  const del = server.requests.at(-1)!;
  assert.deepEqual([del.method, del.url.pathname], ["DELETE", "/api/v1/admin/generator/pending"]);
});

test("a non-admin is refused the generator endpoints", async () => {
  const server = new FakeServer(() => NOW);
  const client = api(server);
  server.admin = false;
  for (const call of [() => client.adminGenerator(), () => client.setGenerator(2), () => client.cancelGenerator()]) {
    await assert.rejects(call, (e) => e instanceof ApiException && e.status === 403);
  }
  server.admin = true;
  server.generatorStatus = 500;
  await assert.rejects(client.adminGenerator(), (e) => e instanceof ApiException && e.error?.message === "generator broke");
  await assert.rejects(client.cancelGenerator(), (e) => e instanceof ApiException && e.status === 500);
});

test("the client asks for the stats of one generator", async () => {
  const server = new FakeServer(() => NOW);
  const client = api(server);
  assert.equal((await client.myStats()).generator, 1);
  assert.equal(server.requests.at(-1)!.url.search, "");
  assert.equal((await client.myStats(2)).generator, 2);
  assert.equal(server.requests.at(-1)!.url.search, "?generator=2");
  server.reportsGenerator = false;
  assert.equal((await client.myStats()).generator, 1);
});

// The repository

function repoFor(server: FakeServer, store = new MemoryStore()): SudokuRepository {
  return new SudokuRepository(new AppStorage(store), REDIRECT, "", () => NOW, server.fetch);
}

test("the repository plays the generator its week reports, and a change of generator is not served from the cache", async () => {
  const server = new FakeServer(() => NOW);
  server.levels = 2;
  server.generator = 2;
  const r = repoFor(server);
  await r.signInDev("sudoku.test", "alice", "Alice");
  assert.equal(r.weekFor()!.generator, 2);
  const seed = parseWeekSeed(r.weekFor()!.seed);
  const graded = r.puzzles()!;
  assert.deepEqual(graded.map((p) => p.givens), generateDayV2(seed, 2, 2).map((p) => p.givens));
  assert.equal(r.puzzles(), graded, "the same week is served from the cache");

  // The same seed, levels and date with another generator (an admin switched and the week was refetched).
  server.generator = 1;
  await r.refresh();
  const classic = r.puzzles()!;
  assert.deepEqual(classic.map((p) => p.givens), generateDay(seed, 2, 2).map((p) => p.givens));
  assert.notEqual(classic[0]!.givens, graded[0]!.givens);
});

test("an older server's week plays Classic and a cached week without the fields still reads", async () => {
  const server = new FakeServer(() => NOW);
  server.levels = 2;
  server.reportsGenerator = false;
  const store = new MemoryStore();
  await repoFor(server, store).signInDev("sudoku.test", "alice", "Alice");
  // What an older version of the app stored: no generator fields.
  const { generator: _g, pendingGenerator: _p, ...stored } = JSON.parse(store.get("week")!);
  store.set("week", JSON.stringify(stored));
  const again = repoFor(new FakeServer(() => NOW), store);
  assert.equal(again.weekFor()!.generator, 1);
  assert.equal(again.weekFor()!.pendingGenerator, null);
  assert.deepEqual(again.puzzles()!.map((p) => p.givens), generateDay(parseWeekSeed(SEED), 2, 2).map((p) => p.givens));
});

// Serverless schedule

test("the serverless schedule starts Classic for every week", () => {
  assert.deepEqual(INITIAL_SCHEDULE, [{ fromWeek: FIRST_WEEK, version: 1 }]);
  assert.equal(versionFor(INITIAL_SCHEDULE, "2026-W44"), 1);
  assert.equal(versionFor([], "2026-W44"), 1);
  assert.equal(pendingFor(INITIAL_SCHEDULE, "2026-W44"), null);
});

test("choosing is always pending, replaces a pending change, and choosing the current version cancels", () => {
  const picked = choose(INITIAL_SCHEDULE, "2026-W44", "2026-W45", 2);
  assert.deepEqual(picked, [...INITIAL_SCHEDULE, { fromWeek: "2026-W45", version: 2 }]);
  assert.equal(versionFor(picked, "2026-W44"), 1);
  assert.equal(versionFor(picked, "2026-W45"), 2);
  assert.deepEqual(pendingFor(picked, "2026-W44"), { version: 2, fromWeek: "2026-W45" });
  assert.equal(pendingFor(picked, "2026-W45"), null);
  assert.deepEqual(choose(picked, "2026-W44", "2026-W45", 2), picked);
  assert.deepEqual(choose(picked, "2026-W44", "2026-W45", 1), INITIAL_SCHEDULE);
  // Next week it is in force, and going back is pending again.
  const back = choose(picked, "2026-W45", "2026-W46", 1);
  assert.deepEqual(back, [...picked, { fromWeek: "2026-W46", version: 1 }]);
  assert.deepEqual([versionFor(back, "2026-W44"), versionFor(back, "2026-W45"), versionFor(back, "2026-W46")], [1, 2, 1]);
  // The year turns over.
  assert.equal(versionFor(back, "2027-W01"), 1);
});

test("a stored schedule is checked and sorted", () => {
  assert.deepEqual(
    decodeSchedule([{ fromWeek: "2026-W45", version: 2 }, { fromWeek: FIRST_WEEK, version: 1 }, { fromWeek: "2026-W44", version: 2 }]),
    [{ fromWeek: FIRST_WEEK, version: 1 }, { fromWeek: "2026-W44", version: 2 }, { fromWeek: "2026-W45", version: 2 }],
  );
  assert.equal(decodeSchedule([{ fromWeek: "2026-W44", version: 2 }, { fromWeek: "2026-W44", version: 1 }]).length, 2);
  assert.throws(() => decodeSchedule([]), /empty/);
  assert.throws(() => decodeSchedule([{ fromWeek: FIRST_WEEK, version: 4 }]), /unsupported/);
  assert.throws(() => decodeSchedule([{ fromWeek: FIRST_WEEK }]), TypeError);
  assert.throws(() => decodeSchedule("nope"), TypeError);
});

// Serverless repository

function seedRepo(store: MemoryStore, clock: () => number): SeedRepository {
  return new SeedRepository(store, clock);
}

test("a seed's generator choice waits for next week, is cancellable and survives a restart", async () => {
  let now = NOW;
  const store = new MemoryStore();
  const r = seedRepo(store, () => now);
  await r.use(s("test-secret-0123456789", 2));
  const w0 = await r.week();
  assert.deepEqual([w0.generator, w0.pendingGenerator], [1, null]);
  const classicToday = (await r.puzzles()).map((p) => p.givens);

  r.setGenerator(2);
  const w1 = await r.week();
  assert.deepEqual([w1.generator, w1.pendingGenerator], [1, { version: 2, fromWeek: "2026-W45" }]);
  assert.deepEqual((await r.puzzles()).map((p) => p.givens), classicToday, "this week is unchanged");
  assert.deepEqual((await seedRepo(store, () => now).week()).pendingGenerator, { version: 2, fromWeek: "2026-W45" });

  r.setGenerator(1); // the version in use: cancels
  assert.equal((await r.week()).pendingGenerator, null);
  r.setGenerator(2);
  r.setGenerator(2); // replaces itself
  assert.equal(JSON.parse(store.get(`seed-generator-${r.profile()!.fingerprint.slice(1)}`)!).length, 2);

  // Next week the choice is in force, with the graded puzzles for that week.
  now = NEXT_WEEK;
  const w2 = await r.week();
  assert.deepEqual([w2.isoWeek, w2.generator, w2.pendingGenerator], ["2026-W45", 2, null]);
  assert.deepEqual((await r.puzzles()).map((p) => p.givens), generateDayV2(parseWeekSeed(w2.seed), 2, 2).map((p) => p.givens));

  // Going back is pending again, and the graded week keeps its puzzles until it ends.
  r.setGenerator(1);
  assert.deepEqual((await r.week()).pendingGenerator, { version: 1, fromWeek: "2026-W46" });
  assert.equal((await r.week()).generator, 2);
});

test("each seed has its own generator choice, and an invalid one is refused", async () => {
  const store = new MemoryStore();
  const r = seedRepo(store, () => NOW);
  await r.use(s("one", 2));
  r.setGenerator(2);
  assert.throws(() => r.setGenerator(3), /unknown generator version: 3/);
  assert.throws(() => r.setGenerator(0), RangeError);
  await r.use(s("two", 2));
  assert.equal((await r.week()).pendingGenerator, null);
  await r.use(s("one", 2));
  assert.equal((await r.week()).pendingGenerator?.version, 2);
});

test("an unreadable stored choice falls back to Classic", async () => {
  const store = new MemoryStore();
  const r = seedRepo(store, () => NOW);
  await r.use(s("rimu", 2));
  store.set(`seed-generator-${r.profile()!.fingerprint.slice(1)}`, "{not json");
  assert.equal((await r.week()).generator, 1);
  store.set(`seed-generator-${r.profile()!.fingerprint.slice(1)}`, JSON.stringify([{ fromWeek: FIRST_WEEK, version: 9 }]));
  assert.equal((await r.week()).generator, 1);
});

test("seed weeks carry a generator, Classic unless told otherwise", async () => {
  const w = await seedWeek(s("test-secret-0123456789"), NOW);
  assert.deepEqual([w.generator, w.pendingGenerator], [1, null]);
});

// Wording

test("the generator wording", () => {
  assert.equal(pendingNotice({ version: 2, fromWeek: "2026-W46" }), "From next week (2026-W46), daily puzzles use the Graded generator.");
  assert.equal(pendingLine({ version: 1, fromWeek: "2026-W46" }), "Classic from 2026-W46");
  assert.equal(historyLine({ fromWeek: null, version: 1 }), "Classic from the beginning");
  assert.equal(historyLine({ fromWeek: "2026-W45", version: 2 }), "Graded from 2026-W45");
  assert.equal(generatorSummary(2), "Graded (this week)");
});

// The controller

function makeHost(): Host {
  return {
    location: { hash: "", pathname: "/", search: "", origin: "https://sudoku.test" } as Location,
    history: { replaceState: () => {} } as unknown as History,
    baseUri: () => "https://sudoku.test/",
    isVisible: () => true,
    nowMs: () => 10_000,
    wallMs: () => NOW,
    reloadPage: () => {},
  };
}

async function idle(c: AppController): Promise<void> {
  await settled();
  while (c.syncing) await settled();
  await settled();
}

async function env(server = new FakeServer(() => NOW)) {
  server.levels = 2;
  const repo = new SudokuRepository(new AppStorage(new MemoryStore()), REDIRECT, "", () => NOW, server.fetch);
  await repo.signInDev("https://sudoku.test", "alice", "Alice");
  const seeds = new SeedRepository(new MemoryStore(), () => NOW);
  const c = new AppController(repo, seeds, makeHost());
  c.start();
  await idle(c);
  assert.equal(c.phase.kind, "ready");
  return { c, server, repo, seeds };
}

test("the controller shows the generator and a pending change from the week", async () => {
  const server = new FakeServer(() => NOW);
  server.generator = 2;
  server.pendingGenerator = { version: 1, fromWeek: "2026-W45" };
  const { c } = await env(server);
  assert.equal(c.generator, 2);
  assert.deepEqual(c.pendingGenerator, { version: 1, fromWeek: "2026-W45" });
  assert.deepEqual(c.puzzles!.map((p) => p.givens), generateDayV2(parseWeekSeed(c.week!.seed), 2, 2).map((p) => p.givens));
});

test("with an older server, or no week yet, the controller reports Classic and nothing pending", async () => {
  const server = new FakeServer(() => NOW);
  server.reportsGenerator = false;
  const { c } = await env(server);
  assert.equal(c.generator, 1);
  assert.equal(c.pendingGenerator, null);
  await c.signOut();
  assert.equal(c.week, null);
  assert.equal(c.generator, 1);
  assert.equal(c.pendingGenerator, null);
});

test("the Stats screen starts on the generator in use and can show the other one", async () => {
  const server = new FakeServer(() => NOW);
  server.generator = 2;
  const { c } = await env(server);
  c.showStatsGenerator(1); // not on the Stats screen: ignored
  assert.equal(c.statsGenerator, null);

  c.openStats();
  await until(() => c.stats !== null);
  assert.equal(c.stats!.generator, 2);
  assert.equal(c.statsGenerator, null);
  assert.equal(server.requests.at(-1)!.url.search, "");

  c.showStatsGenerator(1);
  assert.equal(c.stats, null, "the numbers are cleared while loading");
  await until(() => c.stats !== null);
  assert.equal(c.stats!.generator, 1);
  assert.equal(c.statsGenerator, 1);
  assert.equal(server.requests.at(-1)!.url.search, "?generator=1");

  // A sync keeps the generator picked.
  c.sync();
  await idle(c);
  assert.equal(c.stats!.generator, 1);

  // Opening the screen again goes back to the one in use.
  c.openToday();
  c.openStats();
  await until(() => c.stats !== null && c.statsGenerator === null);
  assert.equal(c.stats!.generator, 2);
});

test("a failed stats request for the other generator says so, and offline play never fetches it", async () => {
  const { c, server } = await env();
  c.openStats();
  await until(() => c.stats !== null);
  server.statsStatus = 500;
  c.showStatsGenerator(2);
  await until(() => c.statsError !== null);
  assert.equal(c.statsError, "stats broke");
  assert.equal(c.statsGenerator, 2);
});

test("serverless play shows the seed's generator and a pending change, and changes it for next week", async () => {
  const { c, seeds } = await env();
  await c.setSeedGenerator(2); // not playing a seed: nothing happens
  assert.equal(c.pendingGenerator, null);

  c.useSeed(s("test-secret-0123456789", 2));
  await until(() => c.phase.kind === "ready" && c.seed !== null && c.week !== null);
  assert.equal(c.generator, 1);
  assert.equal(c.pendingGenerator, null);
  const today = c.puzzles!.map((p) => p.givens);

  await c.setSeedGenerator(2);
  assert.equal(c.generator, 1);
  assert.deepEqual(c.pendingGenerator, { version: 2, fromWeek: "2026-W45" });
  assert.deepEqual(c.puzzles!.map((p) => p.givens), today);
  assert.equal(seeds.profile()!.settings.seed, "test-secret-0123456789");

  await c.setSeedGenerator(c.generator); // cancel
  assert.equal(c.pendingGenerator, null);

  // Leaving the seed goes back to the server's week; the choice itself stays with the seed.
  await c.setSeedGenerator(2);
  c.leaveSeed();
  assert.equal(seeds.profile(), null);
  assert.equal(c.pendingGenerator, null);
  assert.equal(c.generator, 1);
});

test("an invalid serverless choice is refused before anything is stored", async () => {
  const { c } = await env();
  c.useSeed(s("rimu", 2));
  await until(() => c.phase.kind === "ready" && c.seed !== null && c.week !== null);
  await assert.rejects(c.setSeedGenerator(5), /unknown generator version: 5/);
  assert.equal(c.pendingGenerator, null);
});

test("the Classic and Graded explainer explains a change with a server and offers the choice only in seed play", () => {
  const pending = { version: GENERATOR_GRADED, fromWeek: "2026-W45" };
  const server = generatorHelp({ current: GENERATOR_CLASSIC, pending, seed: false });
  assert.equal(server.title, "Classic and Graded puzzles");
  assert.deepEqual(server.levels.map((l) => l.name), ["Easy", "Medium", "Hard", "Expert", "Diabolical"]);
  assert.equal(server.intro[0], "From next week (2026-W45), puzzles switch from Classic to Graded. Here's the difference.");
  assert.equal(server.intro.length, 3);
  assert.match(server.outro[1], /^Endless uses the same generator as the daily puzzles\./);
  for (const text of [...server.intro, ...server.outro]) assert.doesNotMatch(text, /choose|choice/i, "players with a server have no say");

  const settled = generatorHelp({ current: GENERATOR_GRADED, pending: null, seed: false });
  assert.equal(settled.intro[0], "This week's puzzles use Graded.");

  const seed = generatorHelp({ current: GENERATOR_CLASSIC, pending: null, seed: true });
  assert.equal(seed.intro[0], "This seed's puzzles use Classic.");
  assert.match(seed.outro[1], /^You choose the generator for this seed in the seed card/);

  const unloaded = generatorHelp({ current: null, pending, seed: false });
  assert.equal(unloaded.intro.length, 2, "no lead line before a week is loaded");
  assert.match(unloaded.intro[0], /^Classic decides/);

  for (const help of [server, settled, seed, unloaded]) {
    for (const text of [help.title, ...help.intro, ...help.outro, ...help.levels.map((l) => l.text)]) {
      assert.ok(!text.includes("\u2014"), "no em dashes");
    }
  }
});
