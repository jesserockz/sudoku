// Request and response bodies of the v1 API, field for field as in docs/API.md,
// with decoders that check what the server (or localStorage) gave us.
import { dayOfWeek, inWeek, isIsoDate } from "../game/calendar.ts";
import { DEFAULT_LEVELS, generateDay, type Puzzle } from "../generator/generator.ts";
import { parseWeekSeed } from "../generator/week-seed.ts";
import { type Replay, type ReplayEvent, decodeReplay, decodeReplayEvent } from "../game/replay.ts";
import { bool, list, num, obj, optional, str } from "../data/store.ts";

export interface ApiError {
  code: string;
  message: string;
}

export interface OidcConfig {
  issuer: string;
  clientId: string;
  scopes: string[];
}

/** `GET /api/v1/config` */
export interface AppConfig {
  timezone: string;
  /** May be absent when the server runs in dev auth mode. */
  oidc: OidcConfig | null;
  authMode: "oidc" | "dev";
  /** The server's release version; older servers don't send it. */
  version?: string;
}

/** `GET /api/v1/week`. The seed is 16 lowercase hex characters. */
export interface Week {
  isoWeek: string;
  seed: string;
  weekStart: string;
  weekEnd: string;
  today: string;
  dayOfWeek: number;
  timezone: string;
  /** Games per day this week (levels `1..levels`). Servers that predate it always had 5. */
  levels: number;
}

/** `GET /api/v1/me` */
export interface Me {
  id: string;
  displayName: string;
  /** May update the server (see `admin` in the server config). Older servers don't send it: false. */
  admin: boolean;
}

/** How a release's version compares with the running server's; `unknown` when either isn't semver. */
export type Comparison = "newer" | "same" | "older" | "unknown";

/** The running server binary, from `GET /api/v1/admin/releases`. */
export interface CurrentBuild {
  version: string;
  os: string;
  arch: string;
  asset: string;
  /** The server also installs each release's web client into its `web_dir`. */
  updatesWeb: boolean;
}

/** One GitHub release, from `GET /api/v1/admin/releases`. */
export interface Release {
  tag: string;
  version: string;
  name: string;
  publishedAt: string;
  prerelease: boolean;
  latest: boolean;
  current: boolean;
  comparison: Comparison;
  installable: boolean;
  notInstallableReason: string;
  url: string;
}

export type UpdateState = "idle" | "downloading" | "verifying" | "installing" | "restarting" | "failed";

/** `GET /api/v1/admin/update`, and the 202 answer of the update and rollback requests. */
export interface UpdateStatus {
  state: UpdateState;
  action: "update" | "rollback" | "";
  target: string;
  message: string;
  error: string;
  bytesDone: number;
  /** 0 when unknown. */
  bytesTotal: number;
  startedAt: string | null;
  finishedAt: string | null;
  rollbackAvailable: boolean;
}

/** `GET /api/v1/admin/releases` */
export interface ReleaseList {
  current: CurrentBuild;
  releases: Release[];
  update: UpdateStatus;
}

/**
 * One result: the body of `POST /api/v1/results` and its response. `completedAt` is RFC 3339 with offset.
 * `replay` is only sent, never returned.
 */
export interface GameResult {
  date: string;
  level: number;
  elapsedMs: number;
  completedAt: string;
  replay?: Replay;
}

/** An item of `GET /api/v1/me/results`, which omits the date. */
export type DayResult = Omit<GameResult, "date" | "replay">;

/** `GET /api/v1/me/results` */
export interface MyResults {
  date: string;
  results: DayResult[];
}

/** `GET /api/v1/leaderboard`. `suspicious` marks a result an admin flagged (older servers don't send it: false). */
export interface Leaderboard {
  date: string;
  puzzles: { level: number; entries: { rank: number; userId: string; displayName: string; elapsedMs: number; suspicious: boolean }[] }[];
  total: { entries: { rank: number; userId: string; displayName: string; totalMs: number; suspicious: boolean }[] };
  /** `players[].streak` is that player's streak as of the board's date (older servers don't send it: 0). */
  players: { userId: string; displayName: string; completedLevels: number[]; streak: number }[];
}

/** The daily streak: consecutive days with a counting result. `lastDate` is `null` when there is none. */
export interface Streak {
  current: number;
  best: number;
  lastDate: string | null;
}

/** One difficulty of the daily stats. `bestMs` and `averageMs` are `null` when nothing is solved. `recent` is oldest first. */
export interface DailyStat {
  difficulty: number;
  completed: number;
  bestMs: number | null;
  averageMs: number | null;
  recent: { date: string; level: number; elapsedMs: number }[];
}

