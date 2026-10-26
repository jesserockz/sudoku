package sudoku.game

import kotlinx.datetime.LocalDate
import sudoku.generator.Generator
import sudoku.generator.Puzzle

/** The five puzzles for a date, from the seed of the week containing it. */
object DailyPuzzles {
    fun forDate(weekSeed: Long, week: WeekInfo, date: LocalDate): List<Puzzle> {
        require(date in week) { "$date is outside ${week.isoWeek}" }
        return Generator.generateDay(weekSeed, GameCalendar.dayOfWeek(date))
    }
}
