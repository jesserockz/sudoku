import { ApiException } from "../api/client.ts";
import type { AppConfig, EndlessBoard, EndlessProgress, EndlessResult, Leaderboard, Me, MyStats, PendingGenerator, Streak, Week } from "../api/models.ts";
import { type HomeTab, endlessGameKey, parseEndlessGameKey } from "../data/app-storage.ts";
import type { EndlessInProgress, EndlessSource } from "../data/endless.ts";
import { OidcException } from "../api/oidc.ts";
import { SignInError, type SudokuRepository } from "../data/repository.ts";
import { addDays } from "../game/calendar.ts";
import { Game } from "../game/game.ts";
import type { ReplayInput } from "../game/replay.ts";
import { DIFFICULTIES, type EndlessPuzzle, isEndlessNumber, type Puzzle } from "../generator/generator.ts";
import { GENERATOR_CLASSIC, isGeneratorVersion } from "../generator/versions.ts";
import { fingerprint, sameSettings, type SeedSettings } from "../serverless/seed.ts";
import type { SeedProfile, SeedRepository, SeedResult } from "../serverless/seed-repository.ts";
import { buildShareLink, parseShareLink } from "../serverless/share-link.ts";
import { AdminModel } from "./admin.ts";
import { AdminResultsModel, type ResultKey } from "./admin-results.ts";
import { streakSummary } from "./stats.ts";

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

/** The home page tab for endless puzzles. One constant, so it's easy to rename. */
export const ENDLESS_LABEL = "Endless";

/** Which "how it works" explainer is open over the screen. */
export type HelpTopic = HomeTab;

/**
 * An endless puzzle: `number` (from 1) of difficulty tier `difficulty` (1 = Easy .. 5 = Diabolical) in the series
 * of generator version `generator` (each version numbers its own puzzles).
 */
export interface EndlessRef {
  generator: number;
  difficulty: number;
  number: number;
}

/** A puzzle being played: today's game `level`, or an endless puzzle. */
export type PuzzleRef = number | EndlessRef;

/** One difficulty on the endless tab, in the current series. `next` is the lowest number not solved yet. */
export interface EndlessSummary {
  difficulty: number;
  solved: number;
  highest: number;
  next: number;
  /** Games started on this device and not solved, lowest number first. */
  inProgress: { number: number; elapsedMs: number }[];
}

export type Screen =
  | { kind: "today" }
  | { kind: "play"; level: number }
  | { kind: "endless-play"; generator: number; difficulty: number; number: number }
  /** The endless leaderboard of `generator`'s series: everyone's progress in `difficulty`, or with `number` that puzzle's times. */
  | { kind: "endless-scores"; generator: number; difficulty: number; number: number | null }
  | { kind: "scores"; date: string; tab: number }
  /** The signed-in player's streak and personal stats. */
  | { kind: "stats" }
  /** Serverless play's local history of solve times. */
  | { kind: "history" }
  | { kind: "about" }
  /** Server admin: update the server binary. Only for `me.admin`. */
  | { kind: "admin" }
  /** Server admin: a day's results with their replay checks and flags. */
  | { kind: "admin-results" }
  /** Server admin: watching one result's replay. */
  | { kind: "replay" };

