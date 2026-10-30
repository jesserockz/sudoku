// Service worker: caches the app shell so the installed app starts offline.
//
// `npm run build` replaces BUILD_VERSION with a hash of the shell files and
// SHELL with their paths, so every build gets its own cache and an update
// replaces the old one. The API is never cached: the app keeps its own
// offline state (week, games, result queue) in localStorage.
//
// Paths are relative to the worker's scope (the app's directory), so the same
// build works at a site root or under a sub-path such as GitHub Pages' /<repo>/.
"use strict";

const BUILD_VERSION = "dev";
const SHELL = ["./", "index.html", "app/main.js", "styles.css", "manifest.webmanifest", "icons/icon.svg"];
const SCOPE = self.registration.scope;
// One cache per copy of the app, in case several live under one origin.
const SCOPE_PATH = new URL(SCOPE).pathname;
const CACHE = "sudoku-shell-" + BUILD_VERSION + "-" + SCOPE_PATH;
const INDEX = new URL("index.html", SCOPE).href;
// On a slow or captive connection, fall back to the cached shell instead of waiting.
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((path) => new Request(new URL(path, SCOPE), { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      // This copy's older caches, and those of builds that named caches without a path.
      .then((keys) => keys.filter((k) => k.startsWith("sudoku-shell-") && k !== CACHE && (k.endsWith("-" + SCOPE_PATH) || !k.includes("/"))))
      .then((old) => Promise.all(old.map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Only this site's GETs, and never the API or health check (the identity provider is another origin).
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") return;

  if (request.mode === "navigate") {
    // Any page, e.g. /auth/callback?code=...: the server answers with index.html;
    // offline, the cached index.html does the same (the app routes client-side).
    event.respondWith(networkFirst(request, INDEX));
  } else {
    event.respondWith(networkFirst(request, url.href.split("?")[0]));
  }
});

/** The network's answer (cached for next time), or the cached [fallback] URL if the network fails or is too slow. */
async function networkFirst(request, fallback) {
  const cache = await caches.open(CACHE);
  const network = fetch(request).then((response) => {
    if (response.ok && response.type === "basic") {
      cache.put(request.mode === "navigate" ? fallback : request, response.clone());
    }
    return response;
  });
  const cached = () => cache.match(fallback, { ignoreSearch: true });
  try {
    return await Promise.race([network, timeout(NETWORK_TIMEOUT_MS)]);
  } catch (e) {
    const hit = await cached();
    if (hit) return hit;
    return network; // nothing cached: let the slow network (or its error) through
  }
}

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
}
