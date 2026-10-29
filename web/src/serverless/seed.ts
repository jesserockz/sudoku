import type { Week } from "../api/models.ts";
import { DEFAULT_TIMEZONE, type WeekInfo, weekAt } from "../game/calendar.ts";
import { formatDuration } from "../game/timer.ts";
import { DEFAULT_LEVELS, checkLevels } from "../generator/generator.ts";
import { hmacSha256, randomBytes } from "../data/crypto.ts";

/**
 * Serverless play: a group shares a seed (a passphrase) instead of a server,
 * and everyone with the same seed gets the same daily puzzles.
 *
 * The weekly seed comes from the server's own KDF with the seed as its secret,
 * `HMAC-SHA256(UTF-8(seed), "sudoku-week:" + isoWeek)` truncated to its first
 * 8 bytes, read big-endian (`server/internal/seed/seed.go`). A seed equal to a
 * server's secret therefore plays exactly that server's puzzles.
 */

/** What everyone in a group has to agree on to get the same games. */
export interface SeedSettings {
  seed: string;
  /** Games per day. */
  levels: number;
  /** The timezone the day turns over in. */
  timezone: string;
}

/** Settings with defaults filled in. Throws for an empty or untrimmed seed or bad `levels`. */
export function seedSettings(seed: string, levels: number = DEFAULT_LEVELS, timezone: string = DEFAULT_TIMEZONE): SeedSettings {
  if (seed === "" || seed !== normalizeSeed(seed)) throw new RangeError("seed must be non-empty and trimmed");
  checkLevels(levels);
  return { seed, levels, timezone };
}

export function sameSettings(a: SeedSettings, b: SeedSettings): boolean {
  return a.seed === b.seed && a.levels === b.levels && a.timezone === b.timezone;
}

/** What a typed seed means: surrounding whitespace dropped, case kept. */
export function normalizeSeed(input: string): string {
  return input.trim();
}

/** The 64-bit seed of `isoWeek` (e.g. `2026-W44`) for `seed`, as 16 hex characters. */
export async function weekSeed(seed: string, isoWeek: string): Promise<string> {
  const mac = await hmacSha256(seed, "sudoku-week:" + isoWeek);
  return toHex(mac.subarray(0, 8));
}

/** The week containing `nowMs` for `settings`, shaped like the server's `GET /api/v1/week`. */
export async function seedWeek(settings: SeedSettings, nowMs: number = Date.now()): Promise<Week> {
  const info = weekAt(nowMs, settings.timezone);
  return seedWeekFor(settings, info, await weekSeed(settings.seed, info.isoWeek));
}

export function seedWeekFor(settings: SeedSettings, info: WeekInfo, seed: string): Week {
  return { ...info, seed, timezone: settings.timezone, levels: settings.levels };
}

// Crockford's base32: no I, L, O or U, so a generated seed reads aloud and types cleanly.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** A new random seed such as `k7mq4-xzp2a-9d3fe-b6wnh`: 20 characters, 100 bits from the CSPRNG. */
export function generateSeed(): string {
  // 256 is a multiple of 32, so masking each byte to 5 bits is unbiased.
  const chars = Array.from(randomBytes(20), (b) => ALPHABET[b & 0x1f]).join("");
  return chars.match(/.{5}/g)!.join("-");
}

/** A short tag for `seed`, e.g. `#3fa9c1`, to tell groups apart without revealing the seed. */
export async function fingerprint(seed: string): Promise<string> {
  return "#" + toHex((await hmacSha256(seed, "sudoku-fingerprint")).subarray(0, 3));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The "Share results" text: a short summary of the day to paste into a
 * message, since serverless play has no leaderboard. For example:
 *
 *     Sudoku 2026-10-27 #3fa9c1
 *     Easy 3:12
 *     Medium 5:40
 *     Hard -
 *     Solved 2/3 in 8:52
 *
 * `group` tells the reader which games these were: a seed's fingerprint or a name.
 */
export function resultsSummary(date: string, group: string, games: { title: string; elapsedMs: number | null }[]): string {
  const lines = [`Sudoku ${date}${group.trim() ? " " + group.trim() : ""}`];
  for (const g of games) lines.push(`${g.title} ${g.elapsedMs === null ? "-" : formatDuration(g.elapsedMs)}`);
  const solved = games.flatMap((g) => (g.elapsedMs === null ? [] : [g.elapsedMs]));
  const total = formatDuration(solved.reduce((a, b) => a + b, 0));
  lines.push(solved.length === games.length ? `Total ${total}` : `Solved ${solved.length}/${games.length} in ${total}`);
  return lines.join("\n");
}

