import type { AppController, PuzzleRef } from "./controller.ts";
import { DIFFICULTIES } from "../generator/generator.ts";
import { h } from "./dom.ts";
import { helpDialog } from "./help.ts";
import "./learn.ts";
import { ADMIN_BANNER, ADMIN_BANNER_COMPACT, PLAYER_BANNER, PLAYER_BANNER_COMPACT } from "./maintenance.ts";
import "./play.ts";
import "./replay-screens.ts";
import "./screens.ts";
import { seriesName } from "./variants.ts";

type ScreenElement = HTMLElement & { app: AppController; ref?: PuzzleRef; lesson?: string; update(): void };

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
  /** The maintenance banner, and what it was built from, so it is rebuilt only when that changes. */
  #maintenance: { key: string; element: HTMLElement } | null = null;
  #help: { topic: string; element: HTMLElement } | null = null;
  #preparing: HTMLElement | null = null;

  set app(app: AppController) {
    this.#app = app;
    app.addEventListener("change", () => this.#show());
    this.#show();
  }

  #show(): void {
    const app = this.#app;
    if (!app) return;
    this.#showBanner(app);
    this.#showMaintenance(app);
    this.#showHelp(app);
    this.#showPreparing(app);
    const { phase, screen } = app;
    const [tag, key] = phase.kind !== "ready"
      ? [`sudoku-${phase.kind}`, phase.kind]
      : screen.kind === "play"
        ? ["sudoku-play", `play-${screen.generator}-${screen.level}`]
        : screen.kind === "endless-play"
          ? ["sudoku-play", `endless-play-${screen.generator}-${screen.variant}-${screen.difficulty}-${screen.number}`]
          : screen.kind === "learn"
            ? ["sudoku-learn", `learn-${screen.lesson}`]
            : [`sudoku-${screen.kind}`, screen.kind];
    if (key === this.#key && this.#screen) {
      this.#screen.update();
      return;
    }
    const next = document.createElement(tag) as ScreenElement;
    next.app = app;
    if (screen.kind === "play") next.ref = screen.level;
    else if (screen.kind === "learn") next.lesson = screen.lesson;
    else if (screen.kind === "endless-play") next.ref = { generator: screen.generator, variant: screen.variant, difficulty: screen.difficulty, number: screen.number };
    // Set before swapping: the old screen may change the app as it leaves (e.g. pausing its game).
    this.#key = key;
    this.#screen = next;
    this.replaceChildren(...(this.#banner ? [this.#banner] : []), next, ...(this.#help ? [this.#help.element] : []), ...(this.#preparing ? [this.#preparing] : []));
    // The new screen replaced the children, the maintenance banner with them: it goes back above the screen.
    if (this.#maintenance) this.prepend(this.#maintenance.element);
    window.scrollTo(0, 0);
  }

  /**
   * Shows the maintenance banner above the screen, leaving the screen element alone. A player sees it while the server is
   * down, unless the Today screen already says so in place of the puzzles; an admin always sees the big reminder while the
   * mode is on. On the play screen, which fills the viewport, both shrink to one line (see `--banner-h` in the stylesheet).
   */
  #showMaintenance(app: AppController): void {
    const ready = app.phase.kind === "ready";
    const admin = ready && app.me?.admin === true && app.maintenance !== null;
    const player = ready && app.serverDown !== null && app.puzzles !== null;
    const compact = app.screen.kind === "play" || app.screen.kind === "endless-play";
    const back = app.backAround;
    const key = admin || player ? JSON.stringify([admin ? "admin" : "player", compact, back, app.screen.kind === "admin"]) : "";
    if (key === (this.#maintenance?.key ?? "")) return;
    this.#maintenance?.element.remove();
    this.#maintenance = null;
    if (key === "") return;
    const element = admin
      ? h("div", { class: ["maintenance-banner", "admin", compact && "compact"], role: "alert" },
        h("div", null,
          h("strong", null, compact ? ADMIN_BANNER_COMPACT : ADMIN_BANNER),
          back && !compact && h("div", { class: "back" }, `Players see: ${back}`)),
        app.screen.kind !== "admin" && h("button", { class: "primary", onclick: () => app.openAdmin() }, compact ? "Admin" : "Switch off in Admin"))
      : h("div", { class: ["maintenance-banner", "player", compact && "compact"], role: "status" },
        h("span", null, compact ? (back ? `Maintenance. ${back}` : PLAYER_BANNER_COMPACT) : PLAYER_BANNER),
        back && !compact && h("div", { class: "back" }, back));
    this.#maintenance = { key, element };
    this.prepend(element);
  }

  /** Shows or removes the "how it works" dialog over the screen, leaving the screen element alone. */
  #showHelp(app: AppController): void {
    const topic = app.phase.kind === "ready" ? app.help : null;
    if (this.#help?.topic === (topic ?? undefined)) return;
    this.#help?.element.remove();
    this.#help = topic ? { topic, element: helpDialog(app, topic) } : null;
    if (this.#help) this.append(this.#help.element);
  }

  /** Shows "Preparing ..." over the screen while a variant's puzzle is generated (see `AppController.preparing`). */
  #showPreparing(app: AppController): void {
    const ref = app.preparing;
    this.#preparing?.remove();
    this.#preparing = ref && h("div", { class: "preparing", role: "status" },
      h("p", null, `Preparing ${seriesName(ref.generator, ref.variant ?? 0)} ${DIFFICULTIES[ref.difficulty - 1]!.name} #${ref.number}…`));
    if (this.#preparing) this.append(this.#preparing);
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
