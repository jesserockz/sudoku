import assert from "node:assert/strict";
import { test } from "node:test";
import { CELLS } from "../src/core/geometry.ts";
import { Drill, type Goal, drillOf, whyNot } from "../src/learn/drill.ts";
import { type State, type Step, bit, cellName, digitsOf, has, isSolved, stateOf } from "../src/learn/state.ts";
import { techniqueById } from "../src/learn/techniques.ts";

const cell = (row: number, col: number): number => (row - 1) * 9 + (col - 1);
const digits = (text: string): number[] => Array.from(text, Number);

/** Decodes candidates the way the mined positions store them: two base-32 characters per cell. */
const cands = (text: string): number[] => Array.from({ length: CELLS }, (_, i) => parseInt(text.slice(i * 2, i * 2 + 2), 32));

// Real positions where the first technique that applies is the named one, each with its (unique) solution.
const HS = digits("200638409800904000004201008000340701000780050723510800001427005002193000370865100");
const HS_SOLUTION = digits("215638479837954216964271538598346721146782953723519864681427395452193687379865142");

const PT = digits("008000100130000060007190005001270590000519004000040201659000012010002057000051000");
const PT_SOLUTION = digits("928765143135824769467193825341276598782519634596348271659487312814632957273951486");

const NP = digits("060079000000000370704013000406007102050006947007041060000790000075002480200100700");
const NP_CAND = cands(
  "4l00474q00004i0j4pchc3c35q5i4g0000dp00c2005i00005i8idg00c400ck4k00000k004500474646000000008486008m00004g004k554d4500004o1i0n1l95000014140000009500ccc4005k4o008k9k",
);
const NP_SOLUTION = digits("563479821912568374784213695496857132851326947327941568648795213175632489239184756");

// Here the naked pair has a single candidate to remove.
const NP1 = digits("472689351619345007583712964046907105020064039090008006958001603261003098734896512");
const NP1_SOLUTION = digits("472689351619345287583712964846937125127564839395128476958271643261453798734896512");

// A puzzle that logic solves (its hardest step is an XY-Wing).
const PUZZLE = digits("000030409800900000004201008000040701000080050023500800001007005002190000370865100");
const PUZZLE_SOLUTION = HS_SOLUTION;

const step = (technique: string): Goal => ({ kind: "step", technique });
const SOLVE: Goal = { kind: "solve" };

const emptyCells = (state: State): number[] => state.grid.flatMap((d, i) => (d === 0 ? [i] : []));
const targetsOf = (d: Drill, technique: string): Step[] => techniqueById(technique).find(d.start);

/** Hints until the drill reports done, with a cap so a bug fails rather than hangs. */
function hintToEnd(d: Drill): number {
  let n = 0;
  while (!d.done) {
    assert.ok(++n < 1000, "the drill never finished");
    d.hint();
  }
  return n;
}

// whyNot

test("whyNot names the row, column or box that already holds the digit", () => {
  const grid = new Array<number>(CELLS).fill(0);
  grid[cell(1, 9)] = 4;
  grid[cell(9, 1)] = 5;
  grid[cell(3, 3)] = 6;
  const state = stateOf(grid);
  assert.equal(whyNot(state, cell(1, 1), 4), "There is already a 4 in row 1.");
  assert.equal(whyNot(state, cell(1, 1), 5), "There is already a 5 in column 1.");
  assert.equal(whyNot(state, cell(1, 1), 6), "There is already a 6 in box 1.");
});

test("whyNot: a candidate ruled out otherwise, and one that is simply wrong", () => {
  const grid = new Array<number>(CELLS).fill(0);
  const cand = new Array<number>(CELLS).fill(0x1ff);
  cand[cell(2, 2)] &= ~bit(7);
  const state = stateOf(grid, cand);
  assert.equal(whyNot(state, cell(2, 2), 7), "7 has already been ruled out of R2C2.");
  assert.equal(whyNot(state, cell(2, 2), 8), "R2C2 isn't 8. Don't guess: look for a step you can prove.");
});

// Setup and accessors

