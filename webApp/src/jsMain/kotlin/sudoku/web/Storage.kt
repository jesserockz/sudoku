package sudoku.web

import kotlinx.browser.localStorage
import kotlinx.serialization.KSerializer
import sudoku.api.SudokuApi

/**
 * Small typed wrapper over `localStorage`, for the keys earlier versions kept
 * ([LegacyStorage]). The app's state lives in the shared repository's documents
 * (`WebStorageKeyValueStore`, same `sudoku.` prefix).
 */
object Storage {
    private const val PREFIX = "sudoku."

    fun getString(key: String): String? = runCatching { localStorage.getItem(PREFIX + key) }.getOrNull()

    fun setString(key: String, value: String?) {
        runCatching {
            if (value == null) localStorage.removeItem(PREFIX + key) else localStorage.setItem(PREFIX + key, value)
        }
    }

    fun <T> get(key: String, serializer: KSerializer<T>): T? =
        getString(key)?.let { runCatching { SudokuApi.json.decodeFromString(serializer, it) }.getOrNull() }

    fun <T> set(key: String, serializer: KSerializer<T>, value: T?) =
        setString(key, value?.let { SudokuApi.json.encodeToString(serializer, it) })

    /** Keys (without the prefix) starting with [prefix]. */
    fun keys(prefix: String): List<String> = runCatching {
        (0 until localStorage.length).mapNotNull { localStorage.key(it) }
            .filter { it.startsWith(PREFIX + prefix) }
            .map { it.removePrefix(PREFIX) }
    }.getOrDefault(emptyList())
}
