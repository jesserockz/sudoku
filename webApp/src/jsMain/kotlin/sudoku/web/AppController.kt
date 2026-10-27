package sudoku.web

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
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
import sudoku.api.AuthMode
import sudoku.api.DayResult
import sudoku.api.GameResult
import sudoku.api.Leaderboard
import sudoku.api.Me
import sudoku.api.SudokuApi
import sudoku.api.TokenProvider
import sudoku.api.WeekResponse
import sudoku.game.DailyPuzzles
import sudoku.game.Game
import sudoku.game.GameCalendar
import sudoku.game.SavedGame
import sudoku.game.Ticker
import sudoku.generator.Puzzle
import sudoku.sync.ResultSync
import kotlin.time.Clock

sealed interface Screen {
    data object Today : Screen

    data class Play(val level: Int) : Screen

    data class Scores(val date: LocalDate, val tab: Int) : Screen
}

sealed interface Phase {
    data object Loading : Phase

    /** Couldn't reach the server or load the day. */
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
 * its methods; nothing else talks to the API or storage.
 */
class AppController(private val scope: CoroutineScope, private val authFactory: (AppConfig) -> WebAuth) {
    val ticker: Ticker = Ticker.monotonic()

    var phase by mutableStateOf<Phase>(Phase.Loading)
        private set
    var screen by mutableStateOf<Screen>(Screen.Today)
        private set

    var config by mutableStateOf<AppConfig?>(null)
        private set
    var auth: WebAuth? = null
        private set
    var me by mutableStateOf<Me?>(null)
        private set
    var week by mutableStateOf<WeekResponse?>(null)
        private set
    var puzzles by mutableStateOf<List<Puzzle>>(emptyList())
        private set

    /** Today's results the server already has, by level. */
    val serverResults = mutableStateMapOf<Int, DayResult>()

    /** Today's games started on this device, by level. */
    val games = mutableStateMapOf<Int, Game>()

    /** Levels with a result still waiting to upload. */
    val unsynced = mutableStateMapOf<Int, Long>()

    var leaderboard by mutableStateOf<Leaderboard?>(null)
        private set
    var leaderboardError by mutableStateOf<String?>(null)
        private set

    /** A transient problem worth showing (e.g. results not uploaded yet). */
    var notice by mutableStateOf<String?>(null)
        private set

    private val api = SudokuApi(window.location.origin, TokenProvider { auth?.tokens?.token() })
    private var sync: ResultSync? = null
    private var leaderboardJob: Job? = null

    val today: LocalDate? get() = week?.today

    init {
        start()
        watchDayRollover()
    }

    fun start() {
        phase = Phase.Loading
        scope.launch {
            try {
                val cfg = config ?: api.config().also { config = it }
                val a = auth ?: authFactory(cfg).also { auth = it }
                if (!a.isSignedIn) {
                    phase = Phase.SignIn(cfg)
                    return@launch
                }
                loadDay()
                phase = Phase.Ready
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                if (e.isUnauthorized) signOut() else phase = Phase.Failed(describe(e))
            } catch (e: Throwable) {
                phase = Phase.Failed(describe(e))
            }
        }
    }

    fun signOut() {
        auth?.signOut()
        me = null
        week = null
        sync = null
        games.clear()
        serverResults.clear()
        unsynced.clear()
        screen = Screen.Today
        config?.let { phase = Phase.SignIn(it) } ?: start()
    }

    private suspend fun loadDay() {
        val user = api.me()
        val w = api.week()
        me = user
        week = w
        puzzles = DailyPuzzles.forDate(w.seed, w.toWeekInfo(), w.today)

        val s = ResultSync(LocalPendingResultStore(user.id)) { api.submitResult(it) }
        sync = s

        games.clear()
        for (p in puzzles) {
            Storage.get(gameKey(user.id, w.today, p.difficulty.level), SavedGame.serializer())
                ?.takeIf { it.givens == p.givens }
                ?.let { games[p.difficulty.level] = Game.restore(it) }
        }
        forgetOtherDays(user.id, w.today)

        flushResults()
        refreshServerResults()
    }

    private suspend fun refreshServerResults() {
        val date = today ?: return
        val results = api.myResults(date)
        serverResults.clear()
        if (results.date == date) results.results.forEach { serverResults[it.level] = it }
        unsynced.clear()
        sync?.pending()?.filter { it.date == date }?.forEach { unsynced[it.level] = it.elapsedMs }
    }

    /** Uploads queued results; failures leave them queued and show a notice. */
    private suspend fun flushResults() {
        val s = sync ?: return
        val report = s.flush()
        when {
            report.isUnauthorized -> signOut()
            report.failure != null -> notice = "Couldn't upload ${report.remaining.size} result(s) yet; they'll be retried."
            else -> notice = null
        }
        if (report.rejected.isNotEmpty()) {
            notice = "The server rejected ${report.rejected.size} result(s)."
        }
    }

