import type { Game, SavedGame } from "../game/game.ts";
import { parseEndlessGameKey } from "./app-storage.ts";
import type { EndlessPuzzle } from "../generator/generator.ts";
import { generateEndlessVersion } from "../generator/versions.ts";
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
  difficulty: number;
  number: number;
  elapsedMs: number;
}

/**
 * What the controller needs from whichever repository the endless puzzles
 * belong to: the server's {@link SudokuRepository} or serverless play's
 * `SeedRepository`. Solved puzzles are keyed by `endlessGameKey`. Every generator version has its own series
 * of numbered puzzles, so each puzzle is named by its `generator` too.
 */
export interface EndlessSource {
  /** Whether the endless seed is known, so {@link endlessPuzzle} can generate. */
  endlessReady(): boolean;
  /** Endless puzzle `number` of `difficulty` in `generator`'s series, or `null` until the endless seed is known. */
  endlessPuzzle(generator: number, difficulty: number, number: number): EndlessPuzzle | null;
  endlessSolved(): Map<string, EndlessSolved>;
  endlessInProgress(): EndlessInProgress[];
  loadEndlessGame(generator: number, puzzle: EndlessPuzzle): Game | null;
  saveEndlessGame(generator: number, difficulty: number, number: number, game: Game, nowMs: number): void;
  /** Records a just-finished endless game. */
  completeEndless(generator: number, difficulty: number, number: number, game: Game): Promise<unknown>;
}

/** Remembers the last endless puzzle generated, since the screens ask for the same one repeatedly. */
export class EndlessPuzzleCache {
  #cached: { key: string; puzzle: EndlessPuzzle } | null = null;

  /** The puzzle for the 16-hex-character endless `seed`, from generator version `generator`. */
  get(seed: string, generator: number, difficulty: number, number: number): EndlessPuzzle {
    const key = JSON.stringify([seed, generator, difficulty, number]);
    if (this.#cached?.key !== key) this.#cached = { key, puzzle: generateEndlessVersion(generator, parseWeekSeed(seed), difficulty, number) };
    return this.#cached.puzzle;
  }
}

/** The unfinished games among `games` (keyed by `endlessGameKey`), by series, difficulty then number. */
export function endlessInProgressOf(games: Record<string, SavedGame> | null): EndlessInProgress[] {
  return Object.entries(games ?? {})
    .filter(([, g]) => !g.completed)
    .map(([key, g]) => ({ ...parseEndlessGameKey(key), elapsedMs: g.elapsedMs }))
    .sort((a, b) => a.generator - b.generator || a.difficulty - b.difficulty || a.number - b.number);
}
