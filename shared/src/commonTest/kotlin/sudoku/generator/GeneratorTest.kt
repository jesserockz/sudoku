package sudoku.generator

import sudoku.core.Board
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue
import kotlin.time.TimeSource

class GeneratorTest {
    private val seed = WeekSeed.parse("9f2c4a1b7e30d5c8")

    @Test
    fun puzzlesAreValidUniqueAndOnTarget() {
        for (day in 1..7) {
            for (p in Generator.generateDay(seed, day)) {
                val label = "day=$day level=${p.level}"
                val solution = Board.parse(p.solution)
                assertTrue(solution.isSolved, "solution solved: $label")
                // Every given matches the solution.
                for (i in 0 until 81) {
                    if (p.givens[i] != '0') assertEquals(p.solution[i], p.givens[i], "given $i: $label")
                }
                val cells = p.board().toIntArray()
                assertEquals(1, Solver.countSolutions(cells), "unique: $label")
                assertEquals(p.solution, Board.fromGivens(Solver.solve(cells)!!).toCompactString())
                assertEquals(p.difficulty.targetGivens, p.givenCount, "given count: $label")
            }
        }
    }

    @Test
    fun generationIsRepeatable() {
        assertEquals(Generator.generate(seed, 3, 5), Generator.generate(seed, 3, 5))
    }

    @Test
    fun everyInputChangesThePuzzle() {
        val base = Generator.generate(seed, 2, 3).givens
        assertNotEquals(base, Generator.generate(seed xor 1L, 2, 3).givens)
        assertNotEquals(base, Generator.generate(seed, 3, 3).givens)
        assertNotEquals(base, Generator.generate(seed, 2, 4).givens)
        // All 35 puzzles of a week are distinct.
        val week = (1..7).flatMap { Generator.generateDay(seed, it) }.map { it.givens }
        assertEquals(35, week.toSet().size)
    }

    @Test
    fun rejectsBadInputs() {
        assertFailsWith<IllegalArgumentException> { Generator.generate(seed, 0, 1) }
        assertFailsWith<IllegalArgumentException> { Generator.generate(seed, 8, 1) }
        assertFailsWith<IllegalArgumentException> { Generator.generate(seed, 1, 6) }
    }

    @Test
    fun difficultyTiers() {
        assertEquals(listOf(40, 36, 32, 28, 24), Difficulty.entries.map { it.targetGivens })
        assertEquals(Difficulty.entries, (1..5).map { Difficulty.forLevel(it, 5) })
    }

    @Test
    fun levelFiveGeneratesQuickly() {
        // Kotlin/JS emulates Long, so this matters most there. The bound is loose
        // to stay reliable on slow CI machines; the printed timings are the signal.
        val mark = TimeSource.Monotonic.markNow()
        var slowestMs = 0L
        for (day in 1..7) {
            val start = TimeSource.Monotonic.markNow()
            Generator.generate(seed, day, 5)
            slowestMs = maxOf(slowestMs, start.elapsedNow().inWholeMilliseconds)
        }
        val totalMs = mark.elapsedNow().inWholeMilliseconds
        println("Level 5 generation: 7 puzzles in ${totalMs}ms, slowest ${slowestMs}ms")
        assertTrue(slowestMs < 5_000, "level 5 took ${slowestMs}ms")
    }
}
