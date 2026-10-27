package sudoku.data

import kotlinx.serialization.KSerializer
import sudoku.api.SudokuApi

/**
 * Durable string storage, one document per key: files on Android,
 * `localStorage` in the browser. Keys are short names like `week` or `games`.
 */
interface KeyValueStore {
    fun get(key: String): String?

    /** Stores [value], or removes the key when it's `null`. */
    fun set(key: String, value: String?)

    /** Read-modify-write. Implementations shared between threads make this atomic. */
    fun update(key: String, change: (String?) -> String?) = set(key, change(get(key)))
}

/** [KeyValueStore] in memory, for tests. */
class InMemoryKeyValueStore : KeyValueStore {
    val values = mutableMapOf<String, String>()

    override fun get(key: String): String? = values[key]

    override fun set(key: String, value: String?) {
        if (value == null) values.remove(key) else values[key] = value
    }
}

/** One JSON document under [key]. A value that doesn't decode reads as `null`. */
class StoredValue<T>(private val store: KeyValueStore, private val key: String, private val serializer: KSerializer<T>) {
    fun read(): T? = decode(store.get(key))

    fun write(value: T?) = store.set(key, encode(value))

    fun update(change: (T?) -> T?) = store.update(key) { encode(change(decode(it))) }

    private fun decode(text: String?): T? = text?.let {
        try {
            SudokuApi.json.decodeFromString(serializer, it)
        } catch (e: Exception) {
            null
        }
    }

    private fun encode(value: T?): String? = value?.let { SudokuApi.json.encodeToString(serializer, it) }
}
