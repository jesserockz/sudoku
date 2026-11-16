import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore } from "../src/data/store.ts";
import { type Lesson, LESSONS, lessonById } from "../src/learn/lessons.ts";
import { LearnProgress } from "../src/learn/progress.ts";
import type { Step } from "../src/learn/state.ts";
import { techniqueById } from "../src/learn/techniques.ts";
import { CLEAN_MISTAKES, LessonSession } from "../src/ui/learn-session.ts";

const lessonOf = (id: string): Lesson => lessonById(id)!;

function open(id: string): { session: LessonSession; progress: LearnProgress } {
  const progress = new LearnProgress(new MemoryStore());
  return { session: new LessonSession(lessonOf(id), progress), progress };
}

/** The answer to the step drill in hand. */
const answer = (session: LessonSession): Step => techniqueById(session.lesson.technique!).find(session.drill!.start)[0]!;

/** Answers the step drill in hand without a mistake. */
function finish(session: LessonSession): void {
  const step = answer(session);
  const moves = step.place ? [step.place] : step.eliminations;
  for (const move of moves) {
    session.select(move.cell);
    session.digit(move.digit);
  }
  assert.equal(session.drill!.done, true);
}

function hintOut(session: LessonSession): void {
  for (let i = 0; i < 2000 && !session.drill!.done; i++) session.hint();
  assert.equal(session.drill!.done, true);
}

test("opening a lesson marks it seen and starts on the explanation", () => {
  const { session, progress } = open("fullHouse");
  assert.equal(progress.get("fullHouse").seen, true);
  assert.equal(session.stage, "learn");
  assert.equal(session.drill, null);
  assert.deepEqual(session.stages, ["learn", "practice"]);
  assert.equal(session.positions, 4);
  assert.deepEqual(session.finished, []);
  assert.equal(session.feedback, null);
  assert.equal(session.task, "");
  assert.equal(session.canSwitchMode, false);
  assert.equal(session.canToggleCandidates, false);
  assert.deepEqual(open("hiddenSingle").session.stages, ["learn", "practice", "puzzle"]);
});

test("the worked example's frames are shown one at a time, within their ends", () => {
  const { session } = open("fullHouse");
  const first = session.board!;
  assert.deepEqual(first.given, session.frames[0]!.state.grid);
  assert.ok(first.marks.every((m) => m === 0), "no candidates before they are taught");
  assert.equal(first.selected, -1);
  assert.deepEqual(first.targets, []);
  session.showFrame(1);
  assert.equal(session.board!.step, session.frames[1]!.step);
  session.showFrame(99);
  assert.equal(session.frame, session.frames.length - 1);
  assert.equal(session.board!.result, session.frames.at(-1)!.result);
  session.showFrame(-3);
  assert.equal(session.frame, 0);

  const candidates = open("pointing").session;
  assert.deepEqual(candidates.board!.marks, candidates.frames[0]!.state.cand);
  assert.equal(open("notes").session.board, null, "a lesson with no worked example has no board to show");
});

test("the keys do nothing on the explanation", () => {
  const { session } = open("fullHouse");
  session.select(3);
  session.move(1, 0);
  session.digit(5);
  session.hint();
  session.switchMode();
  session.toggleCandidates();
  session.advance();
  assert.equal(session.selected, -1);
  assert.equal(session.stage, "learn");
  session.retry();
  assert.equal(session.stage, "learn");
});

test("practice opens on the first position not finished yet", () => {
  const { session, progress } = open("fullHouse");
  progress.markDone("fullHouse", 0, true);
  progress.markDone("fullHouse", 1, false);
  session.show("practice");
  assert.equal(session.stage, "practice");
  assert.equal(session.position, 2);
  assert.ok(session.drill);
  for (const i of [2, 3]) progress.markDone("fullHouse", i, true);
  session.show("practice");
  assert.equal(session.position, 0, "all done: back to the first");
  session.openPosition(99);
  assert.equal(session.position, 3);
  session.openPosition(-1);
  assert.equal(session.position, 0);
  session.show("puzzle");
  assert.equal(session.stage, "practice", "this lesson has no puzzle");
  session.show("learn");
  assert.equal(session.stage, "learn");
  assert.equal(session.drill, null);
});

test("selecting and moving", () => {
  const { session } = open("fullHouse");
  session.show("practice");
  session.select(3);
  assert.equal(session.selected, 3);
  assert.equal(session.board!.selected, 3);
  session.select(3);
  assert.equal(session.selected, -1, "tapping it again lets go");
  session.move(0, 1);
  assert.equal(session.selected, 40, "the first move starts in the middle");
  session.move(-1, 0);
  assert.equal(session.selected, 31);
  session.select(0);
  session.move(-1, -1);
  assert.equal(session.selected, 80, "the edges wrap");
  session.move(1, 1);
  assert.equal(session.selected, 0);
});

