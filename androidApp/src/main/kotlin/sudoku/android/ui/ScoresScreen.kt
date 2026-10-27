package sudoku.android.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.datetime.DatePeriod
import kotlinx.datetime.minus
import sudoku.android.AppViewModel
import sudoku.android.Screen
import sudoku.game.formatDuration
import sudoku.generator.Generator

@Composable
fun ScoresScreen(vm: AppViewModel, screen: Screen.Scores) {
    val myId = vm.myId
    Scaffold(topBar = { Bar("Leaderboard", onBack = { vm.openToday() }) }) { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(
                    onClick = { vm.shiftScoresDate(-1) },
                    enabled = screen.date > vm.date.minus(DatePeriod(days = 8)),
                ) { Text("‹ Earlier") }
                Text(if (screen.date == vm.date) "Today" else screen.date.toString(), Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
                TextButton(onClick = { vm.shiftScoresDate(1) }, enabled = screen.date < vm.date) { Text("Later ›") }
            }
            val board = vm.leaderboard
            // That day's game count: from its leaderboard once loaded (a past week may differ).
            val levels = board?.takeIf { it.date == screen.date }?.puzzles?.size?.takeIf { it > 0 } ?: (vm.puzzles?.size ?: 5)
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                FilterChip(screen.tab == 0, { vm.showScoresTab(0) }, label = { Text("Total") })
                for (level in 1..levels) {
                    FilterChip(screen.tab == level, { vm.showScoresTab(level) }, label = { Text(Generator.title(level, levels)) })
                }
            }
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    when {
                        vm.leaderboardError != null -> Text(vm.leaderboardError!!, color = MaterialTheme.colorScheme.error)
                        board == null || board.date != screen.date -> Text("Loading…")
                        screen.tab == 0 ->
                            if (board.total.entries.isEmpty()) {
                                Text("Nobody has finished all $levels yet.")
                            } else {
                                board.total.entries.forEach { ScoreRow(it.rank, it.displayName, it.totalMs, it.userId == myId) }
                            }
                        else -> {
                            val entries = board.puzzles.firstOrNull { it.level == screen.tab }?.entries.orEmpty()
                            if (entries.isEmpty()) {
                                Text("No one has solved this one yet.")
                            } else {
                                entries.forEach { ScoreRow(it.rank, it.displayName, it.elapsedMs, it.userId == myId) }
                            }
                        }
                    }
                }
            }
            if (board != null && board.date == screen.date && board.players.isNotEmpty()) {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("Progress", style = MaterialTheme.typography.titleMedium)
                        board.players.sortedWith(compareBy({ -it.completedLevels.size }, { it.displayName })).forEach { p ->
                            Row {
                                Text(
                                    p.displayName,
                                    Modifier.weight(1f),
                                    fontWeight = if (p.userId == myId) FontWeight.Bold else FontWeight.Normal,
                                )
                                Text(
                                    (1..levels).joinToString(" ") { if (it in p.completedLevels) "●" else "○" } + "  ${p.completedLevels.size}/$levels",
                                    color = DoneColor,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ScoreRow(rank: Int, name: String, ms: Long, isMe: Boolean) {
    val weight = if (isMe) FontWeight.Bold else FontWeight.Normal
    Row {
        Text("$rank", Modifier.width(32.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(name, Modifier.weight(1f), fontWeight = weight)
        Text(formatDuration(ms), fontWeight = weight)
    }
}
