import { type Week, weekPuzzles } from "../api/models.ts";
import { inWeek, today, weekOf } from "../game/calendar.ts";
import { Game, type SavedGame } from "../game/game.ts";
import type { EndlessPuzzle, Puzzle } from "../generator/generator.ts";
import { type KeyValueStore, StoredValue, list, num, obj, optional, record, str } from "../data/store.ts";
import { decodeSavedGame, endlessGameKey, gameKey, gameKeyDate } from "../data/app-storage.ts";
import { type EndlessInProgress, EndlessPuzzleCache, type EndlessSolved, type EndlessSource, endlessInProgressOf } from "../data/endless.ts";
import { type EndlessResult, decodeEndlessResult } from "../api/models.ts";
import { GENERATOR_CLASSIC, enabledGenerators } from "../generator/versions.ts";
import { endlessSeed, fingerprint, resultsSummary, seedSettings, seedWeekFor, type SeedSettings, weekSeed } from "./seed.ts";

/** The seed being played, with its fingerprint worked out once. */
export interface SeedProfile {
  settings: SeedSettings;
  fingerprint: string;
}

/** A puzzle solved in serverless play: the local stand-in for a leaderboard entry. */
export interface SeedResult {
  /** The generator the puzzle came from. History from before there were several generators has none: Classic. */
  generator: number;
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
  return {
    generator: optional(o.generator, num) ?? GENERATOR_CLASSIC, date: str(o.date), level: num(o.level), levels: num(o.levels),
    elapsedMs: num(o.elapsedMs), completedAt: str(o.completedAt),
  };
}

/**
 * A seed's enabled generators: `[1]`, `[2]` or `[1, 2]`. Before generators could be enabled together, a seed kept a
 * schedule of `{ fromWeek, version }` entries where a change waited for the next ISO week; such a schedule reads as
 * its latest entry's version alone, so a change that was still waiting applies now.
 */
export function decodeSeedGenerators(json: unknown): number[] {
  const entries = list(json, (e) => e);
  if (entries.some((e) => typeof e === "object" && e !== null)) {
    const latest = list(entries, (e) => ({ fromWeek: str(obj(e).fromWeek), version: num(obj(e).version) }))
      .reduce((a, b) => (b.fromWeek >= a.fromWeek ? b : a));
    return enabledGenerators([latest.version]);
  }
  return enabledGenerators(list(entries, num));
}

/**
 * Serverless play's data: the active seed, games in progress and the player's
 * history of solve times, in the same store as server mode. There is no
 * network: the week comes from the seed.
 *
 * Endless puzzles come from the seed too (see {@link endlessSeed}): their games
 * and solve times are kept per seed like the daily ones, but never pruned, as
 * an endless puzzle can be finished at any time. Each generator version has its
 * own series of them, with its own numbering.
 *
 * Games and history are kept per seed (keyed by its fingerprint), so switching
 * seeds and back resumes where you were and never mixes two groups' games.
 */
