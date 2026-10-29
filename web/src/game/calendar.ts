/**
 * Days and weeks in the game's timezone, Pacific/Auckland by default, whatever
 * the device's own timezone. Matches the server's rules: the date is the
 * calendar date in that zone, the day of week is ISO 8601 (1 = Monday ...
 * 7 = Sunday) and the week is the ISO 8601 week containing that date, written
 * like `2026-W44`.
 *
 * Dates are ISO strings (`2026-10-26`), which compare correctly as strings.
 * Timezones come from the platform's `Intl` database.
 */
export const DEFAULT_TIMEZONE = "Pacific/Auckland";

/** The game day and ISO week containing an instant. Mirrors `GET /api/v1/week`. */
export interface WeekInfo {
  isoWeek: string;
  weekStart: string;
  weekEnd: string;
  today: string;
  dayOfWeek: number;
}

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(zone, f);
  }
  return f;
}

/** Whether `zone` is an IANA timezone this platform knows, e.g. `Europe/London`. */
export function isValidZone(zone: string): boolean {
  try {
    formatter(zone);
    return zone.trim() !== "";
  } catch {
    return false;
  }
}

/** The wall-clock fields of `epochMs` in `zone`. */
function localParts(epochMs: number, zone: string) {
  const parts: Record<string, number> = {};
  for (const p of formatter(zone).formatToParts(epochMs)) if (p.type !== "literal") parts[p.type] = Number(p.value);
  return parts as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const isoDate = (year: number, month: number, day: number) => `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
const toEpochDay = (date: string) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / DAY_MS;
const fromEpochDay = (days: number) => new Date(days * DAY_MS).toISOString().slice(0, 10);

export function isIsoDate(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && fromEpochDay(toEpochDay(text)) === text;
}

export function today(nowMs: number = Date.now(), zone: string = DEFAULT_TIMEZONE): string {
  const p = localParts(nowMs, zone);
  return isoDate(p.year, p.month, p.day);
}

export function addDays(date: string, days: number): string {
  return fromEpochDay(toEpochDay(date) + days);
}

/** ISO day of week: 1 = Monday ... 7 = Sunday. */
export function dayOfWeek(date: string): number {
  return ((((toEpochDay(date) + 3) % 7) + 7) % 7) + 1; // 1970-01-01 was a Thursday
}

/** E.g. "Monday 2026-10-26". */
export function describeDate(date: string): string {
  return `${DAY_NAMES[dayOfWeek(date) - 1]} ${date}`;
}

export function weekStart(date: string): string {
  return addDays(date, 1 - dayOfWeek(date));
}

export function isoWeek(date: string): string {
  // The ISO week-year is the year of the week's Thursday.
  const thursday = addDays(weekStart(date), 3);
  const year = +thursday.slice(0, 4);
  const dayOfYear = toEpochDay(thursday) - toEpochDay(isoDate(year, 1, 1)) + 1;
  return `${pad(year, 4)}-W${pad(Math.floor((dayOfYear - 1) / 7) + 1)}`;
}

export function weekOf(date: string): WeekInfo {
  const start = weekStart(date);
  return { isoWeek: isoWeek(date), weekStart: start, weekEnd: addDays(start, 6), today: date, dayOfWeek: dayOfWeek(date) };
}

export function weekAt(nowMs: number = Date.now(), zone: string = DEFAULT_TIMEZONE): WeekInfo {
  return weekOf(today(nowMs, zone));
}

export function inWeek(week: { weekStart: string; weekEnd: string }, date: string): boolean {
  return date >= week.weekStart && date <= week.weekEnd;
}

/**
 * `epochMs` as RFC 3339 in `zone` with its offset and whole seconds, e.g.
 * `2026-10-26T09:15:00+13:00`: the API's `completedAt` format.
 */
export function formatTimestamp(epochMs: number, zone: string = DEFAULT_TIMEZONE): string {
  const seconds = Math.floor(epochMs / 1000) * 1000;
  const p = localParts(seconds, zone);
  const offsetMin = Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - seconds) / 60_000);
  const abs = Math.abs(offsetMin);
  const offset = `${offsetMin < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${isoDate(p.year, p.month, p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${offset}`;
}
