// Wording for the puzzle generator setting, kept free of the DOM so it can be unit-tested.
import { GENERATOR_CLASSIC, GENERATOR_GRADED, generatorName } from "../generator/versions.ts";

/** The three settings the admin card and the seed card offer: one generator, or both. */
export const GENERATOR_CHOICES: readonly { label: string; enabled: readonly number[] }[] = [
  { label: "Classic", enabled: [GENERATOR_CLASSIC] },
  { label: "Graded", enabled: [GENERATOR_GRADED] },
  { label: "Both", enabled: [GENERATOR_CLASSIC, GENERATOR_GRADED] },
];

/** Whether two enabled sets (both ascending, as the server and seed play keep them) are the same. */
export function sameGenerators(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The enabled generators by name, e.g. "Graded" or "Classic and Graded". */
export function generatorsSummary(enabled: readonly number[]): string {
  return enabled.map(generatorName).join(" and ");
}

/** The "Classic and Graded puzzles" explainer as data: a title, paragraphs, and the five Graded levels. */
export interface GeneratorHelp {
  title: string;
  /** Text before the level list: which generators are in use, Classic, then how Graded decides. */
  intro: string[];
  /** The Graded levels, easiest first: the level name and what it takes. */
  levels: { name: string; text: string }[];
  /** Text after the level list. */
  outro: string[];
}

/** What the explainer needs to know: the enabled generators (`null` before a week is loaded), and serverless play. */
export interface GeneratorHelpContext {
  enabled: readonly number[] | null;
  seed: boolean;
}

/**
 * The explainer for the generators. With both enabled it points to the switch. With a server and one enabled,
 * players have no say, so it only says which one is used, with no word of a choice. In serverless play the
 * choice of generators is the player's, so it points to the seed card.
 */
export function generatorHelp({ enabled, seed }: GeneratorHelpContext): GeneratorHelp {
  const both = enabled !== null && enabled.length > 1;
  let lead: string | null = null;
  if (both) {
    lead = "You can play Classic or Graded: pick with the switch on the Daily and Endless tabs.";
  } else if (enabled !== null) {
    lead = `${seed ? "This seed's puzzles" : "Puzzles here"} use ${generatorName(enabled[0]!)}.`;
  }
  let last: string;
  if (seed) {
    last = "You choose the generators for this seed in the seed card: Classic, Graded or both. Each generator has its own Endless series, numbered from #1, with its own progress.";
  } else if (both) {
    last = "Each generator has its own daily puzzles, Endless series, leaderboards and stats, so your times are only compared with others on the same one.";
  } else {
    last = "Endless uses the same generator as the daily puzzles, with its own series numbered from #1.";
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
      last,
    ],
  };
}
