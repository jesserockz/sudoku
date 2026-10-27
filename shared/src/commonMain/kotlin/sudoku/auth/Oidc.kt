package sudoku.auth

import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.request.forms.submitForm
import io.ktor.client.request.get
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.URLBuilder
import io.ktor.http.isSuccess
import io.ktor.http.parameters
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import sudoku.api.SudokuApi
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

/** A PKCE pair (RFC 7636, S256). */
class Pkce private constructor(val verifier: String, val challenge: String) {
    companion object {
        suspend fun create(): Pkce = fromVerifier(randomToken(32))

        suspend fun fromVerifier(verifier: String): Pkce =
            Pkce(verifier, base64Url(sha256(verifier.encodeToByteArray())))
    }
}

/** A URL-safe random string from [bytes] random bytes (for `state`, `nonce` and PKCE verifiers). */
fun randomToken(bytes: Int = 32): String = base64Url(secureRandomBytes(bytes))

@OptIn(ExperimentalEncodingApi::class)
internal fun base64Url(bytes: ByteArray): String =
    Base64.UrlSafe.withPadding(Base64.PaddingOption.ABSENT).encode(bytes)

/** The parts of the provider's `/.well-known/openid-configuration` we use. */
@Serializable
data class OidcDiscovery(
    val issuer: String,
    @SerialName("authorization_endpoint") val authorizationEndpoint: String,
    @SerialName("token_endpoint") val tokenEndpoint: String,
    @SerialName("end_session_endpoint") val endSessionEndpoint: String? = null,
)

@Serializable
data class TokenResponse(
    @SerialName("access_token") val accessToken: String,
    @SerialName("token_type") val tokenType: String = "Bearer",
    @SerialName("expires_in") val expiresIn: Long? = null,
    @SerialName("refresh_token") val refreshToken: String? = null,
    @SerialName("id_token") val idToken: String? = null,
)

@Serializable
private data class ErrorBody(val error: String? = null, @SerialName("error_description") val description: String? = null)

/** A token endpoint error (RFC 6749 section 5.2). */
class OidcException(val status: Int, val error: String?, description: String?) :
    Exception("OIDC error ${error ?: "HTTP $status"}${description?.let { ": $it" } ?: ""}") {
    /** The refresh token or code is no longer valid: sign in again. */
    val isInvalidGrant: Boolean get() = error == "invalid_grant"
}

/**
 * An OAuth 2.0 / OIDC public client using Authorization Code + PKCE, for
 * Authentik (or any compliant provider). It builds the authorization URL and
 * calls the token endpoint; the redirect itself is the platform's job.
 */
class OidcClient(
    val issuer: String,
    val clientId: String,
    val scopes: List<String>,
    val redirectUri: String,
    engine: HttpClientEngine? = null,
) : AutoCloseable {
    private val client = if (engine != null) HttpClient(engine) else HttpClient()
    private var discovery: OidcDiscovery? = null

    suspend fun discover(): OidcDiscovery = discovery ?: run {
        val url = issuer.trimEnd('/') + "/.well-known/openid-configuration"
        val response = client.get(url)
        if (!response.status.isSuccess()) throw OidcException(response.status.value, null, "discovery failed: $url")
        SudokuApi.json.decodeFromString(OidcDiscovery.serializer(), response.bodyAsText()).also { discovery = it }
    }

    suspend fun authorizationUrl(pkce: Pkce, state: String, nonce: String? = null): String {
        val builder = URLBuilder(discover().authorizationEndpoint)
        builder.parameters.apply {
            append("response_type", "code")
            append("client_id", clientId)
            append("redirect_uri", redirectUri)
            append("scope", scopes.joinToString(" "))
            append("state", state)
            append("code_challenge", pkce.challenge)
            append("code_challenge_method", "S256")
            nonce?.let { append("nonce", it) }
        }
        return builder.buildString()
    }

    suspend fun exchangeCode(code: String, verifier: String): TokenResponse = token(
        parameters {
            append("grant_type", "authorization_code")
            append("code", code)
            append("redirect_uri", redirectUri)
            append("client_id", clientId)
            append("code_verifier", verifier)
        },
    )

    suspend fun refresh(refreshToken: String): TokenResponse = token(
        parameters {
            append("grant_type", "refresh_token")
            append("refresh_token", refreshToken)
            append("client_id", clientId)
        },
    )

    /** Where to send the browser to end the provider session, if it supports that. */
    suspend fun endSessionUrl(idToken: String?, postLogoutRedirectUri: String): String? {
        val endpoint = discover().endSessionEndpoint ?: return null
        val builder = URLBuilder(endpoint)
        idToken?.let { builder.parameters.append("id_token_hint", it) }
        builder.parameters.append("post_logout_redirect_uri", postLogoutRedirectUri)
        builder.parameters.append("client_id", clientId)
        return builder.buildString()
    }

    private suspend fun token(form: io.ktor.http.Parameters): TokenResponse {
        val response = client.submitForm(discover().tokenEndpoint, form)
        if (!response.status.isSuccess()) throw response.oidcError()
        return SudokuApi.json.decodeFromString(TokenResponse.serializer(), response.bodyAsText())
    }

    private suspend fun HttpResponse.oidcError(): OidcException {
        val body = runCatching { SudokuApi.json.decodeFromString(ErrorBody.serializer(), bodyAsText()) }.getOrNull()
        return OidcException(status.value, body?.error, body?.description)
    }

    override fun close() = client.close()
}
