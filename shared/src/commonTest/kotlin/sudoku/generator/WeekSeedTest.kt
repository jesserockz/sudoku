package sudoku.generator

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class WeekSeedTest {
    @Test
    fun parsesHexAsA64BitPattern() {
        assertEquals(0L, WeekSeed.parse("0000000000000000"))
        assertEquals(-1L, WeekSeed.parse("ffffffffffffffff"))
        assertEquals(Long.MIN_VALUE, WeekSeed.parse("8000000000000000"))
        assertEquals(0x0123456789abcdefL, WeekSeed.parse("0123456789abcdef"))
        assertEquals(-0x60d3b5e481cf2a38L, WeekSeed.parse("9f2c4a1b7e30d5c8"))
        assertEquals(WeekSeed.parse("9f2c4a1b7e30d5c8"), WeekSeed.parse("9F2C4A1B7E30D5C8"))
    }

    @Test
    fun formatsRoundTrip() {
        for (hex in listOf("0000000000000000", "ffffffffffffffff", "0000000000000001", "9f2c4a1b7e30d5c8")) {
            assertEquals(hex, WeekSeed.format(WeekSeed.parse(hex)))
        }
    }

    @Test
    fun rejectsMalformedSeeds() {
        for (bad in listOf("", "123", "9f2c4a1b7e30d5c", "9f2c4a1b7e30d5c80", "9f2c4a1b7e30d5cg", "-f2c4a1b7e30d5c8")) {
            assertFailsWith<IllegalArgumentException>(bad) { WeekSeed.parse(bad) }
        }
    }
}
