import { type Week, weekPuzzles } from "../api/models.ts";
import { inWeek, today, weekOf } from "../game/calendar.ts";
import { Game, type SavedGame } from "../game/game.ts";
import type { Puzzle } from "../generator/generator.ts";
import { type KeyValueStore, StoredValue, list, num, obj, optional, record, str } from "../data/store.ts";
import { decodeSavedGame, gameKey } from "../data/app-storage.ts";
import { fingerprint, resultsSummary, seedSettings, seedWeekFor, type SeedSettings, weekSeed } from "./seed.ts";

/** The seed being played, with its fingerprint worked out once. */
export interface SeedProfile {
  settings: SeedSettings;
  fingerprint: string;
}

/** A puzzle solved in serverless play: the local stand-in for a leaderboard entry. */
export interface SeedResult {
  date: string;
  level: number;
  /** The day's game count when it was played, which names the game (e.g. "Medium 2"). */
  levels: number;
  elapsedMs: number;
  /** When it was solved, as an RFC 3339 instant. */
  completedAt: string;
}

function decodeProfile(json: unknown): SeedProfile {
  const o = obj(json);
  const s = obj(o.settings);
  return {
    settings: seedSettings(str(s.seed), optional(s.levels, num) ?? undefined, optional(s.timezone, str) ?? undefined),
    fingerprint: str(o.fingerprint),
  };
}

function decodeResult(json: unknown): SeedResult {
  const o = obj(json);
  return { date: str(o.date), level: num(o.level), levels: num(o.levels), elapsedMs: num(o.elapsedMs), completedAt: str(o.completedAt) };
}

/**
 * Serverless play's data: the active seed, games in progress and the player's
 * history of solve times, in the same store as server mode. There is no
 * network: the week comes from the seed.
 *
 * Games and history are kept per seed (keyed by its fingerprint), so switching
 * seeds and back resumes where you were and never mixes two groups' games.
 */
export class SeedRepository {
  readonly #store: KeyValueStore;
  readonly #now: () => number;
  readonly #active: StoredValue<SeedProfile>;
  #seedCache: { key: string; seed: string } | null = null;
  #puzzleCache: { key: string; puzzles: Puzzle[] } | null = null;

  constructor(store: KeyValueStore, now: () => number = Date.now) {
    this.#store = store;
    this.#now = now;
    this.#active = new StoredValue(store, "seed", decodeProfile);
  }

  /** The seed being played, or `null` when not in serverless mode. */
  profile(): SeedProfile | null {
    return this.#active.read();
  }

  /** Starts playing with `settings` (replacing any other seed; its games and history are kept). */
  async use(settings: SeedSettings): Promise<SeedProfile> {
    const profile = { settings, fingerprint: await fingerprint(settings.seed) };
    this.#active.write(profile);
    return profile;
  }

  /** Stops serverless play. The seed's games and history stay, for if it's entered again. */
  leave(): void {
    this.#active.write(null);
  }

  today(): string {
    return today(this.#now(), this.#requireProfile().settings.timezone);
  }

  /** The current week for the active seed. */
  async week(): Promise<Week> {
    const { settings } = this.#requireProfile();
    const info = weekOf(this.today());
    const key = JSON.stringify([settings, info.isoWeek]);
    if (this.#seedCache?.key !== key) this.#seedCache = { key, seed: await weekSeed(settings.seed, info.isoWeek) };
    return seedWeekFor(settings, info, this.#seedCache.seed);
  }

  /** Today's games (or another day's in the current week). */
  async puzzles(date: string = this.today()): Promise<Puzzle[]> {
    const week = await this.week();
    const key = JSON.stringify([week.seed, week.levels, date]);
    if (this.#puzzleCache?.key !== key) this.#puzzleCache = { key, puzzles: weekPuzzles(week, date) };
    return this.#puzzleCache.puzzles;
  }

  /** A saved game for `puzzle` on `date`, if it still matches the puzzle. */
  loadGame(date: string, puzzle: Puzzle): Game | null {
    const saved = this.#games().read()?.[gameKey(date, puzzle.level)];
    return saved && saved.givens === puzzle.givens ? Game.restore(saved) : null;
  }

  /** Saves a game, dropping saved games from other weeks: they can't be finished any more. */
  saveGame(date: string, level: number, game: Game, nowMs: number): void {
    const week = weekOf(date);
    this.#games().update((saved) => ({
      ...Object.fromEntries(Object.entries(saved ?? {}).filter(([k]) => inWeek(week, k.split("/")[0]!))),
      [gameKey(date, level)]: game.save(nowMs),
    }));
  }

  /** Records a just-finished game in the history. The first result for a game counts; replays don't. */
  complete(date: string, level: number, game: Game): SeedResult {
    const profile = this.#requireProfile();
    if (game.completedElapsedMs === null) throw new Error("game isn't complete");
    const result: SeedResult = {
      date, level, levels: profile.settings.levels, elapsedMs: game.completedElapsedMs, completedAt: new Date(this.#now()).toISOString().replace(".000Z", "Z"),
    };
    const history = this.#history(profile);
    const existing = (history.read() ?? []).find((r) => r.date === date && r.level === level && r.levels === result.levels);
    if (existing) return existing;
    history.update((h) => [...(h ?? []), result]);
    return result;
  }

  /** Every result for the active seed, newest day first. */
  history(): SeedResult[] {
    const profile = this.profile();
    const results = profile ? (this.#history(profile).read() ?? []) : [];
    return results.sort((a, b) => (a.date === b.date ? a.level - b.level : a.date < b.date ? 1 : -1));
  }

  /** `date`'s results at the active seed's game count, by level. */
  results(date: string = this.today()): Map<number, SeedResult> {
    const levels = this.profile()?.settings.levels;
    if (levels === undefined) return new Map();
    return new Map(this.history().filter((r) => r.date === date && r.levels === levels).map((r) => [r.level, r]));
  }

  /** The "Share results" text for `date`. */
  async summary(date: string = this.today()): Promise<string> {
    const profile = this.#requireProfile();
    const results = this.results(date);
    const games = (await this.puzzles(date)).map((p) => ({ title: p.title, elapsedMs: results.get(p.level)?.elapsedMs ?? null }));
    return resultsSummary(date, profile.fingerprint, games);
  }

  #requireProfile(): SeedProfile {
    const profile = this.profile();
    if (!profile) throw new Error("no seed is active");
    return profile;
  }

  #games(): StoredValue<Record<string, SavedGame>> {
    return new StoredValue(this.#store, `seed-games-${this.#requireProfile().fingerprint.replace(/^#/, "")}`, (j) => record(j, decodeSavedGame));
  }

  #history(profile: SeedProfile): StoredValue<SeedResult[]> {
    return new StoredValue(this.#store, `seed-history-${profile.fingerprint.replace(/^#/, "")}`, (j) => list(j, decodeResult));
  }
}

