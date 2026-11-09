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
- How a client turns `(weekSeed, dayOfWeek, level)` into a puzzle is defined by the client (`web/src/generator/`). The server has a bit-identical Go port (`server/internal/puzzle/`, pinned by the same golden puzzles) so it can check [replays](#replays) against the day's puzzle (made by the [generator version](#generator-versions) the game was played with); it never stores puzzles.

## Endless seed

Endless puzzles are numbered puzzles per difficulty, unlimited and shared by everyone, kept forever. There is one **series** per [generator version](#generator-versions): Classic (`1`) and Graded (`2`), each numbered from `#1` with its own results, progress and leaderboards. A puzzle is named by `(generator, difficulty, number)`; every `generator` below is `1` or `2` and a missing one means `1`, so data and clients from before the series existed are Classic's. `difficulty` is the tier `1..5` (Easy 40, Medium 36, Hard 32, Expert 28, Diabolical 24 givens), which is not the daily `level`. `number` is `1..9007199254740991` (2^53-1, the largest integer JavaScript represents exactly).

- `endlessSeed = HMAC-SHA256(key = serverSecret, message = "sudoku-endless")`, truncated to the **first 8 bytes**, encoded as **16 lowercase hex characters**, exactly as the weekly seed is. It never changes for a given server secret, so a client can fetch it once.
- The puzzle seed is derived with SplitMix64 (all arithmetic on unsigned 64-bit integers, wrapping), then fed to the same generator as the dailies (grid, cell removal to the tier's target, up to 8 attempts):

```
ENDLESS_DOMAIN = 0x656e646c657373   // "endless" in ASCII
h = mix(ENDLESS_DOMAIN + generatorVersion)   // 1 for Classic, 2 for Graded
h = mix(h ^ endlessSeed)
h = mix(h + difficulty)
h = mix(h + number)
```

- The web client (`web/src/generator/`, `generateEndless`) and the server's Go port (`server/internal/puzzle/`, `GenerateEndless`) are pinned by the same golden puzzles. The server regenerates an endless puzzle to check [replays](#replays) and never stores puzzles.

## Generator versions

There are two puzzle generators. Players know them as **Classic** (version `1`, the clue-count generator described above) and **Graded** (version `2`, which grades puzzles by technique). Endless puzzles come in both, as separate [series](#endless-seed). The web client and the server's Go port contain both (`web/src/generator/generator.ts` and `generator-v2.ts` with `grader.ts`, `server/internal/puzzle/` `puzzle.go`, `v2.go` and `grader.go`).

- **Graded**: the grader solves a puzzle with human techniques in a fixed order (hidden and naked singles, locked candidates, subsets, fish, wings, colouring, XY-chains) and reports the hardest level needed, 1 to 6, or 7 if it gets stuck. Tiers accept grader levels: Easy 1, Medium 2, Hard 3 to 4, Expert 5, Diabolical 6. Generation tries up to 200 random puzzles per seed and takes the first inside the tier's band, or else the nearest non-stuck one.
- The puzzle seed of Graded uses the same derivation as Classic with the version constant `2` in place of `GeneratorVersion` (`1`), so the two never share a puzzle for the same week, day and level.
- Both implementations are pinned by `testdata/generator-v2.json` at the repo root, which holds daily, endless, forced-fallback and grader cases.

### Enabled generators

An admin **enables** Classic, Graded or both (see [`PUT /api/v1/admin/generator`](#put-apiv1admingenerator)), with **immediate effect**. The enabled set is always non-empty and ascending: `[1]`, `[2]` or `[1, 2]`. The **default generator** is the first enabled one (`enabled[0]`); it is what a request that names no generator means. A fresh server enables Classic only. A server upgraded from the old per-week generator schedule enables the one version the schedule gave the current week; a change that was still pending is dropped.

- With both enabled, players pick a generator per game, for the dailies and endless alike. Each generator keeps its own results and leaderboards: a daily result is keyed by `(user, generator, date, level)`, and the same day and level can be played once in each generator.
- **Mid-game rule.** A submission naming any known generator (`1` or `2`) is accepted, enabled or not, within the usual limits. A game started before the admin disabled its generator, or queued offline, is never lost.
- **Nothing is reset.** Results keep the generator they were played with. Results stored before generators could be chosen took the version the old schedule gave their date's ISO week. A replay is checked against the puzzle of its own generator: the same replay is valid as a Graded result and fails as a Classic one (or the other way round).
- The server uses a result's generator everywhere it regenerates a daily puzzle: checking a submitted replay, and serving an admin a result's `givens`.

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
  "timezone": "Pacific/Auckland",
  "levels": 5,
  "generators": [1, 2],
  "generator": 1,
  "pendingGenerator": null
}
```

- `levels` is the number of games each day of this week has (`1..levels`).
- `generators` is the set of [enabled generators](#enabled-generators): `[1]` (Classic), `[2]` (Graded) or `[1, 2]`, ascending. Clients treat a missing value (older servers) as `[generator]`, or `[1]` when that is missing too.
- `generator` is **deprecated**: the default generator, `generators[0]`, kept for older clients.
- `pendingGenerator` is **deprecated** and always `null`: changes apply immediately. Kept for older clients.

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
    { "generator": 1, "level": 1, "elapsedMs": 183000, "completedAt": "2026-10-26T09:15:00+13:00" }
  ]
}
```

Results of every generator, ordered by `generator` then `level`; each carries the `generator` it was played with.

### `POST /api/v1/results`

Submit one completed puzzle.

```json
{
  "generator": 2,
  "date": "2026-10-26",
  "level": 1,
  "elapsedMs": 183000,
  "completedAt": "2026-10-26T09:15:00+13:00",
  "replay": { "version": 1, "events": [{ "t": 0, "w": 1761423000000, "a": "start" }, "..."] }
}
```

- `replay` is the game's full [replay](#replays). It is optional so that results queued by older clients still upload, but a result without one is flagged as suspicious.
- `generator` is the [generator version](#generator-versions) the game was played with, `1` or `2` (anything else is `400 invalid_result`). It is optional: a missing one is the default generator (the first enabled), which is what an older client played. Either version is accepted whether or not it is enabled now (the [mid-game rule](#enabled-generators)).
- **Idempotent**: one result per `(user, generator, date, level)`. The first accepted submission wins; later ones are ignored.
  - `201 Created` — stored.
  - `200 OK` — a result already existed; the body is the **stored** result, which may differ from the one submitted.
  - Both return the result object `{ "generator", "date", "level", "elapsedMs", "completedAt" }` (never the replay).
- **Sanity caps** (`400 invalid_result` on failure):
  - `level` in `1..5`.
  - `elapsedMs` in `[5000, 86400000]` (5 s to 24 h).
  - `date` not after today, and not more than **8 days** before today (covers offline play across a week boundary).
  - `completedAt` parses as RFC 3339. It is stored as reported and is informational only — it does not affect ranking.
  - `replay`, when present, is an object with `version` `1` and at most **10000** `events`, each well-formed as described under [Replays](#replays) (`400 invalid_result` otherwise).
- The whole request body is capped at **1 MiB** (`413 too_large`).
- The replay is then **checked** against the day's puzzle of that generator (see [Replay checks](#replay-checks)). A replay that fails a check does **not** reject the result: it is stored with the replay and automatically flagged as suspicious, with the failed check as the reason. So is a result with no replay. An automatic flag is only visible to admins until one confirms it by flagging the result themselves (see the admin flag endpoint).

Clients queue results offline and retry until they receive `200`/`201`. A `400` is final; the client should drop the result and not retry.

### `GET /api/v1/leaderboard?date=YYYY-MM-DD&generator=1|2`

The board of one generator's results for a day. `date` defaults to today. The optional `generator` (`1` or `2`, else `400 bad_request`) defaults to the default generator (the first enabled) and is echoed in the response; only results played with it are ranked or listed.

```json
{
  "date": "2026-10-26",
  "generator": 1,
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
    { "userId": "alice", "displayName": "Alice", "completedLevels": [1, 2, 3], "streak": 4 },
    { "userId": "bob", "displayName": "Bob", "completedLevels": [1, 2, 3, 4, 5], "streak": 1 }
  ]
}
```

- `puzzles` always contains all five levels in order `1..5`; `entries` may be empty.
- Entries are sorted by time ascending. **Ties share a rank** with no tiebreaker, using standard competition ranking (1, 2, 2, 4). Entries with equal time are ordered by `displayName` for stable display only.
- `total` includes only users who completed **all five** levels that day.
- `players` lists every user with at least one result of that generator that day, so clients can show partial progress (e.g. 3 of 5).
- Each `players` item has `"streak": n`: the player's [daily streak](#get-apiv1mestats) as of the board's date, i.e. the number of consecutive days, ending on `date`, on which they had a counting result of any generator. It is 0 when none of their results on `date` counts (for instance, an admin flagged them all), and on today's board it equals their current streak. Older servers don't send it; clients treat a missing value as 0.
- Every puzzle and total entry also has `"suspicious": true|false`: `true` when an admin flagged that result (the server's own automatic flags don't count until an admin confirms one), or for a total entry, any of the player's results that day. Flagged results stay listed and ranked like any other; clients show a visible marker on them. Who flagged a result and why is only shown to admins.

### `GET /api/v1/endless`

The [endless seed](#endless-seed).

```json
{ "seed": "3242a2d84b0602b6" }
```

### `GET /api/v1/me/endless`

All of the caller's endless results of every series, ordered by `generator`, difficulty then number; each carries its `generator`. Lets a fresh device know which puzzles are already solved.

```json
{
  "results": [
    { "difficulty": 1, "number": 12, "elapsedMs": 183000, "completedAt": "2026-10-26T09:15:00+13:00" }
  ]
}
```

### `GET /api/v1/me/stats?generator=1|2`

The caller's streak and personal statistics, for the Stats screen.

```json
{
  "generator": 2,
  "today": "2026-11-05",
  "streak": { "current": 4, "best": 12, "lastDate": "2026-11-05" },
  "daily": [
    {
      "difficulty": 1,
      "completed": 30,
      "bestMs": 95000,
      "averageMs": 140250,
      "recent": [{ "date": "2026-11-04", "level": 1, "elapsedMs": 150000 }]
    }
  ],
  "endless": [
    { "difficulty": 1, "completed": 12, "highest": 14, "bestMs": 120000, "averageMs": 180000 }
  ]
}
```

- `today` is today's game date in the server's timezone, as in `GET /api/v1/week`.
- `generator` echoes the [generator version](#generator-versions) the `daily` numbers are for. The optional query parameter `generator` (`1` or `2`, else `400 bad_request`) picks it; it defaults to the default generator (the first enabled). Only results played with that generator are counted in `daily`, so a player keeps a separate record per generator. `streak` does not depend on it: the streak is a daily habit across generators, not a per-generator record. The `endless` numbers do: each series is its own record. Clients treat a missing `generator` (older servers) as `1`.
- **Streak**, across all difficulties and generators. A day counts when the caller has at least one daily result on that game date (any level, any generator) that is not flagged by an admin. The server's own automatic flags don't stop a day counting, since they are admin-only until confirmed and can be false positives; an admin flag, including a confirmed automatic one, does. Days are the stored game dates, so day boundaries match the daily puzzle, and consecutive means consecutive calendar days.
  - `current` is the number of consecutive counting days ending today, or ending yesterday when today has no counting result yet (today isn't over). Otherwise it is 0.
  - `best` is the longest run of consecutive counting days ever, and is never less than `current`.
  - `lastDate` is the latest counting date, or `null` when there is none.
- `daily` always has five entries, `difficulty` 1 (Easy) to 5 (Diabolical) in order. A daily result's difficulty is the tier of its level given the number of games on its day (the level schedule for that date's ISO week, see `levels` in `GET /api/v1/week`), the same mapping as for the endless tiers. It counts all of the caller's daily results, flagged or not: it is their own record.
  - `completed` is the number of results; `bestMs` is the fastest and `averageMs` the mean rounded to the nearest millisecond. Both are `null` when `completed` is 0.
  - `recent` is the caller's 20 most recent results of that difficulty, by date and then level, oldest first. It is empty when there are none.
- `endless` is for the same `generator` as `daily` (one series' numbers; the query parameter and its default are as above). It always has five entries, `difficulty` 1 to 5 in order. `completed` is the number of puzzles solved, `highest` the highest puzzle number solved (0 when none), and `bestMs` and `averageMs` as above (`null` when none).

### `POST /api/v1/endless/results`

Submit one completed endless puzzle.

```json
{
  "generator": 2,
  "difficulty": 1,
  "number": 12,
  "elapsedMs": 183000,
  "completedAt": "2026-10-26T09:15:00+13:00",
  "replay": { "version": 1, "events": [{ "t": 0, "w": 1761423000000, "a": "start" }, "..."] }
}
```

- The rules are those of `POST /api/v1/results`, with `difficulty` and `number` in place of `date` and `level`, and no date limits: an endless puzzle can be solved at any time.
- `generator` is the series (`1` when missing; anything else is `400 invalid_result`). Any series is accepted at any time, enabled or not (the [mid-game rule](#enabled-generators)), so results queued offline still land after the admin changes the enabled generators. The replay is checked against that series' puzzle.
- **Idempotent**: one result per `(user, generator, difficulty, number)`. The first accepted submission wins; later ones are ignored.
  - `201 Created` - stored.
  - `200 OK` - a result already existed; the body is the **stored** result, which may differ from the one submitted.
  - Both return the result object `{ "generator", "difficulty", "number", "elapsedMs", "completedAt" }` (never the replay).
- **Sanity caps** (`400 invalid_result` on failure):
  - `difficulty` in `1..5`.
  - `number` in `1..9007199254740991`.
  - `elapsedMs` in `[5000, 86400000]` (5 s to 24 h).
  - `completedAt` parses as RFC 3339. It is stored as reported and is informational only.
  - `replay`, when present, is well-formed as described under [Replays](#replays) (`400 invalid_result` otherwise).
- A missing required field or a malformed body is `400 bad_request`. The whole request body is capped at **1 MiB** (`413 too_large`).
- The replay is **checked** against the endless puzzle (see [Replay checks](#replay-checks)). As for the dailies, a replay that fails a check does not reject the result: it is stored and automatically flagged as suspicious with the failed check as the reason, as is a result with no replay ("No replay submitted"). An automatic flag is only visible to admins until one confirms it.

Clients queue results offline and retry until they receive `200`/`201`. A `400` is final; the client should drop the result and not retry.

### `GET /api/v1/endless/leaderboard`

Every player's progress in each difficulty of one series. The query parameter `generator` (`1` or `2`, else `400 bad_request`) picks it; it defaults to the default generator (the first enabled), as for `GET /api/v1/me/stats`.

```json
{
  "generator": 1,
  "difficulties": [
    {
      "difficulty": 1,
      "players": [
        { "rank": 1, "userId": "2", "displayName": "Bob", "completed": 12, "highest": 14, "suspicious": false },
        { "rank": 2, "userId": "1", "displayName": "Alice", "completed": 9, "highest": 9, "suspicious": false },
        { "rank": 2, "userId": "3", "displayName": "Carol", "completed": 9, "highest": 30, "suspicious": true }
      ]
    }
  ]
}
```

- `difficulties` always contains all five tiers in order `1..5`; `players` may be empty.
- `players` lists every user with at least one result in that difficulty, ranked by `completed` (puzzles solved) descending. **Ties share a rank** with no tiebreaker, using standard competition ranking (1, 2, 2, 4). Equal players are ordered by `displayName`, then `userId`, for stable display only.
- `highest` is the highest puzzle number the player has solved in that difficulty.
- `suspicious` is `true` when an admin flagged any of the player's results in that difficulty (the server's own automatic flags don't count until an admin confirms one). Flagged results still count towards `completed`.

### `GET /api/v1/endless/leaderboard/{difficulty}/{number}`

The times on one endless puzzle of one series (the optional `generator` parameter works as on the progress leaderboard), laid out as a puzzle in the daily leaderboard.

```json
{
  "generator": 1,
  "difficulty": 1,
  "number": 12,
  "entries": [
    { "rank": 1, "userId": "2", "displayName": "Bob", "elapsedMs": 150000, "suspicious": false },
    { "rank": 2, "userId": "1", "displayName": "Alice", "elapsedMs": 183000, "suspicious": false }
  ]
}
```

- Entries are sorted by time ascending, with the same ranking, tie ordering and `suspicious` rules as a daily puzzle. `entries` is empty when nobody has solved the puzzle.
- `400 bad_request` if `difficulty` is not `1..5`, `number` is not `1..9007199254740991` or `generator` is not `1` or `2`.

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

The server replays the events on the puzzle (a daily regenerated from the week seed, an endless one from the endless seed) and checks, in order:

1. **Shape**: `start` is first with `t` = 0, `finish` is last, and neither appears anywhere else.
2. **Timer**: `t` never decreases, and it stays the same while the timer is stopped (after `pause` or `restore`, until `resume`), except that `restore` itself may move it forward (the time banked by the last save before the app was closed) and `resume` may be up to **1 second** later than the event before it (older clients stamped it a few milliseconds late).
3. **Moves**: every `place`, `erase`, `noteAdd`, `noteRemove`, `undo` and `clear` happens while the timer runs and is legal on the board at that point (no changing a given, no `noteAdd` of a mark already there, and so on), and `pause`/`resume` alternate.
4. **Solved**: the board after the last move is the puzzle's solution, the solving `place` is followed directly by `finish`, and the `finish` event's `t` equals the submitted `elapsedMs`.
5. **Wall clock**: the wall-clock time spent with the timer running (the sum of `w` gaps between consecutive events while it runs; a gap where `w` goes backwards, e.g. a clock change, counts as 0) is at least `elapsedMs` minus **2 seconds**. Equivalently, the replay's wall-clock span minus the time spent paused can't be shorter than the time claimed.

A replay that passes is `valid`; one that fails is `invalid`, with the first failed check as the reason.

## Admin endpoints (results)

The anti-cheat tools. They need an admin token, exactly as the update endpoints below (`401` / `403` otherwise), but work whether or not the server has the updater.

### `GET /api/v1/admin/results?date=YYYY-MM-DD`

Every result of every generator for a day (defaults to today, any past date allowed), ordered by generator, level, then time. Each item has its `generator`. The per-result routes below take an optional query parameter `generator` (`1` or `2`, default `1`, else `400 bad_request`), so they address the right result and the replay's `givens` come from that generator's puzzle.

```json
{
  "date": "2026-10-26",
  "levels": 5,
  "results": [
    {
      "userId": "2",
      "displayName": "Bob",
      "generator": 1,
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

## Admin endpoints (endless results)

The same anti-cheat tools for [endless](#endless-seed) results, with the same access rules as the admin endpoints above. Each list item has its `generator`. The per-result routes below take an optional query parameter `generator` (`1` or `2`, default `1`, else `400 bad_request`) naming the series, so they address the right result and the replay's `givens` come from that series' puzzle.

### `GET /api/v1/admin/endless/results?date=YYYY-MM-DD`

Every endless result **submitted** on a day (defaults to today, any past date allowed), where the day runs from midnight to midnight in the game timezone. Endless puzzles have no date of their own, so the submission time is what places a result on a day. Ordered by generator, difficulty, number, then time.

```json
{
  "date": "2026-10-26",
  "results": [
    {
      "userId": "2",
      "displayName": "Bob",
      "generator": 1,
      "difficulty": 5,
      "number": 12,
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

- `replay` is `valid`, `invalid` (see `replayError`) or `missing` (submitted without one).
- `flag` is as for the daily admin results.

### `GET /api/v1/admin/endless/results/{difficulty}/{number}/{userId}/replay`

One result with everything needed to watch it back: the fields of a list item above, plus `givens` (the puzzle's starting grid as 81 digits, `0` = empty; never the solution) and `events` (the stored replay's events, `[]` when there is none). `400 bad_request` for a bad path value, `404 not_found` if there is no such result.

### `PUT /api/v1/admin/endless/results/{difficulty}/{number}/{userId}/flag`

Flags a result as suspicious, with the same body, limits and replacement semantics as the daily flag endpoint. `200` with the updated list item, `404 not_found` if there is no such result.

### `DELETE /api/v1/admin/endless/results/{difficulty}/{number}/{userId}/flag`

Removes the flag (automatic or not). `200` with the updated list item; also `200` if it wasn't flagged. `404 not_found` if there is no such result.

## Admin endpoints (puzzle generator)

The [enabled generators](#enabled-generators), with the same access rules as the other admin endpoints (`401` / `403` otherwise), working whether or not the server has the updater. Versions are `1` (Classic) and `2` (Graded).

### `GET /api/v1/admin/generator`

```json
{ "enabled": [1, 2] }
```

`enabled` is the set of enabled generators, ascending and never empty: `[1]`, `[2]` or `[1, 2]`.

### `PUT /api/v1/admin/generator`

Body `{ "enabled": [2] }`. Makes that the enabled set, **immediately**: there is no pending change and no schedule. Duplicates are collapsed and the order doesn't matter. A missing, `null`, empty or non-list `enabled`, or one holding anything but `1` and `2`, is `400 bad_request`. `200` with the object of `GET /api/v1/admin/generator`.

The old `DELETE /api/v1/admin/generator/pending` is gone (`404 not_found`).

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
