package sudoku.serverless

import kotlinx.datetime.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals

class ResultsSummaryTest {
    private val date = LocalDate(2026, 10, 27)

    @Test
    fun summarisesAPartlyPlayedDay() {
        val games = listOf(GameTime("Easy", 192_400), GameTime("Medium", 340_999), GameTime("Hard", null))
        assertEquals(
            "Sudoku 2026-10-27 #3fa9c1\nEasy 3:12\nMedium 5:40\nHard -\nSolved 2/3 in 8:53",
            ResultsSummary.format(date, "#3fa9c1", games),
        )
    }

    @Test
    fun showsTheTotalOnceEverythingIsSolved() {
        val games = listOf(GameTime("Easy", 60_000), GameTime("Diabolical", 3_600_000))
        assertEquals("Sudoku 2026-10-27\nEasy 1:00\nDiabolical 1:00:00\nTotal 1:01:00", ResultsSummary.format(date, " ", games))
    }
}