test("a placing step drill starts without candidates and says which cells matter", () => {
  const d = drillOf(HS, HS_SOLUTION, step("hiddenSingle"));
  assert.equal(d.places, true);
  assert.equal(d.showCandidates, false);
  assert.equal(d.marks(cell(1, 2)), 0);
  assert.deepEqual(d.targetCells, []);
  assert.equal(d.done, false);
  assert.equal(d.mistakes, 0);
  assert.equal(d.revealed, false);
  assert.equal(d.feedback, null);
  assert.equal(d.shown, null);
  assert.equal(d.shownResult, false);
  assert.equal(d.start, d.state);
  assert.equal(d.solution, HS_SOLUTION);
});

test("an eliminating step drill shows candidates and does not place", () => {
  const d = drillOf(PT, PT_SOLUTION, step("pointing"));
  assert.equal(d.places, false);
  assert.equal(d.showCandidates, true);
  assert.equal(d.marks(cell(1, 1)), d.state.cand[cell(1, 1)]);
  assert.notEqual(d.marks(cell(1, 1)), 0);
});

test("a solve drill places and starts without candidates", () => {
  const d = drillOf(PUZZLE, PUZZLE_SOLUTION, SOLVE);
  assert.equal(d.places, true);
  assert.equal(d.showCandidates, false);
  assert.equal(d.marks(cell(1, 2)), 0);
  d.toggleCandidates();
  assert.equal(d.showCandidates, true);
  assert.equal(d.marks(cell(1, 2)), d.state.cand[cell(1, 2)]);
  d.toggleCandidates();
  assert.equal(d.showCandidates, false);
});

test("drillOf uses the rules' candidates unless it is given some, and the constructor takes a state directly", () => {
  const rules = drillOf(NP1, NP1_SOLUTION, step("nakedPair"));
  assert.deepEqual(rules.state, stateOf(NP1));
  const given = drillOf(NP, NP_SOLUTION, step("nakedPair"), NP_CAND);
  assert.deepEqual(given.state.cand, NP_CAND);
  assert.notEqual(given.state.cand, NP_CAND);
  const direct = new Drill(stateOf(HS), HS_SOLUTION, step("hiddenSingle"));
  assert.equal(direct.places, true);
});

test("toggleCandidates only works where the player may choose", () => {
  const pointing = drillOf(PT, PT_SOLUTION, step("pointing"));
  pointing.toggleCandidates();
  assert.equal(pointing.showCandidates, true, "an eliminating lesson always shows them");
  const hidden = drillOf(HS, HS_SOLUTION, step("hiddenSingle"));
  hidden.toggleCandidates();
  assert.equal(hidden.showCandidates, true);
  hidden.toggleCandidates();
  assert.equal(hidden.showCandidates, false);
  const notes = drillOf(HS, HS_SOLUTION, { kind: "notes", cells: [cell(1, 2)] });
  notes.toggleCandidates();
  assert.equal(notes.showCandidates, false);
});

// Step goal: placing

test("placing the digit of the step finishes the drill", () => {
  const d = drillOf(HS, HS_SOLUTION, step("hiddenSingle"));
  const target = targetsOf(d, "hiddenSingle")[1]!;
  const { cell: at, digit } = target.place!;
  d.place(at, digit);
  assert.equal(d.done, true);
  assert.equal(d.state.grid[at], digit);
  assert.equal(d.mistakes, 0);
  assert.equal(d.revealed, false);
  assert.deepEqual(d.shown, target);
  assert.equal(d.shownResult, true);
  assert.deepEqual(d.feedback, { tone: "good", text: `Yes! ${target.reason.at(-1)}` });
});

test("a finished drill ignores further moves and hints", () => {
  const d = drillOf(HS, HS_SOLUTION, step("hiddenSingle"));
  const { cell: at, digit } = targetsOf(d, "hiddenSingle")[0]!.place!;
  d.place(at, digit);
  const feedback = d.feedback;
  const state = d.state;
  const other = emptyCells(state)[0]!;
  d.place(other, 9);
  d.eliminate(other, 9);
  d.hint();
  assert.equal(d.state, state);
  assert.equal(d.feedback, feedback);
  assert.equal(d.mistakes, 0);
});

test("placing on a filled square does nothing", () => {
  const d = drillOf(HS, HS_SOLUTION, step("hiddenSingle"));
  d.place(0, 7);
  d.eliminate(0, 7);
  assert.equal(d.feedback, null);
  assert.equal(d.mistakes, 0);
});

