import { ApiException, type SubmitOutcome } from "../api/client.ts";
import type { EndlessResult, GameResult } from "../api/models.ts";
import { endlessGameKey } from "./app-storage.ts";
import { Mutex } from "./mutex.ts";
import type { StoredValue } from "./store.ts";

/** What one {@link ResultSync.flush} did. */
export interface FlushReport<T = GameResult> {
  /** Accepted by the server (201) or already stored there (200). */
  accepted: T[];
  /** Rejected with 400: dropped, never retried. */
  rejected: T[];
  /** Still queued because the server couldn't be reached or failed. */
  remaining: T[];
  /** Why the flush stopped early, if it did. */
  failure: unknown;
}

export const isUnauthorized = (report: FlushReport<unknown>): boolean =>
  report.failure instanceof ApiException && report.failure.isUnauthorized;

/** Daily results are one per `(date, level)`. */
export const dailyKey = (r: GameResult): string => `${r.date}/${r.level}`;
/** Endless results are one per `(generator, difficulty, number)`; see {@link endlessGameKey}. */
export const endlessKey = (r: EndlessResult): string => endlessGameKey(r.generator, r.difficulty, r.number);

/**
 * The offline result queue: completed puzzles are queued durably, then sent
 * oldest first. Per `docs/API.md`, 200/201 and 400 remove a result from the
 * queue; anything else (network failure, 401, 5xx) leaves it and the rest
 * queued for the next flush.
 *
 * At most one result per puzzle (`key`; for daily results `(date, level)`) is
 * queued; the first one wins, as on the server.
 */
export class ResultSync<T = GameResult> {
  readonly #store: StoredValue<T[]>;
  readonly #submit: (result: T) => Promise<SubmitOutcome<T>>;
  readonly #key: (result: T) => string;
  readonly #mutex = new Mutex();

  constructor(store: StoredValue<T[]>, submit: (result: T) => Promise<SubmitOutcome<T>>, key: (result: T) => string) {
    this.#store = store;
    this.#submit = submit;
    this.#key = key;
  }

  pending(): T[] {
    return this.#store.read() ?? [];
  }

  enqueue(result: T): Promise<void> {
    return this.#mutex.run(async () => {
      const queued = this.pending();
      const key = this.#key(result);
      if (!queued.some((r) => this.#key(r) === key)) this.#save([...queued, result]);
    });
  }

  flush(): Promise<FlushReport<T>> {
    return this.#mutex.run(async () => {
      const queue = this.pending();
      const accepted: T[] = [];
      const rejected: T[] = [];
      let failure: unknown = null;
      while (queue.length > 0) {
        const next = queue[0]!;
        let outcome: SubmitOutcome<T>;
        try {
          outcome = await this.#submit(next);
        } catch (e) {
          failure = e;
          break;
        }
        (outcome.kind === "rejected" ? rejected : accepted).push(next);
        queue.shift();
        this.#save(queue);
      }
      return { accepted, rejected, remaining: queue.slice(), failure };
    });
  }

  #save(results: T[]): void {
    this.#store.write(results.length > 0 ? results.slice() : null);
  }
}
