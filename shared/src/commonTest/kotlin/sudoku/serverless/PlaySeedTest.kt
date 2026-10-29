package sudoku.serverless

import kotlinx.coroutines.test.runTest
import kotlinx.datetime.LocalDate
import sudoku.api.WeekResponse
import sudoku.generator.Generator
import sudoku.generator.WeekSeed
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue
import kotlin.time.Instant

class PlaySeedTest {
    // The Go server's test secret (server/internal/seed/seed_test.go).
    private val serverSecret = "test-secret-0123456789"

    @Test
    fun matchesTheServersKdf() = runTest {
        // server/internal/seed/seed_test.go TestForWeekVectors.
        assertEquals("e4d2e1e00e3549cc", WeekSeed.format(PlaySeed.weekSeed(serverSecret, "2026-W44")))
        assertEquals("8ef3b5d3a4a37a74", WeekSeed.format(PlaySeed.weekSeed(serverSecret, "2020-W53")))
    }

    @Test
    fun hashesTheSeedAsUtf8() = runTest {
        // Computed with Python: hmac.new(seed.encode(), b"sudoku-week:2026-W44", sha256), first 8 bytes.
        assertEquals("45065fa404bf2ffe", WeekSeed.format(PlaySeed.weekSeed("Kōwhai 🌼 whānau", "2026-W44")))
        // Longer than SHA-256's block, so the key is hashed first.
        assertEquals("8acc740767e736a8", WeekSeed.format(PlaySeed.weekSeed("a".repeat(100), "2026-W44")))
    }

    @Test
    fun weekMatchesTheServersWeekEndpoint() = runTest {
        // server/internal/api/week_test.go: Monday 00:00 in Auckland is Sunday 11:00 UTC.
        val monday = PlaySeed.week(SeedSettings(serverSecret), Instant.parse("2026-10-25T11:00:00Z"))
        assertEquals(
            WeekResponse(
                isoWeek = "2026-W44", seed = WeekSeed.parse("e4d2e1e00e3549cc"),
                weekStart = LocalDate(2026, 10, 26), weekEnd = LocalDate(2026, 11, 1),
                today = LocalDate(2026, 10, 26), dayOfWeek = 1, timezone = "Pacific/Auckland", levels = 5,
            ),
            monday,
        )
        val sunday = PlaySeed.week(SeedSettings(serverSecret), Instant.parse("2026-10-25T10:59:59Z"))
        assertEquals("2026-W43", sunday.isoWeek)
        assertEquals(7, sunday.dayOfWeek)
    }

    @Test
    fun weekFollowsTheGroupsTimezoneAndLevels() = runTest {
        // Monday in Auckland is still Sunday morning in London.
        val week = PlaySeed.week(SeedSettings(serverSecret, levels = 3, timezone = "Europe/London"), Instant.parse("2026-10-25T11:00:00Z"))
        assertEquals("2026-W43", week.isoWeek)
        assertEquals(LocalDate(2026, 10, 25), week.today)
        assertEquals("Europe/London", week.timezone)
        assertEquals(3, week.levels)
        assertEquals(3, week.puzzles().size)
    }

    @Test
    fun puzzlesAreTheGeneratorsForTheDerivedWeekSeed() = runTest {
        val week = PlaySeed.week(SeedSettings(serverSecret), Instant.parse("2026-10-27T01:00:00Z"))
        assertEquals(LocalDate(2026, 10, 27), week.today)
        assertEquals(Generator.generateDay(WeekSeed.parse("e4d2e1e00e3549cc"), 2, 5), week.puzzles())
        // Golden: pins the whole chain from seed text to puzzle on every target.
        assertEquals(GOLDEN_GIVENS, week.puzzles().first().givens)
    }

    @Test
    fun sameSeedSamePuzzlesDifferentSeedDifferentPuzzles() = runTest {
        val now = Instant.parse("2026-10-27T01:00:00Z")
        val a = PlaySeed.week(SeedSettings("rimu-totara-kauri"), now).puzzles()
        assertEquals(a, PlaySeed.week(SeedSettings("rimu-totara-kauri"), now).puzzles())
        // Case matters: the seed is used exactly as typed (after trimming).
        assertNotEquals(a, PlaySeed.week(SeedSettings("Rimu-Totara-Kauri"), now).puzzles())
    }

    @Test
    fun normalizeTrimsButKeepsCase() {
        assertEquals("Rimu Kauri", PlaySeed.normalize("  Rimu Kauri \n"))
    }

    @Test
    fun generatedSeedsAreLongRandomAndReadable() {
        val seeds = List(50) { PlaySeed.generate() }
        val shape = Regex("^[0-9a-hjkmnp-tv-z]{5}(-[0-9a-hjkmnp-tv-z]{5}){3}$")
        for (seed in seeds) assertTrue(shape.matches(seed), seed)
        assertEquals(seeds.size, seeds.toSet().size)
    }

    @Test
    fun fingerprintIsShortAndStable() = runTest {
        // Python: hmac.new(b"test-secret-0123456789", b"sudoku-fingerprint", sha256).hexdigest()[:6]
        assertEquals("#287caf", PlaySeed.fingerprint(serverSecret))
        assertNotEquals(PlaySeed.fingerprint("a"), PlaySeed.fingerprint("b"))
    }

    private companion object {
        const val GOLDEN_GIVENS = "160027450780100000050000008010094027427000301800702045598241060306008002001605000"
    }
}
