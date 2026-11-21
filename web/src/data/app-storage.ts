import {
  type DayResult, type EndlessInfo, type EndlessResult, type GameResult, type Me, type OidcConfig, type Streak, type VariantDayResult, type Week,
  decodeDayResult, decodeEndlessInfo, decodeGeneratorVersion, decodeEndlessResult, decodeGameResult, decodeMe, decodeOidcConfig, decodeStreak, decodeVariantDayResult, decodeWeek,
} from "../api/models.ts";
import type { SavedGame } from "../game/game.ts";
import { VARIANT_DIAGONAL, VARIANT_STANDARD, isVariant } from "../core/layout.ts";
import { decodeReplayEvent } from "../game/replay.ts";
import { GENERATOR_CLASSIC } from "../generator/versions.ts";
import { type KeyValueStore, StoredValue, bool, list, num, obj, optional, record, str } from "./store.ts";

export interface DevUser {
  sub: string;
  name: string;
}

export interface Settings {
  serverUrl: string;
  /** Set when signed in through the server's dev auth mode. */
  devUser: DevUser | null;
  /** Set when signed in with OIDC: the provider from the server's `/config`. */
  oidc: OidcConfig | null;
}

/** OIDC tokens kept between launches. `expiresAtEpochMs` is when the access token expires. */
export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  expiresAtEpochMs: number | null;
}

/** An OIDC sign-in waiting for the browser to redirect back. */
export interface PendingAuth {
  serverUrl: string;
  oidc: OidcConfig;
  state: string;
  verifier: string;
  nonce: string;
  createdAtEpochMs: number;
}

/**
 * Where a daily game is kept: its generator, date and level. Classic (generator 1) keeps the plain `date/level` it
 * always had, so games from before there were several generators still match; others are prefixed `g<generator>/`,
 * as endless games are.
 */
export const gameKey = (generator: number, date: string, level: number): string =>
  generator === GENERATOR_CLASSIC ? `${date}/${level}` : `g${generator}/${date}/${level}`;

/** The date of a {@link gameKey}. */
export const gameKeyDate = (key: string): string => key.split("/").at(-2)!;
/**
 * Where an endless game is kept: its generator's series, difficulty and number, and its variant. Classic
 * (generator 1) keeps the plain `difficulty/number` it always had, so games and queued results from before the
 * series existed still match; other series are prefixed `g<generator>/`. Standard Sudoku (variant 0) keeps
 * those keys as they are; the variants prefix them with `v<variant>/` (`v3/2/5` is Classic Killer Medium #5,
 * `v3/g2/2/5` the Graded one).
 */
export const endlessGameKey = (generator: number, difficulty: number, number: number, variant: number = VARIANT_STANDARD): string =>
  (variant === VARIANT_STANDARD ? "" : `v${variant}/`) +
  (generator === GENERATOR_CLASSIC ? `${difficulty}/${number}` : `g${generator}/${difficulty}/${number}`);

/** The inverse of {@link endlessGameKey}. */
export function parseEndlessGameKey(key: string): { generator: number; variant: number; difficulty: number; number: number } {
  const parts = key.split("/");
  const variant = parts[0]!.startsWith("v") ? Number(parts.shift()!.slice(1)) : VARIANT_STANDARD;
  const generator = parts.length === 3 ? Number(parts.shift()!.slice(1)) : GENERATOR_CLASSIC;
  const [difficulty, number] = parts.map(Number) as [number, number];
  return { generator, variant, difficulty, number };
}

/** The date of a variant of the day game key: games of the variant of the day are kept apart from the daily ones, by date alone. */
export const variantDayGameKey = (date: string): string => date;

/** The home page's tabs. */
export type HomeTab = "daily" | "endless" | "variants" | "learn";

const decodeHomeTab = (json: unknown): HomeTab => {
  if (json !== "daily" && json !== "endless" && json !== "variants" && json !== "learn") throw new TypeError(`unknown tab: ${String(json)}`);
  return json;
};

/** A variant the Variants tab can show: Diagonal, Jigsaw or Killer (not standard Sudoku, which is the Endless tab's). */
export const decodeVariantPick = (json: unknown): number => {
  const v = num(json);
  if (!isVariant(v) || v < VARIANT_DIAGONAL) throw new TypeError(`not a variant: ${v}`);
  return v;
};

export function decodeSavedGame(json: unknown): SavedGame {
  const o = obj(json);
  const replay = optional(o.replay, (r) => list(r, decodeReplayEvent));
  const colours = optional(o.colours, str);
  return {
    givens: str(o.givens), entries: str(o.entries), notes: list(o.notes, num), elapsedMs: num(o.elapsedMs), completed: bool(o.completed),
    ...(replay ? { replay } : {}),
    ...(colours ? { colours } : {}),
  };
}

