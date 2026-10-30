/**
 * Keeps the screen on while wanted, where the Screen Wake Lock API exists
 * (Safari 16.4+, Chrome 84+). The browser drops the lock whenever the page is
 * hidden, so call `set()` again after the page becomes visible.
 */
export class ScreenWakeLock {
  #wanted = false;
  #sentinel: WakeLockSentinel | null = null;
  #pending = false;

  set(wanted: boolean): void {
    this.#wanted = wanted;
    if (wanted) this.#acquire();
    else this.#release();
  }

  #acquire(): void {
    if (this.#pending || (this.#sentinel && !this.#sentinel.released)) return;
    if (!("wakeLock" in navigator) || document.hidden) return;
    this.#pending = true;
    navigator.wakeLock.request("screen").then(
      (sentinel) => {
        this.#pending = false;
        this.#sentinel = sentinel;
        // No longer wanted while the request was in flight.
        if (!this.#wanted) this.#release();
      },
      () => {
        // Refused, e.g. low battery or no user activation yet: just let the screen sleep.
        this.#pending = false;
      },
    );
  }

  #release(): void {
    const sentinel = this.#sentinel;
    this.#sentinel = null;
    sentinel?.release().catch(() => {});
  }
}
