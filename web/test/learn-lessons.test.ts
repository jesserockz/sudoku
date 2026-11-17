import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LESSONS, LEVELS, demoFrames, firstLessonOf, hasPuzzle, isGraded, lessonById, levelOf, nextLesson, notesCells, practiceCount,
  practiceDrill, puzzleDrill,
} from "../src/learn/lessons.ts";
import { POSITIONS } from "../src/learn/positions.ts";
import { basicCandidates, count, parseGrid } from "../src/learn/state.ts";
import { TECHNIQUES, VARIANT_TECHNIQUES } from "../src/learn/techniques.ts";
import { generatorHelp } from "../src/ui/generator.ts";

const lesson = (id: string) => lessonById(id)!;

test("the levels are the Graded difficulties, in order, then the variants", () => {
  assert.deepEqual(LEVELS.map((l) => l.name), [...generatorHelp({ enabled: null, seed: false }).levels.map((l) => l.name), "Variants"]);
  assert.ok(LEVELS.every((l) => l.blurb.length > 0 && l.lessons.length > 0));
});

test("there is a lesson for every technique, plus one on notes", () => {
  assert.deepEqual(LESSONS.map((l) => l.id).filter((id) => id !== "notes"), [...TECHNIQUES, ...VARIANT_TECHNIQUES].map((t) => t.id));
  assert.equal(lesson("notes").technique, null);
  assert.equal(lesson("xWing").technique, "xWing");
  assert.equal(new Set(LESSONS.map((l) => l.title)).size, LESSONS.length);
});

test("every lesson explains itself without em dashes", () => {
  for (const l of LESSONS) {
    assert.ok(l.summary.length > 0 && l.intro.length > 0 && l.spot.length > 0, l.id);
    assert.doesNotMatch([l.title, l.summary, ...l.intro, ...l.spot].join(" "), /[\u2013\u2014]/, l.id);
  }
});

test("lessons are found by id, by level and in order", () => {
  assert.equal(lessonById("nope"), undefined);
  assert.equal(nextLesson("fullHouse")!.id, "crossHatch");
  assert.equal(nextLesson("hiddenSingle")!.id, "notes");
  assert.equal(nextLesson("xyChain")!.id, "diagonalSingle");
  assert.equal(nextLesson("cagePointing"), null);
  assert.equal(levelOf(lesson("notes")).name, "Medium");
  assert.equal(firstLessonOf("Hard")!.id, "pointing");
  assert.equal(firstLessonOf("Impossible"), undefined);
});

test("lessons know whether the grader uses their technique", () => {
  assert.ok(isGraded(lesson("notes")));
  assert.ok(isGraded(lesson("xWing")));
  assert.ok(!isGraded(lesson("jellyfish")));
});

test("a technique lesson practises on its own positions", () => {
  const l = lesson("pointing");
  assert.equal(practiceCount(l), 4);
  const drill = practiceDrill(l, 0);
  assert.deepEqual(drill.goal, { kind: "step", technique: "pointing" });
  assert.deepEqual(drill.state.grid, parseGrid(POSITIONS.pointing![0]!.grid));
  assert.ok(!drill.places && drill.showCandidates);
  assert.throws(() => practiceDrill(l, 4), RangeError);
});

test("a position with candidates removed keeps them in its drill", () => {
  const id = Object.keys(POSITIONS).find((k) => POSITIONS[k]![0]!.cand)!;
  const drill = practiceDrill(lesson(id), 0);
  assert.notDeepEqual(drill.state.cand, basicCandidates(drill.state.grid));
  const plain = practiceDrill(lesson("fullHouse"), 0);
  assert.deepEqual(plain.state.cand, basicCandidates(plain.state.grid));
  assert.ok(plain.places && !plain.showCandidates);
});

test("the notes lesson asks for the candidates of a few squares", () => {
  const l = lesson("notes");
  assert.equal(practiceCount(l), 3);
  const drill = practiceDrill(l, 1);
  assert.equal(drill.goal.kind, "notes");
  const cells = drill.targetCells;
  assert.ok(cells.length > 0 && cells.length <= 3);
  assert.ok(cells.every((c) => drill.state.grid[c] === 0 && count(drill.state.cand[c]!) > 0));
  assert.deepEqual(demoFrames(l), []);
  assert.ok(!hasPuzzle(l));
  assert.equal(puzzleDrill(l), null);
});

test("notes squares come from the emptiest box", () => {
  const grid = new Array<number>(81).fill(1);
  for (const c of [0, 1, 30, 31, 32, 40, 41]) grid[c] = 0;
  assert.deepEqual(notesCells(grid), [30, 31, 32]);
});

test("lessons end in a whole puzzle where there is one", () => {
  assert.ok(!hasPuzzle(lesson("fullHouse")));
  assert.equal(puzzleDrill(lesson("fullHouse")), null);
  assert.ok(hasPuzzle(lesson("xyWing")));
  const drill = puzzleDrill(lesson("xyWing"))!;
  assert.deepEqual(drill.goal, { kind: "solve" });
  assert.ok(drill.places);
});

test("a worked example opens on the position and argues a sentence at a time", () => {
  for (const l of LESSONS.filter((x) => x.technique)) {
    const frames = demoFrames(l);
    assert.ok(frames.length >= 2, l.id);
    const [first, ...rest] = frames;
    assert.equal(first!.step, null);
    assert.match(first!.text, /^Here is a position\. /);
    assert.ok(rest.every((f) => f.step !== null));
    assert.deepEqual(rest.map((f) => f.result), rest.map((_, i) => i === rest.length - 1), l.id);
    assert.ok(rest.every((f, i) => i === 0 || f.text.startsWith(rest[i - 1]!.text)));
    assert.notDeepEqual(frames.at(-1)!.state, first!.state);
    assert.equal(first!.candidates, !["fullHouse", "crossHatch", "hiddenSingle", "nakedSingle", "diagonalSingle", "jigsawSingle", "rule45"].includes(l.id));
  }
});
