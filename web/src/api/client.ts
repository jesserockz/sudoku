import {
  type AdminEndlessResult, type AdminEndlessResults, type AdminResult, type AdminResults, type AdminVariantDayResult, type ApiError, type AppConfig,
  type EndlessBoard, type EndlessInfo, type EndlessProgress, type EndlessReplayDetail, type EndlessResult, type GameResult, type GeneratorSettings, type MaintenanceSettings, MAINTENANCE_CODE,
  type Leaderboard, type Me, type MyEndlessResults, type MyResults, type MyStats, type ReleaseList, type ReplayDetail, type UpdateStatus, type VariantBoard,
  type VariantDayReplayDetail, type VariantDayResult, type Week,
  decodeAdminEndlessResult, decodeAdminEndlessResults, decodeAdminResult, decodeAdminResults, decodeAdminVariantDayResult, decodeApiError, decodeAppConfig,
  decodeEndlessBoard, decodeEndlessInfo, decodeEndlessProgress, decodeEndlessReplayDetail, decodeEndlessResult, decodeGameResult,
  decodeGeneratorSettings, decodeLeaderboard, decodeMaintenanceSettings, decodeMe, decodeMyEndlessResults, decodeMyResults, decodeMyStats, decodeReleaseList, decodeReplayDetail, decodeUpdateStatus,
  decodeVariantBoard, decodeVariantDayReplayDetail, decodeVariantDayResult, decodeWeek,
} from "./models.ts";
import { type Replay, withoutColourEvents } from "../game/replay.ts";

