import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReplayDetail } from "../src/api/models.ts";
import { Game } from "../src/game/game.ts";
import type { ReplayAction, ReplayEvent } from "../src/game/replay.ts";
import {
  LONG_GAP_MS, MIN_STRETCH_MS, PACE_MIN_PLACEMENTS, ReplayViewer, STEADY_VARIATION,
  analyse, applyEvent, cellName, formatGap, formatWall, isMove,
} from "../src/ui/replay-viewer.ts";

const puzzle = "530070000600195000098000060800060003400803001700020006060000280000419005000080079";
const solution = "534678912672195348198342567859761423426853791713924856961537284287419635345286179";
const empties = [...puzzle].flatMap((c, i) => (c === "0" ? [i] : []));
const digit = (i: number) => Number(solution[i]);

const ev = (a: ReplayAction, t: number, w: number, extra: Partial<ReplayEvent> = {}): ReplayEvent => ({ a, t, w, ...extra });
const kinds = (a: ReturnType<typeof analyse>) => a.stretches.map((s) => [s.kind, s.from, s.to, s.wallMs]);

function detail(events: ReplayEvent[]): ReplayDetail {
  return {
    userId: "u", displayName: "U", level: 1, elapsedMs: 1, completedAt: "c", submittedAt: "s", replay: "valid", replayError: "",
    flag: null, date: "2026-10-27", levels: 5, givens: puzzle, events,
  };
}

/** Places `n` empties of the real puzzle with the given timer gaps; wall clock runs with the timer. */
function placements(n: number, gap: (i: number) => number): ReplayEvent[] {
  let t = 0;
  const events = [ev("start", 0, 1000), ev("resume", 0, 1000)];
  for (let i = 0; i < n; i++) {
    t += gap(i);
    events.push(ev("place", t, 1000 + t, { c: empties[i]!, d: digit(empties[i]!) }));
  }
  return events;
}

// analyse

test("analyse of no events is all zeros", () => {
  const a = analyse([]);
  assert.deepEqual([a.timerMs, a.wallSpanMs, a.pausedMs, a.hiddenMs, a.stretches, a.gaps, a.wallGaps, a.pace], [0, 0, 0, 0, [], [], [], null]);
  assert.equal(a.longGaps.size, 0);
});

test("isMove is true for board changes only", () => {
  for (const a of ["place", "erase", "noteAdd", "noteRemove", "undo", "clear"] as const) assert.ok(isMove(ev(a, 0, 0)), a);
  for (const a of ["start", "notes", "pause", "resume", "hidden", "visible", "restore", "finish"] as const) assert.ok(!isMove(ev(a, 0, 0)), a);
});

test("paused stretches: short ones are only counted, long ones listed", () => {
  const a = analyse([
    ev("start", 0, 0), ev("resume", 0, 500), // 500 ms before the timer started: below MIN_STRETCH_MS
    ev("place", 1000, 1500, { c: 2, d: 4 }),
    ev("pause", 1000, 2000), ev("resume", 1000, 5000), // 3 s paused
    ev("place", 2000, 6000, { c: 3, d: 6 }),
    ev("pause", 2000, 6100), ev("resume", 2000, 6100 + MIN_STRETCH_MS - 1), // just under the limit
    ev("pause", 2000, 7000), ev("resume", 2000, 7000 + MIN_STRETCH_MS), // exactly the limit
    ev("finish", 2000, 9000),
  ]);
  assert.deepEqual(kinds(a), [["paused", 3, 4, 3000], ["paused", 8, 9, 1000]]);
  assert.equal(a.pausedMs, 500 + 3000 + (MIN_STRETCH_MS - 1) + MIN_STRETCH_MS);
  assert.equal(a.hiddenMs, 0);
  assert.equal(a.timerMs, 2000);
  assert.equal(a.wallSpanMs, 9000);
  assert.deepEqual(a.wallGaps.slice(0, 5), [0, 500, 1000, 500, 3000]);
});

test("a pause while paused and a resume while running change nothing", () => {
  const a = analyse([
    ev("start", 0, 0), ev("resume", 0, 0), ev("resume", 0, 100), // second resume: already running
    ev("pause", 10, 2000), ev("pause", 10, 3000), // second pause: already stopped
    ev("resume", 10, 6000),
  ]);
  assert.deepEqual(kinds(a), [["paused", 3, 5, 4000]]);
  assert.equal(a.pausedMs, 4000);
});

