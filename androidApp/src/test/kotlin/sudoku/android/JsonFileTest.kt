package sudoku.android

import kotlinx.serialization.builtins.serializer
import org.junit.Rule
import org.junit.rules.TemporaryFolder
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

class JsonFileTest {
    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun roundTripsUpdatesAndDeletes() {
        val f = JsonFile(File(tmp.root, "sub/x.json"), Settings.serializer())
        assertNull(f.read())
        f.write(Settings("https://a", DevUser("a", "A")))
        assertEquals(Settings("https://a", DevUser("a", "A")), f.read())
        f.update { it?.copy(devUser = null) }
        assertEquals(Settings("https://a"), f.read())
        f.write(null)
        assertNull(f.read())
        assertFalse(File(tmp.root, "sub/x.json.tmp").exists())
    }

    @Test
    fun corruptFilesReadAsNull() {
        val file = File(tmp.root, "bad.json").apply { writeText("{not json") }
        assertNull(JsonFile(file, Int.serializer()).read())
    }
}