    fun statusOf(level: Int): PuzzleStatus {
        serverResults[level]?.let { return PuzzleStatus.Done(it.elapsedMs, synced = true) }
        unsynced[level]?.let { return PuzzleStatus.Done(it, synced = false) }
        val game = games[level] ?: return PuzzleStatus.New
        game.completedElapsedMs?.let { return PuzzleStatus.Done(it, synced = false) }
        return PuzzleStatus.InProgress(game.elapsedMs(ticker.nowMs()))
    }

    fun puzzle(level: Int): Puzzle? = puzzles.firstOrNull { it.difficulty.level == level }

    // Navigation

    fun openToday() {
        screen = Screen.Today
        // The day may have rolled over while a puzzle was open.
        if (week != null && GameCalendar.today() != today) reload()
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

    fun openScores(tab: Int = 0, date: LocalDate? = null) {
        val d = date ?: today ?: return
        screen = Screen.Scores(d, tab)
        loadLeaderboard(d)
    }

    fun showScoresTab(tab: Int) {
        (screen as? Screen.Scores)?.let { screen = it.copy(tab = tab) }
    }

    /** Moves the leaderboard by [days], within the server's 8-day result window. */
    fun shiftScoresDate(days: Int) {
        val current = screen as? Screen.Scores ?: return
        val t = today ?: return
        val next = if (days >= 0) current.date.plus(DatePeriod(days = days)) else current.date.minus(DatePeriod(days = -days))
        if (next > t || next < t.minus(DatePeriod(days = 8))) return
        openScores(current.tab, next)
    }

    private fun loadLeaderboard(date: LocalDate) {
        leaderboardJob?.cancel()
        leaderboard = null
        leaderboardError = null
        leaderboardJob = scope.launch {
            try {
                leaderboard = api.leaderboard(date)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                if (e.isUnauthorized) signOut() else leaderboardError = describe(e)
            } catch (e: Throwable) {
                leaderboardError = describe(e)
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
        save(level, after)
        if (after.isComplete && !before.isComplete) complete(level, after)
    }

    fun save(level: Int, game: Game) {
        val user = me ?: return
        val date = today ?: return
        Storage.set(gameKey(user.id, date, level), SavedGame.serializer(), game.save(ticker.nowMs()))
    }

    private fun complete(level: Int, game: Game) {
        val date = today ?: return
        val result = GameResult(
            date = date,
            level = level,
            elapsedMs = game.completedElapsedMs ?: return,
            completedAt = GameCalendar.formatTimestamp(Clock.System.now()),
        )
        unsynced[level] = result.elapsedMs
        scope.launch {
            sync?.enqueue(result)
            runCatching {
                flushResults()
                refreshServerResults()
            }.onFailure { if (it is CancellationException) throw it }
        }
    }

    // Lifecycle

    fun reload() {
        screen = Screen.Today
        start()
    }

    /** Retries queued uploads, e.g. when the browser comes back online. */
    fun retryUploads() {
        if (phase != Phase.Ready) return
        scope.launch {
            runCatching {
                flushResults()
                refreshServerResults()
            }.onFailure { if (it is CancellationException) throw it }
        }
    }

    private fun watchDayRollover() {
        scope.launch {
            while (true) {
                delay(30_000)
                val t = today ?: continue
                // Don't pull the board out from under someone mid-puzzle; openToday() catches up.
                if (phase == Phase.Ready && screen !is Screen.Play && GameCalendar.today() != t) reload()
            }
        }
    }

    private fun gameKey(userId: String, date: LocalDate, level: Int) = "game.$userId.$date.$level"

    /** Drops saved games from earlier days: they can't be finished any more. */
    private fun forgetOtherDays(userId: String, date: LocalDate) {
        val keep = "game.$userId.$date."
        Storage.keys("game.$userId.").filterNot { it.startsWith(keep) }.forEach { Storage.setString(it, null) }
    }

    private fun describe(e: Throwable): String = when (e) {
        is ApiException -> e.error?.message?.takeIf { it.isNotBlank() } ?: "Server error (HTTP ${e.status})"
        else -> "Can't reach the server. Check your connection and try again."
    }

    companion object {
        fun defaultAuth(config: AppConfig): WebAuth = when (config.authMode) {
            AuthMode.DEV -> DevWebAuth()
            AuthMode.OIDC -> UnsupportedAuth
        }
    }
}

/** Placeholder until OIDC sign-in lands: never signed in. */
object UnsupportedAuth : WebAuth {
    override val isSignedIn = false
    override val tokens = TokenProvider { null }

    override fun signOut() = Unit
}