export class SeedRepository implements EndlessSource {
  readonly #store: KeyValueStore;
  readonly #now: () => number;
  readonly #active: StoredValue<SeedProfile>;
  #seedCache: { key: string; seed: string } | null = null;
  #puzzleCache: { key: string; puzzles: Puzzle[] } | null = null;
  #endlessSeed: { seed: string; hex: string } | null = null;
  readonly #endlessPuzzles = new EndlessPuzzleCache();

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
    const profile = this.#requireProfile();
    const { settings } = profile;
    const info = weekOf(this.today());
    const key = JSON.stringify([settings, info.isoWeek]);
    if (this.#seedCache?.key !== key) this.#seedCache = { key, seed: await weekSeed(settings.seed, info.isoWeek) };
    return seedWeekFor(settings, info, this.#seedCache.seed, this.#enabled(profile));
  }

  /** The generators enabled for the active seed: Classic alone until the player chooses. */
  generators(): number[] {
    return this.#enabled(this.#requireProfile());
  }

  /** Enables exactly `enabled` (non-empty, known versions) for the active seed, straight away. Throws a `TypeError` otherwise. */
  setGenerators(enabled: readonly number[]): void {
    const set = enabledGenerators(enabled);
    this.#generators(this.#requireProfile()).write(set);
  }

  /** Today's games (or another day's in the current week) from `generator`. */
  async puzzles(date: string, generator: number): Promise<Puzzle[]> {
    const week = await this.week();
    const key = JSON.stringify([week.seed, week.levels, generator, date]);
    if (this.#puzzleCache?.key !== key) this.#puzzleCache = { key, puzzles: weekPuzzles(week, generator, date) };
    return this.#puzzleCache.puzzles;
  }

  /** A saved game for `puzzle` (from `generator`) on `date`, if it still matches the puzzle. */
  loadGame(generator: number, date: string, puzzle: Puzzle): Game | null {
    const saved = this.#games().read()?.[gameKey(generator, date, puzzle.level)];
    return saved && saved.givens === puzzle.givens ? Game.restore(saved) : null;
  }

  /** Saves a game, dropping saved games from other weeks: they can't be finished any more. */
  saveGame(generator: number, date: string, level: number, game: Game, nowMs: number): void {
    const week = weekOf(date);
    this.#games().update((saved) => ({
      ...Object.fromEntries(Object.entries(saved ?? {}).filter(([k]) => inWeek(week, gameKeyDate(k)))),
      [gameKey(generator, date, level)]: game.save(nowMs),
    }));
  }

  /** Records a just-finished game from `generator` in the history. The first result for a game counts; replays don't. */
  complete(generator: number, date: string, level: number, game: Game): SeedResult {
    const profile = this.#requireProfile();
    if (game.completedElapsedMs === null) throw new Error("game isn't complete");
    const result: SeedResult = {
      generator, date, level, levels: profile.settings.levels, elapsedMs: game.completedElapsedMs,
      completedAt: new Date(this.#now()).toISOString().replace(".000Z", "Z"),
    };
    const history = this.#history(profile);
    const existing = (history.read() ?? [])
      .find((r) => r.generator === generator && r.date === date && r.level === level && r.levels === result.levels);
    if (existing) return existing;
    history.update((h) => [...(h ?? []), result]);
    return result;
  }

  /** Every result for the active seed, newest day first, then by generator and level. */
  history(): SeedResult[] {
    const profile = this.profile();
    const results = profile ? (this.#history(profile).read() ?? []) : [];
    return results.sort((a, b) => (a.date === b.date ? a.generator - b.generator || a.level - b.level : a.date < b.date ? 1 : -1));
  }

  /** `generator`'s results on `date` at the active seed's game count, by level. */
  results(date: string, generator: number): Map<number, SeedResult> {
    const levels = this.profile()?.settings.levels;
    if (levels === undefined) return new Map();
    return new Map(this.history().filter((r) => r.generator === generator && r.date === date && r.levels === levels).map((r) => [r.level, r]));
  }

  /** The "Share results" text for `generator`'s games on `date`. */
  async summary(date: string, generator: number): Promise<string> {
    const profile = this.#requireProfile();
    const results = this.results(date, generator);
    const games = (await this.puzzles(date, generator)).map((p) => ({ title: p.title, elapsedMs: results.get(p.level)?.elapsedMs ?? null }));
    return resultsSummary(date, profile.fingerprint, games);
  }

  /** Works out the active seed's endless seed, which {@link endlessPuzzle} needs (it can't wait for the hash). */
  async loadEndless(): Promise<void> {
    const { seed } = this.#requireProfile().settings;
    if (this.#endlessSeed?.seed !== seed) this.#endlessSeed = { seed, hex: await endlessSeed(seed) };
  }

  /** Whether {@link loadEndless} has run for the active seed. */
  endlessReady(): boolean {
    return this.#endlessSeed !== null && this.#endlessSeed.seed === this.profile()?.settings.seed;
  }

  /** Endless puzzle `number` of `difficulty` in `generator`'s series, or `null` until {@link loadEndless} has run for the active seed. */
  endlessPuzzle(generator: number, difficulty: number, number: number): EndlessPuzzle | null {
    if (!this.endlessReady()) return null;
    return this.#endlessPuzzles.get(this.#endlessSeed!.hex, generator, difficulty, number);
  }

  /** Every solved endless puzzle of the active seed, by {@link endlessGameKey}. */
  endlessSolved(): Map<string, EndlessSolved> {
    return new Map(this.endlessHistory().map((r) => [endlessGameKey(r.generator, r.difficulty, r.number), { elapsedMs: r.elapsedMs, synced: true }]));
  }

  /** Every endless solve of the active seed, by series, difficulty then number. */
  endlessHistory(): EndlessResult[] {
    const profile = this.profile();
    const results = profile ? (this.#endlessHistory(profile).read() ?? []) : [];
    return results.sort((a, b) => a.generator - b.generator || a.difficulty - b.difficulty || a.number - b.number);
  }

  /** Endless games started and not solved yet, by series, difficulty then number. */
  endlessInProgress(): EndlessInProgress[] {
    return endlessInProgressOf(this.#endlessGames().read());
  }

  /** A saved game for an endless puzzle, if it still matches the puzzle. */
  loadEndlessGame(generator: number, puzzle: EndlessPuzzle): Game | null {
    const saved = this.#endlessGames().read()?.[endlessGameKey(generator, puzzle.tier, puzzle.number)];
    return saved && saved.givens === puzzle.givens ? Game.restore(saved) : null;
  }

  saveEndlessGame(generator: number, difficulty: number, number: number, game: Game, nowMs: number): void {
    this.#endlessGames().update((games) => ({ ...games, [endlessGameKey(generator, difficulty, number)]: game.save(nowMs) }));
  }

  /**
   * Records a just-finished endless game in the history and drops its saved
   * game, which has nothing left to resume. The first result for a puzzle counts.
   */
  async completeEndless(generator: number, difficulty: number, number: number, game: Game): Promise<EndlessResult> {
    const profile = this.#requireProfile();
    if (game.completedElapsedMs === null) throw new Error("game isn't complete");
    const key = endlessGameKey(generator, difficulty, number);
    this.#endlessGames().update((games) => Object.fromEntries(Object.entries(games ?? {}).filter(([k]) => k !== key)));
    const history = this.#endlessHistory(profile);
    const existing = (history.read() ?? []).find((r) => r.generator === generator && r.difficulty === difficulty && r.number === number);
    if (existing) return existing;
    const result: EndlessResult = {
      generator, difficulty, number, elapsedMs: game.completedElapsedMs, completedAt: new Date(this.#now()).toISOString().replace(".000Z", "Z"),
    };
    history.update((h) => [...(h ?? []), result]);
    return result;
  }

  #requireProfile(): SeedProfile {
    const profile = this.profile();
    if (!profile) throw new Error("no seed is active");
    return profile;
  }

  #games(): StoredValue<Record<string, SavedGame>> {
    return new StoredValue(this.#store, `seed-games-${this.#requireProfile().fingerprint.replace(/^#/, "")}`, (j) => record(j, decodeSavedGame));
  }

  #generators(profile: SeedProfile): StoredValue<number[]> {
    return new StoredValue(this.#store, `seed-generator-${profile.fingerprint.replace(/^#/, "")}`, decodeSeedGenerators);
  }

  #enabled(profile: SeedProfile): number[] {
    return this.#generators(profile).read() ?? [GENERATOR_CLASSIC];
  }

  #history(profile: SeedProfile): StoredValue<SeedResult[]> {
    return new StoredValue(this.#store, `seed-history-${profile.fingerprint.replace(/^#/, "")}`, (j) => list(j, decodeResult));
  }

  #endlessGames(): StoredValue<Record<string, SavedGame>> {
    return new StoredValue(this.#store, `seed-endless-games-${this.#requireProfile().fingerprint.replace(/^#/, "")}`, (j) => record(j, decodeSavedGame));
  }

  #endlessHistory(profile: SeedProfile): StoredValue<EndlessResult[]> {
    return new StoredValue(this.#store, `seed-endless-history-${profile.fingerprint.replace(/^#/, "")}`, (j) => list(j, decodeEndlessResult));
  }
}