test("a digit that is right in the end but is not this step gets a nudge, not a mistake", () => {
  const d = drillOf(HS, HS_SOLUTION, step("hiddenSingle"));
  const targetCells = new Set(targetsOf(d, "hiddenSingle").map((t) => t.place!.cell));
  const other = emptyCells(d.state).find((c) => !targetCells.has(c))!;
  d.place(other, HS_SOLUTION[other]!);
  assert.equal(d.mistakes, 0);
  assert.equal(d.done, false);
  assert.deepEqual(d.feedback, {
    tone: "hint",
    text: `${cellName(other)} is ${HS_SOLUTION[other]} in the end, but that isn't the hidden single here. Keep looking.`,
  });
  assert.equal(d.state, d.start);
});

test("a wrong digit costs a mistake and says why", () => {
  const d = drillOf(HS, HS_SOLUTION, step("hiddenSingle"));
  const at = emptyCells(d.state)[0]!;
  const wrong = HS_SOLUTION[at]! % 9 + 1;
  d.place(at, wrong);
  assert.equal(d.mistakes, 1);
  assert.equal(d.feedback!.tone, "bad");
  assert.equal(d.feedback!.text, whyNot(d.state, at, wrong));
  d.place(at, wrong);
  assert.equal(d.mistakes, 2);
  assert.equal(d.done, false);
});

test("placing is refused in a candidate-removing drill, with a pointer to what to do", () => {
  const d = drillOf(PT, PT_SOLUTION, step("pointing"));
  const at = emptyCells(d.state)[0]!;
  d.place(at, PT_SOLUTION[at]!);
  assert.deepEqual(d.feedback, {
    tone: "hint",
    text: "Pointing doesn't place a digit. It removes candidates: pick a square and the candidate to remove.",
  });
  assert.equal(d.mistakes, 0);
  assert.equal(d.state, d.start);
});

test("eliminating in a placing drill is refused once candidates are showing, and ignored before", () => {
  const d = drillOf(HS, HS_SOLUTION, step("hiddenSingle"));
  const at = emptyCells(d.state)[0]!;
  const digit = digitsOf(d.state.cand[at]!)[0]!;
  d.eliminate(at, digit);
  assert.equal(d.feedback, null, "candidates are hidden: nothing to click");
  d.toggleCandidates();
  d.eliminate(at, digit);
  assert.deepEqual(d.feedback, { tone: "hint", text: "This one is about placing a digit: find the hidden single and fill it in." });
  assert.equal(d.mistakes, 0);
  const absent = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((n) => !has(d.state, at, n))!;
  d.feedback = null;
  d.eliminate(at, absent);
  assert.equal(d.feedback, null, "not a candidate: ignored");
});

// Step goal: eliminating

test("eliminating a candidate the solution needs is a mistake", () => {
  const d = drillOf(PT, PT_SOLUTION, step("pointing"));
  const at = emptyCells(d.state)[0]!;
  const digit = PT_SOLUTION[at]!;
  assert.ok(has(d.state, at, digit));
  d.eliminate(at, digit);
  assert.equal(d.mistakes, 1);
  assert.deepEqual(d.feedback, { tone: "bad", text: `${digit} can't be removed from ${cellName(at)}: nothing rules it out.` });
  assert.equal(d.state, d.start);
});

test("eliminating a candidate that goes, but not by this technique, is a mistake", () => {
  const d = drillOf(PT, PT_SOLUTION, step("pointing"));
  const proved = new Set(targetsOf(d, "pointing").flatMap((t) => t.eliminations.map((e) => `${e.cell}:${e.digit}`)));
  let pick: { cell: number; digit: number } | undefined;
  for (const c of emptyCells(d.state)) {
    for (const n of digitsOf(d.state.cand[c]!)) if (PT_SOLUTION[c] !== n && !proved.has(`${c}:${n}`)) pick ??= { cell: c, digit: n };
  }
  const { cell: at, digit } = pick!;
  d.eliminate(at, digit);
  assert.equal(d.mistakes, 1);
  assert.deepEqual(d.feedback, {
    tone: "bad",
    text: `${digit} does leave ${cellName(at)} eventually, but the pointing isn't what proves it.`,
  });
  assert.ok(has(d.state, at, digit));
});

