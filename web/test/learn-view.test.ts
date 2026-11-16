import assert from "node:assert/strict";
import { test } from "node:test";
import { Layout } from "../src/core/layout.ts";
import { MemoryStore } from "../src/data/store.ts";
import { LESSONS, LEVELS, lessonById, practiceCount } from "../src/learn/lessons.ts";
import { LearnProgress } from "../src/learn/progress.ts";
import type { Step } from "../src/learn/state.ts";
import { type BoardView, cellModels, digitCounts, keyCommand, learnSummary, lessonRow, lessonRows } from "../src/ui/learn-view.ts";

const EMPTY: number[] = new Array<number>(81).fill(0);

const view = (over: Partial<BoardView> = {}): BoardView => ({ given: EMPTY, grid: EMPTY, marks: EMPTY, step: null, result: false, selected: -1, targets: [], layout: Layout.STANDARD, ...over });

const step = (over: Partial<Step> = {}): Step => ({ technique: "pointing", place: null, eliminations: [], marks: [], units: [], reason: [], nudge: "", ...over });

const with_ = (cells: Record<number, number>): number[] => EMPTY.map((_, c) => cells[c] ?? 0);

test("an empty board draws 81 empty cells", () => {
  const cells = cellModels(view());
  assert.equal(cells.length, 81);
  assert.deepEqual(cells[0], { classes: [], text: "", notes: null, label: "Row 1 column 1, empty" });
  assert.equal(cells[80]!.label, "Row 9 column 9, empty");
});

test("givens, entries and candidates are told apart", () => {
  const cells = cellModels(view({ given: with_({ 0: 5 }), grid: with_({ 0: 5, 1: 3 }), marks: with_({ 2: 0b000000101 }) }));
  assert.deepEqual(cells[0], { classes: ["given"], text: "5", notes: null, label: "Row 1 column 1, 5" });
  assert.deepEqual(cells[1], { classes: ["entry"], text: "3", notes: null, label: "Row 1 column 2, 3" });
  assert.equal(cells[2]!.label, "Row 1 column 3, empty, candidates 1 3");
  assert.deepEqual(cells[2]!.notes!.map((n) => n.text), ["1", "", "3", "", "", "", "", "", ""]);
  assert.ok(cells[2]!.notes!.every((n) => n.kind === ""));
});

test("a step highlights its units, its pattern and the candidates that matter", () => {
  const s = step({
    units: [0],
    marks: [{ cell: 2, role: "pattern", digits: [1] }, { cell: 2, role: "pivot" }, { cell: 2, role: "pattern", digits: [3] }, { cell: 20, role: "see" }],
    eliminations: [{ cell: 20, digit: 7 }, { cell: 20, digit: 8 }],
  });
  const marks = with_({ 2: 0b000000111, 20: 0b001000001 });
  const before = cellModels(view({ marks, step: s }));
  assert.deepEqual(before[2]!.classes, ["unit", "hl-pattern", "hl-pivot"]);
  assert.deepEqual(before[2]!.notes!.slice(0, 3).map((n) => n.kind), ["hot", "", "hot"]);
  assert.equal(before[2]!.label, "Row 1 column 3, empty, candidates 1 2 3, part of the pattern, the pivot");
  assert.deepEqual(before[8]!.classes, ["unit"]);
  assert.deepEqual(before[20]!.classes, ["hl-see"]);
  assert.deepEqual(before[20]!.notes!.map((n) => n.kind), ["", "", "", "", "", "", "", "", ""], "nothing is struck before the result shows");
  assert.equal(before[20]!.notes![7]!.text, "");

  // With the result: the removed candidates are struck, even one the position no longer holds.
  const after = cellModels(view({ marks, step: s, result: true }));
  assert.deepEqual(after[20]!.notes!.map((n) => `${n.text}${n.kind}`), ["1", "", "", "", "", "", "7struck", "8struck", ""]);
  assert.equal(after[20]!.label, "Row 3 column 3, empty, candidates 1 7, sees the pattern");
  assert.deepEqual(after[2]!.classes, ["unit", "hl-pattern", "hl-pivot"], "no digit was placed");
});

test("a placed digit is marked once the result shows", () => {
  const s = step({ place: { cell: 4, digit: 9 }, marks: [{ cell: 4, role: "wing" }] });
  const grid = with_({ 4: 9 });
  assert.deepEqual(cellModels(view({ grid, step: s }))[4]!.classes, ["entry", "hl-wing"]);
  const shown = cellModels(view({ grid, step: s, result: true }))[4]!;
  assert.deepEqual(shown.classes, ["entry", "hl-wing", "placed"]);
  assert.equal(shown.label, "Row 1 column 5, 9, a wing, just placed");
  assert.deepEqual(cellModels(view({ grid, result: true }))[4]!.classes, ["entry"], "no step: nothing to mark");
});

test("the colour roles are named", () => {
  const cells = cellModels(view({ step: step({ marks: [{ cell: 0, role: "colourA" }, { cell: 1, role: "colourB" }] }) }));
  assert.equal(cells[0]!.label, "Row 1 column 1, empty, colour A");
  assert.equal(cells[1]!.label, "Row 1 column 2, empty, colour B");
});

