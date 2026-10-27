package sudoku.data

import io.ktor.client.engine.HttpClientEngine
import io.ktor.http.parseQueryString
import kotlinx.coroutines.CancellationException
import kotlinx.datetime.LocalDate
import sudoku.api.AppConfig
import sudoku.api.DayResult
import sudoku.api.DevAuth
import sudoku.api.GameResult
import sudoku.api.Leaderboard
import sudoku.api.Me
import sudoku.api.OidcConfig
import sudoku.api.SudokuApi
import sudoku.api.TokenProvider
import sudoku.api.WeekResponse
import sudoku.auth.OidcClient
import sudoku.auth.Pkce
import sudoku.auth.TokenSession
import sudoku.auth.randomToken
import sudoku.game.Game
import sudoku.game.GameCalendar
import sudoku.generator.Puzzle
import sudoku.sync.FlushReport
import sudoku.sync.ResultSync
import kotlin.time.Clock

/**
 * The clients' offline-first data layer: settings, the cached week, games, the
 * offline result queue and the API. Plain Kotlin over [AppStorage], shared by
 * the Android app (files) and the web app (`localStorage`).
 *
 * Offline rules (PROJECT_PLAN.md): the device keeps exactly one week's seed. With
 * it, every day of that week plays offline; "today" comes from the device clock
 * in Pacific/Auckland. A new week needs a connection. Finished puzzles queue
 * results that upload whenever the server is reachable.
 */
