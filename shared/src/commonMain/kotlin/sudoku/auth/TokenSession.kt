package sudoku.auth

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import sudoku.api.TokenProvider
import kotlin.time.Clock

/** Tokens kept between launches. [expiresAtEpochMs] is when the access token expires. */
@Serializable
data class StoredTokens(
    val accessToken: String,
    val refreshToken: String? = null,
    val idToken: String? = null,
    val expiresAtEpochMs: Long? = null,
)

/** Durable storage for [StoredTokens]. */
interface TokenStore {
    suspend fun load(): StoredTokens?

    suspend fun save(tokens: StoredTokens?)
}

class InMemoryTokenStore(private var tokens: StoredTokens? = null) : TokenStore {
    override suspend fun load() = tokens

    override suspend fun save(tokens: StoredTokens?) {
        this.tokens = tokens
    }
}

/**
 * Keeps a signed-in session's tokens fresh. [token] returns a usable access
 * token, refreshing it first when it expires within [refreshMarginMs]. When
 * refresh is impossible (no refresh token, or the provider says `invalid_grant`)
 * the session ends and [token] returns `null`. Other refresh failures (offline)
 * return the old token so the API can decide.
 */
class TokenSession(
    private val store: TokenStore,
    private val refresh: suspend (refreshToken: String) -> TokenResponse,
    private val clock: Clock = Clock.System,
    private val refreshMarginMs: Long = 60_000,
) : TokenProvider {
    private val mutex = Mutex()

    suspend fun isSignedIn(): Boolean = store.load() != null

    suspend fun current(): StoredTokens? = store.load()

    /** Stores the result of a code exchange (or any token response). */
    suspend fun signedIn(response: TokenResponse) = mutex.withLock {
        store.save(response.toStored(previous = null))
    }

    suspend fun signOut() = mutex.withLock { store.save(null) }

    override suspend fun token(): String? = mutex.withLock {
        val tokens = store.load() ?: return@withLock null
        val expiresAt = tokens.expiresAtEpochMs
        val now = clock.now().toEpochMilliseconds()
        if (expiresAt == null || expiresAt - refreshMarginMs > now) return@withLock tokens.accessToken

        val refreshToken = tokens.refreshToken
        if (refreshToken == null) {
            if (expiresAt > now) return@withLock tokens.accessToken
            store.save(null)
            return@withLock null
        }
        try {
            val refreshed = refresh(refreshToken).toStored(previous = tokens)
            store.save(refreshed)
            refreshed.accessToken
        } catch (e: CancellationException) {
            throw e
        } catch (e: OidcException) {
            if (e.isInvalidGrant || e.status in 400..499) {
                store.save(null)
                null
            } else {
                tokens.accessToken
            }
        } catch (e: Throwable) {
            tokens.accessToken
        }
    }

    /** Forces the next [token] call to refresh, e.g. after the API answered `401`. */
    suspend fun invalidateAccessToken() = mutex.withLock {
        store.load()?.let { store.save(it.copy(expiresAtEpochMs = 0)) }
    }

    private fun TokenResponse.toStored(previous: StoredTokens?) = StoredTokens(
        accessToken = accessToken,
        // Providers may omit the refresh token on refresh, meaning "keep using the old one".
        refreshToken = refreshToken ?: previous?.refreshToken,
        idToken = idToken ?: previous?.idToken,
        expiresAtEpochMs = expiresIn?.let { clock.now().toEpochMilliseconds() + it * 1000 },
    )
}
