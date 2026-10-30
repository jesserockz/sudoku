import { CELLS, colOf, peers, rowOf } from "../core/geometry.ts";
import type { Game } from "../game/game.ts";
import { type Child, Component, h } from "./dom.ts";

/**
 * `<sudoku-board>`: the 9x9 grid for a {@link Game}, highlighting the selected
 * cell, its peers, cells with the same digit and conflicts. Set `game` and
 * `selected` (`-1` for none); clicking a cell fires `cell-select` with the
 * cell's index as `detail`.
 */
export class SudokuBoard extends Component {
  #game: Game | null = null;
  #selected = -1;

  constructor() {
    super();
    this.addEventListener("click", (e) => {
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

  protected render(): Child {
    const game = this.#game;
    if (!game) return null;
    const { board, notes } = game;
    const selected = this.#selected;
    const conflicts = new Set(board.conflicts());
    const selectedPeers = new Set(selected >= 0 ? peers[selected] : []);
    const selectedDigit = selected >= 0 ? board.get(selected) : 0;
    const cells: HTMLElement[] = [];
    for (let i = 0; i < CELLS; i++) {
      const r = rowOf(i);
      const c = colOf(i);
      const value = board.get(i);
      cells.push(h("div", {
        class: [
          "cell", `r${r}`, `c${c}`,
          board.isGiven(i) && "given",
          selectedPeers.has(i) && "peer",
          selectedDigit !== 0 && value === selectedDigit && i !== selected && "same",
          i === selected && "selected",
          conflicts.has(i) && "conflict",
        ],
        role: "gridcell",
        "aria-label": `Row ${r + 1} column ${c + 1}, ${value === 0 ? "empty" : value}`,
        "data-index": i,
      },
      value !== 0
        ? String(value)
        : !notes.isEmpty(i) && h("div", { class: "notes" }, [1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => h("span", null, notes.has(i, d) ? String(d) : ""))),
      ));
    }
    return h("div", { class: "board", role: "grid", "aria-label": "Sudoku board" }, cells);
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
