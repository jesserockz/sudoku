package sudoku.serverless

import kotlinx.serialization.Serializable
import sudoku.game.GameCalendar
import sudoku.generator.Generator

/**
 * What everyone in a serverless group has to agree on to get the same games:
 * the seed, the number of games per day and the timezone the day turns over in.
 */
@Serializable
data class SeedSettings(
    val seed: String,
    val levels: Int = Generator.DEFAULT_LEVELS,
    val timezone: String = GameCalendar.TIMEZONE_ID,
) {
    init {
        require(seed.isNotEmpty() && seed == PlaySeed.normalize(seed)) { "seed must be non-empty and trimmed" }
        require(levels in 1..Generator.MAX_LEVELS) { "levels must be 1..${Generator.MAX_LEVELS}: $levels" }
    }
}

/**
 * Share links carry [SeedSettings] in the URL fragment, which browsers never
 * send to a server, so the seed stays out of requests and access logs:
 * `https://host/path/#seed=<percent-encoded>&levels=5`, plus `&tz=<zone>` when
 * the timezone isn't the default.
 */
object ShareLink {
    private const val SEED = "seed"
    private const val LEVELS = "levels"
    private const val TZ = "tz"

    /** The fragment for [settings], without the `#`. */
    fun fragment(settings: SeedSettings): String = buildString {
        append(SEED).append('=').append(percentEncode(settings.seed))
        append('&').append(LEVELS).append('=').append(settings.levels)
        if (settings.timezone != GameCalendar.TIMEZONE_ID) {
            append('&').append(TZ).append('=').append(percentEncode(settings.timezone))
        }
    }

    /** [baseUrl] (any fragment dropped) with [settings] as its fragment. */
    fun build(baseUrl: String, settings: SeedSettings): String = baseUrl.substringBefore('#') + "#" + fragment(settings)

    /**
     * The settings in a share link, or in just its fragment (with or without
     * the `#`). Null when there is no `seed` or anything in it is invalid: a
     * malformed escape, an empty seed, `levels` outside 1..10 or an unknown
     * timezone. Unknown parameters are ignored.
     */
    fun parse(text: String): SeedSettings? {
        val trimmed = text.trim()
        val fragment = when {
            '#' in trimmed -> trimmed.substringAfter('#')
            trimmed.startsWith("$SEED=") -> trimmed
            else -> return null
        }
        val params = mutableMapOf<String, String>()
        for (part in fragment.split('&')) {
            if (part.isEmpty()) continue
            val key = percentDecode(part.substringBefore('=')) ?: return null
            val value = percentDecode(part.substringAfter('=', "")) ?: return null
            if (key !in params) params[key] = value
        }
        val seed = PlaySeed.normalize(params[SEED] ?: return null)
        if (seed.isEmpty()) return null
        val levels = params[LEVELS]?.let { it.toIntOrNull() ?: return null } ?: Generator.DEFAULT_LEVELS
        if (levels !in 1..Generator.MAX_LEVELS) return null
        val timezone = params[TZ]?.takeIf { it.isNotEmpty() } ?: GameCalendar.TIMEZONE_ID
        if (runCatching { GameCalendar.zone(timezone) }.isFailure) return null
        return SeedSettings(seed, levels, timezone)
    }

    /** Like JavaScript's `encodeURIComponent`, but escaping everything outside RFC 3986's unreserved set. */
    internal fun percentEncode(value: String): String = buildString {
        for (byte in value.encodeToByteArray()) {
            val c = byte.toInt() and 0xff
            if (c.toChar().isUnreserved()) {
                append(c.toChar())
            } else {
                append('%').append(HEX[c shr 4]).append(HEX[c and 0xf])
            }
        }
    }

    /** Reverses [percentEncode]; `+` reads as a space, as `URLSearchParams` does. Null if malformed. */
    internal fun percentDecode(value: String): String? {
        val bytes = ArrayList<Byte>(value.length)
        var i = 0
        while (i < value.length) {
            when (value[i]) {
                '%' -> {
                    val hi = value.getOrNull(i + 1)?.digitToIntOrNull(16) ?: return null
                    val lo = value.getOrNull(i + 2)?.digitToIntOrNull(16) ?: return null
                    bytes.add((hi * 16 + lo).toByte())
                    i += 3
                }
                '+' -> {
                    bytes.add(' '.code.toByte())
                    i++
                }
                else -> {
                    // A pasted link may hold raw Unicode: encode each literal run whole, keeping surrogate pairs.
                    val end = (i until value.length).firstOrNull { value[it] == '%' || value[it] == '+' } ?: value.length
                    value.substring(i, end).encodeToByteArray().forEach(bytes::add)
                    i = end
                }
            }
        }
        return runCatching { bytes.toByteArray().decodeToString(throwOnInvalidSequence = true) }.getOrNull()
    }

    private fun Char.isUnreserved() = this in 'A'..'Z' || this in 'a'..'z' || this in '0'..'9' || this in "-._~"

    private const val HEX = "0123456789ABCDEF"
}
