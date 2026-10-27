package sudoku.generator

import sudoku.core.Board
import sudoku.core.Geometry

/** The five daily difficulty tiers, driven by a target number of givens. */
enum class Difficulty(val level: Int, val displayName: String, val targetGivens: Int) {
    EASY(1, "Easy", 40),
    MEDIUM(2, "Medium", 36),
    HARD(3, "Hard", 32),
    EXPERT(4, "Expert", 28),
    DIABOLICAL(5, "Diabolical", 24),
    ;

    companion object {
        fun of(level: Int): Difficulty =
            entries.firstOrNull { it.level == level } ?: throw IllegalArgumentException("unknown level: $level")
    }
}

/** A generated puzzle. [givens] and [solution] are 81-character strings (`0` = empty). */
data class Puzzle(
    val weekSeed: Long,
    val dayOfWeek: Int,
    val difficulty: Difficulty,
    val givens: String,
    val solution: String,
) {
    val givenCount: Int get() = givens.count { it != '0' }

    fun board(): Board = Board.parse(givens)
}

/**
 * Deterministic puzzle generation: [generate] is a pure function of
 * `(weekSeed, dayOfWeek, level)` and returns bit-identical puzzles on every
 * platform. That's what gives the whole family the same daily puzzles.
 *
 * **Any change to this file, [Solver] or the PRNGs that changes output changes
 * everyone's puzzles.** The golden tests in `GeneratorGoldenTest` catch that; if
 * a change is intentional, bump [VERSION] and update the golden values.
 *
 * Algorithm:
 * 1. Derive a puzzle seed by mixing [VERSION], `weekSeed`, `dayOfWeek` and
 *    `level` with SplitMix64, and seed xoshiro256** from it.
 * 2. Build a full grid by backtracking search, trying candidates in random order.
 * 3. Visit the cells in a random order, removing each one only if the puzzle
 *    still has a unique solution, until the level's target given count is hit.
 * 4. If a pass ends above target (cells can't be removed any more), start again
 *    from a fresh grid, up to [MAX_ATTEMPTS] times, and keep the attempt with
 *    the fewest givens (the earliest on ties).
 */
object Generator {
    const val VERSION = 1

    /** Attempts before settling for the closest-to-target puzzle. */
    const val MAX_ATTEMPTS = 8

    fun generate(weekSeed: Long, dayOfWeek: Int, level: Int): Puzzle =
        generate(weekSeed, dayOfWeek, Difficulty.of(level))

    fun generate(weekSeed: Long, dayOfWeek: Int, difficulty: Difficulty): Puzzle {
        require(dayOfWeek in 1..7) { "dayOfWeek must be 1 (Monday) to 7 (Sunday): $dayOfWeek" }
        val random = Xoshiro256StarStar(puzzleSeed(weekSeed, dayOfWeek, difficulty.level))

        var bestGivens: IntArray? = null
        var bestSolution: IntArray? = null
        var bestCount = Int.MAX_VALUE
        for (attempt in 0 until MAX_ATTEMPTS) {
            val solution = Solver.randomSolution(IntArray(Geometry.CELLS), random)
                ?: error("an empty grid always has a solution")
            val givens = removeCells(solution, difficulty.targetGivens, random)
            val count = givens.count { it != 0 }
            if (count < bestCount) {
                bestGivens = givens
                bestSolution = solution
                bestCount = count
            }
            if (count <= difficulty.targetGivens) break
        }
        return Puzzle(weekSeed, dayOfWeek, difficulty, encode(bestGivens!!), encode(bestSolution!!))
    }

    /** All five puzzles for a day, Easy to Diabolical. */
    fun generateDay(weekSeed: Long, dayOfWeek: Int): List<Puzzle> =
        Difficulty.entries.map { generate(weekSeed, dayOfWeek, it) }

    /** The seed for one puzzle: every input passes through a full SplitMix64 mix. */
    internal fun puzzleSeed(weekSeed: Long, dayOfWeek: Int, level: Int): Long {
        var h = SplitMix64.mix(DOMAIN + VERSION)
        h = SplitMix64.mix(h xor weekSeed)
        h = SplitMix64.mix(h + dayOfWeek)
        h = SplitMix64.mix(h + level)
        return h
    }

    private fun removeCells(solution: IntArray, target: Int, random: Xoshiro256StarStar): IntArray {
        val grid = solution.copyOf()
        val order = IntArray(Geometry.CELLS) { it }
        random.shuffle(order)
        var count = Geometry.CELLS
        for (i in order) {
            if (count <= target) break
            val digit = grid[i]
            grid[i] = 0
            if (Solver.hasUniqueSolution(grid)) count-- else grid[i] = digit
        }
        return grid
    }

    private fun encode(cells: IntArray): String = buildString(Geometry.CELLS) { cells.forEach { append('0' + it) } }

    /** "sudoku" in ASCII; separates this seed derivation from any other use of the week seed. */
    private const val DOMAIN: Long = 0x7375646f6b75L
}
