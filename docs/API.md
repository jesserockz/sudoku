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
| 413    | `too_large`               | Request body over the size cap                 |
| 401    | `unauthorized`            | Missing / invalid / expired token              |
| 403    | `forbidden`               | Caller is not an admin                         |
| 404    | `not_found`               | Unknown route, or no such result (admin)       |
| 404    | `release_not_found`       | Unknown release (admin endpoints)              |
| 409    | `update_in_progress`      | An update or rollback is running (admin)       |
| 409    | `update_unavailable`      | Update cannot run here (admin)                 |
| 409    | `downgrade_not_confirmed` | Not an upgrade, `allowDowngrade` unset (admin) |
| 500    | `internal`                | Server fault                                   |
| 502    | `upstream_error`          | GitHub failed (admin endpoints)                |

## Authentication

- Every endpoint except `GET /api/v1/config` and `GET /healthz` requires `Authorization: Bearer <access token>`.
- In production the token is an OIDC access token (JWT) issued by the OIDC provider (e.g. Authentik). The server verifies signature (via the issuer's JWKS), `iss`, `aud`, and `exp`.
- The user is keyed by the token's `sub`. Display name is taken from `name`, falling back to `preferred_username`, then `sub`. A user record is created on first authenticated request and the display name refreshed on later ones.

### Dev auth mode

For local development and client testing without an OIDC provider, the server can be started with `auth.mode = "dev"`. In that mode the bearer token is:

```
Authorization: Bearer dev:<sub>:<display name>
```

e.g. `Bearer dev:alice:Alice`. Dev tokens carry only the claims `sub` and `name`, so to try admin access in dev mode configure `[admin] claim = "sub"`, `values = ["ann"]` and use `Bearer dev:ann:Ann`. Dev mode must never be enabled in production; the server logs a prominent warning when it is.

## Weekly seed

- `weekSeed = HMAC-SHA256(key = serverSecret, message = "sudoku-week:" + isoWeek)`, truncated to the **first 8 bytes**, read as a big-endian unsigned 64-bit integer, encoded as **16 lowercase hex characters**.
- Hex (not a JSON number) because JS cannot represent 64-bit integers exactly. Clients parse it into a 64-bit value (`ULong`/`Long` bit pattern).
- How a client turns `(weekSeed, dayOfWeek, level)` into a puzzle is defined by the client (`web/src/generator/`). The server has a bit-identical Go port (`server/internal/puzzle/`, pinned by the same golden puzzles) so it can check [replays](#replays) against the day's puzzle; it never stores puzzles.

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
  "completedAt": "2026-10-26T09:15:00+13:00",
  "replay": { "version": 1, "events": [{ "t": 0, "w": 1761423000000, "a": "start" }, "..."] }
}
```

- `replay` is the game's full [replay](#replays). It is optional so that results queued by older clients still upload, but a result without one is flagged as suspicious.
- **Idempotent**: one result per `(user, date, level)`. The first accepted submission wins; later ones are ignored.
  - `201 Created` — stored.
  - `200 OK` — a result already existed; the body is the **stored** result, which may differ from the one submitted.
  - Both return the result object `{ "date", "level", "elapsedMs", "completedAt" }` (never the replay).
- **Sanity caps** (`400 invalid_result` on failure):
  - `level` in `1..5`.
  - `elapsedMs` in `[5000, 86400000]` (5 s to 24 h).
  - `date` not after today, and not more than **8 days** before today (covers offline play across a week boundary).
  - `completedAt` parses as RFC 3339. It is stored as reported and is informational only — it does not affect ranking.
  - `replay`, when present, is an object with `version` `1` and at most **10000** `events`, each well-formed as described under [Replays](#replays) (`400 invalid_result` otherwise).
- The whole request body is capped at **1 MiB** (`413 too_large`).
- The replay is then **checked** against the day's puzzle (see [Replay checks](#replay-checks)). A replay that fails a check does **not** reject the result: it is stored with the replay and automatically flagged as suspicious, with the failed check as the reason. So is a result with no replay. An automatic flag is only visible to admins until one confirms it by flagging the result themselves (see the admin flag endpoint).

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
- Every puzzle and total entry also has `"suspicious": true|false`: `true` when an admin flagged that result (the server's own automatic flags don't count until an admin confirms one), or for a total entry, any of the player's results that day. Flagged results stay listed and ranked like any other; clients show a visible marker on them. Who flagged a result and why is only shown to admins.

## Replays

A replay records every action of a game, so the server can check a result and an admin can watch it back. Clients record it while playing, keep it with the in-progress game (so a reload doesn't lose it) and send it with the result.

```json
{
  "version": 1,
  "events": [
    { "t": 0, "w": 1761423000000, "a": "start" },
    { "t": 0, "w": 1761423000004, "a": "resume" },
    { "t": 4210, "w": 1761423004214, "a": "place", "c": 40, "d": 5 },
    { "t": 6020, "w": 1761423006024, "a": "notes", "on": true },
    { "t": 7400, "w": 1761423007404, "a": "noteAdd", "c": 41, "d": 3 },
    { "t": 9000, "w": 1761423009004, "a": "hidden" },
    { "t": 9000, "w": 1761423009005, "a": "pause" },
    { "t": 9000, "w": 1761423069005, "a": "visible" },
    { "t": 9000, "w": 1761423070000, "a": "resume" },
    { "t": 183000, "w": 1761423244000, "a": "place", "c": 80, "d": 9 },
    { "t": 183000, "w": 1761423244000, "a": "finish" }
  ]
}
```

Every event has `t`, the game timer in integer milliseconds (the in-game clock, which stops while paused), `w`, the wall clock in integer epoch milliseconds, and `a`, the action. `c` is a cell index `0..80` (row-major) and `d` a digit `1..9`.

| `a`          | Fields   | Meaning                                                                                               |
| ------------ | -------- | ----------------------------------------------------------------------------------------------------- |
| `start`      |          | The puzzle was opened for the first time (always the first event, `t` = 0)                            |
| `place`      | `c`, `d` | Digit `d` placed in `c` (replacing any other digit; clears `c`'s notes and `d` from its peers' notes) |
| `erase`      | `c`      | Cleared `c`: its digit if it has one, else its notes                                                  |
| `noteAdd`    | `c`, `d` | Pencil mark `d` added to the empty cell `c`                                                           |
| `noteRemove` | `c`, `d` | Pencil mark `d` removed from `c`                                                                      |
| `undo`       |          | Reverted the last `place`, `erase`, `noteAdd`, `noteRemove` or `clear`                                |
| `clear`      |          | Cleared every entered digit and note                                                                  |
| `notes`      | `on`     | Notes mode switched on (`true`) or off (`false`); changes nothing on the board                        |
| `pause`      |          | The timer stopped (Pause, the app hidden, or the puzzle closed)                                       |
| `resume`     |          | The timer started again                                                                               |
| `hidden`     |          | The app was hidden (`visibilitychange`)                                                               |
| `visible`    |          | The app became visible again                                                                          |
| `restore`    |          | The game was reloaded from storage: the timer is stopped and the undo history is gone                 |
| `finish`     |          | The puzzle was solved (always the last event, right after the solving `place`)                        |

Only actions that change something are recorded: a `place` of the digit already there, or an `undo` with nothing to undo, never appears.

### Replay checks

The server replays the events on the day's puzzle (regenerated from the week seed) and checks, in order:

1. **Shape**: `start` is first with `t` = 0, `finish` is last, and neither appears anywhere else.
2. **Timer**: `t` never decreases, and it stays the same while the timer is stopped (after `pause` or `restore`, until `resume`), except that `restore` itself may move it forward (the time banked by the last save before the app was closed) and `resume` may be up to **1 second** later than the event before it (older clients stamped it a few milliseconds late).
3. **Moves**: every `place`, `erase`, `noteAdd`, `noteRemove`, `undo` and `clear` happens while the timer runs and is legal on the board at that point (no changing a given, no `noteAdd` of a mark already there, and so on), and `pause`/`resume` alternate.
4. **Solved**: the board after the last move is the puzzle's solution, the solving `place` is followed directly by `finish`, and the `finish` event's `t` equals the submitted `elapsedMs`.
5. **Wall clock**: the wall-clock time spent with the timer running (the sum of `w` gaps between consecutive events while it runs; a gap where `w` goes backwards, e.g. a clock change, counts as 0) is at least `elapsedMs` minus **2 seconds**. Equivalently, the replay's wall-clock span minus the time spent paused can't be shorter than the time claimed.

A replay that passes is `valid`; one that fails is `invalid`, with the first failed check as the reason.

## Admin endpoints (results)

The anti-cheat tools. They need an admin token, exactly as the update endpoints below (`401` / `403` otherwise), but work whether or not the server has the updater.

### `GET /api/v1/admin/results?date=YYYY-MM-DD`

Every result for a day (defaults to today, any past date allowed), ordered by level, then time.

```json
{
  "date": "2026-10-26",
  "levels": 5,
  "results": [
    {
      "userId": "2",
      "displayName": "Bob",
      "level": 5,
      "elapsedMs": 120000,
      "completedAt": "2026-10-26T09:15:00+13:00",
      "submittedAt": "2026-10-25T20:15:01.123Z",
      "replay": "invalid",
      "replayError": "the wall clock ran 41 s while the timer ran 120 s",
      "flag": {
        "reason": "Replay check failed: the wall clock ran 41 s while the timer ran 120 s",
        "auto": true,
        "flaggedBy": null,
        "flaggedAt": "2026-10-25T20:15:01.123Z"
      }
    }
  ]
}
```

- `replay` is `valid`, `invalid` (see `replayError`), `missing` (submitted without one) or `none` (submitted before the server kept replays).
- `flag` is `null` when the result isn't flagged. `auto` is `true` when the server flagged it on submission (then `flaggedBy` is `null`); otherwise `flaggedBy` is `{ "userId", "displayName" }` of the admin who did.

### `GET /api/v1/admin/results/{date}/{level}/{userId}/replay`

One result with everything needed to watch it back: the fields of a list item above, plus `date`, `levels` (games that day), `givens` (the puzzle's starting grid as 81 digits, `0` = empty; never the solution) and `events` (the stored replay's events, `[]` when there is none). `404 not_found` if there is no such result.

### `PUT /api/v1/admin/results/{date}/{level}/{userId}/flag`

Flags a result as suspicious, replacing any earlier flag (including an automatic one, which this confirms and makes public). Body `{ "reason": "Way faster than usual" }`; `reason` is optional, trimmed, and at most 500 characters (`400 bad_request` otherwise). Records the calling admin and the time. `200` with the updated list item, `404 not_found` if there is no such result.

### `DELETE /api/v1/admin/results/{date}/{level}/{userId}/flag`

Removes the flag (automatic or not). `200` with the updated list item; also `200` if it wasn't flagged. `404 not_found` if there is no such result.

## Admin endpoints (self-update)

Self-update of the server binary and, when the server has a `web_dir`, the web client. Every `/api/v1/admin/*` endpoint needs a valid bearer token whose claims match the server's `[admin]` config (a claim, which may be a dot-separated path, equal to one of a list of values). Otherwise: `401 unauthorized` without a valid token, `403 forbidden` ("admin access required") for a valid non-admin token. With no `[admin]` config nobody is admin. If the server was built without the updater, every self-update endpoint answers `409 update_unavailable`.

When `web_dir` is set, an update also installs the release's `sudoku-web.zip` into it (the previous directory is kept as `<web_dir>.previous`) and a rollback restores both. Without `web_dir` only the binary is updated.

### `GET /api/v1/admin/releases?prereleases=true`

Up to the 30 most recent published (non-draft) GitHub releases, newest first. Prereleases are omitted unless `prereleases=true`. `502 upstream_error` if GitHub fails.

```json
{
  "current": { "version": "0.2.0", "os": "linux", "arch": "amd64", "asset": "sudoku-server-linux-amd64", "updatesWeb": true },
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

- `current.updatesWeb` is true when the server also installs the web client (its `web_dir` is set).
- `version` is the tag without a leading `v`. `current` is true when it equals the running version.
- `comparison` is `newer`, `same`, `older` or `unknown` (either version is not semver) relative to the running version, by semver 2 precedence (a prerelease ranks below its release).
- `latest` is true for the highest-semver non-prerelease release.
- `installable` needs this platform's asset (`sudoku-server-<os>-<arch>`), a `SHA256SUMS` asset and, when `updatesWeb` is true, a `sudoku-web.zip` asset; otherwise `notInstallableReason` says what is missing.

### `POST /api/v1/admin/update`

```json
{ "tag": "v0.3.0", "allowDowngrade": false }
```

`tag` must look like `v1.2.3` (optional `v`, optional `-prerelease` and `+build`), else `400 bad_request`. The request is checked synchronously, then the download, verification and install run in the background and the server restarts itself. Refusals:

| Status | `code`                    | When                                                                                                       |
| ------ | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 409    | `update_in_progress`      | An update or rollback is already running                                                                   |
| 409    | `update_unavailable`      | The binary's directory (or the parent of `web_dir`) is not writable by the service user, or the release lacks an asset |
| 404    | `release_not_found`       | No such published release                                                                                  |
| 502    | `upstream_error`          | GitHub failed                                                                                              |
| 409    | `downgrade_not_confirmed` | `comparison` is `same`, `older` or `unknown` and `allowDowngrade` is not `true`                            |

Otherwise `202 Accepted` with the status object below. Downloads are checked against the release's `SHA256SUMS`. The web bundle is unpacked into a staging directory next to `web_dir` (archive entries that are absolute, escape the directory or are not plain files are refused, and it must contain `index.html`). Only then is `web_dir` swapped (the old one is kept as `<web_dir>.previous`) and the new binary installed atomically (the old one is kept as `<binary>.previous`); if the binary cannot be installed the old web directory is put back.

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
- `rollbackAvailable` is true when a `.previous` binary exists next to the running one. A web client `.previous` is restored too when present, but is not required.
- In `restarting` the server is about to exit. Clients poll `GET /api/v1/config` until its `version` matches the target.

### `POST /api/v1/admin/rollback`

No body. Swaps the `.previous` binary back in (the replaced binary becomes the new `.previous`) and, when `web_dir` is set and has a `.previous`, the web client too, then restarts. `409 update_in_progress` if a job is running, `409 update_unavailable` if there is no previous binary or a directory is not writable. Otherwise `202 Accepted` with the status object.

## Static web client

All non-`/api/`, non-`/healthz` paths serve the compiled web client from a configured directory, falling back to `index.html` for unknown paths (client-side routing).
