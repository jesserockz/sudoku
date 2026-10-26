package sudoku.android

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.OutgoingContent
import io.ktor.http.headersOf
import kotlinx.datetime.LocalDate
import sudoku.api.GameResult
import sudoku.api.SudokuApi
import sudoku.game.GameCalendar
import kotlin.time.Clock
import java.io.IOException

/** An in-memory v1 server behind Ktor's MockEngine, following docs/API.md. */
class FakeServer(private val clock: Clock, val authMode: String = "dev") {
    var online = true
    var rejectAll = false

    // OIDC provider state (authMode = "oidc").
    var oidcSub = "alice"
    var refreshRevoked = false
    var refreshGrants = 0
    private val codes = mutableMapOf<String, String>() // code -> PKCE challenge
    private val accessTokens = mutableMapOf<String, Long>() // token -> expiry (epoch ms)
    private var counter = 0

    /** The provider "redirects" back: returns the redirect URI for an authorization URL. */
    fun authorize(authorizationUrl: String, state: String? = null): String {
        val q = io.ktor.http.Url(authorizationUrl).parameters
        val code = "code${++counter}"
        codes[code] = q["code_challenge"]!!
        return "${q["redirect_uri"]}?code=$code&state=${state ?: q["state"]}"
    }
    val requests = mutableListOf<HttpRequestData>()
    val stored = mutableListOf<GameResult>()
    val seeds = mutableMapOf<String, String>()

    val engine = MockEngine { request ->
        if (!online) throw IOException("offline")
        requests += request
        handle(request)
    }

    private suspend fun MockRequestHandleScope.handle(request: HttpRequestData) = when (request.url.encodedPath) {
        "/api/v1/config" -> json(
            """{"timezone":"Pacific/Auckland","authMode":"$authMode",
            "oidc":{"issuer":"$ISSUER","clientId":"sudoku-android","scopes":["openid","profile","offline_access"]}}""",
        )
        "/o/sudoku/.well-known/openid-configuration" -> json(
            """{"issuer":"$ISSUER","authorization_endpoint":"https://auth.test/o/authorize/",
            "token_endpoint":"https://auth.test/o/token/"}""",
        )
        "/o/token/" -> token(request)
        else -> if (authMode == "oidc" && !authorized(request)) {
            json("""{"error":{"code":"unauthorized","message":"bad token"}}""", HttpStatusCode.Unauthorized)
        } else {
            api(request)
        }
    }

    private fun authorized(request: HttpRequestData): Boolean {
        val token = request.headers["Authorization"]?.removePrefix("Bearer ") ?: return false
        val expiry = accessTokens[token] ?: return false
        return expiry > clock.now().toEpochMilliseconds()
    }

    private fun MockRequestHandleScope.token(request: HttpRequestData): io.ktor.client.request.HttpResponseData {
        val form = io.ktor.http.parseQueryString((request.body as OutgoingContent.ByteArrayContent).bytes().decodeToString())
        when (form["grant_type"]) {
            "authorization_code" -> {
                val challenge = codes.remove(form["code"])
                val digest = java.security.MessageDigest.getInstance("SHA-256").digest(form["code_verifier"]!!.toByteArray())
                val expected = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
                if (challenge == null || challenge != expected || form["client_id"] != "sudoku-android") {
                    return json("""{"error":"invalid_grant"}""", HttpStatusCode.BadRequest)
                }
            }
            "refresh_token" -> {
                refreshGrants++
                if (refreshRevoked) return json("""{"error":"invalid_grant"}""", HttpStatusCode.BadRequest)
            }
            else -> return json("""{"error":"unsupported_grant_type"}""", HttpStatusCode.BadRequest)
        }
        val access = "$oidcSub-at${++counter}"
        accessTokens[access] = clock.now().toEpochMilliseconds() + 300_000
        return json("""{"access_token":"$access","token_type":"Bearer","expires_in":300,"refresh_token":"rt$counter"}""")
    }

    private suspend fun MockRequestHandleScope.api(request: HttpRequestData) = when (request.url.encodedPath) {
        "/api/v1/me" -> if (authMode == "oidc") {
            json("""{"id":"$oidcSub","displayName":"${oidcSub.replaceFirstChar { it.uppercase() }}"}""")
        } else {
            json("""{"id":"1","displayName":"Alice"}""")
        }
        "/api/v1/week" -> {
            val w = GameCalendar.weekAt(clock.now())
            val seed = seeds.getOrPut(w.isoWeek) { if (w.isoWeek.endsWith("44")) "9f2c4a1b7e30d5c8" else "0123456789abcdef" }
            json(
                """{"isoWeek":"${w.isoWeek}","seed":"$seed","weekStart":"${w.weekStart}","weekEnd":"${w.weekEnd}",
                "today":"${w.today}","dayOfWeek":${w.dayOfWeek},"timezone":"Pacific/Auckland"}""",
            )
        }
        "/api/v1/me/results" -> {
            val date = LocalDate.parse(request.url.parameters["date"]!!)
            val items = stored.filter { it.date == date }
                .joinToString(",") { """{"level":${it.level},"elapsedMs":${it.elapsedMs},"completedAt":"${it.completedAt}"}""" }
            json("""{"date":"$date","results":[$items]}""")
        }
        "/api/v1/results" -> {
            check(request.method == HttpMethod.Post)
            val body = (request.body as OutgoingContent.ByteArrayContent).bytes().decodeToString()
            val result = SudokuApi.json.decodeFromString(GameResult.serializer(), body)
            val existing = stored.firstOrNull { it.date == result.date && it.level == result.level }
            when {
                rejectAll -> json("""{"error":{"code":"invalid_result","message":"no"}}""", HttpStatusCode.BadRequest)
                existing != null -> json(SudokuApi.json.encodeToString(GameResult.serializer(), existing), HttpStatusCode.OK)
                else -> {
                    stored += result
                    json(body, HttpStatusCode.Created)
                }
            }
        }
        "/api/v1/leaderboard" -> json(
            """{"date":"${request.url.parameters["date"]}","puzzles":[],"total":{"entries":[]},"players":[]}""",
        )
        else -> json("""{"error":{"code":"not_found","message":""}}""", HttpStatusCode.NotFound)
    }

    private fun MockRequestHandleScope.json(body: String, status: HttpStatusCode = HttpStatusCode.OK) =
        respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))

    companion object {
        const val ISSUER = "https://auth.test/o/sudoku/"
    }

    fun posts() = requests.count { it.url.encodedPath == "/api/v1/results" }
}
