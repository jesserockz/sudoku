import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiException } from "../src/api/client.ts";
import type { AdminEndlessResult, AdminEndlessResults, AdminResult, AdminResults, EndlessReplayDetail, ReplayDetail } from "../src/api/models.ts";
import { AdminResultsModel, type ResultsApi } from "../src/ui/admin-results.ts";
import type { ReplayViewer } from "../src/ui/replay-viewer.ts";

const TODAY = "2026-10-27";
const puzzle = "530070000600195000098000060800060003400803001700020006060000280000419005000080079";

const res = (userId: string, level: number, extra: Partial<AdminResult> = {}): AdminResult => ({
  generator: 1, userId, displayName: userId.toUpperCase(), level, elapsedMs: 1000 * level, completedAt: "c", submittedAt: "s",
  replay: "valid", replayError: "", flag: null, ...extra,
});
const flag = (reason: string, auto = false): NonNullable<AdminResult["flag"]> => ({ reason, auto, flaggedBy: null, flaggedAt: "f" });
const day = (date: string, ...results: AdminResult[]): AdminResults => ({ date, levels: 5, results });
const detailOf = (r: AdminResult, date = TODAY): ReplayDetail => ({
  ...r, date, levels: 5, givens: puzzle, events: [{ a: "start", t: 0, w: 1 }, { a: "place", t: 100, w: 2, c: 2, d: 4 }],
});

const eres = (userId: string, difficulty: number, number: number, extra: Partial<AdminEndlessResult> = {}): AdminEndlessResult => ({
  userId, displayName: userId.toUpperCase(), generator: 1, difficulty, number, elapsedMs: 1000 * number, completedAt: "c", submittedAt: "2026-10-27T01:00:00Z",
  replay: "valid", replayError: "", flag: null, ...extra,
});
const eday = (date: string, ...results: AdminEndlessResult[]): AdminEndlessResults => ({ date, results });
const edetailOf = (r: AdminEndlessResult): EndlessReplayDetail => ({
  ...r, givens: puzzle, events: [{ a: "start", t: 0, w: 1 }, { a: "place", t: 100, w: 2, c: 2, d: 4 }],
});

const g = (generator: number) => (generator === 1 ? "" : `:g${generator}`);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Answers from tables; a request with a pending entry waits for the test to settle it. */
class FakeApi implements ResultsApi {
  calls: string[] = [];
  days = new Map<string, AdminResults | Error>();
  details = new Map<string, ReplayDetail | Error>();
  /** The result a flag or unflag answers with, or an error. */
  change: AdminResult | Error = res("a", 1);
  endlessDays = new Map<string, AdminEndlessResults | Error>();
  endlessDetails = new Map<string, EndlessReplayDetail | Error>();
  endlessChange: AdminEndlessResult | Error = eres("a", 1, 1);
  hold: Deferred<void>[] = [];
  gate: Deferred<void> | null = null;

