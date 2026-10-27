package sudoku.auth

private const val SHA256_BLOCK_SIZE = 64

/** HMAC-SHA256 (RFC 2104) on the platform's [sha256], so it runs the same on every target. */
internal suspend fun hmacSha256(key: ByteArray, message: ByteArray): ByteArray {
    val blockKey = (if (key.size > SHA256_BLOCK_SIZE) sha256(key) else key).copyOf(SHA256_BLOCK_SIZE)
    val inner = ByteArray(SHA256_BLOCK_SIZE) { (blockKey[it].toInt() xor 0x36).toByte() }
    val outer = ByteArray(SHA256_BLOCK_SIZE) { (blockKey[it].toInt() xor 0x5c).toByte() }
    return sha256(outer + sha256(inner + message))
}
