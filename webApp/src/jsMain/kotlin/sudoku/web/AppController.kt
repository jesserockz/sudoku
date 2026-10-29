package sudoku.web

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.browser.document
import kotlinx.browser.window
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.datetime.DatePeriod
import kotlinx.datetime.LocalDate
import kotlinx.datetime.minus
import kotlinx.datetime.plus
import sudoku.api.ApiException
import sudoku.api.AppConfig
import sudoku.api.Leaderboard
import sudoku.api.Me
import sudoku.data.AppStorage
import sudoku.data.SignInException
import sudoku.data.SudokuRepository
import sudoku.game.Game
import sudoku.game.Ticker
import sudoku.generator.Puzzle
import sudoku.serverless.PlaySeed
import sudoku.serverless.SeedProfile
import sudoku.serverless.SeedRepository
import sudoku.serverless.SeedSettings
import sudoku.serverless.ShareLink

sealed interface Screen {
    data object Today : Screen

    data class Play(val level: Int) : Screen

    data class Scores(val date: LocalDate, val tab: Int) : Screen

    /** Serverless play's local history of solve times. */
    data object History : Screen
}

sealed interface Phase {
    data object Loading : Phase

    /** Couldn't sign in, or reach the server while signed out. */
    data class Failed(val message: String) : Phase

    data class SignIn(val config: AppConfig) : Phase

    /**
     * Enter or generate a seed. [server] is the server's config when there is
     * one (the player chose "Play with a seed" over signing in), or `null` when
     * there's no Sudoku server here (e.g. static hosting).
     */
    data class SeedSetup(val server: AppConfig?) : Phase

    /** A share link for [incoming] was opened while playing with a different seed (or signed in). */
    data class ConfirmSeed(val incoming: SeedSettings, val incomingFingerprint: String, val current: SeedProfile?) : Phase

    data object Ready : Phase
}

/** A puzzle's state on the "today" list. */
sealed interface PuzzleStatus {
    data object New : PuzzleStatus

    data class InProgress(val elapsedMs: Long) : PuzzleStatus

    /** Finished. [synced] is false while the result waits in the offline queue. */
    data class Done(val elapsedMs: Long, val synced: Boolean) : PuzzleStatus
}

/**
 * All web client state and logic. Screens read the Compose state here and call
 * its methods; nothing else talks to the repository.
 *
 * Offline-first, like the Android app: once signed in, the app starts from the
 * cached week in `localStorage` with no network, and syncs in the background
 * (at start, when the browser comes back online and when the page becomes
 * visible). Only signing in and the leaderboard need the server.
 *
 * Serverless mode ([seed] set) plays from a shared seed instead: no server,
 * sign-in or leaderboard; puzzles, games and a history of times are all local
 * ([SeedRepository]). It's chosen when there's no Sudoku server here, when a
 * share link (`#seed=...`) is opened, or with "Play with a seed".
 */
