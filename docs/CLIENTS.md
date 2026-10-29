# Clients (Kotlin Multiplatform)

The Android app, the web app and their shared logic live in one Gradle build at
the repository root. The Go server in `server/` is built separately.

| Module   | What it is                                                         |
| -------- | ------------------------------------------------------------------ |
| `shared` | Pure Kotlin: board model, validation, generator, game logic, API client and the offline-first repository. Targets JVM, Android and JS. |
| `webApp` | Browser client: Compose HTML on Kotlin/JS.                         |
| `androidApp` | Android app: Jetpack Compose, offline-first.                   |

## Requirements

- JDK 25 (the current LTS; CI uses it). Gradle 9.8 also runs on JDK 17+.
- Android SDK (only for Android targets). Point Gradle at it with `ANDROID_HOME`
  or a `local.properties` file containing `sdk.dir=/path/to/android-sdk`.
- Nothing else: the Gradle wrapper downloads Gradle, and the Kotlin/JS plugin
  downloads Node.js for the JS tests.

## Tests

```sh
./gradlew :shared:jvmTest            # fastest; no Android SDK needed
./gradlew :shared:jsNodeTest         # same tests compiled to JS, run on Node.js
./gradlew :shared:testAndroidHostTest  # same tests on the Android target (needs the SDK)
```

CI (`.github/workflows/clients.yml`) runs all three on every change outside
`server/` and `deploy/`.

`kotlin-js-store/yarn.lock` pins the JS test dependencies. If a dependency
change makes the build complain that it is out of date, run
`./gradlew kotlinUpgradeYarnLock` and commit the result.

## Offline data (shared)

Both apps keep their state through `sudoku.data.SudokuRepository` in `shared`:
settings and identity, the cached week (seed and games per day), `me`, games
in progress, the server's results for today and the offline result queue
(`ResultSync`). It stores JSON documents in a small `KeyValueStore`: one file
per key on Android (`FileKeyValueStore`, e.g. `week.json`) and `localStorage`
keys prefixed `sudoku.` in the browser (`WebStorageKeyValueStore`). The rules:

- Exactly one week is kept. "Today" is the device clock in Pacific/Auckland;
  if the cached week covers it, the day's games come from its seed with no
  network. Saving a different week drops games from other weeks.
- `refresh()` syncs identity, the week, queued results and today's results;
  failures leave everything cached and queued.
- If a different account signs in with OIDC, the previous account's games and
  queued results are discarded rather than uploaded under the new account.

`SudokuRepositoryTest` in `shared/src/commonTest` covers this on every target
against an in-memory store and a fake server (Ktor `MockEngine`).

## Web app

