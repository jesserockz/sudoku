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
| `src/learn/`         | Learn: technique finders, lessons, practice positions, progress    |
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

**Puzzle generators.** The page also has a Puzzle generators card (admins
only): which generators players can play ("On: Classic and Graded") and three
buttons, **Classic**, **Graded** and **Both**, with the setting in force marked
(`aria-pressed`, and it can't be chosen again). A change applies straight away
for every player; there is no pending change and no history. A line explains
that with both on players pick one with a switch, and that results and replays
keep the generator they were played with. After a change the admin's own app
syncs, so its Daily tab follows. It uses `GET`/`PUT /api/v1/admin/generator`
(`{ "enabled": [1, 2] }`, see `docs/API.md`).

**Maintenance mode.** Another admin-only card, "Maintenance mode", switches the
server's [maintenance mode](#maintenance-mode) on or off straight away: a
checkbox, an optional "Back around" time (a `datetime-local` input in the
admin's own time zone, sent as UTC, with a **Clear** button) and **Save**. The
time is only a hint shown to players; passing it switches nothing off. It uses
`GET`/`PUT /api/v1/admin/maintenance` (`{ "enabled": true, "until": "..." }`,
see `docs/API.md`), and after a save the admin's reminder banner follows at
once.

The logic is in `src/ui/admin.ts` (`AdminModel`, with an injected clock and
sleep so tests don't wait); `AdminScreen` in `screens.ts` only renders it.
The three choices and the wording (`GENERATOR_CHOICES`, `generatorsSummary`)
are in `src/ui/generator.ts`.

### Maintenance mode

An admin switches maintenance mode on from the Admin page before deploying or
testing; the server keeps running, and answers non-admins `503` with the error
code `maintenance` (and `until` when an end time is set). The client keys off the
code, never the status, since other 503s exist. Admins are served as usual.
Wording and time formatting are in `src/ui/maintenance.ts`.

**Players.** `AppController.maintenance` (`{ until: Date | null }` or `null`) is
set by a sync, a leaderboard, stats or endless board request that gets
the maintenance error, and cleared by the next sync that succeeds. While it is
set the 30-second `tick()` retries the sync, as for being offline, so the state
clears by itself, without a reload, and the queued results upload then. Results
solved meanwhile stay in the offline queue: a 503 is neither accepted nor
rejected, so nothing is dropped (a sync that finds maintenance part way through
the upload also keeps the rest queued). There is no error notice; instead:

- With this week's puzzles on the device, a banner above every screen says "The
  server is down for maintenance. Puzzles still work and your scores will upload
  when it's back. There's nothing you need to do." with "Back around Tue 3:00 pm"
  when an end time is known. The time is formatted with `Intl.DateTimeFormat` in
  the player's locale and time zone (weekday and time; the date too when it is
  more than six days away). Play carries on offline as usual.
- Without them (a fresh device, or a week the cache doesn't cover), the Today
  screen shows "The server is down for maintenance. Please try again later."
  (plus the "Back around" line) with a Try again button, instead of the puzzle
  list; the Endless tab says the same when its seed was never downloaded.
- The leaderboards and Stats say "The server is down for maintenance. Back around
  Tue 3:00 pm." (or "Please try again later.") instead of a generic error.
- Signing in still works (authentication runs first); an OIDC sign-in during
  maintenance ends up signed in with the banner and no "couldn't sync" notice.

**Admins.** They are served normally, so there is no 503 to learn from: after
each sync the app reads `maintenance` from `GET /api/v1/config` (older servers
omit it, which is off), and the Admin page updates it when it saves. While on,
every screen carries a big red reminder, "Maintenance mode is on. Players can't
reach the server.", with "Players see: Back around ..." when an end time is set
and a **Switch off in Admin** button that opens the Admin page, where the
Maintenance mode card has the switch.

**The play screen** fills the viewport exactly, so there both banners shrink to
one fixed-height line (28 px, ellipsis for long text; "Maintenance. Back around
..." for players, "Maintenance mode is on" and an **Admin** button for admins)
and the screen gives up that height through the `--banner-h` custom property
instead of scrolling. The colours are the `--maint-*` tokens in `styles.css`,
with light and dark values; the admin banner is solid red with white text and a
heavier border so it is unmistakable next to the player's pale amber one.

`web/e2e/maintenance.cjs <url> [screenshot dir]` (a dev-auth server with `ann` as
admin and an empty database) drives all of it with two browser contexts.

### Results and replays

**Results and replays** at the top of the Server admin page lists a day's
results (today first, "Earlier" goes back any number of days) under each game,
fastest first, with the player, time, how the server's [replay
check](API.md#replay-checks) went ("Replay OK", "Replay failed", "No replay",
or "Before replays" for results from before the server kept them) and whether
the result is flagged as suspicious ("auto" when the server flagged it; only
admins see an automatic flag until one is confirmed).
Tapping one opens its replay:

- The board as it was after each action, with the cell the last action changed
  highlighted. It is the game's own board, read-only, so digits and notes look
  the same as in the game, colour pens included.
  **Digits are hidden by default**: an entered digit shows as `•`, a cell's
  pencil marks as one `•` each in its first note slots (a mark's own slot would
  give its digit away), and action descriptions say "Placed a digit in
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
- **Flag as suspicious**, with an optional reason, or **Remove flag**. A flag
  the server added automatically also has **Confirm flag**, which flags it as
  you. Results flagged by an admin show a "suspicious" marker on everyone's
  leaderboard but stay ranked; automatic flags are admin-only until confirmed.
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

### Generator v2 ("Graded")

`src/generator/generator-v2.ts` is a second generator that grades puzzles by
the techniques a person would need, instead of by how many clues they have.
Daily and endless puzzles use it when the [generator setting](#generator-setting)
enables it. v1 above is unchanged, and its
goldens still pass.

- **The grader** (`src/generator/grader.ts`) solves a grid one step at a time:
  it tries the techniques in a fixed order, applies only the first one that
  works, then starts again from the first. The order is hidden single, naked
  single, locked candidates (pointing, claiming), naked and hidden pairs,
  triples and quads, X-Wing, Swordfish, XY-Wing, XYZ-Wing, simple colouring and
  XY-chains. Each technique has a level 1 to 6; a puzzle's grade is the
  hardest level it needed, or 7 if the grader got stuck (never accepted).
  Everything is integer and bitmask maths with documented scan orders, so the
  Go port gives identical grades.
- **Bands** (`BANDS`): Easy needs level 1 only, Medium level 2, Hard levels 3
  to 4, Expert level 5 and Diabolical level 6. Easy and Medium stop removing
  clues at 38 and 30; the others remove every clue they can.
- **Building** (`buildV2`): up to 200 attempts, each a random solution with
  cells removed and then graded; the first attempt inside the band wins. If
  none is, the non-stuck attempt nearest the band is used (the easier on equal
  distance, then the earliest). Seeds use their own version constant (2), so
  they never equal v1's. `generateV2` and `generateEndlessV2` return the usual
  `Puzzle` / `EndlessPuzzle` plus the grade and the attempts used.
- **Shared fixture**: `testdata/generator-v2.json` (at the repo root) holds the
  expected daily, endless, forced-fallback and grader results. The web tests
  (`test/generator-v2.test.ts`) and the server's Go tests read it, so the two
  implementations must agree. Regenerate it, only when a change is intentional,
  with `node scripts/generator-v2-fixture.ts`.

### Variants engine

`src/generator/variants.ts` builds the endless puzzles of the variants
(Diagonal, Jigsaw, Killer) for both generators:
`generateEndlessVariant(generator, variant, endlessSeed, tier, number)` returns
a `VariantPuzzle` (an `EndlessPuzzle` with `generator`, `variant` and
`layout`). Variant 0 is `generateEndlessVersion`'s puzzle unchanged.

- **Layouts** (`src/core/layout.ts`): a `Layout` holds a variant's units
  (rows, columns, regions, diagonals), peers and killer cages; `regions` is a
  region index per cell (the boxes, or a jigsaw's regions) and `cages` is
  `{ cells, sum }[]`, which is what the board needs to draw and check a
  variant. `Layout.STANDARD`, `Layout.DIAGONAL`, `Layout.jigsaw(regions)` and
  `Layout.killer(cages)` build them; `isValid(cells)` checks a grid.
- **Solver** (`src/generator/layout-solver.ts`): backtracking under any layout
  with cage sum pruning and a node budget; standard puzzles keep `solver.ts`.
- **Grader**: `grade(cells, layout)` grades under a layout; killer layouts
  add cage combinations, the 45 rule, cage pointing and the 45 rule over lines
  (`KILLER_TECHNIQUES`). Standard grading is unchanged.
- Seeds, layouts, tiers and levels are specified in `docs/API.md` (Variants).
  The shared fixture `testdata/variants.json` (regenerate with
  `node scripts/variants-fixture.ts`) pins the Go port. Generation takes a
  few milliseconds typically; the slowest measured (Graded Killer, the
  hardest tiers) took 0.74 s before the Killer rule of two empty cells per
  cage, about 1.8 s since (see `docs/API.md`).

### Generator setting

The puzzle generators are **Classic** (v1) and **Graded** (v2) (`generatorName`
in `src/generator/versions.ts`, which also holds `generateDayVersion`, the one
place that picks the generator for a version, and `enabledGenerators`, which
checks a set). The setting is which of them players can play: Classic, Graded
or both (`[1]`, `[2]` or `[1, 2]`, always ascending). The same rules apply with
a server and in serverless play:

- A change applies straight away. Results, replays and saved games keep the
  generator they were played with, so turning one off and on again loses
  nothing, and a game started before a change can still be finished and
  uploaded (the server accepts any known generator).
- With a server, `GET /api/v1/week` lists the enabled ones (`generators`;
  `Week.generators`). An older server that only sends `generator` (or nothing)
  reads as that one alone (or Classic). The first enabled is the **default**:
  the server assumes it for a request or result that doesn't name one.
- The generator the Daily, Endless and Variants tabs play is `AppController.generator`:
  the player's pick while it is enabled, else the default. With one enabled
  there is nothing to pick and that one plays. With both enabled, all three tabs
  show a **Classic | Graded** switch (`.generator-switch`, styled like Stats'
  `.generator-tabs`) with a "What's this?" link; `chooseGenerator` stores the
  pick in `sudoku.generator` (one per device, shared by the tabs and by
  serverless play, kept across sign-out) and reloads the day.
- Each generator has its own daily puzzles (`weekPuzzles(week, generator,
  date)`; the puzzle caches key on it), saved games (Classic keeps its
  `date/level` keys, others are prefixed `g2/`, as endless ones are:
  `gameKey`), results (`GameResult.generator`, sent with the result; one queued
  by an older app has none and counts as the default's), leaderboard
  (`GET /leaderboard?generator=N`; the `scores` screen keeps its generator, and
  has the switch, without the link, while both are on), stats (the Stats
  screen opens on the generator in use) and Endless series (see
  [Endless puzzles](#endless-puzzles)). The play screen names the generator
  ("Graded · Easy") while both are on. Admin result lists name it, and the
  per-result replay and flag calls send `?generator=`.
- **About** has a "Puzzle generator" row (or "Puzzle generators" with both),
  naming the enabled ones.
- A "Classic and Graded puzzles" explainer (`generatorHelp` in
  `src/ui/generator.ts`, shown by the help dialog as the `generators` topic)
  describes both generators and the five Graded levels. Its first line depends
  on the setting: with both enabled "You can play Classic or Graded: pick with
  the switch on the Daily, Endless and Variants tabs."; with a server and one enabled
  just "Puzzles here use Graded." (no word of a choice, so players don't ask
  for the other); in serverless play with one "This seed's puzzles use
  Classic.", and its closing line points to the seed card. It opens from the
  "What's this?" links next to the switch and in the seed card's Puzzle
  generators section, and from the "Classic and Graded" button on **About**.
- Admins change it on the [Server admin](#admin) page; serverless play has it
  in the seed card (see [Serverless play](#serverless-play-a-shared-seed)).

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
prefixed `sudoku.`: settings and identity, the cached week (seed, games per
day and enabled generators), `me`, games in progress (`games`, keyed by
`gameKey`: `date/level` for Classic, `g2/date/level` for Graded), endless and
variant games and results (see [Endless puzzles](#endless-puzzles) and
[Variants](#variants)), the server's
results for today (each with its generator), the player's Classic / Graded
pick (`generator`, kept on sign-out), the last
streak (`streak`, from `GET /api/v1/me/stats`; cleared on sign-out) and the offline
result queue (`ResultSync`). Games and queued results are parked per user on
sign-out (`parked-progress`, see below). The rules (`SudokuRepository`):

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
- **Signing out keeps the player's progress on the device**, so it can't be
  used to restart a ranked puzzle with a fresh timer. `AppStorage.parkProgress`
  sets the signed-in user's games (daily, endless, variant of the day: saved
  `elapsedMs` included) and queued results aside under `parked-progress`,
  keyed by `me.id`, replacing any older entry for that id (nothing is parked
  when the user was never synced or has nothing to keep). Everything else tied
  to the user is cleared as before. When that same user signs in again, either
  way (dev or OIDC), `SudokuRepository` restores the entry as soon as `me` is
  known (`#restoreParked`) and removes it from the parked record; the normal
  sync then flushes the restored queues under the right account. A game
  already live under the same key is kept unless the parked one has more time
  on it; queues are merged without duplicates, a live result winning over a
  parked one for the same puzzle. Another account signing in on the same
  device never sees the entry, and it stays for its owner.

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

**Updates.** A new build's `sw.js` installs, activates and takes over open
pages immediately (`skipWaiting` and `clients.claim`), but a page keeps running
the JavaScript it loaded. `src/ui/update.ts` listens for `controllerchange`
and, if the page was already under a worker (the first-ever install doesn't
count), calls `AppController.updateReady()`; `<sudoku-app>` then shows an "A new
version is available" banner with a **Reload** button (`applyUpdate()`, which
reloads through `Host.reloadPage`). Browsers only re-check `sw.js` on
navigation, so `main.ts` also asks (`registration.update()`) whenever the
browser comes back online or the page becomes visible; failures, such as being
offline, are ignored.

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
`web/e2e/stats.cjs` (same server, any database) seeds daily results on
consecutive days through the API and checks the home streak, the Stats screen
and the leaderboard's streak markers, with screenshots (including dark mode):
`node web/e2e/stats.cjs http://localhost:8080 [screenshot dir]`.
`web/e2e/endless.cjs` (same server, any database) plays and submits an endless
puzzle with a reload part way, and checks the tab, the leaderboards, that a
second player gets the same puzzle and the admin list.
`web/e2e/endless-series.cjs <url> [screenshot dir]` (same server, with `ann`
as admin) checks the Classic and Graded series: it enables one generator at a
time through the admin API, plays both series and checks the unfinished game
left in the other one, the leaderboards and Stats, and leaves Classic on.
`web/e2e/generator.cjs <url> [screenshot dir]` (same server) checks the
[generator setting](#generator-setting): the admin card's Classic / Graded /
Both, a player's view with one generator (no switch, the explainer naming it)
and with both (the switch on Daily and Endless, the pick kept, a Graded daily
solved and on the Graded leaderboard only, Stats on the pick, the admin list
naming the generator), and the seed card's choices, switch, history and the
migration of an old schedule. It leaves the server on Classic.
`web/e2e/variants.cjs <url> [screenshot dir]` (same server, with `ann` as
admin) checks the [Variants](#variants) tab: the first-visit explainer and its
rules, the picker (Diagonal first, remembered with the tab across a reload),
Easy #1 of each variant drawn with its layout (17 shaded diagonal cells; bold
jigsaw borders that aren't the boxes'; 81 caged cells, a dashed outline and one
sum per cage adding up to 405), a digit that only breaks the diagonal (or a
jigsaw region) shown as a conflict, Killer Easy #1 solved through the UI with
the solution from the app's own generator (it imports `src/generator/variants.ts`,
which Node runs as TypeScript, with the endless seed from `localStorage`), the
result on the server with the variant, the Killer leaderboard (and not the
Jigsaw one), the puzzle's board, the Stats Variants card, the admin replay with
its cages, and the Variants tab in seed play. Screenshots are at phone width,
in light and dark, with notes and a colour pen on the killer board.

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
   expire, and once more (followed by a single retry of the request) when the
   API answers 401 to a token the app thought was valid, e.g. after a clock
   difference or a signing key change. A refresh that fails for any reason
   other than the provider rejecting the refresh token (offline, 429, 5xx)
   keeps the session: the app says "Sign-in isn't available right now. Please
   try again later, and contact the admin if it still isn't working.", adds
   that puzzles still work, and retries every 30 s. The API answering
   `503 auth_unavailable` is handled the same way. The same message, without
   the extra line, is shown when signing in can't reach the provider. Only `invalid_grant` ends the session; the app then
   keeps playing offline with results queued, and shows just "Sign in again".
   Nothing syncs (or refreshes) while the page is hidden, so the OS can't cut
   a refresh off half way; the app syncs when it is shown again.
4. **Sign out** forgets the tokens and, if the provider has an
   `end_session_endpoint`, ends the provider session too. The user's games in
   progress and queued results are not lost: they are parked on the device for
   that account and come back when it signs in again (see
   [Offline data](#offline-data)).

Provider setup: a **public** client (no secret) using Authorization Code +
PKCE, redirect URI `https://<your host>/auth/callback`, access tokens signed as
JWTs (e.g. RS256), and the `openid`, `profile` and `offline_access` scopes (the
last one is what issues refresh tokens on most providers). The server's
`oidc.client_id` must be this client's id. See
[deploy/README.md](../deploy/README.md#3-identity-provider-oidc) for an
Authentik example.

Token lifetimes: keep access tokens around an hour (not minutes) so refreshes
are rare, and refresh tokens long enough to cover the longest gap between
uses (e.g. 30 days, renewed on each refresh). If the provider rotates refresh
tokens (single-use, the old one revoked on each refresh), a refresh whose
response is lost (the app was suspended mid-request, or the network dropped)
leaves the app holding a revoked token, and the user has to sign in again. The
app can't recover from that, so where the provider allows it, only rotate the
refresh token when it is close to expiry, or allow a short reuse grace period.

In dev auth mode the app instead asks for a user id and display name and sends
`Authorization: Bearer dev:<id>:<name>`.

## What it does

- **Today**: the day's games, each New, In progress (with time so far) or
  Solved.
- **Play**: tap or arrow-key to select; digits by keypad or keyboard; notes
  mode (`N`), erase (`Backspace`), undo (`Ctrl/Cmd+Z`), clear the board.
  Conflicts are highlighted. **Colour pens** (`C`, the Colours button next to
  Notes; both buttons show their on state with the highlight, not the label) are for the "simple colouring" technique: with Colours on, tapping a
  cell cycles it through none, colour A (orange), colour B (purple) and back
  to none, without selecting it. Any cell that isn't a given can be coloured,
  empty or holding a player's digit; givens can't. While Colours is on the
  keypad, digit keys and Erase are off (so a tap can't place a digit or a
  note) and Clear removes every colour instead of clearing the board (so the
  actions column keeps five buttons and always fits beside the keypad with no
  scrolling, down to a 320 px wide phone); Undo still works but
  doesn't undo colours. The tints are layered over selection, same-digit and
  error highlights, with a single ring for A and a double ring for B so they
  don't rely on hue, and a coloured cell reads as "colour A" or "colour B" to
  a screen reader. Colours are only the player's aid: they're saved with the
  game in progress in `localStorage` (so they survive a reload on this
  device, in Daily, Endless and seed play) and not part of the timer or the
  result, but every change is logged in the replay (`colour` with the cell's
  new pen, `clearColours`) so the admin replay viewer shows them in step with
  the moves; the server ignores them for its checks. They're dropped when
  the game is solved or the board is cleared (`Game.colours`, `SavedGame.colours`,
  absent in older saves). The timer runs only while the puzzle is on screen
  and the tab is visible; switching away pauses it behind a "Paused" cover.
  While a puzzle is being played (not paused or solved) the app holds a
  screen wake lock, where supported, so the phone does not go to sleep.
  While the play screen is up (paused and solved included) the page can't be
  pinch or double-tap zoomed and its text can't be selected, so fast taps
  never move or highlight the page: `src/ui/zoom-lock.ts` sets `playing` on
  the root element, whose CSS allows panning only (`touch-action: pan-x
  pan-y`) and turns off selection and the long-press callout, and cancels
  Safari's `gesturestart`, since Safari ignores `user-scalable=no`. Every
  other screen zooms and selects as usual, and zooming from the browser's own
  menu or keyboard is left alone. `web/e2e/zoom-lock.cjs <url>` checks it
  against the static build with real two-finger pinches, double clicks and a
  long press, and that taps, the number pad and the keyboard still play.
  Games are saved on every move, so a reload or a closed tab resumes where you
  left off.
- **Replays**: every game records each action (placing, erasing, notes, undo,
  clear, colour pens, notes mode, pause and resume, the app hidden or shown, reloads, start
  and finish) with both the game timer and the wall clock, saved with the game
  and sent with its result (see [Replays](API.md#replays)). The controller
  records them (`AppController.update` with the action, `log` for actions that
  don't change the board); `Game` only keeps the list. A replay over the
  server's 10000-event cap is left out, and the result is then flagged; the
  colour pen events are dropped first, so painting alone never costs a game its
  replay. A server from before colour pens refuses a replay holding them
  (`invalid_result`), so the client sends the result once more without them
  (`SudokuApi`, `withoutColourEvents`). This can happen when an admin
  downgrades the server while a newer client is cached or has results queued.
- **Endless** (the home page's second tab, next to **Daily**; with a server or
  a seed): see [Endless puzzles](#endless-puzzles).
- **Variants** (the third tab: Diagonal, Jigsaw and Killer; with a server or a
  seed): see [Variants](#variants).
- **Learn** (the home page's fourth tab): lessons on solving without
  guessing, see [Learn](#learn).
- **Leaderboard**: total and per-puzzle boards with shared ranks, plus each
  player's progress (e.g. 3/5), for today and the previous 8 days. Online
  only; offline it says so, and it loads once the connection is back. Results
  an admin flagged (including by confirming the server's automatic flag) carry
  a red "suspicious" marker.
- **Streak**: with a server, the Daily tab shows the player's daily streak
  ("4-day streak", plus "best 12" when that is longer), or "No streak yet".
  A day counts when at least one daily result for it counts (any difficulty,
  not admin-flagged). It comes from `GET /api/v1/me/stats`, fetched after every
  sync and kept in storage (`streak`), so it shows offline and after a reload;
  a stored streak whose last counting day is before yesterday reads as ended.
  Nothing is shown until the first fetch (or against a server without stats),
  and never when playing with a seed. Signing out forgets it.
- **Streak marker on the leaderboard**: next to a player's name (in the boards
  and the progress list), a flame and the number, with the title "N-day
  streak", for streaks of 2 or more. It uses `players[].streak` of
  `GET /api/v1/leaderboard` (0 from servers that don't send it).
- **Stats** (button next to **Leaderboard**, on both tabs, with a server only):
  the streak (current and best); a Daily table per difficulty with games
  played, best and average time and a small sparkline of the most recent
  times (oldest on the left, drawn with the fastest at the top, so a line
  climbing to the right means getting faster; none under two times); and an
  Endless table per difficulty with puzzles solved, the highest number, best
  and average time. Online only, like the leaderboard: offline it says so, and
  it loads once the connection is back (the next sync retries it). The
  decisions behind it (streak text, marker, sparkline points) are pure
  functions in `src/ui/stats.ts`, unit-tested; `StatsScreen` only lays them out.
  The Daily card has a **Classic / Graded** toggle: the numbers are kept per
  generator (a player who has played both has two records), and the screen
  opens on the generator the Daily tab plays (`AppController.generator`). Picking the other one fetches
  `GET /api/v1/me/stats?generator=N` again (`AppController.showStatsGenerator`);
  a sync keeps the pick. The streak does not change with it; the Endless card follows the same
  toggle, as endless numbers are kept per series (see below), and so does the
  **Variants** card under it: the same table for each variant, from
  `variants` in `GET /api/v1/me/stats` (left out when an older server sends
  none).

## Learn

The home page's fourth tab (after Daily, Endless and Variants) teaches the
solving techniques, from the rules to chains and then the variants, so that
no puzzle needs a guess. It needs no server and no sign-in: it
works with a server, with a seed and offline, and nothing it does is sent
anywhere.

There are 33 lessons in six levels: five named after the Graded difficulties
that need them, then one for the [Variants](#variants):

| Level      | Lessons                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| Easy       | The rules and the last square, cross-hatching, hidden singles in rows and columns                            |
| Medium     | Notes and candidates, naked singles                                                                          |
| Hard       | Pointing, claiming, naked and hidden pairs, triples and quads                                                |
| Expert     | X-Wing, Swordfish, Jellyfish, Skyscraper, 2-String Kite, Empty Rectangle, XY-Wing, XYZ-Wing, W-Wing          |
| Diabolical | Unique Rectangle, simple colouring, X-Chains, XY-Chains                                                      |
| Variants   | Diagonal: the extra units, locked candidates. Jigsaw: regions, the law of leftovers. Killer: see below       |

The Variants lessons are taught on boards of their own variant, drawn like the
game's (shaded diagonals, bold region borders, dashed cages with their sums):

- **Diagonal**: the two diagonals as extra units (a digit with one place left
  on a diagonal), and locked candidates between a box and a diagonal.
- **Jigsaw**: the irregular regions (a digit with one place left in a region),
  and the law of leftovers: the first one to four rows or columns from an edge
  against the regions lying mostly inside them, whose leftover squares on each
  side hold the same digits (drawn in two colours).
- **Killer**: cage sums and the combinations that make them, the 45 rule
  (innies and outies: the one square left over when a row, column or box is
  compared with the cages covering it), and cage pointing (a digit a cage must
  hold, lined up in a row, column or box, leaves the rest of it).

Each lesson has up to three parts, shown as tabs:

- **Learn**: what the technique is, how to spot it, and a worked example on a
  real position that steps through the pattern (Back, Next, Play, or the left
  and right arrow keys), highlighting the squares and candidates involved and
  then the digit placed or the candidates struck out.
- **Practice**: three or four positions where the technique is the easiest
  step open. The player picks a square and then the digit it takes, or, for a
  technique that only removes candidates, a candidate the pattern rules out.
  Every answer gets feedback at once: a right one explains why, a wrong one
  says what is wrong with it (a digit that breaks the rules, a true digit that
  this technique doesn't give, a candidate that is still possible) and counts
  as a mistake. **Hint** points at the pattern first and gives the answer the
  second time. The notes lesson asks for every candidate of a few squares
  instead.
- **Full puzzle** (every lesson but the first and the notes one, variants
  included): a whole
  puzzle whose hardest step is that technique. Digits are checked against the
  solution as they go in, **Remove** switches to striking out candidates
  (only ones a technique really rules out are accepted), **Notes** shows the
  candidates, and **Hint** shows the easiest step open, whatever technique it
  is.

Keys on a lesson: arrows move the selection (or step the worked example),
`1` to `9` answer, `H` or `?` hints, `N` switches Remove, `C` shows
candidates, `Escape` deselects.

Progress is kept per lesson in `localStorage` only (`learn`,
`src/learn/progress.ts`): opened, the positions finished, the ones finished
unaided (the answer never shown and at most two mistakes) and whether the full
puzzle was solved. A lesson reads New, Started, "Practised 2 of 4" or
Mastered (every position unaided) in the list, and the tab's first card counts
the lessons mastered. The Graded explainer links each level to its first
lesson ("Learn these"), and About has "Learn the techniques".

How it is built:

- `src/learn/state.ts` is a position with its candidates, and a `Step` (what
  a technique found: the pattern's cells and digits, a placement or
  eliminations, and the explanation). `src/learn/finders/` has one finder per
  technique, and `techniques.ts` lists them easiest first, with `nextStep`
  and `solveByLogic` (which solve by technique alone, never by search).
- These are separate from the generator's grader (`src/generator/grader.ts`),
  which is untouched: Learn teaches a few techniques the grader doesn't use
  (Jellyfish, Skyscraper, 2-String Kite, Empty Rectangle, W-Wing, Unique
  Rectangle, X-Chains), and those lessons say so.
- A position carries its `Layout` (`src/core/layout.ts`), standard unless the
  data says otherwise. The singles finders, the drill's feedback and the board
  follow it; `finders/variants.ts` has the seven variant techniques, and
  `techniquesFor(layout)` in `techniques.ts` is the order tried on each
  layout. A Jigsaw uses only singles and leftovers (the other finders assume
  3x3 boxes), and Diagonal and Killer leave out Unique Rectangle, whose
  argument fails with extra constraints. The law of leftovers is the one
  variant technique the grader has no equivalent of.
- `src/learn/positions.ts` holds the practice positions and puzzles. It is
  generated: `node scripts/learn-mine.ts <first seed> <puzzles> <out.json>`
  generates puzzles, solves them with the Learn techniques and records every
  position where a technique is the easiest step open, and
  `node scripts/learn-fixture.ts <mined.json>...` picks from one or more runs
  and writes the file. Don't edit it by hand.
- `src/learn/variant-positions.ts` is the same for the Variants lessons, each
  entry with its own layout (`diagonal`, 81 region digits, or cages as
  `sum:cell.cell ...`), so it doesn't depend on what the generator produces
  later. `node scripts/learn-mine.ts --variant <1|2|3> <first seed> <puzzles>
  <out.json>` mines Diagonal, Jigsaw or Killer puzzles (skipping Killer
  layouts with a one-square cage) and `node scripts/learn-fixture.ts
  --variants <mined.json>...` writes that file only. Killer needs several
  thousand puzzles to find cage pointing positions the grader agrees with.
- `test/learn-positions.test.ts` and `test/learn-lessons.test.ts` check every
  position: the solution is the only one, the lesson's technique applies and
  nothing easier does, the step it finds agrees with the solution, and each
  full puzzle solves with techniques up to its lesson's. Variant positions
  are checked under their own layout with the variant solver
  (`hasUniqueSolutionIn`) and, where the grader has the technique, against the
  grader's next step; `test/learn-variants.test.ts` also runs the Learn
  solver over generated puzzles of each variant and checks no step ever
  contradicts the solution.
- `src/learn/drill.ts` is one exercise (checking answers, feedback, hints);
  `src/ui/learn-session.ts` is a visit to a lesson and `src/ui/learn-view.ts`
  what the board and list draw. All three are DOM-free and unit-tested;
  `src/ui/learn.ts` (`<sudoku-learn>` and the lesson list) only draws them.

`web/e2e/learn.cjs <url> [screenshot dir]` checks it in a browser against the
static build (no server needed, like `serverless.cjs` below): it opens the
Learn tab, steps a worked example, gives a wrong and then a right answer,
finishes a lesson's positions (one of them by keyboard only), checks the
progress survives a reload, solves a full puzzle, finishes a candidate lesson
with hints, follows the Graded explainer's link, and checks phone width and
dark mode. It also checks the four home tabs fit on one row at 320 and 375
pixels, opens a lesson of each variant and checks its board's drawing, and
answers a Diagonal and a Killer position wrong and then right.

## Endless puzzles

The home page has four tabs, **Daily** (the day's games, as
above), **Endless**, **Variants** (see [Variants](#variants)) and **Learn**
(see [Learn](#learn)); the one last shown is remembered on the device
(`home-tab` in `localStorage`: `daily`, `endless`, `variants` or `learn`). The tabs' names are `ENDLESS_LABEL` and
`VARIANTS_LABEL` in `src/ui/controller.ts`.

Endless puzzles are numbered from 1 within each of the five difficulty tiers,
with no upper limit (up to 2^53 - 1, so numbers stay exact in JSON). Puzzle
`n` of a tier comes from the server's endless seed (fetched once with
`GET /api/v1/endless` and kept, as it never changes), the tier and `n`:
`generateEndless(seed, tier, n)` in `src/generator/generator.ts`, the daily
generator with its own seed derivation (a separate domain constant, so no
endless puzzle shares a daily one's seed). The goldens in
`test/generator.test.ts` are the same vectors as the server's Go port, so
everyone gets the same puzzles and the server can check their replays.

**Series.** Each generator version has its own numbered series of endless
puzzles (`generateEndlessVersion(version, seed, tier, n)` in
`src/generator/versions.ts`; v2 is `generateEndlessV2`), each starting at #1
with its own progress, results and leaderboards. The tab plays the series of
the generator in use (`AppController.generator`: the player's pick with the
[switch](#generator-setting) while both are enabled, else the enabled one),
and names it ("Graded series") in its heading. When the setting or the pick
changes, the tab switches series, and switching back resumes the earlier one
exactly where it was. Unfinished games of the other series stay resumable: the tab
lists them under **Unfinished in another series**. Results carry a
`generator` (missing means Classic, 1); the series is also shown in the play
header ("Graded · Easy #3"), on the leaderboard (which has a Classic / Graded
switch), in Stats and in the admin lists. Storage keeps Classic's keys as they
were (`<tier>/<n>`) and prefixes the others (`g2/<tier>/<n>`):
`endlessGameKey` and `parseEndlessGameKey` in `src/data/app-storage.ts`.

- **The tab** lists each tier with how many the player has solved (and the
  highest number, when there are gaps) and a button for the lowest number not
  solved yet ("Play #13", or "Resume #13"). Other games in progress are linked
  under it. **Open a puzzle** picks any tier and number of the current series.
- **Playing** works exactly as for dailies: games are saved on every move
  (`endless-games`) and resume after a reload, replays are recorded, and a
  solved puzzle's result is queued (`endless-pending`) and uploaded with
  `POST /api/v1/endless/results` whenever the server is reachable. Finished
  games are dropped from storage once `GET /api/v1/me/endless` has them. A
  number solved on another device opens its leaderboard instead.
- **Leaderboard**: for one series (the tab's, switchable), per tier, everyone's count of solved puzzles and highest
  number (ties share a rank), and any one puzzle's times, with Prev and Next
  by number. Admin flags show the same "suspicious" marker as on the daily
  boards.
- **Admin**: Results and replays has a Daily / Endless switch; endless results
  are listed by the day they were submitted, under their tier, and open,
  flag and unflag like daily ones.

- **How it works**: the first time the Endless tab is shown on a device, a
  dialog explains it (`endless-help-seen` in `localStorage` keeps it to once).
  The About screen has **How Daily works** and **How Endless works** buttons
  that open the same kind of dialog; the Daily one never pops up by itself.
  The texts are in `src/ui/help.ts`.

Seed play has the Endless tab too, see [Serverless play](#serverless-play-a-shared-seed):
the puzzles are the same, but without a server there is no leaderboard.

## Variants

The **Variants** tab is the Endless tab for Sudoku with an extra rule
([Variants engine](#variants-engine), `docs/API.md` Variants):

| Variant      | Extra rule                                             | Drawn as                                         |
| ------------ | ------------------------------------------------------ | ------------------------------------------------ |
| Diagonal (1) | Both long diagonals hold 1 to 9                        | The two diagonals shaded                         |
| Jigsaw (2)   | Nine irregular regions replace the boxes               | Bold borders between regions, no box borders     |
| Killer (3)   | Cages with a sum, no repeated digit in a cage          | Dashed cage outlines, the sum in the first cell  |

- **The tab**: a **Diagonal | Jigsaw | Killer** picker (`AppController.variant`,
  remembered per device in `variant` in `localStorage`, Diagonal until the
  player picks; `chooseVariant`), then the same screen as Endless for the
  picked variant (`TodayScreen` renders both with the variant as a parameter):
  the series' name ("Classic Killer series"), the variant's rule in one line
  with a "How it works" link, each difficulty's progress and next number, other
  games in progress, **Unfinished in another series** (games of the other
  variants or generator), **Open a puzzle**, and Leaderboard and Stats (History
  in seed play). The Classic | Graded switch shows above it while both are
  enabled: every generator has its own series of every variant.
- **Naming**: an endless puzzle is `(generator, variant, difficulty, number)`;
  variant 0 is standard Sudoku (the Endless tab), unchanged everywhere.
  `EndlessRef.variant`, `endless-play` and `endless-scores` screens carry it.
  Series read "Classic Diagonal", "Graded Killer" (`seriesName` in
  `src/ui/variants.ts`), as in the play header ("Graded Killer · Easy #3"),
  the leaderboard, History, the admin lists and the replay heading.
- **Puzzles** come from `generateEndlessVariant` through `EndlessPuzzleCache`
  (`src/data/endless.ts`), which keeps the 16 most recently used puzzles, as a
  variant can take up to about 0.7 s to generate. Opening a variant's puzzle
  that isn't already open sets `AppController.preparing` first: `<sudoku-app>`
  shows "Preparing Classic Killer Easy #3…" over the screen for a frame
  (`Host.nextFrame`, a `requestAnimationFrame` in the browser) before the work
  starts, so the tap shows a response. `openEndless` returns a promise that
  settles once the puzzle is open.
- **Rules in play**: a `Game` has its puzzle's `Layout` (`Game.create(givens,
  layout)`, `Game.restore(saved, layout)`). Placing a digit clears it from the
  notes of the layout's peers (a diagonal, a jigsaw region, a cage), and the
  game is solved only when the grid is full and right under the layout
  (`Board.solvedUnder`: no repeat in any unit or cage, every cage adding up).
  `Board.conflicts(layout)` marks repeats in any unit or cage, so a digit that
  only breaks the variant's rule is a conflict; the selected cell's peers
  follow the layout too. A full killer cage that doesn't add up has its sum
  marked in red (`Board.wrongCages`).
- **Drawing** (`<sudoku-board>`, from the game's layout): the board gets
  `layout-diagonal`, `layout-jigsaw` or `layout-killer`, and each cell the
  classes from `cellDecor` in `src/ui/cell-view.ts`: `diag` on a diagonal (a
  tint layered over the cell's own background, like the colour pens, so
  selection and other highlights still show); `jr` / `jb` where the next cell
  right / below is in another jigsaw region (bold borders that replace the box
  borders); `cage` with `ct`, `cr`, `cb`, `cl` on the sides where a killer
  cage ends (a dashed line inset 3 px, drawn by `::before`) and `has-sum` on
  the cage's first cell, which holds a small `.cage-sum` in its top-left corner
  (its notes start lower to make room). The sum is also in that cell's label
  for screen readers ("cage of 3 adding to 12"). The tokens `--diag-tint` and
  `--cage` have light and dark values. The admin replay viewer draws the
  layout from the replay's `layout` the same way.
- **Storage**: variant games and results are keyed by `endlessGameKey` with a
  `v<variant>/` prefix in front of the endless key: `v3/2/5` is Classic Killer
  Medium #5 and `v3/g2/2/5` the Graded one; standard keys are unchanged
  (`2/5`, `g2/2/5`). That covers `endless-games`, the queue
  (`endless-pending`) and, in seed play, `seed-endless-games-<fp>`. Results
  (`EndlessResult.variant`, sent with `POST /api/v1/endless/results`) carry the
  variant, left out for standard Sudoku as older servers expect; one without
  it is standard. Seed play's history (`seed-endless-history-<fp>`) keeps it
  the same way.
- **Leaderboards** are per generator and variant: `GET
  /api/v1/endless/leaderboard?generator=G&variant=V` and the per-puzzle board
  (`variant` left out for standard Sudoku). The variants' leaderboard is titled
  "Killer leaderboard" and has the variant picker and the Classic / Graded
  switch.
- **Stats** has a **Variants** card (see Stats above); **History** in seed play
  lists every series, standard and variant ("Classic Jigsaw series").
- **Admin**: endless results name the series ("Graded Killer #4"), and the
  replay and flag calls send `&variant=`; a variant replay's `layout`
  (`{ regions, diagonals, cages }`) is decoded into a `Layout`
  (`decodeLayout`) so the replay plays and draws under the variant's rules.
- **How Variants works**: the first time the Variants tab is shown on a device,
  a dialog explains it (`variants-help-seen` in `localStorage` keeps it to
  once); About has a **How Variants works** button, and the tab's "How it
  works" link opens it too. It gives each rule in plain words (Diagonal: "the
  two long diagonals also hold 1 to 9 once each."; Jigsaw: "the bold shapes
  replace the 3x3 boxes; each holds 1 to 9 once."; Killer: "dashed cages show
  a sum: the digits in a cage add up to it and don't repeat."), that each
  variant has five difficulties with their own numbered puzzles, and that
  variants work with Classic and Graded. The text is `variantsHelp` in
  `src/ui/variants.ts`.

## Variant of the day

Under the day's games on the **Daily** tab sits one more card, the **variant of
the day** (`docs/API.md`, [Variant of the
day](API.md#variant-of-the-day)): a Diagonal, Jigsaw or Killer puzzle that is
the same for everyone each day. The card is titled by its variant ("Killer of
the day"), gives that variant's rule, and has one row, "Variant of the day",
with a status ("Not started yet", "In progress · 1:05", "Solved in 7:01", plus
" · not uploaded yet" while the result is queued) and **Play**, **Resume** or
**Scores**. Players never see its generator or difficulty (it is always the
Graded generator, at Expert or Diabolical, or from 2026-11-20 at Hard or Expert): no "Graded", "Expert" or
"Diabolical" appears on the card, the play screen, the leaderboard or the admin
lists, only the variant. It does not follow the Classic / Graded switch.

- **Generation** is local and offline: the variant (`dailyVariantOf`) and the
  puzzle (`generateDailyVariant`, in `src/generator/variants.ts`) come from the
  cached week's seed and the day (and the version of the date,
  `dailyVariantVersion`: dates before 2026-11-20 keep the older, harder
  puzzle), so the card works offline all week. The card
  shows the variant at once; the puzzle is generated when **Play** is pressed,
  behind the "Preparing Killer of the day..." overlay, and kept by
  `VariantDayCache` (`src/data/variant-day.ts`) for the screens that ask again.
  A saved game is recognised without generating the puzzle, so the home screen
  never waits for it.
- **Play** is the usual play screen (`PuzzleRef` `{ variantDay: true, variant }`,
  screen `variant-day-play`), titled only "Killer of the day". The rule is the
  Variants tab's (`variantRule`). Replays record as usual, colour pens included, and go
  with the result.
- **Results** have their own queue. `SudokuRepository.variantDaySync` is a
  `ResultSync` over `variant-day-pending`, flushed by `refresh()` with the
  others: `200`/`201`/`400` take a result off it, a network failure, 503
  (including `maintenance`) or anything else leaves it queued, as for daily
  results. `POST /api/v1/variant-daily/results` carries
  `{ date, elapsedMs, completedAt, replay? }`; the server works the variant out
  from the date. `refresh()` also keeps the server's record for today
  (`variant-day-results`, from `GET /api/v1/me/results`' `variantDaily`).
- **Storage** keeps the saved game apart from the daily games, by date alone in
  `variant-day-games` (only the cached week's dates are kept). It is cleared
  when a different account signs in; on sign-out it is parked for its user
  and restored when they sign in again (see [Offline data](#offline-data)).
- **Streak**: finishing it counts towards the one daily streak, server side
  (`docs/API.md`, `GET /api/v1/me/stats`). The client shows the streak it is
  given.
- **Leaderboard**: the daily Leaderboard screen shows the variant of the day's
  board in a card beneath the classic content for the same date (the same
  "Earlier" / "Later" navigation, whichever tab is open), titled by the day's
  variant and ranked by time, with the same streak markers and "suspicious"
  badges. It is not a tab and is not part of the Total, it is the same for
  Classic and Graded, and it loads on its own: `AppController.variantBoard` and
  `variantBoardError` come from `GET /api/v1/variant-daily/leaderboard`, with a
  failure (offline, maintenance) shown inside that card and retried by the
  next sync. See scores after solving it opens this screen.
- **Not downloaded yet / maintenance**: the card is part of the daily list, so
  while the week isn't on the device it is replaced by the same "This week's
  puzzles haven't been downloaded yet" card, or the maintenance "try again
  later" one while the server is down.
- **Admin**: Results and replays lists the day's variant of the day results in
  a card above the games ("Killer of the day"), each opening its replay (drawn
  with the puzzle's layout) with the same flag, confirm and remove-flag
  controls (`AdminResultsModel`, key `{ variantDay: true, userId }`).
- **Serverless play** has it too: the variant and puzzle come from the seed's
  week (`SeedRepository.variantDay`), the game is saved per seed
  (`seed-variant-day-games-<fp>`) and a solve goes into the seed's history
  (`seed-variant-day-history-<fp>`, shown in History under "Variant of the
  day"). There is no leaderboard: the card's Scores button is not offered and
  after a solve the button reads **History**.

Tests: `test/variant-day.test.ts` (controller, repositories, client and models
against `test/fake-server.ts`), `test/variants.test.ts` (the shared fixture's
`daily` section), `test/admin-results.test.ts`, and the end-to-end script
`e2e/variant-of-the-day.cjs`.

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
- **Endless seed**: `HMAC-SHA256(key = UTF-8(seed), "sudoku-endless")`, first
  8 bytes, as 16 lowercase hex characters: the server's endless seed with the
  seed as its secret (so a seed equal to a server's secret also gets that
  server's [Endless puzzles](#endless-puzzles)). Everyone with the same seed
  gets the same puzzle for a difficulty and number; the settings other than
  the seed don't matter to it. Tests check the server's vectors.
- **Generators**: the [enabled generators](#generator-setting) live in
  `seed-generator-<fp>` as a set (`[1]`, `[2]` or `[1,2]`;
  `SeedRepository.setGenerators`, decoded by `decodeSeedGenerators`), Classic
  alone until the player chooses. A change in the seed card applies straight
  away. A seed that still has the schedule history of earlier versions
  (`[{ "fromWeek": "0000-W00", "version": 1 }, ...]`) reads as the version of
  its latest entry alone, so a change that was still pending applies now; the
  next change stores the new format. It is a local choice: it is not part of a
  share link, so a group has to agree on it for everyone to get the same
  puzzles. With both on, the Daily, Endless and Variants tabs have the same switch as
  with a server (the pick is the device's `generator`).
- **Share results** copies a summary of the day to paste into a message, tagged
  with a short fingerprint of the seed (e.g. `#287caf`) instead of the seed.
- **Variants**: the Variants tab works as with a server, with History instead of
  the leaderboard (see [Variants](#variants)).
- **Storage**: the active seed (`seed`), and per seed (keyed by its
  fingerprint) games in progress (`seed-games-<fp>`, current week only, keyed
  by `gameKey` like the server's) and the history of solve times
  (`seed-history-<fp>`, each with its generator; entries without one are
  Classic's). Endless puzzles are kept
  per seed the same way: games in progress (`seed-endless-games-<fp>`, never
  pruned, and dropped once solved) and solve times
  (`seed-endless-history-<fp>`: generator, variant, difficulty, number,
  elapsed time, when; entries without a generator are Classic's, and those
  without a variant standard Sudoku's). Variant games are keyed with the
  `v<variant>/` prefix (see [Variants](#variants)).
  Switching seeds and back resumes where you were.

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
  (every solved game, newest day first, then an **Endless** section with the
  solve times of each series and difficulty by puzzle number), and the seed's card with
  the share link, **Copy link**, **Share…** (the system share sheet, where the
  browser has one), **Copy seed** and **Leave seed**.
  The card also has the **Puzzle generators** setting: which are on ("On:
  Classic and Graded."), a "What's this?" link to the explainer, and
  **Classic**, **Graded** and **Both** buttons with the one in force marked.
  **Share results** and History cover the generator in use; History names the
  generator on each day's card while more than one is in play ("Today ·
  Graded").
- **Endless** works as with a server (next puzzle, resume, open any number,
  the first-visit explainer and About's "How Endless works", whose text leaves
  out the leaderboard), with the endless seed above, and nothing is uploaded.
  There is no endless leaderboard: after a solve the button reads **History**
  instead of "See scores", and the tab's button is **History** instead of
  "Leaderboard"; both open History. Only your own device's solves count.

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
`.github/release-drafter.yml`), deletes the assets the draft had, and attaches
fresh builds to it: the server binaries and `sudoku-web.zip`. If a build fails
the draft is left with no assets rather than stale ones. Publishing the draft deploys the files in that
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
browser and checks the puzzles are identical, solves an Endless puzzle (it
shows in History, and the other browser gets the same one), switches seeds and
back, round trips a Unicode seed, and starts offline. The e2e scripts need Playwright with
Chromium (`npm i -g playwright && npx playwright install chromium`).

`web/e2e/update.cjs` checks the "new version available" banner. It simulates a
deployment by changing `BUILD_VERSION` in the served `sw.js` (restored
afterwards), goes offline and back online to trigger the update check, and
checks the banner appears and that Reload brings in the new worker. It needs
the path of the served directory:

```sh
node web/e2e/update.cjs http://localhost:8090/ web/dist
```

### PR previews

Every pull request that touches `web/` gets a live preview of the web client,
and so does `main`, on [Cloudflare Pages](https://pages.cloudflare.com/). The
**Web preview** workflow (`preview.yml`) deploys the bundle that the **Web**
workflow already built, so nothing from a pull request is built or run with the
Cloudflare secrets. A comment on the pull request links to the preview, and the
deployment shows in the pull request's timeline.

Deployments of `main` are recorded in the `cf-pages` environment, with the
preview's link on the workflow run. Those of pull requests are recorded in the
`preview` environment at the pull request's commit, which the pull request
shows; the run's job summary links those previews.

Pull request N is served at `https://pr-N.<project>.pages.dev` and `main` at
the project's own URL, `https://<project>.pages.dev`. Each is a separate origin,
so a preview's saved data and service worker never touch the real app's.

Previews are seed play only. There is no server behind them, and sign-in
redirects and the same-origin API do not work on a preview host, so there is no
sign-in or leaderboards. Pages are marked `noindex`.

- Pull requests from forks are only deployed with the `preview` label. Add it,
  then re-run the pull request's **Web** workflow. A labelled fork's later
  pushes are deployed too, so remove the label if in doubt.
- A pull request that does not touch `web/` has no preview, since **Web** does
  not run for it.
- When a pull request closes, **Web preview cleanup** (`preview-cleanup.yml`)
  deletes its deployments and replaces the comment. It also sweeps weekly for
  any a failed run left behind, and can be run by hand.

One-time setup:

1. Create the Pages project, with `main` as its production branch:
   `npx wrangler pages project create sudoku-time --production-branch main`.
2. Create a Cloudflare API token with only the **Cloudflare Pages: Edit**
   permission.
3. In the repository's **Settings → Environments**, create an environment
   named `cf-pages`. Under **Deployment branches and tags**, choose
   **Selected branches and tags** and add `main`: both workflows run from
   `main`, so no other branch's workflow can read the secrets. Add the
   environment secrets `CLOUDFLARE_API_TOKEN` (that token) and
   `CLOUDFLARE_ACCOUNT_ID`.
4. If the project has another name, set the variable
   `CLOUDFLARE_PAGES_PROJECT` to it, in the environment or the repository.
5. Create a `preview` label.

The scripts the workflows run are in `.github/scripts` and are tested by
`.github/scripts/test-preview.sh` (the **Workflow scripts** workflow).
