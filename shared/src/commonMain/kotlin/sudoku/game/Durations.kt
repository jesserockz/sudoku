package sudoku.game

/** A solve time for display: `m:ss` under an hour, `h:mm:ss` from then on. Rounds down. */
fun formatDuration(ms: Long): String {
    val totalSeconds = (if (ms < 0) 0 else ms) / 1000
    val h = totalSeconds / 3600
    val m = totalSeconds % 3600 / 60
    val s = totalSeconds % 60
    val ss = s.toString().padStart(2, '0')
    return if (h > 0) "$h:${m.toString().padStart(2, '0')}:$ss" else "$m:$ss"
}
