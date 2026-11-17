// How the Learn area follows a variant's layout: state, the singles' wording,
// the technique orders, drills, the stored layouts, and the lesson screens.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CELLS } from "../src/core/geometry.ts";
import { type Cage, Layout } from "../src/core/layout.ts";
import { KILLER_TECHNIQUES, TECHNIQUES as GRADER_TECHNIQUES } from "../src/generator/grader.ts";
import { FALLBACK_JIGSAWS } from "../src/generator/variants.ts";
import { MemoryStore } from "../src/data/store.ts";
import { drillOf, whyNot } from "../src/learn/drill.ts";
import { fullHouse, hiddenSingle, nakedSingle } from "../src/learn/finders/singles.ts";
import { lessonById, practiceDrill, puzzleDrill } from "../src/learn/lessons.ts";
import { LearnProgress } from "../src/learn/progress.ts";
import { dataLayout, decodeCages, encodeCages, positionState } from "../src/learn/positions-format.ts";
import {
  ALL, DIAGONAL_NAMES, type State, apply, basicCandidates, bit, layoutOf, parseGrid, peerWords, stateOf, unitName, unitWords, unitsOf,
} from "../src/learn/state.ts";
import { TECHNIQUES, VARIANT_TECHNIQUES, graderStepOf, nextStep, solveByLogic, techniqueById, techniquesIn } from "../src/learn/techniques.ts";
import { VARIANT_POSITIONS, VARIANT_PUZZLES } from "../src/learn/variant-positions.ts";
import { LessonSession } from "../src/ui/learn-session.ts";
import { type BoardView, cellModels } from "../src/ui/learn-view.ts";

const cell = (row: number, col: number): number => (row - 1) * 9 + (col - 1);
const EMPTY: number[] = new Array<number>(CELLS).fill(0);
const SOLUTION = parseGrid("215638479837954216964271538598346721146782953723519864681427395452193687379865142");
/** A Diagonal solution: its diagonals hold 1 to 9 too. */
const DIAG = parseGrid(VARIANT_POSITIONS.diagonalSingle![0]!.solution);
const JIGSAW = Layout.jigsaw(parseGrid(FALLBACK_JIGSAWS[0]!.regions));
/** R1C1 and R2C2 in one cage, the rest in cages of one. */
const KILLER = Layout.killer([{ cells: [0, 10], sum: 5 }, ...Array.from({ length: CELLS }, (_, c) => c).filter((c) => c !== 0 && c !== 10).map((c): Cage => ({ cells: [c], sum: 1 }))]);

const withDigits = (cells: Record<number, number>): number[] => EMPTY.map((_, c) => cells[c] ?? 0);

// State.

test("a state's layout: standard unless it has one", () => {
  assert.equal(layoutOf(stateOf(EMPTY)), Layout.STANDARD);
  assert.equal(layoutOf(stateOf(EMPTY, undefined, Layout.DIAGONAL)), Layout.DIAGONAL);
  assert.equal("layout" in stateOf(EMPTY, undefined, Layout.STANDARD), false, "standard positions keep their plain shape");
  assert.equal("layout" in apply(stateOf(EMPTY), { place: null, eliminations: [] }), false);
});

test("candidates and placements follow the layout's peers", () => {
  const grid = withDigits({ [cell(9, 9)]: 4 });
  assert.equal(basicCandidates(grid)[cell(1, 1)], ALL);
  assert.equal(basicCandidates(grid, Layout.DIAGONAL)[cell(1, 1)], ALL & ~bit(4), "the diagonal sees R9C9");
  const killer = stateOf(EMPTY, undefined, KILLER);
  const placed = apply(killer, { place: { cell: 0, digit: 3 }, eliminations: [] });
  assert.equal(placed.layout, KILLER);
  assert.equal(placed.cand[10]! & bit(3), 0, "the cage-mate loses the digit");
  assert.deepEqual(unitsOf(cell(5, 5), Layout.DIAGONAL), [4, 13, 22, 27, 28]);
  assert.deepEqual(unitsOf(cell(5, 5)), [4, 13, 22]);
});

