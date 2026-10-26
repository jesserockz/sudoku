package sudoku.auth

/** Cryptographically secure random bytes from the platform. */
internal expect fun secureRandomBytes(size: Int): ByteArray

/** SHA-256 from the platform (WebCrypto on JS). */
internal expect suspend fun sha256(data: ByteArray): ByteArray
