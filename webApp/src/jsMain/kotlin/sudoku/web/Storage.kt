package sudoku.web

import kotlinx.browser.localStorage
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import sudoku.api.GameResult
import sudoku.api.SudokuApi
import sudoku.sync.PendingResultStore

/**
 * Small typed wrapper over `localStorage`. Everything the web client keeps is
 * a convenience or a retry queue: if storage is unavailable (private mode, quota)
 * reads come back empty and writes are dropped, and the app still works online.
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

/** The offline result queue for one user, in `localStorage`. */
class LocalPendingResultStore(userId: String) : PendingResultStore {
    private val key = "pending.$userId"
    private val serializer = ListSerializer(GameResult.serializer())

    override suspend fun load(): List<GameResult> = Storage.get(key, serializer) ?: emptyList()

    override suspend fun save(results: List<GameResult>) = Storage.set(key, serializer, results.ifEmpty { null })
}