test("hidden stretches pair a hidden event with the next visible one", () => {
  const a = analyse([
    ev("start", 0, 0), ev("resume", 0, 0),
    ev("visible", 0, 100), // not hidden: ignored
    ev("hidden", 0, 1000), ev("hidden", 0, 2000), // already hidden: ignored
    ev("visible", 0, 5000), // 4 s hidden
    ev("hidden", 0, 6000), ev("visible", 0, 6500), // 0.5 s: counted, not listed
    ev("finish", 0, 7000),
  ]);
  assert.deepEqual(kinds(a), [["hidden", 3, 5, 4000]]);
  assert.equal(a.hiddenMs, 4500);
  assert.equal(a.pausedMs, 0);
});

test("a hidden stretch can overlap a paused one, and both are listed in order", () => {
  const a = analyse([
    ev("start", 0, 0), ev("resume", 0, 0),
    ev("pause", 0, 1000), ev("hidden", 0, 2000), ev("resume", 0, 4000), ev("visible", 0, 6000),
  ]);
  assert.deepEqual(kinds(a), [["paused", 2, 4, 3000], ["hidden", 3, 5, 4000]]);
  assert.deepEqual([a.pausedMs, a.hiddenMs], [3000, 4000]);
});

test("stretches that start at the same event are ordered by where they end", () => {
  // The timer starts stopped, so a replay opening with the app hidden has both stretches starting at event 0.
  const pausedFirst = analyse([ev("hidden", 0, 0), ev("resume", 0, 3000), ev("visible", 0, 6000)]);
  assert.deepEqual(kinds(pausedFirst), [["paused", 0, 1, 3000], ["hidden", 0, 2, 6000]]);
  const hiddenFirst = analyse([ev("hidden", 0, 0), ev("visible", 0, 2000), ev("resume", 0, 5000)]);
  assert.deepEqual(kinds(hiddenFirst), [["hidden", 0, 1, 2000], ["paused", 0, 2, 5000]]);
});

test("a restore stops the timer until the next resume, whether it was running or not", () => {
  // A reload while running: the time until the player is back counts as paused.
  const running = analyse([ev("start", 0, 0), ev("resume", 0, 0), ev("restore", 500, 1000), ev("resume", 500, 4000), ev("finish", 600, 4100)]);
  assert.deepEqual(kinds(running), [["paused", 2, 3, 3000]]);
  assert.equal(running.pausedMs, 3000);

  // A reload while already stopped: the stretch started at the original stop and carries on.
  const stopped = analyse([ev("start", 0, 0), ev("restore", 0, 2000), ev("resume", 0, 5000)]);
  assert.deepEqual(kinds(stopped), [["paused", 0, 2, 5000]]);
  assert.equal(stopped.pausedMs, 5000);
});

test("wall gaps going backwards count as zero", () => {
  const a = analyse([
    ev("start", 0, 10_000), ev("resume", 0, 10_000),
    ev("pause", 5, 20_000), ev("resume", 5, 15_000), // wall clock moved back 5 s
    ev("finish", 9, 9_000),
  ]);
  assert.deepEqual(a.wallGaps, [0, 0, 10_000, 0, 0]);
  assert.deepEqual(a.stretches, []);
  assert.equal(a.wallSpanMs, 0);
});

test("gaps are measured from the previous move, or from the previous event for other events", () => {
  const a = analyse([
    ev("place", 700, 0, { c: 2, d: 4 }), // a move first: gap from time zero
    ev("notes", 1000, 0, { on: true }), // 300 since the previous event
    ev("noteAdd", 1500, 0, { c: 3, d: 6 }), // 800 since the last move
    ev("pause", 1800, 0),
    ev("undo", 2000, 0),
  ]);
  assert.deepEqual(a.gaps, [700, 300, 800, 300, 500]);
  const first = analyse([ev("start", 5, 0)]);
  assert.deepEqual(first.gaps, [0]);
});

