package sudoku.game

import kotlinx.datetime.DatePeriod
import kotlinx.datetime.LocalDate
import kotlinx.datetime.TimeZone
import kotlinx.datetime.atStartOfDayIn
import kotlinx.datetime.isoDayNumber
import kotlinx.datetime.minus
import kotlinx.datetime.offsetAt
import kotlinx.datetime.plus
import kotlinx.datetime.toLocalDateTime
import kotlin.time.Clock
import kotlin.time.Instant

/** The game day and ISO week containing an instant. Mirrors `GET /api/v1/week`. */
data class WeekInfo(
    val isoWeek: String,
    val weekStart: LocalDate,
    val weekEnd: LocalDate,
    val today: LocalDate,
    val dayOfWeek: Int,
) {
    operator fun contains(date: LocalDate): Boolean = date >= weekStart && date <= weekEnd
}

/**
 * Days and weeks in the game's fixed timezone, Pacific/Auckland, whatever the
 * device's own timezone. Matches the server's rules: the date is the Auckland
 * calendar date, the day of week is ISO 8601 (1 = Monday ... 7 = Sunday) and the
 * week is the ISO 8601 week containing that date, written like `2026-W44`.
 */
object GameCalendar {
    const val TIMEZONE_ID = "Pacific/Auckland"

    val timeZone: TimeZone by lazy {
        loadTimeZoneDatabase()
        TimeZone.of(TIMEZONE_ID)
    }

    /**
     * The timezone [id] (an IANA name such as `Europe/London`), for groups that
     * play with a seed in a zone of their own. Throws [IllegalArgumentException]
     * for an unknown id.
     */
    fun zone(id: String): TimeZone {
        loadTimeZoneDatabase()
        return TimeZone.of(id)
    }

    fun today(now: Instant = Clock.System.now(), zone: TimeZone = timeZone): LocalDate = now.toLocalDateTime(zone).date

    fun dayOfWeek(date: LocalDate): Int = date.dayOfWeek.isoDayNumber

    fun weekStart(date: LocalDate): LocalDate = date.minus(DatePeriod(days = dayOfWeek(date) - 1))

    fun isoWeek(date: LocalDate): String {
        // The ISO week-year is the year of the week's Thursday.
        val thursday = weekStart(date).plus(DatePeriod(days = 3))
        val week = (thursday.dayOfYear - 1) / 7 + 1
        return "${thursday.year.toString().padStart(4, '0')}-W${week.toString().padStart(2, '0')}"
    }

    fun weekOf(date: LocalDate): WeekInfo {
        val start = weekStart(date)
        return WeekInfo(isoWeek(date), start, start.plus(DatePeriod(days = 6)), date, dayOfWeek(date))
    }

    fun weekAt(now: Instant = Clock.System.now(), zone: TimeZone = timeZone): WeekInfo = weekOf(today(now, zone))

    /** Midnight at the start of [date], Auckland time. */
    fun startOfDay(date: LocalDate): Instant = date.atStartOfDayIn(timeZone)

    /**
     * [instant] as RFC 3339 in Auckland time with its offset and whole seconds,
     * e.g. `2026-10-26T09:15:00+13:00`, the API's `completedAt` format.
     */
    fun formatTimestamp(instant: Instant): String {
        val local = instant.toLocalDateTime(timeZone)
        val offsetSeconds = timeZone.offsetAt(instant).totalSeconds
        val sign = if (offsetSeconds < 0) '-' else '+'
        val abs = if (offsetSeconds < 0) -offsetSeconds else offsetSeconds
        return buildString {
            append(local.date.toString())
            append('T')
            append(two(local.hour)).append(':').append(two(local.minute)).append(':').append(two(local.second))
            append(sign).append(two(abs / 3600)).append(':').append(two(abs % 3600 / 60))
        }
    }

    private fun two(n: Int) = n.toString().padStart(2, '0')
}

/** Makes sure the platform has the IANA timezone database loaded (a no-op except on JS). */
internal expect fun loadTimeZoneDatabase()
