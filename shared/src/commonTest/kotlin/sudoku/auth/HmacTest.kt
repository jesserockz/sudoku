package sudoku.auth

import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

class HmacTest {
    private class Vector(val name: String, val key: ByteArray, val data: ByteArray, val mac: String)

    // RFC 4231 section 4. Test case 5 is omitted: it checks a truncated MAC.
    private val rfc4231 = listOf(
        Vector("1", ByteArray(20) { 0x0b }, "Hi There".encodeToByteArray(), "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"),
        Vector("2", "Jefe".encodeToByteArray(), "what do ya want for nothing?".encodeToByteArray(), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"),
        Vector("3", ByteArray(20) { 0xaa.toByte() }, ByteArray(50) { 0xdd.toByte() }, "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe"),
        Vector("4", ByteArray(25) { (it + 1).toByte() }, ByteArray(50) { 0xcd.toByte() }, "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b"),
        Vector(
            "6", ByteArray(131) { 0xaa.toByte() }, "Test Using Larger Than Block-Size Key - Hash Key First".encodeToByteArray(),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
        ),
        Vector(
            "7", ByteArray(131) { 0xaa.toByte() },
            (
                "This is a test using a larger than block-size key and a larger than block-size data. " +
                    "The key needs to be hashed before being used by the HMAC algorithm."
                ).encodeToByteArray(),
            "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2",
        ),
    )

    @Test
    fun matchesRfc4231() = runTest {
        for (v in rfc4231) assertEquals(v.mac, hmacSha256(v.key, v.data).toHex(), "test case ${v.name}")
    }

    @Test
    fun keyOfExactlyOneBlockIsUsedAsIs() = runTest {
        // A 64-byte key is not hashed; a 65-byte one is. Both computed with Python's hmac module.
        assertEquals(
            "21cd586aeca0579d99a1c938127c92525a371f807bc5ba6eb78bc825bd4f2be3",
            hmacSha256(ByteArray(64) { 0x0b }, "Hi There".encodeToByteArray()).toHex(),
        )
        assertEquals(
            "727b82fba264393c5d67fd6d6ad783e9019a1fa6a857fccb70f5852f04be5d5d",
            hmacSha256(ByteArray(65) { 0x0b }, "Hi There".encodeToByteArray()).toHex(),
        )
    }

    private fun ByteArray.toHex() = joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
}
