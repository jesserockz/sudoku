package sudoku.web

import kotlinx.serialization.Serializable
import sudoku.api.DevAuth
import sudoku.api.TokenProvider

/** How the web client signs in. One implementation per server `authMode`. */
interface WebAuth {
    val isSignedIn: Boolean

    val tokens: TokenProvider

    fun signOut()
}

/** Dev auth mode: the user picks an id and name, kept in `localStorage`. */
class DevWebAuth : WebAuth {
    @Serializable
    data class DevUser(val sub: String, val name: String)

    private var user: DevUser? = Storage.get(KEY, DevUser.serializer())

    override val isSignedIn: Boolean get() = user != null

    override val tokens = TokenProvider { user?.let { DevAuth.token(it.sub, it.name) } }

    fun signIn(sub: String, name: String) {
        DevAuth.token(sub, name) // validates
        user = DevUser(sub, name).also { Storage.set(KEY, DevUser.serializer(), it) }
    }

    override fun signOut() {
        user = null
        Storage.set(KEY, DevUser.serializer(), null)
    }

    private companion object {
        const val KEY = "devUser"
    }
}
