package sudoku.auth

import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Clock
import kotlin.time.Instant

class TokenSessionTest {
    private class FakeClock(var nowMs: Long) : Clock {
        override fun now() = Instant.fromEpochMilliseconds(nowMs)
    }

    private val clock = FakeClock(1_000_000)
    private val store = InMemoryTokenStore()
    private val refreshed = mutableListOf<String>()
    private var refreshResult: () -> TokenResponse = { TokenResponse("at2", expiresIn = 300) }

    private val session = TokenSession(store, { refreshed += it; refreshResult() }, clock)

    @Test
    fun signInStoresTokensWithExpiry() = runTest {
        assertFalse(session.isSignedIn())
        assertNull(session.token())
        session.signedIn(TokenResponse("at1", expiresIn = 300, refreshToken = "rt1", idToken = "id1"))
        assertEquals(StoredTokens("at1", "rt1", "id1", 1_300_000), store.load())
        assertTrue(session.isSignedIn())
        assertEquals("at1", session.token())
        assertTrue(refreshed.isEmpty())
    }

    @Test
    fun refreshesShortlyBeforeExpiryKeepingTheRefreshToken() = runTest {
        session.signedIn(TokenResponse("at1", expiresIn = 300, refreshToken = "rt1", idToken = "id1"))
        clock.nowMs += 241_000 // 59s left, inside the 60s margin
        assertEquals("at2", session.token())
        assertEquals(listOf("rt1"), refreshed)
        assertEquals(StoredTokens("at2", "rt1", "id1", clock.nowMs + 300_000), store.load())
        assertEquals("at2", session.token())
        assertEquals(1, refreshed.size)
    }

    @Test
    fun rotatedRefreshTokenReplacesTheOldOne() = runTest {
        refreshResult = { TokenResponse("at2", expiresIn = 300, refreshToken = "rt2") }
        session.signedIn(TokenResponse("at1", expiresIn = 1, refreshToken = "rt1"))
        session.token()
        assertEquals("rt2", store.load()?.refreshToken)
    }

    @Test
    fun invalidGrantEndsTheSession() = runTest {
        refreshResult = { throw OidcException(400, "invalid_grant", "revoked") }
        session.signedIn(TokenResponse("at1", expiresIn = 1, refreshToken = "rt1"))
        clock.nowMs += 5_000
        assertNull(session.token())
        assertFalse(session.isSignedIn())
    }

    @Test
    fun networkFailureKeepsTheOldToken() = runTest {
        refreshResult = { throw RuntimeException("offline") }
        session.signedIn(TokenResponse("at1", expiresIn = 30, refreshToken = "rt1"))
        assertEquals("at1", session.token())
        assertTrue(session.isSignedIn())
        refreshResult = { throw OidcException(503, null, null) }
        assertEquals("at1", session.token())
        assertTrue(session.isSignedIn())
    }

    @Test
    fun withoutRefreshTokenExpiryEndsTheSession() = runTest {
        session.signedIn(TokenResponse("at1", expiresIn = 300))
        clock.nowMs += 250_000
        assertEquals("at1", session.token()) // still valid, nothing to refresh with
        clock.nowMs += 60_000
        assertNull(session.token())
        assertFalse(session.isSignedIn())
    }

    @Test
    fun tokensWithoutExpiryAreUsedAsIs() = runTest {
        session.signedIn(TokenResponse("at1", refreshToken = "rt1"))
        clock.nowMs += 10_000_000
        assertEquals("at1", session.token())
        assertTrue(refreshed.isEmpty())
    }

    @Test
    fun invalidateForcesRefresh() = runTest {
        session.signedIn(TokenResponse("at1", expiresIn = 300, refreshToken = "rt1"))
        session.invalidateAccessToken()
        assertEquals("at2", session.token())
        assertEquals(listOf("rt1"), refreshed)
    }

    @Test
    fun signOutClears() = runTest {
        session.signedIn(TokenResponse("at1"))
        session.signOut()
        assertNull(store.load())
    }
}
