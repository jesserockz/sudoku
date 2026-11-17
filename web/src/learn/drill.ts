// One practice exercise: a position, what the player is asked to do in it,
// and a verdict on every move they try. No DOM here; the Learn screen draws it.
import type { Layout } from "../core/layout.ts";
import {
  type CellDigit, type State, type Step, apply, bit, cellName, count, digitsOf, has, isSolved, layoutOf, listOf, stateOf, unitName,
} from "./state.ts";
import { nextStep, techniqueById } from "./techniques.ts";

/**
 * What a drill asks for.
 * - `step`: find one step of a technique (place its digit, or remove its candidates).
 * - `solve`: finish the puzzle, with hints from whatever technique comes next.
 * - `notes`: write the candidates of the marked cells.
 */
export type Goal =
  | { kind: "step"; technique: string }
  | { kind: "solve" }
  | { kind: "notes"; cells: readonly number[] };

/** What the drill says about the last move: `good` and `bad` judge it, `hint` only informs. */
export interface Feedback {
  tone: "good" | "bad" | "hint";
  text: string;
}

const same = (a: CellDigit, b: CellDigit): boolean => a.cell === b.cell && a.digit === b.digit;

/** Why `digit` can't go in `cell`, in a sentence. */
export function whyNot(state: State, cell: number, digit: number): string {
  const layout = layoutOf(state);
  const blocker = layout.peers[cell]!.find((p) => state.grid[p] === digit);
  if (blocker !== undefined) {
    // The first unit (row, column, box or region, diagonal) holding both; failing that, they share a cage.
    const unit = layout.units.findIndex((cells) => cells.includes(cell) && cells.includes(blocker));
    return `There is already a ${digit} in ${unit >= 0 ? unitName(unit, layout) : "the same cage"}.`;
  }
  if (!has(state, cell, digit)) return `${digit} has already been ruled out of ${cellName(cell)}.`;
  return `${cellName(cell)} isn't ${digit}. Don't guess: look for a step you can prove.`;
}

export class Drill {
  readonly goal: Goal;
  readonly start: State;
  readonly solution: readonly number[];
  state: State;
  /** The player's own notes, for a `notes` goal: a mask per cell. */
  notes: number[] = new Array<number>(81).fill(0);
  /** Whether the board shows every cell's candidates. Off for the lessons before notes are taught. */
  showCandidates: boolean;
  feedback: Feedback | null = null;
  /** The step to highlight: a hint's, or the one just completed. */
  shown: Step | null = null;
  /** Whether {@link shown}'s result (its digit, its struck candidates) is drawn too. */
  shownResult = false;
  mistakes = 0;
  /** Set once the drill has done a step for the player. */
  revealed = false;
  done = false;
  #hints = 0;
  /** A `step` goal's answers, as they stood at the start. */
  readonly #targets: Step[];

  constructor(start: State, solution: readonly number[], goal: Goal) {
    this.start = start;
    this.state = start;
    this.solution = solution;
    this.goal = goal;
    this.#targets = goal.kind === "step" ? techniqueById(goal.technique).find(start) : [];
    this.showCandidates = goal.kind === "step" ? !techniqueById(goal.technique).places : false;
  }

  /** Whether moves in this drill place digits (`true`) or work on candidates. */
  get places(): boolean {
    return this.goal.kind === "solve" || (this.goal.kind === "step" && techniqueById(this.goal.technique).places);
  }

  /** The candidates to draw in a cell: the player's notes, the position's, or none. */
  marks(cell: number): number {
    if (this.goal.kind === "notes") return this.notes[cell]!;
    return this.showCandidates ? this.state.cand[cell]! : 0;
  }

  /** The cells a `notes` goal asks about. */
  get targetCells(): readonly number[] {
    return this.goal.kind === "notes" ? this.goal.cells : [];
  }

