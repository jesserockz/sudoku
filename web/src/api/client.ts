import {
  type AdminEndlessResult, type AdminEndlessResults, type AdminResult, type AdminResults, type ApiError, type AppConfig,
  type EndlessBoard, type EndlessInfo, type EndlessProgress, type EndlessReplayDetail, type EndlessResult, type GameResult, type GeneratorInfo,
  type Leaderboard, type Me, type MyEndlessResults, type MyResults, type MyStats, type ReleaseList, type ReplayDetail, type UpdateStatus, type Week,
  decodeAdminEndlessResult, decodeAdminEndlessResults, decodeAdminResult, decodeAdminResults, decodeApiError, decodeAppConfig,
  decodeEndlessBoard, decodeEndlessInfo, decodeEndlessProgress, decodeEndlessReplayDetail, decodeEndlessResult, decodeGameResult,
  decodeGeneratorInfo, decodeLeaderboard, decodeMe, decodeMyEndlessResults, decodeMyResults, decodeMyStats, decodeReleaseList, decodeReplayDetail, decodeUpdateStatus,
  decodeWeek,
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
export type SubmitOutcome<T = GameResult> =
  | { kind: "created"; result: T }
  | { kind: "stored"; result: T }
  | { kind: "rejected"; error: ApiError | null };

/**
 * Supplies the bearer token for API calls, or `null` when signed out. `rejected`
 * is the token the API just answered 401 to: the provider should return a
 * fresher one if it can.
 */
export type TokenProvider = (rejected?: string) => Promise<string | null>;

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

  /** The caller's streak and personal stats, with the daily numbers for `generator` (the one in use now when omitted). */
  async myStats(generator?: number): Promise<MyStats> {
    return decodeMyStats(await this.#get("me/stats" + (generator === undefined ? "" : `?generator=${generator}`)));
  }

  submitResult(result: GameResult): Promise<SubmitOutcome> {
    return this.#submit("results", result, decodeGameResult);
  }

  /** The seed every endless puzzle comes from. */
  async endless(): Promise<EndlessInfo> {
    return decodeEndlessInfo(await this.#get("endless"));
  }

  /** Every endless puzzle the caller has solved. */
  async myEndlessResults(): Promise<MyEndlessResults> {
    return decodeMyEndlessResults(await this.#get("me/endless"));
  }

  submitEndlessResult(result: EndlessResult): Promise<SubmitOutcome<EndlessResult>> {
    return this.#submit("endless/results", result, decodeEndlessResult);
  }

  /** How many endless puzzles of each difficulty everyone has solved in `generator`'s series. */
  async endlessProgress(generator: number): Promise<EndlessProgress> {
    return decodeEndlessProgress(await this.#get(`endless/leaderboard?generator=${generator}`));
  }

  /** One endless puzzle's leaderboard, in `generator`'s series. */
  async endlessBoard(generator: number, difficulty: number, number: number): Promise<EndlessBoard> {
    return decodeEndlessBoard(await this.#get(`endless/leaderboard/${difficulty}/${number}?generator=${generator}`));
  }

  async #submit<T>(path: string, result: T, decode: (json: unknown) => T): Promise<SubmitOutcome<T>> {
    const response = await this.#request("POST", path, true, result);
    if (response.status === 201) return { kind: "created", result: decode(await response.json()) };
    if (response.status === 200) return { kind: "stored", result: decode(await response.json()) };
    if (response.status === 400) return { kind: "rejected", error: await errorOf(response) };
    throw new ApiException(response.status, await errorOf(response));
  }

  /** Admin only: the server's version and its recent GitHub releases. */
  async adminReleases(includePrereleases = false): Promise<ReleaseList> {
    return decodeReleaseList(await this.#get("admin/releases" + (includePrereleases ? "?prereleases=true" : "")));
  }

  /** Admin only: how the running or last update is going. */
  async adminUpdateStatus(): Promise<UpdateStatus> {
    return decodeUpdateStatus(await this.#get("admin/update"));
  }

  /** Admin only: installs release `tag` and restarts (202). `allowDowngrade` confirms a reinstall or downgrade. */
  async startUpdate(tag: string, allowDowngrade = false): Promise<UpdateStatus> {
    return this.#post("admin/update", { tag, allowDowngrade });
  }

  /** Admin only: swaps the previous binary back in and restarts (202). */
  async rollback(): Promise<UpdateStatus> {
    return this.#post("admin/rollback");
  }

  /** Admin only: every result for `date`, with replay checks and flags. */
  async adminResults(date: string): Promise<AdminResults> {
    return decodeAdminResults(await this.#get(`admin/results?date=${date}`));
  }

  /** Admin only: one result's replay, with the puzzle's givens. */
  async adminReplay(date: string, level: number, userId: string): Promise<ReplayDetail> {
    return decodeReplayDetail(await this.#get(`${resultPath(date, level, userId)}/replay`));
  }

  /** Admin only: flags a result as suspicious (shown on the leaderboard), replacing any earlier flag. */
  async flagResult(date: string, level: number, userId: string, reason: string): Promise<AdminResult> {
    return decodeAdminResult(await this.#send("PUT", `${resultPath(date, level, userId)}/flag`, { reason }));
  }

  /** Admin only: removes a result's flag. */
  async unflagResult(date: string, level: number, userId: string): Promise<AdminResult> {
    return decodeAdminResult(await this.#send("DELETE", `${resultPath(date, level, userId)}/flag`));
  }

  /** Admin only: every endless result submitted on `date`, with replay checks and flags. */
  async adminEndlessResults(date: string): Promise<AdminEndlessResults> {
    return decodeAdminEndlessResults(await this.#get(`admin/endless/results?date=${date}`));
  }

  /** Admin only: one endless result's replay, with the puzzle's givens. */
  async adminEndlessReplay(generator: number, difficulty: number, number: number, userId: string): Promise<EndlessReplayDetail> {
    return decodeEndlessReplayDetail(await this.#get(`${endlessResultPath(difficulty, number, userId)}/replay?generator=${generator}`));
  }

  /** Admin only: flags an endless result as suspicious, replacing any earlier flag. */
  async flagEndlessResult(generator: number, difficulty: number, number: number, userId: string, reason: string): Promise<AdminEndlessResult> {
    return decodeAdminEndlessResult(await this.#send("PUT", `${endlessResultPath(difficulty, number, userId)}/flag?generator=${generator}`, { reason }));
  }

  /** Admin only: removes an endless result's flag. */
  async unflagEndlessResult(generator: number, difficulty: number, number: number, userId: string): Promise<AdminEndlessResult> {
    return decodeAdminEndlessResult(await this.#send("DELETE", `${endlessResultPath(difficulty, number, userId)}/flag?generator=${generator}`));
  }

  /** Admin only: the puzzle generator in use, what is scheduled and its history. */
  async adminGenerator(): Promise<GeneratorInfo> {
    return decodeGeneratorInfo(await this.#get("admin/generator"));
  }

  /** Admin only: makes `version` the generator from next week (choosing the one in use cancels a pending change). */
  async setGenerator(version: number): Promise<GeneratorInfo> {
    return decodeGeneratorInfo(await this.#send("PUT", "admin/generator", { version }));
  }

  /** Admin only: cancels the pending generator change, if any. */
  async cancelGenerator(): Promise<GeneratorInfo> {
    return decodeGeneratorInfo(await this.#send("DELETE", "admin/generator/pending"));
  }

  async #post(path: string, body?: unknown): Promise<UpdateStatus> {
    return decodeUpdateStatus(await this.#send("POST", path, body));
  }

  async #send(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.#request(method, path, true, body);
    if (!response.ok) throw new ApiException(response.status, await errorOf(response));
    return response.json();
  }

  async #get(path: string, auth = true): Promise<unknown> {
    const response = await this.#request("GET", path, auth);
    if (!response.ok) throw new ApiException(response.status, await errorOf(response));
    return response.json();
  }

  /**
   * Sends a request, with the bearer token when `auth`. An authenticated call
   * without a token (signed out, or the session ended) fails with a 401 without
   * touching the network. If the server answers 401, the token provider is
   * asked for a fresher token, and the request is retried once if there is one.
   */
  async #request(method: string, path: string, auth: boolean, body?: unknown): Promise<Response> {
    const token = auth ? await this.#tokens() : null;
    if (auth && token === null) throw new ApiException(401, null);
    const send = (bearer: string | null) => {
      const headers: Record<string, string> = {};
      if (bearer !== null) headers.Authorization = `Bearer ${bearer}`;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      return this.#fetch(this.#base + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    };
    const response = await send(token);
    if (token === null || response.status !== 401) return response;
    const fresh = await this.#tokens(token);
    return fresh === null || fresh === token ? response : send(fresh);
  }
}

const resultPath = (date: string, level: number, userId: string) => `admin/results/${date}/${level}/${encodeURIComponent(userId)}`;

const endlessResultPath = (difficulty: number, number: number, userId: string) =>
  `admin/endless/results/${difficulty}/${number}/${encodeURIComponent(userId)}`;

async function errorOf(response: Response): Promise<ApiError | null> {
  try {
    return decodeApiError(await response.json());
  } catch {
    return null;
  }
}
