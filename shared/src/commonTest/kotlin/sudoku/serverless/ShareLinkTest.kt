package sudoku.serverless

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class ShareLinkTest {
    @Test
    fun buildsALinkWithTheSettingsInTheFragment() {
        assertEquals(
            "https://sudoku.example.com/#seed=k7mq4-xzp2a&levels=5",
            ShareLink.build("https://sudoku.example.com/", SeedSettings("k7mq4-xzp2a")),
        )
        assertEquals(
            "https://example.github.io/sudoku/#seed=Rimu%20Kauri&levels=3&tz=Europe%2FLondon",
            ShareLink.build("https://example.github.io/sudoku/#seed=old&levels=5", SeedSettings("Rimu Kauri", 3, "Europe/London")),
        )
    }

    @Test
    fun roundTripsAwkwardSeeds() {
        val seeds = listOf(
            "plain",
            "Kōwhai 🌼 whānau",
            "a&b=c#d?e/f%g+h i",
            "%41 is not A",
            "100% sure",
            "tab\there",
            "日本語のシード",
            "'\"<>\\{}|^`[]",
            "~-._",
        )
        for (seed in seeds) {
            for (settings in listOf(SeedSettings(seed), SeedSettings(seed, 10, "America/New_York"))) {
                val link = ShareLink.build("https://h.example/sub/", settings)
                assertEquals(settings, ShareLink.parse(link), link)
                assertEquals(settings, ShareLink.parse("#" + ShareLink.fragment(settings)))
                assertEquals(settings, ShareLink.parse(ShareLink.fragment(settings)))
                // Only unreserved characters reach the URL.
                val fragment = link.substringAfter('#')
                assertEquals(fragment, fragment.filter { it.isLetterOrDigit() || it in "-._~%=&" }, fragment)
            }
        }
    }

    @Test
    fun matchesEncodeUriComponentForUtf8() {
        assertEquals("K%C5%8Dwhai%20%F0%9F%8C%BC", ShareLink.percentEncode("Kōwhai 🌼"))
    }

    @Test
    fun acceptsLinksWrittenByOtherTools() {
        // Lower-case escapes, `+` for space (URLSearchParams), raw Unicode in a pasted link, extra parameters.
        assertEquals(SeedSettings("Rimu Kauri"), ShareLink.parse("https://h/#seed=Rimu+Kauri"))
        assertEquals(SeedSettings("a/b"), ShareLink.parse("#seed=a%2fb&levels=5"))
        assertEquals(SeedSettings("Kōwhai 🌼"), ShareLink.parse("  https://h/#seed=Kōwhai 🌼&levels=5&v=2\n"))
        assertEquals(SeedSettings("x", 7), ShareLink.parse("https://h/?ref=chat#levels=7&seed=x&seed=ignored"))
    }

    @Test
    fun trimsTheSeedAndDefaultsTheRest() {
        assertEquals(SeedSettings("abc", 5, "Pacific/Auckland"), ShareLink.parse("#seed=%20abc%0A"))
        assertEquals(SeedSettings("abc", 5, "Pacific/Auckland"), ShareLink.parse("#seed=abc&tz="))
    }

    @Test
    fun rejectsLinksWithoutValidSettings() {
        val bad = listOf(
            "",
            "just a seed",
            "https://sudoku.example.com/",
            "https://sudoku.example.com/#",
            "#levels=5",
            "#seed=",
            "#seed=%20%20",
            "#seed=abc&levels=0",
            "#seed=abc&levels=11",
            "#seed=abc&levels=five",
            "#seed=abc&tz=Mars/Olympus_Mons",
            "#seed=%",
            "#seed=%4",
            "#seed=%zz",
            "#seed=%C3%28", // invalid UTF-8
        )
        for (text in bad) assertNull(ShareLink.parse(text), text)
    }

    @Test
    fun settingsValidateThemselves() {
        assertFailsWith<IllegalArgumentException> { SeedSettings("") }
        assertFailsWith<IllegalArgumentException> { SeedSettings(" padded ") }
        assertFailsWith<IllegalArgumentException> { SeedSettings("x", levels = 0) }
        assertFailsWith<IllegalArgumentException> { SeedSettings("x", levels = 11) }
    }
}