test("long gaps need both the absolute threshold and a multiple of the median", () => {
  const long = analyse(placements(4, (i) => (i === 3 ? 40_000 : 1000)));
  assert.deepEqual([...long.longGaps], [5]);

  const slowEveryTime = analyse(placements(4, () => LONG_GAP_MS + 10_000)); // long, but not unusual
  assert.equal(slowEveryTime.longGaps.size, 0);

  const quickGap = analyse(placements(4, (i) => (i === 3 ? 20_000 : 1000))); // unusual, but under the threshold
  assert.equal(quickGap.longGaps.size, 0);

  // A long gap before a non-move event isn't flagged.
  assert.equal(analyse([ev("start", 0, 0), ev("pause", 100_000, 0)]).longGaps.size, 0);
});

test("pace is judged only from enough placements", () => {
  assert.equal(analyse(placements(PACE_MIN_PLACEMENTS - 1, () => 2000)).pace, null);
  assert.equal(analyse([ev("start", 0, 0), ev("noteAdd", 10, 0, { c: 2, d: 4 })]).pace, null);

  const steady = analyse(placements(PACE_MIN_PLACEMENTS, () => 2000)).pace!;
  assert.equal(steady.placements, PACE_MIN_PLACEMENTS);
  assert.equal(steady.medianMs, 2000);
  assert.equal(steady.variation, 0);
  assert.ok(steady.steady);
});

test("human-like variation is not steady", () => {
  const gaps = [1000, 9000, 2500, 400, 15_000, 3000, 700, 6000, 1200, 20_000];
  const pace = analyse(placements(gaps.length, (i) => gaps[i]!)).pace!;
  assert.ok(pace.variation >= STEADY_VARIATION, String(pace.variation));
  assert.ok(!pace.steady);
  // Nine gaps between ten placements (the first has no gap before it): the median is the middle one, 3000.
  assert.equal(pace.medianMs, 3000);
});

test("the median of an even number of gaps is the mean of the middle two", () => {
  // 11 placements -> 10 gaps.
  const gaps = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100];
  const pace = analyse(placements(11, (i) => gaps[i]!)).pace!;
  assert.equal(pace.medianMs, 650);
});

test("placements all at the same instant have zero variation", () => {
  const events = [ev("start", 0, 0), ...Array.from({ length: PACE_MIN_PLACEMENTS }, (_, i) => ev("place", 0, i, { c: empties[i]!, d: digit(empties[i]!) }))];
  const pace = analyse(events).pace!;
  assert.equal(pace.variation, 0);
  assert.ok(pace.steady);
});

// applyEvent

const fresh = () => Game.create(puzzle);

test("applyEvent places, erases and toggles notes", () => {
  const placed = applyEvent(fresh(), ev("place", 100, 0, { c: 2, d: 4 }));
  assert.equal(placed.board.get(2), 4);
  assert.equal(applyEvent(placed, ev("erase", 0, 0, { c: 2 })).board.get(2), 0);

  const noted = applyEvent(fresh(), ev("noteAdd", 0, 0, { c: 2, d: 4 }));
  assert.ok(noted.notes.has(2, 4));
  const removed = applyEvent(noted, ev("noteRemove", 0, 0, { c: 2, d: 4 }));
  assert.ok(!removed.notes.has(2, 4));
  assert.equal(applyEvent(noted, ev("erase", 0, 0, { c: 2 })).notes.has(2, 4), false);
});

test("applyEvent ignores events that don't fit", () => {
  const g = applyEvent(fresh(), ev("noteAdd", 0, 0, { c: 3, d: 6 }));
  const unchanged = (e: ReplayEvent) => assert.equal(applyEvent(g, e), g, JSON.stringify(e));
  // Bad cells.
  for (const c of [undefined, -1, 81, 200]) {
    for (const a of ["place", "erase", "noteAdd", "noteRemove"] as const) unchanged(ev(a, 0, 0, { ...(c === undefined ? {} : { c }), d: 4 }));
  }
  // Bad digits.
  for (const d of [undefined, 0, 10, -3]) {
    for (const a of ["place", "noteAdd", "noteRemove"] as const) unchanged(ev(a, 0, 0, { c: 2, ...(d === undefined ? {} : { d }) }));
  }
  // Redundant note events.
  unchanged(ev("noteAdd", 0, 0, { c: 3, d: 6 })); // already there
  unchanged(ev("noteRemove", 0, 0, { c: 2, d: 4 })); // never there
  // Nothing to erase, a given, an undo with no history.
  unchanged(ev("erase", 0, 0, { c: 5 }));
  unchanged(ev("erase", 0, 0, { c: 0 }));
  assert.equal(applyEvent(fresh(), ev("undo", 0, 0)).canUndo, false);
  unchanged(ev("place", 0, 0, { c: 80, d: 1 })); // a given
  // The last valid cell and digit bounds are accepted.
  assert.equal(applyEvent(fresh(), ev("place", 0, 0, { c: 77, d: 1 })).board.get(77), 1);
  assert.equal(applyEvent(fresh(), ev("place", 0, 0, { c: 2, d: 9 })).board.get(2), 9);
});

