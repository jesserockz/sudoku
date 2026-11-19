// The admin results page's logic, free of the DOM: a day's results by level with their replay check and
// flag, opening one in the replay viewer, and flagging or unflagging it.
import {
  type AdminEndlessResult, type AdminEndlessResults, type AdminResult, type AdminResults, type AdminVariantDayResult, type EndlessReplayDetail, type ReplayDetail,
  type VariantDayReplayDetail, variantOf,
} from "../api/models.ts";
import { addDays } from "../game/calendar.ts";
import { endlessTitle, puzzleTitle } from "../generator/generator.ts";
import { generatorName } from "../generator/versions.ts";
import { describeError } from "./admin.ts";
import { ReplayViewer } from "./replay-viewer.ts";
import { seriesName, variantDayTitle } from "./variants.ts";

/** The parts of {@link SudokuApi} the results page uses. */
export interface ResultsApi {
  adminResults(date: string): Promise<AdminResults>;
  adminReplay(generator: number, date: string, level: number, userId: string): Promise<ReplayDetail>;
  flagResult(generator: number, date: string, level: number, userId: string, reason: string): Promise<AdminResult>;
  unflagResult(generator: number, date: string, level: number, userId: string): Promise<AdminResult>;
  adminEndlessResults(date: string): Promise<AdminEndlessResults>;
  adminEndlessReplay(generator: number, difficulty: number, number: number, userId: string, variant?: number): Promise<EndlessReplayDetail>;
  flagEndlessResult(generator: number, difficulty: number, number: number, userId: string, reason: string, variant?: number): Promise<AdminEndlessResult>;
  unflagEndlessResult(generator: number, difficulty: number, number: number, userId: string, variant?: number): Promise<AdminEndlessResult>;
  adminVariantDayReplay(date: string, userId: string): Promise<VariantDayReplayDetail>;
  flagVariantDayResult(date: string, userId: string, reason: string): Promise<AdminVariantDayResult>;
  unflagVariantDayResult(date: string, userId: string): Promise<AdminVariantDayResult>;
}

/** Which list the page shows: the day's games, or the endless puzzles submitted that day. */
export type ResultsMode = "daily" | "endless";

/** Names a daily result. */
export interface DailyResultKey {
  /** The generator version of the puzzle: each has its own games of the day. */
  generator: number;
  level: number;
  userId: string;
}

/** Names an endless result. */
export interface EndlessResultKey {
  /** The series: the generator version of the puzzle. */
  generator: number;
  /** The variant, absent for standard Sudoku (0), as in the API's results. */
  variant?: number;
  difficulty: number;
  number: number;
  userId: string;
}

/** Names a variant of the day result: the list's date has only one puzzle of the kind. */
export interface VariantDayResultKey {
  variantDay: true;
  userId: string;
}

/** Which result a key names: a daily one, an endless one or a variant of the day. */
export type ResultKey = DailyResultKey | EndlessResultKey | VariantDayResultKey;

const isEndlessKey = (k: ResultKey): k is EndlessResultKey => "difficulty" in k;
const isVariantDayKey = (k: ResultKey): k is VariantDayResultKey => "variantDay" in k;

const same = (a: ResultKey, b: ResultKey): boolean => {
  if (isVariantDayKey(a) || isVariantDayKey(b)) return isVariantDayKey(a) && isVariantDayKey(b) && a.userId === b.userId;
  if (isEndlessKey(a) || isEndlessKey(b)) {
    return isEndlessKey(a) && isEndlessKey(b) && a.generator === b.generator && variantOf(a) === variantOf(b) && a.difficulty === b.difficulty
      && a.number === b.number && a.userId === b.userId;
  }
  return a.generator === b.generator && a.level === b.level && a.userId === b.userId;
};

const copyKey = (k: ResultKey): ResultKey =>
  isVariantDayKey(k)
    ? { variantDay: true, userId: k.userId }
    : isEndlessKey(k)
    ? { generator: k.generator, ...(variantOf(k) === 0 ? {} : { variant: variantOf(k) }), difficulty: k.difficulty, number: k.number, userId: k.userId }
    : { generator: k.generator, level: k.level, userId: k.userId };

/** The difficulties an endless list is grouped by. */
export const ENDLESS_DIFFICULTIES: readonly number[] = [1, 2, 3, 4, 5];

/** What the replay screen calls the result it shows: who, which puzzle, and when. A variant of the day is named by its variant only. */
export function replayHeading(d: ReplayDetail | EndlessReplayDetail | VariantDayReplayDetail): string {
  if ("variantDay" in d) return `${d.displayName}, ${variantDayTitle(d.variant)} on ${d.date}`;
  if ("difficulty" in d) return `${d.displayName}, ${seriesName(d.generator, variantOf(d))} ${endlessTitle(d.difficulty, d.number)}, submitted ${d.submittedAt.slice(0, 10)}`;
  return `${d.displayName}, ${generatorName(d.generator)} ${puzzleTitle(d.level, d.levels)} on ${d.date}`;
}

/** State of the admin results page and the replay opened from it. Fires `change` whenever anything does. */
export class AdminResultsModel extends EventTarget {
  date: string;
  /** Daily mode's list. */
  data: AdminResults | null = null;
  /** Endless mode's list. */
  endlessData: AdminEndlessResults | null = null;
  mode: ResultsMode = "daily";
  loading = false;
  /** Loading the list failed (the message), or `null`. */
  loadError: string | null = null;
  /** A flag or unflag request is in flight. */
  busy = false;
  /** Why the last flag or unflag failed, or `null`. */
  error: string | null = null;
  /** The replay being watched; `null` while it loads or when none is open. Its changes are passed on as this model's. */
  viewer: ReplayViewer | null = null;
  /** The result whose replay is open (or loading). */
  opened: ResultKey | null = null;
  viewerError: string | null = null;

