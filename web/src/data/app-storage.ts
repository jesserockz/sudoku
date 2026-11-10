import {
  type DayResult, type EndlessInfo, type EndlessResult, type GameResult, type Me, type OidcConfig, type Streak, type Week,
  decodeDayResult, decodeEndlessInfo, decodeGeneratorVersion, decodeEndlessResult, decodeGameResult, decodeMe, decodeOidcConfig, decodeStreak, decodeWeek,
} from "../api/models.ts";
import type { SavedGame } from "../game/game.ts";
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
 * Where an endless game is kept: its generator's series, difficulty and number. Classic (generator 1) keeps
 * the plain `difficulty/number` it always had, so games and queued results from before the series existed
 * still match; other series are prefixed `g<generator>/`.
 */
export const endlessGameKey = (generator: number, difficulty: number, number: number): string =>
  generator === GENERATOR_CLASSIC ? `${difficulty}/${number}` : `g${generator}/${difficulty}/${number}`;

/** The inverse of {@link endlessGameKey}. */
export function parseEndlessGameKey(key: string): { generator: number; difficulty: number; number: number } {
  const parts = key.split("/");
  const generator = parts.length === 3 ? Number(parts.shift()!.slice(1)) : GENERATOR_CLASSIC;
  const [difficulty, number] = parts.map(Number) as [number, number];
  return { generator, difficulty, number };
}

/** The home page's tabs. */
export type HomeTab = "daily" | "endless";

const decodeHomeTab = (json: unknown): HomeTab => {
  if (json !== "daily" && json !== "endless") throw new TypeError(`unknown tab: ${String(json)}`);
  return json;
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
  /** The user's last known daily streak, so the home page shows it offline and after a reload. */
  readonly streak: StoredValue<Streak>;
  /** The home page tab last shown on this device. */
  readonly homeTab: StoredValue<HomeTab>;
  /** Set once the endless explainer has popped up on this device, so it only does so once. */
  readonly endlessHelpSeen: StoredValue<boolean>;
  /**
   * The generator the player last picked with the Classic / Graded switch (Daily and Endless share it), on this
   * device, with a server or a seed. Only used while that generator is enabled.
   */
  readonly generator: StoredValue<number>;

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
    this.streak = new StoredValue(store, "streak", decodeStreak);
    this.homeTab = new StoredValue(store, "home-tab", decodeHomeTab);
    this.endlessHelpSeen = new StoredValue(store, "endless-help-seen", bool);
    this.generator = new StoredValue(store, "generator", decodeGeneratorVersion);
  }

  /** Forgets everything tied to the signed-in user, keeping the server URL. */
  clearUserData(): void {
    this.settings.update((s) => s && { ...s, devUser: null, oidc: null });
    this.tokens.write(null);
    this.clearProgress();
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
    this.streak.write(null);
  }
}
