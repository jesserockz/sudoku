import { colOf, index, rowOf } from "../core/geometry.ts";
import { formatDuration } from "../game/timer.ts";
import { SudokuBoard, SudokuKeypad } from "./board.ts";
import type { AppController } from "./controller.ts";
import { type Child, Component, h, topBar } from "./dom.ts";
import { shareResultsButton } from "./share.ts";
import { ScreenWakeLock } from "./wake-lock.ts";

/**
 * `<sudoku-play>`: one puzzle being played. The timer runs only while this
 * screen is open and the page is visible, and so does a screen wake lock (the
 * phone stays awake while playing, not while paused or solved). Keyboard: digits, Backspace/Delete/0
 * to erase, arrows to move, N for notes, Escape to deselect, Ctrl/Cmd+Z to undo.
 */
export class PlayScreen extends Component {
  app!: AppController;
  level = 0;
  #selected = -1;
  #notesMode = false;
  #paused = false;
  readonly #board = document.createElement("sudoku-board") as SudokuBoard;
  readonly #keypad = document.createElement("sudoku-keypad") as SudokuKeypad;
  readonly #timer = h("span", { class: "timer" });
  #tick = 0;
  readonly #wakeLock = new ScreenWakeLock();

  constructor() {
    super();
    this.#board.addEventListener("cell-select", (e) => this.#select((e as CustomEvent<number>).detail));
    this.#keypad.addEventListener("digit", (e) => this.#input((e as CustomEvent<number>).detail));
  }

  override connectedCallback(): void {
    this.app.update(this.level, (g) => g.resume(this.app.nowMs()));
    document.addEventListener("visibilitychange", this.#onVisibility);
    window.addEventListener("keydown", this.#onKey);
    this.#tick = window.setInterval(() => this.#showTime(), 250);
    super.connectedCallback();
  }

  disconnectedCallback(): void {
    document.removeEventListener("visibilitychange", this.#onVisibility);
    window.removeEventListener("keydown", this.#onKey);
    clearInterval(this.#tick);
    this.#wakeLock.set(false);
    this.app.update(this.level, (g) => g.pause(this.app.nowMs()));
  }

  get #game() {
    return this.app.games.get(this.level);
  }

  #showTime(): void {
    const game = this.#game;
    if (game) this.#timer.textContent = formatDuration(game.elapsedMs(this.app.nowMs()));
  }

  #select(i: number): void {
    this.#selected = i;
    this.update();
  }

  #pause(): void {
    this.app.update(this.level, (g) => g.pause(this.app.nowMs()));
    if (this.#game?.isComplete === false) this.#paused = true;
    this.update();
  }

  #resume(): void {
    this.#paused = false;
    this.app.update(this.level, (g) => g.resume(this.app.nowMs()));
    this.update();
  }

  #input(digit: number): void {
    const g = this.#game;
    const i = this.#selected;
    if (!g || i < 0 || this.#paused || g.board.isGiven(i)) return;
    this.app.update(this.level, (game) => {
      if (this.#notesMode) return game.toggleNote(i, digit);
      if (game.board.get(i) === digit) return game.erase(i);
      return game.place(i, digit, this.app.nowMs());
    });
  }

  #erase(): void {
    if (this.#selected >= 0 && !this.#paused) this.app.update(this.level, (g) => g.erase(this.#selected));
  }

  #undo(): void {
    if (!this.#paused) this.app.update(this.level, (g) => g.undo());
  }

  #toggleNotes(): void {
    this.#notesMode = !this.#notesMode;
    this.update();
  }

  #move(dRow: number, dCol: number): void {
    const i = this.#selected < 0 ? 40 : this.#selected;
    this.#select(index((rowOf(i) + dRow + 9) % 9, (colOf(i) + dCol + 9) % 9));
  }

  readonly #onVisibility = (): void => {
    if (document.hidden) this.#pause();
  };

  readonly #onKey = (e: KeyboardEvent): void => {
    if (e.altKey) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      this.#undo();
      e.preventDefault();
      return;
    }
    if (e.ctrlKey || e.metaKey) return;
    if (/^[1-9]$/.test(e.key)) this.#input(Number(e.key));
    else if (e.key === "Backspace" || e.key === "Delete" || e.key === "0") this.#erase();
    else if (e.key === "ArrowUp") this.#move(-1, 0);
    else if (e.key === "ArrowDown") this.#move(1, 0);
    else if (e.key === "ArrowLeft") this.#move(0, -1);
    else if (e.key === "ArrowRight") this.#move(0, 1);
    else if (e.key === "n" || e.key === "N") this.#toggleNotes();
    else if (e.key === "Escape") this.#select(-1);
    else return;
    e.preventDefault();
  };

  protected render(): Child {
    const app = this.app;
    const puzzle = app.puzzle(this.level);
    const game = this.#game;
    if (!puzzle || !game) return null;
    const paused = this.#paused && !game.isComplete;
    this.#wakeLock.set(!paused && !game.isComplete);
    this.#board.game = game;
    this.#board.selected = this.#selected;
    this.#showTime();

    let footer: Child;
    if (game.isComplete) {
      footer = h("div", { class: "solved" },
        h("p", { class: "big" }, `Solved in ${formatDuration(game.completedElapsedMs ?? 0)}`),
        h("div", { class: "actions" },
          app.seed
            ? shareResultsButton(() => app.resultsSummary(), true)
            : h("button", { class: "primary", onclick: () => app.openScores(this.level) }, "See scores"),
          h("button", { onclick: () => app.openToday() }, "Today's puzzles"),
        ),
      );
    } else {
      Object.assign(this.#keypad, { counts: game.digitCounts(), disabled: paused, notesMode: this.#notesMode });
      this.#keypad.update();
      footer = [
        h("div", { class: "controls" },
          h("button", { disabled: !game.canUndo || paused, onclick: () => this.#undo() }, "Undo"),
          h("button", { disabled: paused, onclick: () => this.#erase() }, "Erase"),
          h("button", {
            disabled: !game.canClearAll || paused, "aria-label": "Clear board",
            onclick: () => app.update(this.level, (g) => g.clearAll()),
          }, "Clear"),
          h("button", {
            class: this.#notesMode && "active", "aria-pressed": String(this.#notesMode),
            onclick: () => this.#toggleNotes(),
          }, this.#notesMode ? "Notes on" : "Notes off"),
        ),
        this.#keypad,
      ];
    }

    return [
      topBar(puzzle.title, () => app.openToday(),
        !game.isComplete && !paused && h("button", { class: "link", onclick: () => this.#pause() }, "Pause")),
      h("div", { class: "play-head" },
        h("span", { class: "muted" }, `${app.today} · ${puzzle.givenCount} givens`),
        this.#timer,
      ),
      h("div", { class: "board-wrap" },
        this.#board,
        paused && h("div", { class: "paused" },
          h("p", null, "Paused"),
          h("button", { class: "primary", onclick: () => this.#resume() }, "Resume"),
        ),
      ),
      footer,
    ];
  }
}

customElements.define("sudoku-play", PlayScreen);
