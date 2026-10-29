package sudoku.game

import kotlinx.serialization.Serializable
import sudoku.core.Board
import sudoku.core.Geometry

/**
 * One puzzle being played: board, pencil marks, undo history and timer.
 *
 * Immutable: every action returns a new [Game], so the UI can hold it as state.
 * [place] takes `nowMs` (a [Ticker] reading) because solving the puzzle stops
 * the timer at that instant. Once [isComplete], the
 * game ignores further moves.
 */
class Game private constructor(
    val board: Board,
    val notes: Notes,
    val timer: ElapsedTimer,
    /** Solve time once complete, else `null`. */
    val completedElapsedMs: Long?,
    private val history: List<Snapshot>,
) {
    private class Snapshot(val board: Board, val notes: Notes)

    val isComplete: Boolean get() = completedElapsedMs != null

    val canUndo: Boolean get() = !isComplete && history.isNotEmpty()

    fun elapsedMs(nowMs: Long): Long = completedElapsedMs ?: timer.elapsedMs(nowMs)

    /**
     * Places [digit] at [index], clearing that cell's notes and removing [digit]
     * from its peers' notes. Completes the game if the board is now solved.
     */
    fun place(index: Int, digit: Int, nowMs: Long): Game {
        if (isComplete || board.isGiven(index) || board[index] == digit) return this
        val nextBoard = board.with(index, digit)
        val nextNotes = notes.cleared(index).withoutDigit(Geometry.peers[index], digit)
        return record(nextBoard, nextNotes, nowMs)
    }

    /** Clears a player-entered digit, or the notes of an empty cell. */
    fun erase(index: Int): Game {
        if (isComplete || board.isGiven(index)) return this
        return when {
            board[index] != Board.EMPTY -> record(board.cleared(index), notes, nowMs = null)
            !notes.isEmpty(index) -> record(board, notes.cleared(index), nowMs = null)
            else -> this
        }
    }

    /** Whether there is anything for [clearAll] to remove: a player-entered digit or a note. */
    val canClearAll: Boolean
        get() = !isComplete && (board != board.givensOnly() || notes != Notes.Empty)

    /** Clears every player-entered digit and note as a single undoable step. */
    fun clearAll(): Game {
        if (!canClearAll) return this
        return record(board.givensOnly(), Notes.Empty, nowMs = null)
    }

    /** Toggles a pencil mark. Only empty cells take notes. */
    fun toggleNote(index: Int, digit: Int): Game {
        if (isComplete || board[index] != Board.EMPTY) return this
        return record(board, notes.toggled(index, digit), nowMs = null)
    }

    /** Reverts the last board or note change. The timer is unaffected. */
    fun undo(): Game {
        if (!canUndo) return this
        val last = history.last()
        return Game(last.board, last.notes, timer, null, history.dropLast(1))
    }

    fun pause(nowMs: Long): Game = if (isComplete) this else copy(timer = timer.pause(nowMs))

    /** Starts or resumes the timer. A complete game stays stopped. */
    fun resume(nowMs: Long): Game = if (isComplete) this else copy(timer = timer.resume(nowMs))

    /** Digits `1..9` placed nine times on the board (useful to grey out the keypad). */
    fun completedDigits(): Set<Int> {
        val counts = IntArray(10)
        for (i in 0 until Geometry.CELLS) counts[board[i]]++
        return (1..9).filterTo(LinkedHashSet()) { counts[it] >= 9 }
    }

    /** The persistable state (undo history is not kept). */
    fun save(nowMs: Long): SavedGame = SavedGame(
        givens = board.givensString(),
        entries = board.toCompactString(),
        notes = notes.toMaskArray().toList(),
        elapsedMs = elapsedMs(nowMs),
        completed = isComplete,
    )

    /** [nowMs] is only needed when the change can solve the board, i.e. a placement. */
    private fun record(nextBoard: Board, nextNotes: Notes, nowMs: Long?): Game {
        val nextHistory = history + Snapshot(board, notes)
        if (nowMs != null && nextBoard.isSolved) {
            val elapsed = timer.elapsedMs(nowMs)
            return Game(nextBoard, Notes.Empty, ElapsedTimer.paused(elapsed), elapsed, emptyList())
        }
        return Game(nextBoard, nextNotes, timer, null, nextHistory)
    }

    private fun copy(timer: ElapsedTimer): Game = Game(board, notes, timer, completedElapsedMs, history)

    companion object {
        /** A fresh game with the timer not yet started; call [resume] when play begins. */
        fun new(givens: String): Game {
            val board = Board.parse(givens)
            require(board.givenCount > 0) { "puzzle has no givens" }
            return Game(board, Notes.Empty, ElapsedTimer.NotStarted, null, emptyList())
        }

        /** Restores a saved game, paused. */
        fun restore(saved: SavedGame): Game {
            val board = Board.restore(saved.givens, saved.entries)
            val notes = Notes.fromMasks(saved.notes.toIntArray())
            val completed = saved.completed && board.isSolved
            return Game(
                board,
                if (completed) Notes.Empty else notes,
                ElapsedTimer.paused(saved.elapsedMs),
                if (completed) saved.elapsedMs else null,
                emptyList(),
            )
        }
    }
}

/** Plain, serialisable game state for local persistence. */
@Serializable
data class SavedGame(
    val givens: String,
    val entries: String,
    val notes: List<Int>,
    val elapsedMs: Long,
    val completed: Boolean,
)
