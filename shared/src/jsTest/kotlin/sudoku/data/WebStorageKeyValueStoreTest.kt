package sudoku.data

import org.w3c.dom.Storage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class WebStorageKeyValueStoreTest {
    /** A minimal stand-in for `localStorage` (Node.js has none). */
    private fun fakeStorage(): Storage = js(
        """({
            items: {},
            getItem: function (k) { return Object.prototype.hasOwnProperty.call(this.items, k) ? this.items[k] : null; },
            setItem: function (k, v) { this.items[k] = String(v); },
            removeItem: function (k) { delete this.items[k]; }
        })""",
    ).unsafeCast<Storage>()

    @Test
    fun storesDocumentsUnderThePrefix() {
        val storage = fakeStorage()
        val settings = AppStorage(WebStorageKeyValueStore({ storage })).settings
        assertNull(settings.read())
        settings.write(Settings("https://a", DevUser("a", "A")))
        assertEquals(Settings("https://a", DevUser("a", "A")), settings.read())
        assertEquals("""{"serverUrl":"https://a","devUser":{"sub":"a","name":"A"}}""", storage.getItem("sudoku.settings"))
        settings.write(null)
        assertNull(storage.getItem("sudoku.settings"))
    }

    @Test
    fun unavailableStorageReadsEmptyAndDropsWrites() {
        val store = WebStorageKeyValueStore({ throw IllegalStateException("SecurityError") })
        store.set("week", "{}")
        assertNull(store.get("week"))
    }
}
