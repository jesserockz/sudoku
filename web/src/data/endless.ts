import { VARIANT_STANDARD } from "../core/layout.ts";
import type { Game, SavedGame } from "../game/game.ts";
import { parseEndlessGameKey } from "./app-storage.ts";
import { type VariantPuzzle, generateEndlessVariant } from "../generator/variants.ts";
import { parseWeekSeed } from "../generator/week-seed.ts";

/** A solved endless puzzle. `synced` is false while its result waits in the offline queue. */
export interface EndlessSolved {
  elapsedMs: number;
  synced: boolean;
}

/** An endless game started on this device and not solved yet. */
export interface EndlessInProgress {
  /** The series: the generator version its puzzle comes from. */
  generator: number;
  /** The variant: 0 standard Sudoku, 1 Diagonal, 2 Jigsaw, 3 Killer. */
  variant: number;
  difficulty: number;
  number: number;
  elapsedMs: number;
}

/**
 * What the controller needs from whichever repository the endless puzzles
 * belong to: the server's {@link SudokuRepository} or serverless play's
 * `SeedRepository`. Solved puzzles are keyed by `endlessGameKey`. Every generator version has its own series
 * of numbered puzzles, and so does every variant within it, so each puzzle is named by its `generator` and
 * `variant` too (`variant` 0, standard Sudoku, when omitted).
 */
export interface EndlessSource {
  /** Whether the endless seed is known, so {@link endlessPuzzle} can generate. */
  endlessReady(): boolean;
  /** Endless puzzle `number` of `difficulty` in `generator`'s series of `variant`, or `null` until the endless seed is known. */
  endlessPuzzle(generator: number, difficulty: number, number: number, variant?: number): VariantPuzzle | null;
  endlessSolved(): Map<string, EndlessSolved>;
  endlessInProgress(): EndlessInProgress[];
  /** The saved game of `puzzle` (which knows its variant and layout), if it still matches. */
  loadEndlessGame(generator: number, puzzle: VariantPuzzle): Game | null;
  saveEndlessGame(generator: number, difficulty: number, number: number, game: Game, nowMs: number, variant?: number): void;
  /** Records a just-finished endless game. */
  completeEndless(generator: number, difficulty: number, number: number, game: Game, variant?: number): Promise<unknown>;
}

/** How many endless puzzles {@link EndlessPuzzleCache} keeps. */
export const ENDLESS_CACHE_SIZE = 16;

/**
 * Remembers the endless puzzles generated last, since the screens ask for the same ones repeatedly and a variant
 * can take a good fraction of a second to generate. Keeps the {@link ENDLESS_CACHE_SIZE} most recently used.
 */
export class EndlessPuzzleCache {
  readonly #cached = new Map<string, VariantPuzzle>();

  /** The puzzle for the 16-hex-character endless `seed`, from generator version `generator`, of `variant`. */
  get(seed: string, generator: number, difficulty: number, number: number, variant: number = VARIANT_STANDARD): VariantPuzzle {
    const key = JSON.stringify([seed, generator, variant, difficulty, number]);
    const puzzle = this.#cached.get(key) ?? generateEndlessVariant(generator, variant, parseWeekSeed(seed), difficulty, number);
    // Most recently used last, so the first is the one to drop.
    this.#cached.delete(key);
    this.#cached.set(key, puzzle);
    if (this.#cached.size > ENDLESS_CACHE_SIZE) this.#cached.delete(this.#cached.keys().next().value!);
    return puzzle;
  }
}

/** The unfinished games among `games` (keyed by `endlessGameKey`), by series, variant, difficulty then number. */
export function endlessInProgressOf(games: Record<string, SavedGame> | null): EndlessInProgress[] {
  return Object.entries(games ?? {})
    .filter(([, g]) => !g.completed)
    .map(([key, g]) => ({ ...parseEndlessGameKey(key), elapsedMs: g.elapsedMs }))
    .sort((a, b) => a.generator - b.generator || a.variant - b.variant || a.difficulty - b.difficulty || a.number - b.number);
}