The web client is [Compose HTML](https://github.com/JetBrains/compose-multiplatform#compose-html)
on Kotlin/JS: real DOM elements styled with plain CSS (`webApp/src/jsMain/resources/styles.css`).
It renders on every browser, including older iOS Safari, which matters because
the web client is how iPhone users play.

### Production build (served by the Go server)

```sh
./gradlew :webApp:webDist
```

This writes the static site to **`build/web/`** at the repository root:
`index.html`, `styles.css`, `sudoku.js` (plus source maps and a lazily loaded
chunk), the PWA files (`manifest.webmanifest`, `sw.js`, `icons/`). Point the server's `web_dir` (`SUDOKU_WEB_DIR`) at that directory. The
server falls back to `index.html` for unknown paths. Assets load relative to
the app's directory: a small script in `index.html` sets `<base>` to the page's
directory (treating `/auth/callback` as the root), so the same build works at
the server's root and from any static host, including under a sub-path (see
[Hosting without a server](#hosting-without-a-server)).

### Development

Run the Go server in dev auth mode on `:8080` (see `server/README.md`), then:

```sh
./gradlew :webApp:jsBrowserDevelopmentRun --continuous
```

That serves the app on <http://localhost:8081> with live reload and proxies
`/api` to `http://localhost:8080` (override with `-PapiUrl=http://host:port`).
In dev auth mode the app asks for a user id and display name and sends
`Authorization: Bearer dev:<id>:<name>`.

### Installable and offline (PWA)

The web client is an installable, offline-first Progressive Web App, and plays
offline the way the Android app does.

**Installing.** On iPhone/iPad: open the site in Safari, tap **Share → Add to
Home Screen**. On Android/desktop Chrome or Edge: use **Install app** in the
browser menu (or the install icon in the address bar). The app then opens
full-screen from its own icon.

**What works offline.** After one sign-in online, the app keeps the current
week's seed, the identity, games in progress and the result queue in
`localStorage` (via the shared repository, see above), and a service worker
keeps the app itself. Offline it opens normally, generates every day of that
week's puzzles, and plays, times and finishes them; finished puzzles queue
their results. It syncs in the background at start, when the browser reports
it's back online, when the page becomes visible again, and every 30 seconds
while the last sync failed. A new week needs one connection: until then the
app shows "Connect to the internet once this week". The leaderboard and
signing in need the server.

**iOS caveats.**

- No Background Sync on iOS: queued results upload the next time the app is
  opened (or brought back to the foreground) with a connection, not while
  it's closed. They keep the date they were played, as on Android.
- Home Screen apps keep their own storage, so the cached week, games and
  queued results survive. Safari may clear the storage of an ordinary tab
  that hasn't been used for a while (about 7 days), so iPhone users should
  play from the Home Screen icon. A Home Screen app also has its own sign-in,
  separate from Safari's.

**Service worker (`sw.js`).** Hand-written, in `webApp/src/jsMain/resources`.
It caches the app shell (`index.html`, `sudoku.js` and its chunk,
`styles.css`, the manifest and icons) in a cache named after a hash of those
files, which `webDist` writes into `sw.js` along with the file list. So every
build installs a fresh cache and deletes the old one. Requests go to the
network first and fall back to the cache when offline or after 4 seconds
without an answer. Navigations to any path (`/auth/callback?...` included)
fall back to the cached `index.html`. `/api/` and `/healthz` are never cached.
A service worker needs a secure context: HTTPS, or `http://localhost`.

Reverse proxy: serve `sw.js` with `Cache-Control: no-cache` so browsers pick
up new builds promptly (they already bypass the HTTP cache for it by default,
so this is a safeguard). Optionally serve `manifest.webmanifest` as
`application/manifest+json` (the Go server sends `text/plain`, which browsers
accept). With Caddy:

```caddyfile
@sw path /sw.js
header @sw Cache-Control "no-cache"
@manifest path /manifest.webmanifest
header @manifest Content-Type "application/manifest+json"
```

**Upgrading from earlier versions.** The first start of this version moves the
old `localStorage` keys (`devUser`, `oidc.tokens`, `pending.<id>`,
`game.<id>.*`) into the new documents, so players stay signed in and keep their
queued results and this week's games.

**Checking offline play** end to end (Playwright with Chromium) against the
Go server in dev mode serving `build/web`:

```sh
./gradlew :webApp:webDist
(cd server && go build ./cmd/sudoku-server)
SUDOKU_AUTH_MODE=dev SUDOKU_SERVER_SECRET=dev-secret-change-me SUDOKU_TIMEZONE=Pacific/Auckland \
  SUDOKU_WEB_DIR=$PWD/build/web server/sudoku-server &
node webApp/e2e/offline.js http://localhost:8080
```

It signs in, goes offline and reloads, solves a puzzle offline, checks the
result reaches `GET /api/v1/me/results` once back online, and covers the
stale-week message and the storage migration.

### Sign-in (OIDC)

When the server's `authMode` is `oidc`, the web client signs in with
Authorization Code + PKCE (S256), using the issuer, client id and scopes from
`GET /api/v1/config`:

1. **Sign in** fetches the provider's discovery document, stores a random
   `state`, `nonce` and PKCE verifier, and redirects to the authorization endpoint.
2. The provider redirects back to **`<origin>/auth/callback`**. The app checks
   `state`, exchanges the code (sending the verifier) at the token endpoint,
   stores the tokens in `localStorage` and replaces the URL with `/`. If a
   different account signs in, the previous account's games and queued
   results are discarded rather than uploaded under the new account.
3. Access tokens are refreshed with the refresh token shortly before they
   expire. If the refresh token is rejected, the app keeps playing offline
   with results queued, and shows "Sign in again".
4. **Sign out** forgets the tokens and, if the provider has an
   `end_session_endpoint`, ends the provider session too.

Authentik setup for the web client: an **OAuth2/OpenID Provider** with
client type **Public**, redirect URI `https://<your host>/auth/callback`, an
RS256 signing key, and the `openid`, `profile` and `offline_access` scopes
(the last one is what issues refresh tokens). The server's `oidc.client_id`
must be this provider's client id. The protocol code (`sudoku.auth` in
`shared`) is platform-neutral and covered by tests on every target.

### What it does

- **Today**: the day's games (generated locally from the cached week's seed;
  "today" is the device clock in Pacific/Auckland), each New, In progress
  (with time so far) or Solved.
- **Play**: tap or arrow-key to select; digits by keypad or keyboard;
  notes mode (`N`), erase (`Backspace`), undo (`Ctrl/Cmd+Z`). Conflicts are highlighted.
  The timer runs only while the puzzle is on screen and the tab is visible;
  switching away pauses it behind a "Paused" cover.
- **Results**: a solved puzzle is queued in `localStorage` and uploaded; failed
  uploads retry with the background sync above (`400` responses are dropped,
  per the API contract).
