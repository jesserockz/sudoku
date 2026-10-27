package sudoku.api

import kotlinx.datetime.LocalDate
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import sudoku.game.DailyPuzzles
import sudoku.game.WeekInfo
import sudoku.generator.Generator
import sudoku.generator.Puzzle
import sudoku.generator.WeekSeed

// Request and response bodies of the v1 API, field for field as in docs/API.md.

@Serializable
data class ErrorEnvelope(val error: ApiError)

@Serializable
data class ApiError(val code: String, val message: String = "")

/** `GET /api/v1/config` */
@Serializable
data class AppConfig(
    val timezone: String,
    /** May be absent when the server runs in dev auth mode. */
    val oidc: OidcConfig? = null,
    val authMode: AuthMode,
)

@Serializable
data class OidcConfig(
    val issuer: String,
    val clientId: String,
    val scopes: List<String> = listOf("openid", "profile"),
)

@Serializable
enum class AuthMode {
    @SerialName("oidc")
    OIDC,

    @SerialName("dev")
    DEV,
}

/** `GET /api/v1/week` */
@Serializable
data class WeekResponse(
    val isoWeek: String,
    /** The 64-bit weekly seed; 16 lowercase hex characters on the wire. */
    @Serializable(with = HexSeedSerializer::class)
    val seed: Long,
    val weekStart: LocalDate,
    val weekEnd: LocalDate,
    val today: LocalDate,
    val dayOfWeek: Int,
    val timezone: String,
    /** Games per day this week (levels `1..levels`). Servers that predate it always had 5. */
    val levels: Int = Generator.DEFAULT_LEVELS,
) {
    /** The day's games for [date] in this week. */
    fun puzzles(date: LocalDate = today): List<Puzzle> = DailyPuzzles.forDate(seed, toWeekInfo(), date, levels)

    fun toWeekInfo(): WeekInfo = WeekInfo(isoWeek, weekStart, weekEnd, today, dayOfWeek)
}

/** `GET /api/v1/me` */
@Serializable
data class Me(val id: String, val displayName: String)

/**
 * One result: the body of `POST /api/v1/results`, its response, and the items
 * of `GET /api/v1/me/results`. [completedAt] is RFC 3339 with offset, kept as
 * the string the client reported.
 */
@Serializable
data class GameResult(
    val date: LocalDate,
    val level: Int,
    val elapsedMs: Long,
    val completedAt: String,
)

/** An item of `GET /api/v1/me/results`, which omits the date. */
@Serializable
data class DayResult(
    val level: Int,
    val elapsedMs: Long,
    val completedAt: String,
)

/** `GET /api/v1/me/results` */
@Serializable
data class MyResults(val date: LocalDate, val results: List<DayResult>)

/** `GET /api/v1/leaderboard` */
@Serializable
data class Leaderboard(
    val date: LocalDate,
    val puzzles: List<PuzzleBoard>,
    val total: TotalBoard,
    val players: List<PlayerProgress>,
)

@Serializable
data class PuzzleBoard(val level: Int, val entries: List<PuzzleEntry>)

@Serializable
data class PuzzleEntry(val rank: Int, val userId: String, val displayName: String, val elapsedMs: Long)

@Serializable
data class TotalBoard(val entries: List<TotalEntry>)

@Serializable
data class TotalEntry(val rank: Int, val userId: String, val displayName: String, val totalMs: Long)

@Serializable
data class PlayerProgress(val userId: String, val displayName: String, val completedLevels: List<Int>)

/** The weekly seed as 16 hex characters (see [WeekSeed]). */
object HexSeedSerializer : KSerializer<Long> {
    override val descriptor = PrimitiveSerialDescriptor("sudoku.api.HexSeed", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: Long) = encoder.encodeString(WeekSeed.format(value))

    override fun deserialize(decoder: Decoder): Long = WeekSeed.parse(decoder.decodeString())
}
