package sudoku.api

import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.parameter
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.datetime.LocalDate
import kotlinx.serialization.json.Json

/** A non-2xx API response. [error] is the parsed error envelope, when there was one. */
class ApiException(val status: Int, val error: ApiError?) :
    Exception("HTTP $status${error?.let { ": ${it.code} ${it.message}" } ?: ""}") {
    val isUnauthorized: Boolean get() = status == 401
}

/** How the server answered `POST /api/v1/results`. */
sealed interface SubmitOutcome {
    /** `201`: stored now. */
    data class Created(val result: GameResult) : SubmitOutcome

    /** `200`: a result already existed; [result] is the stored one, which may differ. */
    data class AlreadyStored(val result: GameResult) : SubmitOutcome

    /** `400`: failed validation. Final; drop the result and don't retry. */
    data class Rejected(val error: ApiError?) : SubmitOutcome
}

/**
 * Client for the v1 API (`docs/API.md`).
 *
 * [baseUrl] is the server origin, e.g. `https://sudoku.example.com`. Network
 * failures surface as the engine's exceptions; HTTP errors as [ApiException].
 */
class SudokuApi(
    baseUrl: String,
    private val tokens: TokenProvider,
    engine: HttpClientEngine = defaultEngine(),
) : AutoCloseable {
    private val apiBase = baseUrl.trimEnd('/') + "/api/v1/"

    private val client = HttpClient(engine) {
        expectSuccess = false
    }

    /** Unauthenticated. */
    suspend fun config(): AppConfig = client.get(apiBase + "config").bodyOrThrow()

    suspend fun week(): WeekResponse = client.get(apiBase + "week") { auth() }.bodyOrThrow()

    suspend fun me(): Me = client.get(apiBase + "me") { auth() }.bodyOrThrow()

    /** The caller's results for [date] (the server's today when `null`). */
    suspend fun myResults(date: LocalDate? = null): MyResults =
        client.get(apiBase + "me/results") {
            auth()
            date?.let { parameter("date", it.toString()) }
        }.bodyOrThrow()

    suspend fun submitResult(result: GameResult): SubmitOutcome {
        val response = client.post(apiBase + "results") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(json.encodeToString(GameResult.serializer(), result))
        }
        return when (response.status) {
            HttpStatusCode.Created -> SubmitOutcome.Created(response.decode())
            HttpStatusCode.OK -> SubmitOutcome.AlreadyStored(response.decode())
            HttpStatusCode.BadRequest -> SubmitOutcome.Rejected(response.errorOrNull())
            else -> throw ApiException(response.status.value, response.errorOrNull())
        }
    }

    /** The leaderboard for [date] (the server's today when `null`). */
    suspend fun leaderboard(date: LocalDate? = null): Leaderboard =
        client.get(apiBase + "leaderboard") {
            auth()
            date?.let { parameter("date", it.toString()) }
        }.bodyOrThrow()

    override fun close() = client.close()

    private suspend fun HttpRequestBuilder.auth() {
        tokens.token()?.let { header(HttpHeaders.Authorization, "Bearer $it") }
    }

    private suspend inline fun <reified T> HttpResponse.bodyOrThrow(): T {
        if (!status.isSuccess()) throw ApiException(status.value, errorOrNull())
        return decode()
    }

    private suspend inline fun <reified T> HttpResponse.decode(): T = json.decodeFromString(bodyAsText())

    private suspend fun HttpResponse.errorOrNull(): ApiError? =
        runCatching { json.decodeFromString<ErrorEnvelope>(bodyAsText()).error }.getOrNull()

    companion object {
        /** Lenient on input (unknown fields are ignored) so newer servers stay compatible. */
        val json = Json {
            ignoreUnknownKeys = true
            explicitNulls = false
        }
    }
}

/** The platform's HTTP engine: OkHttp on Android, fetch on JS, java.net.http on the JVM. */
internal expect fun defaultEngine(): HttpClientEngine
