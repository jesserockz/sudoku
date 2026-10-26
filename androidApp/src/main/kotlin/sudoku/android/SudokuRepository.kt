package sudoku.android

import io.ktor.client.engine.HttpClientEngine
import kotlinx.datetime.LocalDate
import sudoku.api.AppConfig
import sudoku.api.DayResult
import sudoku.api.DevAuth
import sudoku.api.GameResult
import sudoku.api.Leaderboard
import sudoku.api.Me
import sudoku.api.SudokuApi
import sudoku.api.TokenProvider
import sudoku.api.WeekResponse
import sudoku.game.DailyPuzzles
import sudoku.game.Game
import sudoku.game.GameCalendar
import sudoku.generator.Puzzle
import sudoku.sync.FlushReport
import sudoku.sync.ResultSync
import kotlin.time.Clock

/**
 * The Android app's data layer: settings, the cached week, games, the offline
 * result queue and the API. Plain Kotlin over [AppStorage], so it's unit tested
 * on the JVM.
 *
 * Offline rules (PROJECT_PLAN.md): the device keeps exactly one week's seed. With
 * it, every day of that week plays offline; "today" comes from the device clock
 * in Pacific/Auckland. A new week needs a connection. Finished puzzles queue
 * results that upload whenever the server is reachable.
 */
class SudokuRepository(
    private val storage: AppStorage,
    private val defaultServerUrl: String = "",
    private val clock: Clock = Clock.System,
    /** Overrides the HTTP engine (tests use a mock). */
    private val engine: HttpClientEngine? = null,
) {
    private var api: Pair<String, SudokuApi>? = null
    private var puzzleCache: Pair<Pair<Long, LocalDate>, List<Puzzle>>? = null

    val tokens = TokenProvider { settings().devUser?.let { DevAuth.token(it.sub, it.name) } }

    val sync = ResultSync(storage.pending) { api().submitResult(it) }

    fun settings(): Settings = storage.settings.read() ?: Settings(serverUrl = defaultServerUrl)

    val isSignedIn: Boolean get() = settings().let { it.serverUrl.isNotBlank() && it.devUser != null }

    fun today(): LocalDate = GameCalendar.today(clock.now())

    fun me(): Me? = storage.me.read()

    /** The cached week, if it contains [date]. */
    fun weekFor(date: LocalDate = today()): WeekResponse? = storage.week.read()?.takeIf { date in it.toWeekInfo() }

    /** The five puzzles for [date], or `null` if the cached week doesn't cover it. */
    fun puzzles(date: LocalDate = today()): List<Puzzle>? {
        val week = weekFor(date) ?: return null
        val key = week.seed to date
        puzzleCache?.let { (k, v) -> if (k == key) return v }
        return DailyPuzzles.forDate(week.seed, week.toWeekInfo(), date).also { puzzleCache = key to it }
    }

    /** `GET /config` on a server that isn't saved yet (first-run setup). */
    suspend fun fetchConfig(serverUrl: String): AppConfig =
        newApi(normalizeUrl(serverUrl), TokenProvider { null }).use { it.config() }

    /**
     * Saves the server and dev identity, then syncs. If the server can't be
     * reached the previous settings are restored and the error propagates.
     */
    suspend fun signInDev(serverUrl: String, sub: String, name: String) {
        DevAuth.token(sub, name) // validates
        val previous = storage.settings.read()
        storage.settings.write(Settings(normalizeUrl(serverUrl), DevUser(sub, name)))
        api = null
        try {
            refresh()
        } catch (e: Throwable) {
            storage.settings.write(previous)
            api = null
            throw e
        }
    }

    suspend fun signOut() {
        storage.clearUserData()
        api = null
    }

    /**
     * Brings local state up to date with the server: identity, the current week
     * (replacing the cached one), uploads queued results, and today's results.
     * Network and HTTP failures propagate; queued results stay queued.
     */
    suspend fun refresh(): FlushReport {
        val api = api()
        storage.me.write(api.me())
        storeWeek(api.week())
        val report = sync.flush()
        val today = today()
        val mine = api.myResults(today)
        storage.serverResults.write(mapOf(mine.date to mine.results))
        return report
    }

    /** Uploads queued results only (the background worker's job). */
    suspend fun flush(): FlushReport = sync.flush()

    suspend fun pending(): List<GameResult> = sync.pending()

    fun serverResults(date: LocalDate): Map<Int, DayResult> =
        storage.serverResults.read()?.get(date).orEmpty().associateBy { it.level }

    suspend fun leaderboard(date: LocalDate): Leaderboard = api().leaderboard(date)

    /** A saved game for [puzzle] on [date], if it still matches the puzzle. */
    fun loadGame(date: LocalDate, puzzle: Puzzle): Game? =
        storage.games.read()?.get(AppStorage.gameKey(date, puzzle.difficulty.level))
            ?.takeIf { it.givens == puzzle.givens }
            ?.let(Game::restore)

    fun saveGame(date: LocalDate, level: Int, game: Game, nowMs: Long) {
        storage.games.update { it.orEmpty() + (AppStorage.gameKey(date, level) to game.save(nowMs)) }
    }

    /** Queues the result of a just-finished game. */
    suspend fun complete(date: LocalDate, level: Int, game: Game): GameResult {
        val result = GameResult(
            date = date,
            level = level,
            elapsedMs = checkNotNull(game.completedElapsedMs) { "game isn't complete" },
            completedAt = GameCalendar.formatTimestamp(clock.now()),
        )
        sync.enqueue(result)
        return result
    }

    private fun storeWeek(week: WeekResponse) {
        val previous = storage.week.read()
        storage.week.write(week)
        if (previous?.isoWeek != week.isoWeek) {
            // Games from other weeks can't be finished any more; their results (if any) are already queued.
            val info = week.toWeekInfo()
            storage.games.update { games -> games?.filterKeys { LocalDate.parse(it.substringBefore('/')) in info } }
        }
    }

    private fun api(): SudokuApi {
        val url = settings().serverUrl
        check(url.isNotBlank()) { "no server configured" }
        api?.let { (u, a) -> if (u == url) return a }
        return newApi(url, tokens).also { api = url to it }
    }

    private fun newApi(url: String, tokens: TokenProvider) =
        if (engine != null) SudokuApi(url, tokens, engine) else SudokuApi(url, tokens)

    companion object {
        fun normalizeUrl(url: String): String {
            val trimmed = url.trim().trimEnd('/')
            return if ("://" in trimmed) trimmed else "https://$trimmed"
        }
    }
}