test("removing the candidates of a pattern one by one counts down and then finishes", () => {
  const d = drillOf(PT, PT_SOLUTION, step("pointing"));
  const targets = targetsOf(d, "pointing");
  assert.deepEqual(targets.map((t) => t.eliminations.length), [3, 1, 1]);
  // A candidate only the first (largest) pattern removes.
  const others = new Set(targets.slice(1).flatMap((t) => t.eliminations.map((e) => `${e.cell}:${e.digit}`)));
  const own = targets[0]!.eliminations.filter((e) => !others.has(`${e.cell}:${e.digit}`));
  assert.ok(own.length >= 2);
  d.eliminate(own[0]!.cell, own[0]!.digit);
  assert.equal(d.done, false);
  assert.equal(d.mistakes, 0);
  assert.equal(has(d.state, own[0]!.cell, own[0]!.digit), false);
  assert.deepEqual(d.feedback, {
    tone: "good",
    text: `Yes, ${own[0]!.digit} goes from ${cellName(own[0]!.cell)}. 1 more to remove with this pattern.`,
  });
  // Finish a pattern that needs only one removal.
  const last = targets[1]!.eliminations[0]!;
  d.eliminate(last.cell, last.digit);
  assert.equal(d.done, true);
  assert.deepEqual(d.shown, targets[1]);
  assert.equal(d.shownResult, true);
  assert.deepEqual(d.feedback, { tone: "good", text: `That's the pointing! ${targets[1]!.reason.at(-1)}` });
  assert.equal(d.mistakes, 0);
});

test("the count of removals left follows the pattern closest to done", () => {
  const d = drillOf(NP, NP_SOLUTION, step("nakedPair"), NP_CAND);
  const targets = targetsOf(d, "nakedPair");
  assert.deepEqual(targets.map((t) => t.eliminations.length), [4, 2]);
  const big = targets[0]!;
  const small = new Set(targets[1]!.eliminations.map((e) => `${e.cell}:${e.digit}`));
  const only = big.eliminations.filter((e) => !small.has(`${e.cell}:${e.digit}`));
  d.eliminate(only[0]!.cell, only[0]!.digit);
  assert.match(d.feedback!.text, /2 more to remove/);
  // Removing the whole small pattern finishes with that one.
  for (const e of targets[1]!.eliminations) d.eliminate(e.cell, e.digit);
  assert.equal(d.done, true);
  assert.deepEqual(d.shown, targets[1]);
});

test("a pattern with one removal is done at once", () => {
  const d = drillOf(NP1, NP1_SOLUTION, step("nakedPair"));
  const target = targetsOf(d, "nakedPair")[0]!;
  assert.equal(target.eliminations.length, 1);
  d.eliminate(target.eliminations[0]!.cell, target.eliminations[0]!.digit);
  assert.equal(d.done, true);
  assert.equal(d.state.cand[target.eliminations[0]!.cell]! & bit(target.eliminations[0]!.digit), 0);
});

// Hints for a step goal

test("hints for a placing step: a nudge, then the pattern, then the answer", () => {
  const d = drillOf(HS, HS_SOLUTION, step("hiddenSingle"));
  const target = targetsOf(d, "hiddenSingle")[0]!;
  d.hint();
  assert.deepEqual(d.feedback, { tone: "hint", text: target.nudge });
  assert.equal(d.shown, null);
  assert.equal(d.revealed, false);
  d.hint();
  assert.deepEqual(d.shown, target);
  assert.equal(d.shownResult, false);
  assert.equal(d.showCandidates, false, "a placing step needs no candidates");
  assert.deepEqual(d.feedback, { tone: "hint", text: target.reason.slice(0, -1).join(" ") });
  d.hint();
  assert.equal(d.done, true);
  assert.equal(d.revealed, true);
  assert.deepEqual(d.shown, target);
  assert.equal(d.shownResult, true);
  assert.equal(d.state.grid[target.place!.cell], target.place!.digit);
  assert.deepEqual(d.feedback, { tone: "good", text: `${target.reason.at(-1)} Done for you this time.` });
  assert.equal(d.mistakes, 0);
});

test("a hint with a one-line argument shows that line", () => {
  // The only square with one candidate, a naked single the rules did not leave.
  const grid = new Array<number>(CELLS).fill(0);
  const cand = new Array<number>(CELLS).fill(0x1ff);
  cand[cell(5, 5)] = bit(3);
  const d = drillOf(grid, HS_SOLUTION, step("nakedSingle"), cand);
  d.hint();
  d.hint();
  assert.equal(d.shown!.reason.length, 1);
  assert.deepEqual(d.feedback, { tone: "hint", text: "R5C5 has one candidate left, so it is 3." });
});

