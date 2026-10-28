package sudoku.android

import io.ktor.http.Url
import kotlinx.coroutines.test.runTest
import org.junit.Rule
import org.junit.rules.TemporaryFolder
import sudoku.api.OidcConfig
import sudoku.data.SignInException
import sudoku.data.SudokuRepository
import sudoku.game.Game
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Clock
import kotlin.time.Instant

class OidcSignInTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private class FakeClock(var now: Instant) : Clock {
        override fun now() = now
    }

    private val clock = FakeClock(Instant.parse("2026-10-25T20:00:00Z"))
    private val server = FakeServer(clock, authMode = "oidc")
    private val repo by lazy { SudokuRepository(AppStorage(tmp.root), SudokuApp.OIDC_REDIRECT_URI, clock = clock, engine = server.engine) }
    private val url = "http://localhost:8080"

    private suspend fun oidc(): OidcConfig = repo.fetchConfig(url).oidc!!

    private suspend fun signIn() {
        val authUrl = repo.beginOidcSignIn(url, oidc())
        repo.completeOidcSignIn(server.authorize(authUrl))
    }

    private fun advanceMinutes(m: Int) {
        clock.now = Instant.fromEpochMilliseconds(clock.now.toEpochMilliseconds() + m * 60_000L)
    }

    @Test
    fun authorizationUrlUsesPkceAndTheAppRedirect() = runTest {
        val q = Url(repo.beginOidcSignIn(url, oidc())).parameters
        assertEquals("code", q["response_type"])
        assertEquals("sudoku-android", q["client_id"])
        assertEquals(SudokuApp.OIDC_REDIRECT_URI, q["redirect_uri"])
        assertEquals("S256", q["code_challenge_method"])
        assertEquals("openid profile offline_access", q["scope"])
        assertNotNull(q["state"])
    }

    @Test
    fun signInExchangesTheCodeAndSyncs() = runTest {
        assertFalse(repo.isSignedIn)
        signIn()
        assertTrue(repo.isSignedIn)
        assertFalse(repo.needsSignIn)
        assertEquals("Alice", repo.me()?.displayName)
        assertNotNull(repo.puzzles())
        val week = server.requests.last { it.url.encodedPath == "/api/v1/week" }
        assertTrue(week.headers["Authorization"]!!.startsWith("Bearer alice-at"))
    }

    @Test
    fun forgedOrStaleRedirectsAreRejected() = runTest {
        val authUrl = repo.beginOidcSignIn(url, oidc())
        assertFailsWith<SignInException> { repo.completeOidcSignIn(server.authorize(authUrl, state = "forged")) }
        assertFalse(repo.isSignedIn)

        // The pending request is single-use.
        val again = repo.beginOidcSignIn(url, oidc())
        val redirect = server.authorize(again)
        advanceMinutes(16)
        assertFailsWith<SignInException> { repo.completeOidcSignIn(redirect) }
        assertFailsWith<SignInException> { repo.completeOidcSignIn(redirect) }

        assertFailsWith<SignInException> {
            repo.completeOidcSignIn("${SudokuApp.OIDC_REDIRECT_URI}?error=access_denied&error_description=Denied")
        }
        assertFalse(repo.isSignedIn)
    }

    @Test
    fun accessTokensRefreshSilently() = runTest {
        signIn()
        advanceMinutes(10) // past the 5-minute access token lifetime
        repo.refresh()
        assertEquals(1, server.refreshGrants)
        assertFalse(repo.needsSignIn)
    }

    @Test
    fun revokedSessionKeepsOfflinePlayAndQueuedResults() = runTest {
        signIn()
        val p = repo.puzzles()!!.first()
        var g = Game.new(p.givens).resume(0)
        for (i in 0 until 81) if (p.givens[i] == '0') g = g.place(i, p.solution[i] - '0', 90_000)
        repo.complete(repo.today(), 1, g)

        server.refreshRevoked = true
        advanceMinutes(10)
        assertFailsWith<Exception> { repo.refresh() }
        assertTrue(repo.needsSignIn)
        assertTrue(repo.isSignedIn) // still playable offline
        assertNotNull(repo.puzzles())
        assertEquals(1, repo.pending().size)

        // Signing in again uploads the queued result.
        server.refreshRevoked = false
        signIn()
        assertFalse(repo.needsSignIn)
        assertTrue(repo.pending().isEmpty())
        assertEquals(1, server.stored.size)
    }

    @Test
    fun aDifferentAccountStartsFresh() = runTest {
        signIn()
        server.online = false
        val p = repo.puzzles()!!.first()
        var g = Game.new(p.givens).resume(0)
        for (i in 0 until 81) if (p.givens[i] == '0') g = g.place(i, p.solution[i] - '0', 90_000)
        repo.complete(repo.today(), 1, g)
        repo.saveGame(repo.today(), 2, Game.new(repo.puzzles()!![1].givens), 0)

        server.online = true
        server.oidcSub = "bob"
        signIn()
        assertEquals("Bob", repo.me()?.displayName)
        assertTrue(repo.pending().isEmpty())
        assertTrue(server.stored.isEmpty()) // Alice's result was not uploaded as Bob
        assertNull(repo.loadGame(repo.today(), repo.puzzles()!![1]))
    }

    @Test
    fun signOutForgetsTokens() = runTest {
        signIn()
        repo.signOut()
        assertFalse(repo.isSignedIn)
        assertFalse(repo.needsSignIn)
    }
}