/** What players see when signing in can't happen right now. It doesn't say why, on purpose. */
export const SIGN_IN_UNAVAILABLE = "Sign-in isn't available right now. Please try again later, and contact the admin if it still isn't working.";

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

  /** The server couldn't check the sign-in for now (503 `auth_unavailable`): keep the session and retry later. */
  get isAuthUnavailable(): boolean {
    return this.status === 503 && this.error?.code === "auth_unavailable";
  }

  /** The server is in maintenance mode (and the caller is no admin). Not every 503 is: see {@link MAINTENANCE_CODE}. */
  get isMaintenance(): boolean {
    return this.error?.code === MAINTENANCE_CODE;
  }

  /** When maintenance might end, if the server said. */
  get maintenanceUntil(): Date | null {
    return this.error?.until ?? null;
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

  /** The leaderboard for `date` (the server's today when omitted) of `generator`'s puzzles (the server's default when omitted). */
  async leaderboard(date?: string, generator?: number): Promise<Leaderboard> {
    const query = new URLSearchParams();
    if (date) query.set("date", date);
    if (generator !== undefined) query.set("generator", String(generator));
    const search = query.toString();
    return decodeLeaderboard(await this.#get("leaderboard" + (search ? `?${search}` : "")));
  }

  /** The caller's streak and personal stats, with the daily numbers for `generator` (the one in use now when omitted). */
  async myStats(generator?: number): Promise<MyStats> {
    return decodeMyStats(await this.#get("me/stats" + (generator === undefined ? "" : `?generator=${generator}`)));
  }

  submitResult(result: GameResult): Promise<SubmitOutcome> {
    return this.#submitCompat("results", result, decodeGameResult);
  }

  /** Submits a finished variant of the day. */
  submitVariantDayResult(result: VariantDayResult): Promise<SubmitOutcome<VariantDayResult>> {
    return this.#submitCompat("variant-daily/results", result, decodeVariantDayResult);
  }

  /** The variant of the day's leaderboard for `date` (the server's today when omitted). */
  async variantBoard(date?: string): Promise<VariantBoard> {
    return decodeVariantBoard(await this.#get("variant-daily/leaderboard" + (date ? `?date=${date}` : "")));
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
    return this.#submitCompat("endless/results", result, decodeEndlessResult);
  }

  /** How many endless puzzles of each difficulty everyone has solved in `generator`'s series of `variant` (0: standard Sudoku). */
  async endlessProgress(generator: number, variant = 0): Promise<EndlessProgress> {
    return decodeEndlessProgress(await this.#get(`endless/leaderboard?${seriesQuery(generator, variant)}`));
  }

  /** One endless puzzle's leaderboard, in `generator`'s series of `variant` (0: standard Sudoku). */
  async endlessBoard(generator: number, difficulty: number, number: number, variant = 0): Promise<EndlessBoard> {
    return decodeEndlessBoard(await this.#get(`endless/leaderboard/${difficulty}/${number}?${seriesQuery(generator, variant)}`));
  }

  /**
   * {@link #submit}, with one retry for a server older than the colour pen events: it refuses a replay with an
   * action it doesn't know as `invalid_result`, so the result is sent again without those events (the pens
   * are only the player's aid, and every check ignores them).
   */
  async #submitCompat<T extends { replay?: Replay }>(path: string, result: T, decode: (json: unknown) => T): Promise<SubmitOutcome<T>> {
    const outcome = await this.#submit(path, result, decode);
    if (outcome.kind !== "rejected" || outcome.error?.code !== "invalid_result") return outcome;
    const plain = withoutColourEvents(result);
    return plain === result ? outcome : this.#submit(path, plain, decode);
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

  /** Admin only: one result's replay, with the puzzle's givens. `generator` names the puzzle's generator. */
  async adminReplay(generator: number, date: string, level: number, userId: string): Promise<ReplayDetail> {
    return decodeReplayDetail(await this.#get(`${resultPath(date, level, userId)}/replay?generator=${generator}`));
  }

  /** Admin only: flags a result as suspicious (shown on the leaderboard), replacing any earlier flag. */
  async flagResult(generator: number, date: string, level: number, userId: string, reason: string): Promise<AdminResult> {
    return decodeAdminResult(await this.#send("PUT", `${resultPath(date, level, userId)}/flag?generator=${generator}`, { reason }));
  }

  /** Admin only: removes a result's flag. */
  async unflagResult(generator: number, date: string, level: number, userId: string): Promise<AdminResult> {
    return decodeAdminResult(await this.#send("DELETE", `${resultPath(date, level, userId)}/flag?generator=${generator}`));
  }

  /** Admin only: one variant of the day result's replay, with the puzzle's givens and layout. */
  async adminVariantDayReplay(date: string, userId: string): Promise<VariantDayReplayDetail> {
    return decodeVariantDayReplayDetail(await this.#get(`${variantDayPath(date, userId)}/replay`));
  }

  /** Admin only: flags a variant of the day result as suspicious, replacing any earlier flag. */
  async flagVariantDayResult(date: string, userId: string, reason: string): Promise<AdminVariantDayResult> {
    return decodeAdminVariantDayResult(await this.#send("PUT", `${variantDayPath(date, userId)}/flag`, { reason }));
  }

  /** Admin only: removes a variant of the day result's flag. */
  async unflagVariantDayResult(date: string, userId: string): Promise<AdminVariantDayResult> {
    return decodeAdminVariantDayResult(await this.#send("DELETE", `${variantDayPath(date, userId)}/flag`));
  }

  /** Admin only: every endless result submitted on `date`, with replay checks and flags. */
  async adminEndlessResults(date: string): Promise<AdminEndlessResults> {
    return decodeAdminEndlessResults(await this.#get(`admin/endless/results?date=${date}`));
  }

  /** Admin only: one endless result's replay, with the puzzle's givens (and a variant's layout). */
  async adminEndlessReplay(generator: number, difficulty: number, number: number, userId: string, variant = 0): Promise<EndlessReplayDetail> {
    return decodeEndlessReplayDetail(await this.#get(`${endlessResultPath(difficulty, number, userId)}/replay?${seriesQuery(generator, variant)}`));
  }

  /** Admin only: flags an endless result as suspicious, replacing any earlier flag. */
  async flagEndlessResult(generator: number, difficulty: number, number: number, userId: string, reason: string, variant = 0): Promise<AdminEndlessResult> {
    return decodeAdminEndlessResult(await this.#send("PUT", `${endlessResultPath(difficulty, number, userId)}/flag?${seriesQuery(generator, variant)}`, { reason }));
  }

  /** Admin only: removes an endless result's flag. */
  async unflagEndlessResult(generator: number, difficulty: number, number: number, userId: string, variant = 0): Promise<AdminEndlessResult> {
    return decodeAdminEndlessResult(await this.#send("DELETE", `${endlessResultPath(difficulty, number, userId)}/flag?${seriesQuery(generator, variant)}`));
  }

  /** Admin only: the puzzle generators players can play. */
  async adminGenerators(): Promise<GeneratorSettings> {
    return decodeGeneratorSettings(await this.#get("admin/generator"));
  }

  /** Admin only: enables exactly the generators in `enabled` (non-empty), straight away. */
  async setGenerators(enabled: number[]): Promise<GeneratorSettings> {
    return decodeGeneratorSettings(await this.#send("PUT", "admin/generator", { enabled }));
  }

  /** Admin only: whether maintenance mode is on, and the end time shown to players. */
  async adminMaintenance(): Promise<MaintenanceSettings> {
    return decodeMaintenanceSettings(await this.#get("admin/maintenance"));
  }

  /** Admin only: switches maintenance mode on or off straight away; `until` is an optional end time shown to players. */
  async setMaintenance(enabled: boolean, until: Date | null): Promise<MaintenanceSettings> {
    return decodeMaintenanceSettings(await this.#send("PUT", "admin/maintenance", { enabled, until: until ? until.toISOString() : null }));
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

/** An endless series as a query: `generator=N`, plus `&variant=V` for a variant (standard Sudoku's 0 is left out, as older servers expect). */
const seriesQuery = (generator: number, variant: number) => `generator=${generator}${variant === 0 ? "" : `&variant=${variant}`}`;

const variantDayPath = (date: string, userId: string) => `admin/variant-daily/results/${date}/${encodeURIComponent(userId)}`;

const endlessResultPath = (difficulty: number, number: number, userId: string) =>
  `admin/endless/results/${difficulty}/${number}/${encodeURIComponent(userId)}`;

async function errorOf(response: Response): Promise<ApiError | null> {
  try {
    return decodeApiError(await response.json());
  } catch {
    return null;
  }
}