test("applyEvent undoes, clears and restores", () => {
  const g = applyEvent(applyEvent(fresh(), ev("place", 0, 0, { c: 2, d: 4 })), ev("noteAdd", 0, 0, { c: 3, d: 6 }));
  assert.ok(g.notes.has(3, 6));
  const undone = applyEvent(g, ev("undo", 0, 0));
  assert.ok(!undone.notes.has(3, 6));
  assert.equal(undone.board.get(2), 4);

  const cleared = applyEvent(g, ev("clear", 0, 0));
  assert.equal(cleared.board.get(2), 0);
  assert.ok(!cleared.notes.has(3, 6));

  // A reload keeps the board and notes but loses the undo history.
  assert.ok(g.canUndo);
  const restored = applyEvent(g, ev("restore", 0, 0));
  assert.equal(restored.board.get(2), 4);
  assert.ok(restored.notes.has(3, 6));
  assert.ok(!restored.canUndo);
});

test("applyEvent leaves the game alone for events that don't touch the board", () => {
  const g = fresh();
  for (const a of ["start", "notes", "pause", "resume", "hidden", "visible", "finish"] as const) assert.equal(applyEvent(g, ev(a, 0, 0, { c: 2, d: 4, on: true })), g, a);
});

// helpers

test("cellName is 1-based row and column", () => {
  assert.equal(cellName(0), "R1C1");
  assert.equal(cellName(13), "R2C5");
  assert.equal(cellName(80), "R9C9");
});

test("formatWall shows the time of day in the given timezone", () => {
  const t = Date.UTC(2026, 9, 27, 13, 5, 9);
  assert.equal(formatWall(t, "UTC"), "13:05:09");
  assert.equal(formatWall(t, "Pacific/Auckland"), "02:05:09");
  assert.equal(formatWall(Date.UTC(2026, 9, 27, 0, 0, 0), "UTC"), "00:00:00");
  assert.match(formatWall(t), /^\d\d:\d\d:\d\d$/);
});

test("formatGap covers milliseconds, seconds, minutes and hours", () => {
  assert.equal(formatGap(0), "0 ms");
  assert.equal(formatGap(850.4), "850 ms");
  assert.equal(formatGap(999), "999 ms");
  assert.equal(formatGap(1000), "1.0 s");
  assert.equal(formatGap(12_400), "12.4 s");
  assert.equal(formatGap(59_949), "59.9 s");
  assert.equal(formatGap(59_960), "1 m 00 s");
  assert.equal(formatGap(60_000), "1 m 00 s");
  assert.equal(formatGap(185_000), "3 m 05 s");
  assert.equal(formatGap(3_599_000), "59 m 59 s");
  assert.equal(formatGap(3_600_000), "1 h 00 m");
  assert.equal(formatGap(3_720_000), "1 h 02 m");
  assert.equal(formatGap(26 * 3_600_000 + 30 * 60_000), "26 h 30 m");
});

// ReplayViewer