test("targets and the selection are drawn", () => {
  const grid = with_({ 0: 4, 40: 4, 80: 4, 1: 6 });
  const cells = cellModels(view({ grid, selected: 0, targets: [1, 2] }));
  assert.deepEqual(cells[0]!.classes, ["entry", "selected"]);
  assert.deepEqual(cells[1]!.classes, ["entry", "target", "peer"]);
  assert.equal(cells[2]!.label, "Row 1 column 3, empty, to fill in");
  assert.deepEqual(cells[40]!.classes, ["entry", "same"], "the same digit elsewhere");
  assert.deepEqual(cells[9]!.classes, ["peer"]);
  assert.deepEqual(cells[50]!.classes, []);
  // An empty selection has no digit to match.
  const empty = cellModels(view({ grid, selected: 2 }));
  assert.deepEqual(empty[2]!.classes, ["selected"]);
  assert.deepEqual(empty[40]!.classes, ["entry"]);
});

test("digitCounts counts each digit and ignores empty cells", () => {
  const counts = digitCounts(with_({ 0: 4, 40: 4, 80: 9 }));
  assert.deepEqual(counts, [0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
});

test("a lesson's row follows its progress", () => {
  const progress = new LearnProgress(new MemoryStore());
  const lesson = lessonById("hiddenSingle")!;
  const total = practiceCount(lesson);
  assert.deepEqual(lessonRow(lesson, progress), { lesson, status: "new", statusText: lesson.summary, action: "Start" });
  progress.markSeen(lesson.id);
  assert.deepEqual(lessonRow(lesson, progress), { lesson, status: "seen", statusText: "Started", action: "Continue" });
  progress.markSolved(lesson.id);
  assert.equal(lessonRow(lesson, progress).statusText, "Started · puzzle solved");
  progress.markDone(lesson.id, 0, false);
  assert.deepEqual(lessonRow(lesson, progress), { lesson, status: "practised", statusText: `Practised 1 of ${total} · puzzle solved`, action: "Continue" });
  for (let i = 0; i < total; i++) progress.markDone(lesson.id, i, true);
  assert.deepEqual(lessonRow(lesson, progress), { lesson, status: "mastered", statusText: "Mastered · puzzle solved", action: "Review" });

  const other = lessonById("pointing")!;
  progress.markDone(other.id, 1, true);
  assert.equal(lessonRow(other, progress).statusText, `Practised 1 of ${practiceCount(other)}`);
  for (let i = 0; i < practiceCount(other); i++) progress.markDone(other.id, i, true);
  assert.equal(lessonRow(other, progress).statusText, "Mastered");
});

test("lessonRows lists a level's lessons in order", () => {
  const progress = new LearnProgress(new MemoryStore());
  const level = LEVELS[0]!;
  assert.deepEqual(lessonRows(level, progress).map((r) => r.lesson.id), level.lessons.map((l) => l.id));
});

test("the summary counts mastered and started lessons", () => {
  const progress = new LearnProgress(new MemoryStore());
  assert.equal(learnSummary(progress), `${LESSONS.length} lessons, from the rules to chains and the variants. Each one has a worked example and positions to practise on.`);
  progress.markSeen("pointing");
  assert.ok(learnSummary(progress).startsWith(`${LESSONS.length} lessons`), "only opened: still the introduction");
  for (let i = 0; i < 4; i++) progress.markDone("fullHouse", i, true);
  assert.equal(learnSummary(progress), `1 of ${LESSONS.length} lessons mastered.`);
  progress.markDone("pointing", 0, false);
  assert.equal(learnSummary(progress), `1 of ${LESSONS.length} lessons mastered, 1 more in progress.`);
  const started = new LearnProgress(new MemoryStore());
  started.markDone("pointing", 0, false);
  assert.equal(learnSummary(started), `0 of ${LESSONS.length} lessons mastered, 1 more in progress.`);
});

test("keys map to commands", () => {
  const key = (k: string, mod: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) =>
    keyCommand({ key: k, altKey: false, ctrlKey: false, metaKey: false, ...mod });
  assert.deepEqual(key("7"), { kind: "digit", digit: 7 });
  assert.equal(key("0"), null);
  assert.deepEqual(key("ArrowUp"), { kind: "move", row: -1, col: 0 });
  assert.deepEqual(key("ArrowDown"), { kind: "move", row: 1, col: 0 });
  assert.deepEqual(key("ArrowLeft"), { kind: "move", row: 0, col: -1 });
  assert.deepEqual(key("ArrowRight"), { kind: "move", row: 0, col: 1 });
  for (const k of ["n", "N"]) assert.deepEqual(key(k), { kind: "mode" });
  for (const k of ["c", "C"]) assert.deepEqual(key(k), { kind: "candidates" });
  for (const k of ["h", "H", "?"]) assert.deepEqual(key(k), { kind: "hint" });
  assert.deepEqual(key("Escape"), { kind: "deselect" });
  assert.equal(key("x"), null);
  assert.equal(key("7", { altKey: true }), null);
  assert.equal(key("7", { ctrlKey: true }), null);
  assert.equal(key("h", { metaKey: true }), null);
});
