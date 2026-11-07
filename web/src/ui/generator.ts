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
