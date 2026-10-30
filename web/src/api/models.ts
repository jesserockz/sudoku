// Request and response bodies of the v1 API, field for field as in docs/API.md,
// with decoders that check what the server (or localStorage) gave us.
import { dayOfWeek, inWeek, isIsoDate } from "../game/calendar.ts";
import { DEFAULT_LEVELS, generateDay, type Puzzle } from "../generator/generator.ts";
import { parseWeekSeed } from "../generator/week-seed.ts";
import { list, num, obj, optional, str } from "../data/store.ts";

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
}

/** One result: the body of `POST /api/v1/results` and its response. `completedAt` is RFC 3339 with offset. */
export interface GameResult {
  date: string;
  level: number;
  elapsedMs: number;
  completedAt: string;
}

/** An item of `GET /api/v1/me/results`, which omits the date. */
export type DayResult = Omit<GameResult, "date">;

/** `GET /api/v1/me/results` */
export interface MyResults {
  date: string;
  results: DayResult[];
}

/** `GET /api/v1/leaderboard` */
export interface Leaderboard {
  date: string;
  puzzles: { level: number; entries: { rank: number; userId: string; displayName: string; elapsedMs: number }[] }[];
  total: { entries: { rank: number; userId: string; displayName: string; totalMs: number }[] };
  players: { userId: string; displayName: string; completedLevels: number[] }[];
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
  return { id: str(o.id), displayName: str(o.displayName) };
}

export function decodeDayResult(json: unknown): DayResult {
  const o = obj(json);
  return { level: num(o.level), elapsedMs: num(o.elapsedMs), completedAt: str(o.completedAt) };
}

export function decodeGameResult(json: unknown): GameResult {
  return { date: date(obj(json).date), ...decodeDayResult(json) };
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
        entries: list(b.entries, (e) => {
          const x = obj(e);
          return { rank: num(x.rank), userId: str(x.userId), displayName: str(x.displayName), elapsedMs: num(x.elapsedMs) };
        }),
      };
    }),
    total: {
      entries: list(obj(o.total).entries, (e) => {
        const x = obj(e);
        return { rank: num(x.rank), userId: str(x.userId), displayName: str(x.displayName), totalMs: num(x.totalMs) };
      }),
    },
    players: list(o.players, (p) => {
      const x = obj(p);
      return { userId: str(x.userId), displayName: str(x.displayName), completedLevels: list(x.completedLevels, num) };
    }),
  };
}

