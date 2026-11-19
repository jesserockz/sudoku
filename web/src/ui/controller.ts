import { ApiException, SIGN_IN_UNAVAILABLE } from "../api/client.ts";
import {
  type AppConfig, type EndlessBoard, type EndlessProgress, type EndlessResult, type Leaderboard, type MaintenanceSettings, type MaintenanceState, type Me,
  type MyStats, type Streak, type VariantBoard, type VariantDayResult, type Week, variantOf,
} from "../api/models.ts";
import { type HomeTab, endlessGameKey, parseEndlessGameKey } from "../data/app-storage.ts";
import type { EndlessInProgress, EndlessSource } from "../data/endless.ts";
import type { VariantDaySource } from "../data/variant-day.ts";
import { OidcException } from "../api/oidc.ts";
import { SignInError, type SudokuRepository } from "../data/repository.ts";
import { MemoryStore } from "../data/store.ts";
import { addDays, dayOfWeek } from "../game/calendar.ts";
import { Game } from "../game/game.ts";
import type { ReplayInput } from "../game/replay.ts";
import { VARIANT_DIAGONAL, VARIANT_STANDARD, isVariant } from "../core/layout.ts";
import { DIFFICULTIES, type EndlessPuzzle, isEndlessNumber, type Puzzle } from "../generator/generator.ts";
import { type DailyVariant, type VariantPuzzle, dailyVariantOf } from "../generator/variants.ts";
import { parseWeekSeed } from "../generator/week-seed.ts";
import { GENERATOR_CLASSIC, generatorName, isGeneratorVersion } from "../generator/versions.ts";
import { lessonById } from "../learn/lessons.ts";
import { LearnProgress } from "../learn/progress.ts";
import { fingerprint, sameSettings, type SeedSettings } from "../serverless/seed.ts";
import type { SeedProfile, SeedRepository, SeedResult } from "../serverless/seed-repository.ts";
import { buildShareLink, parseShareLink } from "../serverless/share-link.ts";
import { AdminModel } from "./admin.ts";
import { AdminResultsModel, type ResultKey } from "./admin-results.ts";
import { backAroundOf, maintenanceError } from "./maintenance.ts";
import { streakSummary } from "./stats.ts";
import { seriesName, variantDayTitle } from "./variants.ts";

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
/** The home page tab for the variants' endless puzzles (Diagonal, Jigsaw, Killer). */
export const VARIANTS_LABEL = "Variants";

/** Which "how it works" explainer is open over the screen. */
export type HelpTopic = Exclude<HomeTab, "learn"> | "generators";

/**
 * An endless puzzle: `number` (from 1) of difficulty tier `difficulty` (1 = Easy .. 5 = Diabolical) in the series
 * of generator version `generator` and `variant` (each numbers its own puzzles). `variant` is 0 (standard
 * Sudoku, the Endless tab's) when omitted; 1 Diagonal, 2 Jigsaw and 3 Killer are the Variants tab's.
 */
export interface EndlessRef {
  generator: number;
  variant?: number;
  difficulty: number;
  number: number;
}

/** Today's variant of the day: `variant` (1 Diagonal, 2 Jigsaw, 3 Killer) is the day's. */
export interface VariantDayRef {
  variantDay: true;
  variant: number;
}

export const isVariantDayRef = (ref: PuzzleRef): ref is VariantDayRef => typeof ref === "object" && "variantDay" in ref;

/**
 * A puzzle being played: today's game `level` (from the generator in use, {@link AppController.generator}), an endless
 * puzzle, or the variant of the day.
 */
