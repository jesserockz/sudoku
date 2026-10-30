import { ApiException } from "../api/client.ts";
import type { AppConfig, Leaderboard, Me } from "../api/models.ts";
import { SignInError, type SudokuRepository } from "../data/repository.ts";
import { addDays } from "../game/calendar.ts";
import { Game } from "../game/game.ts";
import type { Puzzle } from "../generator/generator.ts";
import { fingerprint, sameSettings, type SeedSettings } from "../serverless/seed.ts";
import type { SeedProfile, SeedRepository, SeedResult } from "../serverless/seed-repository.ts";
import { buildShareLink, parseShareLink } from "../serverless/share-link.ts";

/** Register `<origin>/auth/callback` as the redirect URI with the identity provider. */
export const CALLBACK_PATH = "/auth/callback";

export type Phase =
  | { kind: "loading" }
  /** Couldn't sign in, or reach the server while signed out. */
  | { kind: "failed"; message: string }
  | { kind: "sign-in"; config: AppConfig }
  /**
   * Enter or generate a seed. `server` is the server's config when there is one
   * (the player chose "Play with a seed" over signing in), or `null` when
   * there's no Sudoku server here (e.g. static hosting).
   */
  | { kind: "seed-setup"; server: AppConfig | null }
  /** A share link for `incoming` was opened while playing with a different seed (or signed in). */
  | { kind: "confirm-seed"; incoming: SeedSettings; incomingFingerprint: string; current: SeedProfile | null }
  | { kind: "ready" };

export type Screen =
  | { kind: "today" }
  | { kind: "play"; level: number }
  | { kind: "scores"; date: string; tab: number }
  /** Serverless play's local history of solve times. */
  | { kind: "history" };

/** A puzzle's state on the "today" list. `synced` is false while a result waits in the offline queue. */
export type PuzzleStatus =
  | { kind: "new" }
  | { kind: "in-progress"; elapsedMs: number }
  | { kind: "done"; elapsedMs: number; synced: boolean };

/** What a page needs from the browser; tests and other hosts can supply their own. */
export interface Host {
  /** This page's URL. */
  location: Location;
  history: History;
  /** Where this copy of the app lives, e.g. `https://example.github.io/sudoku/`. */
  baseUri: () => string;
  isVisible: () => boolean;
  /** A monotonic clock in milliseconds, for game timers. */
  nowMs: () => number;
}

/**
 * All app state and logic. Screens read the state here and call its methods;
 * nothing else talks to the repositories. Every change fires a `change` event.
 *
 * Offline-first: once signed in, the app starts from the cached week in
 * `localStorage` with no network, and syncs in the background (at start, when
 * the browser comes back online and when the page becomes visible). Only
 * signing in and the leaderboard need the server.
 *
 * Serverless mode (`seed` set) plays from a shared seed instead: no server,
 * sign-in or leaderboard; puzzles, games and a history of times are all local.
 * It's chosen when there's no Sudoku server here, when a share link
 * (`#seed=...`) is opened, or with "Play with a seed".
 */
export class AppController extends EventTarget {
  phase: Phase = { kind: "loading" };
  screen: Screen = { kind: "today" };
  me: Me | null = null;
  /** The seed being played in serverless mode, or `null` when playing with a server. */
  seed: SeedProfile | null = null;
  /** The day being shown; follows the device clock in the game's timezone. */
  today: string;
  /** The day's games, or `null` when the cached week doesn't cover today (connect once this week). */
  puzzles: Puzzle[] | null = null;
  /** Today's games started on this device, by level. */
  readonly games = new Map<number, Game>();
  syncing = false;
  /** Signed in with OIDC but the session has expired or been revoked: offer "Sign in again". */
  needsSignIn = false;
  leaderboard: Leaderboard | null = null;
  leaderboardError: string | null = null;
  /** A transient problem worth showing (e.g. offline, results not uploaded yet). */
  notice: string | null = null;

  readonly #repo: SudokuRepository;
  readonly #seeds: SeedRepository;
  readonly #host: Host;
  readonly #serverDone = new Map<number, number>();
  readonly #queued = new Map<number, number>();
  /** The last sync couldn't reach the server: retried periodically, as `online` events aren't reliable. */
  #offline = false;
  #leaderboardRequest = 0;

  constructor(repo: SudokuRepository, seeds: SeedRepository, host: Host) {
    super();
    this.#repo = repo;
    this.#seeds = seeds;
    this.#host = host;
    this.today = repo.today();
  }

  get origin(): string {
    return this.#host.location.origin;
  }

  nowMs(): number {
    return this.#host.nowMs();
  }

