package sudoku.game

import kotlinx.datetime.LocalDate
import sudoku.generator.Generator
import sudoku.generator.Puzzle

/** The day's games for a date, from the seed of the week containing it. */
object DailyPuzzles {
    /** [levels] is the week's number of games per day (`/api/v1/week`'s `levels`). */
    fun forDate(weekSeed: Long, week: WeekInfo, date: LocalDate, levels: Int = Generator.DEFAULT_LEVELS): List<Puzzle> {
        require(date in week) { "$date is outside ${week.isoWeek}" }
        return Generator.generateDay(weekSeed, GameCalendar.dayOfWeek(date), levels)
    }
}
