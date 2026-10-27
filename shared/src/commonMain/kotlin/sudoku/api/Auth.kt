package sudoku.api

/** Supplies the bearer token for API calls, or `null` when signed out. */
fun interface TokenProvider {
    suspend fun token(): String?
}

/**
 * The server's dev auth mode (`auth.mode = "dev"`): the bearer token is
 * `dev:<sub>:<display name>`. For local development only.
 */
object DevAuth {
    fun token(sub: String, displayName: String): String {
        require(sub.isNotEmpty() && ':' !in sub) { "dev sub must be non-empty and contain no ':'" }
        require(displayName.isNotEmpty()) { "dev display name must be non-empty" }
        return "dev:$sub:$displayName"
    }

    fun provider(sub: String, displayName: String): TokenProvider {
        val token = token(sub, displayName)
        return TokenProvider { token }
    }
}
