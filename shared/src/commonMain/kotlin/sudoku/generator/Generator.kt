package sudoku.generator

import sudoku.core.Board
import sudoku.core.Geometry

/** The five difficulty tiers, driven by a target number of givens. */
enum class Difficulty(val displayName: String, val targetGivens: Int) {
    EASY("Easy", 40),
    MEDIUM("Medium", 36),
    HARD("Hard", 32),
    EXPERT("Expert", 28),
    DIABOLICAL("Diabolical", 24),
    ;

    companion object {
        /**
         * The tier of game [level] (`1..levels`) on a day with [levels] games.
         *
         * Games are spread evenly across the five tiers, easiest first: game `i`
         * (0-based) of `n` gets tier `round(i * 4 / (n - 1))`, computed in exact
         * integer arithmetic (halves round up) so every platform agrees. So:
         * - 5 games: one of each tier (Easy, Medium, Hard, Expert, Diabolical);
         * - 7 games: Easy, Medium, Medium, Hard, Expert, Expert, Diabolical;
         * - 10 games: two of each tier;
         * - 3 games: Easy, Hard, Diabolical; 1 game: Hard.
         */
        fun forLevel(level: Int, levels: Int): Difficulty {
            require(levels in 1..Generator.MAX_LEVELS) { "levels must be 1..${Generator.MAX_LEVELS}: $levels" }
            require(level in 1..levels) { "level must be 1..$levels: $level" }
            if (levels == 1) return HARD
            val i = level - 1
            val last = entries.size - 1
            val tier = (2 * i * last + (levels - 1)) / (2 * (levels - 1))
            return entries[tier]
        }
    }
}

/**
 * A generated puzzle: game [level] of [levels] on a day. [givens] and
 * [solution] are 81-character strings (`0` = empty).
 */
data class Puzzle(
    val weekSeed: Long,
    val dayOfWeek: Int,
    val level: Int,
    val levels: Int,
    val difficulty: Difficulty,
    val givens: String,
    val solution: String,
) {
    val givenCount: Int get() = givens.count { it != '0' }

    /**
     * A display name: the tier's name, numbered when the day has more than one
     * game of that tier (e.g. "Medium 1", "Medium 2").
     */
    val title: String get() = Generator.title(level, levels)

    fun board(): Board = Board.parse(givens)
}

/**
 * Deterministic puzzle generation: [generate] is a pure function of
 * `(weekSeed, dayOfWeek, level, levels)` and returns bit-identical puzzles on
 * every platform. That's what gives the whole family the same daily puzzles.
 *
 * `level` is the game number within the day (`1..levels`, as in the API); its
 * difficulty tier comes from [Difficulty.forLevel]. With the default five games
 * the tiers are Easy..Diabolical in order, and the puzzles are exactly those of
 * the original five-level generator.
 *
 * **Any change to this file, [Solver] or the PRNGs that changes output changes
 * everyone's puzzles.** The golden tests in `GeneratorGoldenTest` catch that; if
 * a change is intentional, bump [VERSION] and update the golden values.
 *
 * Algorithm:
 * 1. Derive a puzzle seed by mixing [VERSION], `weekSeed`, `dayOfWeek` and the
 *    game number `level` with SplitMix64, and seed xoshiro256** from it. Games
 *    sharing a tier on the same day have different numbers, so different seeds.
 * 2. Build a full grid by backtracking search, trying candidates in random order.
 * 3. Visit the cells in a random order, removing each one only if the puzzle
 *    still has a unique solution, until the tier's target given count is hit.
 * 4. If a pass ends above target (cells can't be removed any more), start again
 *    from a fresh grid, up to [MAX_ATTEMPTS] times, and keep the attempt with
 *    the fewest givens (the earliest on ties).
 */
object Generator {
    const val VERSION = 1

    /** Attempts before settling for the closest-to-target puzzle. */
    const val MAX_ATTEMPTS = 8

    /** The default number of games per day. */
    const val DEFAULT_LEVELS = 5

    /** The most games per day the server allows. */
    const val MAX_LEVELS = 10

    fun generate(weekSeed: Long, dayOfWeek: Int, level: Int, levels: Int = DEFAULT_LEVELS): Puzzle {
        require(dayOfWeek in 1..7) { "dayOfWeek must be 1 (Monday) to 7 (Sunday): $dayOfWeek" }
        val difficulty = Difficulty.forLevel(level, levels)
        val random = Xoshiro256StarStar(puzzleSeed(weekSeed, dayOfWeek, level))

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
        return Puzzle(weekSeed, dayOfWeek, level, levels, difficulty, encode(bestGivens!!), encode(bestSolution!!))
    }

    /** All games for a day, in order (easiest first). */
    fun generateDay(weekSeed: Long, dayOfWeek: Int, levels: Int = DEFAULT_LEVELS): List<Puzzle> =
        (1..levels).map { generate(weekSeed, dayOfWeek, it, levels) }

    /** See [Puzzle.title]. */
    fun title(level: Int, levels: Int): String {
        val difficulty = Difficulty.forLevel(level, levels)
        val same = (1..levels).filter { Difficulty.forLevel(it, levels) == difficulty }
        return if (same.size == 1) difficulty.displayName else "${difficulty.displayName} ${same.indexOf(level) + 1}"
    }

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
