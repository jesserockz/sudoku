import { Board, EMPTY } from "../core/board.ts";
import { CELLS } from "../core/geometry.ts";
import { Layout } from "../core/layout.ts";
import { COLOUR_COUNT, Colours, nextColour } from "./colours.ts";
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
  /**
   * The colour pens' cells (see {@link Colours}); absent when none are painted
   * and in games saved before colours existed.
   */
  colours?: string;
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
 *
 * A game follows its puzzle's {@link Layout}: a variant's extra units and
 * cages count for clearing notes, and for when the puzzle is solved.
 */
export class Game {
  readonly board: Board;
  readonly notes: Notes;
  /** Colour pen marks: a player's aid, kept with the game in progress but not undoable or submitted as a result; it is logged in the replay. */
  readonly colours: Colours;
  readonly timer: ElapsedTimer;
  /** Solve time once complete, else `null`. */
  readonly completedElapsedMs: number | null;
  /** Every recorded action, oldest first. */
  readonly replay: readonly ReplayEvent[];
  /** The puzzle's rules: standard Sudoku, or a variant's units and cages. */
  readonly layout: Layout;
  readonly #history: readonly Snapshot[];
  /** Restored from storage and nothing recorded since. */
  readonly #restored: boolean;

  private constructor(
    board: Board, notes: Notes, colours: Colours, timer: ElapsedTimer, completedElapsedMs: number | null, history: readonly Snapshot[],
    replay: readonly ReplayEvent[], restored: boolean, layout: Layout,
  ) {
    this.board = board;
    this.notes = notes;
    this.colours = colours;
    this.timer = timer;
    this.completedElapsedMs = completedElapsedMs;
    this.#history = history;
    this.replay = replay;
    this.#restored = restored;
    this.layout = layout;
  }

  /** A fresh game with the timer not yet started; call `resume` when play begins. */
  static create(givens: string, layout: Layout = Layout.STANDARD): Game {
    const board = Board.parse(givens);
    if (board.givenCount === 0) throw new RangeError("puzzle has no givens");
    return new Game(board, Notes.EMPTY, Colours.EMPTY, ElapsedTimer.NOT_STARTED, null, [], [], false, layout);
  }

  /** Restores a saved game, paused. `layout` is its puzzle's (a saved game doesn't keep it). */
  static restore(saved: SavedGame, layout: Layout = Layout.STANDARD): Game {
    const board = Board.restore(saved.givens, saved.entries);
    const notes = Notes.fromMasks(saved.notes);
    const completed = saved.completed && board.solvedUnder(layout);
    return new Game(
      board, completed ? Notes.EMPTY : notes, completed ? Colours.EMPTY : Colours.parse(saved.colours), ElapsedTimer.paused(saved.elapsedMs), completed ? saved.elapsedMs : null, [],
      saved.replay ?? [], true, layout,
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
    return this.#record(this.board.with(i, digit), this.notes.cleared(i).withoutDigit(this.layout.peers[i]!, digit), nowMs);
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
    return this.#record(this.board.givensOnly(), Notes.EMPTY, null).#withColours(Colours.EMPTY);
  }

  /** Whether any cell has a colour. */
  get hasColours(): boolean {
    return !this.colours.isBlank;
  }

  /** Cycles a cell's colour: none, colour A, colour B, none. Givens and a finished game can't be coloured. Not an undoable step. */
  cycleColour(i: number): Game {
    return this.setColour(i, nextColour(this.colours.get(i)));
  }

  /** Sets a cell's colour (0 for none, else 1 or 2, as a replay's `colour` event says). Givens and a finished game can't be coloured. */
  setColour(i: number, colour: number): Game {
    if (this.isComplete || this.board.isGiven(i) || !Number.isInteger(colour) || colour < 0 || colour > COLOUR_COUNT) return this;
    const colours = this.colours.with(i, colour);
    return colours === this.colours ? this : this.#withColours(colours);
  }

  /** Removes every colour. */
  clearColours(): Game {
    return this.hasColours ? this.#withColours(Colours.EMPTY) : this;
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
    return new Game(last.board, last.notes, this.colours, this.timer, null, this.#history.slice(0, -1), this.replay, this.#restored, this.layout);
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
    return new Game(this.board, this.notes, this.colours, this.timer, this.completedElapsedMs, this.#history, [...this.replay, ...restore, event], false, this.layout);
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
      ...(this.hasColours ? { colours: this.colours.toString() } : {}),
    };
  }

  /** `nowMs` is only needed when the change can solve the board, i.e. a placement. */
  #record(board: Board, notes: Notes, nowMs: number | null): Game {
    if (nowMs !== null && board.solvedUnder(this.layout)) {
      const elapsed = Math.round(this.timer.elapsedMs(nowMs));
      return new Game(board, Notes.EMPTY, Colours.EMPTY, ElapsedTimer.paused(elapsed), elapsed, [], this.replay, this.#restored, this.layout);
    }
    return new Game(board, notes, this.colours, this.timer, null, [...this.#history, { board: this.board, notes: this.notes }], this.replay, this.#restored, this.layout);
  }

  #withColours(colours: Colours): Game {
    return new Game(this.board, this.notes, colours, this.timer, this.completedElapsedMs, this.#history, this.replay, this.#restored, this.layout);
  }

  #withTimer(timer: ElapsedTimer): Game {
    return new Game(this.board, this.notes, this.colours, timer, this.completedElapsedMs, this.#history, this.replay, this.#restored, this.layout);
  }
}
