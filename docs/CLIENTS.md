# Clients (Kotlin Multiplatform)

The Android app, the web app and their shared logic live in one Gradle build at
the repository root. The Go server in `server/` is built separately.

| Module   | What it is                                                         |
| -------- | ------------------------------------------------------------------ |
| `shared` | Pure Kotlin: board model, validation, generator, game logic, API client. Targets JVM, Android and JS. |
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
chunk). Point the server's `web_dir` (`SUDOKU_WEB_DIR`) at that directory. The
server falls back to `index.html` for unknown paths, so `index.html` loads its
assets by absolute path: serve the client at the site root.

### Development

Run the Go server in dev auth mode on `:8080` (see `server/README.md`), then:

```sh
./gradlew :webApp:jsBrowserDevelopmentRun --continuous
```

That serves the app on <http://localhost:8081> with live reload and proxies
`/api` to `http://localhost:8080` (override with `-PapiUrl=http://host:port`).
In dev auth mode the app asks for a user id and display name and sends
`Authorization: Bearer dev:<id>:<name>`.

### Sign-in (OIDC)

When the server's `authMode` is `oidc`, the web client signs in with
Authorization Code + PKCE (S256), using the issuer, client id and scopes from
`GET /api/v1/config`:

1. **Sign in** fetches the provider's discovery document, stores a random
   `state`, `nonce` and PKCE verifier, and redirects to the authorization endpoint.
2. The provider redirects back to **`<origin>/auth/callback`**. The app checks
   `state`, exchanges the code (sending the verifier) at the token endpoint,
   stores the tokens in `localStorage` and replaces the URL with `/`.
3. Access tokens are refreshed with the refresh token shortly before they
   expire. If the refresh token is rejected, the user is asked to sign in again.
4. **Sign out** forgets the tokens and, if the provider has an
   `end_session_endpoint`, ends the provider session too.

Authentik setup for the web client: an **OAuth2/OpenID Provider** with
client type **Public**, redirect URI `https://<your host>/auth/callback`, an
RS256 signing key, and the `openid`, `profile` and `offline_access` scopes
(the last one is what issues refresh tokens). The server's `oidc.client_id`
must be this provider's client id. The protocol code (`sudoku.auth` in
`shared`) is platform-neutral and covered by tests on every target.

### What it does

- **Today**: the day's games (generated locally from the week's seed),
  each New, In progress (with time so far) or Solved.
- **Play**: tap or arrow-key to select; digits by keypad or keyboard;
  notes mode (`N`), erase (`Backspace`), undo (`Ctrl/Cmd+Z`). Conflicts are highlighted.
  The timer runs only while the puzzle is on screen and the tab is visible;
  switching away pauses it behind a "Paused" cover.
- **Results**: a solved puzzle is queued in `localStorage` and uploaded; failed
  uploads retry on the next load or when the browser comes back online
  (`400` responses are dropped, per the API contract).
- **Leaderboard**: total and per-puzzle boards with shared ranks, plus each
  player's progress (e.g. 3/5), for today and the previous 8 days.
- In-progress games are saved per user and day in `localStorage`, so a reload
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
