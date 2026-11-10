import { CELLS, colOf, peers, rowOf } from "../core/geometry.ts";
import { COLOUR_NAMES } from "../game/colours.ts";
import type { Game } from "../game/game.ts";
import { cellLabel, cellView } from "./cell-view.ts";
import { type Child, Component, h } from "./dom.ts";

/**
 * `<sudoku-board>`: the 9x9 grid for a {@link Game}, highlighting the selected
 * cell, its peers, cells with the same digit and conflicts. Set `game` and
 * `selected` (`-1` for none); clicking a cell fires `cell-select` with the
 * cell's index as `detail`.
 *
 * The admin replay viewer shows the same board read-only: set `readOnly`
 * (no `cell-select`, no pointer cursor), `hideDigits` (see {@link cellView})
 * and `changed` (the cell the last action changed, `-1` for none).
 */
export class SudokuBoard extends Component {
  #game: Game | null = null;
  #selected = -1;
  #readOnly = false;
  #hideDigits = false;
  #changed = -1;

  constructor() {
    super();
    this.addEventListener("click", (e) => {
      if (this.#readOnly) return;
      const cell = (e.target as Element).closest<HTMLElement>("[data-index]");
      if (cell) this.dispatchEvent(new CustomEvent("cell-select", { detail: Number(cell.dataset.index), bubbles: true }));
    });
  }

  set game(game: Game) {
    this.#game = game;
    if (this.isConnected) this.update();
  }

  set selected(index: number) {
    this.#selected = index;
    if (this.isConnected) this.update();
  }

  set readOnly(readOnly: boolean) {
    this.#readOnly = readOnly;
    this.classList.toggle("read-only", readOnly);
  }

  set hideDigits(hide: boolean) {
    this.#hideDigits = hide;
    if (this.isConnected) this.update();
  }

  set changed(index: number) {
    this.#changed = index;
    if (this.isConnected) this.update();
  }

  protected render(): Child {
    const game = this.#game;
    if (!game) return null;
    const { board } = game;
    const selected = this.#selected;
    const conflicts = new Set(board.conflicts());
    const selectedPeers = new Set(selected >= 0 ? peers[selected] : []);
    const selectedDigit = selected >= 0 ? board.get(selected) : 0;
    const cells: HTMLElement[] = [];
    for (let i = 0; i < CELLS; i++) {
      const r = rowOf(i);
      const c = colOf(i);
      const value = board.get(i);
      const view = cellView(game, i, this.#hideDigits);
      const colour = game.colours.get(i);
      cells.push(h("div", {
        class: [
          "cell", `r${r}`, `c${c}`,
          board.isGiven(i) && "given",
          selectedPeers.has(i) && "peer",
          selectedDigit !== 0 && value === selectedDigit && i !== selected && "same",
          i === selected && "selected",
          conflicts.has(i) && "conflict",
          i === this.#changed && "changed",
          colour !== 0 && `colour-${colour}`,
        ],
        role: "gridcell",
        "aria-label": `Row ${r + 1} column ${c + 1}, ${cellLabel(view)}${colour !== 0 ? `, ${COLOUR_NAMES[colour]}` : ""}`,
        "data-index": i,
      },
      view.kind === "notes" ? h("div", { class: "notes" }, view.marks.map((m) => h("span", null, m))) : view.text,
      ));
    }
    return h("div", { class: ["board", game.isComplete && "solved"], role: "grid", "aria-label": "Sudoku board" }, cells);
  }
}

/**
 * `<sudoku-keypad>`: digit buttons 1-9, each showing how many are left to
 * place. Set `counts` (from `Game.digitCounts()`), `disabled` and `notesMode`
 * (digits stay usable in notes mode even when all nine are placed). Fires
 * `digit` with the digit as `detail`.
 */
export class SudokuKeypad extends Component {
  counts: number[] = new Array(10).fill(0);
  disabled = false;
  notesMode = false;

  protected render(): Child {
    return h("div", { class: "keypad" }, [1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => {
      const left = 9 - this.counts[d]!;
      return h("button", {
        disabled: this.disabled || (left <= 0 && !this.notesMode),
        "aria-label": `${d}, ${left} left`,
        onclick: () => this.dispatchEvent(new CustomEvent("digit", { detail: d, bubbles: true })),
      }, String(d), h("span", { class: "left" }, left > 0 ? String(left) : ""));
    }));
  }
}

customElements.define("sudoku-board", SudokuBoard);
customElements.define("sudoku-keypad", SudokuKeypad);
