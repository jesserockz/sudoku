package sudoku.core

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class GeometryTest {
    @Test
    fun indexRoundTrips() {
        for (r in 0 until 9) for (c in 0 until 9) {
            val i = Geometry.index(r, c)
            assertEquals(r, Geometry.rowOf(i))
            assertEquals(c, Geometry.colOf(i))
        }
        assertFailsWith<IllegalArgumentException> { Geometry.index(9, 0) }
    }

    @Test
    fun boxes() {
        assertEquals(0, Geometry.boxOf(0))
        assertEquals(2, Geometry.boxOf(8))
        assertEquals(4, Geometry.boxOf(40))
        assertEquals(8, Geometry.boxOf(80))
        assertContentEquals(intArrayOf(30, 31, 32, 39, 40, 41, 48, 49, 50), Geometry.boxes[4])
    }

    @Test
    fun everyCellHasTwentyPeers() {
        for (i in 0 until Geometry.CELLS) {
            val peers = Geometry.peers[i]
            assertEquals(20, peers.size)
            assertEquals(20, peers.toSet().size)
            assertEquals(false, i in peers)
        }
        assertContentEquals(
            intArrayOf(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 18, 19, 20, 27, 36, 45, 54, 63, 72),
            Geometry.peers[0],
        )
    }
}
