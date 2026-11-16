// Wording and time formatting for maintenance mode, kept free of the DOM so it can be unit-tested.
import type { MaintenanceState } from "../api/models.ts";

/** An end time further away than this also shows its date, not just the weekday. */
const NEAR_MS = 6 * 24 * 60 * 60 * 1000;

/** What a player is told while the server is down: scores wait on the device, nothing to do. */
export const PLAYER_BANNER = "The server is down for maintenance. Puzzles still work and your scores will upload when it's back. There's nothing you need to do.";
/** The one-line version for the play screen, which has no room for more. */
export const PLAYER_BANNER_COMPACT = "Server down for maintenance. Scores upload when it's back.";
/** Shown instead of play when this week's puzzles aren't on the device. */
export const PLAYER_TRY_LATER = "The server is down for maintenance. Please try again later.";
/** The admin's reminder. */
export const ADMIN_BANNER = "Maintenance mode is on. Players can't reach the server.";
export const ADMIN_BANNER_COMPACT = "Maintenance mode is on";

/**
 * "Back around Tue 3:00 pm", in the viewer's locale and time zone (`locale` and `timeZone` are for tests): the weekday
 * and time, plus the date when `until` is more than about six days away.
 */
export function backAround(until: Date, now: Date, locale?: string, timeZone?: string): string {
  const far = until.getTime() - now.getTime() > NEAR_MS;
  const format = new Intl.DateTimeFormat(locale, {
    weekday: "short", ...(far ? { day: "numeric", month: "short" } : {}), hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}),
  });
  return `Back around ${format.format(until)}`;
}

/** "Back around ..." for a maintenance state that has an end time, else `null`. */
export function backAroundOf(state: MaintenanceState, now: Date): string | null {
  return state.until ? backAround(state.until, now) : null;
}

/** A leaderboard or stats failure caused by maintenance: says so, with the time when it is known. */
export function maintenanceError(state: MaintenanceState, now: Date): string {
  const back = backAroundOf(state, now);
  return back ? `The server is down for maintenance. ${back}.` : PLAYER_TRY_LATER;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A date as the value of a `datetime-local` input: its local date and time, to the minute. */
export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The date a `datetime-local` input's value means in the viewer's time zone, or `null` when it is empty or not a date. */
export function fromLocalInput(value: string): Date | null {
  if (value === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
