package sudoku.generator

/**
 * Deterministic pseudo-random numbers for puzzle generation.
 *
 * This is deliberately not `kotlin.random.Random`, whose output is only
 * guaranteed within one Kotlin version. Everything here is plain 64-bit
 * integer arithmetic, which is exact on every target (on Kotlin/JS `Long` is
 * emulated, but still exact), so a seed produces the same sequence everywhere.
 *
 * The generator is xoshiro256** (Blackman and Vigna), seeded from SplitMix64
 * as its authors recommend.
 */
class Xoshiro256StarStar(seed: Long) {
    private var s0: Long
    private var s1: Long
    private var s2: Long
    private var s3: Long

    init {
        val sm = SplitMix64(seed)
        s0 = sm.next()
        s1 = sm.next()
        s2 = sm.next()
        s3 = sm.next()
    }

    fun nextLong(): Long {
        val result = rotl(s1 * 5, 7) * 9
        val t = s1 shl 17
        s2 = s2 xor s0
        s3 = s3 xor s1
        s1 = s1 xor s2
        s0 = s0 xor s3
        s2 = s2 xor t
        s3 = rotl(s3, 45)
        return result
    }

    /** A uniformly distributed integer in `0 until bound`, without modulo bias. */
    fun nextInt(bound: Int): Int {
        require(bound > 0) { "bound must be positive: $bound" }
        // Take the top 32 bits as an unsigned value and reject the uneven tail.
        val range = 1L shl 32
        val limit = range - range % bound
        while (true) {
            val r = nextLong() ushr 32
            if (r < limit) return (r % bound).toInt()
        }
    }

    /** Fisher-Yates shuffle of [array] in place. */
    fun shuffle(array: IntArray) {
        for (i in array.size - 1 downTo 1) {
            val j = nextInt(i + 1)
            val tmp = array[i]
            array[i] = array[j]
            array[j] = tmp
        }
    }

    private fun rotl(x: Long, k: Int): Long = (x shl k) or (x ushr (64 - k))
}

/** SplitMix64 (Steele, Lea and Flood), used for seeding and for mixing seed inputs. */
class SplitMix64(private var state: Long) {
    fun next(): Long {
        state += GOLDEN_GAMMA
        return mix(state)
    }

    companion object {
        const val GOLDEN_GAMMA: Long = -0x61c8864680b583ebL // 0x9e3779b97f4a7c15

        /** The SplitMix64 output function: a strong 64-bit bijective mixer. */
        fun mix(value: Long): Long {
            var z = value
            z = (z xor (z ushr 30)) * -0x40a7b892e31b1a47L // 0xbf58476d1ce4e5b9
            z = (z xor (z ushr 27)) * -0x6b2fb644ecceee15L // 0x94d049bb133111eb
            return z xor (z ushr 31)
        }
    }
}
