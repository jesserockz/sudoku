package sudoku.data

import org.w3c.dom.Storage

/**
 * A [KeyValueStore] over Web Storage (`localStorage`), with every key under
 * [prefix]. Storage can be unavailable (private mode, quota, blocked site
 * data): reads then come back empty and writes are dropped, so the app still
 * works online.
 */
class WebStorageKeyValueStore(private val storage: () -> Storage, private val prefix: String = "sudoku.") : KeyValueStore {
    override fun get(key: String): String? = try {
        storage().getItem(prefix + key)
    } catch (e: Throwable) {
        null
    }

    override fun set(key: String, value: String?) {
        try {
            if (value == null) storage().removeItem(prefix + key) else storage().setItem(prefix + key, value)
        } catch (e: Throwable) {
            // Dropped; see the class comment.
        }
    }
}