/** A scripted game on the real puzzle: notes, placements, an erase, an undo, a pause, a reload and the finish. */
function script(): ReplayEvent[] {
  return [
    ev("start", 0, 1000), // 0
    ev("resume", 0, 1000), // 1
    ev("notes", 0, 1100, { on: true }), // 2
    ev("noteAdd", 1000, 2000, { c: 2, d: 4 }), // 3
    ev("noteAdd", 1500, 2500, { c: 2, d: 5 }), // 4
    ev("noteRemove", 2000, 3000, { c: 2, d: 5 }), // 5
    ev("notes", 2200, 3200, { on: false }), // 6
    ev("place", 3000, 4000, { c: 2, d: 4 }), // 7
    ev("place", 4000, 5000, { c: 3, d: 6 }), // 8
    ev("erase", 5000, 6000, { c: 3 }), // 9: erases a digit
    ev("noteAdd", 5500, 6500, { c: 3, d: 6 }), // 10
    ev("erase", 6000, 7000, { c: 3 }), // 11: erases notes
    ev("undo", 6500, 7500), // 12
    ev("clear", 7000, 8000), // 13
    ev("pause", 7000, 9000), // 14
    ev("resume", 7000, 20_000), // 15: an 11 s pause
    ev("hidden", 7500, 20_500), // 16
    ev("visible", 7600, 25_000), // 17: hidden for 4.5 s
    ev("restore", 7600, 26_000), // 18
    ev("place", 8000, 27_000, { c: 5, d: 8 }), // 19
    ev("finish", 9000, 28_000), // 20
  ];
}

const all = (v: ReplayViewer) => Array.from({ length: v.length }, (_, k) => v.describe(k));

test("a viewer rebuilds the board after every event and reports its analysis", () => {
  const v = new ReplayViewer(detail(script()));
  assert.equal(v.length, 21);
  assert.equal(v.endMs, 9000);
  assert.equal(v.analysis.timerMs, 9000);
  assert.deepEqual([v.index, v.cursorMs, v.playing, v.speed, v.revealDigits], [0, 0, false, 1, false]);
  assert.equal(v.detail.givens, puzzle);
  assert.equal(v.events.length, 21);
  assert.equal(v.game.board.get(2), 0);
  assert.equal(v.current, null);
  assert.equal(v.changedCell, -1);

  v.goTo(5);
  assert.ok(v.game.notes.has(2, 4) && v.game.notes.has(2, 5));
  assert.equal(v.current!.a, "noteAdd");
  assert.equal(v.changedCell, 2);
  v.goTo(6);
  assert.ok(!v.game.notes.has(2, 5));
  v.goTo(9);
  assert.equal(v.game.board.get(3), 6);
  v.goTo(10);
  assert.equal(v.game.board.get(3), 0);
  v.goTo(21);
  assert.equal(v.game.board.get(2), 0); // cleared
  assert.equal(v.game.board.get(5), 8);
  assert.equal(v.current!.a, "finish");
  assert.equal(v.changedCell, -1);
});

test("a viewer hides digits and notes by default", () => {
  const v = new ReplayViewer(detail(script()));
  assert.equal(v.revealDigits, false);
  v.goTo(5); // notes 4 and 5 in cell 2
  assert.deepEqual(v.cell(2), { kind: "notes", text: "··" });
  assert.deepEqual(v.cell(0), { kind: "given", text: "5" });
  assert.deepEqual(v.cell(3), { kind: "empty", text: "" });
  v.goTo(8); // 4 placed in cell 2
  assert.deepEqual(v.cell(2), { kind: "entry", text: "•" });

  const lines = all(v);
  assert.deepEqual(lines, [
    "Opened the puzzle", "Timer started", "Notes mode on", "Added note in R1C3", "Added note in R1C3", "Removed note in R1C3", "Notes mode off",
    "Placed a digit in R1C3", "Placed a digit in R1C4", "Erased the digit in R1C4", "Added note in R1C4", "Erased the notes in R1C4",
    "Undo", "Cleared the board", "Timer stopped", "Timer started", "App hidden", "App visible again", "Reloaded from storage",
    "Placed a digit in R1C6", "Solved",
  ]);
  for (const line of lines) assert.doesNotMatch(line.replace(/R\dC\d/, ""), /\d/, line);
});

test("revealing digits shows them in the cells and the descriptions, and fires change", () => {
  const v = new ReplayViewer(detail(script()));
  let changes = 0;
  v.addEventListener("change", () => changes++);
  v.setRevealDigits(true);
  assert.equal(v.revealDigits, true);
  assert.equal(changes, 1);

  v.goTo(5);
  assert.deepEqual(v.cell(2), { kind: "notes", text: "45" });
  v.goTo(8);
  assert.deepEqual(v.cell(2), { kind: "entry", text: "4" });
  assert.deepEqual(v.cell(0), { kind: "given", text: "5" });
  assert.equal(v.describe(3), "Added note 4 in R1C3");
  assert.equal(v.describe(5), "Removed note 5 in R1C3");
  assert.equal(v.describe(7), "Placed 4 in R1C3");
  assert.equal(v.describe(19), "Placed 8 in R1C6");

  v.setRevealDigits(false);
  assert.deepEqual(v.cell(2), { kind: "entry", text: "•" });
  assert.equal(v.describe(7), "Placed a digit in R1C3");
});