  #say(tone: Feedback["tone"], text: string): void {
    this.feedback = { tone, text };
  }

  #wrong(text: string): void {
    this.mistakes++;
    this.#say("bad", text);
  }

  #moved(): void {
    this.#hints = 0;
    this.shown = null;
    this.shownResult = false;
  }

  #finish(step: Step | null, text: string): void {
    this.done = true;
    this.shown = step;
    this.shownResult = true;
    this.#say("good", text);
  }

  /** Tries to place `digit` in `cell`. */
  place(cell: number, digit: number): void {
    if (this.done || this.state.grid[cell] !== 0) return;
    const goal = this.goal;
    if (goal.kind === "notes") {
      this.#say("hint", "No digits to place here: switch to Notes and write the candidates.");
      return;
    }
    if (goal.kind === "step") {
      const technique = techniqueById(goal.technique);
      if (!technique.places) {
        this.#say("hint", `${technique.name} doesn't place a digit. It removes candidates: pick a square and the candidate to remove.`);
        return;
      }
      const target = this.#targets.find((t) => same(t.place!, { cell, digit }));
      if (target) {
        this.state = apply(this.state, target);
        this.#finish(target, `Yes! ${target.reason.at(-1)}`);
      } else if (this.solution[cell] === digit) {
        this.#say("hint", `${cellName(cell)} is ${digit} in the end, but that isn't the ${technique.name.toLowerCase()} here. Keep looking.`);
      } else {
        this.#wrong(whyNot(this.state, cell, digit));
      }
      return;
    }
    if (this.solution[cell] !== digit) {
      this.#wrong(whyNot(this.state, cell, digit));
      return;
    }
    this.state = apply(this.state, { place: { cell, digit }, eliminations: [] });
    this.#moved();
    if (isSolved(this.state)) this.#finish(null, "Solved! Every step was one you could prove.");
    else this.#say("good", `Yes, ${cellName(cell)} is ${digit}.`);
  }

  /** Tries to remove the candidate `digit` from `cell` (or, for a `notes` goal, toggles the player's note). */
  eliminate(cell: number, digit: number): void {
    if (this.done || this.state.grid[cell] !== 0) return;
    const goal = this.goal;
    if (goal.kind === "notes") {
      this.#note(goal.cells, cell, digit);
      return;
    }
    if (!this.showCandidates || !has(this.state, cell, digit)) return;
    if (goal.kind === "step" && techniqueById(goal.technique).places) {
      this.#say("hint", `This one is about placing a digit: find the ${techniqueById(goal.technique).name.toLowerCase()} and fill it in.`);
      return;
    }
    if (this.solution[cell] === digit) {
      this.#wrong(`${digit} can't be removed from ${cellName(cell)}: nothing rules it out.`);
      return;
    }
    if (goal.kind === "solve") {
      this.state = apply(this.state, { place: null, eliminations: [{ cell, digit }] });
      this.#moved();
      this.feedback = null;
      return;
    }
    const technique = techniqueById(goal.technique);
    if (!this.#targets.some((t) => t.eliminations.some((e) => same(e, { cell, digit })))) {
      this.#wrong(`${digit} does leave ${cellName(cell)} eventually, but the ${technique.name.toLowerCase()} isn't what proves it.`);
      return;
    }
    this.state = apply(this.state, { place: null, eliminations: [{ cell, digit }] });
    const complete = this.#targets.find((t) => this.#left(t).length === 0);
    if (complete) {
      this.#finish(complete, `That's the ${technique.name.toLowerCase()}! ${complete.reason.at(-1)}`);
      return;
    }
    const left = Math.min(...this.#targets.map((t) => this.#left(t).length));
    this.#say("good", `Yes, ${digit} goes from ${cellName(cell)}. ${left} more to remove with this pattern.`);
  }

  /** The eliminations of a target that are still on the board. */
  #left(target: Step): CellDigit[] {
    return target.eliminations.filter((e) => has(this.state, e.cell, e.digit));
  }

  #note(cells: readonly number[], cell: number, digit: number): void {
    if (!cells.includes(cell)) {
      this.#say("hint", "Work on the highlighted squares.");
      return;
    }
    if (this.notes[cell]! & bit(digit)) {
      this.notes[cell]! &= ~bit(digit);
      this.feedback = null;
      return;
    }
    if (!has(this.state, cell, digit)) {
      this.#wrong(`${digit} isn't a candidate for ${cellName(cell)}. ${whyNot(this.state, cell, digit)}`);
      return;
    }
    this.notes[cell]! |= bit(digit);
    const missing = cells.reduce((n, c) => n + count(this.state.cand[c]! & ~this.notes[c]!), 0);
    if (missing === 0) this.#finish(null, "That's every candidate. Notes like these are what the harder techniques work on.");
    else this.#say("good", `Yes, ${digit} is possible in ${cellName(cell)}. ${missing} more to find.`);
  }

  /** The step a hint is about: the goal's own, or whatever comes next in a solve. */
  #hintStep(): Step | null {
    if (this.goal.kind === "step") {
      const target = this.#targets.reduce((best, t) => (this.#left(t).length < this.#left(best).length ? t : best), this.#targets[0]!);
      return target.place ? target : { ...target, eliminations: this.#left(target) };
    }
    return nextStep(this.state);
  }

  /**
   * A hint, stronger each time it's asked for without a move in between:
   * a nudge, then the pattern and why it works, then the step done for the player.
   */
  hint(): void {
    if (this.done) return;
    if (this.goal.kind === "notes") {
      this.#noteHint(this.goal.cells);
      return;
    }
    const step = this.#hintStep();
    if (!step) {
      // Past what the techniques here can prove: give one digit so the solve can go on.
      const cell = this.state.grid.indexOf(0);
      this.revealed = true;
      this.state = apply(this.state, { place: { cell, digit: this.solution[cell]! }, eliminations: [] });
      this.#moved();
      this.#say("hint", `This spot needs something beyond these lessons, so here is one digit: ${cellName(cell)} is ${this.solution[cell]}.`);
      if (isSolved(this.state)) this.done = true;
      return;
    }
    this.#hints++;
    const name = techniqueById(step.technique).name;
    if (this.#hints === 1) {
      this.#say("hint", this.goal.kind === "solve" ? `Look for a ${name.toLowerCase()}. ${step.nudge}` : step.nudge);
      return;
    }
    if (this.#hints === 2) {
      this.shown = step;
      this.shownResult = false;
      if (step.place === null) this.showCandidates = true;
      this.#say("hint", step.reason.slice(0, -1).join(" ") || step.reason[0]!);
      return;
    }
    this.revealed = true;
    if (step.place === null) this.showCandidates = true;
    this.state = apply(this.state, step);
    this.#hints = 0;
    if (this.goal.kind === "step") {
      this.#finish(step, `${step.reason.at(-1)} Done for you this time.`);
    } else if (isSolved(this.state)) {
      this.#finish(null, `${step.reason.at(-1)} That finishes the puzzle.`);
    } else {
      this.shown = step;
      this.shownResult = true;
      this.#say("hint", `${name}: ${step.reason.at(-1)} Done for you.`);
    }
  }

  #noteHint(cells: readonly number[]): void {
    this.#hints++;
    if (this.#hints === 1) {
      this.#say("hint", "For each highlighted square, run through 1 to 9: any digit not already in its row, column or box is a candidate.");
      return;
    }
    const cell = cells.find((c) => this.notes[c] !== this.state.cand[c])!;
    this.revealed = true;
    this.notes[cell] = this.state.cand[cell]!;
    this.#hints = 1;
    const text = `${cellName(cell)} can be ${listOf(digitsOf(this.state.cand[cell]!))}.`;
    if (cells.every((c) => this.notes[c] === this.state.cand[c])) this.#finish(null, `${text} That's all of them.`);
    else this.#say("hint", `${text} Filled in for you.`);
  }

  /** Shows or hides every cell's candidates, where the goal lets the player choose. */
  toggleCandidates(): void {
    if (this.goal.kind === "notes" || (this.goal.kind === "step" && !this.places)) return;
    this.showCandidates = !this.showCandidates;
  }
}

/** A drill on a position given as digits under `layout` (standard by default), with the rules' candidates unless `cand` is given. */
export function drillOf(grid: readonly number[], solution: readonly number[], goal: Goal, cand?: readonly number[], layout?: Layout): Drill {
  return new Drill(stateOf(grid, cand, layout), solution, goal);
}
