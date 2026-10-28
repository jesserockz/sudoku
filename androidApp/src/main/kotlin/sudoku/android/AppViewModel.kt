package sudoku.android

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.datetime.DatePeriod
import kotlinx.datetime.LocalDate
import kotlinx.datetime.minus
import kotlinx.datetime.plus
import sudoku.api.ApiException
import sudoku.api.AppConfig
import sudoku.api.AuthMode
import sudoku.api.Leaderboard
import sudoku.data.SignInException
import sudoku.game.Game
import sudoku.game.Ticker
import sudoku.generator.Puzzle

sealed interface Screen {
    data object Setup : Screen

    data object Today : Screen

    data class Play(val level: Int) : Screen

    data class Scores(val date: LocalDate, val tab: Int) : Screen
}

sealed interface PuzzleStatus {
    data object New : PuzzleStatus

    data class InProgress(val elapsedMs: Long) : PuzzleStatus

    /** Finished. [synced] is false while the result waits in the upload queue. */
    data class Done(val elapsedMs: Long, val synced: Boolean) : PuzzleStatus
}

class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val app = SudokuApp.from(application)
    private val repo = app.repository
    val ticker: Ticker = Ticker.monotonic()

    var screen by mutableStateOf<Screen>(if (repo.isSignedIn) Screen.Today else Screen.Setup)
        private set

    /** The day being shown; follows the device clock in Auckland time. */
    var date by mutableStateOf(repo.today())
        private set
    var puzzles by mutableStateOf<List<Puzzle>?>(null)
        private set
    val games = mutableStateMapOf<Int, Game>()
    private val serverDone = mutableStateMapOf<Int, Long>()
    private val queued = mutableStateMapOf<Int, Long>()

    var syncing by mutableStateOf(false)
        private set

    /** Shown under the header when the last sync failed (e.g. offline). */
    var syncProblem by mutableStateOf<String?>(null)
        private set

    var leaderboard by mutableStateOf<Leaderboard?>(null)
        private set
    var leaderboardError by mutableStateOf<String?>(null)
        private set
    private var leaderboardJob: Job? = null

    // Setup screen state.
    var setupBusy by mutableStateOf(false)
        private set
    var setupError by mutableStateOf<String?>(null)
        private set
    var setupAuthMode by mutableStateOf<AuthMode?>(null)
        private set
    private var setupConfig: AppConfig? = null

    /** A URL the activity should open in the browser (OIDC sign-in), then clear with [browserOpened]. */
    var browserUrl by mutableStateOf<String?>(null)
        private set

    /** Signed in with OIDC but the session has expired or been revoked. */
    var needsSignIn by mutableStateOf(repo.needsSignIn)
        private set
    val defaultServerUrl: String get() = repo.settings().serverUrl
    val displayName: String? get() = repo.me()?.displayName
    val myId: String? get() = repo.me()?.id

    init {
        if (repo.isSignedIn) {
            loadLocal()
            sync()
        }
    }

    /** Reloads the day from local state (no network). */
    private fun loadLocal() {
        date = repo.today()
        val list = repo.puzzles(date)
        puzzles = list
        games.clear()
        list?.forEach { p -> repo.loadGame(date, p)?.let { games[p.level] = it } }
        serverDone.clear()
        repo.serverResults(date).forEach { (level, r) -> serverDone[level] = r.elapsedMs }
        viewModelScope.launch { refreshQueued() }
    }

    private suspend fun refreshQueued() {
        queued.clear()
        repo.pending().filter { it.date == date }.forEach { queued[it.level] = it.elapsedMs }
    }

    /** Syncs with the server in the background; offline is fine and just noted. */
    fun sync() {
        if (syncing || !repo.isSignedIn) return
        syncing = true
        viewModelScope.launch {
            try {
                val report = repo.refresh()
                syncProblem = when {
                    report.failure != null -> "Some results haven't uploaded yet. They'll retry automatically."
                    report.rejected.isNotEmpty() -> "The server rejected ${report.rejected.size} result(s)."
                    else -> null
                }
                if (report.remaining.isNotEmpty()) app.scheduleUpload()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                syncProblem = if (e.isUnauthorized) "The server didn't accept your sign-in." else "Server error (HTTP ${e.status})."
                if (e.isUnauthorized && repo.settings().oidc != null) needsSignIn = true
            } catch (e: Exception) {
                syncProblem = "Offline. Puzzles still work; results upload when you're back online."
            } finally {
                syncing = false
                if (repo.needsSignIn) needsSignIn = true
                // Keep an in-progress game if the day hasn't changed; otherwise reload.
                if (screen !is Screen.Play) loadLocal() else refreshQueued()
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

    // Navigation

    fun openToday() {
        screen = Screen.Today
        if (repo.today() != date) loadLocal()
    }

    fun openPuzzle(level: Int) {
        if (statusOf(level) is PuzzleStatus.Done && games[level]?.isComplete != true) {
            openScores(level)
            return
        }
        val p = puzzle(level) ?: return
        if (games[level] == null) games[level] = Game.new(p.givens)
        screen = Screen.Play(level)
    }

    fun openScores(tab: Int = 0, day: LocalDate = date) {
        screen = Screen.Scores(day, tab)
        leaderboardJob?.cancel()
        leaderboard = null
        leaderboardError = null
        leaderboardJob = viewModelScope.launch {
            try {
                leaderboard = repo.leaderboard(day)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                leaderboardError = "The leaderboard needs a connection to the server."
            }
        }
    }

    fun showScoresTab(tab: Int) {
        (screen as? Screen.Scores)?.let { screen = it.copy(tab = tab) }
    }

    fun shiftScoresDate(days: Int) {
        val s = screen as? Screen.Scores ?: return
        val next = if (days >= 0) s.date.plus(DatePeriod(days = days)) else s.date.minus(DatePeriod(days = -days))
        if (next > repo.today() || next < repo.today().minus(DatePeriod(days = 8))) return
        openScores(s.tab, next)
    }

    /** Back navigation; returns false when the system should handle it (exit). */
    fun back(): Boolean = when (screen) {
        is Screen.Play, is Screen.Scores -> {
            openToday()
            true
        }
        else -> false
    }

    // Play

    fun update(level: Int, change: (Game) -> Game) {
        val before = games[level] ?: return
        val after = change(before)
        if (after === before) return
        games[level] = after
        repo.saveGame(date, level, after, ticker.nowMs())
        if (after.isComplete && !before.isComplete) {
            queued[level] = after.completedElapsedMs ?: 0
            val day = date
            viewModelScope.launch {
                repo.complete(day, level, after)
                app.scheduleUpload()
                sync()
            }
        }
    }

    // Setup

    fun checkServer(url: String) {
        setupBusy = true
        setupError = null
        viewModelScope.launch {
            try {
                val config = repo.fetchConfig(url)
                setupConfig = config
                setupAuthMode = config.authMode
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                setupAuthMode = null
                setupError = "Couldn't reach a Sudoku server at that address."
            } finally {
                setupBusy = false
            }
        }
    }

    fun signInDev(url: String, sub: String, name: String) {
        setupBusy = true
        setupError = null
        viewModelScope.launch {
            try {
                repo.signInDev(url, sub.trim(), name.trim())
                loadLocal()
                screen = Screen.Today
            } catch (e: CancellationException) {
                throw e
            } catch (e: IllegalArgumentException) {
                setupError = "User id can't be empty or contain ':', and a name is required."
            } catch (e: Exception) {
                setupError = "Sign-in failed: couldn't reach the server."
            } finally {
                setupBusy = false
            }
        }
    }

    /** Starts OIDC sign-in from the setup screen. */
    fun signInOidc(url: String) {
        val oidc = setupConfig?.oidc
        if (oidc == null || oidc.issuer.isBlank()) {
            setupError = "The server's OIDC settings are incomplete."
            return
        }
        startOidc(url, oidc)
    }

    /** Signs in again after the session expired, keeping games and queued results. */
    fun signInAgain() {
        val s = repo.settings()
        startOidc(s.serverUrl, s.oidc ?: return)
    }

    private fun startOidc(url: String, oidc: sudoku.api.OidcConfig) {
        setupBusy = true
        setupError = null
        viewModelScope.launch {
            try {
                browserUrl = repo.beginOidcSignIn(url, oidc)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                setupError = "Couldn't reach the identity provider."
                syncProblem = setupError
            } finally {
                setupBusy = false
            }
        }
    }

    fun browserOpened() {
        browserUrl = null
    }

    /** The browser came back to the app's redirect URI. */
    fun handleRedirect(uri: String) {
        setupBusy = true
        setupError = null
        viewModelScope.launch {
            try {
                repo.completeOidcSignIn(uri)
                needsSignIn = false
                syncProblem = null
                loadLocal()
                screen = Screen.Today
            } catch (e: CancellationException) {
                throw e
            } catch (e: SignInException) {
                setupError = e.message
                syncProblem = e.message
            } catch (e: Exception) {
                // Signed in, but the first sync failed (e.g. the connection dropped).
                needsSignIn = repo.needsSignIn
                if (repo.isSignedIn) {
                    loadLocal()
                    screen = Screen.Today
                    syncProblem = "Signed in, but couldn't sync yet."
                } else {
                    setupError = "Sign-in failed: couldn't reach the server."
                }
            } finally {
                setupBusy = false
            }
        }
    }

    fun signOut() {
        viewModelScope.launch {
            repo.signOut()
            games.clear()
            puzzles = null
            setupAuthMode = null
            needsSignIn = false
            syncProblem = null
            screen = Screen.Setup
        }
    }
}