test("units are named for the layout", () => {
  assert.equal(unitName(20), "box 3");
  assert.equal(unitName(20, JIGSAW), "region 3");
  assert.equal(unitName(27), DIAGONAL_NAMES[0]);
  assert.equal(unitName(28, Layout.DIAGONAL), "the diagonal from the top right");
  assert.equal(unitWords(Layout.STANDARD), "row, column or box");
  assert.equal(unitWords(Layout.DIAGONAL), "row, column, box or diagonal");
  assert.equal(unitWords(JIGSAW), "row, column or region");
  assert.equal(unitWords(KILLER), "row, column or box");
  assert.equal(peerWords(KILLER), "row, column, box or cage");
  assert.equal(peerWords(JIGSAW), "row, column or region");
});

// The singles on a variant.

test("singles use the layout's units and peers, and say so", () => {
  // A full house on the diagonal from the top left.
  // R5C5 is the only gap on either diagonal; its row, column and box have two or three.
  const diag = DIAG.map((d, c) => ([40, 41, 49].includes(c) ? 0 : d));
  const diagonalHouse = fullHouse(stateOf(diag, undefined, Layout.DIAGONAL)).find((s) => s.place!.cell === 40)!;
  assert.deepEqual(diagonalHouse.units, [27]);
  assert.equal(diagonalHouse.reason[0], "The diagonal from the top left has only one empty square: R5C5.");
  assert.equal(diagonalHouse.nudge, "One row, column, box or diagonal has just one empty square left.");
  // A hidden single in a row whose blockers are a cage-mate away.
  const grid = withDigits({ [cell(2, 2)]: 7 });
  const cand = EMPTY.map((_, c) => (c < 9 ? (c === 0 || c === 1 ? ALL & ~bit(7) : ALL) : 0));
  for (let c = 2; c < 8; c++) cand[c]! &= ~bit(7);
  const hidden = hiddenSingle({ grid, cand, layout: KILLER }).find((s) => s.units[0] === 0)!;
  assert.deepEqual(hidden.place, { cell: 8, digit: 7 });
  assert.equal(hidden.reason[1], "Every other empty square of row 1 already has a 7 in its row, column, box or cage, or has had 7 ruled out.");
  assert.ok(hidden.marks.some((m) => m.cell === cell(2, 2) && m.role === "see"));
  // A naked single: on a variant, the squares it sees.
  const lone = DIAG.map((d, c) => (c === 0 ? 0 : d));
  const single = nakedSingle(stateOf(lone, undefined, Layout.DIAGONAL))[0]!;
  assert.deepEqual(single.units, [0, 9, 18, 27]);
  assert.match(single.reason[0]!, /^The squares R1C1 sees \(those sharing its row, column, box or diagonal\) hold (\d, ){6}\d and \d\.$/);
  assert.match(nakedSingle(stateOf(lone))[0]!.reason[0]!, /^R1C1 shares its row, column and box \(box 1\) with/);
});

// Techniques.

test("the variant techniques: found by id, placing or removing, and mapped to the grader", () => {
  assert.deepEqual(VARIANT_TECHNIQUES.map((t) => t.id), ["diagonalSingle", "diagonalLocked", "jigsawSingle", "leftovers", "cageCombination", "rule45", "cagePointing"]);
  assert.deepEqual(VARIANT_TECHNIQUES.filter((t) => t.places).map((t) => t.id), ["diagonalSingle", "jigsawSingle", "rule45"]);
  assert.equal(techniqueById("leftovers"), VARIANT_TECHNIQUES[3]);
  const hidden = GRADER_TECHNIQUES.findIndex((g) => g.name === "hiddenSingle");
  assert.equal(techniqueById("diagonalSingle").grader, hidden);
  assert.equal(techniqueById("jigsawSingle").grader, hidden);
  assert.equal(techniqueById("diagonalLocked").grader, GRADER_TECHNIQUES.findIndex((g) => g.name === "pointing"));
  assert.equal(techniqueById("leftovers").grader, -1);
  for (const id of ["cageCombination", "rule45", "cagePointing"]) assert.equal(KILLER_TECHNIQUES[techniqueById(id).grader]!.name, id);
});

