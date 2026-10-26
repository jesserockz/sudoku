package sudoku.auth

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.Url
import io.ktor.http.content.OutgoingContent
import io.ktor.http.headersOf
import io.ktor.http.parseQueryString
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class OidcTest {
    @Test
    fun sha256MatchesKnownVectors() = runTest {
        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            sha256("abc".encodeToByteArray()).toHex(),
        )
        assertEquals(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            sha256(ByteArray(0)).toHex(),
        )
    }

    @Test
    fun pkceMatchesRfc7636Example() = runTest {
        val pkce = Pkce.fromVerifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", pkce.challenge)
    }

    @Test
    fun randomTokensAreUrlSafeAndDistinct() = runTest {
        val a = randomToken()
        val b = randomToken()
        assertNotEquals(a, b)
        assertEquals(43, a.length) // 32 bytes, unpadded base64url
        assertTrue(a.all { it.isLetterOrDigit() || it == '-' || it == '_' })
        assertEquals(43, Pkce.create().verifier.length)
    }

    private val requests = mutableListOf<HttpRequestData>()

    private fun client(tokenStatus: HttpStatusCode = HttpStatusCode.OK, tokenBody: String = TOKENS) = OidcClient(
        issuer = "https://auth.example.com/application/o/sudoku/",
        clientId = "sudoku-web",
        scopes = listOf("openid", "profile", "offline_access"),
        redirectUri = "https://sudoku.example.com/auth/callback",
        engine = MockEngine { request ->
            requests += request
            val json = headersOf(HttpHeaders.ContentType, "application/json")
            when (request.url.encodedPath) {
                "/application/o/sudoku/.well-known/openid-configuration" -> respond(DISCOVERY, headers = json)
                "/application/o/token/" -> respond(tokenBody, tokenStatus, json)
                else -> respond("", HttpStatusCode.NotFound)
            }
        },
    )

    @Test
    fun authorizationUrlCarriesPkceAndState() = runTest {
        val pkce = Pkce.fromVerifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        val c = client()
        val url = Url(c.authorizationUrl(pkce, state = "s1", nonce = "n1"))
        assertEquals("https://auth.example.com/application/o/authorize/", url.toString().substringBefore('?'))
        val q = url.parameters
        assertEquals("code", q["response_type"])
        assertEquals("sudoku-web", q["client_id"])
        assertEquals("https://sudoku.example.com/auth/callback", q["redirect_uri"])
        assertEquals("openid profile offline_access", q["scope"])
        assertEquals("s1", q["state"])
        assertEquals("n1", q["nonce"])
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", q["code_challenge"])
        assertEquals("S256", q["code_challenge_method"])
        // Discovery is fetched once.
        c.authorizationUrl(pkce, "s2")
        assertEquals(1, requests.size)
    }

    @Test
    fun exchangesCodeWithVerifier() = runTest {
        val tokens = client().exchangeCode("the-code", "the-verifier")
        assertEquals(TokenResponse("at1", "Bearer", 300, "rt1", "id1"), tokens)
        val post = requests.last()
        assertEquals(HttpMethod.Post, post.method)
        val form = parseQueryString((post.body as OutgoingContent.ByteArrayContent).bytes().decodeToString())
        assertEquals("authorization_code", form["grant_type"])
        assertEquals("the-code", form["code"])
        assertEquals("the-verifier", form["code_verifier"])
        assertEquals("sudoku-web", form["client_id"])
        assertEquals("https://sudoku.example.com/auth/callback", form["redirect_uri"])
    }

    @Test
    fun refreshes() = runTest {
        client().refresh("rt1")
        val form = parseQueryString((requests.last().body as OutgoingContent.ByteArrayContent).bytes().decodeToString())
        assertEquals("refresh_token", form["grant_type"])
        assertEquals("rt1", form["refresh_token"])
        assertEquals("sudoku-web", form["client_id"])
    }

    @Test
    fun tokenErrorsAreParsed() = runTest {
        val c = client(HttpStatusCode.BadRequest, """{"error":"invalid_grant","error_description":"expired"}""")
        val e = assertFailsWith<OidcException> { c.refresh("old") }
        assertEquals(400, e.status)
        assertTrue(e.isInvalidGrant)
        val opaque = client(HttpStatusCode.BadGateway, "nope")
        assertEquals(502, assertFailsWith<OidcException> { opaque.refresh("x") }.status)
    }

    @Test
    fun endSessionUrl() = runTest {
        val url = Url(client().endSessionUrl("id1", "https://sudoku.example.com/")!!)
        assertEquals("/application/o/sudoku/end-session/", url.encodedPath)
        assertEquals("id1", url.parameters["id_token_hint"])
        assertEquals("https://sudoku.example.com/", url.parameters["post_logout_redirect_uri"])
    }

    private fun ByteArray.toHex() = joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }

    private companion object {
        // Shaped like Authentik's discovery document.
        const val DISCOVERY = """{
          "issuer": "https://auth.example.com/application/o/sudoku/",
          "authorization_endpoint": "https://auth.example.com/application/o/authorize/",
          "token_endpoint": "https://auth.example.com/application/o/token/",
          "userinfo_endpoint": "https://auth.example.com/application/o/userinfo/",
          "end_session_endpoint": "https://auth.example.com/application/o/sudoku/end-session/",
          "jwks_uri": "https://auth.example.com/application/o/sudoku/jwks/",
          "response_types_supported": ["code"]
        }"""
        const val TOKENS =
            """{"access_token":"at1","token_type":"Bearer","expires_in":300,"refresh_token":"rt1","id_token":"id1","scope":"openid"}"""
    }
}
