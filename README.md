# Sudoku

A self-hosted daily Sudoku game for a small group. Everyone gets the same
puzzles each day (five by default, one per difficulty level), plays each once,
and lands on a per-day leaderboard ranked by solve time.

- **Android app** and an **installable web app (PWA)** that play fully offline
  once synced, and send results back when a connection returns.
- **Puzzles are generated on the client**, deterministically from a weekly
  seed, so every device produces the identical puzzles and the server never
  stores them.
- **Go server**: a single static binary with SQLite. It hands out the weekly
  seed, records results and serves the leaderboards and the web app. Sign-in is
  OIDC (built against Authentik), with a dev mode for local use.
- **Serverless play**: share a seed (or a share link) and a group gets the same
  daily games with no server at all; the web app runs from any static host,
  such as GitHub Pages.

## Layout

| Path         | What it is                                                     |
| ------------ | -------------------------------------------------------------- |
| `shared/`    | Kotlin Multiplatform: board, generator, game logic, API client, offline storage |
| `webApp/`    | Web client (Compose HTML on Kotlin/JS)                         |
| `androidApp/`| Android client (Jetpack Compose)                               |
| `server/`    | Go backend                                                     |
| `deploy/`    | systemd units, backup timer, example config, Caddy snippet     |
| `docs/`      | API contract and client docs                                   |

## Quick start

Run the server in dev auth mode (needs Go):

```sh
cd server
make build
SUDOKU_AUTH_MODE=dev SUDOKU_SERVER_SECRET=dev-secret-change-me ./sudoku-server
```

Then, from the repository root, run the web app with live reload (needs JDK 17+)
on <http://localhost:8081>:

```sh
./gradlew :webApp:jsBrowserDevelopmentRun --continuous
```

## Documentation

- [`docs/CLIENTS.md`](docs/CLIENTS.md): building, testing and running the web
  and Android apps, sign-in, offline play and serverless seed play
- [`server/README.md`](server/README.md): building and configuring the server
- [`deploy/README.md`](deploy/README.md): deploying to a Linux container with
  systemd and Caddy
- [`docs/API.md`](docs/API.md): the HTTP API between server and clients
- [`PROJECT_PLAN.md`](PROJECT_PLAN.md): goals, design decisions and how the
  pieces fit together

## License

Copyright 2026 Jesse Hills. Licensed under the [Apache License, Version 2.0](LICENSE).
