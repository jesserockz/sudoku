# API contract (v1)

The contract between the Go server and the web client. Both sides build against this document; change it in its own PR before changing behaviour on either side.

## Conventions

- Base path: `/api/v1`. JSON request and response bodies, UTF-8.
- Field names are `camelCase`.
- Dates are `YYYY-MM-DD` calendar dates in the server timezone (**Pacific/Auckland**), never device-local.
- Timestamps are RFC 3339 with offset (e.g. `2026-10-26T09:15:00+13:00`).
- Durations are integer milliseconds (`elapsedMs`, `totalMs`).
- ISO week identifiers use the form `2026-W44`.
- Day of week follows ISO 8601: `1` = Monday … `7` = Sunday.
- Difficulty `level` is an integer `1`–`5` (Easy, Medium, Hard, Expert, Diabolical).

### Errors

Non-2xx responses carry:

```json
{ "error": { "code": "invalid_result", "message": "elapsedMs below minimum" } }
```

| Status | `code` examples           | When                                           |
| ------ | ------------------------- | ---------------------------------------------- |
| 400    | `bad_request`             | Malformed body                                 |
| 400    | `invalid_result`          | Failed caps                                    |
| 401    | `unauthorized`            | Missing / invalid / expired token              |
| 403    | `forbidden`               | Caller is not an admin                         |
| 404    | `not_found`               | Unknown route                                  |
| 404    | `release_not_found`       | Unknown release (admin endpoints)              |
| 409    | `update_in_progress`      | An update or rollback is running (admin)       |
| 409    | `update_unavailable`      | Update cannot run here (admin)                 |
| 409    | `downgrade_not_confirmed` | Not an upgrade, `allowDowngrade` unset (admin) |
| 500    | `internal`                | Server fault                                   |
| 502    | `upstream_error`          | GitHub failed (admin endpoints)                |

## Authentication

