package sudoku.generator

import sudoku.core.Board
import sudoku.generator.Difficulty.DIABOLICAL
import sudoku.generator.Difficulty.EASY
import sudoku.generator.Difficulty.EXPERT
import sudoku.generator.Difficulty.HARD
import sudoku.generator.Difficulty.MEDIUM
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlin.time.TimeSource

/**
 * Days with other than five games: the five tiers are spread across the games.
 * Like [GeneratorGoldenTest], these run on every target and pin exact output.
 */
class GeneratorLevelsTest {
    private val seed = WeekSeed.parse("9f2c4a1b7e30d5c8")

    @Test
    fun tierSpreadIsPinnedForEveryCount() {
        val expected = mapOf(
            1 to listOf(HARD),
            2 to listOf(EASY, DIABOLICAL),
            3 to listOf(EASY, HARD, DIABOLICAL),
            4 to listOf(EASY, MEDIUM, EXPERT, DIABOLICAL),
            5 to listOf(EASY, MEDIUM, HARD, EXPERT, DIABOLICAL),
            6 to listOf(EASY, MEDIUM, HARD, HARD, EXPERT, DIABOLICAL),
            7 to listOf(EASY, MEDIUM, MEDIUM, HARD, EXPERT, EXPERT, DIABOLICAL),
            8 to listOf(EASY, MEDIUM, MEDIUM, HARD, HARD, EXPERT, EXPERT, DIABOLICAL),
            9 to listOf(EASY, MEDIUM, MEDIUM, HARD, HARD, EXPERT, EXPERT, DIABOLICAL, DIABOLICAL),
            10 to listOf(EASY, EASY, MEDIUM, MEDIUM, HARD, HARD, EXPERT, EXPERT, DIABOLICAL, DIABOLICAL),
        )
        for ((n, tiers) in expected) {
            assertEquals(tiers, (1..n).map { Difficulty.forLevel(it, n) }, "levels=$n")
        }
    }

    @Test
    fun spreadProperties() {
        for (n in 2..Generator.MAX_LEVELS) {
            val tiers = (1..n).map { Difficulty.forLevel(it, n) }
            assertEquals(tiers.sortedBy { it.ordinal }, tiers, "easiest first, levels=$n")
            assertEquals(EASY, tiers.first(), "levels=$n")
            assertEquals(DIABOLICAL, tiers.last(), "levels=$n")
            if (n >= 5) {
                val counts = Difficulty.entries.map { d -> tiers.count { it == d } }
                assertTrue(counts.all { it >= 1 }, "every tier used, levels=$n: $counts")
                assertTrue(counts.max() - counts.min() <= 1, "evenly spread, levels=$n: $counts")
            }
        }
    }

    @Test
    fun titlesNumberRepeatedTiers() {
        assertEquals(
            listOf("Easy", "Medium 1", "Medium 2", "Hard", "Expert 1", "Expert 2", "Diabolical"),
            (1..7).map { Generator.title(it, 7) },
        )
        assertEquals(listOf("Easy", "Medium", "Hard", "Expert", "Diabolical"), (1..5).map { Generator.title(it, 5) })
    }

    @Test
    fun rejectsOutOfRangeGames() {
        assertFailsWith<IllegalArgumentException> { Difficulty.forLevel(0, 5) }
        assertFailsWith<IllegalArgumentException> { Difficulty.forLevel(6, 5) }
        assertFailsWith<IllegalArgumentException> { Difficulty.forLevel(1, 0) }
        assertFailsWith<IllegalArgumentException> { Difficulty.forLevel(1, Generator.MAX_LEVELS + 1) }
        assertFailsWith<IllegalArgumentException> { Generator.generate(seed, 1, 8, 7) }
    }

    @Test
    fun fiveGamesAreTheOriginalPuzzles() {
        // Same seed and tier as the five-level generator, so the same puzzles.
        for (level in 1..5) {
            assertEquals(Generator.generate(seed, 2, level).givens, Generator.generate(seed, 2, level, 5).givens)
        }
        // Games that keep the same number and tier at another count are unchanged too.
        assertEquals(Generator.generate(seed, 1, 1).givens, Generator.generate(seed, 1, 1, 7).givens)
        assertEquals(Generator.generate(seed, 1, 2).givens, Generator.generate(seed, 1, 2, 7).givens)
    }

    private class Golden(val day: Int, val levels: Int, val level: Int, val difficulty: Difficulty, val givens: String)

    private val goldens = listOf(
        Golden(1, 7, 1, EASY, "020091683006050000817600520080405071002080946470069000700918000100006754203000090"),
        Golden(1, 7, 2, MEDIUM, "630897020480650700025031000010005000800019003002068104260004300004003008007006040"),
        Golden(1, 7, 3, MEDIUM, "090054010504002007000830090050009000000520309930760004068203070109070800305180900"),
        Golden(1, 7, 4, HARD, "007008903001570082020004710309000000100206000800490306003000600204000079010000530"),
        Golden(1, 7, 5, EXPERT, "060700300000060000075003460708000005004000000030000020081205000003080009507390280"),
        Golden(1, 7, 6, EXPERT, "080000002294700005000400000907206008006140020000000600020010806408060100009030000"),
        Golden(1, 7, 7, DIABOLICAL, "000070000069020305001000006002004000475100000000500600100000780300000900040009002"),
        Golden(2, 10, 1, EASY, "005006040201504000680000700000209005002063407768400209810390504030642001007158060"),
        Golden(2, 10, 2, EASY, "904031000030087950876940200520890600400006082700123405601079020000018040000000079"),
        Golden(2, 10, 9, DIABOLICAL, "000000005070030409000700010004308000039100000060000570006000098000002000001690300"),
        Golden(2, 10, 10, DIABOLICAL, "001000700000009406009080003080600000000003500507400000000000000003006071906350002"),
        Golden(3, 1, 1, HARD, "003050970050097000700020604300900006006000002071200005060580307500079400030062000"),
        Golden(4, 3, 3, DIABOLICAL, "300000078000306000050000000600021809001000200000980000004510030700000902030009000"),
    )

    @Test
    fun goldenPuzzles() {
        for (g in goldens) {
            val p = Generator.generate(seed, g.day, g.level, g.levels)
            val label = "day=${g.day} levels=${g.levels} level=${g.level}"
            assertEquals(g.difficulty, p.difficulty, label)
            assertEquals(g.givens, p.givens, label)
        }
    }

    @Test
    fun aWeekOfTenGamesADayIsValidUniqueOnTargetAndDistinct() {
        val all = (1..7).flatMap { Generator.generateDay(seed, it, 10) }
        assertEquals(70, all.size)
        for (p in all) {
            val label = "day=${p.dayOfWeek} level=${p.level}"
            assertTrue(Board.parse(p.solution).isSolved, label)
            assertEquals(1, Solver.countSolutions(p.board().toIntArray()), label)
            assertEquals(p.difficulty.targetGivens, p.givenCount, label)
            for (i in 0 until 81) if (p.givens[i] != '0') assertEquals(p.solution[i], p.givens[i], label)
        }
        assertEquals(70, all.map { it.givens }.toSet().size, "every puzzle in the week differs")
    }

    @Test
    fun tenGameDayGeneratesQuickly() {
        val start = TimeSource.Monotonic.markNow()
        Generator.generateDay(seed, 7, 10)
        val ms = start.elapsedNow().inWholeMilliseconds
        println("10-game day: ${ms}ms")
        assertTrue(ms < 10_000, "took ${ms}ms")
    }
}
