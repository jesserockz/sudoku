package sudoku.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertSame
import kotlin.test.assertTrue

class BoardTest {
    // A well-known puzzle and its solution.
    private val puzzle =
        "530070000600195000098000060800060003400803001700020006060000280000419005000080079"
    private val solution =
        "534678912672195348198342567859761423426853791713924856961537284287419635345286179"

    @Test
    fun parsesAndFormats() {
        val board = Board.parse(puzzle)
        assertEquals(puzzle, board.toCompactString())
        assertEquals(30, board.givenCount)
        assertEquals(5, board[0])
        assertEquals(3, board[0, 1])
        assertTrue(board.isGiven(0))
        assertFalse(board.isGiven(2))
        assertTrue(board.isEmpty(2))
    }

    @Test
    fun parseAcceptsDotsAndWhitespace() {
        val dotted = puzzle.replace('0', '.').chunked(9).joinToString("\n")
        assertEquals(Board.parse(puzzle), Board.parse(dotted))
    }

    @Test
    fun parseRejectsBadInput() {
        assertFailsWith<IllegalArgumentException> { Board.parse("123") }
        assertFailsWith<IllegalArgumentException> { Board.parse(puzzle.dropLast(1) + "x") }
    }

    @Test
    fun withIsImmutable() {
        val board = Board.parse(puzzle)
        val next = board.with(2, 4)
        assertEquals(0, board[2])
        assertEquals(4, next[2])
        assertFalse(next.isGiven(2))
        assertEquals(0, next.cleared(2)[2])
        assertSame(board, board.with(2, 0))
    }

    @Test
    fun givensCannotBeChanged() {
        val board = Board.parse(puzzle)
        assertFailsWith<IllegalArgumentException> { board.with(0, 1) }
        assertFailsWith<IllegalArgumentException> { board.with(2, 10) }
        assertFailsWith<IndexOutOfBoundsException> { board.with(81, 1) }
    }

    @Test
    fun canPlaceChecksRowColumnAndBox() {
        val board = Board.parse(puzzle)
        // Cell (0,2): row has 5,3,7; column has 8; box has 5,3,6,9,8.
        assertFalse(board.canPlace(2, 5)) // row and box
        assertFalse(board.canPlace(2, 7)) // row
        assertFalse(board.canPlace(2, 8)) // column and box
        assertFalse(board.canPlace(2, 6)) // box
        assertTrue(board.canPlace(2, 4))
        assertTrue(board.canPlace(2, 1))
    }

    @Test
    fun conflictsAreReportedOnBothCells() {
        val board = Board.parse(puzzle).with(2, 5) // repeats the 5 at index 0
        assertTrue(board.hasConflict(2))
        assertTrue(board.hasConflict(0))
        assertEquals(listOf(0, 2), board.conflicts())
        assertTrue(Board.parse(puzzle).conflicts().isEmpty())
    }

    @Test
    fun solvedRequiresFullAndConflictFree() {
        var board = Board.parse(puzzle)
        assertFalse(board.isSolved)
        for (i in 0 until 81) if (!board.isGiven(i)) board = board.with(i, solution[i] - '0')
        assertTrue(board.isFull)
        assertTrue(board.isSolved)
        assertEquals(solution, board.toCompactString())
        assertEquals(puzzle, board.givensString())

        // Swap two non-given digits in a row: still full, no longer solved.
        val a = board[2]
        val b = board[3]
        val broken = board.with(2, b).with(3, a)
        assertTrue(broken.isFull)
        assertFalse(broken.isSolved)
    }

    @Test
    fun restoreKeepsGivensAndEntries() {
        val entries = "004" + "0".repeat(78)
        val board = Board.restore(puzzle, entries)
        assertEquals(4, board[2])
        assertTrue(board.isGiven(0))
        assertFalse(board.isGiven(2))
        assertEquals(Board.parse(puzzle).with(2, 4), board)
        // Entries may repeat a given's value.
        assertEquals(board, Board.restore(puzzle, board.toCompactString()))
        assertFailsWith<IllegalArgumentException> { Board.restore(puzzle, "1" + "0".repeat(80)) }
    }

    @Test
    fun equalityIsByContent() {
        assertEquals(Board.parse(puzzle), Board.parse(puzzle))
        assertEquals(Board.parse(puzzle).hashCode(), Board.parse(puzzle).hashCode())
        assertNotEquals(Board.parse(puzzle), Board.parse(puzzle).with(2, 4))
        // Same values, different givens.
        assertNotEquals(Board.parse(solution), Board.restore(puzzle, solution))
    }
}