- Every endpoint except `GET /api/v1/config` and `GET /healthz` requires `Authorization: Bearer <access token>`.
- In production the token is an OIDC access token (JWT) issued by Authentik. The server verifies signature (via the issuer's JWKS), `iss`, `aud`, and `exp`.
- The user is keyed by the token's `sub`. Display name is taken from `name`, falling back to `preferred_username`, then `sub`. A user record is created on first authenticated request and the display name refreshed on later ones.

### Dev auth mode

For local development and client testing without Authentik, the server can be started with `auth.mode = "dev"`. In that mode the bearer token is:

```
Authorization: Bearer dev:<sub>:<display name>
```

e.g. `Bearer dev:alice:Alice`. Dev tokens carry only the claims `sub` and `name`, so to try admin access in dev mode configure `[admin] claim = "sub"`, `values = ["ann"]` and use `Bearer dev:ann:Ann`. Dev mode must never be enabled in production; the server logs a prominent warning when it is.

## Weekly seed

- `weekSeed = HMAC-SHA256(key = serverSecret, message = "sudoku-week:" + isoWeek)`, truncated to the **first 8 bytes**, read as a big-endian unsigned 64-bit integer, encoded as **16 lowercase hex characters**.
- Hex (not a JSON number) because JS cannot represent 64-bit integers exactly. Clients parse it into a 64-bit value (`ULong`/`Long` bit pattern).
- How a client turns `(weekSeed, dayOfWeek, level)` into a puzzle is defined entirely by the client (`web/src/generator/`); the server never needs to know.

## Endpoints

### `GET /healthz`

Unauthenticated liveness check. `200` with `{"status":"ok"}`.

### `GET /api/v1/config`

Unauthenticated. Lets the web client discover how to log in.

```json
{
  "timezone": "Pacific/Auckland",
  "oidc": {
    "issuer": "https://auth.example.com/application/o/sudoku/",
    "clientId": "sudoku-web",
    "scopes": ["openid", "profile", "offline_access"]
  },
  "authMode": "oidc",
  "version": "0.1.0"
}
```

`authMode` is `"oidc"` or `"dev"`. `version` is the server's release version (semver, no leading `v`); older servers don't send it.

### `GET /api/v1/week`

The current ISO week's seed and boundaries.

```json
{
  "isoWeek": "2026-W44",
  "seed": "9f2c4a1b7e30d5c8",
  "weekStart": "2026-10-26",
  "weekEnd": "2026-11-01",
  "today": "2026-10-26",
  "dayOfWeek": 1,
  "timezone": "Pacific/Auckland"
}
```

Only the **current** week is served. There is no way to fetch a future week's seed.

### `GET /api/v1/me`

```json
{ "id": "alice", "displayName": "Alice", "admin": false }
```

`id` is an opaque stable user id (clients must not assume it equals the OIDC `sub`). `admin` is `true` when the caller may use the `/api/v1/admin/*` endpoints; clients treat a missing field (older servers) as `false`.

### `GET /api/v1/me/results?date=YYYY-MM-DD`

The caller's results for a day (defaults to today). Lets a fresh device know which puzzles are already played.

```json
{
  "date": "2026-10-26",
  "results": [
    { "level": 1, "elapsedMs": 183000, "completedAt": "2026-10-26T09:15:00+13:00" }
  ]
}
```

### `POST /api/v1/results`

Submit one completed puzzle.

```json
{
  "date": "2026-10-26",
  "level": 1,
  "elapsedMs": 183000,
  "completedAt": "2026-10-26T09:15:00+13:00"
}
```

- **Idempotent**: one result per `(user, date, level)`. The first accepted submission wins; later ones are ignored.
  - `201 Created` — stored.
  - `200 OK` — a result already existed; the body is the **stored** result, which may differ from the one submitted.
  - Both return the result object `{ "date", "level", "elapsedMs", "completedAt" }`.
- **Sanity caps** (`400 invalid_result` on failure):
  - `level` in `1..5`.
  - `elapsedMs` in `[5000, 86400000]` (5 s to 24 h).
  - `date` not after today, and not more than **8 days** before today (covers offline play across a week boundary).
  - `completedAt` parses as RFC 3339. It is stored as reported and is informational only — it does not affect ranking.

Clients queue results offline and retry until they receive `200`/`201`. A `400` is final; the client should drop the result and not retry.

### `GET /api/v1/leaderboard?date=YYYY-MM-DD`

Defaults to today.

```json
{
  "date": "2026-10-26",
  "puzzles": [
    {
      "level": 1,
      "entries": [
        { "rank": 1, "userId": "bob", "displayName": "Bob", "elapsedMs": 150000 },
        { "rank": 2, "userId": "alice", "displayName": "Alice", "elapsedMs": 183000 },
        { "rank": 2, "userId": "carol", "displayName": "Carol", "elapsedMs": 183000 },
        { "rank": 4, "userId": "dave", "displayName": "Dave", "elapsedMs": 200000 }
      ]
    }
  ],
  "total": {
    "entries": [
      { "rank": 1, "userId": "bob", "displayName": "Bob", "totalMs": 2400000 }
    ]
  },
  "players": [
    { "userId": "alice", "displayName": "Alice", "completedLevels": [1, 2, 3] },
    { "userId": "bob", "displayName": "Bob", "completedLevels": [1, 2, 3, 4, 5] }
  ]
}
```

- `puzzles` always contains all five levels in order `1..5`; `entries` may be empty.
- Entries are sorted by time ascending. **Ties share a rank** with no tiebreaker, using standard competition ranking (1, 2, 2, 4). Entries with equal time are ordered by `displayName` for stable display only.
- `total` includes only users who completed **all five** levels that day.
- `players` lists every user with at least one result that day, so clients can show partial progress (e.g. 3 of 5).

## Admin endpoints

Self-update of the server binary. Every `/api/v1/admin/*` endpoint needs a valid bearer token whose claims match the server's `[admin]` config (a claim, which may be a dot-separated path, equal to one of a list of values). Otherwise: `401 unauthorized` without a valid token, `403 forbidden` ("admin access required") for a valid non-admin token. With no `[admin]` config nobody is admin. If the server was built without the updater, every admin endpoint answers `409 update_unavailable`.

Only the server binary is updated; the web client is deployed separately.

### `GET /api/v1/admin/releases?prereleases=true`

Up to the 30 most recent published (non-draft) GitHub releases, newest first. Prereleases are omitted unless `prereleases=true`. `502 upstream_error` if GitHub fails.

```json
{
  "current": { "version": "0.2.0", "os": "linux", "arch": "amd64", "asset": "sudoku-server-linux-amd64" },
  "releases": [
    {
      "tag": "v0.3.0",
      "version": "0.3.0",
      "name": "v0.3.0",
      "publishedAt": "2026-10-30T01:02:03Z",
      "prerelease": false,
      "latest": true,
      "current": false,
      "comparison": "newer",
      "installable": true,
      "notInstallableReason": "",
      "url": "https://github.com/jesserockz/sudoku/releases/tag/v0.3.0"
    }
  ],
  "update": { "state": "idle", "action": "", "...": "same object as GET /api/v1/admin/update" }
}
```

- `version` is the tag without a leading `v`. `current` is true when it equals the running version.
- `comparison` is `newer`, `same`, `older` or `unknown` (either version is not semver) relative to the running version, by semver 2 precedence (a prerelease ranks below its release).
- `latest` is true for the highest-semver non-prerelease release.
- `installable` needs both this platform's asset (`sudoku-server-<os>-<arch>`) and a `SHA256SUMS` asset; otherwise `notInstallableReason` says what is missing.

### `POST /api/v1/admin/update`

```json
{ "tag": "v0.3.0", "allowDowngrade": false }
```

`tag` must look like `v1.2.3` (optional `v`, optional `-prerelease` and `+build`), else `400 bad_request`. The request is checked synchronously, then the download, verification and install run in the background and the server restarts itself. Refusals:

| Status | `code`                    | When                                                                                                       |
| ------ | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 409    | `update_in_progress`      | An update or rollback is already running                                                                   |
| 409    | `update_unavailable`      | The binary's directory is not writable by the service user, or the release lacks the asset or `SHA256SUMS` |
| 404    | `release_not_found`       | No such published release                                                                                  |
| 502    | `upstream_error`          | GitHub failed                                                                                              |
| 409    | `downgrade_not_confirmed` | `comparison` is `same`, `older` or `unknown` and `allowDowngrade` is not `true`                            |

Otherwise `202 Accepted` with the status object below. The download is checked against the release's `SHA256SUMS`; the new binary replaces the old one atomically and the old one is kept as `<binary>.previous`.

### `GET /api/v1/admin/update`

Progress of the current or last job.

```json
{
  "state": "downloading",
  "action": "update",
  "target": "v0.3.0",
  "message": "Downloading sudoku-server-linux-amd64",
  "error": "",
  "bytesDone": 1234,
  "bytesTotal": 9999999,
  "startedAt": "2026-10-31T01:02:03Z",
  "finishedAt": null,
  "rollbackAvailable": true
}
```

- `state` is `idle` (nothing ran since the server started), `downloading`, `verifying`, `installing`, `restarting` or `failed`. `error` is set when `failed`. `action` is `update`, `rollback` or `""` (idle).
- `target` is the tag being installed; empty for a rollback.
- `bytesTotal` is `0` when unknown. `finishedAt` is `null` while running.
- `rollbackAvailable` is true when a `.previous` binary exists next to the running one.
- In `restarting` the server is about to exit. Clients poll `GET /api/v1/config` until its `version` matches the target.

### `POST /api/v1/admin/rollback`

No body. Swaps the `.previous` binary back in (the replaced binary becomes the new `.previous`) and restarts. `409 update_in_progress` if a job is running, `409 update_unavailable` if there is no previous binary or the directory is not writable. Otherwise `202 Accepted` with the status object.

## Static web client

All non-`/api/`, non-`/healthz` paths serve the compiled web client from a configured directory, falling back to `index.html` for unknown paths (client-side routing).