test("a new viewer for the same detail starts hidden again", () => {
  const d = detail(script());
  const first = new ReplayViewer(d);
  first.setRevealDigits(true);
  first.goTo(8);
  assert.equal(first.cell(2).text, "4");
  const second = new ReplayViewer(d);
  assert.equal(second.revealDigits, false);
  second.goTo(8);
  assert.equal(second.cell(2).text, "•");
  assert.equal(second.describe(7), "Placed a digit in R1C3");
  assert.equal(first.revealDigits, true);
});

test("describe copes with events missing their cell, digit or mode", () => {
  const v = new ReplayViewer(detail([
    ev("place", 0, 0), ev("noteAdd", 0, 0), ev("noteRemove", 0, 0), ev("erase", 0, 0), ev("notes", 0, 0),
    ev("place", 0, 0, { c: 2 }), ev("noteAdd", 0, 0, { c: 2 }),
  ]));
  v.setRevealDigits(true);
  assert.deepEqual(all(v), [
    "Placed a digit in ", "Added note in ", "Removed note in ", "Erased the notes in ", "Notes mode off",
    "Placed a digit in R1C3", "Added note in R1C3",
  ]);
});

test("play, pause and speed fire change", () => {
  const v = new ReplayViewer(detail(script()));
  let changes = 0;
  v.addEventListener("change", () => changes++);
  v.play();
  assert.ok(v.playing);
  assert.equal(changes, 1);
  v.pause();
  assert.ok(!v.playing);
  assert.equal(changes, 2);
  v.setSpeed(4);
  assert.equal(v.speed, 4);
  assert.equal(changes, 3);
});

test("play with no events does nothing", () => {
  const v = new ReplayViewer(detail([]));
  let changes = 0;
  v.addEventListener("change", () => changes++);
  v.play();
  assert.ok(!v.playing);
  assert.equal(changes, 0);
  assert.equal(v.endMs, 0);
  assert.equal(v.game.board.get(2), 0);
  assert.equal(v.length, 0);
});

test("play at the end starts over", () => {
  const v = new ReplayViewer(detail(script()));
  v.goTo(21);
  assert.equal(v.cursorMs, 9000);
  v.play();
  assert.ok(v.playing);
  assert.equal(v.cursorMs, 0);
  // The events at time zero are already applied.
  assert.equal(v.index, 3);
  v.tick(0);
  assert.equal(v.index, 3);
});

test("play mid-way carries on from where it is", () => {
  const v = new ReplayViewer(detail(script()));
  v.goTo(5);
  v.play();
  assert.equal(v.index, 5);
  assert.ok(v.playing);
});

test("tick does nothing unless playing", () => {
  const v = new ReplayViewer(detail(script()));
  let changes = 0;
  v.addEventListener("change", () => changes++);
  v.tick(5000);
  assert.deepEqual([v.cursorMs, v.index, changes], [0, 0, 0]);
});

test("tick advances the cursor at the playback speed, applying events as it passes them", () => {
  const v = new ReplayViewer(detail(script()));
  let changes = 0;
  v.addEventListener("change", () => changes++);
  v.play();
  changes = 0;
  v.tick(1000);
  assert.deepEqual([v.cursorMs, v.index], [1000, 4]); // start, resume, notes, first noteAdd
  assert.equal(changes, 1);
  v.setSpeed(2);
  v.tick(1000);
  assert.deepEqual([v.cursorMs, v.index], [3000, 8]);
  v.setSpeed(8);
  v.tick(100);
  assert.equal(v.cursorMs, 3800);
  assert.equal(v.index, 8);
  assert.ok(v.playing);
});

test("tick stops at the end and never goes past it", () => {
  const v = new ReplayViewer(detail(script()));
  v.play();
  v.setSpeed(8);
  v.tick(1_000_000);
  assert.equal(v.cursorMs, 9000);
  assert.equal(v.index, 21);
  assert.ok(!v.playing);
  assert.equal(v.game.board.get(5), 8);
  v.tick(1000); // no longer playing
  assert.equal(v.cursorMs, 9000);
});

