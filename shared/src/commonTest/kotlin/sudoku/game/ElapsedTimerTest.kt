package sudoku.game

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertSame
import kotlin.test.assertTrue

class ElapsedTimerTest {
    @Test
    fun countsOnlyRunningTime() {
        var t = ElapsedTimer.NotStarted
        assertEquals(0, t.elapsedMs(1_000))
        t = t.resume(1_000)
        assertTrue(t.isRunning)
        assertEquals(2_500, t.elapsedMs(3_500))
        t = t.pause(4_000)
        assertFalse(t.isRunning)
        assertEquals(3_000, t.elapsedMs(100_000)) // time away doesn't count
        t = t.resume(100_000)
        assertEquals(4_000, t.elapsedMs(101_000))
        assertEquals(4_000, t.pause(101_000).accumulatedMs)
    }

    @Test
    fun pauseAndResumeAreIdempotent() {
        val running = ElapsedTimer.NotStarted.resume(10)
        assertSame(running, running.resume(500))
        val paused = running.pause(20)
        assertSame(paused, paused.pause(999))
        assertEquals(10, paused.elapsedMs(0))
    }

    @Test
    fun clockGoingBackwardsNeverSubtracts() {
        val t = ElapsedTimer.paused(5_000).resume(1_000)
        assertEquals(5_000, t.elapsedMs(900))
    }

    @Test
    fun restoredTimerIsPaused() {
        val t = ElapsedTimer.paused(42_000)
        assertFalse(t.isRunning)
        assertEquals(42_000, t.elapsedMs(1))
        assertFailsWith<IllegalArgumentException> { ElapsedTimer.paused(-1) }
    }

    @Test
    fun monotonicTickerDoesNotGoBackwards() {
        val ticker = Ticker.monotonic()
        val a = ticker.nowMs()
        val b = ticker.nowMs()
        assertTrue(a >= 0 && b >= a)
    }
}