class AppController(
    private val scope: CoroutineScope,
    private val storage: AppStorage,
    private val repo: SudokuRepository,
    private val seeds: SeedRepository,
) {
    val ticker: Ticker = Ticker.monotonic()

    var phase by mutableStateOf<Phase>(Phase.Loading)
        private set
    var screen by mutableStateOf<Screen>(Screen.Today)
        private set

    var me by mutableStateOf<Me?>(null)
        private set

    /** The seed being played in serverless mode, or `null` when playing with a server. */
    var seed by mutableStateOf<SeedProfile?>(null)
        private set

    /** The day being shown; follows the device clock in Auckland time. */
    var today by mutableStateOf(repo.today())
        private set

    /** The day's games, or `null` when the cached week doesn't cover today (connect once this week). */
    var puzzles by mutableStateOf<List<Puzzle>?>(null)
        private set

    /** Today's games started on this device, by level. */
    val games = mutableStateMapOf<Int, Game>()
    private val serverDone = mutableStateMapOf<Int, Long>()
    private val queued = mutableStateMapOf<Int, Long>()

    var syncing by mutableStateOf(false)
        private set

    /** The last sync couldn't reach the server: retried periodically, as `online` events aren't reliable. */
    private var offline = false

    /** Signed in with OIDC but the session has expired or been revoked: offer "Sign in again". */
    var needsSignIn by mutableStateOf(false)
        private set

    var leaderboard by mutableStateOf<Leaderboard?>(null)
        private set
    var leaderboardError by mutableStateOf<String?>(null)
        private set
    private var leaderboardJob: Job? = null

    /** A transient problem worth showing (e.g. offline, results not uploaded yet). */
    var notice by mutableStateOf<String?>(null)
        private set

    private val origin = window.location.origin

    init {
        start()
        watchDayRollover()
    }

    fun start() {
        if (window.location.pathname == CALLBACK_PATH) {
            finishOidcSignIn()
            return
        }
        takeShareLink()?.let {
            offerSeed(it)
            return
        }
        seeds.profile()?.let {
            startSeed(it)
            return
        }
        seed = null
        LegacyStorage.migrateIdentity(storage, origin)
        if (repo.isSignedIn) {
            showReady()
            sync()
            return
        }
        phase = Phase.Loading
        scope.launch {
            val config = try {
                repo.fetchConfig(origin)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                // Unreachable, or not a Sudoku server (e.g. a static host): play with a seed.
                null
            }
            when {
                config == null -> phase = Phase.SeedSetup(server = null)
                LegacyStorage.migrateOidcTokens(storage, origin, config) -> {
                    showReady()
                    sync()
                }
                else -> phase = Phase.SignIn(config)
            }
        }
    }

    private fun showReady() {
        seed = null
        loadLocal()
        needsSignIn = repo.needsSignIn
        phase = Phase.Ready
    }

    /** Reloads the day from local state (no network). */
    private fun loadLocal() {
        if (seed != null) {
            scope.launch { loadSeedDay() }
            return
        }
        me = repo.me()
        today = repo.today()
        val list = repo.puzzles(today)
        puzzles = list
        games.clear()
        list?.forEach { p -> repo.loadGame(today, p)?.let { games[p.level] = it } }
        serverDone.clear()
        repo.serverResults(today).forEach { (level, r) -> serverDone[level] = r.elapsedMs }
        scope.launch { refreshQueued() }
    }

    private suspend fun refreshQueued() {
        val pending = repo.pending().filter { it.date == today }
        queued.clear()
        pending.forEach { queued[it.level] = it.elapsedMs }
    }

    /** Syncs with the server in the background; offline is fine and just noted. */
    fun sync() {
        if (syncing || phase != Phase.Ready || seed != null || !repo.isSignedIn) return
        syncing = true
        scope.launch {
            try {
                val report = repo.refresh()
                offline = false
                // Results queued by the web app before it kept one queue for everyone.
                if (LegacyStorage.migrateProgress(storage, repo)) repo.flush()
                notice = when {
                    report.failure != null -> "Some results haven't uploaded yet. They'll retry automatically."
                    report.rejected.isNotEmpty() -> "The server rejected ${report.rejected.size} result(s)."
                    else -> null
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                notice = if (e.isUnauthorized) "The server didn't accept your sign-in." else describe(e)
            } catch (e: Throwable) {
                offline = true
                notice = "Offline. Puzzles still work; results upload when you're back online."
            } finally {
                syncing = false
                needsSignIn = repo.needsSignIn
                // Keep an open game as it is; otherwise pick up the new week, results and day.
                if (screen !is Screen.Play) loadLocal() else refreshQueued()
                // A leaderboard that failed (e.g. offline) tries again.
                (screen as? Screen.Scores)?.let { if (leaderboardError != null) loadLeaderboard(it.date) }
            }
        }
    }

    fun statusOf(level: Int): PuzzleStatus {
        serverDone[level]?.let { return PuzzleStatus.Done(it, synced = true) }
        queued[level]?.let { return PuzzleStatus.Done(it, synced = false) }
        val game = games[level] ?: return PuzzleStatus.New
        game.completedElapsedMs?.let { return PuzzleStatus.Done(it, synced = false) }
        return PuzzleStatus.InProgress(game.elapsedMs(ticker.nowMs()))
    }

    fun puzzle(level: Int): Puzzle? = puzzles?.firstOrNull { it.level == level }

    // Serverless play

    /** The settings in the URL's `#seed=...` fragment, if any; the fragment is removed either way. */
    private fun takeShareLink(): SeedSettings? {
        val hash = window.location.hash
        if (hash.length <= 1) return null
        // Keep the seed out of the address bar, history and anything copied from it.
        window.history.replaceState(null, "", window.location.pathname + window.location.search)
        return ShareLink.parse(hash).also { if (it == null) notice = "That link doesn't contain a valid seed." }
    }

    /** A share link was opened: adopt it, after asking if it would replace another seed or a sign-in. */
    private fun offerSeed(incoming: SeedSettings) {
        val current = seeds.profile()
        if (current?.settings == incoming || (current == null && !repo.isSignedIn)) {
            useSeed(incoming)
            return
        }
        phase = Phase.Loading
        scope.launch { phase = Phase.ConfirmSeed(incoming, PlaySeed.fingerprint(incoming.seed), current) }
    }

    /** The URL's fragment changed while the app is open, e.g. a share link pasted into this tab. */
    fun onHashChange() {
        takeShareLink()?.let { offerSeed(it) }
    }

    /** Starts playing with [settings] (from the setup screen, or accepting a share link). */
    fun useSeed(settings: SeedSettings) {
        phase = Phase.Loading
        scope.launch { startSeed(seeds.use(settings)) }
    }

    /** "Play with a seed" from the sign-in screen. */
    fun chooseSeed() {
        phase = Phase.SeedSetup((phase as? Phase.SignIn)?.config)
    }

    /** Back from seed setup or a declined share link to whatever was there before. */
    fun cancelSeed() {
        screen = Screen.Today
        val setup = phase as? Phase.SeedSetup
        if (setup?.server != null) phase = Phase.SignIn(setup.server) else start()
    }

    /** Stops playing with the seed. Its games and history are kept for if it's entered again. */
    fun leaveSeed() {
        seeds.leave()
        seed = null
        games.clear()
        puzzles = null
        notice = null
        screen = Screen.Today
        start()
    }

    private fun startSeed(profile: SeedProfile) {
        seed = profile
        phase = Phase.Loading
        scope.launch {
            try {
                loadSeedDay()
                phase = Phase.Ready
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                // E.g. a stored timezone this browser doesn't know: let the player pick again.
                seeds.leave()
                seed = null
                phase = Phase.SeedSetup(server = null)
                notice = "Couldn't start that seed: ${e.message}"
            }
        }
    }

    private suspend fun loadSeedDay() {
        val day = seeds.today()
        val list = seeds.puzzles(day)
        today = day
        puzzles = list
        me = null
        needsSignIn = false
        games.clear()
        list.forEach { p -> seeds.loadGame(day, p)?.let { games[p.level] = it } }
        queued.clear()
        serverDone.clear()
        seeds.results(day).forEach { (level, r) -> serverDone[level] = r.elapsedMs }
    }

    /** The link that gives others this seed and settings: this page's address with them in the fragment. */
    fun shareLink(): String? = seed?.let { ShareLink.build(appUrl(), it.settings) }

    /** The "Share results" text for today. */
    suspend fun resultsSummary(): String = seeds.summary(today)

    /** Serverless play's history of solve times, newest day first. */
    fun history() = seeds.history()

    fun openHistory() {
        if (seed != null) screen = Screen.History
    }

    /** Where this copy of the app lives, e.g. `https://example.github.io/sudoku/`. */
    private fun appUrl(): String = document.baseURI.substringBefore('#').substringBefore('?')

    // Sign-in

    /** Dev auth mode: signs in as [sub] / [name]. Throws [IllegalArgumentException] for an invalid id or name. */
    suspend fun signInDev(sub: String, name: String) {
        repo.signInDev(origin, sub, name)
        showReady()
    }

    /** Starts OIDC sign-in (or signs in again after the session expired): redirects to the provider. */
    fun signIn() {
        val oidc = (phase as? Phase.SignIn)?.config?.oidc ?: repo.settings().oidc ?: return
        scope.launch {
            try {
                window.location.href = repo.beginOidcSignIn(origin, oidc)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                val message = "Couldn't reach the identity provider. Check your connection and try again."
                if (phase == Phase.Ready) notice = message else phase = Phase.Failed(message)
            }
        }
    }

    /** The provider redirected back to [CALLBACK_PATH]. */
    private fun finishOidcSignIn() {
        val redirect = window.location.href
        // Leave the callback URL whatever happens, so a reload doesn't replay it.
        window.history.replaceState(null, "", "/")
        phase = Phase.Loading
        scope.launch {
            try {
                repo.completeOidcSignIn(redirect)
                notice = null
                showReady()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                if (repo.isSignedIn) {
                    // Signing in again failed, or the first sync did: the cached state still plays.
                    showReady()
                    notice = if (e is SignInException) e.message else "Signed in, but couldn't sync yet."
                } else {
                    phase = Phase.Failed(describe(e))
                }
            }
        }
    }

    /** Signs out here and, with OIDC, at the identity provider too (which navigates away). */
    fun signOut() {
        scope.launch {
            val endSession = repo.endSessionUrl("$origin/")
            repo.signOut()
            games.clear()
            puzzles = null
            me = null
            notice = null
            needsSignIn = false
            screen = Screen.Today
            if (endSession != null) window.location.href = endSession else start()
        }
    }

    // Navigation

    fun openToday() {
        screen = Screen.Today
        // The day may have rolled over while a puzzle was open.
        if (currentDay() != today) loadLocal()
    }

    fun openPuzzle(level: Int) {
        // Finished on another device (or this one before storage was cleared): nothing to play.
        if (statusOf(level) is PuzzleStatus.Done && games[level]?.isComplete != true) {
            openScores(level)
            return
        }
        val p = puzzle(level) ?: return
        if (games[level] == null) games[level] = Game.new(p.givens)
        screen = Screen.Play(level)
    }

    fun openScores(tab: Int = 0, date: LocalDate = today) {
        // No leaderboard without a server: serverless play has its own history instead.
        if (seed != null) {
            openHistory()
            return
        }
        screen = Screen.Scores(date, tab)
        loadLeaderboard(date)
    }

    fun showScoresTab(tab: Int) {
        (screen as? Screen.Scores)?.let { screen = it.copy(tab = tab) }
    }

    /** Moves the leaderboard by [days], within the server's 8-day result window. */
    fun shiftScoresDate(days: Int) {
        val current = screen as? Screen.Scores ?: return
        val next = if (days >= 0) current.date.plus(DatePeriod(days = days)) else current.date.minus(DatePeriod(days = -days))
        if (next > today || next < today.minus(DatePeriod(days = 8))) return
        openScores(current.tab, next)
    }

    private fun loadLeaderboard(date: LocalDate) {
        leaderboardJob?.cancel()
        leaderboard = null
        leaderboardError = null
        leaderboardJob = scope.launch {
            try {
                leaderboard = repo.leaderboard(date)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                leaderboardError = describe(e)
            } catch (e: Throwable) {
                leaderboardError = "You're offline. The leaderboard needs a connection to the server."
            }
        }
    }

    // Play

    /** Applies [change] to the game for [level], persists it, and handles completion. */
    fun update(level: Int, change: (Game) -> Game) {
        val before = games[level] ?: return
        val after = change(before)
        if (after === before) return
        games[level] = after
        if (seed != null) {
            seeds.saveGame(today, level, after, ticker.nowMs())
            if (after.isComplete && !before.isComplete) serverDone[level] = seeds.complete(today, level, after).elapsedMs
            return
        }
        repo.saveGame(today, level, after, ticker.nowMs())
        if (after.isComplete && !before.isComplete) {
            queued[level] = after.completedElapsedMs ?: 0
            val day = today
            scope.launch {
                repo.complete(day, level, after)
                sync()
            }
        }
    }

    // Lifecycle

    /** Starts over, e.g. "Try again" after a failure. */
    fun reload() {
        screen = Screen.Today
        start()
    }

    /** Every 30 s: catches the day rolling over, and retries a sync that failed while the page is visible. */
    private fun watchDayRollover() {
        scope.launch {
            while (true) {
                delay(30_000)
                if (phase != Phase.Ready) continue
                // Don't pull the board out from under someone mid-puzzle; openToday() catches up.
                if (screen !is Screen.Play && currentDay() != today) {
                    loadLocal()
                    sync()
                } else if (offline && document.asDynamic().hidden != true) {
                    sync()
                }
            }
        }
    }

    private fun currentDay(): LocalDate = if (seed != null) seeds.today() else repo.today()

    private fun describe(e: Throwable): String = when (e) {
        is SignInException -> e.message ?: "Sign-in failed."
        is ApiException -> e.error?.message?.takeIf { it.isNotBlank() } ?: "Server error (HTTP ${e.status})"
        else -> "Can't reach the server. Check your connection and try again."
    }

    companion object {
        /** Register `<origin>/auth/callback` as the redirect URI in Authentik. */
        const val CALLBACK_PATH = "/auth/callback"
    }
}
