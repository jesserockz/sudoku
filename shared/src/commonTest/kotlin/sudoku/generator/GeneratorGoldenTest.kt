package sudoku.generator

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Golden puzzles. These run on every target (JVM, Android, JS) and are what
 * guarantees that every platform generates the same puzzles.
 *
 * If one fails, generation output has changed: the family would no longer get
 * the same puzzles across app versions and platforms. Don't update these values
 * unless the change is deliberate, and bump [Generator.VERSION] when it is.
 */
class GeneratorGoldenTest {
    private class Golden(val seed: String, val day: Int, val level: Int, val givens: String, val solution: String)

    private val goldens = listOf(
        Golden(
            "9f2c4a1b7e30d5c8", 1, 1,
            "020091683006050000817600520080405071002080946470069000700918000100006754203000090",
            "524791683936852417817643529689435271352187946471269835745918362198326754263574198",
        ),
        Golden(
            "9f2c4a1b7e30d5c8", 1, 2,
            "630897020480650700025031000010005000800019003002068104260004300004003008007006040",
            "631897425489652731725431986913245867846719253572368194268574319154923678397186542",
        ),
        Golden(
            "9f2c4a1b7e30d5c8", 1, 3,
            "090054010504000007000830090050009000000020309930760004068203070109070800300180000",
            "793654218584912637216837495851349726647521389932768154468293571129475863375186942",
        ),
        Golden(
            "9f2c4a1b7e30d5c8", 1, 4,
            "007008903001000082020004710309000000100206000800090306003000600204000079010000500",
            "457128963631579482928364715369785241145236897872491356593817624284653179716942538",
        ),
        Golden(
            "9f2c4a1b7e30d5c8", 1, 5,
            "000004010600000009801057002005600000930000805000000400700040006004000020302080000",
            "593264718627813549841957632415678293936421875278395461759142386184536927362789154",
        ),
        Golden(
            "0000000000000000", 7, 5,
            "000300001504009600000000080020917050005000000000850030406705020000000004030020000",
            "289376541514289673367541289823917456975463812641852937496735128752198364138624795",
        ),
        Golden(
            "ffffffffffffffff", 4, 3,
            "700300000259108006000024800000000100017002003823610007000780630061050000370060000",
            "784396215259178346136524879495837162617942583823615497542789631961453728378261954",
        ),
        Golden(
            "0123456789abcdef", 3, 1,
            "003000061000010732028003005260807000480060000307021680030006408015030296946002570",
            "573249861694518732128673945261897354489365127357421689732956418815734296946182573",
        ),
        Golden(
            "8000000000000000", 6, 4,
            "001000009637000000800657301003000000500008006900500487060705000070094008000000090",
            "251843679637921854894657321783469512542178936916532487169785243375294168428316795",
        ),
    )

    @Test
    fun generatorVersionIsPinned() {
        assertEquals(1, Generator.VERSION)
    }

    @Test
    fun puzzleSeedIsPinned() {
        assertEquals(4473328950258826066L, Generator.puzzleSeed(WeekSeed.parse("9f2c4a1b7e30d5c8"), 1, 1))
    }

    @Test
    fun goldenPuzzles() {
        for (g in goldens) {
            val p = Generator.generate(WeekSeed.parse(g.seed), g.day, g.level)
            val label = "seed=${g.seed} day=${g.day} level=${g.level}"
            assertEquals(g.givens, p.givens, "givens for $label")
            assertEquals(g.solution, p.solution, "solution for $label")
        }
    }
}
