/** The part of `ServiceWorkerContainer` that update detection needs; tests supply a fake. */
export interface UpdateWorkers {
  /** The worker controlling the page, or `null` before the first install finishes. */
  readonly controller: unknown;
  addEventListener(type: "controllerchange", listener: () => void): void;
  /** This page's registration, if any. */
  getRegistration(): Promise<{ update(): Promise<unknown> } | undefined>;
}

/**
 * Calls `onUpdate` (once) when a newer service worker takes over a page that was
 * already running under an older one. The very first install also fires
 * `controllerchange` (sw.js claims its clients) and is not an update. Returns a
 * check that asks the browser for a new sw.js: browsers only do that on
 * navigation, so a long-lived page has to ask. It never rejects (offline is fine).
 * With no `workers` (no service worker support) it does nothing.
 */
export function watchForUpdates(workers: UpdateWorkers | undefined, onUpdate: () => void): () => Promise<void> {
  if (!workers) return async () => {};
  let hadController = workers.controller != null;
  let notified = false;
  workers.addEventListener("controllerchange", () => {
    if (!hadController) {
      hadController = true;
    } else if (!notified) {
      notified = true;
      onUpdate();
    }
  });
  return async () => {
    try {
      await (await workers.getRegistration())?.update();
    } catch (e) {
      console.warn("Update check failed", e);
    }
  };
}
