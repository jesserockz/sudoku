import { AppStorage } from "./data/app-storage.ts";
import { SudokuRepository } from "./data/repository.ts";
import { WebStorageStore } from "./data/store.ts";
import { SeedRepository } from "./serverless/seed-repository.ts";
import "./ui/app.ts";
import type { SudokuApp } from "./ui/app.ts";
import { AppController, CALLBACK_PATH } from "./ui/controller.ts";
import { watchForUpdates } from "./ui/update.ts";

const store = new WebStorageStore();
const origin = location.origin;
const app = new AppController(
  new SudokuRepository(new AppStorage(store), origin + CALLBACK_PATH, origin),
  new SeedRepository(store),
  {
    location,
    history,
    baseUri: () => document.baseURI,
    isVisible: () => !document.hidden,
    nowMs: () => performance.now(),
    wallMs: () => Date.now(),
    reloadPage: () => location.reload(),
  },
);

// A new build installs and takes over in the background; the page keeps running the old code until reloaded.
const checkForUpdate = watchForUpdates(navigator.serviceWorker, () => app.updateReady());

// Background sync: no Background Sync API on iOS, so sync whenever the app could have a connection again.
// Also asks for a new sw.js, as a long-lived page never navigates.
window.addEventListener("online", () => {
  app.sync();
  void checkForUpdate();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    app.sync();
    void checkForUpdate();
  }
});
// A share link opened in a tab that already shows the app only changes the fragment.
window.addEventListener("hashchange", () => app.onHashChange());
// Catches the day rolling over, and retries a sync that failed.
setInterval(() => app.tick(), 30_000);

// Caches the app shell for offline starts (sw.js). Needs a secure context (HTTPS or localhost).
// The path is relative to the page's <base>, so a copy hosted under a sub-path gets its own worker.
navigator.serviceWorker?.register("sw.js").catch((e) => console.warn("Service worker registration failed", e));

const root = document.createElement("sudoku-app") as SudokuApp;
document.getElementById("root")!.replaceChildren(root);
root.app = app;
app.start();
