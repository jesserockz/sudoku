package sudoku.android

import kotlinx.coroutines.test.runTest
import kotlinx.datetime.LocalDate
import org.junit.Rule
import org.junit.rules.TemporaryFolder
import sudoku.data.SudokuRepository
import sudoku.game.Game
import sudoku.generator.Generator
import sudoku.generator.WeekSeed
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Clock
import kotlin.time.Instant

class SudokuRepositoryTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private class FakeClock(var now: Instant) : Clock {
        override fun now() = now
    }

    // Monday 2026-10-26, 09:00 in Auckland (NZDT, +13).
    private val clock = FakeClock(Instant.parse("2026-10-25T20:00:00Z"))
    private val server = FakeServer(clock)

    private fun repo() = SudokuRepository(AppStorage(tmp.root), SudokuApp.OIDC_REDIRECT_URI, clock = clock, engine = server.engine)

    private fun advanceDays(days: Int) {
        clock.now = Instant.fromEpochMilliseconds(clock.now.toEpochMilliseconds() + days * 86_400_000L)
    }

    /** Plays [level] to completion by filling in the solution. */
    private fun solved(repo: SudokuRepository, level: Int): Game {
        val p = repo.puzzles()!!.first { it.level == level }
        var g = Game.new(p.givens).resume(0)
        for (i in 0 until 81) if (p.givens[i] == '0') g = g.place(i, p.solution[i] - '0', 60_000)
        assertTrue(g.isComplete)
        return g
    }

    @Test
    fun signInFetchesTheWeekAndPuzzlesPlayOffline() = runTest {
        val repo = repo()
        assertFalse(repo.isSignedIn)
        assertNull(repo.puzzles())
        repo.signInDev("http://localhost:8080/", "alice", "Alice")
        assertTrue(repo.isSignedIn)
        assertEquals("http://localhost:8080", repo.settings().serverUrl)
        assertEquals("Alice", repo.me()?.displayName)

        val puzzles = repo.puzzles()!!
        assertEquals(5, puzzles.size)
        assertEquals(Generator.generate(WeekSeed.parse("9f2c4a1b7e30d5c8"), 1, 1).givens, puzzles[0].givens)

        // Offline, a fresh repository on the same storage still has the week.
        server.online = false
        val offline = repo()
        assertTrue(offline.isSignedIn)
        assertEquals(puzzles.map { it.givens }, offline.puzzles()!!.map { it.givens })
        assertFailsWith<Exception> { offline.refresh() }
    }

    @Test
    fun laterDaysOfTheWeekPlayOfflineButNotTheNextWeek() = runTest {
        val repo = repo()
        repo.signInDev("http://localhost:8080", "alice", "Alice")
        server.online = false

        advanceDays(3) // Thursday
        assertEquals(LocalDate(2026, 10, 29), repo.today())
        assertEquals(Generator.generate(WeekSeed.parse("9f2c4a1b7e30d5c8"), 4, 2).givens, repo.puzzles()!![1].givens)

        advanceDays(4) // next Monday: the seed for W45 hasn't been fetched
        assertNull(repo.weekFor())
        assertNull(repo.puzzles())

        server.online = true
        repo.refresh()
        assertEquals("2026-W45", repo.weekFor()?.isoWeek)
        assertEquals(Generator.generate(WeekSeed.parse("0123456789abcdef"), 1, 1).givens, repo.puzzles()!![0].givens)
    }

    @Test
    fun resultsQueueOfflineAndUploadLater() = runTest {
        val repo = repo()
        repo.signInDev("http://localhost:8080", "alice", "Alice")
        server.online = false

        val game = solved(repo, 1)
        val result = repo.complete(repo.today(), 1, game)
        assertEquals(LocalDate(2026, 10, 26), result.date)
        assertEquals(60_000, result.elapsedMs)
        assertEquals("2026-10-26T09:00:00+13:00", result.completedAt)
        assertEquals(listOf(result), repo.pending())

        val offlineFlush = repo.flush()
        assertEquals(listOf(result), offlineFlush.remaining)

        // The day rolls over before the connection returns: the result keeps its date.
        advanceDays(1)
        server.online = true
        val report = repo.refresh()
        assertEquals(listOf(result), report.accepted)
        assertTrue(repo.pending().isEmpty())
        assertEquals(listOf(result), server.stored)
    }

    @Test
    fun weeksWithMoreGamesSpreadTheTiers() = runTest {
        server.levels = 7
        val repo = repo()
        repo.signInDev("http://localhost:8080", "alice", "Alice")
        val puzzles = repo.puzzles()!!
        assertEquals((1..7).toList(), puzzles.map { it.level })
        assertEquals(
            listOf("Easy", "Medium 1", "Medium 2", "Hard", "Expert 1", "Expert 2", "Diabolical"),
            puzzles.map { it.title },
        )
        assertEquals(Generator.generateDay(WeekSeed.parse("9f2c4a1b7e30d5c8"), 1, 7).map { it.givens }, puzzles.map { it.givens })
        // The count is cached with the week, so offline play keeps it.
        server.online = false
        assertEquals(7, repo().puzzles()!!.size)
        val result = repo.complete(repo.today(), 6, solved(repo, 6))
        assertEquals(6, result.level)
    }

    @Test
    fun rejectedResultsAreDropped() = runTest {
        val repo = repo()
        repo.signInDev("http://localhost:8080", "alice", "Alice")
        server.rejectAll = true
        repo.complete(repo.today(), 2, solved(repo, 2))
        val report = repo.flush()
        assertEquals(1, report.rejected.size)
        assertTrue(repo.pending().isEmpty())
        repo.flush()
        assertEquals(1, server.posts())
    }

    @Test
    fun serverResultsAreCachedForOfflineDisplay() = runTest {
        val repo = repo()
        repo.signInDev("http://localhost:8080", "alice", "Alice")
        repo.complete(repo.today(), 3, solved(repo, 3))
        repo.refresh()
        server.online = false
        assertEquals(setOf(3), repo().serverResults(repo.today()).keys)
    }

    @Test
    fun gamesPersistAndOtherWeeksArePruned() = runTest {
        val repo = repo()
        repo.signInDev("http://localhost:8080", "alice", "Alice")
        val p = repo.puzzles()!![0]
        val firstEmpty = p.givens.indexOf('0')
        val game = Game.new(p.givens).resume(0).place(firstEmpty, p.solution[firstEmpty] - '0', 1_000).toggleNote(p.givens.indexOf('0', firstEmpty + 1), 5)
        repo.saveGame(repo.today(), 1, game, nowMs = 4_000)

        val restored = repo().loadGame(repo.today(), p)!!
        assertEquals(game.board, restored.board)
        assertEquals(game.notes, restored.notes)
        assertEquals(4_000, restored.elapsedMs(0))
        assertFalse(restored.timer.isRunning)

        // A saved game for a different puzzle (e.g. a changed seed) is ignored.
        assertNull(repo.loadGame(repo.today(), repo.puzzles()!![1].copy(level = p.level)))

        advanceDays(7)
        repo.refresh()
        assertNull(repo.loadGame(LocalDate(2026, 10, 26), p))
    }

    @Test
    fun failedSignInRestoresPreviousSettings() = runTest {
        val repo = repo()
        server.online = false
        assertFailsWith<Exception> { repo.signInDev("http://localhost:8080", "alice", "Alice") }
        assertFalse(repo.isSignedIn)
        assertFailsWith<IllegalArgumentException> { repo.signInDev("http://localhost:8080", "a:b", "x") }
    }

    @Test
    fun signOutForgetsUserDataButKeepsTheServer() = runTest {
        val repo = repo()
        repo.signInDev("http://localhost:8080", "alice", "Alice")
        server.online = false
        repo.complete(repo.today(), 1, solved(repo, 1))
        repo.signOut()
        assertFalse(repo.isSignedIn)
        assertNull(repo.me())
        assertTrue(repo.pending().isEmpty())
        assertEquals("http://localhost:8080", repo.settings().serverUrl)
    }

    @Test
    fun fetchConfigAndUrlNormalisation() = runTest {
        assertEquals(sudoku.api.AuthMode.DEV, repo().fetchConfig("localhost:8080").authMode)
        assertEquals("https://sudoku.example.com", SudokuRepository.normalizeUrl(" sudoku.example.com/ "))
        assertEquals("http://10.0.2.2:8080", SudokuRepository.normalizeUrl("http://10.0.2.2:8080/"))
    }

    @Test
    fun devTokenIsSent() = runTest {
        repo().signInDev("http://localhost:8080", "alice", "Alice")
        val me = server.requests.first { it.url.encodedPath == "/api/v1/me" }
        assertEquals("Bearer dev:alice:Alice", me.headers["Authorization"])
        assertNotNull(server.requests.firstOrNull { it.url.encodedPath == "/api/v1/me/results" })
    }
}