/** One difficulty of the endless stats. `highest` is 0 when nothing is solved. */
export interface EndlessStat {
  difficulty: number;
  completed: number;
  highest: number;
  bestMs: number | null;
  averageMs: number | null;
}

/** `GET /api/v1/me/stats` */
export interface MyStats {
  today: string;
  streak: Streak;
  daily: DailyStat[];
  endless: EndlessStat[];
}

/** How a result's replay checked out on submission (`none`: submitted before the server kept replays). */
export type ReplayStatus = "valid" | "invalid" | "missing" | "none";

/** Why a result is flagged as suspicious. `flaggedBy` is `null` for the server's own (`auto`) flags. */
export interface ResultFlag {
  reason: string;
  auto: boolean;
  flaggedBy: { userId: string; displayName: string } | null;
  flaggedAt: string;
}

/** One result as admins see it, from `GET /api/v1/admin/results`. */
export interface AdminResult {
  userId: string;
  displayName: string;
  level: number;
  elapsedMs: number;
  completedAt: string;
  submittedAt: string;
  replay: ReplayStatus;
  replayError: string;
  flag: ResultFlag | null;
}

/** `GET /api/v1/admin/results` */
export interface AdminResults {
  date: string;
  levels: number;
  results: AdminResult[];
}

/** `GET /api/v1/admin/results/{date}/{level}/{userId}/replay`. `givens` is the starting grid, never the solution. */
export interface ReplayDetail extends AdminResult {
  date: string;
  levels: number;
  givens: string;
  events: ReplayEvent[];
}

/** `GET /api/v1/endless`: the seed every endless puzzle on this server comes from. Never changes. */
export interface EndlessInfo {
  seed: string;
}

/**
 * One endless result: the body of `POST /api/v1/endless/results` and its response. `difficulty` is the tier
 * (1 = Easy .. 5 = Diabolical) and `number` the puzzle's number within it. `replay` is only sent, never returned.
 */
export interface EndlessResult {
  difficulty: number;
  number: number;
  elapsedMs: number;
  completedAt: string;
  replay?: Replay;
}

/** `GET /api/v1/me/endless` */
export interface MyEndlessResults {
  results: EndlessResult[];
}

/** `GET /api/v1/endless/leaderboard`: per difficulty, how many puzzles each player has solved. */
export interface EndlessProgress {
  difficulties: {
    difficulty: number;
    players: { rank: number; userId: string; displayName: string; completed: number; highest: number; suspicious: boolean }[];
  }[];
}

/** `GET /api/v1/endless/leaderboard/{difficulty}/{number}`: one endless puzzle's times. */
export interface EndlessBoard {
  difficulty: number;
  number: number;
  entries: { rank: number; userId: string; displayName: string; elapsedMs: number; suspicious: boolean }[];
}

/** One endless result as admins see it: an {@link AdminResult} keyed by difficulty and number instead of a game of the day. */
export interface AdminEndlessResult extends Omit<AdminResult, "level"> {
  difficulty: number;
  number: number;
}

/** `GET /api/v1/admin/endless/results`: the endless results submitted on `date`. */
export interface AdminEndlessResults {
  date: string;
  results: AdminEndlessResult[];
}

/** `GET /api/v1/admin/endless/results/{difficulty}/{number}/{userId}/replay` */
export interface EndlessReplayDetail extends AdminEndlessResult {
  givens: string;
  events: ReplayEvent[];
}

/** The day's games for `date`, which must be in `week`. */
export function weekPuzzles(week: Week, date: string = week.today): Puzzle[] {
  if (!inWeek(week, date)) throw new RangeError(`${date} is outside ${week.isoWeek}`);
  return generateDay(parseWeekSeed(week.seed), dayOfWeek(date), week.levels);
}

const date = (json: unknown) => {
  const s = str(json);
  if (!isIsoDate(s)) throw new TypeError(`not a date: ${s}`);
  return s;
};

export function decodeApiError(json: unknown): ApiError {
  const e = obj(obj(json).error);
  return { code: str(e.code), message: optional(e.message, str) ?? "" };
}

export function decodeOidcConfig(json: unknown): OidcConfig {
  const o = obj(json);
  return { issuer: str(o.issuer), clientId: str(o.clientId), scopes: optional(o.scopes, (s) => list(s, str)) ?? ["openid", "profile"] };
}

export function decodeAppConfig(json: unknown): AppConfig {
  const o = obj(json);
  const authMode = str(o.authMode);
  if (authMode !== "oidc" && authMode !== "dev") throw new TypeError(`unknown auth mode: ${authMode}`);
  const version = optional(o.version, str);
  return { timezone: str(o.timezone), oidc: optional(o.oidc, decodeOidcConfig), authMode, ...(version ? { version } : {}) };
}