/** The server's side of the About screen. */
export type ServerInfo =
  /** Playing with a seed: no server involved. */
  | { kind: "none" }
  | { kind: "loading" }
  /** `version` is `null` when the server didn't report one (an older server). */
  | { kind: "ok"; version: string | null }
  /** Signed in, but the server couldn't be reached (e.g. offline). */
  | { kind: "unreachable" };

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
  /** The wall clock in epoch milliseconds, for replays. */
  wallMs: () => number;
  /** Reloads the page, to pick up a new version of the app. */
  reloadPage: () => void;
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
  /** The current week (the server's, or the seed's), or `null` when the cached one doesn't cover today. */
  week: Week | null = null;
  /** Today's games started on this device, by level. */
  readonly games = new Map<number, Game>();
  syncing = false;
  /** Signed in with OIDC but the session has expired or been revoked: offer "Sign in again". */
  needsSignIn = false;
  leaderboard: Leaderboard | null = null;
  leaderboardError: string | null = null;
  /** The daily streak last fetched (kept in storage, so known offline), or `null` when unknown or in serverless play. */
  streak: Streak | null = null;
  /** The Stats screen's data, and why it couldn't load. */
  stats: MyStats | null = null;
  statsError: string | null = null;
  /** The generator the player picked on the Stats screen, or `null` for the one in use now. */
  statsGenerator: number | null = null;
  /** The home page tab; remembered on this device. */
  homeTab: HomeTab;
  /** The endless leaderboard screen's data (whichever of the two it shows). */
  endlessProgress: EndlessProgress | null = null;
  endlessBoard: EndlessBoard | null = null;
  /** The "how it works" explainer showing over the screen, or `null`. */
  help: HelpTopic | null = null;
  /** A transient problem worth showing (e.g. offline, results not uploaded yet). */
  notice: string | null = null;
  /** What the About screen shows for the server; fetched when it's opened. */
  serverInfo: ServerInfo = { kind: "none" };
  /** The Admin screen's state, while it is open. */
  admin: AdminModel | null = null;
  /** The admin results and replay screens' state, kept while either is open. */
  adminResults: AdminResultsModel | null = null;
  /** A newer version of the app has been installed; reloading the page switches to it. */
  updateAvailable = false;

  readonly #repo: SudokuRepository;
  readonly #seeds: SeedRepository;
  readonly #host: Host;
  readonly #serverDone = new Map<number, number>();
  readonly #queued = new Map<number, number>();
  /** The endless game being played (or last played), so the play screen and its updates share one `Game`. */
  #endless: { ref: EndlessRef; puzzle: EndlessPuzzle; game: Game } | null = null;
  /** The last sync couldn't reach the server: retried periodically, as `online` events aren't reliable. */
  #offline = false;
  #leaderboardRequest = 0;
  #statsRequest = 0;

  constructor(repo: SudokuRepository, seeds: SeedRepository, host: Host) {
    super();
    this.#repo = repo;
    this.#seeds = seeds;
    this.#host = host;
    this.today = repo.today();
    this.homeTab = repo.homeTab();
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

  #set(changes: Partial<Pick<AppController, "phase" | "screen" | "notice" | "me" | "seed" | "puzzles" | "needsSignIn" | "serverInfo" | "help">>): void {
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
      this.#showReady(false);
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

  /** `loadStats` is false when a sync follows anyway, which fetches them. */
  #showReady(loadStats = true): void {
    this.seed = null;
    this.#loadLocal();
    this.#set({ needsSignIn: this.#repo.needsSignIn, phase: { kind: "ready" } });
    this.#firstEndlessVisit();
    // Signing in has just synced everything but the stats.
    if (loadStats) void this.#refreshStats().then(() => this.#changed());
  }

  /** Reloads the day from local state (no network). */
  #loadLocal(): void {
    if (this.seed) {
      void this.#loadSeedDay().then(() => this.#changed());
      return;
    }
    this.me = this.#repo.me();
    this.streak = this.#repo.streak();
    this.today = this.#repo.today();
    this.puzzles = this.#repo.puzzles(this.today);
    this.week = this.#repo.weekFor(this.today);
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

  /**
   * Syncs with the server in the background; offline is fine and just noted.
   * Not while the page is hidden: the visibility handler syncs when it is shown again, and a token refresh
   * cut off by the OS suspending the page can lose the rotated refresh token and sign the player out.
   */
  sync(): void {
    if (this.syncing || this.phase.kind !== "ready" || this.seed || !this.#repo.isSignedIn || !this.#host.isVisible()) return;
    this.syncing = true;
    this.#changed();
    void (async () => {
      try {
        const report = await this.#repo.refresh();
        this.#offline = false;
        await this.#refreshStats();
        this.notice = report.failure != null
          ? "Some results haven't uploaded yet. They'll retry automatically."
          : report.rejected.length > 0 ? `The server rejected ${report.rejected.length} result(s).` : null;
      } catch (e) {
        if (e instanceof ApiException) {
          // An ended session has its own "Sign in again" banner; that is the one message.
          this.notice = e.isUnauthorized ? (this.#repo.needsSignIn ? null : "The server didn't accept your sign-in.") : describe(e);
        } else if (e instanceof OidcException) {
          // The sign-in server failed (5xx, 429...): the session is kept, so retry like offline.
          this.#offline = true;
          this.notice = "Can't reach the sign-in server. Puzzles still work; results upload once it's back.";
        } else {
          this.#offline = true;
          this.notice = "Offline. Puzzles still work; results upload when you're back online.";
        }
      } finally {
        this.syncing = false;
        this.needsSignIn = this.#repo.needsSignIn;
        // Keep an open game as it is; otherwise pick up the new week, results and day.
        if (this.screen.kind !== "play" && this.screen.kind !== "endless-play") this.#loadLocal();
        else this.#refreshQueued();
        // A leaderboard that failed (e.g. offline) tries again.
        if (this.screen.kind === "scores" && this.leaderboardError !== null) this.#loadLeaderboard(this.screen.date);
        if (this.screen.kind === "stats" && this.statsError !== null) this.openStats();
        if (this.screen.kind === "endless-scores" && this.leaderboardError !== null) this.openEndlessScores(this.screen.difficulty, this.screen.number, this.screen.generator);
        this.#changed();
      }
    })();
  }

  /** Keeps the streak (and the Stats screen's data) fresh after a sync. Stats are a nicety: a failure here is not a sync failure. */
  async #refreshStats(): Promise<void> {
    try {
      this.#setStats(await this.#repo.fetchStats(this.statsGenerator ?? undefined));
    } catch {
      // Offline or an old server without stats: the stored streak stays as it was.
    }
  }

  #setStats(stats: MyStats): void {
    this.stats = stats;
    this.streak = stats.streak;
    this.statsError = null;
  }

  /** The puzzle generator this week's dailies use. */
  get generator(): number {
    return this.week?.generator ?? GENERATOR_CLASSIC;
  }

  /** A generator change that starts next week, or `null`. */
  get pendingGenerator(): PendingGenerator | null {
    return this.week?.pendingGenerator ?? null;
  }

  /** The home page's streak line, or `null` when there is nothing to show (serverless play, or no streak known yet). */
  streakText(): string | null {
    return this.seed ? null : streakSummary(this.streak, this.today);
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
    void fingerprint(incoming.seed).then(
      (incomingFingerprint) => this.#set({ phase: { kind: "confirm-seed", incoming, incomingFingerprint, current } }),
      (e) => this.#seedFailed(e),
    );
  }

  /** The URL's fragment changed while the app is open, e.g. a share link pasted into this tab. */
  onHashChange(): void {
    const link = this.#takeShareLink();
    if (link) this.#offerSeed(link);
  }

  /** Starts playing with `settings` (from the setup screen, or accepting a share link). */
  useSeed(settings: SeedSettings): void {
    this.#set({ phase: { kind: "loading" } });
    void this.#seeds.use(settings).then((profile) => this.#startSeed(profile), (e) => this.#seedFailed(e));
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
    this.#endless = null;
    Object.assign(this, { seed: null, puzzles: null, week: null, notice: null, screen: { kind: "today" } });
    this.start();
  }

  async #startSeed(profile: SeedProfile): Promise<void> {
    this.#endless = null;
    this.#set({ seed: profile, phase: { kind: "loading" } });
    try {
      await this.#loadSeedDay();
      this.#set({ phase: { kind: "ready" } });
      this.#firstEndlessVisit();
    } catch (e) {
      // E.g. a stored timezone this browser doesn't know: let the player pick again.
      this.#seeds.leave();
      this.#seedFailed(e);
    }
  }

  /** Back to seed setup with the reason, rather than leaving the loading screen up. */
  #seedFailed(e: unknown): void {
    this.#set({ seed: null, phase: { kind: "seed-setup", server: null }, notice: `Couldn't start that seed: ${(e as Error).message}` });
  }

  async #loadSeedDay(): Promise<void> {
    const day = this.#seeds.today();
    const list = await this.#seeds.puzzles(day);
    const week = await this.#seeds.week();
    await this.#seeds.loadEndless();
    this.today = day;
    this.puzzles = list;
    this.week = week;
    this.me = null;
    this.streak = null;
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

  /**
   * Serverless play: chooses the puzzle generator for this seed from next week on (the current week never changes).
   * Choosing the one this week uses cancels a change that is pending.
   */
  async setSeedGenerator(version: number): Promise<void> {
    if (!this.seed) return;
    this.#seeds.setGenerator(version);
    this.week = await this.#seeds.week();
    this.#changed();
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

  /** The About screen. The server's version comes from `GET /config`, fetched once per visit while signed in. */
  openAbout(): void {
    const connected = !this.seed;
    this.#set({ screen: { kind: "about" }, serverInfo: connected ? { kind: "loading" } : { kind: "none" } });
    if (!connected) return;
    this.#repo.fetchConfig(this.#repo.settings().serverUrl).then(
      (config): ServerInfo => ({ kind: "ok", version: config.version ?? null }),
      (): ServerInfo => ({ kind: "unreachable" }),
    ).then((serverInfo) => {
      if (this.screen.kind === "about") this.#set({ serverInfo });
    });
  }

  /** The Admin screen, for an admin signed in to a server. It loads the releases and follows any update under way. */
  openAdmin(): void {
    if (this.seed || !this.me?.admin) return;
    const model = new AdminModel(this.#repo.api(), {
      serverVersion: async () => (await this.#repo.fetchConfig(this.#repo.settings().serverUrl)).version ?? null,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => this.#host.nowMs(),
    });
    this.admin = model;
    this.#set({ screen: { kind: "admin" } });
    void model.load();
  }

  /** The admin results screen for today (or back to it from a replay, keeping its date). */
  openAdminResults(): void {
    if (this.seed || !this.me?.admin) return;
    if (this.screen.kind === "replay" && this.adminResults) {
      this.adminResults.close();
    } else {
      this.adminResults = new AdminResultsModel(this.#repo.api(), this.today);
      void this.adminResults.load();
    }
    this.#set({ screen: { kind: "admin-results" } });
  }

  /** Opens a result's replay, from the admin results screen. */
  openReplay(key: ResultKey): void {
    if (!this.adminResults) return;
    void this.adminResults.open(key);
    this.#set({ screen: { kind: "replay" } });
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
    Object.assign(this, { puzzles: null, week: null, me: null, streak: null, stats: null, statsGenerator: null, notice: null, needsSignIn: false, screen: { kind: "today" } });
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

  /** Switches the home page between today's puzzles and the endless ones. */
  showHomeTab(tab: HomeTab): void {
    this.#repo.setHomeTab(tab);
    this.homeTab = tab;
    this.#changed();
    this.#firstEndlessVisit();
  }

  /** Opens the explainer for `topic` (from the About screen, or the first endless visit). */
  openHelp(topic: HelpTopic): void {
    if (topic === "endless" && !this.hasEndless) return;
    this.#set({ help: topic });
  }

  closeHelp(): void {
    this.#set({ help: null });
  }

  /** The endless explainer pops up once per device, the first time the endless tab is shown. */
  #firstEndlessVisit(): void {
    if (!this.hasEndless || this.homeTab !== "endless" || this.screen.kind !== "today" || this.#repo.endlessHelpSeen()) return;
    this.#repo.markEndlessHelpSeen();
    this.openHelp("endless");
  }

  /** Whether the endless tab is offered: with a server or a seed, so always. */
  get hasEndless(): boolean {
    return true;
  }

  /** Where endless puzzles, games and results live: the seed's repository in serverless play. */
  get #endlessSource(): EndlessSource {
    return this.seed ? this.#seeds : this.#repo;
  }

  /** Serverless play's endless solve times, by series, difficulty then number. */
  endlessHistory(): EndlessResult[] {
    return this.#seeds.endlessHistory();
  }

  /**
   * The series the Endless tab plays: the generator the current week uses. It follows the week, so when the
   * generator changes the tab switches series by itself, and switching back resumes the earlier series.
   */
  get endlessGenerator(): number {
    return this.week?.generator ?? GENERATOR_CLASSIC;
  }

  /** The endless tab for the current series, per difficulty, or `null` until the endless seed has been downloaded once. */
  endlessSummaries(): EndlessSummary[] | null {
    if (!this.#endlessSource.endlessReady()) return null;
    const generator = this.endlessGenerator;
    const solved = this.#endlessSource.endlessSolved();
    const inProgress = this.#endlessSource.endlessInProgress();
    return DIFFICULTIES.map((_, i) => {
      const difficulty = i + 1;
      const numbers = [...solved.keys()].map(parseEndlessGameKey).filter((k) => k.generator === generator && k.difficulty === difficulty).map((k) => k.number);
      let next = 1;
      while (solved.has(endlessGameKey(generator, difficulty, next))) next++;
      return {
        difficulty, solved: numbers.length, highest: Math.max(0, ...numbers), next,
        inProgress: inProgress.filter((g) => g.generator === generator && g.difficulty === difficulty).map((g) => ({ number: g.number, elapsedMs: g.elapsedMs })),
      };
    });
  }

  /** Unfinished games of the series the tab isn't playing now (e.g. Classic after the week moved to Graded), which can still be resumed. */
  endlessElsewhere(): EndlessInProgress[] {
    return this.#endlessSource.endlessInProgress().filter((g) => g.generator !== this.endlessGenerator);
  }

  /** An endless puzzle's state, as {@link statusOf} for today's. */
  endlessStatusOf(ref: EndlessRef): PuzzleStatus {
    const open = this.#endless && sameEndless(this.#endless.ref, ref) ? this.#endless.game : null;
    const game = open ?? this.#loadEndless(ref)?.game ?? null;
    const solved = this.#endlessSource.endlessSolved().get(endlessGameKey(ref.generator, ref.difficulty, ref.number));
    if (solved) return { kind: "done", elapsedMs: solved.elapsedMs, synced: solved.synced };
    if (!game) return { kind: "new" };
    if (game.completedElapsedMs !== null) return { kind: "done", elapsedMs: game.completedElapsedMs, synced: false };
    return { kind: "in-progress", elapsedMs: game.elapsedMs(this.nowMs()) };
  }

  /** Plays an endless puzzle, resuming it if it was started here. One solved elsewhere opens its leaderboard. */
  openEndless(ref: EndlessRef): void {
    if (!this.hasEndless || !isGeneratorVersion(ref.generator) || !DIFFICULTIES[ref.difficulty - 1] || !isEndlessNumber(ref.number)) return;
    const loaded = this.#endless && sameEndless(this.#endless.ref, ref) ? this.#endless : this.#loadEndless(ref);
    if (!loaded) return;
    if (this.endlessStatusOf(ref).kind === "done" && !loaded.game.isComplete) {
      this.openEndlessScores(ref.difficulty, ref.number, ref.generator);
      return;
    }
    this.#endless = loaded;
    this.#set({ screen: { kind: "endless-play", generator: ref.generator, difficulty: ref.difficulty, number: ref.number } });
  }

  /** The endless puzzle and its game (a new one if it wasn't started here), or `null` without the endless seed. */
  #loadEndless(ref: EndlessRef): { ref: EndlessRef; puzzle: EndlessPuzzle; game: Game } | null {
    const puzzle = this.#endlessSource.endlessPuzzle(ref.generator, ref.difficulty, ref.number);
    if (!puzzle) return null;
    const game = this.#endlessSource.loadEndlessGame(ref.generator, puzzle) ?? this.#stamp(Game.create(puzzle.givens), { a: "start" });
    return { ref: { generator: ref.generator, difficulty: ref.difficulty, number: ref.number }, puzzle, game };
  }

  /**
   * The endless leaderboard of `generator`'s series (the current one when omitted): progress in `difficulty`, or one
   * puzzle's times with `number`. In serverless play, the history.
   */
  openEndlessScores(difficulty: number, number: number | null = null, generator: number = this.endlessGenerator): void {
    // No leaderboard without a server: serverless play's history lists endless solves too.
    if (this.seed) {
      this.openHistory();
      return;
    }
    this.screen = { kind: "endless-scores", generator, difficulty, number };
    const request = ++this.#leaderboardRequest;
    this.endlessProgress = null;
    this.endlessBoard = null;
    this.leaderboardError = null;
    this.#changed();
    const load: Promise<unknown> = number === null ? this.#repo.endlessProgress(generator) : this.#repo.endlessBoard(generator, difficulty, number);
    load.then(
      (data) => {
        if (request !== this.#leaderboardRequest) return;
        if (number === null) this.endlessProgress = data as EndlessProgress;
        else this.endlessBoard = data as EndlessBoard;
      },
      (e) => {
        if (request !== this.#leaderboardRequest) return;
        this.leaderboardError = e instanceof ApiException ? describe(e) : "You're offline. The leaderboard needs a connection to the server.";
      },
    ).finally(() => this.#changed());
  }

  /** The game for `ref`, if it's open (today's games, or the endless puzzle on screen). */
  gameOf(ref: PuzzleRef): Game | null {
    if (typeof ref === "number") return this.games.get(ref) ?? null;
    return this.#endless && sameEndless(this.#endless.ref, ref) ? this.#endless.game : null;
  }

  /** The puzzle for `ref`. */
  puzzleOf(ref: PuzzleRef): Puzzle | EndlessPuzzle | null {
    if (typeof ref === "number") return this.puzzle(ref);
    return this.#endless && sameEndless(this.#endless.ref, ref) ? this.#endless.puzzle : null;
  }

  /** "See scores" after solving `ref`. */
  openScoresFor(ref: PuzzleRef): void {
    if (typeof ref === "number") this.openScores(ref);
    else this.openEndlessScores(ref.difficulty, ref.number, ref.generator);
  }

  openPuzzle(level: number): void {
    // Finished on another device (or this one before storage was cleared): nothing to play.
    if (this.statusOf(level).kind === "done" && !this.games.get(level)?.isComplete) {
      this.openScores(level);
      return;
    }
    const p = this.puzzle(level);
    if (!p) return;
    if (!this.games.has(level)) this.games.set(level, this.#stamp(Game.create(p.givens), { a: "start" }));
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

  /** The Stats screen. It needs the server, like the leaderboard. */
  openStats(): void {
    if (this.seed) return;
    this.screen = { kind: "stats" };
    this.#loadStats(null);
  }

  /** Shows the Stats screen's daily numbers for generator `version`. The streak is the same for every generator. */
  showStatsGenerator(version: number): void {
    if (this.screen.kind !== "stats") return;
    this.#loadStats(version);
  }

  #loadStats(generator: number | null): void {
    this.statsGenerator = generator;
    const request = ++this.#statsRequest;
    this.stats = null;
    this.statsError = null;
    this.#changed();
    this.#repo.fetchStats(generator ?? undefined).then(
      (stats) => {
        if (request === this.#statsRequest) this.#setStats(stats);
      },
      (e) => {
        if (request !== this.#statsRequest) return;
        this.statsError = e instanceof ApiException ? describe(e) : "You're offline. Your stats need a connection to the server.";
      },
    ).finally(() => this.#changed());
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

  /**
   * Applies `change` to the game for `level`, records `action` in its replay
   * if the change did something (for `pause` and `resume`: if the timer
   * stopped or started), persists it, and handles completion.
   */
  update(ref: PuzzleRef, change: (game: Game) => Game, action?: ReplayInput): void {
    const before = this.gameOf(ref);
    if (!before) return;
    let after = change(before);
    if (after === before) return;
    const finished = after.isComplete && !before.isComplete;
    const timerOnly = action?.a === "pause" || action?.a === "resume";
    if (action && !before.isComplete && (!timerOnly || after.timer.isRunning !== before.timer.isRunning)) after = this.#stamp(after, action);
    if (finished) after = this.#stamp(after, { a: "finish" });
    if (typeof ref !== "number") {
      this.#endless!.game = after;
      this.#endlessSource.saveEndlessGame(ref.generator, ref.difficulty, ref.number, after, this.nowMs());
      if (finished) void this.#endlessSource.completeEndless(ref.generator, ref.difficulty, ref.number, after).then(() => this.sync());
      this.#changed();
      return;
    }
    const level = ref;
    this.games.set(level, after);
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

  /** Records an action that changes nothing on the board (notes mode, the app hidden or shown). Not after the game is solved. */
  log(ref: PuzzleRef, action: ReplayInput): void {
    if (this.gameOf(ref)?.isComplete === false) this.update(ref, (g) => this.#stamp(g, action));
  }

  #stamp(game: Game, action: ReplayInput): Game {
    // A resume reads the clock again after the timer started, so it would land a hair past the pause before it; the timer
    // reads exactly what it banked at the moment it resumed.
    const elapsed = action.a === "resume" ? game.timer.accumulatedMs : game.elapsedMs(this.nowMs());
    return game.record({ t: Math.round(elapsed), w: this.#host.wallMs(), ...action });
  }

  // Lifecycle

  /** Starts over, e.g. "Try again" after a failure. */
  reload(): void {
    this.screen = { kind: "today" };
    this.start();
  }

  /** A newer version of the app has taken over: shows the "Reload" banner. */
  updateReady(): void {
    if (this.updateAvailable) return;
    this.updateAvailable = true;
    this.#changed();
  }

  /** Reloads the page onto the new version. */
  applyUpdate(): void {
    this.#host.reloadPage();
  }

  /** Every 30 s: catches the day rolling over, and retries a sync that failed while the page is visible. */
  tick(): void {
    if (this.phase.kind !== "ready") return;
    // Don't pull the board out from under someone mid-puzzle; openToday() catches up.
    if (this.screen.kind !== "play" && this.screen.kind !== "endless-play" && this.#currentDay() !== this.today) {
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

const sameEndless = (a: EndlessRef, b: EndlessRef) => a.generator === b.generator && a.difficulty === b.difficulty && a.number === b.number;

function describe(e: unknown): string {
  if (e instanceof SignInError) return e.message || "Sign-in failed.";
  if (e instanceof ApiException) return e.error?.message.trim() || (e.isUnauthorized ? "Your sign-in has expired." : `Server error (HTTP ${e.status})`);
  return "Can't reach the server. Check your connection and try again.";
}
