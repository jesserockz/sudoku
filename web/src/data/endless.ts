import type { Game, SavedGame } from "../game/game.ts";
import { type EndlessPuzzle, generateEndless } from "../generator/generator.ts";
import { parseWeekSeed } from "../generator/week-seed.ts";

/** A solved endless puzzle. `synced` is false while its result waits in the offline queue. */
export interface EndlessSolved {
  elapsedMs: number;
  synced: boolean;
}

/** An endless game started on this device and not solved yet. */
export interface EndlessInProgress {
  difficulty: number;
  number: number;
  elapsedMs: number;
}

/**
 * What the controller needs from whichever repository the endless puzzles
 * belong to: the server's {@link SudokuRepository} or serverless play's
 * `SeedRepository`. Solved puzzles are keyed by `endlessGameKey`.
 */
export interface EndlessSource {
  /** Endless puzzle `number` of `difficulty`, or `null` until the endless seed is known. */
  endlessPuzzle(difficulty: number, number: number): EndlessPuzzle | null;
  endlessSolved(): Map<string, EndlessSolved>;
  endlessInProgress(): EndlessInProgress[];
  loadEndlessGame(puzzle: EndlessPuzzle): Game | null;
  saveEndlessGame(difficulty: number, number: number, game: Game, nowMs: number): void;
  /** Records a just-finished endless game. */
  completeEndless(difficulty: number, number: number, game: Game): Promise<unknown>;
}

/** Remembers the last endless puzzle generated, since the screens ask for the same one repeatedly. */
export class EndlessPuzzleCache {
  #cached: { key: string; puzzle: EndlessPuzzle } | null = null;

  /** The puzzle for the 16-hex-character endless `seed`. */
  get(seed: string, difficulty: number, number: number): EndlessPuzzle {
    const key = JSON.stringify([seed, difficulty, number]);
    if (this.#cached?.key !== key) this.#cached = { key, puzzle: generateEndless(parseWeekSeed(seed), difficulty, number) };
    return this.#cached.puzzle;
  }
}

/** The unfinished games among `games` (keyed by `endlessGameKey`), by difficulty then number. */
export function endlessInProgressOf(games: Record<string, SavedGame> | null): EndlessInProgress[] {
  return Object.entries(games ?? {})
    .filter(([, g]) => !g.completed)
    .map(([key, g]) => {
      const [difficulty, number] = key.split("/").map(Number) as [number, number];
      return { difficulty, number, elapsedMs: g.elapsedMs };
    })
    .sort((a, b) => a.difficulty - b.difficulty || a.number - b.number);
}
