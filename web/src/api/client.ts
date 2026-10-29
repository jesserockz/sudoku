import {
  type ApiError, type AppConfig, type GameResult, type Leaderboard, type Me, type MyResults, type Week,
  decodeApiError, decodeAppConfig, decodeGameResult, decodeLeaderboard, decodeMe, decodeMyResults, decodeWeek,
} from "./models.ts";

/** A non-2xx API response. `error` is the parsed error envelope, when there was one. */
export class ApiException extends Error {
  readonly status: number;
  readonly error: ApiError | null;

  constructor(status: number, error: ApiError | null) {
    super(`HTTP ${status}${error ? `: ${error.code} ${error.message}` : ""}`);
    this.status = status;
    this.error = error;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

/**
 * How the server answered `POST /api/v1/results`: `created` (201, stored now),
 * `stored` (200, a result already existed) or `rejected` (400, failed
 * validation: final, so drop it and don't retry).
 */
export type SubmitOutcome =
  | { kind: "created"; result: GameResult }
  | { kind: "stored"; result: GameResult }
  | { kind: "rejected"; error: ApiError | null };

/** Supplies the bearer token for API calls, or `null` when signed out. */
export type TokenProvider = () => Promise<string | null>;

export type Fetch = typeof fetch;

/** The server's dev auth mode: the bearer token is `dev:<sub>:<display name>`. For local development only. */
export function devToken(sub: string, displayName: string): string {
  if (sub === "" || sub.includes(":")) throw new RangeError("dev sub must be non-empty and contain no ':'");
  if (displayName === "") throw new RangeError("dev display name must be non-empty");
  return `dev:${sub}:${displayName}`;
}

/**
 * Client for the v1 API (`docs/API.md`). `baseUrl` is the server origin, e.g.
 * `https://sudoku.example.com`. Network failures surface as fetch's errors
 * (a `TypeError`); HTTP errors as {@link ApiException}.
 */
export class SudokuApi {
  readonly #base: string;
  readonly #tokens: TokenProvider;
  readonly #fetch: Fetch;

  constructor(baseUrl: string, tokens: TokenProvider, fetcher: Fetch = (...args) => fetch(...args)) {
    this.#base = baseUrl.replace(/\/+$/, "") + "/api/v1/";
    this.#tokens = tokens;
    this.#fetch = fetcher;
  }

  /** Unauthenticated. */
  async config(): Promise<AppConfig> {
    return decodeAppConfig(await this.#get("config", false));
  }

  async week(): Promise<Week> {
    return decodeWeek(await this.#get("week"));
  }

  async me(): Promise<Me> {
    return decodeMe(await this.#get("me"));
  }

  /** The caller's results for `date` (the server's today when omitted). */
  async myResults(date?: string): Promise<MyResults> {
    return decodeMyResults(await this.#get("me/results" + (date ? `?date=${date}` : "")));
  }

  /** The leaderboard for `date` (the server's today when omitted). */
  async leaderboard(date?: string): Promise<Leaderboard> {
    return decodeLeaderboard(await this.#get("leaderboard" + (date ? `?date=${date}` : "")));
  }

  async submitResult(result: GameResult): Promise<SubmitOutcome> {
    const headers = await this.#headers(true);
    headers["Content-Type"] = "application/json";
    const response = await this.#fetch(this.#base + "results", { method: "POST", headers, body: JSON.stringify(result) });
    if (response.status === 201) return { kind: "created", result: decodeGameResult(await response.json()) };
    if (response.status === 200) return { kind: "stored", result: decodeGameResult(await response.json()) };
    if (response.status === 400) return { kind: "rejected", error: await errorOf(response) };
    throw new ApiException(response.status, await errorOf(response));
  }

  async #get(path: string, auth = true): Promise<unknown> {
    const response = await this.#fetch(this.#base + path, { headers: await this.#headers(auth) });
    if (!response.ok) throw new ApiException(response.status, await errorOf(response));
    return response.json();
  }

  async #headers(auth: boolean): Promise<Record<string, string>> {
    const token = auth ? await this.#tokens() : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
}

async function errorOf(response: Response): Promise<ApiError | null> {
  try {
    return decodeApiError(await response.json());
  } catch {
    return null;
  }
}
