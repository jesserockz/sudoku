import type { AppController } from "./controller.ts";
import "./play.ts";
import "./screens.ts";

type ScreenElement = HTMLElement & { app: AppController; level?: number; update(): void };

/**
 * `<sudoku-app>`: shows the screen for the app's phase and screen, and updates
 * it whenever the {@link AppController} changes. A new screen element is made
 * only when the screen itself changes, so screens keep their own state (such
 * as the selected cell) across updates.
 */
export class SudokuApp extends HTMLElement {
  #app: AppController | null = null;
  #key = "";
  #screen: ScreenElement | null = null;

  set app(app: AppController) {
    this.#app = app;
    app.addEventListener("change", () => this.#show());
    this.#show();
  }

  #show(): void {
    const app = this.#app;
    if (!app) return;
    const { phase, screen } = app;
    const [tag, key] = phase.kind !== "ready"
      ? [`sudoku-${phase.kind}`, phase.kind]
      : screen.kind === "play"
        ? ["sudoku-play", `play-${screen.level}`]
        : [`sudoku-${screen.kind}`, screen.kind];
    if (key === this.#key && this.#screen) {
      this.#screen.update();
      return;
    }
    const next = document.createElement(tag) as ScreenElement;
    next.app = app;
    if (screen.kind === "play") next.level = screen.level;
    // Set before swapping: the old screen may change the app as it leaves (e.g. pausing its game).
    this.#key = key;
    this.#screen = next;
    this.replaceChildren(next);
    window.scrollTo(0, 0);
  }
}

customElements.define("sudoku-app", SudokuApp);
