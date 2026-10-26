package sudoku.web

import kotlinx.browser.window
import kotlinx.serialization.Serializable
import org.w3c.dom.url.URLSearchParams
import sudoku.api.AppConfig
import sudoku.api.AuthMode
import sudoku.api.DevAuth
import sudoku.api.OidcConfig
import sudoku.api.TokenProvider
import sudoku.auth.OidcClient
import sudoku.auth.Pkce
import sudoku.auth.StoredTokens
import sudoku.auth.TokenSession
import sudoku.auth.TokenStore
import sudoku.auth.randomToken
import kotlin.time.Clock

/** How the web client signs in. One implementation per server `authMode`. */
interface WebAuth {
    val tokens: TokenProvider

    /** Called once at startup, e.g. to finish a sign-in redirect. Throws [SignInException] on failure. */
    suspend fun initialize() = Unit

    suspend fun isSignedIn(): Boolean

    /**
     * Ends the session. With [everywhere], also ends it at the identity provider
     * (which may navigate away); without, just forgets the local tokens.
     */
    suspend fun signOut(everywhere: Boolean)

    companion object {
        fun forConfig(config: AppConfig): WebAuth = when (config.authMode) {
            AuthMode.DEV -> DevWebAuth()
            AuthMode.OIDC -> {
                val oidc = config.oidc?.takeIf { it.issuer.isNotBlank() && it.clientId.isNotBlank() }
                    ?: throw SignInException("The server's OIDC settings are incomplete (issuer and client id are required).")
                OidcWebAuth(oidc)
            }
        }
    }
}

class SignInException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** Dev auth mode: the user picks an id and name, kept in `localStorage`. */
class DevWebAuth : WebAuth {
    @Serializable
    data class DevUser(val sub: String, val name: String)

    private var user: DevUser? = Storage.get(KEY, DevUser.serializer())

    override val tokens = TokenProvider { user?.let { DevAuth.token(it.sub, it.name) } }

    override suspend fun isSignedIn() = user != null

    fun signIn(sub: String, name: String) {
        DevAuth.token(sub, name) // validates
        user = DevUser(sub, name).also { Storage.set(KEY, DevUser.serializer(), it) }
    }

    override suspend fun signOut(everywhere: Boolean) {
        user = null
        Storage.set(KEY, DevUser.serializer(), null)
    }

    private companion object {
        const val KEY = "devUser"
    }
}

/**
 * OIDC Authorization Code + PKCE in the browser, against the provider named by
 * `/api/v1/config`. [signIn] redirects to the provider, which redirects back to
 * [CALLBACK_PATH]; [initialize] then exchanges the code. Tokens live in
 * `localStorage` and are refreshed by [TokenSession].
 */
class OidcWebAuth(config: OidcConfig) : WebAuth {
    @Serializable
    private data class PendingSignIn(val state: String, val verifier: String, val nonce: String, val createdAtMs: Long)

    private val origin = window.location.origin
    private val client = OidcClient(config.issuer, config.clientId, config.scopes, origin + CALLBACK_PATH)
    private val session = TokenSession(LocalTokenStore(), client::refresh)

    override val tokens: TokenProvider = session

    override suspend fun initialize() {
        if (window.location.pathname != CALLBACK_PATH) return
        val params = URLSearchParams(window.location.search)
        val pending = Storage.get(PENDING_KEY, PendingSignIn.serializer())
        Storage.set(PENDING_KEY, PendingSignIn.serializer(), null)
        // Leave the callback URL whatever happens, so a reload doesn't replay it.
        window.history.replaceState(null, "", "/")

        params.get("error")?.let { error ->
            throw SignInException("Sign-in failed: ${params.get("error_description") ?: error}")
        }
        val code = params.get("code") ?: throw SignInException("Sign-in failed: no authorization code returned.")
        if (pending == null || pending.state != params.get("state")) {
            throw SignInException("Sign-in failed: the response didn't match this browser's request. Please try again.")
        }
        if (Clock.System.now().toEpochMilliseconds() - pending.createdAtMs > PENDING_TTL_MS) {
            throw SignInException("Sign-in took too long. Please try again.")
        }
        try {
            session.signedIn(client.exchangeCode(code, pending.verifier))
        } catch (e: Exception) {
            throw SignInException("Sign-in failed: couldn't get tokens from the identity provider.", e)
        }
    }

    override suspend fun isSignedIn() = session.isSignedIn()

    /** Redirects the browser to the identity provider. */
    suspend fun signIn() {
        val pkce = Pkce.create()
        val pending = PendingSignIn(randomToken(), pkce.verifier, randomToken(), Clock.System.now().toEpochMilliseconds())
        Storage.set(PENDING_KEY, PendingSignIn.serializer(), pending)
        window.location.href = client.authorizationUrl(pkce, pending.state, pending.nonce)
    }

    override suspend fun signOut(everywhere: Boolean) {
        val idToken = session.current()?.idToken
        session.signOut()
        if (everywhere) {
            runCatching { client.endSessionUrl(idToken, "$origin/") }.getOrNull()?.let { window.location.href = it }
        }
    }

    companion object {
        /** Register `<origin>/auth/callback` as the redirect URI in Authentik. */
        const val CALLBACK_PATH = "/auth/callback"
        private const val PENDING_KEY = "oidc.pending"
        private const val PENDING_TTL_MS = 15 * 60 * 1000L
    }
}

private class LocalTokenStore : TokenStore {
    override suspend fun load(): StoredTokens? = Storage.get(KEY, StoredTokens.serializer())

    override suspend fun save(tokens: StoredTokens?) = Storage.set(KEY, StoredTokens.serializer(), tokens)

    private companion object {
        const val KEY = "oidc.tokens"
    }
}
