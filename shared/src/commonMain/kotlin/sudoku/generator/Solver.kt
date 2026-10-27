package sudoku.generator

import sudoku.core.Geometry

/**
 * Backtracking Sudoku solver on bitmasks.
 *
 * Grids are `IntArray`s of 81 values with `0` for empty. Search always picks the
 * empty cell with the fewest candidates (lowest index on ties) and tries digits
 * in ascending order, so results are fully deterministic. The hot path uses only
 * `Int` arithmetic, which keeps it fast on Kotlin/JS.
 */
object Solver {
    /**
     * Counts solutions of [cells], stopping as soon as [limit] are found.
     * `countSolutions(grid, 2) == 1` is the uniqueness check.
     */
    fun countSolutions(cells: IntArray, limit: Int = 2): Int {
        require(limit >= 1) { "limit must be at least 1" }
        val search = Search(cells) ?: return 0
        search.limit = limit
        search.run()
        return search.count
    }

    fun hasUniqueSolution(cells: IntArray): Boolean = countSolutions(cells, 2) == 1

    /** The first solution in search order, or `null` if there is none. */
    fun solve(cells: IntArray): IntArray? {
        val search = Search(cells) ?: return null
        search.limit = 1
        search.run()
        return search.first
    }

    /**
     * A complete valid grid built by searching from [cells] (typically empty)
     * with candidate digits tried in an order drawn from [random].
     */
    internal fun randomSolution(cells: IntArray, random: Xoshiro256StarStar): IntArray? {
        val search = Search(cells) ?: return null
        search.limit = 1
        search.random = random
        search.run()
        return search.first
    }
}

private val ROW = IntArray(Geometry.CELLS) { Geometry.rowOf(it) }
private val COL = IntArray(Geometry.CELLS) { Geometry.colOf(it) }
private val BOX = IntArray(Geometry.CELLS) { Geometry.boxOf(it) }
private const val ALL = 0x1ff

private class Search private constructor(private val grid: IntArray) {
    private val rows = IntArray(9)
    private val cols = IntArray(9)
    private val boxes = IntArray(9)
    private val digits = IntArray(9)

    var limit = 2
    var random: Xoshiro256StarStar? = null
    var count = 0
    var first: IntArray? = null

    fun run() {
        search()
    }

    /** Returns true when the search should stop. */
    private fun search(): Boolean {
        var best = -1
        var bestMask = 0
        var bestCount = 10
        for (i in 0 until Geometry.CELLS) {
            if (grid[i] != 0) continue
            val mask = ALL and (rows[ROW[i]] or cols[COL[i]] or boxes[BOX[i]]).inv()
            val n = mask.countOneBits()
            if (n < bestCount) {
                best = i
                bestMask = mask
                bestCount = n
                if (n <= 1) break
            }
        }
        if (best < 0) {
            count++
            if (first == null) first = grid.copyOf()
            return count >= limit
        }
        if (bestCount == 0) return false

        val rng = random
        if (rng == null) {
            var mask = bestMask
            while (mask != 0) {
                val bit = mask and -mask
                if (tryDigit(best, bit.countTrailingZeroBits() + 1)) return true
                mask = mask xor bit
            }
        } else {
            var n = 0
            var mask = bestMask
            while (mask != 0) {
                val bit = mask and -mask
                digits[n++] = bit.countTrailingZeroBits() + 1
                mask = mask xor bit
            }
            // Shuffle a local copy: `digits` is reused by deeper levels.
            val order = digits.copyOf(n)
            rng.shuffle(order)
            for (d in order) if (tryDigit(best, d)) return true
        }
        return false
    }

    private fun tryDigit(i: Int, d: Int): Boolean {
        val bit = 1 shl (d - 1)
        grid[i] = d
        rows[ROW[i]] = rows[ROW[i]] or bit
        cols[COL[i]] = cols[COL[i]] or bit
        boxes[BOX[i]] = boxes[BOX[i]] or bit
        val stop = search()
        grid[i] = 0
        rows[ROW[i]] = rows[ROW[i]] xor bit
        cols[COL[i]] = cols[COL[i]] xor bit
        boxes[BOX[i]] = boxes[BOX[i]] xor bit
        return stop
    }

    companion object {
        /** A search over a copy of [cells], or `null` if the givens already conflict. */
        operator fun invoke(cells: IntArray): Search? {
            require(cells.size == Geometry.CELLS) { "expected ${Geometry.CELLS} cells, got ${cells.size}" }
            val s = Search(cells.copyOf())
            for (i in 0 until Geometry.CELLS) {
                val d = cells[i]
                if (d == 0) continue
                require(d in 1..9) { "cell value out of range at $i: $d" }
                val bit = 1 shl (d - 1)
                if ((s.rows[ROW[i]] or s.cols[COL[i]] or s.boxes[BOX[i]]) and bit != 0) return null
                s.rows[ROW[i]] = s.rows[ROW[i]] or bit
                s.cols[COL[i]] = s.cols[COL[i]] or bit
                s.boxes[BOX[i]] = s.boxes[BOX[i]] or bit
            }
            return s
        }
    }
}