class SudokuRepository(
    private val storage: AppStorage,
    /** Where the identity provider sends the browser back to after sign-in. */
    private val redirectUri: String,
    private val defaultServerUrl: String = "",
    private val clock: Clock = Clock.System,
    /** Overrides the HTTP engine (tests use a mock). */
    private val engine: HttpClientEngine? = null,
) {
    private var api: Pair<String, SudokuApi>? = null
    private var puzzleCache: Pair<Pair<Long, LocalDate>, List<Puzzle>>? = null

    private var oidcClient: Pair<OidcConfig, OidcClient>? = null

    private val tokenSession = TokenSession(
        StoredTokenStore(storage.tokens),
        refresh = { refreshToken ->
            val oidc = checkNotNull(settings().oidc) { "not signed in with OIDC" }
            oidcClient(oidc).refresh(refreshToken)
        },
        clock = clock,
    )

    val tokens = TokenProvider {
        val s = settings()
        when {
            s.devUser != null -> DevAuth.token(s.devUser.sub, s.devUser.name)
            s.oidc != null -> tokenSession.token()
            else -> null
        }
    }

    val sync = ResultSync(storage.pending) { api().submitResult(it) }

    fun settings(): Settings = storage.settings.read() ?: Settings(serverUrl = defaultServerUrl)

    /**
     * Whether the app has an identity to play as. With OIDC this stays true when
     * the tokens expire or are revoked, so offline play and the result queue keep
     * working; [needsSignIn] then asks for a fresh sign-in.
     */
    val isSignedIn: Boolean get() = settings().let { it.serverUrl.isNotBlank() && (it.devUser != null || it.oidc != null) }

    /** Signed in with OIDC but without usable tokens: the user should sign in again. */
    val needsSignIn: Boolean get() = settings().oidc != null && storage.tokens.read() == null

    fun today(): LocalDate = GameCalendar.today(clock.now())

    fun me(): Me? = storage.me.read()

    /** The cached week, if it contains [date]. */
    fun weekFor(date: LocalDate = today()): WeekResponse? = storage.week.read()?.takeIf { date in it.toWeekInfo() }

    /** The day's games for [date], or `null` if the cached week doesn't cover it. */
    fun puzzles(date: LocalDate = today()): List<Puzzle>? {
        val week = weekFor(date) ?: return null
        val key = week.seed to date
        puzzleCache?.let { (k, v) -> if (k == key) return v }
        return week.puzzles(date).also { puzzleCache = key to it }
    }

    /** `GET /config` on a server that isn't saved yet (first-run setup). */
    suspend fun fetchConfig(serverUrl: String): AppConfig =
        newApi(normalizeUrl(serverUrl), TokenProvider { null }).use { it.config() }

    /**
     * Saves the server and dev identity, then syncs. If the server can't be
     * reached the previous settings are restored and the error propagates.
     */
    suspend fun signInDev(serverUrl: String, sub: String, name: String) {
        DevAuth.token(sub, name) // validates
        val previous = storage.settings.read()
        storage.settings.write(Settings(normalizeUrl(serverUrl), DevUser(sub, name)))
        api = null
        try {
            refresh()
        } catch (e: Throwable) {
            storage.settings.write(previous)
            api = null
            throw e
        }
    }

    /**
     * Starts an OIDC sign-in (Authorization Code + PKCE): stores the PKCE
     * verifier and state, and returns the URL to open in the system browser.
     * The browser comes back to [redirectUri]; pass that to [completeOidcSignIn].
     */
    suspend fun beginOidcSignIn(serverUrl: String, oidc: OidcConfig): String {
        require(oidc.issuer.isNotBlank() && oidc.clientId.isNotBlank()) { "the server's OIDC settings are incomplete" }
        val pkce = Pkce.create()
        val pending = PendingAuth(
            serverUrl = normalizeUrl(serverUrl),
            oidc = oidc,
            state = randomToken(),
            verifier = pkce.verifier,
            nonce = randomToken(),
            createdAtEpochMs = clock.now().toEpochMilliseconds(),
        )
        storage.pendingAuth.write(pending)
        return oidcClient(oidc).authorizationUrl(pkce, pending.state, pending.nonce)
    }

    /**
     * Finishes an OIDC sign-in from the redirect URI the browser opened: checks
     * `state`, exchanges the code, saves the tokens, then syncs. If a different
     * account than before signs in, the previous account's games and queued
     * results are discarded. Throws [SignInException] when sign-in fails; a sync
     * failure after a successful sign-in propagates as is.
     */
    suspend fun completeOidcSignIn(redirectUri: String) {
        val params = parseQueryString(redirectUri.substringAfter('?', ""))
        val pending = storage.pendingAuth.read()
        storage.pendingAuth.write(null)
        params["error"]?.let { throw SignInException("Sign-in failed: ${params["error_description"] ?: it}") }
        val code = params["code"] ?: throw SignInException("Sign-in failed: no authorization code returned.")
        if (pending == null || pending.state != params["state"]) {
            throw SignInException("Sign-in failed: the response didn't match this app's request. Please try again.")
        }
        if (clock.now().toEpochMilliseconds() - pending.createdAtEpochMs > PENDING_TTL_MS) {
            throw SignInException("Sign-in took too long. Please try again.")
        }
        val response = try {
            oidcClient(pending.oidc).exchangeCode(code, pending.verifier)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw SignInException("Sign-in failed: couldn't get tokens from the identity provider.", e)
        }

        val previousUser = storage.me.read()
        storage.settings.write(Settings(pending.serverUrl, devUser = null, oidc = pending.oidc))
        tokenSession.signedIn(response)
        api = null
        val me = api().me()
        if (previousUser != null && previousUser.id != me.id) storage.clearProgress()
        storage.me.write(me)
        refresh()
    }

    suspend fun signOut() {
        storage.clearUserData()
        api = null
    }

    /**
     * Brings local state up to date with the server: identity, the current week
     * (replacing the cached one), uploads queued results, and today's results.
     * Network and HTTP failures propagate; queued results stay queued.
     */
    suspend fun refresh(): FlushReport {
        val api = api()
        storage.me.write(api.me())
        storeWeek(api.week())
        val report = sync.flush()
        val today = today()
        val mine = api.myResults(today)
        storage.serverResults.write(mapOf(mine.date to mine.results))
        return report
    }

    /** Uploads queued results only (the background worker's job). */
    suspend fun flush(): FlushReport = sync.flush()

    suspend fun pending(): List<GameResult> = sync.pending()

    fun serverResults(date: LocalDate): Map<Int, DayResult> =
        storage.serverResults.read()?.get(date).orEmpty().associateBy { it.level }

    suspend fun leaderboard(date: LocalDate): Leaderboard = api().leaderboard(date)

    /** A saved game for [puzzle] on [date], if it still matches the puzzle. */
    fun loadGame(date: LocalDate, puzzle: Puzzle): Game? =
        storage.games.read()?.get(AppStorage.gameKey(date, puzzle.level))
            ?.takeIf { it.givens == puzzle.givens }
            ?.let(Game::restore)

    fun saveGame(date: LocalDate, level: Int, game: Game, nowMs: Long) {
        storage.games.update { it.orEmpty() + (AppStorage.gameKey(date, level) to game.save(nowMs)) }
    }

    /** Queues the result of a just-finished game. */
    suspend fun complete(date: LocalDate, level: Int, game: Game): GameResult {
        val result = GameResult(
            date = date,
            level = level,
            elapsedMs = checkNotNull(game.completedElapsedMs) { "game isn't complete" },
            completedAt = GameCalendar.formatTimestamp(clock.now()),
        )
        sync.enqueue(result)
        return result
    }

    private fun storeWeek(week: WeekResponse) {
        val previous = storage.week.read()
        storage.week.write(week)
        if (previous?.isoWeek != week.isoWeek) {
            // Games from other weeks can't be finished any more; their results (if any) are already queued.
            val info = week.toWeekInfo()
            storage.games.update { games -> games?.filterKeys { LocalDate.parse(it.substringBefore('/')) in info } }
        }
    }

    private fun api(): SudokuApi {
        val url = settings().serverUrl
        check(url.isNotBlank()) { "no server configured" }
        api?.let { (u, a) -> if (u == url) return a }
        return newApi(url, tokens).also { api = url to it }
    }

    private fun oidcClient(oidc: OidcConfig): OidcClient {
        oidcClient?.let { (c, client) -> if (c == oidc) return client }
        val client = if (engine != null) {
            OidcClient(oidc.issuer, oidc.clientId, oidc.scopes, redirectUri, engine)
        } else {
            OidcClient(oidc.issuer, oidc.clientId, oidc.scopes, redirectUri)
        }
        return client.also { oidcClient = oidc to it }
    }

    private fun newApi(url: String, tokens: TokenProvider) =
        if (engine != null) SudokuApi(url, tokens, engine) else SudokuApi(url, tokens)

    companion object {
        private const val PENDING_TTL_MS = 15 * 60 * 1000L

        fun normalizeUrl(url: String): String {
            val trimmed = url.trim().trimEnd('/')
            return if ("://" in trimmed) trimmed else "https://$trimmed"
        }
    }
}

class SignInException(message: String, cause: Throwable? = null) : Exception(message, cause)
