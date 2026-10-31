# Web app

The client is a single installable web app (PWA) in `web/`: plain TypeScript
and a handful of [custom elements](https://developer.mozilla.org/en-US/docs/Web/API/Web_components),
with no framework and no runtime dependencies. It plays fully offline once
installed, on phones (including iPhone, from the Home Screen) and desktops.

| Path                 | What it is                                                         |
| -------------------- | ------------------------------------------------------------------ |
| `src/core/`          | Board model and grid geometry                                      |
| `src/generator/`     | Deterministic PRNGs, solver and puzzle generator                   |
| `src/game/`          | Game state (notes, undo, timer) and the Auckland calendar          |
| `src/api/`           | v1 API client and models, OIDC (Authorization Code + PKCE)         |
| `src/data/`          | `localStorage` documents, the offline result queue, the repository |
| `src/serverless/`    | Seed play: week-seed KDF, share links, local history               |
| `src/ui/`            | App controller and the custom elements (`<sudoku-board>`, screens) |
| `public/`            | `index.html`, `styles.css`, `sw.js`, the manifest and icons        |
| `test/`              | Unit tests (Node's test runner)                                    |
| `e2e/`               | End-to-end checks in a real browser (Playwright)                   |

## Requirements

Node.js 22.18 or later. That's all: TypeScript is the only (dev) dependency.
Node runs the `.ts` sources directly for tests and scripts; `tsc` compiles them
for the browser, one JavaScript module per source file, with no bundler.

```sh
cd web
npm ci
npm test          # unit tests
npm run check     # type-check sources, tests and scripts
npm run build     # the static site, in web/dist/
npm run dev       # http://localhost:8081, rebuilding on change
```

`npm run dev` forwards `/api` and `/healthz` to a Sudoku server on
`http://localhost:8080` (or `API_URL=http://host:port`); run one in dev auth
mode as in `server/README.md`. CI (`.github/workflows/web.yml`) type-checks,
tests and builds on every change under `web/`.

## How the UI is built

- `src/ui/controller.ts` (`AppController`) holds all app state and logic and
  fires a `change` event whenever it changes. Nothing else talks to the
  repositories.
- `<sudoku-app>` shows one screen element per phase or screen
  (`<sudoku-today>`, `<sudoku-play>`, `<sudoku-scores>`, ...) and calls its
  `update()` on every change. Screens are `Component`s (`src/ui/dom.ts`): they
  render into their own light DOM, so the one global stylesheet applies, by
  returning elements from `render()`, built with the small `h()` helper.
- Reusable elements: `<sudoku-board>` (the grid; fires `cell-select`),
  `<sudoku-keypad>` (fires `digit`) and `<action-button>` (a button that shows
  a result message, e.g. "Link copied.").

## Versions and About

The web client's version is `web/package.json`'s, bumped together with the
server's by the release workflow. `npm run build` stamps it into the
compiled `WEB_VERSION` (`src/version.ts` holds a placeholder, so the dev server
shows "dev").
The **About** button on the Today screen opens a screen showing the web
version and the server's (from `version` in `GET /api/v1/config`, fetched when
the screen opens): "unknown" for a server that doesn't report one, "Can't
reach the server" when offline, and "Not connected" when playing with a seed.
It also links to the GitHub repository and releases.
Admins (see below) also get an **Admin** button there.

## Admin

`GET /api/v1/me` reports `admin: true` for accounts the server's `[admin]`
config recognises (older servers don't send it, which reads as false). Only
those users, signed in to a server, see an **Admin** button on the About
screen, which opens the **Server admin** page. It updates the server binary
and, when the server has a `web_dir`, the web client too.

The page shows the running version and platform, and the recent GitHub
releases (prereleases only with "Show prereleases") with Latest, Current and
Prerelease badges. Each installable release has a button: "Update to",
"Reinstall" or "Downgrade to" (or "Install" when the versions can't be
compared). Choosing one asks for confirmation on the page; reinstalling and
downgrading get an extra warning, and only those send `allowDowngrade: true`.
Releases the server can't install (no asset for its platform, or no
`SHA256SUMS`) are listed with the reason.

After `POST /api/v1/admin/update` the page polls `GET /api/v1/admin/update`
every second, showing the server's message and a progress bar from
`bytesDone` / `bytesTotal` (indeterminate when the total is unknown). When the
server is `restarting` (or stops answering, as it restarts) the page polls
`GET /api/v1/config` until `version` matches the target, giving up after two
minutes, and then reports "Updated to X" or what went wrong. A failure
reported by the server shows its error. If the page is opened while an update
is under way it picks it up. When the server has a previous binary, "Roll back
to previous binary" does the same after a confirmation. Errors show the
server's message; a 403 reads "Your account isn't an admin".

The logic is in `src/ui/admin.ts` (`AdminModel`, with an injected clock and
sleep so tests don't wait); `AdminScreen` in `screens.ts` only renders it.

### Results and replays

**Results and replays** at the top of the Server admin page lists a day's
results (today first, "Earlier" goes back any number of days) under each game,
fastest first, with the player, time, how the server's [replay
check](API.md#replay-checks) went ("Replay OK", "Replay failed", "No replay",
or "Before replays" for results from before the server kept them) and whether
the result is flagged as suspicious ("auto" when the server flagged it).
Tapping one opens its replay:

- The board as it was after each action, with the cell the last action changed
  highlighted. **Digits are hidden by default**: an entered digit shows as `•`
  and each pencil mark as `·`, and action descriptions say "Placed a digit in
  R3C5" without the digit, because the admin is also a player and mustn't see
  the solution by accident. The **Reveal digits (shows the solution)** box shows
  them; it is unticked every time a replay opens and is never remembered.
- Play and Pause, a scrubber, Prev and Next (one action at a time) and 1x, 2x,
  4x and 8x speed. Playback follows the game timer, so paused time passes
  instantly; the wall clock of the current action is shown next to the timer.
- **Timing**: the timer, the wall-clock span, the wall-clock time with the
  timer running (red when shorter than the timer), time paused or closed, time
  hidden, the number of long gaps between moves (at least 30 s and 3x the
  median gap), and the entry pace: the median gap between placements and how
  much it varies, with a warning when it is steady enough to look
  machine-like (under 35% variation over at least 10 placements).
- **Actions**: every action with its timer and wall-clock time and the wall gap
  before it. Long gaps and stretches spent paused or hidden are marked; tap a
  row to jump there.
- **Flag as suspicious**, with an optional reason, or **Remove flag**. Flagged
  results show a "suspicious" marker on everyone's leaderboard but stay ranked.
  Who flagged it, when and why is only shown here.

The logic is in `src/ui/admin-results.ts` (`AdminResultsModel`) and
`src/ui/replay-viewer.ts` (`ReplayViewer`, which rebuilds each frame with the
same `Game` code the app plays with, and the timing analysis); the screens in
`replay-screens.ts` only render them.

## Puzzles

Puzzles are generated on the device, deterministically from the week's seed
(see `docs/API.md`): `generate(weekSeed, dayOfWeek, level, levels)` gives
bit-identical puzzles everywhere, using SplitMix64 and xoshiro256** on exact
64-bit `BigInt` arithmetic and a deterministic backtracking solver. The golden
tests in `test/generator.test.ts` pin the output (they are the same values the
earlier Kotlin implementation produced, so existing groups keep their
puzzles). If a change to the generator is ever intentional, bump
`GENERATOR_VERSION` and the goldens.

### Games per day and difficulty

The server decides how many games each day has (`levels` in `/api/v1/week`,
1 to 10, default 5). There are always five difficulty tiers (Easy 40, Medium
36, Hard 32, Expert 28, Diabolical 24 givens), and the day's games are spread
across them easiest-first: game `i` of `n` (0-based) gets tier
`round(i * 4 / (n - 1))`, in integer arithmetic.

| Games | Tiers |
| ----- | ----- |
| 1 | Hard |
| 3 | Easy, Hard, Diabolical |
| 5 | Easy, Medium, Hard, Expert, Diabolical |
| 7 | Easy, Medium ×2, Hard, Expert ×2, Diabolical |
| 10 | two of each |

Each game's puzzle seed mixes in its game number, so two games of the same tier
are different puzzles. Games of a repeated tier are titled "Medium 1",
"Medium 2" and so on.

## Offline data

The app keeps its state as JSON documents in `localStorage`, under keys
prefixed `sudoku.`: settings and identity, the cached week (seed and games per
day), `me`, games in progress, the server's results for today and the offline
result queue (`ResultSync`). The rules (`SudokuRepository`):

- Exactly one week is kept. "Today" is the device clock in Pacific/Auckland;
  if the cached week covers it, the day's games come from its seed with no
  network. Saving a different week drops games from other weeks.
- `refresh()` syncs identity, the week, queued results and today's results;
  failures leave everything cached and queued.
- Results are queued the moment a puzzle is solved and keep the date they were
  played. `200`/`201` and `400` responses take a result off the queue (`400`s
  are dropped, per the API contract); anything else leaves it for next time.
- If a different account signs in with OIDC, the previous account's games and
  queued results are discarded rather than uploaded under the new account.

`test/repository.test.ts` covers this against an in-memory store and a fake
server.

## Installable and offline (PWA)

**Installing.** On iPhone/iPad: open the site in Safari, tap **Share → Add to
Home Screen**. On Android/desktop Chrome or Edge: use **Install app** in the
browser menu (or the install icon in the address bar). The app then opens
full-screen from its own icon.

**What works offline.** After one sign-in online, the app keeps the current
week's seed, the identity, games in progress and the result queue in
`localStorage`, and a service worker keeps the app itself. Offline it opens
normally, generates every day of that week's puzzles, and plays, times and
finishes them; finished puzzles queue their results. It syncs in the
background at start, when the browser reports it's back online, when the page
becomes visible again, and every 30 seconds while the last sync failed. A new
week needs one connection: until then the app shows "Connect to the internet
once this week". The leaderboard and signing in need the server.

**iOS caveats.**

- No Background Sync on iOS: queued results upload the next time the app is
  opened (or brought back to the foreground) with a connection, not while
  it's closed.
- Home Screen apps keep their own storage, so the cached week, games and
  queued results survive. Safari may clear the storage of an ordinary tab
  that hasn't been used for a while (about 7 days), so iPhone users should
  play from the Home Screen icon. A Home Screen app also has its own sign-in,
  separate from Safari's.

**Service worker (`public/sw.js`).** Hand-written. It caches the app shell
(every file in `dist/`) in a cache named after a hash of those files, which
`npm run build` writes into `sw.js` along with the file list, so every build
installs a fresh cache and deletes the old one. Requests go to the network
first and fall back to the cache when offline or after 4 seconds without an
answer. Navigations to any path (`/auth/callback?...` included) fall back to
the cached `index.html`. `/api/` and `/healthz` are never cached. A service
worker needs a secure context: HTTPS, or `http://localhost`.

Reverse proxy: serve `sw.js` with `Cache-Control: no-cache` so browsers pick
up new builds promptly (they already bypass the HTTP cache for it by default,
so this is a safeguard). Optionally serve `manifest.webmanifest` as
`application/manifest+json`. With Caddy:

```caddyfile
@sw path /sw.js
header @sw Cache-Control "no-cache"
@manifest path /manifest.webmanifest
header @manifest Content-Type "application/manifest+json"
```

## Served by the Go server

Point the server's `web_dir` (`SUDOKU_WEB_DIR`) at `web/dist`. The server falls
back to `index.html` for unknown paths. Assets load relative to the app's
directory: a small script in `index.html` sets `<base>` to the page's
directory (treating `/auth/callback` as the root), so the same build works at
the server's root and from any static host, including under a sub-path.

**Checking offline play** end to end (Playwright with Chromium) against the
Go server in dev mode:

```sh
(cd web && npm run build)
(cd server && go build ./cmd/sudoku-server)
SUDOKU_AUTH_MODE=dev SUDOKU_SERVER_SECRET=dev-secret-change-me SUDOKU_TIMEZONE=Pacific/Auckland \
  SUDOKU_WEB_DIR=$PWD/web/dist server/sudoku-server &
node web/e2e/offline.cjs http://localhost:8080
node web/e2e/serverless-on-server.cjs http://localhost:8080 dev-secret-change-me
```

`web/e2e/replay.cjs` checks replays and the admin tools the same way, against
a server started with `SUDOKU_ADMIN_CLAIM=sub SUDOKU_ADMIN_VALUES=ann` and an
empty database: `node web/e2e/replay.cjs http://localhost:8080 [screenshot dir]`.

The first signs in, goes offline and reloads, solves a puzzle offline, checks
the result reaches `GET /api/v1/me/results` once back online, and covers the
stale-week message. The second checks "Play with a seed instead" and that the
server's secret as a seed gives the server's puzzles.

## Sign-in (OIDC)

When the server's `authMode` is `oidc`, the app signs in with Authorization
Code + PKCE (S256), using the issuer, client id and scopes from
`GET /api/v1/config`:

1. **Sign in** fetches the provider's discovery document, stores a random
   `state`, `nonce` and PKCE verifier, and redirects to the authorization endpoint.
2. The provider redirects back to **`<origin>/auth/callback`**. The app checks
   `state` (single-use, valid for 15 minutes), exchanges the code (sending the
   verifier) at the token endpoint, stores the tokens in `localStorage` and
   replaces the URL with `/`.
3. Access tokens are refreshed with the refresh token shortly before they
   expire. If the refresh token is rejected, the app keeps playing offline
   with results queued, and shows "Sign in again".
4. **Sign out** forgets the tokens and, if the provider has an
   `end_session_endpoint`, ends the provider session too.

Authentik setup: an **OAuth2/OpenID Provider** with client type **Public**,
redirect URI `https://<your host>/auth/callback`, an RS256 signing key, and the
`openid`, `profile` and `offline_access` scopes (the last one is what issues
refresh tokens). The server's `oidc.client_id` must be this provider's client id.

In dev auth mode the app instead asks for a user id and display name and sends
`Authorization: Bearer dev:<id>:<name>`.

## What it does

- **Today**: the day's games, each New, In progress (with time so far) or
  Solved.
- **Play**: tap or arrow-key to select; digits by keypad or keyboard; notes
  mode (`N`), erase (`Backspace`), undo (`Ctrl/Cmd+Z`), clear the board.
  Conflicts are highlighted. The timer runs only while the puzzle is on screen
  and the tab is visible; switching away pauses it behind a "Paused" cover.
  While a puzzle is being played (not paused or solved) the app holds a
  screen wake lock, where supported, so the phone does not go to sleep.
  Games are saved on every move, so a reload or a closed tab resumes where you
  left off.
- **Replays**: every game records each action (placing, erasing, notes, undo,
  clear, notes mode, pause and resume, the app hidden or shown, reloads, start
  and finish) with both the game timer and the wall clock, saved with the game
  and sent with its result (see [Replays](API.md#replays)). The controller
  records them (`AppController.update` with the action, `log` for actions that
  don't change the board); `Game` only keeps the list. A replay over the
  server's 10000-event cap is left out, and the result is then flagged.
- **Leaderboard**: total and per-puzzle boards with shared ranks, plus each
  player's progress (e.g. 3/5), for today and the previous 8 days. Online
  only; offline it says so, and it loads once the connection is back. Results
  an admin (or the server's replay check) flagged carry a red "suspicious"
  marker.

## Serverless play (a shared seed)

A group can play without a server: everyone enters the same **seed** (any
passphrase, or a generated one) and gets the same daily games
(`src/serverless/`).

- **Week seed**: `HMAC-SHA256(key = UTF-8(seed), "sudoku-week:" + isoWeek)`,
  first 8 bytes, big-endian, on WebCrypto. This is the server's own derivation
  (`server/internal/seed/seed.go`) with the seed as its secret, so a seed equal
  to a server's secret plays that server's puzzles. Tests check it against the
  server's vectors.
- **Seeds** are used exactly as typed, minus surrounding whitespace: case
  matters. "Generate" makes 20 characters of Crockford base32 (100 random
  bits), such as `k7mq4-xzp2a-9d3fe-b6wnh`.
- **Settings** a group must share: the seed, games per day (1 to 10, default 5)
  and the timezone the day turns over in (default Pacific/Auckland).
- **Share links** carry them in the URL fragment, which browsers never send to
  a server: `https://<host>/<path>/#seed=<percent-encoded>&levels=5`, plus
  `&tz=<IANA zone>` when it isn't Pacific/Auckland. Anything else in the
  fragment is ignored; a bad escape, empty seed, out-of-range `levels` or
  unknown zone makes the link invalid.
- **Share results** copies a summary of the day to paste into a message, tagged
  with a short fingerprint of the seed (e.g. `#287caf`) instead of the seed.
- **Storage**: the active seed (`seed`), and per seed (keyed by its
  fingerprint) games in progress (`seed-games-<fp>`, current week only) and the
  history of solve times (`seed-history-<fp>`). Switching seeds and back
  resumes where you were.

In the app:

- **When**: if `GET /api/v1/config` fails or isn't a Sudoku server's (e.g. a
  static host), the app goes straight to "Play with a seed". On a real server
  the sign-in screen also offers "Play with a seed instead". Opening a
  `#seed=` link always plays that seed.
- **Setup**: type any seed or press **Generate**, pick games per day and the
  timezone, or paste a share link into the seed field.
- **Share links** are adopted on open, or when pasted into the address bar of
  an open tab, and the fragment is then removed from the address bar. A link
  for a different seed, or one opened while signed in to the server, asks
  before switching; **Leave seed** goes back to setup (or to the signed-in
  server).
- **Today** works as with a server (offline, timer, notes) but with no sign-in,
  uploads or leaderboard. Under the games: **Share results**, **History**
  (every solved game, newest day first), and the seed's card with the share
  link, **Copy link**, **Share…** (the system share sheet, where the browser
  has one), **Copy seed** and **Leave seed**.

### Hosting without a server

`web/dist` is a plain static site, so seed play needs nothing but a static
host. Serve the directory as is, at a domain's root or under a path; the app's
URL must end in `/` (most hosts redirect `/sudoku` to `/sudoku/`). HTTPS (or
`localhost`) is needed for the service worker, the clipboard and WebCrypto.

**GitHub Pages**: in the repository's **Settings → Pages**, set the source to
**GitHub Actions**. Then, under **Settings → Environments → github-pages →
Deployment branches and tags**, add a tag rule for `v*`, since deploys run from
the release's tag. Publishing a release then deploys it to
`https://<owner>.github.io/<repo>/` (the **Web (GitHub Pages)** workflow), and
nothing is published until you publish a release. Any other static host works
the same way: upload the contents of `web/dist`, or unzip a release's
`sudoku-web.zip`.

**Releases**: on every push to `main`, the **Release** workflow updates a draft
release with [Release Drafter](https://github.com/release-drafter/release-drafter)
(notes from merged pull requests, grouped and versioned by their labels, see
`.github/release-drafter.yml`) and attaches fresh builds to it: the server
binaries and `sudoku-web.zip`. Publishing the draft deploys the files in that
`sudoku-web.zip` to Pages as they are, without rebuilding, so the site is
exactly what was attached to the draft. Running **Web (GitHub Pages)** by hand
redeploys the latest release, or the tag given.

**Checking it** end to end, at the root and under a sub-path of plain static
servers with no `/api`:

```sh
(cd web && npm run build)
(cd web/dist && python3 -m http.server 8090) &
mkdir -p /tmp/sub && ln -sfn "$PWD/web/dist" /tmp/sub/sudoku && (cd /tmp/sub && python3 -m http.server 8091) &
node web/e2e/serverless.cjs http://localhost:8090/
node web/e2e/serverless.cjs http://localhost:8091/sudoku/
```

It generates a seed and solves a puzzle, opens the share link in a fresh
browser and checks the puzzles are identical, switches seeds and back, round
trips a Unicode seed, and starts offline. The e2e scripts need Playwright with
Chromium (`npm i -g playwright && npx playwright install chromium`).