  #changed(): void {
    this.dispatchEvent(new Event("change"));
  }

  #set(changes: Partial<Pick<AppController, "phase" | "screen" | "notice" | "me" | "seed" | "puzzles" | "needsSignIn">>): void {
    Object.assign(this, changes);
    this.#changed();
  }

  start(): void {
    if (this.#host.location.pathname === CALLBACK_PATH) {
      void this.#finishOidcSignIn();
      return;
    }
    const link = this.#takeShareLink();
    if (link) {
      this.#offerSeed(link);
      return;
    }
    const profile = this.#seeds.profile();
    if (profile) {
      void this.#startSeed(profile);
      return;
    }
    this.seed = null;
    if (this.#repo.isSignedIn) {
      this.#showReady();
      this.sync();
      return;
    }
    this.#set({ phase: { kind: "loading" } });
    void (async () => {
      try {
        const config = await this.#repo.fetchConfig(this.origin);
        this.#set({ phase: { kind: "sign-in", config } });
      } catch {
        // Unreachable, or not a Sudoku server (e.g. a static host): play with a seed.
        this.#set({ phase: { kind: "seed-setup", server: null } });
      }
    })();
  }

  #showReady(): void {
    this.seed = null;
    this.#loadLocal();
    this.#set({ needsSignIn: this.#repo.needsSignIn, phase: { kind: "ready" } });
  }

  /** Reloads the day from local state (no network). */
  #loadLocal(): void {
    if (this.seed) {
      void this.#loadSeedDay().then(() => this.#changed());
      return;
    }
    this.me = this.#repo.me();
    this.today = this.#repo.today();
    this.puzzles = this.#repo.puzzles(this.today);
    this.games.clear();
    for (const p of this.puzzles ?? []) {
      const g = this.#repo.loadGame(this.today, p);
      if (g) this.games.set(p.level, g);
    }
    this.#serverDone.clear();
    for (const [level, r] of this.#repo.serverResults(this.today)) this.#serverDone.set(level, r.elapsedMs);
    this.#refreshQueued();
    this.#changed();
  }

  #refreshQueued(): void {
    this.#queued.clear();
    for (const r of this.#repo.pending()) if (r.date === this.today) this.#queued.set(r.level, r.elapsedMs);
  }

  /** Syncs with the server in the background; offline is fine and just noted. */
  sync(): void {
    if (this.syncing || this.phase.kind !== "ready" || this.seed || !this.#repo.isSignedIn) return;
    this.syncing = true;
    this.#changed();
    void (async () => {
      try {
        const report = await this.#repo.refresh();
        this.#offline = false;
        this.notice = report.failure != null
          ? "Some results haven't uploaded yet. They'll retry automatically."
          : report.rejected.length > 0 ? `The server rejected ${report.rejected.length} result(s).` : null;
      } catch (e) {
        if (e instanceof ApiException) {
          this.notice = e.isUnauthorized ? "The server didn't accept your sign-in." : describe(e);
        } else {
          this.#offline = true;
          this.notice = "Offline. Puzzles still work; results upload when you're back online.";
        }
      } finally {
        this.syncing = false;
        this.needsSignIn = this.#repo.needsSignIn;
        // Keep an open game as it is; otherwise pick up the new week, results and day.
        if (this.screen.kind !== "play") this.#loadLocal();
        else this.#refreshQueued();
        // A leaderboard that failed (e.g. offline) tries again.
        if (this.screen.kind === "scores" && this.leaderboardError !== null) this.#loadLeaderboard(this.screen.date);
        this.#changed();
      }
    })();
  }

  statusOf(level: number): PuzzleStatus {
    const server = this.#serverDone.get(level);
    if (server !== undefined) return { kind: "done", elapsedMs: server, synced: true };
    const queued = this.#queued.get(level);
    if (queued !== undefined) return { kind: "done", elapsedMs: queued, synced: false };
    const game = this.games.get(level);
    if (!game) return { kind: "new" };
    if (game.completedElapsedMs !== null) return { kind: "done", elapsedMs: game.completedElapsedMs, synced: false };
    return { kind: "in-progress", elapsedMs: game.elapsedMs(this.nowMs()) };
  }

  puzzle(level: number): Puzzle | null {
    return this.puzzles?.find((p) => p.level === level) ?? null;
  }

  // Serverless play

  /** The settings in the URL's `#seed=...` fragment, if any; the fragment is removed either way. */
  #takeShareLink(): SeedSettings | null {
    const hash = this.#host.location.hash;
    if (hash.length <= 1) return null;
    // Keep the seed out of the address bar, history and anything copied from it.
    this.#host.history.replaceState(null, "", this.#host.location.pathname + this.#host.location.search);
    const settings = parseShareLink(hash);
    if (!settings) this.notice = "That link doesn't contain a valid seed.";
    return settings;
  }

  /** A share link was opened: adopt it, after asking if it would replace another seed or a sign-in. */
  #offerSeed(incoming: SeedSettings): void {
    const current = this.#seeds.profile();
    if ((current && sameSettings(current.settings, incoming)) || (!current && !this.#repo.isSignedIn)) {
      this.useSeed(incoming);
      return;
    }
    this.#set({ phase: { kind: "loading" } });
    void fingerprint(incoming.seed).then((incomingFingerprint) =>
      this.#set({ phase: { kind: "confirm-seed", incoming, incomingFingerprint, current } }));
  }

  /** The URL's fragment changed while the app is open, e.g. a share link pasted into this tab. */
  onHashChange(): void {
    const link = this.#takeShareLink();
    if (link) this.#offerSeed(link);
  }

  /** Starts playing with `settings` (from the setup screen, or accepting a share link). */
  useSeed(settings: SeedSettings): void {
    this.#set({ phase: { kind: "loading" } });
    void this.#seeds.use(settings).then((profile) => this.#startSeed(profile));
  }

  /** "Play with a seed" from the sign-in screen. */
  chooseSeed(): void {
    this.#set({ phase: { kind: "seed-setup", server: this.phase.kind === "sign-in" ? this.phase.config : null } });
  }

  /** Back from seed setup or a declined share link to whatever was there before. */
  cancelSeed(): void {
    this.screen = { kind: "today" };
    if (this.phase.kind === "seed-setup" && this.phase.server) this.#set({ phase: { kind: "sign-in", config: this.phase.server } });
    else this.start();
  }

  /** Stops playing with the seed. Its games and history are kept for if it's entered again. */
  leaveSeed(): void {
    this.#seeds.leave();
    this.games.clear();
    Object.assign(this, { seed: null, puzzles: null, notice: null, screen: { kind: "today" } });
    this.start();
  }

  async #startSeed(profile: SeedProfile): Promise<void> {
    this.#set({ seed: profile, phase: { kind: "loading" } });
    try {
      await this.#loadSeedDay();
      this.#set({ phase: { kind: "ready" } });
    } catch (e) {
      // E.g. a stored timezone this browser doesn't know: let the player pick again.
      this.#seeds.leave();
      this.#set({ seed: null, phase: { kind: "seed-setup", server: null }, notice: `Couldn't start that seed: ${(e as Error).message}` });
    }
  }

  async #loadSeedDay(): Promise<void> {
    const day = this.#seeds.today();
    const list = await this.#seeds.puzzles(day);
    this.today = day;
    this.puzzles = list;
    this.me = null;
    this.needsSignIn = false;
    this.games.clear();
    for (const p of list) {
      const g = this.#seeds.loadGame(day, p);
      if (g) this.games.set(p.level, g);
    }
    this.#queued.clear();
    this.#serverDone.clear();
    for (const [level, r] of this.#seeds.results(day)) this.#serverDone.set(level, r.elapsedMs);
  }

  /** The link that gives others this seed and settings: this page's address with them in the fragment. */
  shareLink(): string | null {
    return this.seed ? buildShareLink(this.#host.baseUri().split(/[#?]/)[0]!, this.seed.settings) : null;
  }

  /** The "Share results" text for today. */
  resultsSummary(): Promise<string> {
    return this.#seeds.summary(this.today);
  }

  /** Serverless play's history of solve times, newest day first. */
  history(): SeedResult[] {
    return this.#seeds.history();
  }

  openHistory(): void {
    if (this.seed) this.#set({ screen: { kind: "history" } });
  }

  // Sign-in

  /** Dev auth mode: signs in as `sub` / `name`. Throws `RangeError` for an invalid id or name. */
  async signInDev(sub: string, name: string): Promise<void> {
    await this.#repo.signInDev(this.origin, sub, name);
    this.#showReady();
  }

  /** Starts OIDC sign-in (or signs in again after the session expired): redirects to the provider. */
  signIn(): void {
    const oidc = (this.phase.kind === "sign-in" ? this.phase.config.oidc : null) ?? this.#repo.settings().oidc;
    if (!oidc) return;
    this.#repo.beginOidcSignIn(this.origin, oidc).then(
      (url) => this.#host.location.assign(url),
      () => {
        const message = "Couldn't reach the identity provider. Check your connection and try again.";
        if (this.phase.kind === "ready") this.#set({ notice: message });
        else this.#set({ phase: { kind: "failed", message } });
      },
    );
  }

  /** The provider redirected back to the callback path. */
  async #finishOidcSignIn(): Promise<void> {
    const redirect = this.#host.location.href;
    // Leave the callback URL whatever happens, so a reload doesn't replay it.
    this.#host.history.replaceState(null, "", "/");
    this.#set({ phase: { kind: "loading" } });
    try {
      await this.#repo.completeOidcSignIn(redirect);
      this.notice = null;
      this.#showReady();
    } catch (e) {
      if (this.#repo.isSignedIn) {
        // Signing in again failed, or the first sync did: the cached state still plays.
        this.#showReady();
        this.#set({ notice: e instanceof SignInError ? e.message : "Signed in, but couldn't sync yet." });
      } else {
        this.#set({ phase: { kind: "failed", message: describe(e) } });
      }
    }
  }

  /** Signs out here and, with OIDC, at the identity provider too (which navigates away). */
  async signOut(): Promise<void> {
    const endSession = await this.#repo.endSessionUrl(`${this.origin}/`);
    this.#repo.signOut();
    this.games.clear();
    Object.assign(this, { puzzles: null, me: null, notice: null, needsSignIn: false, screen: { kind: "today" } });
    if (endSession) this.#host.location.assign(endSession);
    else this.start();
  }

  // Navigation

  openToday(): void {
    this.screen = { kind: "today" };
    // The day may have rolled over while a puzzle was open.
    if (this.#currentDay() !== this.today) this.#loadLocal();
    this.#changed();
  }

  openPuzzle(level: number): void {
    // Finished on another device (or this one before storage was cleared): nothing to play.
    if (this.statusOf(level).kind === "done" && !this.games.get(level)?.isComplete) {
      this.openScores(level);
      return;
    }
    const p = this.puzzle(level);
    if (!p) return;
    if (!this.games.has(level)) this.games.set(level, Game.create(p.givens));
    this.#set({ screen: { kind: "play", level } });
  }

  openScores(tab = 0, date: string = this.today): void {
    // No leaderboard without a server: serverless play has its own history instead.
    if (this.seed) {
      this.openHistory();
      return;
    }
    this.screen = { kind: "scores", date, tab };
    this.#loadLeaderboard(date);
  }

  showScoresTab(tab: number): void {
    if (this.screen.kind === "scores") this.#set({ screen: { ...this.screen, tab } });
  }

  /** Moves the leaderboard by `days`, within the server's 8-day result window. */
  shiftScoresDate(days: number): void {
    if (this.screen.kind !== "scores") return;
    const next = addDays(this.screen.date, days);
    if (next > this.today || next < addDays(this.today, -8)) return;
    this.openScores(this.screen.tab, next);
  }

  #loadLeaderboard(date: string): void {
    const request = ++this.#leaderboardRequest;
    this.leaderboard = null;
    this.leaderboardError = null;
    this.#changed();
    this.#repo.leaderboard(date).then(
      (board) => {
        if (request === this.#leaderboardRequest) this.leaderboard = board;
      },
      (e) => {
        if (request !== this.#leaderboardRequest) return;
        this.leaderboardError = e instanceof ApiException ? describe(e) : "You're offline. The leaderboard needs a connection to the server.";
      },
    ).finally(() => this.#changed());
  }

  // Play

  /** Applies `change` to the game for `level`, persists it, and handles completion. */
  update(level: number, change: (game: Game) => Game): void {
    const before = this.games.get(level);
    if (!before) return;
    const after = change(before);
    if (after === before) return;
    this.games.set(level, after);
    const finished = after.isComplete && !before.isComplete;
    if (this.seed) {
      this.#seeds.saveGame(this.today, level, after, this.nowMs());
      if (finished) this.#serverDone.set(level, this.#seeds.complete(this.today, level, after).elapsedMs);
    } else {
      this.#repo.saveGame(this.today, level, after, this.nowMs());
      if (finished) {
        this.#queued.set(level, after.completedElapsedMs!);
        void this.#repo.complete(this.today, level, after).then(() => this.sync());
      }
    }
    this.#changed();
  }

  // Lifecycle

  /** Starts over, e.g. "Try again" after a failure. */
  reload(): void {
    this.screen = { kind: "today" };
    this.start();
  }

  /** Every 30 s: catches the day rolling over, and retries a sync that failed while the page is visible. */
  tick(): void {
    if (this.phase.kind !== "ready") return;
    // Don't pull the board out from under someone mid-puzzle; openToday() catches up.
    if (this.screen.kind !== "play" && this.#currentDay() !== this.today) {
      this.#loadLocal();
      this.sync();
    } else if (this.#offline && this.#host.isVisible()) {
      this.sync();
    }
  }

  #currentDay(): string {
    return this.seed ? this.#seeds.today() : this.#repo.today();
  }
}

function describe(e: unknown): string {
  if (e instanceof SignInError) return e.message || "Sign-in failed.";
  if (e instanceof ApiException) return e.error?.message.trim() || `Server error (HTTP ${e.status})`;
  return "Can't reach the server. Check your connection and try again.";
}
