package sudoku.serverless

import kotlinx.datetime.TimeZone
import sudoku.api.WeekResponse
import sudoku.auth.hmacSha256
import sudoku.auth.secureRandomBytes
import sudoku.game.GameCalendar
import kotlin.time.Clock
import kotlin.time.Instant

/**
 * Serverless play: a group shares a seed (a passphrase) instead of a server,
 * and everyone with the same seed gets the same daily puzzles.
 *
 * The weekly seed comes from the server's own KDF with the seed as its secret,
 * `HMAC-SHA256(UTF-8(seed), "sudoku-week:" + isoWeek)` truncated to its first
 * 8 bytes, read big-endian (`server/internal/seed/seed.go`). A seed equal to a
 * server's secret therefore plays exactly that server's puzzles.
 */
object PlaySeed {
    private const val WEEK_PREFIX = "sudoku-week:"
    private const val FINGERPRINT_MESSAGE = "sudoku-fingerprint"

    // Crockford's base32: no I, L, O or U, so a generated seed reads aloud and types cleanly.
    private const val ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"
    private const val GROUPS = 4
    private const val GROUP_LENGTH = 5

    /** What a typed seed means: surrounding whitespace dropped, case kept. */
    fun normalize(input: String): String = input.trim()

    /** The 64-bit seed of [isoWeek] (e.g. `2026-W44`) for [seed]. */
    suspend fun weekSeed(seed: String, isoWeek: String): Long {
        val mac = hmacSha256(seed.encodeToByteArray(), (WEEK_PREFIX + isoWeek).encodeToByteArray())
        return (0 until 8).fold(0L) { acc, i -> (acc shl 8) or (mac[i].toLong() and 0xff) }
    }

    /**
     * The week containing [now] for [settings], in the same shape as the
     * server's `GET /api/v1/week`, so the clients play it the same way.
     */
    suspend fun week(settings: SeedSettings, now: Instant = Clock.System.now()): WeekResponse {
        val zone: TimeZone = GameCalendar.zone(settings.timezone)
        val info = GameCalendar.weekAt(now, zone)
        return WeekResponse(
            isoWeek = info.isoWeek,
            seed = weekSeed(settings.seed, info.isoWeek),
            weekStart = info.weekStart,
            weekEnd = info.weekEnd,
            today = info.today,
            dayOfWeek = info.dayOfWeek,
            timezone = settings.timezone,
            levels = settings.levels,
        )
    }

    /**
     * A new random seed such as `k7mq4-xzp2a-9d3fe-b6wnh`: 20 characters from a
     * 32-letter alphabet, 100 bits from the platform's CSPRNG.
     */
    fun generate(): String {
        // 256 is a multiple of 32, so masking each byte to 5 bits is unbiased.
        val bytes = secureRandomBytes(GROUPS * GROUP_LENGTH)
        return bytes.toList().chunked(GROUP_LENGTH).joinToString("-") { group ->
            group.joinToString("") { ALPHABET[it.toInt() and 0x1f].toString() }
        }
    }

    /**
     * A short tag for [seed], e.g. `#3fa9c1`, to tell groups apart in shared
     * results without revealing the seed itself.
     */
    suspend fun fingerprint(seed: String): String {
        val mac = hmacSha256(seed.encodeToByteArray(), FINGERPRINT_MESSAGE.encodeToByteArray())
        return "#" + (0 until 3).joinToString("") { (mac[it].toInt() and 0xff).toString(16).padStart(2, '0') }
    }
}
