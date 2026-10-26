package sudoku.auth

import kotlinx.coroutines.await
import org.khronos.webgl.ArrayBuffer
import org.khronos.webgl.Int8Array
import kotlin.js.Promise

// WebCrypto, available in browsers (secure contexts: https or localhost) and Node.js 19+.
private val webCrypto: dynamic get() = js("globalThis.crypto")

internal actual fun secureRandomBytes(size: Int): ByteArray {
    val array = Int8Array(size)
    webCrypto.getRandomValues(array)
    return array.unsafeCast<ByteArray>().copyOf()
}

internal actual suspend fun sha256(data: ByteArray): ByteArray {
    val input = Int8Array(data.toTypedArray())
    val digest = (webCrypto.subtle.digest("SHA-256", input) as Promise<ArrayBuffer>).await()
    return Int8Array(digest).unsafeCast<ByteArray>().copyOf()
}
