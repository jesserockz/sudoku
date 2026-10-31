import type { AppController } from "./controller.ts";
import { h } from "./dom.ts";
import "./play.ts";
import "./replay-screens.ts";
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
  #banner: HTMLElement | null = null;

  set app(app: AppController) {
    this.#app = app;
    app.addEventListener("change", () => this.#show());
    this.#show();
  }

  #show(): void {
    const app = this.#app;
    if (!app) return;
    this.#showBanner(app);
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
    this.replaceChildren(...(this.#banner ? [this.#banner] : []), next);
    window.scrollTo(0, 0);
  }

  /** Adds the "new version" banner above the screen once an update is ready, leaving the screen element alone. */
  #showBanner(app: AppController): void {
    if (!app.updateAvailable || this.#banner) return;
    this.#banner = h("div", { class: "update-banner", role: "status" },
      h("span", null, "A new version is available"),
      h("button", { class: "primary", onclick: () => app.applyUpdate() }, "Reload"));
    this.prepend(this.#banner);
  }
}

customElements.define("sudoku-app", SudokuApp);
