import { DEFAULT_TIMEZONE, isValidZone } from "../game/calendar.ts";
import { DEFAULT_LEVELS, MAX_LEVELS } from "../generator/generator.ts";
import { normalizeSeed, seedSettings, type SeedSettings } from "./seed.ts";

/**
 * Share links carry seed settings in the URL fragment, which browsers never
 * send to a server, so the seed stays out of requests and access logs:
 * `https://host/path/#seed=<percent-encoded>&levels=5`, plus `&tz=<zone>` when
 * the timezone isn't the default.
 */

/** The fragment for `settings`, without the `#`. */
export function shareFragment(settings: SeedSettings): string {
  let f = `seed=${percentEncode(settings.seed)}&levels=${settings.levels}`;
  if (settings.timezone !== DEFAULT_TIMEZONE) f += `&tz=${percentEncode(settings.timezone)}`;
  return f;
}

/** `baseUrl` (any fragment dropped) with `settings` as its fragment. */
export function buildShareLink(baseUrl: string, settings: SeedSettings): string {
  return baseUrl.split("#")[0] + "#" + shareFragment(settings);
}

/**
 * The settings in a share link, or in just its fragment (with or without the
 * `#`). Null when there is no `seed` or anything in it is invalid: a
 * malformed escape, an empty seed, `levels` outside 1..10 or an unknown
 * timezone. Unknown parameters are ignored. A link inside a longer message
 * (e.g. text shared from a chat) is found too.
 */
export function parseShareLink(text: string): SeedSettings | null {
  const direct = parseLink(text);
  if (direct) return direct;
  for (const word of text.split(/\s+/)) {
    if (!word.includes("seed=")) continue;
    const found = parseLink(word);
    if (found) return found;
  }
  return null;
}

function parseLink(text: string): SeedSettings | null {
  const trimmed = text.trim();
  const hash = trimmed.indexOf("#");
  let fragment: string;
  if (hash >= 0) fragment = trimmed.slice(hash + 1);
  else if (trimmed.startsWith("seed=")) fragment = trimmed;
  else return null;

  const params = new Map<string, string>();
  for (const part of fragment.split("&")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    const key = percentDecode(eq < 0 ? part : part.slice(0, eq));
    const value = percentDecode(eq < 0 ? "" : part.slice(eq + 1));
    if (key === null || value === null) return null;
    if (!params.has(key)) params.set(key, value);
  }
  const rawSeed = params.get("seed");
  if (rawSeed === undefined) return null;
  const seed = normalizeSeed(rawSeed);
  if (seed === "") return null;
  const levelsText = params.get("levels");
  let levels = DEFAULT_LEVELS;
  if (levelsText !== undefined) {
    if (!/^[+-]?\d+$/.test(levelsText)) return null;
    levels = Number(levelsText);
  }
  if (!(levels >= 1 && levels <= MAX_LEVELS)) return null;
  const timezone = params.get("tz") || DEFAULT_TIMEZONE;
  if (!isValidZone(timezone)) return null;
  return seedSettings(seed, levels, timezone);
}

/** Like `encodeURIComponent`, but escaping everything outside RFC 3986's unreserved set. */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Reverses {@link percentEncode}; `+` reads as a space, as `URLSearchParams` does. Null if malformed. */
export function percentDecode(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return null;
  }
}