  async #answer<T>(value: T | Error | undefined): Promise<T> {
    if (this.gate) {
      const gate = this.gate;
      this.gate = null;
      this.hold.push(gate);
      await gate.promise;
    }
    if (value instanceof Error) throw value;
    return value as T;
  }

  adminResults(date: string): Promise<AdminResults> {
    this.calls.push(`results:${date}`);
    return this.#answer(this.days.get(date) ?? day(date));
  }

  // Classic's calls read as they did before there were several generators; others are suffixed `:g<generator>`.
  adminReplay(generator: number, date: string, level: number, userId: string): Promise<ReplayDetail> {
    this.calls.push(`replay:${date}:${level}:${userId}${g(generator)}`);
    return this.#answer(this.details.get(`${date}:${level}:${userId}${g(generator)}`));
  }

  flagResult(generator: number, date: string, level: number, userId: string, reason: string): Promise<AdminResult> {
    this.calls.push(`flag:${date}:${level}:${userId}:${reason}${g(generator)}`);
    return this.#answer(this.change);
  }

  unflagResult(generator: number, date: string, level: number, userId: string): Promise<AdminResult> {
    this.calls.push(`unflag:${date}:${level}:${userId}${g(generator)}`);
    return this.#answer(this.change);
  }

  adminEndlessResults(date: string): Promise<AdminEndlessResults> {
    this.calls.push(`eresults:${date}`);
    return this.#answer(this.endlessDays.get(date) ?? eday(date));
  }

  adminEndlessReplay(generator: number, difficulty: number, number: number, userId: string): Promise<EndlessReplayDetail> {
    this.calls.push(`ereplay:${generator}:${difficulty}:${number}:${userId}`);
    return this.#answer(this.endlessDetails.get(`${generator}:${difficulty}:${number}:${userId}`));
  }

  flagEndlessResult(generator: number, difficulty: number, number: number, userId: string, reason: string): Promise<AdminEndlessResult> {
    this.calls.push(`eflag:${generator}:${difficulty}:${number}:${userId}:${reason}`);
    return this.#answer(this.endlessChange);
  }

  unflagEndlessResult(generator: number, difficulty: number, number: number, userId: string): Promise<AdminEndlessResult> {
    this.calls.push(`eunflag:${generator}:${difficulty}:${number}:${userId}`);
    return this.#answer(this.endlessChange);
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const offline = new TypeError("Failed to fetch");
const forbidden = new ApiException(403, { code: "forbidden", message: "admin access required" });

function setup(): { api: FakeApi; model: AdminResultsModel; changes: () => number } {
  const api = new FakeApi();
  const model = new AdminResultsModel(api, TODAY);
  let n = 0;
  model.addEventListener("change", () => n++);
  return { api, model, changes: () => n };
}

test("a new model starts on today with nothing loaded", () => {
  const { model } = setup();
  assert.deepEqual([model.date, model.today, model.data, model.loading, model.loadError, model.busy, model.error], [TODAY, TODAY, null, false, null, false, null]);
  assert.deepEqual([model.viewer, model.opened, model.viewerError], [null, null, null]);
});

test("load fetches the day, showing loading in between", async () => {
  const { api, model, changes } = setup();
  api.days.set(TODAY, day(TODAY, res("a", 1)));
  const gate = deferred<void>();
  api.gate = gate;
  const loading = model.load();
  assert.ok(model.loading);
  assert.equal(model.data, null);
  assert.equal(changes(), 1);
  gate.resolve();
  await loading;
  assert.ok(!model.loading);
  assert.equal(model.data!.results.length, 1);
  assert.equal(model.loadError, null);
  assert.equal(changes(), 2);
  assert.deepEqual(api.calls, [`results:${TODAY}`]);
});

test("a failed load reports why, and a later load clears it", async () => {
  const { api, model } = setup();
  api.days.set(TODAY, forbidden);
  await model.load();
  assert.equal(model.loadError, "Your account isn't an admin");
  assert.equal(model.data, null);
  assert.ok(!model.loading);

  api.days.set(TODAY, offline);
  await model.load();
  assert.match(model.loadError!, /Couldn't reach the server/);

  api.days.set(TODAY, day(TODAY, res("a", 1)));
  await model.load();
  assert.equal(model.loadError, null);
  assert.equal(model.data!.results.length, 1);
});

test("load takes a date and remembers it", async () => {
  const { api, model } = setup();
  await model.load("2026-10-25");
  assert.equal(model.date, "2026-10-25");
  await model.load();
  assert.deepEqual(api.calls, ["results:2026-10-25", "results:2026-10-25"]);
});

test("an older load that answers late is ignored, whether it succeeds or fails", async () => {
  const { api, model } = setup();
  api.days.set("2026-10-25", day("2026-10-25", res("old", 1)));
  api.days.set("2026-10-26", offline);
  api.days.set("2026-10-27", day(TODAY, res("new", 1)));

  const slowOk = deferred<void>();
  api.gate = slowOk;
  const first = model.load("2026-10-25");
  const second = model.load("2026-10-27");
  await second;
  assert.equal(model.data!.results[0]!.userId, "new");
  slowOk.resolve();
  await first;
  assert.equal(model.data!.results[0]!.userId, "new");
  assert.equal(model.date, "2026-10-27");
  assert.ok(!model.loading);

  const slowFail = deferred<void>();
  api.gate = slowFail;
  api.days.set("2026-10-24", offline);
  const third = model.load("2026-10-24");
  const fourth = model.load("2026-10-27");
  await fourth;
  slowFail.resolve();
  await third;
  assert.equal(model.loadError, null);
  assert.equal(model.data!.results[0]!.userId, "new");
});

test("shiftDate moves the list by days but never past today", async () => {
  const { api, model } = setup();
  await model.shiftDate(-1);
  assert.equal(model.date, "2026-10-26");
  await model.shiftDate(-3);
  assert.equal(model.date, "2026-10-23");
  await model.shiftDate(4);
  assert.equal(model.date, TODAY);
  const before = api.calls.length;
  await model.shiftDate(1);
  assert.equal(model.date, TODAY);
  assert.equal(api.calls.length, before);
  assert.deepEqual(api.calls, ["results:2026-10-26", "results:2026-10-23", `results:${TODAY}`]);
});

test("resultsFor and find read the loaded list", async () => {
  const { api, model } = setup();
  assert.deepEqual(model.resultsFor(1), []);
  assert.equal(model.find({ generator: 1, level: 1, userId: "a" }), null);
  const a1 = res("a", 1);
  const b1 = res("b", 1);
  const a2 = res("a", 2);
  api.days.set(TODAY, day(TODAY, a1, b1, a2));
  await model.load();
  assert.deepEqual(model.resultsFor(1), [a1, b1]);
  assert.deepEqual(model.resultsFor(2), [a2]);
  assert.deepEqual(model.resultsFor(3), []);
  assert.equal(model.find({ generator: 1, level: 2, userId: "a" }), a2);
  assert.equal(model.find({ generator: 1, level: 1, userId: "b" }), b1);
  assert.equal(model.find({ generator: 1, level: 2, userId: "b" }), null);
  assert.equal(model.find({ generator: 1, level: 3, userId: "a" }), null);
});

test("open loads the replay into a viewer with the digits hidden", async () => {
  const { api, model, changes } = setup();
  const a1 = res("a", 1);
  api.details.set(`${TODAY}:1:a`, detailOf(a1));
  const gate = deferred<void>();
  api.gate = gate;
  const key = { generator: 1, level: 1, userId: "a" };
  const opening = model.open(key);
  assert.deepEqual(model.opened, key);
  assert.notEqual(model.opened, key);
  assert.equal(model.viewer, null);
  assert.equal(model.viewerError, null);
  gate.resolve();
  await opening;
  const viewer = model.viewer as ReplayViewer | null;
  assert.ok(viewer);
  assert.equal(viewer.length, 2);
  assert.equal(viewer.revealDigits, false);
  assert.deepEqual(api.calls, [`replay:${TODAY}:1:a`]);
  assert.ok(changes() >= 3); // close, start of open, end of open
});

test("opening another replay starts a fresh viewer, hidden again after a reveal", async () => {
  const { api, model } = setup();
  api.details.set(`${TODAY}:1:a`, detailOf(res("a", 1)));
  api.details.set(`${TODAY}:2:b`, detailOf(res("b", 2)));
  await model.open({ generator: 1, level: 1, userId: "a" });
  const first = model.viewer!;
  first.setRevealDigits(true);
  first.play();
  await model.open({ generator: 1, level: 2, userId: "b" });
  assert.notEqual(model.viewer, first);
  assert.ok(!first.playing);
  assert.equal(model.viewer!.revealDigits, false);
  assert.equal(model.viewer!.detail.userId, "b");

  // Same replay again, too.
  await model.open({ generator: 1, level: 2, userId: "b" });
  model.viewer!.setRevealDigits(true);
  await model.open({ generator: 1, level: 2, userId: "b" });
  assert.equal(model.viewer!.revealDigits, false);
});

test("a failed open reports why and leaves no viewer", async () => {
  const { api, model } = setup();
  api.details.set(`${TODAY}:1:a`, forbidden);
  await model.open({ generator: 1, level: 1, userId: "a" });
  assert.equal(model.viewer, null);
  assert.equal(model.viewerError, "Your account isn't an admin");
  assert.deepEqual(model.opened, { generator: 1, level: 1, userId: "a" });

  api.details.set(`${TODAY}:1:a`, detailOf(res("a", 1)));
  await model.open({ generator: 1, level: 1, userId: "a" });
  assert.equal(model.viewerError, null);
  assert.ok(model.viewer);
});

test("an open that answers after another open or a close is ignored", async () => {
  const { api, model } = setup();
  api.details.set(`${TODAY}:1:a`, detailOf(res("a", 1)));
  api.details.set(`${TODAY}:2:b`, detailOf(res("b", 2)));
  api.details.set(`${TODAY}:3:c`, offline);

  // A slow success, overtaken by another open.
  const slow = deferred<void>();
  api.gate = slow;
  const first = model.open({ generator: 1, level: 1, userId: "a" });
  await model.open({ generator: 1, level: 2, userId: "b" });
  slow.resolve();
  await first;
  assert.equal(model.viewer!.detail.userId, "b");
  assert.deepEqual(model.opened, { generator: 1, level: 2, userId: "b" });

  // A slow failure, overtaken by another open.
  const slowFail = deferred<void>();
  api.gate = slowFail;
  const failing = model.open({ generator: 1, level: 3, userId: "c" });
  await model.open({ generator: 1, level: 1, userId: "a" });
  slowFail.resolve();
  await failing;
  assert.equal(model.viewerError, null);
  assert.equal(model.viewer!.detail.userId, "a");

  // A slow success, overtaken by a close.
  const slowClose = deferred<void>();
  api.gate = slowClose;
  const closing = model.open({ generator: 1, level: 2, userId: "b" });
  model.close();
  slowClose.resolve();
  await closing;
  assert.equal(model.viewer, null);
  assert.equal(model.opened, null);
});

test("close pauses and drops the viewer, and is fine with none open", async () => {
  const { api, model, changes } = setup();
  const before = changes();
  model.close();
  assert.equal(changes(), before + 1);
  api.details.set(`${TODAY}:1:a`, detailOf(res("a", 1)));
  await model.open({ generator: 1, level: 1, userId: "a" });
  const viewer = model.viewer!;
  viewer.play();
  assert.ok(viewer.playing);
  model.close();
  assert.ok(!viewer.playing);
  assert.deepEqual([model.viewer, model.opened, model.viewerError], [null, null, null]);
  // A closed viewer no longer reports through the model.
  const afterClose = changes();
  viewer.setRevealDigits(true);
  assert.equal(changes(), afterClose);

  api.details.set(`${TODAY}:1:a`, offline);
  await model.open({ generator: 1, level: 1, userId: "a" });
  assert.ok(model.viewerError);
  model.close();
  assert.equal(model.viewerError, null);
});

test("flag sends the trimmed reason and updates the list and the open replay", async () => {
  const { api, model } = setup();
  const a1 = res("a", 1);
  const b1 = res("b", 1);
  api.days.set(TODAY, day(TODAY, a1, b1));
  api.details.set(`${TODAY}:1:a`, detailOf(a1));
  await model.load();
  await model.open({ generator: 1, level: 1, userId: "a" });

  const flagged = res("a", 1, { flag: flag("too fast") });
  api.change = flagged;
  const sending = model.flag({ generator: 1, level: 1, userId: "a" }, "  too fast \n");
  assert.ok(model.busy);
  await sending;
  assert.ok(!model.busy);
  assert.equal(model.error, null);
  assert.deepEqual(api.calls.at(-1), `flag:${TODAY}:1:a:too fast`);
  assert.equal(model.find({ generator: 1, level: 1, userId: "a" }), flagged);
  assert.equal(model.find({ generator: 1, level: 1, userId: "b" }), b1);
  assert.deepEqual(model.viewer!.detail.flag, flagged.flag);

  // And off again.
  api.change = a1;
  await model.unflag({ generator: 1, level: 1, userId: "a" });
  assert.deepEqual(api.calls.at(-1), `unflag:${TODAY}:1:a`);
  assert.equal(model.find({ generator: 1, level: 1, userId: "a" }), a1);
  assert.equal(model.viewer!.detail.flag, null);
});

test("a flag leaves an open replay of a different result alone", async () => {
  const { api, model } = setup();
  const a1 = res("a", 1);
  api.days.set(TODAY, day(TODAY, a1, res("b", 1)));
  api.details.set(`${TODAY}:1:a`, detailOf(a1));
  await model.load();
  await model.open({ generator: 1, level: 1, userId: "a" });
  api.change = res("b", 1, { flag: flag("odd") });
  await model.flag({ generator: 1, level: 1, userId: "b" }, "odd");
  assert.equal(model.viewer!.detail.flag, null);
  assert.equal(model.find({ generator: 1, level: 1, userId: "b" })!.flag!.reason, "odd");
});

test("flagging works with no list loaded and no replay open", async () => {
  const { api, model } = setup();
  api.change = res("a", 1, { flag: flag("x") });
  await model.flag({ generator: 1, level: 1, userId: "a" }, "x");
  assert.equal(model.data, null);
  assert.equal(model.viewer, null);
  assert.equal(model.error, null);
  assert.ok(!model.busy);
});

test("a failed flag or unflag sets error and leaves the data alone; the next success clears it", async () => {
  const { api, model } = setup();
  const a1 = res("a", 1);
  api.days.set(TODAY, day(TODAY, a1));
  await model.load();

  api.change = forbidden;
  await model.flag({ generator: 1, level: 1, userId: "a" }, "x");
  assert.equal(model.error, "Your account isn't an admin");
  assert.ok(!model.busy);
  assert.equal(model.find({ generator: 1, level: 1, userId: "a" }), a1);

  api.change = offline;
  await model.unflag({ generator: 1, level: 1, userId: "a" });
  assert.match(model.error!, /Couldn't reach the server/);

  api.change = res("a", 1, { flag: flag("ok") });
  await model.flag({ generator: 1, level: 1, userId: "a" }, "ok");
  assert.equal(model.error, null);
});

test("a flag request while another is under way is ignored", async () => {
  const { api, model, changes } = setup();
  const gate = deferred<void>();
  api.gate = gate;
  api.change = res("a", 1, { flag: flag("x") });
  const first = model.flag({ generator: 1, level: 1, userId: "a" }, "x");
  const seen = changes();
  await model.flag({ generator: 1, level: 1, userId: "b" }, "y");
  await model.unflag({ generator: 1, level: 1, userId: "b" });
  assert.equal(changes(), seen);
  assert.equal(api.calls.length, 1);
  gate.resolve();
  await first;
  await settle();
  assert.ok(!model.busy);
  assert.equal(api.calls.length, 1);

  // Once it's done, the next one goes through.
  await model.unflag({ generator: 1, level: 1, userId: "b" });
  assert.equal(api.calls.length, 2);
});

test("the open viewer's change events are forwarded as the model's own", async () => {
  const { api, model, changes } = setup();
  api.details.set(`${TODAY}:1:a`, detailOf(res("a", 1)));
  await model.open({ generator: 1, level: 1, userId: "a" });
  const viewer = model.viewer!;
  const before = changes();
  viewer.setRevealDigits(true);
  assert.equal(changes(), before + 1);
  viewer.play();
  viewer.setSpeed(2);
  assert.equal(changes(), before + 3);
});

test("a new model is in daily mode with no endless list", () => {
  const { model } = setup();
  assert.deepEqual([model.mode, model.endlessData], ["daily", null]);
});

test("setMode reloads the current date's list for the mode, and clears the other list", async () => {
  const { api, model } = setup();
  api.days.set("2026-10-25", day("2026-10-25", res("a", 1)));
  api.endlessDays.set("2026-10-25", eday("2026-10-25", eres("a", 2, 7)));
  await model.load("2026-10-25");
  assert.equal(model.data!.results.length, 1);

  await model.setMode("endless");
  assert.equal(model.mode, "endless");
  assert.equal(model.date, "2026-10-25");
  assert.equal(model.data, null);
  assert.equal(model.endlessData!.results.length, 1);

  await model.setMode("daily");
  assert.equal(model.endlessData, null);
  assert.equal(model.data!.results.length, 1);
  assert.deepEqual(api.calls, ["results:2026-10-25", "eresults:2026-10-25", "results:2026-10-25"]);
});

test("shiftDate and load keep using the endless endpoint in endless mode", async () => {
  const { api, model } = setup();
  await model.setMode("endless");
  await model.shiftDate(-1);
  assert.deepEqual(api.calls, [`eresults:${TODAY}`, "eresults:2026-10-26"]);
});

test("endless load failures are reported and stale endless answers are ignored", async () => {
  const { api, model } = setup();
  await model.setMode("endless");
  api.endlessDays.set(TODAY, forbidden);
  await model.load();
  assert.equal(model.loadError, "Your account isn't an admin");
  assert.equal(model.endlessData, null);

  api.endlessDays.set("2026-10-25", eday("2026-10-25", eres("old", 1, 1)));
  api.endlessDays.set(TODAY, eday(TODAY, eres("new", 1, 1)));
  const slow = deferred<void>();
  api.gate = slow;
  const first = model.load("2026-10-25");
  await model.load(TODAY);
  slow.resolve();
  await first;
  assert.equal(model.endlessData!.results[0]!.userId, "new");
  assert.equal(model.date, TODAY);
});

test("endlessResultsFor groups by difficulty in the server's order, and find tells the lists apart", async () => {
  const { api, model } = setup();
  assert.deepEqual(model.endlessResultsFor(1), []);
  assert.equal(model.find({ generator: 1, difficulty: 1, number: 1, userId: "a" }), null);
  const a = eres("a", 2, 3);
  const b = eres("b", 2, 3);
  const c = eres("a", 2, 4);
  const d = eres("a", 1, 3);
  api.endlessDays.set(TODAY, eday(TODAY, d, a, b, c));
  const daily = res("a", 2);
  api.days.set(TODAY, day(TODAY, daily));
  await model.load();
  await model.setMode("endless");
  assert.deepEqual(model.endlessResultsFor(2), [a, b, c]);
  assert.deepEqual(model.endlessResultsFor(1), [d]);
  assert.deepEqual(model.endlessResultsFor(5), []);
  assert.equal(model.find({ generator: 1, difficulty: 2, number: 3, userId: "b" }), b);
  assert.equal(model.find({ generator: 1, difficulty: 2, number: 4, userId: "a" }), c);
  assert.equal(model.find({ generator: 1, difficulty: 2, number: 3, userId: "z" }), null);
  assert.equal(model.find({ generator: 1, difficulty: 1, number: 4, userId: "a" }), null);
  assert.equal(model.find({ generator: 1, difficulty: 3, number: 3, userId: "a" }), null);
  // A daily key never matches an endless row, even with the same player.
  assert.equal(model.find({ generator: 1, level: 2, userId: "a" }), null);
  await model.setMode("daily");
  assert.equal(model.find({ generator: 1, level: 2, userId: "a" }), daily);
  // And an endless key never matches a daily row.
  assert.equal(model.find({ generator: 1, difficulty: 2, number: 3, userId: "a" }), null);
});

test("open loads an endless replay, and a failure is reported", async () => {
  const { api, model } = setup();
  const a = eres("a", 2, 3);
  api.endlessDetails.set("1:2:3:a", edetailOf(a));
  const key = { generator: 1, difficulty: 2, number: 3, userId: "a" };
  await model.open(key);
  assert.deepEqual(model.opened, key);
  assert.notEqual(model.opened, key);
  assert.equal(model.viewer!.revealDigits, false);
  assert.equal(model.viewer!.detail.userId, "a");
  assert.deepEqual(api.calls, ["ereplay:1:2:3:a"]);

  api.endlessDetails.set("1:2:3:a", forbidden);
  await model.open(key);
  assert.equal(model.viewer, null);
  assert.equal(model.viewerError, "Your account isn't an admin");
});

test("endless flag and unflag use the endless endpoints and update the list and open replay", async () => {
  const { api, model } = setup();
  const a = eres("a", 2, 3);
  const b = eres("b", 2, 3);
  api.endlessDays.set(TODAY, eday(TODAY, a, b));
  api.endlessDetails.set("1:2:3:a", edetailOf(a));
  await model.setMode("endless");
  await model.open({ generator: 1, difficulty: 2, number: 3, userId: "a" });

  const flagged = eres("a", 2, 3, { flag: flag("too fast") });
  api.endlessChange = flagged;
  await model.flag({ generator: 1, difficulty: 2, number: 3, userId: "a" }, "  too fast ");
  assert.equal(api.calls.at(-1), "eflag:1:2:3:a:too fast");
  assert.equal(model.find({ generator: 1, difficulty: 2, number: 3, userId: "a" }), flagged);
  assert.equal(model.find({ generator: 1, difficulty: 2, number: 3, userId: "b" }), b);
  assert.deepEqual(model.viewer!.detail.flag, flagged.flag);

  api.endlessChange = a;
  await model.unflag({ generator: 1, difficulty: 2, number: 3, userId: "a" });
  assert.equal(api.calls.at(-1), "eunflag:1:2:3:a");
  assert.equal(model.find({ generator: 1, difficulty: 2, number: 3, userId: "a" }), a);
  assert.equal(model.viewer!.detail.flag, null);
});

test("an endless flag works with no endless list loaded, and failures set error", async () => {
  const { api, model } = setup();
  api.endlessChange = eres("a", 1, 1, { flag: flag("x") });
  await model.flag({ generator: 1, difficulty: 1, number: 1, userId: "a" }, "x");
  assert.equal(model.endlessData, null);
  assert.equal(model.data, null);
  assert.equal(model.error, null);

  api.endlessChange = forbidden;
  await model.unflag({ generator: 1, difficulty: 1, number: 1, userId: "a" });
  assert.equal(model.error, "Your account isn't an admin");
});

test("an endless flag leaves a daily replay with the same player alone", async () => {
  const { api, model } = setup();
  api.details.set(`${TODAY}:1:a`, detailOf(res("a", 1)));
  await model.open({ generator: 1, level: 1, userId: "a" });
  api.endlessChange = eres("a", 1, 1, { flag: flag("x") });
  await model.flag({ generator: 1, difficulty: 1, number: 1, userId: "a" }, "x");
  assert.equal(model.viewer!.detail.flag, null);
});