test("seek clamps to the replay and applies every event at or before it", () => {
  const v = new ReplayViewer(detail(script()));
  let changes = 0;
  v.addEventListener("change", () => changes++);
  v.seek(3000);
  assert.deepEqual([v.cursorMs, v.index], [3000, 8]);
  assert.equal(v.game.board.get(2), 4);
  v.seek(-50);
  assert.deepEqual([v.cursorMs, v.index], [0, 3]);
  v.seek(1e9);
  assert.deepEqual([v.cursorMs, v.index], [9000, 21]);
  assert.equal(changes, 3);
});

test("goTo clamps and moves the cursor to the event's time", () => {
  const v = new ReplayViewer(detail(script()));
  v.goTo(8);
  assert.deepEqual([v.index, v.cursorMs], [8, 3000]);
  v.goTo(-3);
  assert.deepEqual([v.index, v.cursorMs], [0, 0]);
  v.goTo(99);
  assert.deepEqual([v.index, v.cursorMs], [21, 9000]);
});

test("next and previous step one event and stop playback", () => {
  const v = new ReplayViewer(detail(script()));
  v.play();
  v.next();
  assert.ok(!v.playing);
  assert.equal(v.index, 1);
  v.play();
  v.next();
  assert.equal(v.index, 2);
  v.play();
  v.previous();
  assert.ok(!v.playing);
  assert.equal(v.index, 1);
  v.previous();
  v.previous();
  assert.equal(v.index, 0);
  v.goTo(21);
  v.next();
  assert.equal(v.index, 21);
});

test("stretchAt finds the paused or hidden stretch an event falls in", () => {
  const v = new ReplayViewer(detail(script()));
  const stretches = v.analysis.stretches.map((s) => [s.kind, s.from, s.to]);
  assert.deepEqual(stretches, [["paused", 14, 15], ["hidden", 16, 17]]);
  assert.equal(v.stretchAt(13), null);
  assert.equal(v.stretchAt(14), null); // the event that starts it is not inside it
  assert.equal(v.stretchAt(15)!.kind, "paused"); // the event that ends it is
  assert.equal(v.stretchAt(16), null);
  assert.equal(v.stretchAt(17)!.kind, "hidden");
  assert.equal(v.stretchAt(18), null);
});

test("every kind of event reads as a line, including with the digits revealed", () => {
  const v = new ReplayViewer(detail(script()));
  v.setRevealDigits(true);
  assert.equal(all(v).length, 21);
  assert.equal(v.describe(2), "Notes mode on");
  assert.equal(v.describe(6), "Notes mode off");
  assert.equal(v.describe(9), "Erased the digit in R1C4");
  assert.equal(v.describe(11), "Erased the notes in R1C4");
});

test("tick fires change only for a new event, a new timer second or the end", () => {
  const v = new ReplayViewer(detail([ev("start", 0, 0), ev("resume", 0, 0), ev("finish", 10_000, 10_000)]));
  let changes = 0;
  v.addEventListener("change", () => changes++);
  v.play();
  changes = 0;

  v.tick(500); // the two events at time zero
  assert.deepEqual([v.index, changes], [2, 1]);
  v.tick(300); // 800 ms: same second, no event
  v.tick(100); // 900 ms
  assert.deepEqual([v.cursorMs, v.index, changes], [900, 2, 1]);
  v.tick(200); // 1100 ms: a new second
  assert.deepEqual([v.cursorMs, changes], [1100, 2]);
  v.tick(100); // 1200 ms
  assert.equal(changes, 2);
  v.setSpeed(8);
  changes = 0;
  v.tick(100); // 2000 ms at 8x: a new second
  assert.deepEqual([v.cursorMs, changes], [2000, 1]);
  v.tick(1_000_000); // the last event and the end
  assert.deepEqual([v.index, v.playing, changes], [3, false, 2]);
});

test("tick fires change when playback stops even if nothing else moved", () => {
  const v = new ReplayViewer(detail([ev("start", 0, 0)]));
  v.goTo(1);
  v.playing = true;
  let changes = 0;
  v.addEventListener("change", () => changes++);
  v.tick(10);
  assert.ok(!v.playing);
  assert.equal(changes, 1);
});
