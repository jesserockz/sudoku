# Sudoku

A self-hosted daily Sudoku game for a small group. Everyone gets the same
puzzles each day (five by default, one per difficulty level), plays each once,
and lands on a per-day leaderboard ranked by solve time.

- An **installable web app (PWA)** for phones and desktops that plays fully
  offline once synced, and sends results back when a connection returns. Plain
  TypeScript and web components, no framework.
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
| `web/`       | The app: board, generator, game logic, API client, offline storage and UI |
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

Then run the web app on <http://localhost:8081>, rebuilding on change (needs
Node.js 22.18+):

```sh
cd web
npm ci
npm run dev
```

## Documentation

- [`docs/WEB.md`](docs/WEB.md): building, testing and running the web app,
  sign-in, offline play and serverless seed play
- [`server/README.md`](server/README.md): building and configuring the server
- [`deploy/README.md`](deploy/README.md): deploying to a Linux container with
  systemd and Caddy
- [`docs/API.md`](docs/API.md): the HTTP API between server and clients
- [`PROJECT_PLAN.md`](PROJECT_PLAN.md): goals, design decisions and how the
  pieces fit together

## License

Copyright 2026 Jesse Hills. Licensed under the [Apache License, Version 2.0](LICENSE).
