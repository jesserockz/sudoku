import type { Week } from "../api/models.ts";
import { dayOfWeek } from "../game/calendar.ts";
import type { Game, SavedGame } from "../game/game.ts";
import { type DailyVariant, generateDailyVariant } from "../generator/variants.ts";
import { parseWeekSeed } from "../generator/week-seed.ts";

/** A solved variant of the day. `synced` is false while its result waits in the offline queue. */
export interface VariantDaySolved {
  elapsedMs: number;
  synced: boolean;
}

/**
 * What the controller needs from whichever repository the variant of the day belongs to: the server's
 * {@link SudokuRepository} or serverless play's `SeedRepository`. The puzzle comes from the week's seed and the day (so
 * both generate it locally), and games and results are kept per date.
 */
export interface VariantDaySource {
  /** The variant of the day of `date`, which is in `week`. Generating it can take a moment. */
  variantDay(week: Week, date: string): DailyVariant;
  /** The saved game of `date`, if it still matches `puzzle`. */
  loadVariantDayGame(date: string, puzzle: DailyVariant): Game | null;
  /** The saved game of `date` as it was stored, without the puzzle (so without generating it). */
  variantDaySaved(date: string): SavedGame | null;
  saveVariantDayGame(date: string, game: Game, nowMs: number): void;
  /** Records a just-finished variant of the day, of `variant`. */
  completeVariantDay(date: string, variant: number, game: Game): Promise<unknown>;
  /** `date`'s solved variant of the day: the server's record, then the offline queue. */
  variantDaySolved(date: string): VariantDaySolved | null;
}

/** How many generated variants of the day {@link VariantDayCache} keeps: the screens ask for the same one repeatedly. */
export const VARIANT_DAY_CACHE_SIZE = 4;

/** Remembers the variants of the day generated last, since a Graded Killer can take a good while to generate. */
export class VariantDayCache {
  readonly #cached = new Map<string, DailyVariant>();

  /** The variant of the day for the 16-hex-character week `seed` on `date`. */
  get(seed: string, date: string): DailyVariant {
    const day = dayOfWeek(date);
    const key = `${seed}/${day}`;
    const puzzle = this.#cached.get(key) ?? generateDailyVariant(parseWeekSeed(seed), day);
    // Most recently used last, so the first is the one to drop.
    this.#cached.delete(key);
    this.#cached.set(key, puzzle);
    if (this.#cached.size > VARIANT_DAY_CACHE_SIZE) this.#cached.delete(this.#cached.keys().next().value!);
    return puzzle;
  }
}
