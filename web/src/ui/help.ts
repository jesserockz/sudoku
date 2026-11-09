import { ENDLESS_LABEL, type AppController, type HelpTopic } from "./controller.ts";
import { type Child, h } from "./dom.ts";
import { generatorHelp } from "./generator.ts";

/** The title and paragraphs of each "how it works" explainer. */
function content(app: AppController, topic: HelpTopic): { title: string; body: Child[] } {
  if (topic === "endless") {
    return {
      title: `How ${ENDLESS_LABEL} works`,
      body: [
        h("p", null, "Each difficulty has its own numbered puzzles, starting at #1, and they never run out."),
        h("p", null, app.seed
          ? "Everyone playing the same seed gets the same puzzle for the same number, so you can compare times on any of them. Nothing resets: every solve counts forever."
          : "Everyone gets the same puzzle for the same number, so you can compare times on any of them. Nothing resets: every solve counts forever."),
        h("p", null, "Your next puzzle is the lowest number you haven't solved, but you can open any number with Open a puzzle. Puzzles you've started resume where you left off."),
        app.seed
          ? h("p", null, "History lists your times for every puzzle you've solved, by difficulty.")
          : h("p", null, "The leaderboard shows how many puzzles each player has solved in each difficulty, and the times on any one puzzle."),
      ],
    };
  }
  if (topic === "generators") {
    const help = generatorHelp({ enabled: app.week ? app.generators : null, seed: !!app.seed });
    return {
      title: help.title,
      body: [
        help.intro.map((t) => h("p", null, t)),
        h("ul", { class: "generator-levels" }, help.levels.map((l) => h("li", null, h("strong", null, `${l.name}:`), ` ${l.text}`))),
        help.outro.map((t) => h("p", null, t)),
      ],
    };
  }
  const games = app.puzzles?.length;
  return {
    title: "How Daily works",
    body: [
      h("p", null, `Every day brings ${games ? `${games} new puzzles` : "a new set of puzzles"}, easiest first. Everyone gets the same ones, and a new set starts at midnight.`),
      h("p", null, "The timer only runs while a puzzle is on screen: switching away pauses it. Your game is saved as you go, so you can come back to it any time that day."),
      app.seed
        ? h("p", null, "Everyone playing the same seed gets the same puzzles. Share results to compare times.")
        : h("p", null, "The leaderboard ranks each puzzle by time, and the total for everyone who solves them all. You can look back over the last 8 days."),
    ],
  };
}

/** The explainer dialog over the current screen. Closes with the button, Escape, or a tap outside it. */
export function helpDialog(app: AppController, topic: HelpTopic): HTMLElement {
  const { title, body } = content(app, topic);
  const close = h("button", { class: "primary", onclick: () => app.closeHelp() }, "Got it");
  const overlay = h("div", {
    class: "help-overlay",
    onclick: (e: Event) => {
      if (e.target === overlay) app.closeHelp();
    },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === "Escape") app.closeHelp();
    },
  },
  h("div", { class: "card help", role: "dialog", "aria-modal": "true", "aria-labelledby": "help-title" },
    h("h2", { id: "help-title" }, title),
    body,
    h("div", { class: "actions" }, close),
  ));
  queueMicrotask(() => close.focus());
  return overlay;
}