- **Leaderboard**: total and per-puzzle boards with shared ranks, plus each
  player's progress (e.g. 3/5), for today and the previous 8 days. Online
  only; offline it says so, and it loads once the connection is back.
- In-progress games are saved on every move in `localStorage`, so a reload
  or a closed tab resumes where you left off.

## Android app

```sh
./gradlew :androidApp:assembleDebug        # androidApp/build/outputs/apk/debug/
./gradlew :androidApp:testDebugUnitTest    # JVM tests, including Robolectric UI tests
```

Pass `-PsudokuServerUrl=https://sudoku.example.com` to prefill the server
address on the first-run screen. From the emulator, a dev server on the host is
`http://10.0.2.2:8080` (plain HTTP is allowed only for `10.0.2.2` and `localhost`).

How it works:

- **First run** asks for the server address, reads `/api/v1/config` and signs
  in: dev auth asks for an id and name; OIDC opens the system browser (below).
- **Offline play**: the app keeps exactly one week's seed (`week.json` in the
  app's private files). Every day of that week plays with no network; "today"
  is the device clock in Pacific/Auckland. A new week needs one connection.
- **Sync** runs at launch and whenever the app comes to the foreground:
  identity, the current week, queued uploads and today's results. Failures just
  show an "Offline" note.
- **Results** are queued on disk (`pending.json`) the moment a puzzle is solved
  and uploaded by a WorkManager job that waits for a network and retries with
  backoff; `400` responses are dropped (API contract). A result keeps the date
  it was played even if it uploads days later.
- **Timer** runs only while the puzzle is on screen. Backgrounding the app
  (`ON_STOP`) pauses it and saves the game; coming back shows a "Paused" cover
  until the player taps Resume. Games are saved on every move.
- **Leaderboard** needs a connection; it shows today and the previous 8 days.


### Android sign-in (OIDC)

Authorization Code + PKCE in the **system browser** (a Custom Tab, never a web
view, per RFC 8252), reusing the shared `sudoku.auth` code the web client uses:

- Redirect URI: **`io.github.jesserockz.sudoku:/oauth2redirect`** (a private-use
  scheme from the application id). `MainActivity` handles it (`singleTask`).
- `state` and the PKCE verifier are stored until the browser returns, are
  single-use, and expire after 15 minutes.
- Tokens are kept in app-private storage. Access tokens refresh automatically
  with the refresh token (`offline_access` scope), so a session lasts as long as
  Authentik keeps the refresh token valid.
- If the refresh token stops working, the app **keeps the identity**: puzzles
  still play offline and results stay queued, and a "Sign in again" card
  appears. If a *different* account signs in, the previous account's games and
  queued results are discarded rather than uploaded under the new account.

Authentik: the app uses the issuer and client id from `/api/v1/config` (the
same Public client as the web app), so add
`io.github.jesserockz.sudoku:/oauth2redirect` as a second redirect URI on that
provider. No server changes are needed.

## Games per day and difficulty

The server decides how many games each day has (`levels` in `/api/v1/week`,
1 to 10, default 5). There are always exactly five difficulty tiers (Easy 40,
Medium 36, Hard 32, Expert 28, Diabolical 24 givens), and the day's games are
spread across them easiest-first by `Difficulty.forLevel`: game `i` of `n`
(0-based) gets tier `round(i * 4 / (n - 1))`, in integer arithmetic.

| Games | Tiers |
| ----- | ----- |
| 1 | Hard |
| 3 | Easy, Hard, Diabolical |
| 5 | Easy, Medium, Hard, Expert, Diabolical |
| 7 | Easy, Medium ×2, Hard, Expert ×2, Diabolical |
| 10 | two of each |

Each game's puzzle seed mixes in its game number, so two games of the same tier
are different puzzles. Five games produce exactly the original puzzles. Games
of a repeated tier are titled "Medium 1", "Medium 2" and so on. The tier table
and puzzles for several counts are pinned by golden tests on every target.

## Serverless play (a shared seed)

A group can play without a server: everyone enters the same **seed** (any
passphrase, or a generated one) and gets the same daily games. The shared code
is in `sudoku.serverless`.

- **Week seed**: `HMAC-SHA256(key = UTF-8(seed), "sudoku-week:" + isoWeek)`,
  first 8 bytes, big-endian. This is the server's own derivation
  (`server/internal/seed/seed.go`) with the seed as its secret, so a seed equal
  to a server's secret plays that server's puzzles. HMAC runs on the platform's
  SHA-256 (`MessageDigest` on the JVM, WebCrypto on JS) and is checked against
  RFC 4231 and the server's test vectors on every target.
- **Seeds** are used exactly as typed, minus surrounding whitespace: case
  matters. "Generate" makes 20 characters of Crockford base32 (100 random
  bits), such as `k7mq4-xzp2a-9d3fe-b6wnh`.
