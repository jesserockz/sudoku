// Wording for the variants (Diagonal, Jigsaw, Killer), kept free of the DOM so it can be unit-tested.
import { formatDuration } from "../game/timer.ts";
import { VARIANT_DIAGONAL, VARIANT_JIGSAW, VARIANT_KILLER, VARIANT_STANDARD, variantName } from "../core/layout.ts";
import { DIFFICULTIES } from "../generator/generator.ts";
import { generatorName } from "../generator/versions.ts";

/** The variants the Variants tab offers, in its picker's order. */
export const VARIANT_PICKS: readonly number[] = [VARIANT_DIAGONAL, VARIANT_JIGSAW, VARIANT_KILLER];

/** A series by name: "Classic" or "Graded" for standard Sudoku, "Classic Diagonal" or "Graded Killer" for a variant. */
export function seriesName(generator: number, variant: number): string {
  return variant === VARIANT_STANDARD ? generatorName(generator) : `${generatorName(generator)} ${variantName(variant)}`;
}

/** The variant of the day by name, e.g. "Killer of the day". It never says which generator or difficulty the puzzle has. */
export const variantDayTitle = (variant: number): string => `${variantName(variant)} of the day`;

/** A variant's extra rule in plain words, as the explainer lists it (lower case, after the variant's name). */
export function variantRule(variant: number): string {
  switch (variant) {
    case VARIANT_DIAGONAL: return "the two long diagonals also hold 1 to 9 once each.";
    case VARIANT_JIGSAW: return "the bold shapes replace the 3x3 boxes; each holds 1 to 9 once.";
    case VARIANT_KILLER: return "dashed cages show a sum: the digits in a cage add up to it and don't repeat.";
    default: return "every row, column and 3x3 box holds 1 to 9 once each.";
  }
}

/** A variant's rule as a sentence of its own, for under the Variants tab's heading. */
export const variantRuleSentence = (variant: number): string => {
  const rule = variantRule(variant);
  return rule.charAt(0).toUpperCase() + rule.slice(1);
};

/** The "How Variants works" explainer as data: a title, paragraphs, and each variant's rule. */
export interface VariantsHelp {
  title: string;
  intro: string[];
  rules: { name: string; text: string }[];
  outro: string[];
}

/** What the explainer needs to know: serverless play (no leaderboard), and whether both generators are on (the switch). */
export interface VariantsHelpContext {
  seed: boolean;
  bothGenerators: boolean;
}

export function variantsHelp({ seed, bothGenerators }: VariantsHelpContext): VariantsHelp {
  return {
    title: "How Variants works",
    intro: [
      "Variants are Sudoku with an extra rule. Every row and column still holds 1 to 9 once each, and so does every 3x3 box in Diagonal and Killer. Pick a variant at the top of the tab:",
    ],
    rules: VARIANT_PICKS.map((v) => ({ name: variantName(v), text: variantRule(v) })),
    outro: [
      "Each variant has five difficulties, Easy to Diabolical, and each has its own numbered puzzles starting at #1, so they never run out. Puzzles you've started resume where you left off.",
      bothGenerators
        ? "Variants work with Classic and Graded, and each generator has its own series of every variant: pick one with the switch, as on the Endless tab."
        : "Variants work with Classic and Graded, and each generator has its own series of every variant.",
      seed
        ? "Everyone playing the same seed gets the same puzzle for the same number. History lists your times."
        : "Everyone gets the same puzzle for the same number. Each variant has its own leaderboard, and Stats shows your numbers for each.",
    ],
  };
}

/** What the "Preparing" overlay says while a variant's puzzle is generated: an endless puzzle by series, difficulty and number, or the variant of the day by name alone. */
export function preparingText(ref: { variantDay: true; variant: number } | { generator: number; variant?: number; difficulty: number; number: number }): string {
  if ("variantDay" in ref) return `Preparing ${variantDayTitle(ref.variant)}…`;
  return `Preparing ${seriesName(ref.generator, ref.variant ?? 0)} ${DIFFICULTIES[ref.difficulty - 1]!.name} #${ref.number}…`;
}

/** The variant of the day's row on the Daily tab: what its status line says and which button it gets. */
export interface VariantDayRow {
  text: string;
  /** `scores` is only offered with a server: serverless play has no leaderboard. */
  action: "play" | "resume" | "scores" | null;
}

export function variantDayRow(status: { kind: "new" } | { kind: "in-progress"; elapsedMs: number } | { kind: "done"; elapsedMs: number; synced: boolean }, serverless: boolean): VariantDayRow {
  switch (status.kind) {
    case "new": return { text: "Not started yet", action: "play" };
    case "in-progress": return { text: `In progress · ${formatDuration(status.elapsedMs)}`, action: "resume" };
    case "done": return { text: `Solved in ${formatDuration(status.elapsedMs)}${status.synced ? "" : " · not uploaded yet"}`, action: serverless ? null : "scores" };
  }
}