function decodeSettings(json: unknown): Settings {
  const o = obj(json);
  return {
    serverUrl: optional(o.serverUrl, str) ?? "",
    devUser: optional(o.devUser, (d) => ({ sub: str(obj(d).sub), name: str(obj(d).name) })),
    oidc: optional(o.oidc, decodeOidcConfig),
  };
}

function decodeTokens(json: unknown): StoredTokens {
  const o = obj(json);
  return {
    accessToken: str(o.accessToken), refreshToken: optional(o.refreshToken, str),
    idToken: optional(o.idToken, str), expiresAtEpochMs: optional(o.expiresAtEpochMs, num),
  };
}

function decodePendingAuth(json: unknown): PendingAuth {
  const o = obj(json);
  return {
    serverUrl: str(o.serverUrl), oidc: decodeOidcConfig(o.oidc), state: str(o.state),
    verifier: str(o.verifier), nonce: str(o.nonce), createdAtEpochMs: num(o.createdAtEpochMs),
  };
}

/**
 * One account's unfinished business, set aside while it is signed out: the games in progress (timers included) and
 * the results queued but not yet uploaded. See {@link AppStorage.parkProgress}.
 */
export interface ParkedProgress {
  games: Record<string, SavedGame>;
  endlessGames: Record<string, SavedGame>;
  variantDayGames: Record<string, SavedGame>;
  pending: GameResult[];
  endlessPending: EndlessResult[];
  variantDayPending: VariantDayResult[];
}

function decodeParkedProgress(json: unknown): ParkedProgress {
  const o = obj(json);
  return {
    games: record(o.games, decodeSavedGame),
    endlessGames: record(o.endlessGames, decodeSavedGame),
    variantDayGames: record(o.variantDayGames, decodeSavedGame),
    pending: list(o.pending, decodeGameResult),
    endlessPending: list(o.endlessPending, decodeEndlessResult),
    variantDayPending: list(o.variantDayPending, decodeVariantDayResult),
  };
}

/** Everything server mode keeps between launches, as JSON documents in a {@link KeyValueStore}. */
export class AppStorage {
  readonly settings: StoredValue<Settings>;
  /** The current week's seed: exactly one week is kept. */
  readonly week: StoredValue<Week>;
  readonly me: StoredValue<Me>;
  readonly tokens: StoredValue<StoredTokens>;
  readonly pendingAuth: StoredValue<PendingAuth>;
  /** Games in progress or finished, keyed by {@link gameKey} (so per generator). Only the cached week's are kept. */
  readonly games: StoredValue<Record<string, SavedGame>>;
  /** The server's record of the user's results, by date (only recent dates are kept). */
  readonly serverResults: StoredValue<Record<string, DayResult[]>>;
  /** The offline result queue. */
  readonly pending: StoredValue<GameResult[]>;
  /** The server's endless seed: it never changes, so it's fetched once. */
  readonly endless: StoredValue<EndlessInfo>;
  /** Endless games in progress or finished, keyed by {@link endlessGameKey}. Kept until solved and uploaded. */
  readonly endlessGames: StoredValue<Record<string, SavedGame>>;
  /** The server's record of the user's endless results. */
  readonly endlessResults: StoredValue<EndlessResult[]>;
  /** The offline queue of endless results. */
  readonly endlessPending: StoredValue<EndlessResult[]>;
  /** Variant of the day games in progress or finished, keyed by {@link variantDayGameKey}. Only the cached week's are kept. */
  readonly variantDayGames: StoredValue<Record<string, SavedGame>>;
  /** The server's record of the user's variant of the day result, by date (only the latest fetch is kept). */
  readonly variantDayResults: StoredValue<Record<string, VariantDayResult>>;
  /** The offline queue of variant of the day results. */
  readonly variantDayPending: StoredValue<VariantDayResult[]>;
  /** The user's last known daily streak, so the home page shows it offline and after a reload. */
  readonly streak: StoredValue<Streak>;
  /**
   * Progress set aside at sign-out, by user id (`me.id`), so the same account gets it back on its next sign-in and
   * no other account on a shared device ever sees it.
   */
  readonly parkedProgress: StoredValue<Record<string, ParkedProgress>>;
  /** The home page tab last shown on this device. */
  readonly homeTab: StoredValue<HomeTab>;
  /** Set once the endless explainer has popped up on this device, so it only does so once. */
  readonly endlessHelpSeen: StoredValue<boolean>;
  /**
   * The generator the player last picked with the Classic / Graded switch (Daily and Endless share it), on this
   * device, with a server or a seed. Only used while that generator is enabled.
   */
  readonly generator: StoredValue<number>;
  /** The variant the player last picked on the Variants tab, on this device, with a server or a seed. */
  readonly variant: StoredValue<number>;
  /** Set once the variants explainer has popped up on this device, so it only does so once. */
  readonly variantsHelpSeen: StoredValue<boolean>;