- **Settings** a group must share: the seed, games per day (`levels`, 1 to 10,
  default 5) and the timezone the day turns over in (default Pacific/Auckland).
- **Share links** carry them in the URL fragment, which browsers never send to
  a server: `https://<host>/<path>/#seed=<percent-encoded>&levels=5`, plus
  `&tz=<IANA zone>` when it isn't Pacific/Auckland. Anything else in the
  fragment is ignored; a bad escape, empty seed, out-of-range `levels` or
  unknown zone makes the link invalid.
- **Share results** copies a summary of the day to paste into a message, tagged
  with a short fingerprint of the seed (e.g. `#287caf`) instead of the seed.

`SeedRepository` (also in `sudoku.serverless`) is seed mode's data layer for
both apps, in the same `KeyValueStore` as the server mode's documents: the
active seed (`seed`), and per seed (keyed by its fingerprint) games in progress
(`seed-games-<fp>`, current week only) and the history of solve times
(`seed-history-<fp>`). Switching seeds and back resumes where you were.

### Seed play on the web

- **When**: if `GET /api/v1/config` fails or isn't a Sudoku server's (e.g. a
  static host), the app goes straight to "Play with a seed". On a real server
  the sign-in screen also offers "Play with a seed instead". Opening a
  `#seed=` link always plays that seed.
- **Setup**: type any seed or press **Generate**, pick games per day and the
  timezone, or paste a share link into the seed field. The seed is kept in
  `localStorage`.
- **Share links** are adopted on open, or when pasted into the address bar of
  an open tab (`hashchange`), and the fragment is then removed from the
  address bar. A link for a different seed, or one opened while signed in to
  the server, asks before switching; **Leave seed** goes back to setup (or to
  the signed-in server).
- **Today** works as with a server (offline, timer, notes) but with no sign-in,
  uploads or leaderboard. Under the games: **Share results**, **History**
  (every solved game, newest day first), and the seed's card with the share
  link, **Copy link**, **Share…** (the system share sheet, where the browser
  has one), **Copy seed** and **Leave seed**.

### Seed play on Android

- The first-run screen has **Play with a seed** under the server address:
  enter a seed, **Generate** one, or **Paste link**; pick games per day and the
  timezone. A pasted share link's settings win. The seed is kept in the app's
  private files (`seed.json`, with `seed-games-<fp>.json` and
  `seed-history-<fp>.json` per seed).
- A share link can also be **shared to the app** from another app (Android's
  share sheet, e.g. from a message: the link is found inside the text). If it
  would replace another seed or a server sign-in, the app asks first.
- Today has **Share results** and **History** instead of the leaderboard, and
  the seed's card has **Share link** (the share sheet), **Copy link**, **Copy
  seed** and **Leave seed**. Leaving goes back to the signed-in server, or to
  the first-run screen; the seed's games and times are kept.
- Share links point at `-PsudokuShareUrl=https://<owner>.github.io/<repo>/`
  (a copy of the web client) when the build sets it, else at the server's
  address if the app has one, else they're just the `#seed=...&levels=...`
  part, which both apps accept when pasted.

### Hosting without a server

`build/web` is a plain static site, so seed play needs nothing but a static
host. Serve the directory as is, at a domain's root or under a path; the app's
URL must end in `/` (most hosts redirect `/sudoku` to `/sudoku/`). HTTPS (or
`localhost`) is needed for the service worker, the clipboard and WebCrypto.

**GitHub Pages**: in the repository's **Settings → Pages**, set the source to
**GitHub Actions**, then run the **Web (GitHub Pages)** workflow from the
Actions tab. It builds `build/web` and publishes it to
`https://<owner>.github.io/<repo>/`. It only runs when started by hand, so
nothing is published unless you choose to. Any other static host works the
same way: upload the contents of `build/web`.

**Checking it** end to end (Playwright with Chromium), at the root and under a
sub-path of plain static servers with no `/api`:

```sh
./gradlew :webApp:webDist
(cd build/web && python3 -m http.server 8090) &
mkdir -p /tmp/sub && ln -sfn "$PWD/build/web" /tmp/sub/sudoku && (cd /tmp/sub && python3 -m http.server 8091) &
node webApp/e2e/serverless.js http://localhost:8090/
node webApp/e2e/serverless.js http://localhost:8091/sudoku/
```

It generates a seed and solves a puzzle, opens the share link in a fresh
browser and checks the puzzles are identical, switches seeds and back, round
trips a Unicode seed, and starts offline. With the Go server from "Checking
offline play" running, `node webApp/e2e/serverless-on-server.js
http://localhost:8080 dev-secret-change-me` checks "Play with a seed instead"
and that the server's secret as a seed gives the server's puzzles.
