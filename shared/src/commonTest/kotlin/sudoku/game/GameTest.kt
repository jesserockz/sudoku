package sudoku.game

import kotlinx.datetime.LocalDate
import sudoku.generator.WeekSeed
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

class GameTest {
    private val puzzle = "530070000600195000098000060800060003400803001700020006060000280000419005000080079"
    private val solution = "534678912672195348198342567859761423426853791713924856961537284287419635345286179"

    private fun digit(i: Int) = solution[i] - '0'

    private fun empties() = (0 until 81).filter { puzzle[it] == '0' }

    /** Fills every empty cell but the last; returns that game and the last index. */
    private fun nearlySolved(start: Game): Pair<Game, Int> {
        var g = start
        val cells = empties()
        for (i in cells.dropLast(1)) g = g.place(i, digit(i), 0)
        return g to cells.last()
    }

    @Test
    fun placeAndEraseDigits() {
        var g = Game.new(puzzle).resume(0)
        g = g.place(2, 4, 100)
        assertEquals(4, g.board[2])
        g = g.place(2, 1, 200)
        assertEquals(1, g.board[2])
        g = g.erase(2)
        assertEquals(0, g.board[2])
        // Givens are never changed.
        assertSame(g, g.place(0, 1, 300))
        assertSame(g, g.erase(0))
    }

    @Test
    fun notesToggleAndAreClearedByPlacement() {
        var g = Game.new(puzzle)
        g = g.toggleNote(2, 1).toggleNote(2, 2).toggleNote(2, 4)
        assertEquals(setOf(1, 2, 4), g.notes[2])
        g = g.toggleNote(2, 2)
        assertEquals(setOf(1, 4), g.notes[2])
        // A peer in the same row noting 4 loses it when 4 is placed at index 2.
        g = g.toggleNote(3, 4).toggleNote(3, 6)
        g = g.place(2, 4, 0)
        assertTrue(g.notes.isEmpty(2))
        assertEquals(setOf(6), g.notes[3])
        // Filled cells and givens don't take notes.
        assertSame(g, g.toggleNote(2, 5))
        assertSame(g, g.toggleNote(0, 5))
    }

    @Test
    fun eraseClearsNotesOfEmptyCell() {
        val g = Game.new(puzzle).toggleNote(2, 1).erase(2)
        assertTrue(g.notes.isEmpty(2))
        assertSame(g, g.erase(2))
    }

    @Test
    fun undoRestoresBoardAndNotes() {
        val start = Game.new(puzzle)
        var g = start.toggleNote(3, 4)
        g = g.place(2, 4, 0) // also strips the 4 note at index 3
        g = g.place(5, 8, 0)
        assertTrue(g.canUndo)
        g = g.undo()
        assertEquals(0, g.board[5])
        g = g.undo()
        assertEquals(0, g.board[2])
        assertEquals(setOf(4), g.notes[3])
        g = g.undo()
        assertEquals(start.board, g.board)
        assertEquals(start.notes, g.notes)
        assertFalse(g.canUndo)
        assertSame(g, g.undo())
    }

    @Test
    fun undoKeepsTheTimerRunning() {
        val g = Game.new(puzzle).resume(0).place(2, 4, 1_000).undo()
        assertTrue(g.timer.isRunning)
        assertEquals(5_000, g.elapsedMs(5_000))
    }

    @Test
    fun solvingCompletesAndStopsTheTimer() {
        val (almost, last) = nearlySolved(Game.new(puzzle).resume(1_000))
        assertFalse(almost.isComplete)
        // A wrong final digit doesn't complete.
        val wrong = almost.place(last, digit(last) % 9 + 1, 50_000)
        assertFalse(wrong.isComplete)
        val done = almost.place(last, digit(last), 61_000)
        assertTrue(done.isComplete)
        assertTrue(done.board.isSolved)
        assertEquals(60_000, done.completedElapsedMs)
        assertEquals(60_000, done.elapsedMs(999_999))
        assertFalse(done.timer.isRunning)
        // Nothing changes a finished game.
        assertFalse(done.canUndo)
        assertSame(done, done.undo())
        assertSame(done, done.place(last, 1, 0))
        assertSame(done, done.erase(last))
        assertSame(done, done.resume(70_000))
    }

    @Test
    fun timerPausesAndResumes() {
        var g = Game.new(puzzle)
        assertEquals(0, g.elapsedMs(10_000))
        g = g.resume(10_000).pause(20_000)
        assertEquals(10_000, g.elapsedMs(500_000))
        g = g.resume(500_000)
        assertEquals(15_000, g.elapsedMs(505_000))
    }

    @Test
    fun saveAndRestore() {
        var g = Game.new(puzzle).resume(0).place(2, 4, 0).toggleNote(3, 6)
        val saved = g.save(nowMs = 12_345)
        assertEquals(puzzle, saved.givens)
        assertEquals(12_345, saved.elapsedMs)
        assertFalse(saved.completed)

        val restored = Game.restore(saved)
        assertEquals(g.board, restored.board)
        assertEquals(g.notes, restored.notes)
        assertFalse(restored.timer.isRunning)
        assertEquals(12_345, restored.elapsedMs(0))
        assertFalse(restored.canUndo)

        val (almost, last) = nearlySolved(Game.new(puzzle).resume(0))
        val done = almost.place(last, digit(last), 9_000)
        val restoredDone = Game.restore(done.save(nowMs = 99_999))
        assertTrue(restoredDone.isComplete)
        assertEquals(9_000, restoredDone.completedElapsedMs)

        // A save claiming completion for an unsolved board isn't trusted.
        assertNull(Game.restore(saved.copy(completed = true)).completedElapsedMs)
    }

    @Test
    fun completedDigits() {
        val (almost, last) = nearlySolved(Game.new(puzzle))
        assertEquals((1..9).toSet() - digit(last), almost.completedDigits())
    }

    @Test
    fun dailyPuzzlesUseTheDateWithinTheWeek() {
        val seed = WeekSeed.parse("9f2c4a1b7e30d5c8")
        val week = GameCalendar.weekOf(LocalDate.parse("2026-10-26"))
        val monday = DailyPuzzles.forDate(seed, week, LocalDate.parse("2026-10-26"))
        assertEquals(5, monday.size)
        assertEquals((1..5).toList(), monday.map { it.difficulty.level })
        assertTrue(monday.all { it.dayOfWeek == 1 })
        assertEquals(7, DailyPuzzles.forDate(seed, week, LocalDate.parse("2026-11-01")).first().dayOfWeek)
        assertFailsWith<IllegalArgumentException> { DailyPuzzles.forDate(seed, week, LocalDate.parse("2026-11-02")) }
    }
}
