import { Board, EMPTY } from "../core/board.ts";
import { CELLS, peers } from "../core/geometry.ts";
import { Notes } from "./notes.ts";
import { ElapsedTimer } from "./timer.ts";

/** Plain game state for local persistence (the JSON stored per game). */
export interface SavedGame {
  givens: string;
  entries: string;
  notes: number[];
  elapsedMs: number;
  completed: boolean;
}

interface Snapshot {
  board: Board;
  notes: Notes;
}

/**
 * One puzzle being played: board, pencil marks, undo history and timer.
 *
 * Immutable: every action returns a new Game (or the same one when nothing
 * changed), so the UI can hold it as state. `place` takes `nowMs` because
 * solving the puzzle stops the timer at that instant. Once complete, the game
 * ignores further moves.
 */
export class Game {
  readonly board: Board;
  readonly notes: Notes;
  readonly timer: ElapsedTimer;
  /** Solve time once complete, else `null`. */
  readonly completedElapsedMs: number | null;
  readonly #history: readonly Snapshot[];

  private constructor(board: Board, notes: Notes, timer: ElapsedTimer, completedElapsedMs: number | null, history: readonly Snapshot[]) {
    this.board = board;
    this.notes = notes;
    this.timer = timer;
    this.completedElapsedMs = completedElapsedMs;
    this.#history = history;
  }

  /** A fresh game with the timer not yet started; call `resume` when play begins. */
  static create(givens: string): Game {
    const board = Board.parse(givens);
    if (board.givenCount === 0) throw new RangeError("puzzle has no givens");
    return new Game(board, Notes.EMPTY, ElapsedTimer.NOT_STARTED, null, []);
  }

  /** Restores a saved game, paused. */
  static restore(saved: SavedGame): Game {
    const board = Board.restore(saved.givens, saved.entries);
    const notes = Notes.fromMasks(saved.notes);
    const completed = saved.completed && board.isSolved;
    return new Game(board, completed ? Notes.EMPTY : notes, ElapsedTimer.paused(saved.elapsedMs), completed ? saved.elapsedMs : null, []);
  }

  get isComplete(): boolean {
    return this.completedElapsedMs !== null;
  }

  get canUndo(): boolean {
    return !this.isComplete && this.#history.length > 0;
  }

  /** Whether there is anything for `clearAll` to remove: a player-entered digit or a note. */
  get canClearAll(): boolean {
    return !this.isComplete && (!this.board.equals(this.board.givensOnly()) || !this.notes.isBlank);
  }

  elapsedMs(nowMs: number): number {
    return this.completedElapsedMs ?? this.timer.elapsedMs(nowMs);
  }

  /**
   * Places `digit` at `i`, clearing that cell's notes and removing `digit`
   * from its peers' notes. Completes the game if the board is now solved.
   */
  place(i: number, digit: number, nowMs: number): Game {
    if (this.isComplete || this.board.isGiven(i) || this.board.get(i) === digit) return this;
    return this.#record(this.board.with(i, digit), this.notes.cleared(i).withoutDigit(peers[i]!, digit), nowMs);
  }

  /** Clears a player-entered digit, or the notes of an empty cell. */
  erase(i: number): Game {
    if (this.isComplete || this.board.isGiven(i)) return this;
    if (this.board.get(i) !== EMPTY) return this.#record(this.board.cleared(i), this.notes, null);
    if (!this.notes.isEmpty(i)) return this.#record(this.board, this.notes.cleared(i), null);
    return this;
  }

  /** Clears every player-entered digit and note as a single undoable step. */
  clearAll(): Game {
    if (!this.canClearAll) return this;
    return this.#record(this.board.givensOnly(), Notes.EMPTY, null);
  }

  /** Toggles a pencil mark. Only empty cells take notes. */
  toggleNote(i: number, digit: number): Game {
    if (this.isComplete || this.board.get(i) !== EMPTY) return this;
    return this.#record(this.board, this.notes.toggled(i, digit), null);
  }

  /** Reverts the last board or note change. The timer is unaffected. */
  undo(): Game {
    if (!this.canUndo) return this;
    const last = this.#history[this.#history.length - 1]!;
    return new Game(last.board, last.notes, this.timer, null, this.#history.slice(0, -1));
  }

  pause(nowMs: number): Game {
    return this.isComplete ? this : this.#withTimer(this.timer.pause(nowMs));
  }

  /** Starts or resumes the timer. A complete game stays stopped. */
  resume(nowMs: number): Game {
    return this.isComplete ? this : this.#withTimer(this.timer.resume(nowMs));
  }

  /** How many of each digit are on the board, indexed by digit (index 0 counts empty cells). */
  digitCounts(): number[] {
    const counts = new Array<number>(10).fill(0);
    for (let i = 0; i < CELLS; i++) counts[this.board.get(i)]!++;
    return counts;
  }

  /** The persistable state (undo history is not kept). */
  save(nowMs: number): SavedGame {
    return {
      givens: this.board.givensString(),
      entries: this.board.toCompactString(),
      notes: this.notes.toMasks(),
      elapsedMs: Math.round(this.elapsedMs(nowMs)),
      completed: this.isComplete,
    };
  }

  /** `nowMs` is only needed when the change can solve the board, i.e. a placement. */
  #record(board: Board, notes: Notes, nowMs: number | null): Game {
    if (nowMs !== null && board.isSolved) {
      const elapsed = Math.round(this.timer.elapsedMs(nowMs));
      return new Game(board, Notes.EMPTY, ElapsedTimer.paused(elapsed), elapsed, []);
    }
    return new Game(board, notes, this.timer, null, [...this.#history, { board: this.board, notes: this.notes }]);
  }

  #withTimer(timer: ElapsedTimer): Game {
    return new Game(this.board, this.notes, timer, this.completedElapsedMs, this.#history);
  }
}
