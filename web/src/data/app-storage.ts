import {
  type DayResult, type GameResult, type Me, type OidcConfig, type Week,
  decodeDayResult, decodeGameResult, decodeMe, decodeOidcConfig, decodeWeek,
} from "../api/models.ts";
import type { SavedGame } from "../game/game.ts";
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

export function decodeSavedGame(json: unknown): SavedGame {
  const o = obj(json);
  return { givens: str(o.givens), entries: str(o.entries), notes: list(o.notes, num), elapsedMs: num(o.elapsedMs), completed: bool(o.completed) };
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

  constructor(store: KeyValueStore) {
    this.settings = new StoredValue(store, "settings", decodeSettings);
    this.week = new StoredValue(store, "week", decodeWeek);
    this.me = new StoredValue(store, "me", decodeMe);
    this.tokens = new StoredValue(store, "tokens", decodeTokens);
    this.pendingAuth = new StoredValue(store, "auth-pending", decodePendingAuth);
    this.games = new StoredValue(store, "games", (j) => record(j, decodeSavedGame));
    this.serverResults = new StoredValue(store, "results", (j) => record(j, (r) => list(r, decodeDayResult)));
    this.pending = new StoredValue(store, "pending", (j) => list(j, decodeGameResult));
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
  }
}
