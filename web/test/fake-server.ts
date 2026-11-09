// An in-memory v1 server and OIDC provider behind a fetch function, following docs/API.md.
import type { EndlessResult, GameResult } from "../src/api/models.ts";
import { createPkce } from "../src/api/oidc.ts";
import { weekAt } from "../src/game/calendar.ts";
import { weekSeed } from "../src/serverless/seed.ts";

export const ISSUER = "https://auth.test/o/sudoku/";
export const SECRET = "test-secret-0123456789";
/** `HMAC-SHA256(SECRET, "sudoku-endless")`, first 8 bytes: the server's endless seed (docs/API.md). */
export const ENDLESS_SEED = "3242a2d84b0602b6";

export class FakeServer {
  online = true;
  rejectAll = false;
  /** When set, result uploads (daily and endless) answer this status instead of storing. */
  resultsStatus: number | null = null;
  /** When set, only endless result uploads answer this status. */
  endlessResultsStatus: number | null = null;
  /** When set, the endless leaderboard endpoints answer this status. */
  endlessBoardStatus: number | null = null;
  /** When set, the endless leaderboard endpoints wait for this promise before answering. */
  endlessBoardGate: Promise<void> | null = null;
  levels = 5;
  /** The enabled generators, ascending, as `GET /week` and `GET /admin/generator` report them; PUT changes them. */
  generators: number[] = [1];
  /** False plays an older server: `GET /week` and `GET /me/stats` leave the generator fields out. */
  reportsGenerator = true;
  /** False plays a server from before generators could be enabled together: `GET /week` has `generator` but no `generators`. */
  reportsGenerators = true;
  /** When set, the admin generator endpoints answer this status. */
  generatorStatus: number | null = null;
  /** Answer to `GET /me/stats`; `statsStatus` makes it fail instead, and `statsGate` holds the answer back. */
  stats: unknown = {
    today: "2026-10-27",
    streak: { current: 4, best: 12, lastDate: "2026-10-27" },
    daily: [1, 2, 3, 4, 5].map((difficulty) => ({
      difficulty, completed: difficulty === 1 ? 3 : 0, bestMs: difficulty === 1 ? 90000 : null, averageMs: difficulty === 1 ? 120000 : null,
      recent: difficulty === 1 ? [{ date: "2026-10-25", level: 1, elapsedMs: 150000 }, { date: "2026-10-26", level: 1, elapsedMs: 90000 }] : [],
    })),
    endless: [1, 2, 3, 4, 5].map((difficulty) => ({
      difficulty, completed: difficulty === 1 ? 2 : 0, highest: difficulty === 1 ? 5 : 0,
      bestMs: difficulty === 1 ? 60000 : null, averageMs: difficulty === 1 ? 70000 : null,
    })),
  };
  statsStatus: number | null = null;
  statsGate: Promise<void> | null = null;
  /** The leaderboard's `players`. */
  leaderboardPlayers: unknown[] = [];
  /** Whether `/me` reports the user as an admin; when false the admin endpoints answer 403. */
  admin: boolean | undefined = undefined;
  /** Answer to the admin endpoints, as the server would give them. */
  adminReleases: unknown = {
    current: { version: "1.2.3", os: "linux", arch: "amd64", asset: "sudoku-server-linux-amd64", updatesWeb: false },
    releases: [],
    update: { state: "idle", action: "", target: "", message: "", error: "", bytesDone: 0, bytesTotal: 0, startedAt: null, finishedAt: null, rollbackAvailable: false },
  };
  adminStatus: unknown = (this.adminReleases as { update: unknown }).update;
  /** Answers to the admin results endpoints: the list, one result's replay, and a flag change. */
  adminResultsList: unknown = { date: "2026-10-27", levels: 5, results: [] };
  adminReplayDetail: unknown = null;
  adminFlagResult: unknown = null;
  /** The same for the endless admin results endpoints. */
  adminEndlessList: unknown = { date: "2026-10-27", results: [] };
  adminEndlessReplayDetail: unknown = null;
  adminEndlessFlagResult: unknown = null;
  readonly authMode: "dev" | "oidc";
  readonly now: () => number;

