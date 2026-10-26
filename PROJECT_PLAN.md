# Sudoku - Project Plan

A self-hosted daily Sudoku game for family. Everyone gets the **same 5 puzzles each day** (one per difficulty level), plays them once, and appears on a per-day leaderboard. There is no advantage to playing earlier in the day - the board ranks by solve time, not clock time.

## Goals

- Five puzzles per day, one at each of five difficulty levels.
- Everyone sees the identical five puzzles for a given date.
- Each person may play each of the day's puzzles once. After finishing (or the day rolling over) they wait for the next day.
- Per-day leaderboard: a board per puzzle ranked by solve time, plus a daily-total board summing all five.
- Android app plays fully offline once synchronised; results sync back when a connection returns.
- A self-hosted web client for iOS users and anyone on a browser (no Apple developer account needed).
- Authentication via OIDC against self-hosted Authentik.

## Non-goals (for now)

- No live multiplayer or real-time race.
- No native iOS app (the web client covers iOS).
- No puzzle archive / replaying past days (candidate for later).
- No public/internet-scale hardening - small trusted family deployment.
- No heavy anti-cheat. Times are self-reported by the client and trusted (see Trust model).

## Confirmed decisions

| Area              | Decision                                                      |
| ----------------- | ------------------------------------------------------------- |
| Puzzle generation | Deterministic from a weekly seed; generated **client-side**   |
| Weekly seed       | Derived from a server secret + ISO week (nothing stored)      |
| Backend           | Go, single static binary (no JVM/runtime to install)          |
| Mobile            | Kotlin Multiplatform (shared logic, Android target now)       |
| Web client        | Kotlin Multiplatform (Compose for Web / Kotlin-JS)            |
| Shared logic      | KMP module: board model, generator, validation                |
| Database          | SQLite (native in the LXC)                                    |
| Auth              | OIDC via self-hosted Authentik                                |
| Trust model       | Minimal - trust the family; sanity caps only                  |
| Leaderboard       | Per-puzzle boards + daily-total board                         |
| Day boundary      | Fixed server timezone: **Pacific/Auckland**                   |
| Difficulty        | By target given-count per level (see below), unique-solution  |
| Leaderboard ties  | Shared rank, no tiebreaker (equal times rank equal)           |
| Partial play      | Shown on per-puzzle boards; excluded from daily-total board   |
| TLS / proxy       | Caddy (existing) terminates TLS; proxies to local Go server   |
| Deployment        | Dedicated LXC, native (systemd services), **no Docker**       |

## Architecture overview

The key design choice: **puzzle generation is deterministic and runs on the client.** A puzzle is a pure function of `(weekSeed, dayOfWeek, difficultyLevel)`. Given the same inputs, every platform produces the identical puzzle - which is what guarantees the whole family plays the same five puzzles. The server never needs to generate or even know the puzzles; it only distributes the weekly seed and records results.

This splits the system cleanly:

1. **Shared KMP module** - pure Kotlin, compiled to Android and to JS for web:
   - Sudoku board model and validation.
   - Deterministic generator: `generate(weekSeed, dayOfWeek, level) -> puzzle`.
   - Difficulty tiers (target given-counts), with a uniqueness guarantee.
   - API request/response data models.

2. **Server (Go)** - a single static binary run under systemd in the LXC. Deliberately thin:
   - Issues the current week's seed (plus week metadata and the day boundary).
   - Accepts result submissions; stores them in SQLite.
   - Serves per-puzzle and daily-total leaderboards.
   - Validates OIDC access tokens from Authentik and maps them to local users.
   - Serves the compiled web client's static assets.
   - No puzzle logic. (Server-side verification would require porting the generator to Go; out of scope under the minimal trust model.)

3. **Clients**
   - **Android** (KMP + Compose): fetches the weekly seed, generates all puzzles locally, plays fully offline, uploads results when online.
   - **Web** (KMP Compose for Web / Kotlin-JS): same gameplay for iOS/browser users.

### Puzzle generation - weekly seed

- A puzzle is `generate(weekSeed, dayOfWeek, level)`, deterministic and pure.
- One seed covers a whole ISO week. A client that has the week's seed can generate all 7 days × 5 levels for that week without further network access.
- **Seed is derived, not stored**: `weekSeed = KDF(serverSecret, isoWeek)`. The server computes it on demand from a single long-lived secret; there is no seed table. Rotating the secret would change all future (and past) puzzles, so the secret is fixed for the life of the deployment.
- Difficulty is driven by a target number of givens per level. The generator removes cells toward that target **only while the puzzle retains a unique solution**, so given-count is an approximate difficulty proxy that still yields valid puzzles. A technique-based rating can replace this later without touching anything else.

  | Level | Name        | Target givens |
  | ----- | ----------- | ------------- |
  | 1     | Easy        | ~40           |
  | 2     | Medium      | ~36           |
  | 3     | Hard        | ~32           |
  | 4     | Expert      | ~28           |
  | 5     | Diabolical  | ~24           |

  Targets are a starting point and can be tuned after playtesting. (A classic Sudoku needs at least 17 givens for a unique solution; level 5 stays well above that to keep solve times reasonable.)

