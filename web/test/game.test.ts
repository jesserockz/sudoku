import assert from "node:assert/strict";
import { test } from "node:test";
import { Board } from "../src/core/board.ts";
import { peers } from "../src/core/geometry.ts";
import { Game } from "../src/game/game.ts";
import { ElapsedTimer, formatDuration } from "../src/game/timer.ts";

const puzzle = "530070000600195000098000060800060003400803001700020006060000280000419005000080079";
const solution = "534678912672195348198342567859761423426853791713924856961537284287419635345286179";
const digit = (i: number) => Number(solution[i]);
const empties = () => [...puzzle].flatMap((c, i) => (c === "0" ? [i] : []));

/** Fills every empty cell but the last; returns that game and the last index. */
function nearlySolved(start: Game): [Game, number] {
  let g = start;
  const cells = empties();
  for (const i of cells.slice(0, -1)) g = g.place(i, digit(i), 0);
  return [g, cells[cells.length - 1]!];
}

test("board parses, formats and stays immutable", () => {
  const b = Board.parse(puzzle.replace(/0/g, "."));
  assert.equal(b.toCompactString(), puzzle);
  assert.equal(b.givenCount, 30);
  const c = b.with(2, 4);
  assert.equal(b.get(2), 0);
  assert.equal(c.get(2), 4);
  assert.throws(() => b.with(0, 1), /given/);
  assert.throws(() => Board.parse("123"));
  assert.throws(() => Board.parse(puzzle.slice(1) + "x"));
  assert.ok(b.canPlace(2, 4) && !b.canPlace(2, 5) && !b.canPlace(2, 6));
  assert.deepEqual(b.with(2, 5).conflicts(), [0, 2]);
  assert.ok(Board.parse(solution).isSolved);
  assert.equal(peers[0]!.length, 20);
  const restored = Board.restore(puzzle, c.toCompactString());
  assert.ok(restored.equals(c) && restored.isGiven(0) && !restored.isGiven(2));
  assert.throws(() => Board.restore(puzzle, "6" + puzzle.slice(1)));
});

test("place and erase digits; givens never change", () => {
  let g = Game.create(puzzle).resume(0);
  g = g.place(2, 4, 100);
  assert.equal(g.board.get(2), 4);
  g = g.place(2, 1, 200);
  assert.equal(g.board.get(2), 1);
  g = g.erase(2);
  assert.equal(g.board.get(2), 0);
  assert.equal(g.place(0, 1, 300), g);
  assert.equal(g.erase(0), g);
});

test("notes toggle, and placing a digit clears it from the cell and its peers", () => {
  let g = Game.create(puzzle);
  g = g.toggleNote(2, 4).toggleNote(2, 1).toggleNote(3, 4).toggleNote(80 - 2, 4);
  assert.deepEqual(g.notes.get(2), [1, 4]);
  g = g.place(3, 4, 0);
  assert.ok(g.notes.isEmpty(3));
  assert.deepEqual(g.notes.get(2), [1]); // same row
  assert.deepEqual(g.notes.get(78), [4]); // unrelated cell
  assert.equal(g.toggleNote(3, 2), g); // filled cells take no notes
  g = g.erase(3).erase(2);
  assert.ok(g.notes.isEmpty(2));
});

test("undo restores board and notes; clear all is one undoable step", () => {
  let g = Game.create(puzzle);
  assert.ok(!g.canUndo && !g.canClearAll);
  g = g.place(2, 4, 0).toggleNote(3, 6);
  assert.ok(g.canClearAll);
  const cleared = g.clearAll();
  assert.equal(cleared.board.toCompactString(), puzzle);
  assert.ok(cleared.notes.isBlank && !cleared.canClearAll);
  const back = cleared.undo();
  assert.equal(back.board.get(2), 4);
  assert.deepEqual(back.notes.get(3), [6]);
  assert.ok(back.undo().notes.isEmpty(3));
  assert.equal(back.undo().undo().board.get(2), 0);
});

test("solving completes the game and stops the timer", () => {
  const [g, last] = nearlySolved(Game.create(puzzle).resume(1000));
  assert.ok(!g.isComplete);
  const done = g.place(last, digit(last), 61_000);
  assert.ok(done.isComplete && !done.canUndo && !done.canClearAll);
  assert.equal(done.completedElapsedMs, 60_000);
  assert.equal(done.elapsedMs(999_999), 60_000);
  assert.equal(done.place(last, 1, 70_000), done);
  assert.equal(done.resume(70_000), done);
});

test("timer pauses and resumes", () => {
  let t = ElapsedTimer.NOT_STARTED.resume(100);
  assert.equal(t.elapsedMs(600), 500);
  t = t.pause(600);
  assert.equal(t.elapsedMs(10_000), 500);
  t = t.resume(20_000);
  assert.equal(t.elapsedMs(20_250), 750);
  assert.equal(t.elapsedMs(0), 500); // never negative
  assert.throws(() => ElapsedTimer.paused(-1));
});

test("save and restore", () => {
  let g = Game.create(puzzle).resume(0).place(2, 4, 0).toggleNote(3, 6);
  const saved = g.save(5000);
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), saved);
  const r = Game.restore(saved);
  assert.equal(r.board.toCompactString(), g.board.toCompactString());
  assert.deepEqual(r.notes.get(3), [6]);
  assert.equal(r.elapsedMs(99_999), 5000);
  assert.ok(!r.timer.isRunning && !r.canUndo);

  const [n, last] = nearlySolved(Game.create(puzzle).resume(0));
  const done = Game.restore(n.place(last, digit(last), 42_000).save(0));
  assert.ok(done.isComplete);
  assert.equal(done.completedElapsedMs, 42_000);
  // "completed" only sticks when the board really is solved.
  assert.ok(!Game.restore({ ...saved, completed: true }).isComplete);
});

test("digit counts", () => {
  const counts = Game.create(puzzle).digitCounts();
  assert.equal(counts[0], 51);
  assert.equal(counts.reduce((a, b) => a + b), 81);
});

test("durations", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(-5), "0:00");
  assert.equal(formatDuration(59_999), "0:59");
  assert.equal(formatDuration(61_000), "1:01");
  assert.equal(formatDuration(3_600_000), "1:00:00");
  assert.equal(formatDuration(3_725_000), "1:02:05");
});
