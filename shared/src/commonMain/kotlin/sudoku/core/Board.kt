package sudoku.core

/**
 * An immutable 9x9 Sudoku board: the puzzle's givens plus the player's entries.
 *
 * Values are `1..9`, with `0` meaning empty. Given cells can't be changed.
 * Every mutation returns a new [Board], which keeps it safe to hold in UI state.
 */
class Board private constructor(
    private val cells: IntArray,
    private val given: BooleanArray,
) {
    operator fun get(index: Int): Int = cells[checkIndex(index)]

    operator fun get(row: Int, col: Int): Int = cells[Geometry.index(row, col)]

    fun isGiven(index: Int): Boolean = given[checkIndex(index)]

    fun isEmpty(index: Int): Boolean = get(index) == EMPTY

    /** Returns a board with [digit] (`1..9`, or `0` to clear) placed at [index]. */
    fun with(index: Int, digit: Int): Board {
        checkIndex(index)
        require(digit in EMPTY..9) { "digit out of range: $digit" }
        require(!given[index]) { "cell $index is a given" }
        if (cells[index] == digit) return this
        val next = cells.copyOf()
        next[index] = digit
        return Board(next, given)
    }

    fun cleared(index: Int): Board = with(index, EMPTY)

    /**
     * Whether [digit] could go at [index] without repeating a digit already in
     * that cell's row, column or box. The cell's own current value is ignored.
     */
    fun canPlace(index: Int, digit: Int): Boolean {
        checkIndex(index)
        require(digit in 1..9) { "digit out of range: $digit" }
        return Geometry.peers[index].none { cells[it] == digit }
    }

    /** Whether the cell holds a digit that also appears in one of its peers. */
    fun hasConflict(index: Int): Boolean {
        val d = get(index)
        return d != EMPTY && Geometry.peers[index].any { cells[it] == d }
    }

    /** Indices of every filled cell whose digit repeats in a row, column or box, ascending. */
    fun conflicts(): List<Int> = (0 until Geometry.CELLS).filter { hasConflict(it) }

    val filledCount: Int get() = cells.count { it != EMPTY }

    val givenCount: Int get() = given.count { it }

    val isFull: Boolean get() = cells.none { it == EMPTY }

    /** Every cell filled with no repeated digit in any row, column or box. */
    val isSolved: Boolean get() = isFull && conflicts().isEmpty()

    /** The values as an `IntArray` copy (index order, `0` = empty). */
    fun toIntArray(): IntArray = cells.copyOf()

    /** A board holding only the givens. */
    fun givensOnly(): Board = Board(IntArray(Geometry.CELLS) { if (given[it]) cells[it] else EMPTY }, given)

    /** 81 characters, `1`-`9` for digits and `0` for empty cells. */
    fun toCompactString(): String = buildString(Geometry.CELLS) { cells.forEach { append('0' + it) } }

    /** Givens only, in the same format as [toCompactString]. */
    fun givensString(): String = givensOnly().toCompactString()

    override fun equals(other: Any?): Boolean =
        other is Board && cells.contentEquals(other.cells) && given.contentEquals(other.given)

    override fun hashCode(): Int = 31 * cells.contentHashCode() + given.contentHashCode()

    override fun toString(): String = "Board(${toCompactString()})"

    companion object {
        const val EMPTY = 0

        /**
         * A puzzle from 81 characters: `1`-`9` are givens, `0` or `.` are empty.
         * Whitespace is ignored so grids can be written over several lines.
         */
        fun parse(puzzle: String): Board {
            val values = parseCells(puzzle)
            return Board(values, BooleanArray(Geometry.CELLS) { values[it] != EMPTY })
        }

        /** A puzzle from cell values (`0` = empty); every non-zero value is a given. */
        fun fromGivens(values: IntArray): Board {
            require(values.size == Geometry.CELLS) { "expected ${Geometry.CELLS} cells, got ${values.size}" }
            require(values.all { it in EMPTY..9 }) { "cell values must be 0..9" }
            return Board(values.copyOf(), BooleanArray(Geometry.CELLS) { values[it] != EMPTY })
        }

        /**
         * Restores a board in progress from its [puzzle] (givens) and the player's
         * [entries] (same format; values in given cells must match or be empty).
         */
        fun restore(puzzle: String, entries: String): Board {
            val board = parse(puzzle)
            val values = parseCells(entries)
            val cells = board.cells.copyOf()
            for (i in 0 until Geometry.CELLS) {
                if (board.given[i]) {
                    require(values[i] == EMPTY || values[i] == cells[i]) { "entry at $i overwrites a given" }
                } else {
                    cells[i] = values[i]
                }
            }
            return Board(cells, board.given)
        }

        private fun parseCells(s: String): IntArray {
            val chars = s.filterNot { it.isWhitespace() }
            require(chars.length == Geometry.CELLS) { "expected ${Geometry.CELLS} cells, got ${chars.length}" }
            return IntArray(Geometry.CELLS) { i ->
                when (val c = chars[i]) {
                    '.', '0' -> EMPTY
                    in '1'..'9' -> c - '0'
                    else -> throw IllegalArgumentException("invalid cell '$c' at $i")
                }
            }
        }
    }
}

private fun checkIndex(index: Int): Int {
    if (index !in 0 until Geometry.CELLS) throw IndexOutOfBoundsException("cell index out of range: $index")
    return index
}
