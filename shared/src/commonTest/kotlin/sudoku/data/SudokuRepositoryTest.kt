package sudoku.data

import io.ktor.http.Url
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.LocalDate
import sudoku.api.AuthMode
import sudoku.api.OidcConfig
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
    private class FakeClock(var now: Instant) : Clock {
        override fun now() = now
    }

    // Monday 2026-10-26, 09:00 in Auckland (NZDT, +13).
    private val clock = FakeClock(Instant.parse("2026-10-25T20:00:00Z"))
    private val store = InMemoryKeyValueStore()
    private var server = FakeServer(clock)
    private val url = "http://localhost:8080"

    /** A repository over the same storage, as after an app restart. */
    private fun repo() = SudokuRepository(AppStorage(store), REDIRECT, clock = clock, engine = server.engine)

    private fun advanceMinutes(minutes: Int) {
        clock.now = Instant.fromEpochMilliseconds(clock.now.toEpochMilliseconds() + minutes * 60_000L)
    }

    private fun advanceDays(days: Int) = advanceMinutes(days * 24 * 60)

    /** Plays [level] to completion by filling in the solution. */
    private fun solved(repo: SudokuRepository, level: Int): Game {
        val p = repo.puzzles()!!.first { it.level == level }
        var g = Game.new(p.givens).resume(0)
        for (i in 0 until 81) if (p.givens[i] == '0') g = g.place(i, p.solution[i] - '0', 60_000)
        assertTrue(g.isComplete)
        return g
    }

    private suspend fun signInOidc(repo: SudokuRepository) {
        val oidc = repo.fetchConfig(url).oidc!!
        repo.completeOidcSignIn(server.authorize(repo.beginOidcSignIn(url, oidc)))
    }

    @Test
    fun signInFetchesTheWeekAndPuzzlesPlayOffline() = runTest {
        val repo = repo()
        assertFalse(repo.isSignedIn)
        assertNull(repo.puzzles())
        repo.signInDev("$url/", "alice", "Alice")
        assertTrue(repo.isSignedIn)
        assertEquals(url, repo.settings().serverUrl)
        assertEquals("Alice", repo.me()?.displayName)

        val puzzles = repo.puzzles()!!
        assertEquals(5, puzzles.size)
        assertEquals(Generator.generate(WeekSeed.parse(FakeServer.SEED_W44), 1, 1).givens, puzzles[0].givens)

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
        repo.signInDev(url, "alice", "Alice")
        server.online = false

        advanceDays(3) // Thursday
        assertEquals(LocalDate(2026, 10, 29), repo.today())
        assertEquals(Generator.generate(WeekSeed.parse(FakeServer.SEED_W44), 4, 2).givens, repo.puzzles()!![1].givens)

        advanceDays(4) // next Monday: the seed for W45 hasn't been fetched
        assertNull(repo.weekFor())
        assertNull(repo.puzzles())

        server.online = true
        repo.refresh()
        assertEquals("2026-W45", repo.weekFor()?.isoWeek)
        assertEquals(Generator.generate(WeekSeed.parse(FakeServer.SEED_OTHER), 1, 1).givens, repo.puzzles()!![0].givens)
    }

    @Test
    fun resultsQueueOfflineAndUploadLater() = runTest {
        val repo = repo()
        repo.signInDev(url, "alice", "Alice")
        server.online = false

        val result = repo.complete(repo.today(), 1, solved(repo, 1))
        assertEquals(LocalDate(2026, 10, 26), result.date)
        assertEquals(60_000, result.elapsedMs)
        assertEquals("2026-10-26T09:00:00+13:00", result.completedAt)
        assertEquals(listOf(result), repo().pending())
        assertEquals(listOf(result), repo.flush().remaining)

        // The day rolls over before the connection returns: the result keeps its date.
        advanceDays(1)
        server.online = true
        val report = repo().refresh()
        assertEquals(listOf(result), report.accepted)
        assertTrue(repo.pending().isEmpty())
        assertEquals(listOf(result), server.stored)
    }

    @Test
    fun weeksWithMoreGamesSpreadTheTiers() = runTest {
        server.levels = 7
        val repo = repo()
        repo.signInDev(url, "alice", "Alice")
        val puzzles = repo.puzzles()!!
        assertEquals((1..7).toList(), puzzles.map { it.level })
        assertEquals(
            Generator.generateDay(WeekSeed.parse(FakeServer.SEED_W44), 1, 7).map { it.givens },
            puzzles.map { it.givens },
        )
        // The count is cached with the week, so offline play keeps it.
        server.online = false
        assertEquals(7, repo().puzzles()!!.size)
        assertEquals(6, repo.complete(repo.today(), 6, solved(repo, 6)).level)
    }

    @Test
    fun rejectedResultsAreDropped() = runTest {
        val repo = repo()
        repo.signInDev(url, "alice", "Alice")
        server.rejectAll = true
        repo.complete(repo.today(), 2, solved(repo, 2))
        assertEquals(1, repo.flush().rejected.size)
        assertTrue(repo.pending().isEmpty())
        repo.flush()
        assertEquals(1, server.posts())
    }

    @Test
    fun serverResultsAreCachedForOfflineDisplay() = runTest {
        val repo = repo()
        repo.signInDev(url, "alice", "Alice")
        repo.complete(repo.today(), 3, solved(repo, 3))
        repo.refresh()
        server.online = false
        assertEquals(setOf(3), repo().serverResults(repo.today()).keys)
    }

    @Test
    fun gamesPersistAndOtherWeeksArePruned() = runTest {
        val repo = repo()
        repo.signInDev(url, "alice", "Alice")
        val p = repo.puzzles()!![0]
        val firstEmpty = p.givens.indexOf('0')
        val game = Game.new(p.givens).resume(0).place(firstEmpty, p.solution[firstEmpty] - '0', 1_000)
            .toggleNote(p.givens.indexOf('0', firstEmpty + 1), 5)
        repo.saveGame(repo.today(), 1, game, nowMs = 4_000)

        val restored = repo().loadGame(repo.today(), p)!!
        assertEquals(game.board, restored.board)
        assertEquals(game.notes, restored.notes)
        assertEquals(4_000, restored.elapsedMs(0))
        assertFalse(restored.timer.isRunning)

        // A saved game for a different puzzle (e.g. a changed seed) is ignored.
        assertNull(repo.loadGame(repo.today(), repo.puzzles()!![1].copy(level = p.level)))

        // The same week's sync keeps it; the next week's drops it.
        repo.refresh()
        assertNotNull(repo.loadGame(repo.today(), p))
        advanceDays(7)
        repo.refresh()
        assertNull(repo.loadGame(LocalDate(2026, 10, 26), p))
    }

    @Test
    fun failedSignInRestoresPreviousSettings() = runTest {
        val repo = repo()
        server.online = false
        assertFailsWith<Exception> { repo.signInDev(url, "alice", "Alice") }
        assertFalse(repo.isSignedIn)
        assertFailsWith<IllegalArgumentException> { repo.signInDev(url, "a:b", "x") }
    }

    @Test
    fun signOutForgetsUserDataButKeepsTheServer() = runTest {
        val repo = repo()
        repo.signInDev(url, "alice", "Alice")
        server.online = false
        repo.complete(repo.today(), 1, solved(repo, 1))
        repo.signOut()
        assertFalse(repo.isSignedIn)
        assertNull(repo.me())
        assertTrue(repo.pending().isEmpty())
        assertEquals(url, repo.settings().serverUrl)
    }

    @Test
    fun configDevTokenAndUrlNormalisation() = runTest {
        assertEquals(AuthMode.DEV, repo().fetchConfig("localhost:8080").authMode)
        repo().signInDev(url, "alice", "Alice")
        val me = server.requests.first { it.url.encodedPath == "/api/v1/me" }
        assertEquals("Bearer dev:alice:Alice", me.headers["Authorization"])
        assertEquals("https://sudoku.example.com", SudokuRepository.normalizeUrl(" sudoku.example.com/ "))
        assertEquals("http://10.0.2.2:8080", SudokuRepository.normalizeUrl("http://10.0.2.2:8080/"))
    }

    @Test
    fun oidcSignInUsesPkceAndTheGivenRedirect() = runTest {
        server = FakeServer(clock, authMode = "oidc")
        val repo = repo()
        val q = Url(repo.beginOidcSignIn(url, OidcConfig(FakeServer.ISSUER, "sudoku", listOf("openid")))).parameters
        assertEquals(REDIRECT, q["redirect_uri"])
        assertEquals("S256", q["code_challenge_method"])

        signInOidc(repo)
        assertTrue(repo.isSignedIn)
        assertFalse(repo.needsSignIn)
        assertEquals("Alice", repo.me()?.displayName)
        assertNotNull(repo.puzzles())
        assertTrue(server.requests.last { it.url.encodedPath == "/api/v1/week" }.headers["Authorization"]!!.startsWith("Bearer alice-at"))
    }

    @Test
    fun forgedOrStaleRedirectsAreRejected() = runTest {
        server = FakeServer(clock, authMode = "oidc")
        val repo = repo()
        val oidc = repo.fetchConfig(url).oidc!!
        assertFailsWith<SignInException> {
            repo.completeOidcSignIn(server.authorize(repo.beginOidcSignIn(url, oidc), state = "forged"))
        }
        val redirect = server.authorize(repo.beginOidcSignIn(url, oidc))
        advanceMinutes(16)
        assertFailsWith<SignInException> { repo.completeOidcSignIn(redirect) }
        assertFailsWith<SignInException> { repo.completeOidcSignIn("$REDIRECT?error=access_denied") }
        assertFalse(repo.isSignedIn)
    }

    @Test
    fun revokedSessionKeepsOfflinePlayAndQueuedResults() = runTest {
        server = FakeServer(clock, authMode = "oidc")
        val repo = repo()
        signInOidc(repo)
        repo.complete(repo.today(), 1, solved(repo, 1))

        server.refreshRevoked = true
        advanceMinutes(10) // past the 5-minute access token lifetime
        assertFailsWith<Exception> { repo.refresh() }
        assertTrue(repo.needsSignIn)
        assertTrue(repo.isSignedIn)
        assertNotNull(repo.puzzles())
        assertEquals(1, repo.pending().size)

        server.refreshRevoked = false
        signInOidc(repo)
        assertFalse(repo.needsSignIn)
        assertTrue(repo.pending().isEmpty())
        assertEquals(1, server.stored.size)
    }

    @Test
    fun aDifferentAccountStartsFresh() = runTest {
        server = FakeServer(clock, authMode = "oidc")
        val repo = repo()
        signInOidc(repo)
        server.online = false
        repo.complete(repo.today(), 1, solved(repo, 1))
        repo.saveGame(repo.today(), 2, Game.new(repo.puzzles()!![1].givens), 0)

        server.online = true
        server.oidcSub = "bob"
        signInOidc(repo)
        assertEquals("Bob", repo.me()?.displayName)
        assertTrue(repo.pending().isEmpty())
        assertTrue(server.stored.isEmpty()) // Alice's result was not uploaded as Bob
        assertNull(repo.loadGame(repo.today(), repo.puzzles()!![1]))
    }

    private companion object {
        const val REDIRECT = "https://sudoku.test/auth/callback"
    }
}
