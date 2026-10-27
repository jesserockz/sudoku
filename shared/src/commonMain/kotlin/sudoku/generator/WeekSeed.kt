package sudoku.generator

/**
 * The weekly seed travels as 16 lowercase hex characters (see `docs/API.md`),
 * because JSON numbers can't hold 64-bit integers exactly in JS. In Kotlin it's
 * the same 64-bit pattern held in a `Long`.
 */
object WeekSeed {
    fun parse(hex: String): Long {
        require(hex.length == 16 && hex.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) {
            "week seed must be 16 hex characters: \"$hex\""
        }
        return hex.toULong(16).toLong()
    }

    fun format(seed: Long): String = seed.toULong().toString(16).padStart(16, '0')
}
