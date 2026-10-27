package sudoku.generator

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class RandomTest {
    // Reference values computed from the published C algorithms (independent Python port).
    @Test
    fun splitMix64MatchesReference() {
        val sm = SplitMix64(1234567)
        assertEquals(6457827717110365317L, sm.next())
        assertEquals(3203168211198807973L, sm.next())
        assertEquals(-8629252141511181193L, sm.next()) // 9817491932198370423 unsigned
    }

    @Test
    fun xoshiro256StarStarMatchesReference() {
        val x = Xoshiro256StarStar(42)
        assertContentEquals(
            longArrayOf(1546998764402558742L, 6990951692964543102L, -5902157311460992607L, -1389169964527427423L),
            LongArray(4) { x.nextLong() },
        )
    }

    @Test
    fun nextIntStaysInRangeAndCoversIt() {
        val x = Xoshiro256StarStar(7)
        val seen = IntArray(9)
        repeat(9000) {
            val v = x.nextInt(9)
            assertTrue(v in 0 until 9)
            seen[v]++
        }
        assertTrue(seen.all { it in 800..1200 }, "skewed distribution: ${seen.toList()}")
        assertEquals(0, x.nextInt(1))
        assertFailsWith<IllegalArgumentException> { x.nextInt(0) }
    }

    @Test
    fun nextIntSequenceIsPinned() {
        // Generation depends on exactly this sequence (checked against the Python reference).
        val x = Xoshiro256StarStar(42)
        assertContentEquals(intArrayOf(6, 2, 6, 1, 8, 7, 2, 6), IntArray(8) { x.nextInt(9) })
    }

    @Test
    fun shuffleIsAPermutation() {
        val a = IntArray(81) { it }
        Xoshiro256StarStar(1).shuffle(a)
        assertEquals((0 until 81).toList(), a.sorted())
        val b = IntArray(81) { it }
        Xoshiro256StarStar(1).shuffle(b)
        assertContentEquals(a, b)
    }
}
