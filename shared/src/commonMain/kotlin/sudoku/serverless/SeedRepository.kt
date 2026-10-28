package sudoku.serverless

import kotlinx.datetime.LocalDate
import kotlinx.datetime.TimeZone
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import sudoku.api.WeekResponse
import sudoku.data.AppStorage
import sudoku.data.KeyValueStore
import sudoku.data.StoredValue
import sudoku.game.Game
import sudoku.game.GameCalendar
import sudoku.game.SavedGame
import sudoku.generator.Generator
import sudoku.generator.Puzzle
import kotlin.time.Clock

/** The seed being played, with its [fingerprint] (see [PlaySeed.fingerprint]) worked out once. */
@Serializable
data class SeedProfile(val settings: SeedSettings, val fingerprint: String)

/** A puzzle solved in serverless play: the local stand-in for a leaderboard entry. */
@Serializable
data class SeedResult(
    val date: LocalDate,
    val level: Int,
    /** The day's game count when it was played, which names the game (e.g. "Medium 2"). */
    val levels: Int,
    val elapsedMs: Long,
    /** When it was solved, as an RFC 3339 instant. */
    val completedAt: String,
) {
    val title: String get() = Generator.title(level, levels)
}

/**
 * Serverless play's data: the active seed, games in progress and the player's
 * history of solve times, in the same [KeyValueStore] as the server mode's
 * [AppStorage]. There is no network: the week comes from [PlaySeed.week].
 *
 * Games and history are kept per seed (keyed by its fingerprint), so switching
 * seeds and back resumes where you were and never mixes two groups' games.
 */
class SeedRepository(private val store: KeyValueStore, private val clock: Clock = Clock.System) {
    private val active = StoredValue(store, "seed", SeedProfile.serializer())
    private var seedCache: Pair<Pair<SeedSettings, String>, Long>? = null
    private var puzzleCache: Pair<Triple<Long, Int, LocalDate>, List<Puzzle>>? = null

    /** The seed being played, or `null` when not in serverless mode. */
    fun profile(): SeedProfile? = active.read()

    /** Starts playing with [settings] (replacing any other seed; its games and history are kept). */
    suspend fun use(settings: SeedSettings): SeedProfile =
        SeedProfile(settings, PlaySeed.fingerprint(settings.seed)).also(active::write)

    /** Stops serverless play. The seed's games and history stay, for if it's entered again. */
    fun leave() = active.write(null)

    fun today(): LocalDate = GameCalendar.today(clock.now(), zone())

    /** The current week for the active seed. */
    suspend fun week(): WeekResponse {
        val settings = requireProfile().settings
        val info = GameCalendar.weekOf(today())
        val key = settings to info.isoWeek
        val seed = seedCache?.takeIf { it.first == key }?.second
            ?: PlaySeed.weekSeed(settings.seed, info.isoWeek).also { seedCache = key to it }
        return PlaySeed.weekResponse(settings, info, seed)
    }

    /** Today's games (or another day's in the current week). */
    suspend fun puzzles(date: LocalDate = today()): List<Puzzle> {
        val week = week()
        val key = Triple(week.seed, week.levels, date)
        puzzleCache?.let { (k, v) -> if (k == key) return v }
        return week.puzzles(date).also { puzzleCache = key to it }
    }

    /** A saved game for [puzzle] on [date], if it still matches the puzzle. */
    fun loadGame(date: LocalDate, puzzle: Puzzle): Game? =
        games().read()?.get(AppStorage.gameKey(date, puzzle.level))
            ?.takeIf { it.givens == puzzle.givens }
            ?.let(Game::restore)

    /** Saves a game, dropping saved games from other weeks: they can't be finished any more. */
    fun saveGame(date: LocalDate, level: Int, game: Game, nowMs: Long) {
        val week = GameCalendar.weekOf(date)
        games().update { saved ->
            saved.orEmpty().filterKeys { LocalDate.parse(it.substringBefore('/')) in week } +
                (AppStorage.gameKey(date, level) to game.save(nowMs))
        }
    }

    /** Records a just-finished game in the history. The first result for a game counts; replays don't. */
    fun complete(date: LocalDate, level: Int, game: Game): SeedResult {
        val profile = requireProfile()
        val result = SeedResult(
            date = date,
            level = level,
            levels = profile.settings.levels,
            elapsedMs = checkNotNull(game.completedElapsedMs) { "game isn't complete" },
            completedAt = clock.now().toString(),
        )
        val history = history(profile)
        val existing = history.read().orEmpty()
            .firstOrNull { it.date == date && it.level == level && it.levels == result.levels }
        if (existing != null) return existing
        history.update { it.orEmpty() + result }
        return result
    }

    /** Every result for the active seed, newest day first. */
    fun history(): List<SeedResult> =
        profile()?.let { history(it).read() }.orEmpty().sortedWith(compareByDescending<SeedResult> { it.date }.thenBy { it.level })

    /** [date]'s results at the active seed's game count, by level. */
    fun results(date: LocalDate = today()): Map<Int, SeedResult> {
        val levels = profile()?.settings?.levels ?: return emptyMap()
        return history().filter { it.date == date && it.levels == levels }.associateBy { it.level }
    }

    /** The "Share results" text for [date]. */
    suspend fun summary(date: LocalDate = today()): String {
        val profile = requireProfile()
        val results = results(date)
        val games = puzzles(date).map { GameTime(it.title, results[it.level]?.elapsedMs) }
        return ResultsSummary.format(date, profile.fingerprint, games)
    }

    private fun zone(): TimeZone = GameCalendar.zone(requireProfile().settings.timezone)

    private fun requireProfile() = checkNotNull(profile()) { "no seed is active" }

    private fun games() = StoredValue(store, "seed-games-${key()}", MapSerializer(String.serializer(), SavedGame.serializer()))

    private fun history(profile: SeedProfile) =
        StoredValue(store, "seed-history-${profile.fingerprint.removePrefix("#")}", ListSerializer(SeedResult.serializer()))

    private fun key() = requireProfile().fingerprint.removePrefix("#")
}
