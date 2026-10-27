package sudoku.data

import kotlinx.datetime.LocalDate
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import sudoku.api.DayResult
import sudoku.api.GameResult
import sudoku.api.Me
import sudoku.api.OidcConfig
import sudoku.api.WeekResponse
import sudoku.auth.StoredTokens
import sudoku.auth.TokenStore
import sudoku.game.SavedGame
import sudoku.sync.PendingResultStore

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

/** Everything the clients keep between launches, as documents in a [KeyValueStore]. */
class AppStorage(store: KeyValueStore) {
    val settings = StoredValue(store, "settings", Settings.serializer())

    /** The current week's seed: exactly one week is kept. */
    val week = StoredValue(store, "week", WeekResponse.serializer())

    val me = StoredValue(store, "me", Me.serializer())

    /** OIDC tokens. */
    val tokens = StoredValue(store, "tokens", StoredTokens.serializer())

    val pendingAuth = StoredValue(store, "auth-pending", PendingAuth.serializer())

    /** Games in progress or finished, keyed by [gameKey]. Only the cached week's are kept. */
    val games = StoredValue(store, "games", MapSerializer(String.serializer(), SavedGame.serializer()))

    /** The server's record of the user's results, by date (only recent dates are kept). */
    val serverResults = StoredValue(
        store,
        "results",
        MapSerializer(LocalDate.serializer(), ListSerializer(DayResult.serializer())),
    )

    /** The offline result queue. */
    val pending = StoredPendingResults(StoredValue(store, "pending", ListSerializer(GameResult.serializer())))

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
        pending.value.write(null)
    }

    companion object {
        fun gameKey(date: LocalDate, level: Int) = "$date/$level"
    }
}

class StoredTokenStore(private val value: StoredValue<StoredTokens>) : TokenStore {
    override suspend fun load(): StoredTokens? = value.read()

    override suspend fun save(tokens: StoredTokens?) = value.write(tokens)
}

class StoredPendingResults(val value: StoredValue<List<GameResult>>) : PendingResultStore {
    override suspend fun load(): List<GameResult> = value.read().orEmpty()

    override suspend fun save(results: List<GameResult>) = value.write(results.ifEmpty { null })
}
