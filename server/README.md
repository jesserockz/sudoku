# sudoku-server

The Go backend: issues the weekly seed, stores results in SQLite and serves
leaderboards and the web client. It implements [`docs/API.md`](../docs/API.md).

## Build

```sh
cd server
make build      # host OS/arch -> ./sudoku-server
make dist       # static linux/amd64 and linux/arm64 -> dist/
```

Builds are `CGO_ENABLED=0`, so cross-compiling needs nothing beyond Go. To
run the tests as arm64 binaries on an x86 machine, install
`qemu-user-static` and run `make test-arm64`; CI does both.

## Run locally (dev auth)

```sh
SUDOKU_AUTH_MODE=dev SUDOKU_SERVER_SECRET=dev-secret-change-me ./sudoku-server
curl localhost:8080/healthz
```

## Configuration

An optional TOML file (`-config path` or `SUDOKU_CONFIG`), then environment
overrides. Environment wins.

| TOML key             | Env                     | Default                              |
| -------------------- | ----------------------- | ------------------------------------ |
| `bind`               | `SUDOKU_BIND`           | `127.0.0.1:8080`                     |
| `db_path`            | `SUDOKU_DB_PATH`        | `sudoku.db`                          |
| `server_secret`      | `SUDOKU_SERVER_SECRET`  | required, at least 16 bytes          |
| `web_dir`            | `SUDOKU_WEB_DIR`        | empty (no static serving)            |
| `timezone`           | `SUDOKU_TIMEZONE`       | `UTC`                                |
| `levels`             | `SUDOKU_LEVELS`         | `5` (1 to 10)                        |
| `auth.mode`          | `SUDOKU_AUTH_MODE`      | `oidc` (or `dev`)                    |
| `oidc.issuer`        | `SUDOKU_OIDC_ISSUER`    | required in `oidc` mode              |
| `oidc.audience`      | `SUDOKU_OIDC_AUDIENCE`  | `[client_id]`                        |
| `oidc.client_id`     | `SUDOKU_OIDC_CLIENT_ID` |                                      |
| `oidc.scopes`        | `SUDOKU_OIDC_SCOPES`    | `["openid","profile","offline_access"]` |

List env vars are comma or space separated. `server_secret` keys the weekly
seed and must never change once the deployment is live.

`timezone` is the IANA zone that defines each game day and ISO week for
every player. Changing it on a live deployment moves the day and week
boundaries, so pick it once.

`levels` is how many puzzles (levels `1..levels`) each day has. The server
keeps a per-week schedule in the database, so a change made by restarting
with a new value takes effect from the **next** ISO week; the current week,
and any earlier week, keep the count they were played with. Before anyone
has submitted a result the new value applies immediately. Restarting with
the current week's value again cancels a pending change. `/api/v1/week`
reports the count for the current week as `levels`.
