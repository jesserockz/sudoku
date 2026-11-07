// Wording for the puzzle generator setting, kept free of the DOM so it can be unit-tested.
import type { GeneratorEntry, PendingGenerator } from "../api/models.ts";
import { generatorName } from "../generator/versions.ts";

/** The one-line notice for players while a generator change is pending. */
export function pendingNotice(pending: PendingGenerator): string {
  return `From next week (${pending.fromWeek}), daily puzzles use the ${generatorName(pending.version)} generator.`;
}

/** The admin's pending line, e.g. "Graded from 2026-W46". */
export function pendingLine(pending: PendingGenerator): string {
  return `${generatorName(pending.version)} from ${pending.fromWeek}`;
}

/** One line of the schedule history: the generator and the week it started in (`null`: from the very beginning). */
export function historyLine(entry: GeneratorEntry): string {
  return `${generatorName(entry.version)} ${entry.fromWeek === null ? "from the beginning" : `from ${entry.fromWeek}`}`;
}

/** One line for the About screen: which generator this week's dailies use. */
export function generatorSummary(version: number): string {
  return `${generatorName(version)} (this week)`;
}

/** The "Classic and Graded puzzles" explainer as data: a title, paragraphs, and the five Graded levels. */
export interface GeneratorHelp {
  title: string;
  /** Text before the level list: what is changing (or which generator is in use), Classic, then how Graded decides. */
  intro: string[];
  /** The Graded levels, easiest first: the level name and what it takes. */
  levels: { name: string; text: string }[];
  /** Text after the level list. */
  outro: string[];
}

/** What the explainer needs to know: this week's generator (`null` before a week is loaded), a pending change, and serverless play. */
export interface GeneratorHelpContext {
  current: number | null;
  pending: PendingGenerator | null;
  seed: boolean;
}

/**
 * The explainer for the generator setting. With a server players have no say, so it only explains what the
 * generators are and what is changing; in serverless play the choice is the player's, so it points to it.
 */
export function generatorHelp({ current, pending, seed }: GeneratorHelpContext): GeneratorHelp {
  let lead: string | null = null;
  if (pending && current !== null) {
    lead = `From next week (${pending.fromWeek}), puzzles switch from ${generatorName(current)} to ${generatorName(pending.version)}. Here's the difference.`;
  } else if (current !== null) {
    lead = `${seed ? "This seed's" : "This week's"} puzzles use ${generatorName(current)}.`;
  }
  return {
    title: "Classic and Graded puzzles",
    intro: [
      ...(lead ? [lead] : []),
      "Classic decides difficulty by how many numbers the puzzle starts with. Fewer numbers usually means harder, but not always: some \"Expert\" puzzles turn out easy, and now and then a \"Medium\" one needs a clever trick.",
      "Graded decides difficulty by the kind of thinking a puzzle needs. Before you see a puzzle, the game solves it the way a person would and checks the hardest step it had to take. A puzzle only gets a difficulty if that hardest step matches the level:",
    ],
    levels: [
      { name: "Easy", text: "you can always find a number that has only one place it can go in a row, column or box." },
      { name: "Medium", text: "sometimes you'll need to look at one square and work out that only one number can fit there." },
      { name: "Hard", text: "you'll need notes. For example, \"the 5 in this box has to be in this row,\" or \"these two squares must be a 3 and a 7 between them, so no other square in the row can be 3 or 7.\"" },
      { name: "Expert", text: "you'll need to spot patterns that cover several rows and columns at once." },
      { name: "Diabolical", text: "you'll need short chains of reasoning, like \"if this square is a 4, then that one is a 6, so this other one can't be...\"" },
    ],
    outro: [
      "Every Graded puzzle can be solved by logic alone, without guessing, and puzzles at the same level feel about as hard as each other.",
      seed
        ? "You choose the generator for this seed in the seed card, and a change starts the next week. Each generator has its own Endless series, numbered from #1, with its own progress."
        : "Endless uses the same generator as the daily puzzles. Graded puzzles have their own Endless series, starting at #1, and your Classic progress is kept.",
    ],
  };
}
