package sudoku.api

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.OutgoingContent
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.LocalDate
import kotlinx.serialization.json.Json
import sudoku.generator.WeekSeed
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SudokuApiTest {
    private val requests = mutableListOf<HttpRequestData>()

    private fun api(
        token: String? = DevAuth.token("alice", "Alice"),
        handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData,
    ) = SudokuApi(
        baseUrl = "https://sudoku.example.com/",
        tokens = TokenProvider { token },
        engine = MockEngine { request ->
            requests += request
            handler(request)
        },
    )

    private fun MockRequestHandleScope.json(body: String, status: HttpStatusCode = HttpStatusCode.OK) =
        respond(body, status, headersOf(HttpHeaders.ContentType, "application/json; charset=utf-8"))

    private val last get() = requests.last()

    @Test
    fun configIsUnauthenticated() = runTest {
        val config = api {
            json(
                """
                {
                  "timezone": "Pacific/Auckland",
                  "oidc": {
                    "issuer": "https://auth.example.com/application/o/sudoku/",
                    "clientId": "sudoku-web",
                    "scopes": ["openid", "profile", "offline_access"]
                  },
                  "authMode": "oidc"
                }
                """,
            )
        }.config()
        assertEquals("https://sudoku.example.com/api/v1/config", last.url.toString())
        assertNull(last.headers[HttpHeaders.Authorization])
        assertEquals(
            AppConfig(
                "Pacific/Auckland",
                OidcConfig("https://auth.example.com/application/o/sudoku/", "sudoku-web", listOf("openid", "profile", "offline_access")),
                AuthMode.OIDC,
            ),
            config,
        )
    }

    @Test
    fun devConfigWithoutOidc() = runTest {
        val config = api { json("""{"timezone":"Pacific/Auckland","authMode":"dev"}""") }.config()
        assertEquals(AuthMode.DEV, config.authMode)
        assertNull(config.oidc)
        val nulled = api { json("""{"timezone":"Pacific/Auckland","oidc":null,"authMode":"dev"}""") }.config()
        assertNull(nulled.oidc)
    }

    @Test
    fun weekParsesTheHexSeed() = runTest {
        val week = api {
            json(
                """
                {
                  "isoWeek": "2026-W44",
                  "seed": "9f2c4a1b7e30d5c8",
                  "weekStart": "2026-10-26",
                  "weekEnd": "2026-11-01",
                  "today": "2026-10-26",
                  "dayOfWeek": 1,
                  "timezone": "Pacific/Auckland"
                }
                """,
            )
        }.week()
        assertEquals("https://sudoku.example.com/api/v1/week", last.url.toString())
        assertEquals("Bearer dev:alice:Alice", last.headers[HttpHeaders.Authorization])
        assertEquals(WeekSeed.parse("9f2c4a1b7e30d5c8"), week.seed)
        assertEquals(LocalDate(2026, 10, 26), week.weekStart)
        assertEquals(LocalDate(2026, 11, 1), week.weekEnd)
        assertEquals("2026-W44", week.toWeekInfo().isoWeek)
        assertEquals(1, week.toWeekInfo().dayOfWeek)
        // A seed with the top bit set survives the round trip.
        val encoded = SudokuApi.json.encodeToString(WeekResponse.serializer(), week)
        assertTrue("\"seed\":\"9f2c4a1b7e30d5c8\"" in encoded)
    }

    @Test
    fun weekCarriesTheGameCount() = runTest {
        val body = """{"isoWeek":"2026-W44","seed":"9f2c4a1b7e30d5c8","weekStart":"2026-10-26","weekEnd":"2026-11-01",
            "today":"2026-10-28","dayOfWeek":3,"timezone":"Pacific/Auckland"LEVELS}"""
        val seven = api { json(body.replace("LEVELS", ""","levels":7""")) }.week()
        assertEquals(7, seven.levels)
        val puzzles = seven.puzzles()
        assertEquals((1..7).toList(), puzzles.map { it.level })
        assertTrue(puzzles.all { it.dayOfWeek == 3 && it.levels == 7 })
        // Servers from before configurable levels always had five.
        assertEquals(5, api { json(body.replace("LEVELS", "")) }.week().levels)
    }

    @Test
    fun malformedSeedFailsToDecode() = runTest {
        val api = api {
            json(
                """{"isoWeek":"2026-W44","seed":"123","weekStart":"2026-10-26","weekEnd":"2026-11-01",
                "today":"2026-10-26","dayOfWeek":1,"timezone":"Pacific/Auckland"}""",
            )
        }
        assertFailsWith<IllegalArgumentException> { api.week() }
    }

    @Test
    fun me() = runTest {
        val me = api { json("""{ "id": "alice", "displayName": "Alice" }""") }.me()
        assertEquals(Me("alice", "Alice"), me)
        assertEquals("/api/v1/me", last.url.encodedPath)
    }

    @Test
    fun myResultsWithAndWithoutDate() = runTest {
        val api = api {
            json(
                """
                {
                  "date": "2026-10-26",
                  "results": [
                    { "level": 1, "elapsedMs": 183000, "completedAt": "2026-10-26T09:15:00+13:00" }
                  ]
                }
                """,
            )
        }
        val today = api.myResults()
        assertEquals("/api/v1/me/results", last.url.encodedPath)
        assertNull(last.url.parameters["date"])
        assertEquals(listOf(DayResult(1, 183000, "2026-10-26T09:15:00+13:00")), today.results)
        api.myResults(LocalDate(2026, 10, 25))
        assertEquals("2026-10-25", last.url.parameters["date"])
    }

    private val result = GameResult(LocalDate(2026, 10, 26), 1, 183000, "2026-10-26T09:15:00+13:00")
    private val resultJson =
        """{ "date": "2026-10-26", "level": 1, "elapsedMs": 183000, "completedAt": "2026-10-26T09:15:00+13:00" }"""

    @Test
    fun submitSendsTheContractBody() = runTest {
        val outcome = api { json(resultJson, HttpStatusCode.Created) }.submitResult(result)
        assertEquals(SubmitOutcome.Created(result), outcome)
        assertEquals(HttpMethod.Post, last.method)
        assertEquals("/api/v1/results", last.url.encodedPath)
        assertEquals("Bearer dev:alice:Alice", last.headers[HttpHeaders.Authorization])
        val body = last.body as OutgoingContent.ByteArrayContent
        assertEquals("application/json", body.contentType?.withoutParameters()?.toString())
        assertEquals(
            Json.parseToJsonElement(resultJson),
            Json.parseToJsonElement(body.bytes().decodeToString()),
        )
    }

    @Test
    fun submitDuplicateReturnsTheStoredResult() = runTest {
        val stored = """{"date":"2026-10-26","level":1,"elapsedMs":150000,"completedAt":"2026-10-26T08:00:00+13:00"}"""
        val outcome = api { json(stored, HttpStatusCode.OK) }.submitResult(result)
        assertEquals(
            SubmitOutcome.AlreadyStored(result.copy(elapsedMs = 150000, completedAt = "2026-10-26T08:00:00+13:00")),
            outcome,
        )
    }

    @Test
    fun submitRejectedIsFinal() = runTest {
        val outcome = api {
            json("""{ "error": { "code": "invalid_result", "message": "elapsedMs below minimum" } }""", HttpStatusCode.BadRequest)
        }.submitResult(result.copy(elapsedMs = 10))
        assertEquals(SubmitOutcome.Rejected(ApiError("invalid_result", "elapsedMs below minimum")), outcome)
    }

    @Test
    fun errorsThrowApiException() = runTest {
        val unauthorized = api(token = null) {
            json("""{ "error": { "code": "unauthorized", "message": "missing token" } }""", HttpStatusCode.Unauthorized)
        }
        val e = assertFailsWith<ApiException> { unauthorized.week() }
        assertNull(last.headers[HttpHeaders.Authorization])
        assertEquals(401, e.status)
        assertTrue(e.isUnauthorized)
        assertEquals("unauthorized", e.error?.code)

        val submit401 = assertFailsWith<ApiException> { unauthorized.submitResult(result) }
        assertEquals(401, submit401.status)

        // A body that isn't the error envelope still gives a status.
        val broken = api { respond("Bad Gateway", HttpStatusCode.BadGateway) }
        val e502 = assertFailsWith<ApiException> { broken.leaderboard() }
        assertEquals(502, e502.status)
        assertNull(e502.error)
        assertEquals(502, assertFailsWith<ApiException> { broken.submitResult(result) }.status)
    }

    @Test
    fun leaderboard() = runTest {
        val board = api {
            json(
                """
                {
                  "date": "2026-10-26",
                  "puzzles": [
                    {
                      "level": 1,
                      "entries": [
                        { "rank": 1, "userId": "bob", "displayName": "Bob", "elapsedMs": 150000 },
                        { "rank": 2, "userId": "alice", "displayName": "Alice", "elapsedMs": 183000 },
                        { "rank": 2, "userId": "carol", "displayName": "Carol", "elapsedMs": 183000 },
                        { "rank": 4, "userId": "dave", "displayName": "Dave", "elapsedMs": 200000 }
                      ]
                    },
                    { "level": 2, "entries": [] }
                  ],
                  "total": {
                    "entries": [
                      { "rank": 1, "userId": "bob", "displayName": "Bob", "totalMs": 2400000 }
                    ]
                  },
                  "players": [
                    { "userId": "alice", "displayName": "Alice", "completedLevels": [1, 2, 3] },
                    { "userId": "bob", "displayName": "Bob", "completedLevels": [1, 2, 3, 4, 5] }
                  ],
                  "someFutureField": true
                }
                """,
            )
        }.leaderboard(LocalDate(2026, 10, 26))
        assertEquals("/api/v1/leaderboard", last.url.encodedPath)
        assertEquals("2026-10-26", last.url.parameters["date"])
        assertEquals(listOf(1, 2, 2, 4), board.puzzles[0].entries.map { it.rank })
        assertEquals(PuzzleEntry(2, "carol", "Carol", 183000), board.puzzles[0].entries[2])
        assertTrue(board.puzzles[1].entries.isEmpty())
        assertEquals(listOf(TotalEntry(1, "bob", "Bob", 2400000)), board.total.entries)
        assertEquals(listOf(1, 2, 3), board.players[0].completedLevels)
    }

    @Test
    fun baseUrlWithoutTrailingSlash() = runTest {
        SudokuApi("http://localhost:8080", TokenProvider { null }, MockEngine { requests += it; json("""{"id":"a","displayName":"A"}""") }).me()
        assertEquals("http://localhost:8080/api/v1/me", last.url.toString())
    }

    @Test
    fun devTokens() {
        assertEquals("dev:alice:Alice", DevAuth.token("alice", "Alice"))
        assertEquals("dev:bob:Bob Smith", DevAuth.token("bob", "Bob Smith"))
        assertFailsWith<IllegalArgumentException> { DevAuth.token("a:b", "x") }
        assertFailsWith<IllegalArgumentException> { DevAuth.token("", "x") }
        assertFailsWith<IllegalArgumentException> { DevAuth.token("a", "") }
    }

}
