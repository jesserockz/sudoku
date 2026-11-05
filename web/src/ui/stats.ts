// The decisions behind the streak and Stats displays, kept free of the DOM so they can be unit-tested.
import type { Streak } from "../api/models.ts";
import { addDays } from "../game/calendar.ts";

/** A streak this long or longer gets a marker next to the player's name on the leaderboard. */
export const MARKER_MIN_STREAK = 2;

export const streakLabel = (days: number): string => `${days}-day streak`;

/**
 * The streak to show on `today`: a stored one goes stale while the device is offline, so a last counting day
 * before yesterday means the run has ended (the server counts a run ending yesterday as still alive).
 */
export function currentStreak(streak: Streak, today: string): number {
  return streak.lastDate !== null && streak.lastDate >= addDays(today, -1) ? streak.current : 0;
}

/** The home page's streak line, or `null` when the streak isn't known. */
export function streakSummary(streak: Streak | null, today: string): string | null {
  if (!streak) return null;
  const current = currentStreak(streak, today);
  const best = streak.best > current ? ` · best ${streak.best}` : "";
  return `${current > 0 ? streakLabel(current) : "No streak yet"}${best}`;
}

/** The leaderboard marker for a player's streak: a flame and the number, or `null` for a short streak. */
export function streakMarker(days: number): { text: string; title: string } | null {
  return days >= MARKER_MIN_STREAK ? { text: `\u{1F525}${days}`, title: streakLabel(days) } : null;
}

/**
 * Where to plot `values` (oldest first) in a `width` x `height` box, as SVG polyline points, or `null` when
 * there are fewer than two. Lower times are faster, so the axis is inverted: the fastest time is at the top
 * and a line climbing to the right means getting quicker. All-equal times run along the middle.
 */
export function sparklinePoints(values: number[], width: number, height: number, pad = 2): string | null {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const x = (i: number) => pad + (i * (width - 2 * pad)) / (values.length - 1);
  const y = (v: number) => (max === min ? height / 2 : pad + ((v - min) * (height - 2 * pad)) / (max - min));
  return values.map((v, i) => `${round(x(i))},${round(y(v))}`).join(" ");
}

const round = (n: number) => Math.round(n * 10) / 10;
