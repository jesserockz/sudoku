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

sealed interface Screen {
    data object Today : Screen

    data class Play(val level: Int) : Screen

    data class Scores(val date: LocalDate, val tab: Int) : Screen
}

sealed interface Phase {
    data object Loading : Phase

    /** Couldn't sign in, or reach the server while signed out. */
    data class Failed(val message: String) : Phase

    data class SignIn(val config: AppConfig) : Phase

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
 */
class AppController(
    private val scope: CoroutineScope,
    private val storage: AppStorage,
    private val repo: SudokuRepository,
) {
    val ticker: Ticker = Ticker.monotonic()

    var phase by mutableStateOf<Phase>(Phase.Loading)
        private set
    var screen by mutableStateOf<Screen>(Screen.Today)
        private set

    var me by mutableStateOf<Me?>(null)
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
        LegacyStorage.migrateIdentity(storage, origin)
        if (repo.isSignedIn) {
            showReady()
            sync()
            return
        }
        phase = Phase.Loading
        scope.launch {
            try {
                val config = repo.fetchConfig(origin)
                if (LegacyStorage.migrateOidcTokens(storage, origin, config)) {
                    showReady()
                    sync()
                } else {
                    phase = Phase.SignIn(config)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                phase = Phase.Failed(describe(e))
            }
        }
    }

    private fun showReady() {
        loadLocal()
        needsSignIn = repo.needsSignIn
        phase = Phase.Ready
    }

    /** Reloads the day from local state (no network). */
    private fun loadLocal() {
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
        if (syncing || phase != Phase.Ready || !repo.isSignedIn) return
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
        if (repo.today() != today) loadLocal()
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
                if (screen !is Screen.Play && repo.today() != today) {
                    loadLocal()
                    sync()
                } else if (offline && document.asDynamic().hidden != true) {
                    sync()
                }
            }
        }
    }

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