  constructor(store: KeyValueStore) {
    this.settings = new StoredValue(store, "settings", decodeSettings);
    this.week = new StoredValue(store, "week", decodeWeek);
    this.me = new StoredValue(store, "me", decodeMe);
    this.tokens = new StoredValue(store, "tokens", decodeTokens);
    this.pendingAuth = new StoredValue(store, "auth-pending", decodePendingAuth);
    this.games = new StoredValue(store, "games", (j) => record(j, decodeSavedGame));
    this.serverResults = new StoredValue(store, "results", (j) => record(j, (r) => list(r, decodeDayResult)));
    this.pending = new StoredValue(store, "pending", (j) => list(j, decodeGameResult));
    this.endless = new StoredValue(store, "endless", decodeEndlessInfo);
    this.endlessGames = new StoredValue(store, "endless-games", (j) => record(j, decodeSavedGame));
    this.endlessResults = new StoredValue(store, "endless-results", (j) => list(j, decodeEndlessResult));
    this.endlessPending = new StoredValue(store, "endless-pending", (j) => list(j, decodeEndlessResult));
    this.variantDayGames = new StoredValue(store, "variant-day-games", (j) => record(j, decodeSavedGame));
    this.variantDayResults = new StoredValue(store, "variant-day-results", (j) => record(j, decodeVariantDayResult));
    this.variantDayPending = new StoredValue(store, "variant-day-pending", (j) => list(j, decodeVariantDayResult));
    this.streak = new StoredValue(store, "streak", decodeStreak);
    this.parkedProgress = new StoredValue(store, "parked-progress", (j) => record(j, decodeParkedProgress));
    this.homeTab = new StoredValue(store, "home-tab", decodeHomeTab);
    this.endlessHelpSeen = new StoredValue(store, "endless-help-seen", bool);
    this.generator = new StoredValue(store, "generator", decodeGeneratorVersion);
    this.variant = new StoredValue(store, "variant", decodeVariantPick);
    this.variantsHelpSeen = new StoredValue(store, "variants-help-seen", bool);
  }

  /**
   * Forgets everything tied to the signed-in user, keeping the server URL. The user's games and queued results are
   * first set aside with {@link parkProgress}, so signing out doesn't lose a puzzle in progress or its timer.
   */
  clearUserData(): void {
    this.parkProgress();
    this.settings.update((s) => s && { ...s, devUser: null, oidc: null });
    this.tokens.write(null);
    this.clearProgress();
  }

  /**
   * Sets the signed-in user's games and queued results aside under their id, replacing any older entry for that
   * id. Nothing is parked, and no older entry touched, when the user isn't known (never synced) or has nothing
   * to keep.
   */
  parkProgress(): void {
    const me = this.me.read();
    if (!me) return;
    const parked: ParkedProgress = {
      games: this.games.read() ?? {},
      endlessGames: this.endlessGames.read() ?? {},
      variantDayGames: this.variantDayGames.read() ?? {},
      pending: this.pending.read() ?? [],
      endlessPending: this.endlessPending.read() ?? [],
      variantDayPending: this.variantDayPending.read() ?? [],
    };
    if (Object.values(parked).every((v) => Object.keys(v).length === 0)) return;
    this.parkedProgress.update((all) => ({ ...all, [me.id]: parked }));
  }

  /** Removes and returns what {@link parkProgress} set aside for `userId`, or `null` when there is none. */
  takeParkedProgress(userId: string): ParkedProgress | null {
    const all = this.parkedProgress.read();
    const parked = all?.[userId];
    if (!all || !parked) return null;
    const others = { ...all };
    delete others[userId];
    this.parkedProgress.write(Object.keys(others).length === 0 ? null : others);
    return parked;
  }

  /** Forgets the user's games and results (e.g. when a different account signs in). */
  clearProgress(): void {
    this.me.write(null);
    this.games.write(null);
    this.serverResults.write(null);
    this.pending.write(null);
    this.endlessGames.write(null);
    this.endlessResults.write(null);
    this.endlessPending.write(null);
    this.variantDayGames.write(null);
    this.variantDayResults.write(null);
    this.variantDayPending.write(null);
    this.streak.write(null);
  }
}