test("a placing position: wrong digits explain themselves, the right one finishes it", () => {
  const { session, progress } = open("fullHouse");
  session.show("practice");
  assert.equal(session.mode, "place");
  assert.equal(session.canSwitchMode, false);
  assert.equal(session.canToggleCandidates, true);
  assert.equal(session.task, "Technique: Full house. Pick the square it fills, then its digit.");
  session.digit(5);
  assert.deepEqual(session.feedback, { tone: "hint", text: "Pick a square first, then a digit." });
  const { cell, digit } = answer(session).place!;
  session.select(cell);
  session.digit((digit % 9) + 1);
  assert.equal(session.feedback!.tone, "bad");
  assert.equal(session.drill!.done, false);
  assert.equal(session.selected, cell);
  assert.deepEqual(progress.get("fullHouse").done, []);
  session.digit(digit);
  assert.equal(session.feedback!.tone, "good");
  assert.equal(session.selected, -1);
  assert.deepEqual(progress.get("fullHouse"), { seen: true, done: [0], clean: [0], solved: false });
  assert.deepEqual(session.finished, [0]);
  const state = session.drill!.state;
  session.select(cell);
  session.digit(1);
  assert.equal(session.drill!.state, state, "a finished position takes no more digits");

  assert.equal(session.onward, "position");
  session.advance();
  assert.equal(session.position, 1);
  assert.equal(session.selected, -1);
  assert.equal(session.drill!.done, false);
});

test("too many mistakes, or a revealed answer, is practised but not clean", () => {
  const { session, progress } = open("fullHouse");
  session.show("practice");
  const { cell, digit } = answer(session).place!;
  session.select(cell);
  for (let i = 0; i <= CLEAN_MISTAKES; i++) session.digit((digit % 9) + 1);
  session.digit(digit);
  assert.deepEqual(progress.get("fullHouse").done, [0]);
  assert.deepEqual(progress.get("fullHouse").clean, []);

  session.retry();
  assert.equal(session.position, 0);
  assert.equal(session.drill!.done, false);
  session.advance();
  session.hint();
  assert.equal(session.drill!.done, false, "the first hint only points");
  hintOut(session);
  assert.equal(session.drill!.revealed, true);
  assert.deepEqual(progress.get("fullHouse").done, [0, 1]);
  assert.deepEqual(progress.get("fullHouse").clean, []);
});

test("a candidate position removes candidates", () => {
  const { session, progress } = open("pointing");
  session.show("practice");
  assert.equal(session.mode, "remove");
  assert.equal(session.canToggleCandidates, false);
  session.toggleCandidates();
  assert.equal(session.drill!.showCandidates, true, "the candidates stay on show");
  session.switchMode();
  assert.equal(session.mode, "remove");
  assert.equal(session.task, "Technique: Pointing. Pick a square, then a candidate the pattern rules out.");
  assert.deepEqual(session.board!.marks, session.drill!.state.cand);
  finish(session);
  assert.deepEqual(progress.get("pointing").clean, [0]);
  assert.equal(session.board!.result, true);
});

test("the notes lesson asks for candidates in its highlighted squares", () => {
  const { session } = open("notes");
  session.show("practice");
  assert.equal(session.mode, "notes");
  assert.equal(session.canToggleCandidates, false);
  assert.ok(session.task.startsWith("Write every candidate"));
  assert.ok(session.board!.targets.length > 0);
  hintOut(session);
  assert.deepEqual(session.board!.targets, [], "nothing left to ask about");
});

test("the last position leads to the puzzle, or the next lesson", () => {
  const withPuzzle = open("hiddenSingle").session;
  withPuzzle.openPosition(3);
  assert.equal(withPuzzle.onward, "puzzle");
  withPuzzle.advance();
  assert.equal(withPuzzle.stage, "puzzle");
  assert.equal(withPuzzle.onward, "lesson");
  withPuzzle.advance();
  assert.equal(withPuzzle.stage, "puzzle", "the next lesson is the screen's to open");

  const without = open("fullHouse").session;
  without.openPosition(3);
  assert.equal(without.onward, "lesson");

  const last = open(LESSONS.at(-1)!.id).session;
  last.show("puzzle");
  assert.equal(last.onward, "list");
});

test("a whole puzzle: filling squares, removing candidates, and solving it", () => {
  const { session, progress } = open("hiddenSingle");
  session.show("puzzle");
  const drill = session.drill!;
  assert.equal(session.task, "Solve the whole puzzle. Hint shows the next step whenever you are stuck.");
  assert.equal(session.mode, "place");
  assert.equal(session.canSwitchMode, true);
  assert.equal(session.canToggleCandidates, true);
  assert.equal(drill.showCandidates, false);

  session.switchMode();
  assert.equal(session.mode, "remove");
  assert.equal(drill.showCandidates, true, "removing candidates needs them on show");
  session.switchMode();
  assert.equal(session.mode, "place");
  assert.equal(drill.showCandidates, true);
  session.switchMode();
  assert.equal(session.mode, "remove", "already on show: left alone");
  assert.equal(drill.showCandidates, true);
  session.toggleCandidates();
  assert.equal(drill.showCandidates, false);
  assert.equal(session.mode, "place", "hiding them goes back to filling squares");
  session.toggleCandidates();
  assert.equal(drill.showCandidates, true);
  assert.equal(session.mode, "place");

  // Removing a candidate that has to stay is a mistake.
  session.switchMode();
  const empty = drill.state.grid.indexOf(0);
  session.select(empty);
  session.digit(drill.solution[empty]!);
  assert.equal(session.feedback!.tone, "bad");
  assert.equal(drill.state.grid[empty], 0);

  session.retry();
  assert.equal(session.stage, "puzzle");
  assert.notEqual(session.drill, drill);
  assert.equal(session.mode, "place");
  hintOut(session);
  assert.equal(session.canSwitchMode, false);
  assert.equal(progress.get("hiddenSingle").solved, true);
  assert.deepEqual(progress.get("hiddenSingle").done, []);
});
