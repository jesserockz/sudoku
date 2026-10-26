package sudoku.game

import sudoku.core.Geometry

/** Pencil marks: for each cell, the set of candidate digits the player noted. Immutable. */
class Notes private constructor(private val masks: IntArray) {
    operator fun get(index: Int): Set<Int> = (1..9).filterTo(LinkedHashSet()) { has(index, it) }

    fun has(index: Int, digit: Int): Boolean = masks[index] and bit(digit) != 0

    fun isEmpty(index: Int): Boolean = masks[index] == 0

    /** The raw 9-bit mask for a cell: bit `d - 1` set when digit `d` is noted. */
    fun mask(index: Int): Int = masks[index]

    fun toggled(index: Int, digit: Int): Notes = withMask(index, masks[index] xor bit(digit))

    fun cleared(index: Int): Notes = withMask(index, 0)

    /** Removes [digit] from the notes of every cell in [indices]. */
    fun withoutDigit(indices: IntArray, digit: Int): Notes {
        val b = bit(digit)
        if (indices.none { masks[it] and b != 0 }) return this
        val next = masks.copyOf()
        for (i in indices) next[i] = next[i] and b.inv()
        return Notes(next)
    }

    fun toMaskArray(): IntArray = masks.copyOf()

    private fun withMask(index: Int, mask: Int): Notes {
        if (masks[index] == mask) return this
        val next = masks.copyOf()
        next[index] = mask
        return Notes(next)
    }

    override fun equals(other: Any?): Boolean = other is Notes && masks.contentEquals(other.masks)

    override fun hashCode(): Int = masks.contentHashCode()

    companion object {
        val Empty = Notes(IntArray(Geometry.CELLS))

        fun fromMasks(masks: IntArray): Notes {
            require(masks.size == Geometry.CELLS) { "expected ${Geometry.CELLS} masks, got ${masks.size}" }
            require(masks.all { it in 0..0x1ff }) { "note masks must be 9-bit" }
            return Notes(masks.copyOf())
        }

        private fun bit(digit: Int): Int {
            require(digit in 1..9) { "digit out of range: $digit" }
            return 1 shl (digit - 1)
        }
    }
}
