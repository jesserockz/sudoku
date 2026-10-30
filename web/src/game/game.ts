import { Board, EMPTY } from "../core/board.ts";
import { CELLS, peers } from "../core/geometry.ts";
import { Notes } from "./notes.ts";
import type { ReplayEvent } from "./replay.ts";
import { ElapsedTimer } from "./timer.ts";

/** Plain game state for local persistence (the JSON stored per game). */
export interface SavedGame {
  givens: string;
  entries: string;
  notes: number[];
  elapsedMs: number;
  completed: boolean;
  /** The game's replay so far; absent in games saved before replays were recorded. */
  replay?: ReplayEvent[];
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
 *
 * It also carries the game's replay, which the caller appends to with
 * {@link record} (the game itself knows no wall clock). A restored game has
 * lost its undo history, so the first event recorded after a restore is
 * preceded by a `restore` event.
 */
export class Game {
  readonly board: Board;
  readonly notes: Notes;
  readonly timer: ElapsedTimer;
  /** Solve time once complete, else `null`. */
  readonly completedElapsedMs: number | null;
  /** Every recorded action, oldest first. */
  readonly replay: readonly ReplayEvent[];
  readonly #history: readonly Snapshot[];
  /** Restored from storage and nothing recorded since. */
  readonly #restored: boolean;

  private constructor(
    board: Board, notes: Notes, timer: ElapsedTimer, completedElapsedMs: number | null, history: readonly Snapshot[],
    replay: readonly ReplayEvent[], restored: boolean,
  ) {
    this.board = board;
    this.notes = notes;
    this.timer = timer;
    this.completedElapsedMs = completedElapsedMs;
    this.#history = history;
    this.replay = replay;
    this.#restored = restored;
  }

  /** A fresh game with the timer not yet started; call `resume` when play begins. */
  static create(givens: string): Game {
    const board = Board.parse(givens);
    if (board.givenCount === 0) throw new RangeError("puzzle has no givens");
    return new Game(board, Notes.EMPTY, ElapsedTimer.NOT_STARTED, null, [], [], false);
  }

  /** Restores a saved game, paused. */
  static restore(saved: SavedGame): Game {
    const board = Board.restore(saved.givens, saved.entries);
    const notes = Notes.fromMasks(saved.notes);
    const completed = saved.completed && board.isSolved;
    return new Game(
      board, completed ? Notes.EMPTY : notes, ElapsedTimer.paused(saved.elapsedMs), completed ? saved.elapsedMs : null, [],
      saved.replay ?? [], true,
    );
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
    return new Game(last.board, last.notes, this.timer, null, this.#history.slice(0, -1), this.replay, this.#restored);
  }

  pause(nowMs: number): Game {
    return this.isComplete ? this : this.#withTimer(this.timer.pause(nowMs));
  }

  /** Starts or resumes the timer. A complete game stays stopped. */
  resume(nowMs: number): Game {
    return this.isComplete ? this : this.#withTimer(this.timer.resume(nowMs));
  }

  /** Appends `event` to the replay, after a `restore` event (at the same times) if this game was just restored. */
  record(event: ReplayEvent): Game {
    const restore: ReplayEvent[] = this.#restored ? [{ t: event.t, w: event.w, a: "restore" }] : [];
    return new Game(this.board, this.notes, this.timer, this.completedElapsedMs, this.#history, [...this.replay, ...restore, event], false);
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
      replay: this.replay.slice(),
    };
  }

  /** `nowMs` is only needed when the change can solve the board, i.e. a placement. */
  #record(board: Board, notes: Notes, nowMs: number | null): Game {
    if (nowMs !== null && board.isSolved) {
      const elapsed = Math.round(this.timer.elapsedMs(nowMs));
      return new Game(board, Notes.EMPTY, ElapsedTimer.paused(elapsed), elapsed, [], this.replay, this.#restored);
    }
    return new Game(board, notes, this.timer, null, [...this.#history, { board: this.board, notes: this.notes }], this.replay, this.#restored);
  }

  #withTimer(timer: ElapsedTimer): Game {
    return new Game(this.board, this.notes, timer, this.completedElapsedMs, this.#history, this.replay, this.#restored);
  }
}