  // OIDC provider state.
  oidcSub = "alice";
  /** Revokes every refresh token, as an admin ending the session would. */
  refreshRevoked = false;
  /** Refresh grants processed (including those whose response was lost). */
  refreshGrants = 0;
  /** Like Authentik's refresh token threshold: a refresh rotates the refresh token only once it is this old. 0 rotates on every refresh. */
  refreshThresholdMs = 0;
  /** How long a refresh token lives. */
  refreshLifetimeMs = 30 * 24 * 3600_000;
  /** The token endpoint is unreachable: fetch rejects with a TypeError and nothing is processed. */
  idpOnline = true;
  /** The token endpoint answers this status without processing the request (e.g. 429, 503). */
  tokenStatus: number | null = null;
  /** The next token endpoint calls are processed but their responses are lost (fetch rejects after the IdP rotated). */
  loseTokenResponses = 0;
  /** How far ahead of the IdP the API server's clock runs, when judging access token expiry. */
  skewMs = 0;
  readonly #codes = new Map<string, string>(); // code -> PKCE challenge
  readonly #accessTokens = new Map<string, number>(); // token -> expiry (epoch ms)
  readonly #refreshTokens = new Map<string, { sub: string; issuedAt: number; revoked: boolean }>();
  #counter = 0;

  readonly requests: { method: string; url: URL; headers: Headers; body: string }[] = [];
  /** Stored daily results; one without a `generator` plays a result from before there were several generators (Classic). */
  readonly stored: GameResult[] = [];
  /** Stored endless results; one without a `generator` plays a result from before there were several series (Classic). */
  readonly storedEndless: (Omit<EndlessResult, "generator"> & { generator?: number })[] = [];

  constructor(now: () => number, authMode: "dev" | "oidc" = "dev") {
    this.now = now;
    this.authMode = authMode;
  }

  /** The API server forgets every access token, as after a signing key rotation. */
  forgetAccessTokens(): void {
    this.#accessTokens.clear();
  }

  /** The default generator: the first enabled. */
  get generator(): number {
    return this.generators[0]!;
  }

  posts(): number {
    return this.requests.filter((r) => r.url.pathname === "/api/v1/results").length;
  }

  /** The provider "redirects" back: returns the redirect URL for an authorization URL. */
  authorize(authorizationUrl: string, state?: string): string {
    const q = new URL(authorizationUrl).searchParams;
    const code = `code${++this.#counter}`;
    this.#codes.set(code, q.get("code_challenge")!);
    return `${q.get("redirect_uri")}?code=${code}&state=${state ?? q.get("state")}`;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    if (!this.online) throw new TypeError("Failed to fetch");
    const url = new URL(String(input));
    const request = { method: init?.method ?? "GET", url, headers: new Headers(init?.headers), body: init?.body ? String(init.body) : "" };
    this.requests.push(request);
    return this.#handle(request);
  };