export function decodeWeek(json: unknown): Week {
  const o = obj(json);
  const seed = str(o.seed).toLowerCase();
  parseWeekSeed(seed);
  return {
    isoWeek: str(o.isoWeek), seed, weekStart: date(o.weekStart), weekEnd: date(o.weekEnd), today: date(o.today),
    dayOfWeek: num(o.dayOfWeek), timezone: str(o.timezone), levels: optional(o.levels, num) ?? DEFAULT_LEVELS,
  };
}

export function decodeMe(json: unknown): Me {
  const o = obj(json);
  return { id: str(o.id), displayName: str(o.displayName), admin: optional(o.admin, bool) ?? false };
}

const oneOf = <T extends string>(what: string, allowed: readonly T[]) => (json: unknown): T => {
  const s = str(json);
  if (!(allowed as readonly string[]).includes(s)) throw new TypeError(`unknown ${what}: ${s}`);
  return s as T;
};

export function decodeRelease(json: unknown): Release {
  const o = obj(json);
  return {
    tag: str(o.tag), version: str(o.version), name: optional(o.name, str) ?? "", publishedAt: optional(o.publishedAt, str) ?? "",
    prerelease: bool(o.prerelease), latest: bool(o.latest), current: bool(o.current),
    comparison: oneOf("comparison", ["newer", "same", "older", "unknown"] as const)(o.comparison),
    installable: bool(o.installable), notInstallableReason: optional(o.notInstallableReason, str) ?? "",
    url: optional(o.url, str) ?? "",
  };
}

export function decodeUpdateStatus(json: unknown): UpdateStatus {
  const o = obj(json);
  return {
    state: oneOf("update state", ["idle", "downloading", "verifying", "installing", "restarting", "failed"] as const)(o.state),
    action: optional(o.action, oneOf("action", ["update", "rollback", ""] as const)) ?? "",
    target: optional(o.target, str) ?? "", message: optional(o.message, str) ?? "", error: optional(o.error, str) ?? "",
    bytesDone: optional(o.bytesDone, num) ?? 0, bytesTotal: optional(o.bytesTotal, num) ?? 0,
    startedAt: optional(o.startedAt, str), finishedAt: optional(o.finishedAt, str),
    rollbackAvailable: optional(o.rollbackAvailable, bool) ?? false,
  };
}

export function decodeReleaseList(json: unknown): ReleaseList {
  const o = obj(json);
  const c = obj(o.current);
  return {
    current: { version: str(c.version), os: str(c.os), arch: str(c.arch), asset: str(c.asset), updatesWeb: optional(c.updatesWeb, bool) ?? false },
    releases: list(o.releases, decodeRelease),
    update: decodeUpdateStatus(o.update),
  };
}

export function decodeResultFlag(json: unknown): ResultFlag {
  const o = obj(json);
  return {
    reason: optional(o.reason, str) ?? "", auto: optional(o.auto, bool) ?? false, flaggedAt: str(o.flaggedAt),
    flaggedBy: optional(o.flaggedBy, (b) => ({ userId: str(obj(b).userId), displayName: str(obj(b).displayName) })),
  };
}

export function decodeAdminResult(json: unknown): AdminResult {
  return { level: num(obj(json).level), ...decodeAdminResultBase(json) };
}

function decodeAdminResultBase(json: unknown): Omit<AdminResult, "level"> {
  const o = obj(json);
  return {
    userId: str(o.userId), displayName: str(o.displayName), elapsedMs: num(o.elapsedMs),
    completedAt: str(o.completedAt), submittedAt: optional(o.submittedAt, str) ?? "",
    replay: oneOf("replay status", ["valid", "invalid", "missing", "none"] as const)(o.replay),
    replayError: optional(o.replayError, str) ?? "", flag: optional(o.flag, decodeResultFlag),
  };
}

export function decodeAdminResults(json: unknown): AdminResults {
  const o = obj(json);
  return { date: date(o.date), levels: num(o.levels), results: list(o.results, decodeAdminResult) };
}

export function decodeReplayDetail(json: unknown): ReplayDetail {
  const o = obj(json);
  return { ...decodeAdminResult(json), date: date(o.date), levels: num(o.levels), ...decodeReplayGame(o) };
}

function decodeReplayGame(o: Record<string, unknown>): { givens: string; events: ReplayEvent[] } {
  const givens = str(o.givens);
  if (!/^[0-9]{81}$/.test(givens)) throw new TypeError("givens must be 81 digits");
  return { givens, events: optional(o.events, (e) => list(e, decodeReplayEvent)) ?? [] };
}

export function decodeAdminEndlessResult(json: unknown): AdminEndlessResult {
  const o = obj(json);
  return { difficulty: num(o.difficulty), number: num(o.number), ...decodeAdminResultBase(json) };
}

