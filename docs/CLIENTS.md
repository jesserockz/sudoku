# Clients (Kotlin Multiplatform)

The Android app, the web app and their shared logic live in one Gradle build at
the repository root. The Go server in `server/` is built separately.

| Module   | What it is                                                         |
| -------- | ------------------------------------------------------------------ |
| `shared` | Pure Kotlin: board model, validation, generator, game logic, API client. Targets JVM, Android and JS. |
| `webApp` | Browser client: Compose HTML on Kotlin/JS.                         |

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

### What it does

- **Today**: the day's five puzzles (generated locally from the week's seed),
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
