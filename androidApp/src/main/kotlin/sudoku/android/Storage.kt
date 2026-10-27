package sudoku.android

import kotlinx.datetime.LocalDate
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import sudoku.api.DayResult
import sudoku.api.GameResult
import sudoku.api.Me
import sudoku.api.OidcConfig
import sudoku.api.SudokuApi
import sudoku.api.WeekResponse
import sudoku.auth.StoredTokens
import sudoku.auth.TokenStore
import sudoku.game.SavedGame
import sudoku.sync.PendingResultStore
import java.io.File

/**
 * One JSON document in a file. Writes go to a temporary file that's then
 * renamed over the original, so a crash mid-write never leaves a torn file.
 * Unreadable files read as `null`.
 */
class JsonFile<T>(private val file: File, private val serializer: KSerializer<T>) {
    @Synchronized
    fun read(): T? = try {
        if (file.exists()) SudokuApi.json.decodeFromString(serializer, file.readText()) else null
    } catch (e: Exception) {
        null
    }

    @Synchronized
    fun write(value: T?) {
        if (value == null) {
            file.delete()
            return
        }
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(SudokuApi.json.encodeToString(serializer, value))
        if (!tmp.renameTo(file)) {
            file.delete()
            check(tmp.renameTo(file)) { "couldn't write $file" }
        }
    }

    @Synchronized
    fun update(change: (T?) -> T?) = write(change(read()))
}

@Serializable
data class Settings(
    val serverUrl: String = "",
    /** Set when signed in through the server's dev auth mode. */
    val devUser: DevUser? = null,
    /** Set when signed in with OIDC: the provider from the server's `/config`. */
    val oidc: OidcConfig? = null,
)

/** An OIDC sign-in waiting for the browser to redirect back. */
@Serializable
data class PendingAuth(
    val serverUrl: String,
    val oidc: OidcConfig,
    val state: String,
    val verifier: String,
    val nonce: String,
    val createdAtEpochMs: Long,
)

@Serializable
data class DevUser(val sub: String, val name: String)

/** Everything the app keeps on disk, under [dir] (the app's private files directory). */
class AppStorage(dir: File) {
    val settings = JsonFile(File(dir, "settings.json"), Settings.serializer())

    /** The current week's seed: exactly one week is kept. */
    val week = JsonFile(File(dir, "week.json"), WeekResponse.serializer())

    val me = JsonFile(File(dir, "me.json"), Me.serializer())

    /** OIDC tokens (app-private storage). */
    val tokens = JsonFile(File(dir, "tokens.json"), StoredTokens.serializer())

    val pendingAuth = JsonFile(File(dir, "auth-pending.json"), PendingAuth.serializer())

    /** Games in progress or finished, keyed by [gameKey]. Only the cached week's are kept. */
    val games = JsonFile(File(dir, "games.json"), MapSerializer(String.serializer(), SavedGame.serializer()))

    /** The server's record of the user's results, by date (only recent dates are kept). */
    val serverResults = JsonFile(
        File(dir, "results.json"),
        MapSerializer(LocalDate.serializer(), ListSerializer(DayResult.serializer())),
    )

    /** The offline result queue. */
    val pending = FilePendingResultStore(JsonFile(File(dir, "pending.json"), ListSerializer(GameResult.serializer())))

    /** Forgets everything tied to the signed-in user, keeping the server URL. */
    fun clearUserData() {
        settings.update { it?.copy(devUser = null, oidc = null) }
        tokens.write(null)
        clearProgress()
    }

    /** Forgets the user's games and results (e.g. when a different account signs in). */
    fun clearProgress() {
        me.write(null)
        games.write(null)
        serverResults.write(null)
        pending.file.write(null)
    }

    companion object {
        fun gameKey(date: LocalDate, level: Int) = "$date/$level"
    }
}

class FileTokenStore(private val file: JsonFile<StoredTokens>) : TokenStore {
    override suspend fun load(): StoredTokens? = file.read()

    override suspend fun save(tokens: StoredTokens?) = file.write(tokens)
}

class FilePendingResultStore(val file: JsonFile<List<GameResult>>) : PendingResultStore {
    override suspend fun load(): List<GameResult> = file.read().orEmpty()

    override suspend fun save(results: List<GameResult>) = file.write(results.ifEmpty { null })
}
