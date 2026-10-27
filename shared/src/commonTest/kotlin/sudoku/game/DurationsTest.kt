package sudoku.game

import kotlin.test.Test
import kotlin.test.assertEquals

class DurationsTest {
    @Test
    fun formats() {
        assertEquals("0:00", formatDuration(0))
        assertEquals("0:00", formatDuration(-5))
        assertEquals("0:05", formatDuration(5_999))
        assertEquals("3:03", formatDuration(183_000))
        assertEquals("59:59", formatDuration(3_599_999))
        assertEquals("1:00:00", formatDuration(3_600_000))
        assertEquals("24:00:00", formatDuration(86_400_000))
    }
}