export function decodeAdminEndlessResults(json: unknown): AdminEndlessResults {
  const o = obj(json);
  return { date: date(o.date), results: list(o.results, decodeAdminEndlessResult) };
}

export function decodeEndlessReplayDetail(json: unknown): EndlessReplayDetail {
  return { ...decodeAdminEndlessResult(json), ...decodeReplayGame(obj(json)) };
}

export function decodeEndlessInfo(json: unknown): EndlessInfo {
  const seed = str(obj(json).seed).toLowerCase();
  parseWeekSeed(seed);
  return { seed };
}

export function decodeEndlessResult(json: unknown): EndlessResult {
  const o = obj(json);
  const replay = optional(o.replay, decodeReplay);
  return {
    difficulty: num(o.difficulty), number: num(o.number), elapsedMs: num(o.elapsedMs), completedAt: str(o.completedAt),
    ...(replay ? { replay } : {}),
  };
}

export function decodeMyEndlessResults(json: unknown): MyEndlessResults {
  return { results: list(obj(json).results, decodeEndlessResult) };
}

const decodeTimeEntry = (e: unknown): EndlessBoard["entries"][number] => {
  const x = obj(e);
  return {
    rank: num(x.rank), userId: str(x.userId), displayName: str(x.displayName), elapsedMs: num(x.elapsedMs),
    suspicious: optional(x.suspicious, bool) ?? false,
  };
};

export function decodeEndlessProgress(json: unknown): EndlessProgress {
  return {
    difficulties: list(obj(json).difficulties, (d) => {
      const b = obj(d);
      return {
        difficulty: num(b.difficulty),
        players: list(b.players, (p) => {
          const x = obj(p);
          return {
            rank: num(x.rank), userId: str(x.userId), displayName: str(x.displayName), completed: num(x.completed),
            highest: num(x.highest), suspicious: optional(x.suspicious, bool) ?? false,
          };
        }),
      };
    }),
  };
}

export function decodeEndlessBoard(json: unknown): EndlessBoard {
  const o = obj(json);
  return { difficulty: num(o.difficulty), number: num(o.number), entries: list(o.entries, decodeTimeEntry) };
}

export function decodeDayResult(json: unknown): DayResult {
  const o = obj(json);
  return { level: num(o.level), elapsedMs: num(o.elapsedMs), completedAt: str(o.completedAt) };
}

export function decodeGameResult(json: unknown): GameResult {
  const replay = optional(obj(json).replay, decodeReplay);
  return { date: date(obj(json).date), ...decodeDayResult(json), ...(replay ? { replay } : {}) };
}

export function decodeMyResults(json: unknown): MyResults {
  const o = obj(json);
  return { date: date(o.date), results: list(o.results, decodeDayResult) };
}

export function decodeLeaderboard(json: unknown): Leaderboard {
  const o = obj(json);
  return {
    date: date(o.date),
    puzzles: list(o.puzzles, (p) => {
      const b = obj(p);
      return {
        level: num(b.level),
        entries: list(b.entries, decodeTimeEntry),
      };
    }),
    total: {
      entries: list(obj(o.total).entries, (e) => {
        const x = obj(e);
        return {
          rank: num(x.rank), userId: str(x.userId), displayName: str(x.displayName), totalMs: num(x.totalMs),
          suspicious: optional(x.suspicious, bool) ?? false,
        };
      }),
    },
    players: list(o.players, (p) => {
      const x = obj(p);
      return {
        userId: str(x.userId), displayName: str(x.displayName), completedLevels: list(x.completedLevels, num),
        streak: optional(x.streak, num) ?? 0,
      };
    }),
  };
}


export function decodeStreak(json: unknown): Streak {
  const o = obj(json);
  return { current: num(o.current), best: num(o.best), lastDate: optional(o.lastDate, date) };
}

export function decodeMyStats(json: unknown): MyStats {
  const o = obj(json);
  return {
    today: date(o.today),
    streak: decodeStreak(o.streak),
    daily: list(o.daily, (d) => {
      const x = obj(d);
      return {
        difficulty: num(x.difficulty), completed: num(x.completed), bestMs: optional(x.bestMs, num), averageMs: optional(x.averageMs, num),
        recent: list(x.recent, (r) => {
          const y = obj(r);
          return { date: date(y.date), level: num(y.level), elapsedMs: num(y.elapsedMs) };
        }),
      };
    }),
    endless: list(o.endless, (d) => {
      const x = obj(d);
      return {
        difficulty: num(x.difficulty), completed: num(x.completed), highest: num(x.highest),
        bestMs: optional(x.bestMs, num), averageMs: optional(x.averageMs, num),
      };
    }),
  };
}
