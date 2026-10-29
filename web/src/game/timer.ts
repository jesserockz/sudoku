/**
 * Active solve time, as an immutable value the UI drives.
 *
 * Every call takes `nowMs`, a reading from a monotonic clock in milliseconds
 * (`performance.now()` in the app), so the timer is easy to test and
 * unaffected by wall-clock changes. Pausing banks the running segment;
 * resuming starts a new one.
 */
export class ElapsedTimer {
  static readonly NOT_STARTED = new ElapsedTimer(0, null);

  /** Time banked from completed running segments. */
  readonly accumulatedMs: number;
  /** Monotonic reading when the current segment started, or `null` when paused. */
  readonly #runningSinceMs: number | null;

  private constructor(accumulatedMs: number, runningSinceMs: number | null) {
    this.accumulatedMs = accumulatedMs;
    this.#runningSinceMs = runningSinceMs;
  }

  /** A paused timer holding `elapsedMs`, e.g. restored from storage. */
  static paused(elapsedMs: number): ElapsedTimer {
    if (!(elapsedMs >= 0)) throw new RangeError("elapsedMs must not be negative");
    return new ElapsedTimer(elapsedMs, null);
  }

  get isRunning(): boolean {
    return this.#runningSinceMs !== null;
  }

  elapsedMs(nowMs: number): number {
    return this.accumulatedMs + (this.#runningSinceMs === null ? 0 : Math.max(0, nowMs - this.#runningSinceMs));
  }

  resume(nowMs: number): ElapsedTimer {
    return this.isRunning ? this : new ElapsedTimer(this.accumulatedMs, nowMs);
  }

  pause(nowMs: number): ElapsedTimer {
    return this.isRunning ? new ElapsedTimer(this.elapsedMs(nowMs), null) : this;
  }
}

/** A solve time for display: `m:ss` under an hour, `h:mm:ss` from then on. Rounds down. */
export function formatDuration(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
