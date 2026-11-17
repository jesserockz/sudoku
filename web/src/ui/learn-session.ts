// One visit to a lesson: which part is showing, the exercise in hand, and what
// each tap or key does to it. No DOM here; the Learn screen draws it.
import { CELLS, colOf, index, rowOf } from "../core/geometry.ts";
import type { Drill, Feedback } from "../learn/drill.ts";
import { type DemoFrame, type Lesson, demoFrames, hasPuzzle, nextLesson, practiceCount, practiceDrill, puzzleDrill } from "../learn/lessons.ts";
import type { LearnProgress } from "../learn/progress.ts";
import { layoutOf } from "../learn/state.ts";
import { techniqueById } from "../learn/techniques.ts";
import type { BoardView } from "./learn-view.ts";

/** A lesson's parts: the explanation with its worked example, the practice positions, and a whole puzzle. */
export type Stage = "learn" | "practice" | "puzzle";

/** What a digit does: fills the square, removes that candidate from it, or notes it as one. */
export type Mode = "place" | "remove" | "notes";

/** Where to go once an exercise is finished. */
export type Onward = "position" | "puzzle" | "lesson" | "list";

/** Mistakes a position allows and still counts as done unaided. */
export const CLEAN_MISTAKES = 2;

const NONE: readonly number[] = new Array<number>(CELLS).fill(0);

export class LessonSession {
  readonly lesson: Lesson;
  readonly frames: readonly DemoFrame[];
  stage: Stage = "learn";
  /** The worked example's frame on show. */
  frame = 0;
  /** The practice position on show. */
  position = 0;
  /** The exercise in hand, or `null` in the `learn` stage. */
  drill: Drill | null = null;
  selected = -1;
  readonly #progress: LearnProgress;
  /** In a whole puzzle, whether digits remove candidates instead of filling squares. */
  #removing = false;

  constructor(lesson: Lesson, progress: LearnProgress) {
    this.lesson = lesson;
    this.#progress = progress;
    this.frames = demoFrames(lesson);
    progress.markSeen(lesson.id);
  }

  get stages(): Stage[] {
    return hasPuzzle(this.lesson) ? ["learn", "practice", "puzzle"] : ["learn", "practice"];
  }

  get positions(): number {
    return practiceCount(this.lesson);
  }

  /** The practice positions finished so far, by index. */
  get finished(): readonly number[] {
    return this.#progress.get(this.lesson.id).done;
  }

  /** Switches to a stage. Practice opens on the first position not finished yet. */
  show(stage: Stage): void {
    if (stage === "practice") {
      const done = this.finished;
      const first = Array.from({ length: this.positions }, (_, i) => i).find((i) => !done.includes(i));
      this.openPosition(first ?? 0);
      return;
    }
    const drill = stage === "puzzle" ? puzzleDrill(this.lesson) : null;
    if (stage === "puzzle" && !drill) return;
    this.stage = stage;
    this.#open(drill);
  }

  /** Opens practice position `i` afresh. */
  openPosition(i: number): void {
    this.position = Math.max(0, Math.min(this.positions - 1, i));
    this.stage = "practice";
    this.#open(practiceDrill(this.lesson, this.position));
  }

  /** Starts the exercise in hand again. */
  retry(): void {
    if (this.stage === "practice") this.openPosition(this.position);
    else this.show(this.stage);
  }