  readonly #api: ResultsApi;
  readonly today: string;
  #request = 0;

  constructor(api: ResultsApi, today: string) {
    super();
    this.#api = api;
    this.today = today;
    this.date = today;
  }

  readonly #onViewerChange = (): void => this.#changed();

  #changed(): void {
    this.dispatchEvent(new Event("change"));
  }

  /** The day's results for `level` of every generator, fastest first (as the server orders them). */
  resultsFor(level: number): AdminResult[] {
    return this.data?.results.filter((r) => r.level === level) ?? [];
  }

  /** The day's endless results for `difficulty`, in the server's order (by series, puzzle number, then fastest). */
  endlessResultsFor(difficulty: number): AdminEndlessResult[] {
    return this.endlessData?.results.filter((r) => r.difficulty === difficulty) ?? [];
  }

  /** The day's variant of the day results, fastest first. */
  variantDayResults(): AdminVariantDayResult[] {
    return this.data?.variantResults ?? [];
  }

  /** The listed result for `key`, if loaded. */
  find(key: ResultKey): AdminResult | AdminEndlessResult | AdminVariantDayResult | null {
    const list: (AdminResult | AdminEndlessResult | AdminVariantDayResult)[] =
      (isVariantDayKey(key) ? this.data?.variantResults : isEndlessKey(key) ? this.endlessData?.results : this.data?.results) ?? [];
    return list.find((r) => same(r, key)) ?? null;
  }

  /** Switches between the daily and endless lists, reloading the current date's list for the new mode. */
  setMode(mode: ResultsMode): Promise<void> {
    this.mode = mode;
    return this.load();
  }

  async load(date: string = this.date): Promise<void> {
    const request = ++this.#request;
    this.date = date;
    this.loading = true;
    this.data = null;
    this.endlessData = null;
    this.#changed();
    try {
      if (this.mode === "endless") {
        const endless = await this.#api.adminEndlessResults(date);
        if (request !== this.#request) return;
        this.endlessData = endless;
      } else {
        const data = await this.#api.adminResults(date);
        if (request !== this.#request) return;
        this.data = data;
      }
      this.loadError = null;
    } catch (e) {
      if (request !== this.#request) return;
      this.loadError = describeError(e);
    }
    this.loading = false;
    this.#changed();
  }

  /** Moves the list by `days`, not past today. */
  shiftDate(days: number): Promise<void> {
    const next = addDays(this.date, days);
    return next > this.today ? Promise.resolve() : this.load(next);
  }

  /** Loads `key`'s replay into a fresh viewer (digits hidden). */
  async open(key: ResultKey): Promise<void> {
    this.close();
    const opened = copyKey(key);
    this.opened = opened;
    this.viewerError = null;
    this.#changed();
    try {
      const detail = isVariantDayKey(key)
        ? await this.#api.adminVariantDayReplay(this.date, key.userId)
        : isEndlessKey(key)
        ? await this.#api.adminEndlessReplay(key.generator, key.difficulty, key.number, key.userId, variantOf(key))
        : await this.#api.adminReplay(key.generator, this.date, key.level, key.userId);
      if (this.opened !== opened) return;
      const viewer = new ReplayViewer(detail);
      // The screens listen here only.
      viewer.addEventListener("change", this.#onViewerChange);
      this.viewer = viewer;
    } catch (e) {
      if (this.opened !== opened) return;
      this.viewerError = describeError(e);
    }
    this.#changed();
  }

  /** Closes the replay; a later {@link open} starts a new viewer, with the digits hidden again. */
  close(): void {
    this.viewer?.removeEventListener("change", this.#onViewerChange);
    this.viewer?.pause();
    this.viewer = null;
    this.opened = null;
    this.viewerError = null;
    this.#changed();
  }

  /** Flags `key` as suspicious with an optional `reason`. */
  flag(key: ResultKey, reason: string): Promise<void> {
    const text = reason.trim();
    return this.#change(() => isVariantDayKey(key)
      ? this.#api.flagVariantDayResult(this.date, key.userId, text)
      : isEndlessKey(key)
      ? this.#api.flagEndlessResult(key.generator, key.difficulty, key.number, key.userId, text, variantOf(key))
      : this.#api.flagResult(key.generator, this.date, key.level, key.userId, text));
  }

  unflag(key: ResultKey): Promise<void> {
    return this.#change(() => isVariantDayKey(key)
      ? this.#api.unflagVariantDayResult(this.date, key.userId)
      : isEndlessKey(key)
      ? this.#api.unflagEndlessResult(key.generator, key.difficulty, key.number, key.userId, variantOf(key))
      : this.#api.unflagResult(key.generator, this.date, key.level, key.userId));
  }

  async #change(send: () => Promise<AdminResult | AdminEndlessResult | AdminVariantDayResult>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    this.#changed();
    try {
      const updated = await send();
      if ("variantDay" in updated) {
        const data = this.data;
        if (data) this.data = { ...data, variantResults: data.variantResults.map((r) => (same(r, updated) ? updated : r)) };
      } else if ("difficulty" in updated) {
        const list = this.endlessData;
        if (list) this.endlessData = { ...list, results: list.results.map((r) => (same(r, updated) ? updated : r)) };
      } else if (this.data) {
        this.data = { ...this.data, results: this.data.results.map((r) => (same(r, updated) ? updated : r)) };
      }
      const viewer = this.viewer;
      if (viewer && same(viewer.detail, updated)) viewer.detail.flag = updated.flag;
    } catch (e) {
      this.error = describeError(e);
    }
    this.busy = false;
    this.#changed();
  }
}
