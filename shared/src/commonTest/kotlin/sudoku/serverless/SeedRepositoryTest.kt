package sudoku.serverless

import kotlinx.coroutines.test.runTest
import kotlinx.datetime.LocalDate
import sudoku.data.AppStorage
import sudoku.data.InMemoryKeyValueStore
import sudoku.game.Game
import sudoku.generator.Generator
import sudoku.generator.Puzzle
import sudoku.generator.WeekSeed
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Clock
import kotlin.time.Instant

class SeedRepositoryTest {
    private class FakeClock(var now: Instant) : Clock {
        override fun now() = now
    }

    // Tuesday 2026-10-27, 14:00 in Auckland.
    private val clock = FakeClock(Instant.parse("2026-10-27T01:00:00Z"))
    private val store = InMemoryKeyValueStore()

    private fun repo() = SeedRepository(store, clock)

    private fun solved(p: Puzzle, ms: Long): Game {
        var g = Game.new(p.givens).resume(0)
        for (i in 0 until 81) if (p.givens[i] == '0') g = g.place(i, p.solution[i] - '0', ms)
        return g
    }

    @Test
    fun aSeedPlaysTheSameWeekAsTheServerWithThatSecret() = runTest {
        val repo = repo()
        assertNull(repo.profile())
        repo.use(SeedSettings("test-secret-0123456789"))
        val week = repo.week()
        assertEquals("2026-W44", week.isoWeek)
        assertEquals(WeekSeed.parse("e4d2e1e00e3549cc"), week.seed)
        assertEquals(LocalDate(2026, 10, 27), repo.today())
        assertEquals(Generator.generateDay(week.seed, 2, 5), repo.puzzles())
        assertEquals("#287caf", repo.profile()?.fingerprint)
    }

    @Test
    fun theSeedSurvivesARestartAndLeavingForgetsIt() = runTest {
        repo().use(SeedSettings("rimu", levels = 3, timezone = "Europe/London"))
        val again = repo()
        assertEquals(SeedSettings("rimu", 3, "Europe/London"), again.profile()?.settings)
        assertEquals(3, again.puzzles().size)
        again.leave()
        assertNull(repo().profile())
    }

    @Test
    fun theDayFollowsTheGroupsTimezone() = runTest {
        val repo = repo()
        repo.use(SeedSettings("rimu", timezone = "America/Los_Angeles"))
        // 01:00 UTC on the 27th is still the 26th in Los Angeles.
        assertEquals(LocalDate(2026, 10, 26), repo.today())
        assertEquals(1, repo.week().dayOfWeek)
    }

    @Test
    fun gamesAndHistoryAreKeptPerSeed() = runTest {
        val repo = repo()
        repo.use(SeedSettings("kauri"))
        val today = repo.today()
        val easy = repo.puzzles().first()
        repo.saveGame(today, 1, Game.new(easy.givens).resume(0).place(easy.givens.indexOf('0'), 1, 10), 10)
        repo.complete(today, 2, solved(repo.puzzles()[1], 95_000))
        assertNotNull(repo.loadGame(today, easy))
        assertEquals(setOf(2), repo.results().keys)

        // Another group's seed: nothing of the first one's shows.
        repo.use(SeedSettings("totara"))
        assertNotEquals(easy, repo.puzzles().first())
        assertNull(repo.loadGame(today, repo.puzzles().first()))
        assertTrue(repo.results().isEmpty())
        assertTrue(repo.history().isEmpty())

        // Back to the first: its game and result are still there.
        repo.use(SeedSettings("kauri"))
        assertNotNull(repo.loadGame(today, easy))
        assertEquals(95_000, repo.results()[2]?.elapsedMs)
    }

    @Test
    fun theFirstResultForAGameCounts() = runTest {
        val repo = repo()
        repo.use(SeedSettings("kauri"))
        val p = repo.puzzles().first()
        val first = repo.complete(repo.today(), 1, solved(p, 120_000))
        val replay = repo.complete(repo.today(), 1, solved(p, 30_000))
        assertEquals(first, replay)
        assertEquals(listOf(120_000L), repo.history().map { it.elapsedMs })
        assertEquals("2026-10-27T01:00:00Z", first.completedAt)
    }

    @Test
    fun historyIsNewestFirstAndOldWeeksGamesArePruned() = runTest {
        val repo = repo()
        repo.use(SeedSettings("kauri", levels = 2))
        val monday = LocalDate(2026, 10, 26)
        val tuesday = repo.today()
        repo.complete(monday, 1, solved(repo.puzzles(monday)[0], 61_000))
        repo.complete(tuesday, 2, solved(repo.puzzles()[1], 62_000))
        repo.complete(tuesday, 1, solved(repo.puzzles()[0], 63_000))
        assertEquals(
            listOf(tuesday to "Easy", tuesday to "Diabolical", monday to "Easy"),
            repo.history().map { it.date to it.title },
        )

        val game = Game.new(repo.puzzles()[0].givens)
        repo.saveGame(tuesday, 1, game, 0)
        clock.now = Instant.parse("2026-11-03T01:00:00Z") // next Tuesday: a new week
        val next = repo.today()
        repo.saveGame(next, 1, Game.new(repo.puzzles()[0].givens), 0)
        assertEquals(setOf("$next/1"), store.values.keys.filter { it.startsWith("seed-games-") }
            .flatMap { key -> Regex("\"(\\d{4}-\\d{2}-\\d{2}/\\d+)\"").findAll(store.values[key]!!).map { it.groupValues[1] } }.toSet())
        // History is kept across weeks.
        assertEquals(3, repo.history().size)
    }

    @Test
    fun summaryListsTheDaysGames() = runTest {
        val repo = repo()
        repo.use(SeedSettings("test-secret-0123456789", levels = 3))
        repo.complete(repo.today(), 1, solved(repo.puzzles()[0], 192_000))
        assertEquals(
            "Sudoku 2026-10-27 #287caf\nEasy 3:12\nHard -\nDiabolical -\nSolved 1/3 in 3:12",
            repo.summary(),
        )
    }

    @Test
    fun serverModeStorageIsUntouched() = runTest {
        val repo = repo()
        repo.use(SeedSettings("kauri"))
        repo.complete(repo.today(), 1, solved(repo.puzzles()[0], 70_000))
        val storage = AppStorage(store)
        assertNull(storage.week.read())
        assertNull(storage.games.read())
        assertNull(storage.pending.value.read())
    }
}
