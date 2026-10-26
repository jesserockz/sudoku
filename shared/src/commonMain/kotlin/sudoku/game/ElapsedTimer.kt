package sudoku.game

import kotlin.time.TimeSource

/**
 * Active solve time, as an immutable value the UI drives.
 *
 * Every call takes `nowMs`, a reading from a monotonic clock in milliseconds
 * (see [Ticker]), so the timer is easy to test and unaffected by wall-clock
 * changes. Pausing banks the running segment; resuming starts a new one.
 */
class ElapsedTimer private constructor(
    /** Time banked from completed running segments. */
    val accumulatedMs: Long,
    /** Monotonic reading when the current segment started, or `null` when paused. */
    private val runningSinceMs: Long?,
) {
    val isRunning: Boolean get() = runningSinceMs != null

    fun elapsedMs(nowMs: Long): Long =
        accumulatedMs + (runningSinceMs?.let { (nowMs - it).coerceAtLeast(0) } ?: 0)

    fun resume(nowMs: Long): ElapsedTimer = if (isRunning) this else ElapsedTimer(accumulatedMs, nowMs)

    fun pause(nowMs: Long): ElapsedTimer = if (isRunning) ElapsedTimer(elapsedMs(nowMs), null) else this

    override fun equals(other: Any?): Boolean =
        other is ElapsedTimer && accumulatedMs == other.accumulatedMs && runningSinceMs == other.runningSinceMs

    override fun hashCode(): Int = 31 * accumulatedMs.hashCode() + runningSinceMs.hashCode()

    override fun toString(): String = "ElapsedTimer(accumulatedMs=$accumulatedMs, running=$isRunning)"

    companion object {
        val NotStarted = ElapsedTimer(0, null)

        /** A paused timer holding [elapsedMs], e.g. restored from storage. */
        fun paused(elapsedMs: Long): ElapsedTimer {
            require(elapsedMs >= 0) { "elapsedMs must not be negative" }
            return ElapsedTimer(elapsedMs, null)
        }
    }
}

/** A monotonic millisecond clock for [ElapsedTimer]. */
fun interface Ticker {
    fun nowMs(): Long

    companion object {
        /** Milliseconds since this ticker was created, from the platform's monotonic clock. */
        fun monotonic(): Ticker {
            val origin = TimeSource.Monotonic.markNow()
            return Ticker { origin.elapsedNow().inWholeMilliseconds }
        }
    }
}