### Day and week boundaries

- "The day" and "the week" are defined in a single fixed timezone, **Pacific/Auckland**, for everyone, regardless of device locale - so date boundaries and the weekly seed rollover are consistent for all players.
- The day-of-week and week-number used by the generator are computed in that timezone.

### Offline and sync (Android)

- The device holds **exactly one week's seed at a time** - the current week's. It does not pre-fetch or cache future weeks.
- Because of this, the device **must come online at the start of each week** (on or after Monday, Pacific/Auckland) to fetch that week's seed. Until it does, the new week's puzzles are unavailable; a device that stays offline across the week boundary cannot play the new week until it reconnects.
- Once it has the current week's seed it generates that week's puzzles entirely on-device and plays them fully offline for the rest of the week.
- Play, timing, and win-detection all use the shared validation logic - no network mid-puzzle.
- Each completed puzzle records: which puzzle (date + level), elapsed solve time, completion timestamp.
- Results queue locally and upload when connectivity returns; uploads are idempotent (one result per user per puzzle; later duplicates ignored).
- If the day rolls over while offline (within the same week), unsynced results still upload and still count for the date they were played.

### Timing semantics

- Solve time = elapsed time actively spent on that puzzle, measured by the client.
- The timer pauses when the puzzle/app is backgrounded and resumes on return, so stepping away does not inflate time. Exact pause rules finalised in design.
- Server applies only sanity caps (reject negative or implausibly short/long times) - no deep verification.

### Leaderboard

- Scope: one calendar day (Pacific/Auckland).
- **Per-puzzle board** (×5): everyone who completed that puzzle, ranked by solve time ascending.
- **Daily-total board**: sum of solve times across all five puzzles, ascending; only users who completed all five. Partial completions appear on per-puzzle boards but not the total board.
- **Partial progress is shown** - the boards make clear who has completed which puzzles (e.g. 3 of 5), not just the fully finished.
- **Ties**: equal solve times share the same rank, with no tiebreaker.
- Shows who completed each puzzle and the time taken.
- Ranking is independent of when during the day the puzzle was played.

## Authentication (OIDC / Authentik)

- Both clients authenticate against Authentik via OIDC.
- Web: Authorization Code + PKCE browser flow.
- Android: Authorization Code + PKCE via the system browser (AppAuth-style), with refresh tokens for offline-friendly sessions.
- The Go server validates access tokens (JWT signature + issuer/audience) on API calls.
- Stable OIDC subject claim maps to a local user record used for the leaderboard; display name from Authentik claims.
- OIDC endpoints, client IDs, and secrets are configurable (not hard-coded) so the deployment points at the user's Authentik instance.

## Data model (conceptual)

Final schema in the design phase; roughly:

- **User** - local record keyed by OIDC subject; display name.
- **Result** - user, date, level, elapsed solve time, completed-at timestamp. Unique per (user, date, level).

Note: neither puzzles nor seeds are stored - puzzles are reproducible from the seed, and the seed is derived on demand from the server secret + ISO week.

## Deployment (LXC, no Docker)

- Single dedicated LXC container.
- **Server**: one static Go binary, no runtime dependencies, run under a systemd service. Config via file + environment (OIDC settings, DB path, server secret, bind address).
- **Database**: SQLite file on disk, owned by the service. No separate DB service to run.
- **TLS / proxy**: the existing **Caddy** instance terminates TLS and reverse-proxies to the Go server on a local address; the Go server itself binds plain HTTP on localhost and does not handle certificates.
- **Web assets**: the compiled web client is served directly by the Go server (behind Caddy).
- **Backups**: periodic SQLite backup on a systemd timer (puzzles are reproducible from the seed, but results and the seed history are not).

## Build and tooling

- **KMP (Gradle)**: `shared` module + `androidApp` + `webApp` (Compose for Web / Kotlin-JS). Produces the Android app and the compiled web bundle.
- **Go**: the server module, built to a static binary for the LXC's architecture.
- Web bundle output is embedded in or served alongside the Go binary.

## Milestones (suggested order)

1. **Shared core (KMP)** - board model, validation, deterministic `generate(seed, day, level)`, five difficulty tiers with uniqueness guarantee. Unit-test determinism across targets.
2. **Server core (Go)** - SQLite schema, weekly-seed endpoint, OIDC validation, user records.
3. **Results + leaderboard** - idempotent submission with sanity caps; per-puzzle and daily-total boards.
4. **Android app** - play UI, local seed cache + offline generation, timing, sync.
5. **Web client** - play UI + leaderboard for iOS/browser.
6. **Deployment** - LXC setup, systemd units, backups, config, TLS decision.
7. **Polish** - timer/pause rules, day/week rollover offline, duplicate submissions, ties, empty states.

## Open questions

1. **Offline session length (Android)** - how long should a login stay valid offline before re-auth is required? (The device must come online weekly for the seed anyway, which is a natural point to refresh auth.)
2. **Difficulty tuning** - confirm the given-count targets for levels 1-5 after playtesting (and whether to later revisit with a technique-based rating).
3. **Timer pause rules** - exact behaviour when the app is backgrounded mid-puzzle.