test("hints for an eliminating step turn the candidates on and finish by removing them", () => {
  const d = drillOf(PT, PT_SOLUTION, step("pointing"));
  d.showCandidates = false;
  const targets = targetsOf(d, "pointing");
  d.hint();
  assert.equal(d.feedback!.text, targets[1]!.nudge, "the pattern with the fewest removals left is the one hinted");
  d.hint();
  assert.equal(d.showCandidates, true);
  assert.equal(d.shown!.eliminations.length, 1);
  assert.deepEqual(d.shown!.eliminations, targets[1]!.eliminations);
  assert.equal(d.shownResult, false);
  d.showCandidates = false;
  d.hint();
  assert.equal(d.showCandidates, true);
  assert.equal(d.done, true);
  assert.equal(d.revealed, true);
  assert.equal(has(d.state, targets[1]!.eliminations[0]!.cell, targets[1]!.eliminations[0]!.digit), false);
  assert.match(d.feedback!.text, /Done for you this time\.$/);
});

test("hints only ask for what is still left of a pattern", () => {
  const d = drillOf(PT, PT_SOLUTION, step("pointing"));
  const targets = targetsOf(d, "pointing");
  const others = new Set(targets.slice(1).flatMap((t) => t.eliminations.map((e) => `${e.cell}:${e.digit}`)));
  const own = targets[0]!.eliminations.filter((e) => !others.has(`${e.cell}:${e.digit}`));
  // Remove all but one removal of the big pattern, and leave the two small ones alone: the first target is no longer larger.
  for (const e of own.slice(0, -1)) d.eliminate(e.cell, e.digit);
  d.hint();
  d.hint();
  assert.ok(d.shown!.eliminations.length <= 1);
  assert.ok(d.shown!.eliminations.every((e) => has(d.state, e.cell, e.digit)));
});

// Notes

test("a notes drill asks for the candidates of the marked squares", () => {
  const cells = [cell(1, 2), cell(1, 3)];
  const d = drillOf(HS, HS_SOLUTION, { kind: "notes", cells });
  assert.equal(d.places, false);
  assert.deepEqual(d.targetCells, cells);
  assert.equal(d.showCandidates, false);
  assert.equal(d.marks(cells[0]!), 0);
  const first = digitsOf(d.state.cand[cells[0]!]!);
  const total = first.length + digitsOf(d.state.cand[cells[1]!]!).length;
  d.eliminate(cells[0]!, first[0]!);
  assert.equal(d.marks(cells[0]!), bit(first[0]!));
  assert.equal(d.mistakes, 0);
  assert.deepEqual(d.feedback, {
    tone: "good",
    text: `Yes, ${first[0]} is possible in ${cellName(cells[0]!)}. ${total - 1} more to find.`,
  });
  // Clicking it again takes it back.
  d.eliminate(cells[0]!, first[0]!);
  assert.equal(d.marks(cells[0]!), 0);
  assert.equal(d.feedback, null);
});

test("notes: other squares, filled squares and impossible digits", () => {
  const cells = [cell(1, 2)];
  const d = drillOf(HS, HS_SOLUTION, { kind: "notes", cells });
  d.eliminate(cell(1, 3), 1);
  assert.deepEqual(d.feedback, { tone: "hint", text: "Work on the highlighted squares." });
  assert.equal(d.marks(cell(1, 3)), 0);
  d.feedback = null;
  d.eliminate(0, 2);
  assert.equal(d.feedback, null, "a filled square is ignored");
  const impossible = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((n) => !has(d.state, cells[0]!, n))!;
  d.eliminate(cells[0]!, impossible);
  assert.equal(d.mistakes, 1);
  assert.deepEqual(d.feedback, {
    tone: "bad",
    text: `${impossible} isn't a candidate for R1C2. ${whyNot(d.state, cells[0]!, impossible)}`,
  });
  assert.equal(d.marks(cells[0]!), 0);
});

test("notes: placing a digit is refused", () => {
  const d = drillOf(HS, HS_SOLUTION, { kind: "notes", cells: [cell(1, 2)] });
  d.place(cell(1, 2), 1);
  assert.deepEqual(d.feedback, { tone: "hint", text: "No digits to place here: switch to Notes and write the candidates." });
  assert.equal(d.state, d.start);
});