test("graderStepOf: the index the grader's step returns under a layout", () => {
  assert.equal(graderStepOf(techniqueById("pointing"), Layout.STANDARD), 2);
  assert.equal(KILLER_TECHNIQUES[graderStepOf(techniqueById("pointing"), KILLER)]!.name, "pointing");
  assert.equal(graderStepOf(techniqueById("crossHatch"), KILLER), 0);
  assert.equal(graderStepOf(techniqueById("leftovers"), JIGSAW), -1);
  assert.equal(graderStepOf(techniqueById("cageCombination"), Layout.STANDARD), -1);
});

test("each layout has its own order of techniques", () => {
  const ids = (layout: Layout): string[] => techniquesIn(layout).map((t) => t.id);
  assert.equal(techniquesIn(Layout.STANDARD), TECHNIQUES);
  assert.deepEqual(ids(JIGSAW), ["fullHouse", "hiddenSingle", "jigsawSingle", "nakedSingle", "leftovers"]);
  assert.deepEqual(ids(Layout.DIAGONAL).slice(0, 9), ["fullHouse", "crossHatch", "hiddenSingle", "diagonalSingle", "nakedSingle", "pointing", "claiming", "diagonalLocked", "nakedPair"]);
  assert.deepEqual(ids(KILLER).slice(0, 10), ["fullHouse", "crossHatch", "hiddenSingle", "nakedSingle", "cageCombination", "pointing", "claiming", "rule45", "cagePointing", "nakedPair"]);
  for (const layout of [Layout.DIAGONAL, KILLER]) {
    assert.ok(!ids(layout).includes("uniqueRectangle"), "no uniqueness arguments with extra rules");
    assert.equal(ids(layout).at(-1), "xyChain");
  }
  // On a jigsaw, nothing that assumes 3 by 3 boxes.
  const p = VARIANT_POSITIONS.leftovers![0]!;
  assert.equal(nextStep(positionState(p))!.technique, "leftovers");
  assert.ok(solveByLogic(positionState(p)).steps.every((s) => ids(JIGSAW).includes(s.technique)));
});

// Drills.

test("whyNot names the diagonal, the region or the cage that already has the digit", () => {
  const diag = stateOf(withDigits({ [cell(9, 9)]: 4 }), undefined, Layout.DIAGONAL);
  assert.equal(whyNot(diag, 0, 4), "There is already a 4 in the diagonal from the top left.");
  const regions = JIGSAW.regions;
  const mate = Array.from({ length: CELLS }, (_, c) => c).find((c) => c !== 0 && regions[c] === regions[0] && c % 9 !== 0 && c >= 9)!;
  assert.equal(whyNot(stateOf(withDigits({ [mate]: 6 }), undefined, JIGSAW), 0, 6), `There is already a 6 in region ${regions[0]! + 1}.`);
  assert.equal(whyNot(stateOf(withDigits({ 10: 2 }), undefined, KILLER), 0, 2), "There is already a 2 in box 1.");
  const cage = Layout.killer([{ cells: [0, 40], sum: 9 }, ...Array.from({ length: CELLS }, (_, c) => c).filter((c) => c !== 0 && c !== 40).map((c): Cage => ({ cells: [c], sum: 1 }))]);
  assert.equal(whyNot(stateOf(withDigits({ 40: 8 }), undefined, cage), 0, 8), "There is already a 8 in the same cage.");
});

test("drills and lessons carry the layout", () => {
  const drill = drillOf(EMPTY, SOLUTION, { kind: "solve" }, undefined, Layout.DIAGONAL);
  assert.equal(drill.state.layout, Layout.DIAGONAL);
  const practice = practiceDrill(lessonById("cagePointing")!, 0);
  assert.equal(practice.state.layout!.cages.length > 0, true);
  assert.deepEqual(practice.state, positionState(VARIANT_POSITIONS.cagePointing![0]!));
  assert.equal(puzzleDrill(lessonById("leftovers")!)!.state.layout, dataLayout(VARIANT_PUZZLES.leftovers!));
});

