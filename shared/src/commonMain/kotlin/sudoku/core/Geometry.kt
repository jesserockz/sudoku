package sudoku.core

/**
 * Fixed geometry of a classic 9x9 Sudoku grid.
 *
 * Cells are addressed by a flat index `0..80` in row-major order:
 * `index = row * 9 + col`. Boxes are numbered `0..8` left-to-right,
 * top-to-bottom.
 */
object Geometry {
    const val SIZE = 9
    const val BOX = 3
    const val CELLS = SIZE * SIZE

    fun index(row: Int, col: Int): Int {
        require(row in 0 until SIZE && col in 0 until SIZE) { "row/col out of range: ($row, $col)" }
        return row * SIZE + col
    }

    fun rowOf(index: Int): Int = index / SIZE

    fun colOf(index: Int): Int = index % SIZE

    fun boxOf(index: Int): Int = (rowOf(index) / BOX) * BOX + colOf(index) / BOX

    /** Cell indices of each row, column and box, in ascending order. */
    val rows: List<IntArray> = List(SIZE) { r -> IntArray(SIZE) { c -> r * SIZE + c } }
    val cols: List<IntArray> = List(SIZE) { c -> IntArray(SIZE) { r -> r * SIZE + c } }
    val boxes: List<IntArray> = List(SIZE) { b ->
        val r0 = (b / BOX) * BOX
        val c0 = (b % BOX) * BOX
        IntArray(SIZE) { k -> (r0 + k / BOX) * SIZE + c0 + k % BOX }
    }

    /** The 20 cells sharing a row, column or box with each cell, ascending. */
    val peers: List<IntArray> = List(CELLS) { i ->
        (0 until CELLS).filter { j ->
            j != i && (rowOf(j) == rowOf(i) || colOf(j) == colOf(i) || boxOf(j) == boxOf(i))
        }.toIntArray()
    }
}
