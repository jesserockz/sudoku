package sudoku.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import sudoku.android.AppViewModel
import sudoku.android.PuzzleStatus
import sudoku.game.formatDuration

@Composable
fun TodayScreen(vm: AppViewModel) {
    val serverless = vm.seed != null
    Scaffold(topBar = {
        Bar("Sudoku") {
            if (serverless) {
                TextButton(onClick = { vm.openHistory() }) { Text("History") }
            } else {
                TextButton(onClick = { vm.signOut() }) { Text("Sign out") }
            }
        }
    }) { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (vm.syncing) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (vm.needsSignIn) {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Your sign-in has expired.", fontWeight = FontWeight.SemiBold)
                        Text("You can keep playing; sign in again to upload results and see the leaderboard.")
                        Button(onClick = { vm.signInAgain() }) { Text("Sign in again") }
                    }
                }
            } else {
                vm.syncProblem?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
            }
            val day = vm.date.dayOfWeek.name.lowercase().replaceFirstChar { it.uppercase() }
            Text(
                "$day ${vm.date}" + (vm.displayName?.let { " · $it" } ?: ""),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            val puzzles = vm.puzzles
            if (puzzles == null) {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("This week's puzzles haven't been downloaded yet.", fontWeight = FontWeight.SemiBold)
                        Text("Connect to the internet once at the start of each week; then everything plays offline.")
                        Button(onClick = { vm.sync() }, enabled = !vm.syncing) { Text("Try again") }
                    }
                }
            } else {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(horizontal = 16.dp)) {
                        puzzles.forEachIndexed { index, p ->
                            if (index > 0) HorizontalDivider()
                            PuzzleRow(vm, p.level, p.title, p.givenCount)
                        }
                    }
                }
            }
            if (serverless) {
                Row(Modifier.align(Alignment.CenterHorizontally), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { vm.shareResults() }) { Text("Share results") }
                    OutlinedButton(onClick = { vm.openHistory() }) { Text("History") }
                }
                SeedCard(vm)
            } else {
                OutlinedButton(onClick = { vm.openScores() }, modifier = Modifier.align(Alignment.CenterHorizontally)) {
                    Text("Leaderboard")
                }
            }
        }
    }
}

@Composable
private fun PuzzleRow(vm: AppViewModel, level: Int, name: String, givens: Int) {
    val status = vm.statusOf(level)
    Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(name, fontWeight = FontWeight.SemiBold)
            Text(
                when (status) {
                    PuzzleStatus.New -> "$givens givens"
                    is PuzzleStatus.InProgress -> "In progress · ${formatDuration(status.elapsedMs)}"
                    is PuzzleStatus.Done ->
                        "Solved in ${formatDuration(status.elapsedMs)}" + if (status.synced) "" else " · not uploaded yet"
                },
                style = MaterialTheme.typography.bodyMedium,
                color = if (status is PuzzleStatus.Done) DoneColor else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        when (status) {
            PuzzleStatus.New -> Button(onClick = { vm.openPuzzle(level) }) { Text("Play") }
            is PuzzleStatus.InProgress -> Button(onClick = { vm.openPuzzle(level) }) { Text("Resume") }
            is PuzzleStatus.Done -> if (vm.seed == null) OutlinedButton(onClick = { vm.openScores(level) }) { Text("Scores") }
        }
    }
}
