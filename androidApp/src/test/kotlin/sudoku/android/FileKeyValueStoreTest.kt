package sudoku.android

import kotlinx.serialization.builtins.serializer
import org.junit.Rule
import org.junit.rules.TemporaryFolder
import sudoku.data.DevUser
import sudoku.data.Settings
import sudoku.data.StoredValue
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

class FileKeyValueStoreTest {
    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun roundTripsUpdatesAndDeletes() {
        val f = StoredValue(FileKeyValueStore(File(tmp.root, "sub")), "x", Settings.serializer())
        assertNull(f.read())
        f.write(Settings("https://a", DevUser("a", "A")))
        assertEquals(Settings("https://a", DevUser("a", "A")), f.read())
        assertEquals("""{"serverUrl":"https://a","devUser":{"sub":"a","name":"A"}}""", File(tmp.root, "sub/x.json").readText())
        f.update { it?.copy(devUser = null) }
        assertEquals(Settings("https://a"), f.read())
        f.write(null)
        assertNull(f.read())
        assertFalse(File(tmp.root, "sub/x.json").exists())
        assertFalse(File(tmp.root, "sub/x.json.tmp").exists())
    }

    @Test
    fun corruptFilesReadAsNull() {
        File(tmp.root, "bad.json").writeText("{not json")
        assertNull(StoredValue(FileKeyValueStore(tmp.root), "bad", Int.serializer()).read())
    }

    @Test
    fun keepsTheFileNamesOfEarlierVersions() {
        val storage = AppStorage(tmp.root)
        storage.settings.write(Settings("https://a"))
        storage.week.update { null }
        assertEquals(listOf("settings.json"), tmp.root.list()!!.toList())
        File(tmp.root, "pending.json").writeText("""[{"date":"2026-10-26","level":1,"elapsedMs":5,"completedAt":"x"}]""")
        assertEquals(1, kotlinx.coroutines.runBlocking { storage.pending.load() }.size)
    }
}
