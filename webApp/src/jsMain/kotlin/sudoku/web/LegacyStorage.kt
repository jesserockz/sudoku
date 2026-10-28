package sudoku.web

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.datetime.LocalDate
import sudoku.api.AppConfig
import sudoku.api.AuthMode
import sudoku.api.GameResult
import sudoku.auth.StoredTokens
import sudoku.data.AppStorage
import sudoku.data.DevUser
import sudoku.data.Settings
import sudoku.data.SudokuRepository
import sudoku.game.SavedGame

/**
 * Moves what earlier versions of the web app kept in `localStorage` into the
 * shared repository's documents, so an update keeps people signed in and keeps
 * their games and queued results. Each legacy key is removed once migrated.
 *
 * Earlier keys (all prefixed `sudoku.`): `devUser`, `oidc.tokens`,
 * `pending.<userId>` and `game.<userId>.<date>.<level>`.
 */
object LegacyStorage {
    @Serializable
    private data class LegacyDevUser(val sub: String, val name: String)

    /** Dev auth sign-in: needs nothing from the server, so it migrates offline too. */
    fun migrateIdentity(storage: AppStorage, origin: String) {
        val dev = Storage.get(DEV_USER, LegacyDevUser.serializer()) ?: return
        if (storage.settings.read()?.let { it.devUser != null || it.oidc != null } != true) {
            storage.settings.write(Settings(origin, DevUser(dev.sub, dev.name)))
        }
        Storage.setString(DEV_USER, null)
    }

    /** OIDC tokens: needs the server's provider settings. Returns whether it signed the user in. */
    fun migrateOidcTokens(storage: AppStorage, origin: String, config: AppConfig): Boolean {
        val tokens = Storage.get(OIDC_TOKENS, StoredTokens.serializer()) ?: return false
        Storage.setString(OIDC_TOKENS, null)
        val oidc = config.oidc?.takeIf { config.authMode == AuthMode.OIDC } ?: return false
        storage.tokens.write(tokens)
        storage.settings.write(Settings(origin, oidc = oidc))
        return true
    }

    /**
     * The signed-in user's queued results and saved games (other users' stay
     * where they are). Needs `me`, so it runs after a sync. Returns whether any
     * results were queued.
     */
    suspend fun migrateProgress(storage: AppStorage, repo: SudokuRepository): Boolean {
        val id = repo.me()?.id ?: return false
        val pending = Storage.get("pending.$id", ListSerializer(GameResult.serializer())).orEmpty()
        pending.forEach { repo.sync.enqueue(it) }
        Storage.setString("pending.$id", null)

        val week = repo.weekFor()?.toWeekInfo()
        for (key in Storage.keys("game.$id.")) {
            val (date, level) = key.removePrefix("game.$id.").split('.').let { it[0] to it[1] }
            val game = Storage.get(key, SavedGame.serializer())
            val day = runCatching { LocalDate.parse(date) }.getOrNull()
            if (game != null && day != null && week != null && day in week) {
                val k = AppStorage.gameKey(day, level.toIntOrNull() ?: continue)
                storage.games.update { games -> if (games?.containsKey(k) == true) games else games.orEmpty() + (k to game) }
            }
            Storage.setString(key, null)
        }
        return pending.isNotEmpty()
    }

    private const val DEV_USER = "devUser"
    private const val OIDC_TOKENS = "oidc.tokens"
}
