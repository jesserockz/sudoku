import {
  type DayResult, type EndlessInfo, type EndlessResult, type GameResult, type Me, type OidcConfig, type Week,
  decodeDayResult, decodeEndlessInfo, decodeEndlessResult, decodeGameResult, decodeMe, decodeOidcConfig, decodeWeek,
} from "../api/models.ts";
import type { SavedGame } from "../game/game.ts";
import { decodeReplayEvent } from "../game/replay.ts";
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

export const gameKey = (date: string, level: number): string => `${date}/${level}`;
/** Where an endless game is kept: its difficulty and number. */
export const endlessGameKey = (difficulty: number, number: number): string => `${difficulty}/${number}`;

/** The home page's tabs. */
export type HomeTab = "daily" | "endless";

const decodeHomeTab = (json: unknown): HomeTab => {
  if (json !== "daily" && json !== "endless") throw new TypeError(`unknown tab: ${String(json)}`);
  return json;
};

export function decodeSavedGame(json: unknown): SavedGame {
  const o = obj(json);
  const replay = optional(o.replay, (r) => list(r, decodeReplayEvent));
  return {
    givens: str(o.givens), entries: str(o.entries), notes: list(o.notes, num), elapsedMs: num(o.elapsedMs), completed: bool(o.completed),
    ...(replay ? { replay } : {}),
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
  /** Games in progress or finished, keyed by {@link gameKey}. Only the cached week's are kept. */
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
  /** The home page tab last shown on this device. */
  readonly homeTab: StoredValue<HomeTab>;

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
    this.homeTab = new StoredValue(store, "home-tab", decodeHomeTab);
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
  }
}