  async #handle(r: FakeServer["requests"][number]): Promise<Response> {
    switch (r.url.pathname) {
      case "/api/v1/config":
        return json({ timezone: "Pacific/Auckland", authMode: this.authMode, version: "1.2.3", oidc: { issuer: ISSUER, clientId: "sudoku", scopes: ["openid", "profile", "offline_access"] } });
      case "/o/sudoku/.well-known/openid-configuration":
        return json({
          issuer: ISSUER, authorization_endpoint: "https://auth.test/o/authorize/",
          token_endpoint: "https://auth.test/o/token/", end_session_endpoint: "https://auth.test/o/end/",
        });
      case "/o/token/": {
        if (!this.idpOnline) throw new TypeError("Failed to fetch");
        if (this.tokenStatus !== null) return json({ error: "temporarily_unavailable" }, this.tokenStatus);
        const response = await this.#token(new URLSearchParams(r.body));
        if (this.loseTokenResponses > 0) {
          this.loseTokenResponses--;
          throw new TypeError("Failed to fetch");
        }
        return response;
      }
    }
    const user = this.#user(r.headers.get("Authorization"));
    if (!user) return json({ error: { code: "unauthorized", message: "bad token" } }, 401);
    if (r.url.pathname.startsWith("/api/v1/admin/endless/results")) {
      if (!this.admin) return json({ error: { code: "forbidden", message: "admin access required" } }, 403);
      if (r.url.pathname === "/api/v1/admin/endless/results") return json(this.adminEndlessList);
      return json(r.url.pathname.endsWith("/replay") ? this.adminEndlessReplayDetail : this.adminEndlessFlagResult);
    }
    if (r.url.pathname.startsWith("/api/v1/endless/leaderboard")) {
      await this.endlessBoardGate;
      if (this.endlessBoardStatus !== null) return json({ error: { code: "boom", message: "board broke" } }, this.endlessBoardStatus);
    }
    const board = /^\/api\/v1\/endless\/leaderboard\/(\d+)\/(\d+)$/.exec(r.url.pathname);
    if (board) {
      const [difficulty, number] = [Number(board[1]), Number(board[2])];
      const generator = Number(r.url.searchParams.get("generator") ?? this.generator);
      const entries = this.storedEndless.filter((s) => (s.generator ?? 1) === generator && s.difficulty === difficulty && s.number === number)
        .sort((a, b) => a.elapsedMs - b.elapsedMs)
        .map((s, i) => ({ rank: i + 1, userId: "alice", displayName: "Alice", elapsedMs: s.elapsedMs, suspicious: false }));
      return json({ generator, difficulty, number, entries });
    }
    if (r.url.pathname.startsWith("/api/v1/admin/results")) {
      if (!this.admin) return json({ error: { code: "forbidden", message: "admin access required" } }, 403);
      if (r.url.pathname === "/api/v1/admin/results") return json(this.adminResultsList);
      return json(r.url.pathname.endsWith("/replay") ? this.adminReplayDetail : this.adminFlagResult);
    }
    switch (r.url.pathname) {
      case "/api/v1/me":
        return json(this.admin === undefined ? user : { ...user, admin: this.admin });
      case "/api/v1/admin/releases":
        if (!this.admin) return json({ error: { code: "forbidden", message: "admin access required" } }, 403);
        return json(this.adminReleases);
      case "/api/v1/admin/update":
        if (!this.admin) return json({ error: { code: "forbidden", message: "admin access required" } }, 403);
        return json(this.adminStatus, r.method === "POST" ? 202 : 200);
      case "/api/v1/admin/rollback":
        if (!this.admin) return json({ error: { code: "forbidden", message: "admin access required" } }, 403);
        return json(this.adminStatus, 202);
      case "/api/v1/admin/generator": {
        if (!this.admin) return json({ error: { code: "forbidden", message: "admin access required" } }, 403);
        if (this.generatorStatus !== null) return json({ error: { code: "boom", message: "generator broke" } }, this.generatorStatus);
        if (r.method === "PUT") {
          const enabled = (JSON.parse(r.body) as { enabled: number[] }).enabled;
          if (!Array.isArray(enabled) || enabled.length === 0 || enabled.some((v) => v !== 1 && v !== 2)) {
            return json({ error: { code: "bad_request", message: "enabled must list 1 and/or 2" } }, 400);
          }
          this.generators = [...new Set(enabled)].sort();
        }
        return json({ enabled: this.generators });
      }
      case "/api/v1/week": {
        const info = weekAt(this.now());
        const generator = !this.reportsGenerator ? {}
          : this.reportsGenerators ? { generator: this.generator, generators: this.generators, pendingGenerator: null }
            : { generator: this.generator, pendingGenerator: null };
        return json({ ...info, seed: await weekSeed(SECRET, info.isoWeek), timezone: "Pacific/Auckland", levels: this.levels, ...generator });
      }
      case "/api/v1/me/results": {
        const date = r.url.searchParams.get("date") ?? weekAt(this.now()).today;
        return json({ date, results: this.stored.filter((s) => s.date === date).map(({ date: _, replay: _r, ...rest }) => rest) });
      }
      case "/api/v1/results": {
        if (this.resultsStatus !== null) return json({ error: { code: "boom", message: "" } }, this.resultsStatus);
        if (this.rejectAll) return json({ error: { code: "invalid_result", message: "nope" } }, 400);
        const sent = JSON.parse(r.body) as GameResult;
        if (sent.generator !== undefined && sent.generator !== 1 && sent.generator !== 2) {
          return json({ error: { code: "invalid_result", message: "unknown generator" } }, 400);
        }
        // Without one, the default generator (as from an older app); an older server keeps no generator at all.
        const result = this.reportsGenerators ? { ...sent, generator: sent.generator ?? this.generator } : sent;
        const existing = this.stored.find((s) => (s.generator ?? 1) === (result.generator ?? 1) && s.date === result.date && s.level === result.level);
        if (existing) return json(existing, 200);
        this.stored.push(result);
        return json(result, 201);
      }
      case "/api/v1/endless":
        return json({ seed: ENDLESS_SEED });
      case "/api/v1/me/endless":
        return json({ results: this.storedEndless.map(({ replay: _, ...rest }) => rest) });
      case "/api/v1/endless/results": {
        if (this.resultsStatus !== null || this.endlessResultsStatus !== null) {
          return json({ error: { code: "boom", message: "" } }, this.endlessResultsStatus ?? this.resultsStatus!);
        }
        if (this.rejectAll) return json({ error: { code: "invalid_result", message: "nope" } }, 400);
        const result = JSON.parse(r.body) as EndlessResult;
        const existing = this.storedEndless.find((s) => (s.generator ?? 1) === result.generator && s.difficulty === result.difficulty && s.number === result.number);
        if (existing) return json(existing, 200);
        this.storedEndless.push(result);
        return json(result, 201);
      }
      case "/api/v1/endless/leaderboard": {
        const generator = Number(r.url.searchParams.get("generator") ?? this.generator);
        return json({
          generator,
          difficulties: [1, 2, 3, 4, 5].map((difficulty) => {
            const mine = this.storedEndless.filter((s) => (s.generator ?? 1) === generator && s.difficulty === difficulty);
            return {
              difficulty,
              players: mine.length === 0 ? [] : [{
                rank: 1, userId: "alice", displayName: "Alice", completed: mine.length,
                highest: Math.max(...mine.map((s) => s.number)), suspicious: false,
              }],
            };
          }),
        });
      }
      case "/api/v1/leaderboard": {
        const generator = Number(r.url.searchParams.get("generator") ?? this.generator);
        return json({ date: r.url.searchParams.get("date") ?? weekAt(this.now()).today, generator, puzzles: [], total: { entries: [] }, players: this.leaderboardPlayers });
      }
      case "/api/v1/me/stats":
        await this.statsGate;
        if (this.statsStatus !== null) return json({ error: { code: "boom", message: "stats broke" } }, this.statsStatus);
        return json(this.#statsFor(r.url.searchParams.get("generator")));
    }
    return json({ error: { code: "not_found", message: "" } }, 404);
  }

