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
    val requests = mutableListOf<HttpRequestData>()
    val stored = mutableListOf<GameResult>()
    val seeds = mutableMapOf<String, String>()

    val engine = MockEngine { request ->
        if (!online) throw IOException("offline")
        requests += request
        handle(request)
    }

    private suspend fun MockRequestHandleScope.handle(request: HttpRequestData) = when (request.url.encodedPath) {
        "/api/v1/config" -> json("""{"timezone":"Pacific/Auckland","authMode":"$authMode"}""")
        "/api/v1/me" -> json("""{"id":"1","displayName":"Alice"}""")
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

    fun posts() = requests.count { it.url.encodedPath == "/api/v1/results" }
}
