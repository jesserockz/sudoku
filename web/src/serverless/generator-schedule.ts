// Serverless play's choice of puzzle generator, kept the way the server keeps it: a schedule of
// `{ fromWeek, version }` entries where the latest entry not after a week applies to it. A change never
// touches the current week; it is pending until the next ISO week, and choosing the version already in
// use cancels it. Past weeks keep the version they were played with, so switching back and forth never
// changes an old puzzle (and saved games and history stay valid).
import type { PendingGenerator } from "../api/models.ts";
import { GENERATOR_CLASSIC, isGeneratorVersion } from "../generator/versions.ts";
import { list, num, obj, str } from "../data/store.ts";

export interface ScheduleEntry {
  fromWeek: string;
  version: number;
}

/** Sorts before every real ISO week (`2026-W44` and so on compare correctly as text). */
export const FIRST_WEEK = "0000-W00";

/** The schedule of a seed that has never chosen: Classic for every week. */
export const INITIAL_SCHEDULE: readonly ScheduleEntry[] = [{ fromWeek: FIRST_WEEK, version: GENERATOR_CLASSIC }];

export function decodeSchedule(json: unknown): ScheduleEntry[] {
  const entries = list(json, (e) => {
    const o = obj(e);
    const version = num(o.version);
    if (!isGeneratorVersion(version)) throw new TypeError(`unsupported generator version: ${version}`);
    return { fromWeek: str(o.fromWeek), version };
  });
  if (entries.length === 0) throw new TypeError("empty generator schedule");
  return entries.sort((a, b) => (a.fromWeek < b.fromWeek ? -1 : a.fromWeek > b.fromWeek ? 1 : 0));
}

/** The version in effect for `isoWeek`: the latest entry not after it, else Classic. */
export function versionFor(schedule: readonly ScheduleEntry[], isoWeek: string): number {
  let version = GENERATOR_CLASSIC;
  for (const e of schedule) {
    if (e.fromWeek > isoWeek) break;
    version = e.version;
  }
  return version;
}

/** The change scheduled after `thisWeek`, if any. */
export function pendingFor(schedule: readonly ScheduleEntry[], thisWeek: string): PendingGenerator | null {
  const next = schedule.find((e) => e.fromWeek > thisWeek);
  return next ? { version: next.version, fromWeek: next.fromWeek } : null;
}

/**
 * The schedule after choosing `version` as of `thisWeek`, with `nextWeek` the week after: any pending change
 * is dropped, and unless `version` is already in use a new one starts at `nextWeek`.
 */
export function choose(schedule: readonly ScheduleEntry[], thisWeek: string, nextWeek: string, version: number): ScheduleEntry[] {
  const kept = schedule.filter((e) => e.fromWeek <= thisWeek);
  return versionFor(kept, thisWeek) === version ? kept : [...kept, { fromWeek: nextWeek, version }];
}