  #statsFor(generator: string | null): unknown {
    if (!this.reportsGenerator) return this.stats;
    return { ...(this.stats as object), generator: generator === null ? this.generator : Number(generator) };
  }

  #user(authorization: string | null): { id: string; displayName: string } | null {
    const token = authorization?.replace(/^Bearer /, "") ?? "";
    if (this.authMode === "dev") {
      const [, sub, name] = token.split(":");
      return token.startsWith("dev:") && sub && name ? { id: sub, displayName: name } : null;
    }
    const expiry = this.#accessTokens.get(token);
    if (expiry === undefined || expiry <= this.now() + this.skewMs) return null;
    return { id: token.split("|")[0]!, displayName: "Alice" };
  }

  async #token(form: URLSearchParams): Promise<Response> {
    if (form.get("grant_type") === "authorization_code") {
      const challenge = this.#codes.get(form.get("code") ?? "");
      this.#codes.delete(form.get("code") ?? "");
      if (!challenge || (await createPkce(form.get("code_verifier") ?? "")).challenge !== challenge) {
        return json({ error: "invalid_grant" }, 400);
      }
      return this.#issue(true);
    }
    if (form.get("grant_type") === "refresh_token") {
      const old = this.#refreshTokens.get(form.get("refresh_token") ?? "");
      if (this.refreshRevoked || !old || old.revoked || old.issuedAt + this.refreshLifetimeMs <= this.now()) {
        return json({ error: "invalid_grant", error_description: "revoked" }, 400);
      }
      this.refreshGrants++;
      const rotate = this.now() - old.issuedAt >= this.refreshThresholdMs;
      if (rotate) old.revoked = true;
      return this.#issue(rotate);
    }
    return json({ error: "unsupported_grant_type" }, 400);
  }

  #issue(withRefresh: boolean): Response {
    const token = `${this.oidcSub}|${++this.#counter}`;
    this.#accessTokens.set(token, this.now() + 300_000);
    const refresh = `refresh-${this.oidcSub}-${this.#counter}`;
    if (withRefresh) this.#refreshTokens.set(refresh, { sub: this.oidcSub, issuedAt: this.now(), revoked: false });
    return json({
      access_token: token, token_type: "Bearer", expires_in: 300, id_token: `id-${this.oidcSub}`,
      ...(withRefresh ? { refresh_token: refresh } : {}),
    });
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
