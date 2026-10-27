package sudoku.game

import kotlinx.datetime.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.time.Instant

class GameCalendarTest {
    private class Case(
        val name: String,
        val at: String,
        val week: String,
        val start: String,
        val end: String,
        val today: String,
        val dow: Int,
    )

    // The same cases as the server's week_test.go, so both sides agree.
    private val cases = listOf(
        Case("wednesday", "2026-10-28T01:00:00Z", "2026-W44", "2026-10-26", "2026-11-01", "2026-10-28", 3),
        Case("sunday last second", "2026-10-25T10:59:59Z", "2026-W43", "2026-10-19", "2026-10-25", "2026-10-25", 7),
        Case("monday first second", "2026-10-25T11:00:00Z", "2026-W44", "2026-10-26", "2026-11-01", "2026-10-26", 1),
        Case("before DST start", "2026-09-26T13:59:59Z", "2026-W39", "2026-09-21", "2026-09-27", "2026-09-27", 7),
        Case("after DST start", "2026-09-26T14:00:00Z", "2026-W39", "2026-09-21", "2026-09-27", "2026-09-27", 7),
        Case("week after DST start, Sunday end", "2026-09-27T10:59:59Z", "2026-W39", "2026-09-21", "2026-09-27", "2026-09-27", 7),
        Case("week after DST start, Monday", "2026-09-27T11:00:00Z", "2026-W40", "2026-09-28", "2026-10-04", "2026-09-28", 1),
        Case("DST end Sunday late", "2026-04-05T11:59:59Z", "2026-W14", "2026-03-30", "2026-04-05", "2026-04-05", 7),
        Case("DST end next Monday", "2026-04-05T12:00:00Z", "2026-W15", "2026-04-06", "2026-04-12", "2026-04-06", 1),
        Case("DST end repeated hour", "2026-04-04T14:30:00Z", "2026-W14", "2026-03-30", "2026-04-05", "2026-04-05", 7),
        Case("2020-W53 new year's day", "2021-01-01T00:00:00+13:00", "2020-W53", "2020-12-28", "2021-01-03", "2021-01-01", 5),
        Case("2021-W01 monday", "2021-01-04T00:00:00+13:00", "2021-W01", "2021-01-04", "2021-01-10", "2021-01-04", 1),
        Case("2026-W01 starts in 2025", "2025-12-29T09:00:00+13:00", "2026-W01", "2025-12-29", "2026-01-04", "2025-12-29", 1),
        Case("2026-W53", "2026-12-31T12:00:00+13:00", "2026-W53", "2026-12-28", "2027-01-03", "2026-12-31", 4),
        Case("auckland new year before UTC", "2026-12-31T11:00:00Z", "2026-W53", "2026-12-28", "2027-01-03", "2027-01-01", 5),
        Case("2027-W01", "2027-01-04T00:00:00+13:00", "2027-W01", "2027-01-04", "2027-01-10", "2027-01-04", 1),
        Case("2027-W52 last week", "2028-01-02T12:00:00+13:00", "2027-W52", "2027-12-27", "2028-01-02", "2028-01-02", 7),
        Case("2028-W01", "2028-01-03T00:00:00+13:00", "2028-W01", "2028-01-03", "2028-01-09", "2028-01-03", 1),
    )

    @Test
    fun weekAtMatchesServerRules() {
        for (c in cases) {
            val info = GameCalendar.weekAt(Instant.parse(c.at))
            assertEquals(
                WeekInfo(c.week, LocalDate.parse(c.start), LocalDate.parse(c.end), LocalDate.parse(c.today), c.dow),
                info,
                c.name,
            )
        }
    }

    @Test
    fun weekContainsItsDays() {
        val week = GameCalendar.weekOf(LocalDate.parse("2026-10-28"))
        assertTrue(LocalDate.parse("2026-10-26") in week)
        assertTrue(LocalDate.parse("2026-11-01") in week)
        assertFalse(LocalDate.parse("2026-10-25") in week)
        assertFalse(LocalDate.parse("2026-11-02") in week)
    }

    @Test
    fun startOfDayIsAucklandMidnight() {
        assertEquals(Instant.parse("2026-10-25T11:00:00Z"), GameCalendar.startOfDay(LocalDate.parse("2026-10-26")))
        assertEquals(Instant.parse("2026-07-05T12:00:00Z"), GameCalendar.startOfDay(LocalDate.parse("2026-07-06")))
    }

    @Test
    fun formatsTimestampsWithAucklandOffset() {
        assertEquals("2026-10-26T09:15:00+13:00", GameCalendar.formatTimestamp(Instant.parse("2026-10-25T20:15:00Z")))
        assertEquals("2026-07-06T09:15:07+12:00", GameCalendar.formatTimestamp(Instant.parse("2026-07-05T21:15:07.900Z")))
        // Round-trips through an RFC 3339 parser.
        val now = Instant.parse("2026-12-31T11:00:00Z")
        assertEquals(now, Instant.parse(GameCalendar.formatTimestamp(now)))
    }
}