  #open(drill: Drill | null): void {
    this.drill = drill;
    this.selected = -1;
    this.#removing = false;
  }

  /** Shows frame `i` of the worked example, kept within its ends. */
  showFrame(i: number): void {
    this.frame = Math.max(0, Math.min(this.frames.length - 1, i));
  }

  get mode(): Mode {
    const drill = this.drill;
    if (drill?.goal.kind === "notes") return "notes";
    if (drill?.goal.kind === "step") return drill.places ? "place" : "remove";
    return this.#removing ? "remove" : "place";
  }

  /** Whether the player can switch between filling squares and removing candidates: only in a whole puzzle. */
  get canSwitchMode(): boolean {
    return this.drill?.goal.kind === "solve" && !this.drill.done;
  }

  switchMode(): void {
    const drill = this.drill;
    if (!drill || !this.canSwitchMode) return;
    this.#removing = !this.#removing;
    if (this.#removing && !drill.showCandidates) drill.toggleCandidates();
  }

  /** Whether the board's candidates can be shown and hidden: wherever digits are placed. */
  get canToggleCandidates(): boolean {
    return this.drill !== null && this.drill.places;
  }

  toggleCandidates(): void {
    const drill = this.drill;
    if (!drill || !this.canToggleCandidates) return;
    drill.toggleCandidates();
    if (!drill.showCandidates) this.#removing = false;
  }

  select(cell: number): void {
    if (this.drill) this.selected = cell === this.selected ? -1 : cell;
  }

  /** Moves the selection a square, wrapping at the edges; starts in the middle when nothing is selected. */
  move(row: number, col: number): void {
    if (!this.drill) return;
    this.selected = this.selected < 0 ? index(4, 4) : index((rowOf(this.selected) + row + 9) % 9, (colOf(this.selected) + col + 9) % 9);
  }

  /** A digit from the keypad or keyboard, for the selected square. */
  digit(digit: number): void {
    const drill = this.drill;
    if (!drill || drill.done) return;
    if (this.selected < 0) {
      drill.feedback = { tone: "hint", text: "Pick a square first, then a digit." };
      return;
    }
    if (this.mode === "place") drill.place(this.selected, digit);
    else drill.eliminate(this.selected, digit);
    this.#record();
  }

  hint(): void {
    if (!this.drill) return;
    this.drill.hint();
    this.#record();
  }

  #record(): void {
    const drill = this.drill!;
    if (!drill.done) return;
    this.selected = -1;
    if (this.stage === "puzzle") this.#progress.markSolved(this.lesson.id);
    else this.#progress.markDone(this.lesson.id, this.position, !drill.revealed && drill.mistakes <= CLEAN_MISTAKES);
  }

  get feedback(): Feedback | null {
    return this.drill?.feedback ?? null;
  }

  /** What the board shows: the worked example's frame, or the exercise. */
  get board(): BoardView | null {
    const drill = this.drill;
    if (drill) {
      return {
        given: drill.start.grid, grid: drill.state.grid, marks: drill.state.grid.map((_, c) => drill.marks(c)),
        step: drill.shown, result: drill.shownResult, selected: this.selected, targets: drill.done ? [] : drill.targetCells,
        layout: layoutOf(drill.state),
      };
    }
    const frame = this.frames[this.frame];
    if (!frame) return null;
    return {
      given: this.frames[0]!.state.grid, grid: frame.state.grid, marks: frame.candidates ? frame.state.cand : NONE,
      step: frame.step, result: frame.result, selected: -1, targets: [], layout: layoutOf(frame.state),
    };
  }

  /** What the player is asked to do, above the board. */
  get task(): string {
    const drill = this.drill;
    if (!drill) return "";
    if (drill.goal.kind === "notes") return "Write every candidate of the highlighted squares: pick a square, then each digit that could go there.";
    if (drill.goal.kind === "solve") return "Solve the whole puzzle. Hint shows the next step whenever you are stuck.";
    const name = techniqueById(this.lesson.technique!).name;
    return drill.places
      ? `Technique: ${name}. Pick the square it fills, then its digit.`
      : `Technique: ${name}. Pick a square, then a candidate the pattern rules out.`;
  }

  /** Where the finished exercise leads. */
  get onward(): Onward {
    if (this.stage === "practice" && this.position + 1 < this.positions) return "position";
    if (this.stage === "practice" && hasPuzzle(this.lesson)) return "puzzle";
    return nextLesson(this.lesson.id) ? "lesson" : "list";
  }

  /** Goes on within the lesson: the next position, or the whole puzzle. */
  advance(): void {
    if (this.onward === "position") this.openPosition(this.position + 1);
    else if (this.onward === "puzzle") this.show("puzzle");
  }
}
