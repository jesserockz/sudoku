package sudoku.serverless

import kotlinx.datetime.LocalDate
import sudoku.game.formatDuration

/** One of the day's games for [ResultsSummary]: its title and solve time, or null if unsolved. */
data class GameTime(val title: String, val elapsedMs: Long?)

/**
 * The "Share results" text: a short summary of the day to paste into a
 * message, since serverless play has no leaderboard. For example:
 *
 * ```
 * Sudoku 2026-10-27 #3fa9c1
 * Easy 3:12
 * Medium 5:40
 * Hard -
 * Solved 2/3 in 8:52
 * ```
 */
object ResultsSummary {
    /** [group] tells the reader which games these were: a seed's fingerprint or a name. */
    fun format(date: LocalDate, group: String, games: List<GameTime>): String = buildString {
        append("Sudoku ").append(date.toString())
        if (group.isNotBlank()) append(' ').append(group.trim())
        for (game in games) {
            append('\n').append(game.title).append(' ').append(game.elapsedMs?.let(::formatDuration) ?: "-")
        }
        val solved = games.mapNotNull { it.elapsedMs }
        append('\n')
        if (solved.size == games.size) append("Total ") else append("Solved ${solved.size}/${games.size} in ")
        append(formatDuration(solved.sum()))
    }
}
