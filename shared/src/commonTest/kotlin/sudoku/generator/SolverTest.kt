package sudoku.generator

import sudoku.core.Board
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SolverTest {
    private val puzzle = "530070000600195000098000060800060003400803001700020006060000280000419005000080079"
    private val solution = "534678912672195348198342567859761423426853791713924856961537284287419635345286179"

    private fun cells(s: String) = Board.parse(s).toIntArray()

    @Test
    fun solvesAKnownPuzzle() {
        val solved = Solver.solve(cells(puzzle))!!
        assertEquals(solution, Board.fromGivens(solved).toCompactString())
        assertEquals(1, Solver.countSolutions(cells(puzzle)))
        assertTrue(Solver.hasUniqueSolution(cells(puzzle)))
    }

    @Test
    fun solvesAMinimalSeventeenGivenPuzzle() {
        val hard = "000000010400000000020000000000050407008000300001090000300400200050100000000806000"
        val solved = Solver.solve(cells(hard))!!
        assertTrue(Board.fromGivens(solved).isSolved)
        assertTrue(Solver.hasUniqueSolution(cells(hard)))
    }

    @Test
    fun countsMultipleSolutionsUpToTheLimit() {
        val empty = IntArray(81)
        assertEquals(1, Solver.countSolutions(empty, 1))
        assertEquals(2, Solver.countSolutions(empty, 2))
        assertEquals(5, Solver.countSolutions(empty, 5))
    }

    @Test
    fun clearedDeadlyPatternHasExactlyTwoSolutions() {
        // Four cells in two rows of one band holding a,b / b,a can be swapped,
        // so clearing just those leaves exactly two solutions.
        val grid = cells(solution)
        val pattern = assertNotNull(findDeadlyPattern(grid))
        pattern.forEach { grid[it] = 0 }
        assertEquals(2, Solver.countSolutions(grid, 10))
        assertFalse(Solver.hasUniqueSolution(grid))
    }

    @Test
    fun conflictingGivensHaveNoSolution() {
        val bad = cells(puzzle).also { it[2] = 5 } // second 5 in row 0
        assertEquals(0, Solver.countSolutions(bad))
        assertNull(Solver.solve(bad))
    }

    @Test
    fun deadEndHasNoSolution() {
        // Row 0 has 1..8 in columns 0..7, and column 8 already has a 9 lower down.
        val cells = IntArray(81)
        for (c in 0 until 8) cells[c] = c + 1
        cells[80] = 9
        assertEquals(0, Solver.countSolutions(cells))
    }

    @Test
    fun randomSolutionIsValidAndDeterministic() {
        val a = Solver.randomSolution(IntArray(81), Xoshiro256StarStar(99))!!
        val b = Solver.randomSolution(IntArray(81), Xoshiro256StarStar(99))!!
        assertTrue(Board.fromGivens(a).isSolved)
        assertEquals(a.toList(), b.toList())
    }

    /** Four cells at rows r1,r2 x cols c1,c2 in one band holding a,b / b,a. */
    private fun findDeadlyPattern(g: IntArray): List<Int>? {
        for (r1 in 0 until 9) for (r2 in r1 + 1 until 9) {
            if (r1 / 3 != r2 / 3) continue
            for (c1 in 0 until 9) for (c2 in c1 + 1 until 9) {
                if (g[r1 * 9 + c1] == g[r2 * 9 + c2] && g[r1 * 9 + c2] == g[r2 * 9 + c1]) {
                    return listOf(r1 * 9 + c1, r1 * 9 + c2, r2 * 9 + c1, r2 * 9 + c2)
                }
            }
        }
        return null
    }
}
