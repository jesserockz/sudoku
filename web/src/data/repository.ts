import { type Fetch, SudokuApi, type TokenProvider, devToken } from "../api/client.ts";
import {
  type AppConfig, type DayResult, type EndlessBoard, type EndlessProgress, type EndlessResult, type GameResult, type Leaderboard, type Me,
  type MyStats, type OidcConfig, type Streak, type Week, weekPuzzles,
} from "../api/models.ts";
import { OidcClient, TokenSession, type TokenResponse, createPkce } from "../api/oidc.ts";
import { formatTimestamp, inWeek, today } from "../game/calendar.ts";
import { Game } from "../game/game.ts";
import { MAX_REPLAY_EVENTS, REPLAY_VERSION } from "../game/replay.ts";
import { type EndlessPuzzle, type Puzzle } from "../generator/generator.ts";
import { type AppStorage, type HomeTab, type Settings, endlessGameKey, gameKey } from "./app-storage.ts";
import { randomToken } from "./crypto.ts";
import { type EndlessInProgress, EndlessPuzzleCache, type EndlessSolved, type EndlessSource, endlessInProgressOf } from "./endless.ts";
import { type FlushReport, ResultSync, dailyKey, endlessKey } from "./result-sync.ts";

/** Sign-in failed; the message is fit to show. */
export class SignInError extends Error {}

const PENDING_TTL_MS = 15 * 60 * 1000;

export function normalizeUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  return trimmed.includes("://") ? trimmed : `https://${trimmed}`;
}

/**
 * Server mode's offline-first data layer: settings, the cached week, games, the
 * offline result queue and the API, over {@link AppStorage}.
 *
 * Offline rules: the device keeps exactly one week's seed. With it, every day
 * of that week plays offline; "today" comes from the device clock in
 * Pacific/Auckland. A new week needs a connection. Finished puzzles queue
 * results that upload whenever the server is reachable.
 */
export class SudokuRepository implements EndlessSource {
  readonly sync: ResultSync;
  readonly endlessSync: ResultSync<EndlessResult>;
  readonly tokens: TokenProvider;
  readonly #storage: AppStorage;
  /** Where the identity provider sends the browser back to after sign-in. */
  readonly #redirectUri: string;
  readonly #defaultServerUrl: string;
  readonly #now: () => number;
  readonly #fetch: Fetch;
  readonly #session: TokenSession;
  #api: { url: string; api: SudokuApi } | null = null;
  #oidc: { key: string; client: OidcClient } | null = null;
  #puzzleCache: { key: string; puzzles: Puzzle[] } | null = null;
  readonly #endlessPuzzles = new EndlessPuzzleCache();

