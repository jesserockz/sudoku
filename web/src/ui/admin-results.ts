// The admin results page's logic, free of the DOM: a day's results by level with their replay check and
// flag, opening one in the replay viewer, and flagging or unflagging it.
import type {
  AdminEndlessResult, AdminEndlessResults, AdminResult, AdminResults, EndlessReplayDetail, ReplayDetail,
} from "../api/models.ts";
import { addDays } from "../game/calendar.ts";
import { describeError } from "./admin.ts";
import { ReplayViewer } from "./replay-viewer.ts";

/** The parts of {@link SudokuApi} the results page uses. */
export interface ResultsApi {
  adminResults(date: string): Promise<AdminResults>;
  adminReplay(date: string, level: number, userId: string): Promise<ReplayDetail>;
  flagResult(date: string, level: number, userId: string, reason: string): Promise<AdminResult>;
  unflagResult(date: string, level: number, userId: string): Promise<AdminResult>;
  adminEndlessResults(date: string): Promise<AdminEndlessResults>;
  adminEndlessReplay(generator: number, difficulty: number, number: number, userId: string): Promise<EndlessReplayDetail>;
  flagEndlessResult(generator: number, difficulty: number, number: number, userId: string, reason: string): Promise<AdminEndlessResult>;
  unflagEndlessResult(generator: number, difficulty: number, number: number, userId: string): Promise<AdminEndlessResult>;
}

/** Which list the page shows: the day's games, or the endless puzzles submitted that day. */
export type ResultsMode = "daily" | "endless";

/** Names a daily result. */
export interface DailyResultKey {
  level: number;
  userId: string;
}

/** Names an endless result. */
export interface EndlessResultKey {
  /** The series: the generator version of the puzzle. */
  generator: number;
  difficulty: number;
  number: number;
  userId: string;
}

/** Which result a key names: a daily one, or an endless one. */
export type ResultKey = DailyResultKey | EndlessResultKey;

const isEndlessKey = (k: ResultKey): k is EndlessResultKey => "difficulty" in k;

const same = (a: ResultKey, b: ResultKey): boolean => {
  if (isEndlessKey(a) || isEndlessKey(b)) {
    return isEndlessKey(a) && isEndlessKey(b) && a.generator === b.generator && a.difficulty === b.difficulty && a.number === b.number && a.userId === b.userId;
  }
  return a.level === b.level && a.userId === b.userId;
};

const copyKey = (k: ResultKey): ResultKey =>
  isEndlessKey(k) ? { generator: k.generator, difficulty: k.difficulty, number: k.number, userId: k.userId } : { level: k.level, userId: k.userId };

/** The difficulties an endless list is grouped by. */
export const ENDLESS_DIFFICULTIES: readonly number[] = [1, 2, 3, 4, 5];

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

  /** The day's results for `level`, fastest first (as the server orders them). */
  resultsFor(level: number): AdminResult[] {
    return this.data?.results.filter((r) => r.level === level) ?? [];
  }

  /** The day's endless results for `difficulty`, in the server's order (by series, puzzle number, then fastest). */
  endlessResultsFor(difficulty: number): AdminEndlessResult[] {
    return this.endlessData?.results.filter((r) => r.difficulty === difficulty) ?? [];
  }

  /** The listed result for `key`, if loaded. */
  find(key: ResultKey): AdminResult | AdminEndlessResult | null {
    const list: (AdminResult | AdminEndlessResult)[] = (isEndlessKey(key) ? this.endlessData?.results : this.data?.results) ?? [];
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
      const detail = isEndlessKey(key)
        ? await this.#api.adminEndlessReplay(key.generator, key.difficulty, key.number, key.userId)
        : await this.#api.adminReplay(this.date, key.level, key.userId);
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
    return this.#change(() => isEndlessKey(key)
      ? this.#api.flagEndlessResult(key.generator, key.difficulty, key.number, key.userId, text)
      : this.#api.flagResult(this.date, key.level, key.userId, text));
  }

  unflag(key: ResultKey): Promise<void> {
    return this.#change(() => isEndlessKey(key)
      ? this.#api.unflagEndlessResult(key.generator, key.difficulty, key.number, key.userId)
      : this.#api.unflagResult(this.date, key.level, key.userId));
  }

  async #change(send: () => Promise<AdminResult | AdminEndlessResult>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    this.#changed();
    try {
      const updated = await send();
      if ("difficulty" in updated) {
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
