import { ApiException, type SubmitOutcome } from "../api/client.ts";
import type { GameResult } from "../api/models.ts";
import { Mutex } from "./mutex.ts";
import type { StoredValue } from "./store.ts";

/** What one {@link ResultSync.flush} did. */
export interface FlushReport {
  /** Accepted by the server (201) or already stored there (200). */
  accepted: GameResult[];
  /** Rejected with 400: dropped, never retried. */
  rejected: GameResult[];
  /** Still queued because the server couldn't be reached or failed. */
  remaining: GameResult[];
  /** Why the flush stopped early, if it did. */
  failure: unknown;
}

export const isUnauthorized = (report: FlushReport): boolean =>
  report.failure instanceof ApiException && report.failure.isUnauthorized;

/**
 * The offline result queue: completed puzzles are queued durably, then sent
 * oldest first. Per `docs/API.md`, 200/201 and 400 remove a result from the
 * queue; anything else (network failure, 401, 5xx) leaves it and the rest
 * queued for the next flush.
 *
 * At most one result per `(date, level)` is queued; the first one wins, as on
 * the server.
 */
export class ResultSync {
  readonly #store: StoredValue<GameResult[]>;
  readonly #submit: (result: GameResult) => Promise<SubmitOutcome>;
  readonly #mutex = new Mutex();

  constructor(store: StoredValue<GameResult[]>, submit: (result: GameResult) => Promise<SubmitOutcome>) {
    this.#store = store;
    this.#submit = submit;
  }

  pending(): GameResult[] {
    return this.#store.read() ?? [];
  }

  enqueue(result: GameResult): Promise<void> {
    return this.#mutex.run(async () => {
      const queued = this.pending();
      if (!queued.some((r) => r.date === result.date && r.level === result.level)) this.#save([...queued, result]);
    });
  }

  flush(): Promise<FlushReport> {
    return this.#mutex.run(async () => {
      const queue = this.pending();
      const accepted: GameResult[] = [];
      const rejected: GameResult[] = [];
      let failure: unknown = null;
      while (queue.length > 0) {
        const next = queue[0]!;
        let outcome: SubmitOutcome;
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

  #save(results: GameResult[]): void {
    this.#store.write(results.length > 0 ? results.slice() : null);
  }
}