  constructor(
    storage: AppStorage,
    redirectUri: string,
    defaultServerUrl = "",
    now: () => number = Date.now,
    fetcher: Fetch = (...args) => fetch(...args),
  ) {
    this.#storage = storage;
    this.#redirectUri = redirectUri;
    this.#defaultServerUrl = defaultServerUrl;
    this.#now = now;
    this.#fetch = fetcher;
    this.#session = new TokenSession(
      () => storage.tokens.read(),
      (t) => storage.tokens.write(t),
      (refreshToken) => {
        const oidc = this.settings().oidc;
        if (!oidc) return Promise.reject(new Error("not signed in with OIDC"));
        return this.#oidcClient(oidc).refresh(refreshToken);
      },
      now,
    );
    this.tokens = async (rejected) => {
      const s = this.settings();
      if (s.devUser) return devToken(s.devUser.sub, s.devUser.name);
      if (s.oidc) return this.#session.token(rejected);
      return null;
    };
    this.sync = new ResultSync(storage.pending, (r) => this.#client().submitResult(r), dailyKey);
    this.endlessSync = new ResultSync(storage.endlessPending, (r) => this.#client().submitEndlessResult(r), endlessKey);
  }

  settings(): Settings {
    return this.#storage.settings.read() ?? { serverUrl: this.#defaultServerUrl, devUser: null, oidc: null };
  }

  /**
   * Whether the app has an identity to play as. With OIDC this stays true when
   * the tokens expire or are revoked, so offline play and the result queue keep
   * working; {@link needsSignIn} then asks for a fresh sign-in.
   */
  get isSignedIn(): boolean {
    const s = this.settings();
    return s.serverUrl.trim() !== "" && (s.devUser !== null || s.oidc !== null);
  }

  /** Signed in with OIDC but without usable tokens: the user should sign in again. */
  get needsSignIn(): boolean {
    return this.settings().oidc !== null && this.#storage.tokens.read() === null;
  }

  today(): string {
    return today(this.#now());
  }

  me(): Me | null {
    return this.#storage.me.read();
  }

  /** The cached week, if it contains `date`. */
  weekFor(date: string = this.today()): Week | null {
    const week = this.#storage.week.read();
    return week && inWeek(week, date) ? week : null;
  }

  /** The day's games for `date`, or `null` if the cached week doesn't cover it. */
  puzzles(date: string = this.today()): Puzzle[] | null {
    const week = this.weekFor(date);
    if (!week) return null;
    const key = JSON.stringify([week.seed, week.levels, week.generator, date]);
    if (this.#puzzleCache?.key !== key) this.#puzzleCache = { key, puzzles: weekPuzzles(week, date) };
    return this.#puzzleCache.puzzles;
  }

  /** The signed-in API client, for calls that don't need caching here (the admin page). */
  api(): SudokuApi {
    return this.#client();
  }

  /** `GET /config` on a server that isn't saved yet (first-run setup). */
  fetchConfig(serverUrl: string): Promise<AppConfig> {
    return new SudokuApi(normalizeUrl(serverUrl), async () => null, this.#fetch).config();
  }

  /**
   * Saves the server and dev identity, then syncs. If the server can't be
   * reached the previous settings are restored and the error propagates.
   */
  async signInDev(serverUrl: string, sub: string, name: string): Promise<void> {
    devToken(sub, name); // validates
    const previous = this.#storage.settings.read();
    this.#storage.settings.write({ serverUrl: normalizeUrl(serverUrl), devUser: { sub, name }, oidc: null });
    this.#api = null;
    try {
      await this.refresh();
    } catch (e) {
      this.#storage.settings.write(previous);
      this.#api = null;
      throw e;
    }
  }

  /**
   * Starts an OIDC sign-in (Authorization Code + PKCE): stores the verifier and
   * state, and returns the URL to send the browser to. It comes back to the
   * redirect URI; pass that URL to {@link completeOidcSignIn}.
   */
  async beginOidcSignIn(serverUrl: string, oidc: OidcConfig): Promise<string> {
    if (!oidc.issuer.trim() || !oidc.clientId.trim()) throw new Error("the server's OIDC settings are incomplete");
    const pkce = await createPkce();
    const pending = {
      serverUrl: normalizeUrl(serverUrl),
      oidc,
      state: randomToken(),
      verifier: pkce.verifier,
      nonce: randomToken(),
      createdAtEpochMs: this.#now(),
    };
    this.#storage.pendingAuth.write(pending);
    return this.#oidcClient(oidc).authorizationUrl(pkce.challenge, pending.state, pending.nonce);
  }

  /**
   * Finishes an OIDC sign-in from the redirect URL: checks `state`, exchanges
   * the code, saves the tokens, then syncs. If a different account than before
   * signs in, the previous account's games and queued results are discarded.
   * Throws {@link SignInError} when sign-in fails; a sync failure after a
   * successful sign-in propagates as is.
   */
  async completeOidcSignIn(redirectUrl: string): Promise<void> {
    const params = new URL(redirectUrl).searchParams;
    const pending = this.#storage.pendingAuth.read();
    this.#storage.pendingAuth.write(null);
    const error = params.get("error");
    if (error) throw new SignInError(`Sign-in failed: ${params.get("error_description") ?? error}`);
    const code = params.get("code");
    if (!code) throw new SignInError("Sign-in failed: no authorization code returned.");
    if (!pending || pending.state !== params.get("state")) {
      throw new SignInError("Sign-in failed: the response didn't match this app's request. Please try again.");
    }
    if (this.#now() - pending.createdAtEpochMs > PENDING_TTL_MS) throw new SignInError("Sign-in took too long. Please try again.");
    let response: TokenResponse;
    try {
      response = await this.#oidcClient(pending.oidc).exchangeCode(code, pending.verifier);
    } catch {
      throw new SignInError("Sign-in failed: couldn't get tokens from the identity provider.");
    }

    const previousUser = this.#storage.me.read();
    this.#storage.settings.write({ serverUrl: pending.serverUrl, devUser: null, oidc: pending.oidc });
    await this.#session.signedIn(response);
    this.#api = null;
    const me = await this.#client().me();
    if (previousUser && previousUser.id !== me.id) this.#storage.clearProgress();
    this.#storage.me.write(me);
    await this.refresh();
  }

  /**
   * Where to send the browser to end the identity provider's session too, or
   * `null` (dev auth, no `end_session_endpoint`, or the provider is
   * unreachable). Call before {@link signOut}, which forgets the ID token.
   */
  async endSessionUrl(postLogoutRedirectUri: string): Promise<string | null> {
    const oidc = this.settings().oidc;
    if (!oidc) return null;
    try {
      return await this.#oidcClient(oidc).endSessionUrl(this.#storage.tokens.read()?.idToken ?? null, postLogoutRedirectUri);
    } catch {
      return null;
    }
  }

  signOut(): void {
    this.#storage.clearUserData();
    this.#api = null;
  }

  /**
   * Brings local state up to date with the server: identity, the current week
   * (replacing the cached one), the endless seed (once), queued results, and
   * today's and the endless results. Network and HTTP failures propagate;
   * queued results stay queued.
   */
  async refresh(): Promise<FlushReport<GameResult | EndlessResult>> {
    const api = this.#client();
    this.#storage.me.write(await api.me());
    this.#storeWeek(await api.week());
    const report = await this.sync.flush();
    const mine = await api.myResults(this.today());
    this.#storage.serverResults.write({ [mine.date]: mine.results });
    if (!this.#storage.endless.read()) this.#storage.endless.write(await api.endless());
    const endless = await this.endlessSync.flush();
    this.#storeEndlessResults((await api.myEndlessResults()).results);
    return {
      accepted: [...report.accepted, ...endless.accepted],
      rejected: [...report.rejected, ...endless.rejected],
      remaining: [...report.remaining, ...endless.remaining],
      failure: report.failure ?? endless.failure,
    };
  }

  /**
   * Fetches the user's stats, with the daily numbers for `generator` (the one in use now when omitted), and keeps the
   * streak for offline (it is the same for every generator). Network and HTTP failures propagate (the stored
   * streak is left as it was). A separate call from {@link refresh}: stats are nice to have and must not fail a sync.
   */
  async fetchStats(generator?: number): Promise<MyStats> {
    const stats = await this.#client().myStats(generator);
    this.#storage.streak.write(stats.streak);
    return stats;
  }

  /** The last streak fetched, or `null` when none is known. */
  streak(): Streak | null {
    return this.#storage.streak.read();
  }

  /** Uploads queued results only. */
  flush(): Promise<FlushReport> {
    return this.sync.flush();
  }

  /** The home page tab last shown on this device. */
  homeTab(): HomeTab {
    return this.#storage.homeTab.read() ?? "daily";
  }

  setHomeTab(tab: HomeTab): void {
    this.#storage.homeTab.write(tab);
  }

  /** Whether the endless explainer has already popped up on this device. */
  endlessHelpSeen(): boolean {
    return this.#storage.endlessHelpSeen.read() ?? false;
  }

  markEndlessHelpSeen(): void {
    this.#storage.endlessHelpSeen.write(true);
  }

  /** Whether the endless seed has been fetched once. */
  endlessReady(): boolean {
    return this.#storage.endless.read() !== null;
  }

  /** Endless puzzle `number` of `difficulty` in `generator`'s series, or `null` until the endless seed has been fetched once. */
  endlessPuzzle(generator: number, difficulty: number, number: number): EndlessPuzzle | null {
    const seed = this.#storage.endless.read()?.seed;
    if (!seed) return null;
    return this.#endlessPuzzles.get(seed, generator, difficulty, number);
  }

  /** Every solved endless puzzle, by {@link endlessGameKey}: the server's record, then the offline queue. */
  endlessSolved(): Map<string, EndlessSolved> {
    const solved = new Map<string, EndlessSolved>();
    for (const r of this.endlessSync.pending()) solved.set(endlessKey(r), { elapsedMs: r.elapsedMs, synced: false });
    for (const r of this.#storage.endlessResults.read() ?? []) solved.set(endlessKey(r), { elapsedMs: r.elapsedMs, synced: true });
    return solved;
  }

  /** Endless games started on this device and not solved yet, by series, difficulty then number. */
  endlessInProgress(): EndlessInProgress[] {
    return endlessInProgressOf(this.#storage.endlessGames.read());
  }

  /** A saved game for an endless puzzle, if it still matches the puzzle. */
  loadEndlessGame(generator: number, puzzle: EndlessPuzzle): Game | null {
    const saved = this.#storage.endlessGames.read()?.[endlessGameKey(generator, puzzle.tier, puzzle.number)];
    return saved && saved.givens === puzzle.givens ? Game.restore(saved) : null;
  }

  saveEndlessGame(generator: number, difficulty: number, number: number, game: Game, nowMs: number): void {
    this.#storage.endlessGames.update((games) => ({ ...games, [endlessGameKey(generator, difficulty, number)]: game.save(nowMs) }));
  }

  /** Queues the result of a just-finished endless game. */
  async completeEndless(generator: number, difficulty: number, number: number, game: Game): Promise<EndlessResult> {
    if (game.completedElapsedMs === null) throw new Error("game isn't complete");
    const result: EndlessResult = { generator, difficulty, number, elapsedMs: game.completedElapsedMs, completedAt: formatTimestamp(this.#now()) };
    if (game.replay.length <= MAX_REPLAY_EVENTS) result.replay = { version: REPLAY_VERSION, events: game.replay.slice() };
    await this.endlessSync.enqueue(result);
    return result;
  }

  endlessProgress(generator: number): Promise<EndlessProgress> {
    return this.#client().endlessProgress(generator);
  }

  endlessBoard(generator: number, difficulty: number, number: number): Promise<EndlessBoard> {
    return this.#client().endlessBoard(generator, difficulty, number);
  }

  /** Keeps the server's endless results, and drops finished games it has: they'd otherwise pile up forever. */
  #storeEndlessResults(results: EndlessResult[]): void {
    this.#storage.endlessResults.write(results);
    const done = new Set(results.map(endlessKey));
    this.#storage.endlessGames.update((games) => games && Object.fromEntries(Object.entries(games).filter(([k, g]) => !(g.completed && done.has(k)))));
  }

  pending(): GameResult[] {
    return this.sync.pending();
  }

  serverResults(date: string): Map<number, DayResult> {
    return new Map((this.#storage.serverResults.read()?.[date] ?? []).map((r) => [r.level, r]));
  }

  leaderboard(date: string): Promise<Leaderboard> {
    return this.#client().leaderboard(date);
  }

  /** A saved game for `puzzle` on `date`, if it still matches the puzzle. */
  loadGame(date: string, puzzle: Puzzle): Game | null {
    const saved = this.#storage.games.read()?.[gameKey(date, puzzle.level)];
    return saved && saved.givens === puzzle.givens ? Game.restore(saved) : null;
  }

  saveGame(date: string, level: number, game: Game, nowMs: number): void {
    this.#storage.games.update((games) => ({ ...games, [gameKey(date, level)]: game.save(nowMs) }));
  }

  /** Queues the result of a just-finished game. */
  async complete(date: string, level: number, game: Game): Promise<GameResult> {
    if (game.completedElapsedMs === null) throw new Error("game isn't complete");
    const result: GameResult = { date, level, elapsedMs: game.completedElapsedMs, completedAt: formatTimestamp(this.#now()) };
    // A replay the server would refuse is left out: the result still counts, flagged as having none.
    if (game.replay.length <= MAX_REPLAY_EVENTS) result.replay = { version: REPLAY_VERSION, events: game.replay.slice() };
    await this.sync.enqueue(result);
    return result;
  }

  #storeWeek(week: Week): void {
    const previous = this.#storage.week.read();
    this.#storage.week.write(week);
    if (previous?.isoWeek !== week.isoWeek) {
      // Games from other weeks can't be finished any more; their results (if any) are already queued.
      this.#storage.games.update((games) => games && Object.fromEntries(Object.entries(games).filter(([k]) => inWeek(week, k.split("/")[0]!))));
    }
  }

  #client(): SudokuApi {
    const url = this.settings().serverUrl;
    if (!url.trim()) throw new Error("no server configured");
    if (this.#api?.url !== url) this.#api = { url, api: new SudokuApi(url, this.tokens, this.#fetch) };
    return this.#api.api;
  }

  #oidcClient(oidc: OidcConfig): OidcClient {
    const key = JSON.stringify(oidc);
    if (this.#oidc?.key !== key) {
      this.#oidc = { key, client: new OidcClient(oidc.issuer, oidc.clientId, oidc.scopes, this.#redirectUri, this.#fetch) };
    }
    return this.#oidc.client;
  }
}