test("notes: writing every candidate finishes the drill", () => {
  const cells = [cell(1, 2), cell(1, 3)];
  const d = drillOf(HS, HS_SOLUTION, { kind: "notes", cells });
  for (const c of cells) for (const n of digitsOf(d.state.cand[c]!)) d.eliminate(c, n);
  assert.equal(d.done, true);
  assert.equal(d.mistakes, 0);
  assert.equal(d.shownResult, true);
  assert.equal(d.shown, null);
  assert.deepEqual(d.feedback, { tone: "good", text: "That's every candidate. Notes like these are what the harder techniques work on." });
});

test("notes: hints explain, then fill in a square at a time", () => {
  const cells = [cell(1, 2), cell(1, 3)];
  const d = drillOf(HS, HS_SOLUTION, { kind: "notes", cells });
  d.hint();
  assert.deepEqual(d.feedback, {
    tone: "hint",
    text: "For each highlighted square, run through 1 to 9: any digit not already in its row, column or box is a candidate.",
  });
  assert.equal(d.revealed, false);
  d.hint();
  assert.equal(d.revealed, true);
  assert.equal(d.notes[cells[0]!], d.state.cand[cells[0]!]);
  assert.equal(d.notes[cells[1]!], 0);
  assert.equal(d.done, false);
  assert.deepEqual(d.feedback, {
    tone: "hint",
    text: `R1C2 can be ${digitsOf(d.state.cand[cells[0]!]!).join(" and ")}. Filled in for you.`,
  });
  d.hint();
  assert.equal(d.notes[cells[1]!], d.state.cand[cells[1]!]);
  assert.equal(d.done, true);
  assert.match(d.feedback!.text, /^R1C3 can be .*\. That's all of them\.$/);
  assert.equal(d.mistakes, 0);
});

test("notes: a hint skips squares the player has already finished", () => {
  const cells = [cell(1, 2), cell(1, 3)];
  const d = drillOf(HS, HS_SOLUTION, { kind: "notes", cells });
  for (const n of digitsOf(d.state.cand[cells[0]!]!)) d.eliminate(cells[0]!, n);
  d.hint();
  d.hint();
  assert.match(d.feedback!.text, /^R1C3 can be /);
  assert.equal(d.done, true);
});

// Solve goal

test("solving: a wrong digit is a mistake, a right one is placed and the rest carries on", () => {
  const d = drillOf(PUZZLE, PUZZLE_SOLUTION, SOLVE);
  const at = emptyCells(d.state)[0]!;
  const wrong = PUZZLE_SOLUTION[at]! % 9 + 1;
  d.place(at, wrong);
  assert.equal(d.mistakes, 1);
  assert.deepEqual(d.feedback, { tone: "bad", text: whyNot(d.state, at, wrong) });
  d.place(at, PUZZLE_SOLUTION[at]!);
  assert.equal(d.state.grid[at], PUZZLE_SOLUTION[at]);
  assert.deepEqual(d.feedback, { tone: "good", text: `Yes, ${cellName(at)} is ${PUZZLE_SOLUTION[at]}.` });
  assert.equal(d.done, false);
  assert.equal(d.state.cand[at], 0);
});

test("solving: placing a digit forgets a hint that was showing", () => {
  const d = drillOf(PUZZLE, PUZZLE_SOLUTION, SOLVE);
  d.hint();
  d.hint();
  assert.notEqual(d.shown, null);
  const at = emptyCells(d.state)[0]!;
  d.place(at, PUZZLE_SOLUTION[at]!);
  assert.equal(d.shown, null);
  assert.equal(d.shownResult, false);
  d.hint();
  assert.equal(d.feedback!.text.startsWith("Look for a "), true, "the hints start over");
});

test("solving: filling in every digit finishes the puzzle", () => {
  const d = drillOf(PUZZLE, PUZZLE_SOLUTION, SOLVE);
  for (const c of emptyCells(d.start)) d.place(c, PUZZLE_SOLUTION[c]!);
  assert.equal(d.done, true);
  assert.equal(isSolved(d.state), true);
  assert.equal(d.mistakes, 0);
  assert.equal(d.revealed, false);
  assert.equal(d.shown, null);
  assert.equal(d.shownResult, true);
  assert.deepEqual(d.feedback, { tone: "good", text: "Solved! Every step was one you could prove." });
});

test("solving: candidates can be struck when they are not the solution", () => {
  const d = drillOf(PUZZLE, PUZZLE_SOLUTION, SOLVE);
  const at = emptyCells(d.state)[0]!;
  const digit = digitsOf(d.state.cand[at]!).find((n) => n !== PUZZLE_SOLUTION[at])!;
  d.eliminate(at, digit);
  assert.equal(d.feedback, null, "hidden candidates cannot be clicked");
  d.toggleCandidates();
  d.hint();
  d.eliminate(at, digit);
  assert.equal(has(d.state, at, digit), false);
  assert.equal(d.feedback, null);
  assert.equal(d.mistakes, 0);
  assert.equal(d.shown, null, "a move resets the hints");
  d.eliminate(at, PUZZLE_SOLUTION[at]!);
  assert.equal(d.mistakes, 1);
  assert.deepEqual(d.feedback, {
    tone: "bad",
    text: `${PUZZLE_SOLUTION[at]} can't be removed from ${cellName(at)}: nothing rules it out.`,
  });
});

test("solving: hints name the technique, show the pattern, then do the step", () => {
  const d = drillOf(PUZZLE, PUZZLE_SOLUTION, SOLVE);
  d.hint();
  assert.equal(d.feedback!.tone, "hint");
  assert.match(d.feedback!.text, /^Look for a [a-z -]+\. /);
  d.hint();
  assert.notEqual(d.shown, null);
  assert.equal(d.shownResult, false);
  const before = d.state;
  d.hint();
  assert.equal(d.revealed, true);
  assert.equal(d.done, false);
  assert.notEqual(d.state, before);
  assert.equal(d.shownResult, true);
  assert.match(d.feedback!.text, /^.+: .+ Done for you\.$/);
  assert.equal(d.mistakes, 0);
});

test("solving by hints alone reaches the solution", () => {
  const d = drillOf(PUZZLE, PUZZLE_SOLUTION, SOLVE);
  hintToEnd(d);
  assert.equal(d.done, true);
  assert.equal(d.revealed, true);
  assert.deepEqual(d.state.grid, PUZZLE_SOLUTION);
  assert.equal(d.shown, null);
  assert.equal(d.shownResult, true);
  assert.match(d.feedback!.text, /That finishes the puzzle\.$/);
  assert.equal(d.mistakes, 0);
});

test("solving: a candidate-only step shows the candidates when hinted", () => {
  const d = drillOf(PUZZLE, PUZZLE_SOLUTION, SOLVE);
  let sawRemoval = false;
  for (let i = 0; i < 1000 && !d.done; i++) {
    d.hint();
    if (d.shown && d.shown.place === null && !d.shownResult) {
      sawRemoval = true;
      assert.equal(d.showCandidates, true);
    }
  }
  assert.equal(sawRemoval, true, "this puzzle needs an XY-Wing, which removes candidates");
});

test("solving beyond the techniques gives one digit and carries on", () => {
  // Nothing on an empty board is provable: the drill reveals a digit rather than leaving the player stuck.
  const d = drillOf(new Array<number>(CELLS).fill(0), PUZZLE_SOLUTION, SOLVE);
  d.hint();
  assert.equal(d.revealed, true);
  assert.equal(d.state.grid[0], PUZZLE_SOLUTION[0]);
  assert.equal(d.done, false);
  assert.equal(d.shown, null);
  assert.deepEqual(d.feedback, {
    tone: "hint",
    text: `This spot needs something beyond these lessons, so here is one digit: R1C1 is ${PUZZLE_SOLUTION[0]}.`,
  });
  d.hint();
  assert.equal(d.state.grid[1], PUZZLE_SOLUTION[1], "the next empty square follows");
});

test("solving beyond the techniques can end the puzzle", () => {
  // One empty square with no candidates left: no technique can name it, so the last digit is given.
  const grid = [...PUZZLE_SOLUTION];
  grid[40] = 0;
  const d = drillOf(grid, PUZZLE_SOLUTION, SOLVE, new Array<number>(CELLS).fill(0));
  d.hint();
  assert.equal(d.done, true);
  assert.equal(d.revealed, true);
  assert.equal(d.state.grid[40], PUZZLE_SOLUTION[40]);
  assert.equal(d.feedback!.tone, "hint");
  assert.match(d.feedback!.text, /beyond these lessons/);
});