export type PuzzleRef = number | EndlessRef | VariantDayRef;

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
  /** One lesson of the Learn tab. */
  | { kind: "learn"; lesson: string }
  | { kind: "play"; generator: number; level: number }
  | { kind: "endless-play"; generator: number; variant: number; difficulty: number; number: number }
  /** Today's variant of the day (`variant` is the day's). */
  | { kind: "variant-day-play"; date: string; variant: number }
  /**
   * The endless leaderboard of `generator`'s series of `variant`: everyone's progress in `difficulty`, or with `number`
   * that puzzle's times.
   */
  | { kind: "endless-scores"; generator: number; variant: number; difficulty: number; number: number | null }
  /** The daily leaderboard of `generator`'s puzzles on `date`: the total (`tab` 0) or one game. */
  | { kind: "scores"; date: string; tab: number; generator: number }
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
  /**
   * Resolves once the page has had a chance to show the latest change (e.g. after the next frame is painted).
   * Without it, after a zero-delay timer.
   */
  nextFrame?: () => Promise<void>;
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
  /** The generator the Stats screen shows, or `null` before it has been opened (the server's default then). */
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
  /**
   * The server is in maintenance mode, or `null`. For a player it is learnt from a sync (or a leaderboard) that got
   * 503 `maintenance`, and cleared by the next sync that succeeds. An admin is served as usual, so theirs comes from the
   * server's config after each sync, and from the Admin page when they switch it.
   */
  maintenance: MaintenanceState | null = null;
  /** The variant of the day's leaderboard shown beneath the daily boards, and why it couldn't load. */
  variantBoard: VariantBoard | null = null;
  variantBoardError: string | null = null;
  /** A variant's puzzle (an endless one, or the variant of the day) being generated before it opens (it can take a moment), or `null`. */
  preparing: EndlessRef | VariantDayRef | null = null;

  readonly #repo: SudokuRepository;
  readonly #seeds: SeedRepository;
  readonly #host: Host;
  readonly #serverDone = new Map<number, number>();
  readonly #queued = new Map<number, number>();
  /** The endless game being played (or last played), so the play screen and its updates share one `Game`. */
  #endless: { ref: EndlessRef; puzzle: VariantPuzzle; game: Game } | null = null;
  /** The last sync couldn't reach the server, or it is in maintenance: retried periodically, as `online` events aren't reliable. */
  #offline = false;
  /** The variant of the day being played (or last played), so the play screen and its updates share one `Game`. */
  #variantDay: { date: string; puzzle: DailyVariant; game: Game } | null = null;
  #leaderboardRequest = 0;
  #variantBoardRequest = 0;
  #statsRequest = 0;

  /** How far the player is through the Learn tab's lessons: kept on this device only. */
  readonly learn: LearnProgress;

  constructor(repo: SudokuRepository, seeds: SeedRepository, host: Host, learn: LearnProgress = new LearnProgress(new MemoryStore())) {
    super();
    this.learn = learn;
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
    if (loadStats) void Promise.all([this.#refreshStats(), this.#refreshAdminMaintenance()]).then(() => this.#changed());
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
    this.week = this.#repo.weekFor(this.today);
    const generator = this.generator;
    this.puzzles = this.#repo.puzzles(this.today, generator);
    this.games.clear();
    for (const p of this.puzzles ?? []) {
      const g = this.#repo.loadGame(generator, this.today, p);
      if (g) this.games.set(p.level, g);
    }
    this.#serverDone.clear();
    for (const [level, r] of this.#repo.serverResults(this.today, generator)) this.#serverDone.set(level, r.elapsedMs);
    this.#refreshQueued();
    this.#changed();
  }

  #refreshQueued(): void {
    this.#queued.clear();
    for (const [level, r] of this.#repo.pendingFor(this.today, this.generator)) this.#queued.set(level, r.elapsedMs);
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
        // The server answered, so it is out of maintenance for a player.
        if (!this.#repo.me()?.admin) this.maintenance = null;
        await this.#refreshAdminMaintenance();
        await this.#refreshStats();
        if (isMaintenance(report.failure)) {
          // Maintenance began between the sync's requests: the rest stays queued and goes up once it is over.
          this.#enterMaintenance(report.failure);
          this.notice = null;
        } else {
          this.notice = report.failure != null
            ? "Some results haven't uploaded yet. They'll retry automatically."
            : report.rejected.length > 0 ? `The server rejected ${report.rejected.length} result(s).` : null;
        }
      } catch (e) {
        if (isMaintenance(e)) {
          // The banner says it all, and the results wait in the queue.
          this.#enterMaintenance(e);
          this.notice = null;
        } else if ((e instanceof ApiException && e.isAuthUnavailable) || e instanceof OidcException) {
          // Sign-in can't be checked or refreshed for now (the provider is down): the session is kept, so retry like offline.
          this.#offline = true;
          this.notice = `${SIGN_IN_UNAVAILABLE} Puzzles still work, and results upload once it's back.`;
        } else if (e instanceof ApiException) {
          // An ended session has its own "Sign in again" banner; that is the one message.
          this.notice = e.isUnauthorized ? (this.#repo.needsSignIn ? null : "The server didn't accept your sign-in.") : describe(e);
        } else {
          this.#offline = true;
          this.notice = "Offline. Puzzles still work; results upload when you're back online.";
        }
      } finally {
        this.syncing = false;
        this.needsSignIn = this.#repo.needsSignIn;
        // Keep an open game as it is; otherwise pick up the new week, results and day.
        if (!isPlaying(this.screen)) this.#loadLocal();
        else this.#refreshQueued();
        // A leaderboard that failed (e.g. offline) tries again.
        if (this.screen.kind === "scores" && this.leaderboardError !== null) this.#loadLeaderboard(this.screen.date, this.screen.generator);
        if (this.screen.kind === "scores" && this.variantBoardError !== null) this.#loadVariantBoard(this.screen.date);
        if (this.screen.kind === "stats" && this.statsError !== null) this.openStats();
        if (this.screen.kind === "endless-scores" && this.leaderboardError !== null) {
          this.openEndlessScores(this.screen.difficulty, this.screen.number, this.screen.generator, this.screen.variant);
        }
        this.#changed();
      }
    })();
  }

  /** The server is down for maintenance (a 503 `maintenance`): remember until when, and keep retrying so it clears by itself. */
  #enterMaintenance(e: ApiException): void {
    this.maintenance = { until: e.maintenanceUntil };
    this.#offline = true;
  }

  /**
   * For an admin, who is always served: asks the (public) config whether maintenance mode is on, for the reminder banner.
   * (A player's maintenance state is learnt from the 503s instead.)
   */
  async #refreshAdminMaintenance(): Promise<void> {
    if (!this.#repo.me()?.admin) return;
    try {
      this.maintenance = (await this.#repo.fetchConfig(this.#repo.settings().serverUrl)).maintenance ?? null;
    } catch {
      // Not worth failing the sync over: the reminder is as it was.
    }
  }

  /** The maintenance state as a player sees it: an admin is served as usual, so for them it is `null`. */
  get serverDown(): MaintenanceState | null {
    return this.me?.admin ? null : this.maintenance;
  }

  /** "Back around Tue 3:00 pm" when maintenance mode has an end time, else `null`. */
  get backAround(): string | null {
    return this.maintenance ? backAroundOf(this.maintenance, new Date(this.#host.wallMs())) : null;
  }

  /** The Admin page switched maintenance mode on or off. */
  maintenanceChanged(settings: MaintenanceSettings): void {
    this.maintenance = settings.enabled ? { until: settings.until } : null;
    this.#changed();
  }

  /** Why a request failed, in words for the player; a 503 `maintenance` also puts the app into maintenance mode. */
  #problem(e: unknown): string {
    if (!isMaintenance(e)) return describe(e);
    this.#enterMaintenance(e);
    return maintenanceError(this.maintenance!, new Date(this.#host.wallMs()));
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

  /** The generators players can play (the server's, or the seed's): Classic alone until a week is known. */
  get generators(): number[] {
    return this.week?.generators ?? [GENERATOR_CLASSIC];
  }

  /**
   * The generator the Daily, Endless and Variants tabs play: the player's pick with the switch while it is enabled, else the
   * first enabled one. With one enabled there is no switch, and this is that one.
   */
  get generator(): number {
    const enabled = this.generators;
    const pick = this.#repo.generatorPick();
    return pick !== null && enabled.includes(pick) ? pick : enabled[0]!;
  }

  /** The Classic / Graded switch on the Daily, Endless and Variants tabs: plays `version` from now on (remembered on this device). */
  async chooseGenerator(version: number): Promise<void> {
    if (!this.generators.includes(version)) return;
    this.#repo.setGeneratorPick(version);
    if (this.seed) await this.#loadSeedDay();
    else this.#loadLocal();
    this.#changed();
  }

  /** The variant the Variants tab plays: the player's pick (remembered on this device), Diagonal until they pick. */
  get variant(): number {
    return this.#repo.variantPick() ?? VARIANT_DIAGONAL;
  }

  /** The Variants tab's Diagonal / Jigsaw / Killer picker. */
  chooseVariant(variant: number): void {
    if (!isVariant(variant) || variant === VARIANT_STANDARD) return;
    this.#repo.setVariantPick(variant);
    this.#changed();
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
    this.#variantDay = null;
    Object.assign(this, { seed: null, puzzles: null, week: null, notice: null, screen: { kind: "today" } });
    this.start();
  }

  async #startSeed(profile: SeedProfile): Promise<void> {
    this.#endless = null;
    this.#variantDay = null;
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
    const week = await this.#seeds.week();
    this.week = week;
    const generator = this.generator;
    const list = await this.#seeds.puzzles(day, generator);
    await this.#seeds.loadEndless();
    this.today = day;
    this.puzzles = list;
    this.me = null;
    this.streak = null;
    this.needsSignIn = false;
    this.games.clear();
    for (const p of list) {
      const g = this.#seeds.loadGame(generator, day, p);
      if (g) this.games.set(p.level, g);
    }
    this.#queued.clear();
    this.#serverDone.clear();
    for (const [level, r] of this.#seeds.results(day, generator)) this.#serverDone.set(level, r.elapsedMs);
  }

  /**
   * Serverless play: enables exactly the generators in `enabled` for this seed, straight away. Throws a `TypeError`
   * for an empty set or an unknown version, before anything is stored.
   */
  async setSeedGenerators(enabled: readonly number[]): Promise<void> {
    if (!this.seed) return;
    this.#seeds.setGenerators(enabled);
    await this.#loadSeedDay();
    this.#changed();
  }

  /** The link that gives others this seed and settings: this page's address with them in the fragment. */
  shareLink(): string | null {
    return this.seed ? buildShareLink(this.#host.baseUri().split(/[#?]/)[0]!, this.seed.settings) : null;
  }

  /** The "Share results" text for today's games from the generator in use. */
  resultsSummary(): Promise<string> {
    return this.#seeds.summary(this.today, this.generator);
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
      generatorsChanged: () => this.sync(),
      maintenanceChanged: (settings) => this.maintenanceChanged(settings),
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
        const message = SIGN_IN_UNAVAILABLE;
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
        if (isMaintenance(e)) {
          this.#enterMaintenance(e);
          this.#changed();
        } else {
          this.#set({ notice: e instanceof SignInError ? e.message : "Signed in, but couldn't sync yet." });
        }
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
    this.#variantDay = null;
    Object.assign(this, { puzzles: null, week: null, me: null, streak: null, stats: null, statsGenerator: null, notice: null, needsSignIn: false, maintenance: null, screen: { kind: "today" } });
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

  /** Opens the Learn tab's list of lessons, from wherever the app is. */
  openLearn(): void {
    this.help = null;
    this.screen = { kind: "today" };
    this.showHomeTab("learn");
  }

  /** Opens a lesson of the Learn tab; an unknown one opens the list instead. */
  openLesson(id: string): void {
    if (!lessonById(id)) return this.openLearn();
    this.#repo.setHomeTab("learn");
    this.homeTab = "learn";
    this.#set({ help: null, screen: { kind: "learn", lesson: id } });
  }

  /** Opens the explainer for `topic` (from the About screen, or the first endless visit). */
  openHelp(topic: HelpTopic): void {
    if (topic === "endless" && !this.hasEndless) return;
    this.#set({ help: topic });
  }

  closeHelp(): void {
    this.#set({ help: null });
  }

  /** The Endless and Variants explainers each pop up once per device, the first time their tab is shown. */
  #firstEndlessVisit(): void {
    if (!this.hasEndless || this.screen.kind !== "today") return;
    if (this.homeTab === "endless" && !this.#repo.endlessHelpSeen()) {
      this.#repo.markEndlessHelpSeen();
      this.openHelp("endless");
    } else if (this.homeTab === "variants" && !this.#repo.variantsHelpSeen()) {
      this.#repo.markVariantsHelpSeen();
      this.openHelp("variants");
    }
  }

  /** Whether the endless tab is offered: with a server or a seed, so always. */
  get hasEndless(): boolean {
    return true;
  }

  /** Where endless puzzles, games and results live: the seed's repository in serverless play. */
  get #endlessSource(): EndlessSource {
    return this.seed ? this.#seeds : this.#repo;
  }

  /** Serverless play's variant of the day solve times, newest day first. */
  variantDayHistory(): VariantDayResult[] {
    return this.#seeds.variantDayHistory();
  }

  /** Serverless play's endless solve times, by series, variant, difficulty then number. */
  endlessHistory(): EndlessResult[] {
    return this.#seeds.endlessHistory();
  }

  /**
   * The endless tab (`variant` 0) or the Variants tab (`variant` 1..3) for the current series, per difficulty, or
   * `null` until the endless seed has been downloaded once.
   */
  endlessSummaries(variant: number = VARIANT_STANDARD): EndlessSummary[] | null {
    if (!this.#endlessSource.endlessReady()) return null;
    const generator = this.generator;
    const solved = this.#endlessSource.endlessSolved();
    const inProgress = this.#endlessSource.endlessInProgress();
    const inSeries = (k: { generator: number; variant: number; difficulty: number }, difficulty: number) =>
      k.generator === generator && k.variant === variant && k.difficulty === difficulty;
    return DIFFICULTIES.map((_, i) => {
      const difficulty = i + 1;
      const numbers = [...solved.keys()].map(parseEndlessGameKey).filter((k) => inSeries(k, difficulty)).map((k) => k.number);
      let next = 1;
      while (solved.has(endlessGameKey(generator, difficulty, next, variant))) next++;
      return {
        difficulty, solved: numbers.length, highest: Math.max(0, ...numbers), next,
        inProgress: inProgress.filter((g) => inSeries(g, difficulty)).map((g) => ({ number: g.number, elapsedMs: g.elapsedMs })),
      };
    });
  }

  /**
   * Unfinished games the tab for `variant` isn't playing now, which can still be resumed: for the Endless tab
   * (`variant` 0), standard games of the other series (the other pick, or a generator that is no longer enabled);
   * for the Variants tab, games of the other variants or series.
   */
  endlessElsewhere(variant: number = VARIANT_STANDARD): EndlessInProgress[] {
    const generator = this.generator;
    return this.#endlessSource.endlessInProgress().filter((g) => variant === VARIANT_STANDARD
      ? g.variant === VARIANT_STANDARD && g.generator !== generator
      : g.variant !== VARIANT_STANDARD && (g.variant !== variant || g.generator !== generator));
  }

  /** An endless puzzle's state, as {@link statusOf} for today's. */
  endlessStatusOf(ref: EndlessRef): PuzzleStatus {
    const open = this.#endless && sameEndless(this.#endless.ref, ref) ? this.#endless.game : null;
    const game = open ?? this.#loadEndless(ref)?.game ?? null;
    const solved = this.#endlessSource.endlessSolved().get(endlessGameKey(ref.generator, ref.difficulty, ref.number, ref.variant));
    if (solved) return { kind: "done", elapsedMs: solved.elapsedMs, synced: solved.synced };
    if (!game) return { kind: "new" };
    if (game.completedElapsedMs !== null) return { kind: "done", elapsedMs: game.completedElapsedMs, synced: false };
    return { kind: "in-progress", elapsedMs: game.elapsedMs(this.nowMs()) };
  }

  /**
   * Plays an endless puzzle, resuming it if it was started here. One solved elsewhere opens its leaderboard.
   * A variant's puzzle can take a moment to generate, so {@link preparing} names it for a frame first; the
   * promise settles once it is open.
   */
  async openEndless(ref: EndlessRef): Promise<void> {
    const variant = variantOf(ref);
    if (!this.hasEndless || !isGeneratorVersion(ref.generator) || !isVariant(variant) || !DIFFICULTIES[ref.difficulty - 1] || !isEndlessNumber(ref.number)) return;
    if (variant !== VARIANT_STANDARD && !(this.#endless && sameEndless(this.#endless.ref, ref))) {
      const preparing: EndlessRef = { generator: ref.generator, variant, difficulty: ref.difficulty, number: ref.number };
      this.preparing = preparing;
      this.#changed();
      await (this.#host.nextFrame?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 0)));
      // Another puzzle was opened meanwhile: that one wins.
      if (this.preparing !== preparing) return;
      this.preparing = null;
    }
    const loaded = this.#endless && sameEndless(this.#endless.ref, ref) ? this.#endless : this.#loadEndless(ref);
    if (!loaded) {
      this.#changed();
      return;
    }
    if (this.endlessStatusOf(ref).kind === "done" && !loaded.game.isComplete) {
      this.openEndlessScores(ref.difficulty, ref.number, ref.generator, variant);
      return;
    }
    this.#endless = loaded;
    this.#set({ screen: { kind: "endless-play", generator: ref.generator, variant, difficulty: ref.difficulty, number: ref.number } });
  }

  /** The endless puzzle and its game (a new one if it wasn't started here), or `null` without the endless seed. */
  #loadEndless(ref: EndlessRef): { ref: EndlessRef; puzzle: VariantPuzzle; game: Game } | null {
    const variant = variantOf(ref);
    const puzzle = this.#endlessSource.endlessPuzzle(ref.generator, ref.difficulty, ref.number, variant);
    if (!puzzle) return null;
    const game = this.#endlessSource.loadEndlessGame(ref.generator, puzzle) ?? this.#stamp(Game.create(puzzle.givens, puzzle.layout), { a: "start" });
    return { ref: { generator: ref.generator, variant, difficulty: ref.difficulty, number: ref.number }, puzzle, game };
  }

  /**
   * The endless leaderboard of `generator`'s series (the current one when omitted) of `variant` (standard Sudoku when
   * omitted): progress in `difficulty`, or one puzzle's times with `number`. In serverless play, the history.
   */
  openEndlessScores(difficulty: number, number: number | null = null, generator: number = this.generator, variant: number = VARIANT_STANDARD): void {
    // No leaderboard without a server: serverless play's history lists endless solves too.
    if (this.seed) {
      this.openHistory();
      return;
    }
    this.screen = { kind: "endless-scores", generator, variant, difficulty, number };
    const request = ++this.#leaderboardRequest;
    this.endlessProgress = null;
    this.endlessBoard = null;
    this.leaderboardError = null;
    this.#changed();
    const load: Promise<unknown> = number === null
      ? this.#repo.endlessProgress(generator, variant)
      : this.#repo.endlessBoard(generator, difficulty, number, variant);
    load.then(
      (data) => {
        if (request !== this.#leaderboardRequest) return;
        if (number === null) this.endlessProgress = data as EndlessProgress;
        else this.endlessBoard = data as EndlessBoard;
      },
      (e) => {
        if (request !== this.#leaderboardRequest) return;
        this.leaderboardError = e instanceof ApiException || e instanceof OidcException ? this.#problem(e) : "You're offline. The leaderboard needs a connection to the server.";
      },
    ).finally(() => this.#changed());
  }

  /** The game for `ref`, if it's open (today's games, or the endless puzzle on screen). */
  gameOf(ref: PuzzleRef): Game | null {
    if (isVariantDayRef(ref)) return this.#variantDay?.game ?? null;
    if (typeof ref === "number") return this.games.get(ref) ?? null;
    return this.#endless && sameEndless(this.#endless.ref, ref) ? this.#endless.game : null;
  }

  /** The puzzle for `ref`. */
  puzzleOf(ref: PuzzleRef): Puzzle | EndlessPuzzle | DailyVariant | null {
    if (isVariantDayRef(ref)) return this.#variantDay?.puzzle ?? null;
    if (typeof ref === "number") return this.puzzle(ref);
    return this.#endless && sameEndless(this.#endless.ref, ref) ? this.#endless.puzzle : null;
  }

  /** The play screen's title for `ref`: the generator and the puzzle's name, or just "Killer of the day" for the variant of the day (it never names a generator or difficulty). */
  headingOf(ref: PuzzleRef): string {
    if (isVariantDayRef(ref)) return variantDayTitle(ref.variant);
    const puzzle = this.puzzleOf(ref) as Puzzle | EndlessPuzzle;
    if (typeof ref !== "number") return `${seriesName(ref.generator, ref.variant ?? 0)} · ${puzzle.title}`;
    return this.generators.length > 1 ? `${generatorName(this.generator)} · ${puzzle.title}` : puzzle.title;
  }

  /** "See scores" after solving `ref`. */
  openScoresFor(ref: PuzzleRef): void {
    if (isVariantDayRef(ref)) this.openScores(0);
    else if (typeof ref === "number") this.openScores(ref);
    else this.openEndlessScores(ref.difficulty, ref.number, ref.generator, ref.variant);
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
    this.#set({ screen: { kind: "play", generator: this.generator, level } });
  }

  /** The daily leaderboard of `generator`'s puzzles (the one in use when omitted) on `date`, on tab `tab`. */
  openScores(tab = 0, date: string = this.today, generator: number = this.generator): void {
    // No leaderboard without a server: serverless play has its own history instead.
    if (this.seed) {
      this.openHistory();
      return;
    }
    this.screen = { kind: "scores", date, tab, generator };
    this.#loadLeaderboard(date, generator);
    // It is the same for every generator, so only a new day (or a failed load) fetches it again.
    if (this.variantBoard?.date !== date || this.variantBoardError !== null) this.#loadVariantBoard(date);
  }

  /** The leaderboard's Classic / Graded switch: the same day and tab, for `generator`'s puzzles. */
  showScoresGenerator(generator: number): void {
    if (this.screen.kind === "scores") this.openScores(this.screen.tab, this.screen.date, generator);
  }

  /** The Stats screen, on the generator in use. It needs the server, like the leaderboard. */
  openStats(): void {
    if (this.seed) return;
    this.screen = { kind: "stats" };
    this.#loadStats(this.generator);
  }

  /** Shows the Stats screen's daily numbers for generator `version`. The streak is the same for every generator. */
  showStatsGenerator(version: number): void {
    if (this.screen.kind !== "stats") return;
    this.#loadStats(version);
  }

  #loadStats(generator: number): void {
    this.statsGenerator = generator;
    const request = ++this.#statsRequest;
    this.stats = null;
    this.statsError = null;
    this.#changed();
    this.#repo.fetchStats(generator).then(
      (stats) => {
        if (request === this.#statsRequest) this.#setStats(stats);
      },
      (e) => {
        if (request !== this.#statsRequest) return;
        this.statsError = e instanceof ApiException || e instanceof OidcException ? this.#problem(e) : "You're offline. Your stats need a connection to the server.";
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
    this.openScores(this.screen.tab, next, this.screen.generator);
  }

  #loadLeaderboard(date: string, generator: number): void {
    const request = ++this.#leaderboardRequest;
    this.leaderboard = null;
    this.leaderboardError = null;
    this.#changed();
    this.#repo.leaderboard(date, generator).then(
      (board) => {
        if (request === this.#leaderboardRequest) this.leaderboard = board;
      },
      (e) => {
        if (request !== this.#leaderboardRequest) return;
        this.leaderboardError = e instanceof ApiException || e instanceof OidcException ? this.#problem(e) : "You're offline. The leaderboard needs a connection to the server.";
      },
    ).finally(() => this.#changed());
  }

  #loadVariantBoard(date: string): void {
    const request = ++this.#variantBoardRequest;
    this.variantBoard = null;
    this.variantBoardError = null;
    this.#changed();
    this.#repo.variantBoard(date).then(
      (board) => {
        if (request === this.#variantBoardRequest) this.variantBoard = board;
      },
      (e) => {
        if (request !== this.#variantBoardRequest) return;
        this.variantBoardError = e instanceof ApiException || e instanceof OidcException ? this.#problem(e) : "You're offline. The leaderboard needs a connection to the server.";
      },
    ).finally(() => this.#changed());
  }

  // Variant of the day

  /** Where the variant of the day's puzzle, game and result live: the seed's repository in serverless play. */
  get #variantSource(): VariantDaySource {
    return this.seed ? this.#seeds : this.#repo;
  }

  /**
   * Today's variant of the day: 1 Diagonal, 2 Jigsaw or 3 Killer, drawn from the week's seed (so known offline), or `null`
   * until a week is known. Its generator and difficulty are never shown.
   */
  get variantDayKind(): number | null {
    return this.week ? dailyVariantOf(parseWeekSeed(this.week.seed), dayOfWeek(this.today)) : null;
  }

  /** Today's variant of the day's state, as {@link statusOf} for a level. Never generates the puzzle. */
  variantDayStatus(): PuzzleStatus {
    const solved = this.#variantSource.variantDaySolved(this.today);
    if (solved) return { kind: "done", elapsedMs: solved.elapsedMs, synced: solved.synced };
    const open = this.#variantDay?.date === this.today ? this.#variantDay.game : null;
    if (open) {
      return open.completedElapsedMs !== null
        ? { kind: "done", elapsedMs: open.completedElapsedMs, synced: false }
        : { kind: "in-progress", elapsedMs: open.elapsedMs(this.nowMs()) };
    }
    const saved = this.#variantSource.variantDaySaved(this.today);
    if (!saved) return { kind: "new" };
    return saved.completed ? { kind: "done", elapsedMs: saved.elapsedMs, synced: false } : { kind: "in-progress", elapsedMs: saved.elapsedMs };
  }

  /**
   * Plays today's variant of the day, resuming it if it was started here. One solved elsewhere opens its leaderboard. The
   * puzzle can take a moment to generate, so {@link preparing} names it for a frame first; the promise settles once it is open.
   */
  async openVariantDay(): Promise<void> {
    const week = this.week;
    const variant = this.variantDayKind;
    if (!week || variant === null) return;
    const date = this.today;
    let day = this.#variantDay?.date === date ? this.#variantDay : null;
    if (this.variantDayStatus().kind === "done" && !day?.game.isComplete) {
      this.openScores(0);
      return;
    }
    if (!day) {
      const preparing: VariantDayRef = { variantDay: true, variant };
      this.preparing = preparing;
      this.#changed();
      await (this.#host.nextFrame?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 0)));
      // Another puzzle was opened meanwhile: that one wins.
      if (this.preparing !== preparing) return;
      this.preparing = null;
      const puzzle = this.#variantSource.variantDay(week, date);
      const game = this.#variantSource.loadVariantDayGame(date, puzzle) ?? this.#stamp(Game.create(puzzle.givens, puzzle.layout), { a: "start" });
      day = { date, puzzle, game };
    }
    this.#variantDay = day;
    this.#set({ screen: { kind: "variant-day-play", date, variant } });
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
    if (isVariantDayRef(ref)) {
      const day = this.#variantDay!;
      day.game = after;
      this.#variantSource.saveVariantDayGame(day.date, after, this.nowMs());
      if (finished) void this.#variantSource.completeVariantDay(day.date, ref.variant, after).then(() => this.sync());
      this.#changed();
      return;
    }
    if (typeof ref !== "number") {
      this.#endless!.game = after;
      const variant = variantOf(ref);
      this.#endlessSource.saveEndlessGame(ref.generator, ref.difficulty, ref.number, after, this.nowMs(), variant);
      if (finished) void this.#endlessSource.completeEndless(ref.generator, ref.difficulty, ref.number, after, variant).then(() => this.sync());
      this.#changed();
      return;
    }
    const level = ref;
    const generator = this.generator;
    this.games.set(level, after);
    if (this.seed) {
      this.#seeds.saveGame(generator, this.today, level, after, this.nowMs());
      if (finished) this.#serverDone.set(level, this.#seeds.complete(generator, this.today, level, after).elapsedMs);
    } else {
      this.#repo.saveGame(generator, this.today, level, after, this.nowMs());
      if (finished) {
        this.#queued.set(level, after.completedElapsedMs!);
        void this.#repo.complete(generator, this.today, level, after).then(() => this.sync());
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
    if (!isPlaying(this.screen) && this.#currentDay() !== this.today) {
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

/** Whether `screen` is a puzzle being played: its board is kept as it is while syncs and day changes happen. */
const isPlaying = (screen: Screen): boolean => screen.kind === "play" || screen.kind === "endless-play" || screen.kind === "variant-day-play";

const isMaintenance = (e: unknown): e is ApiException => e instanceof ApiException && e.isMaintenance;

const sameEndless = (a: EndlessRef, b: EndlessRef) =>
  a.generator === b.generator && variantOf(a) === variantOf(b) && a.difficulty === b.difficulty && a.number === b.number;

function describe(e: unknown): string {
  if (e instanceof SignInError) return e.message || "Sign-in failed.";
  if (e instanceof OidcException) return SIGN_IN_UNAVAILABLE;
  if (e instanceof ApiException) return e.error?.message.trim() || (e.isUnauthorized ? "Your sign-in has expired." : `Server error (HTTP ${e.status})`);
  return "Can't reach the server. Check your connection and try again.";
}