// Stored layouts.

test("cages are written as sums and cells", () => {
  const cages: Cage[] = [{ cells: [0, 1, 9], sum: 12 }, { cells: [2], sum: 7 }];
  assert.equal(encodeCages(cages), "12:0.1.9 7:2");
  assert.deepEqual(decodeCages("12:0.1.9 7:2"), cages);
  for (const bad of ["", "12", "12:", "12:0,1", "12:0.1  7:2"]) assert.throws(() => decodeCages(bad), RangeError, bad);
});

test("dataLayout builds each stored layout once", () => {
  assert.equal(dataLayout({}), Layout.STANDARD);
  assert.equal(dataLayout({ diagonal: true }), Layout.DIAGONAL);
  const regions = { regions: FALLBACK_JIGSAWS[1]!.regions };
  const jigsaw = dataLayout(regions);
  assert.equal(jigsaw.variant, JIGSAW.variant);
  assert.deepEqual(jigsaw.regions, parseGrid(regions.regions));
  assert.equal(dataLayout({ ...regions }), jigsaw);
  const cages = { cages: encodeCages(KILLER.cages) };
  const killer = dataLayout(cages);
  assert.deepEqual(killer.cages, KILLER.cages);
  assert.equal(dataLayout({ ...cages }), killer);
});

// The lesson screens.

const view = (over: Partial<BoardView>): BoardView =>
  ({ given: EMPTY, grid: EMPTY, marks: EMPTY, step: null, result: false, selected: -1, targets: [], layout: Layout.STANDARD, ...over });

test("a variant board is drawn with its layout, and highlights follow it", () => {
  const diag = cellModels(view({ layout: Layout.DIAGONAL, selected: 0 }));
  assert.deepEqual(diag[0]!.classes, ["diag", "selected"]);
  assert.ok(diag[80]!.classes.includes("peer"), "the far corner shares the diagonal");
  assert.ok(!cellModels(view({ selected: 0 }))[80]!.classes.includes("peer"));
  const unit = cellModels(view({ layout: Layout.DIAGONAL, step: { technique: "diagonalSingle", place: null, eliminations: [], marks: [], units: [28], reason: [], nudge: "" } }));
  assert.ok(unit[8]!.classes.includes("unit") && !unit[0]!.classes.includes("unit"));
  const killer = cellModels(view({ layout: KILLER }));
  assert.equal(killer[0]!.sum, 5);
  assert.equal(killer[0]!.label, "Row 1 column 1, cage of 2 adding to 5, empty");
  assert.equal("sum" in killer[10]!, false);
  assert.equal(killer[10]!.label, "Row 2 column 2, empty");
  assert.ok(cellModels(view({ layout: JIGSAW })).some((c) => c.classes.includes("jr")));
});

test("a variant lesson's boards carry its layout", () => {
  const session = new LessonSession(lessonById("diagonalLocked")!, new LearnProgress(new MemoryStore()));
  assert.equal(session.board!.layout, Layout.DIAGONAL);
  session.show("practice");
  assert.equal(session.board!.layout, Layout.DIAGONAL);
  const standard = new LessonSession(lessonById("pointing")!, new LearnProgress(new MemoryStore()));
  assert.equal(standard.board!.layout, Layout.STANDARD);
});

test("hints on a variant puzzle use its techniques", () => {
  const drill = puzzleDrill(lessonById("jigsawSingle")!)!;
  drill.hint();
  const allowed = techniquesIn(drill.state.layout!).map((t) => t.name.toLowerCase());
  assert.ok(allowed.some((name) => drill.feedback!.text.toLowerCase().includes(name)));
  const state: State = drill.state;
  assert.equal(state.layout!.variant, JIGSAW.variant);
});
