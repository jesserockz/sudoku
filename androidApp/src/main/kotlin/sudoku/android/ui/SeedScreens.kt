package sudoku.android.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import sudoku.android.AppViewModel
import sudoku.game.GameCalendar
import sudoku.game.formatDuration
import sudoku.generator.Generator
import sudoku.serverless.PlaySeed
import sudoku.serverless.SeedSettings

/** Enter, paste or generate a seed, and the settings the group shares. */
@Composable
fun SeedSetupScreen(vm: AppViewModel) {
    val context = LocalContext.current
    var text by rememberSaveable { mutableStateOf("") }
    var levels by rememberSaveable { mutableIntStateOf(Generator.DEFAULT_LEVELS) }
    var timezone by rememberSaveable { mutableStateOf(GameCalendar.TIMEZONE_ID) }
    Scaffold(topBar = { Bar("Play with a seed", onBack = { vm.back() }) }) { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                "Everyone who enters the same seed gets the same puzzles each day, no server needed. " +
                    "Make one up, generate one, or paste a link someone shared.",
                style = MaterialTheme.typography.bodyLarge,
            )
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                label = { Text("Seed or share link") },
                singleLine = true,
                // A seed is used exactly as typed: no autocorrect or auto-capitals.
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { text = PlaySeed.generate() }) { Text("Generate") }
                OutlinedButton(onClick = { clipboardText(context)?.let { text = it } }) { Text("Paste link") }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Games per day", modifier = Modifier.weight(1f))
                OutlinedButton(onClick = { if (levels > 1) levels-- }, enabled = levels > 1) { Text("−") }
                Text("$levels", fontWeight = FontWeight.SemiBold)
                OutlinedButton(onClick = { if (levels < Generator.MAX_LEVELS) levels++ }, enabled = levels < Generator.MAX_LEVELS) { Text("+") }
            }
            OutlinedTextField(
                value = timezone,
                onValueChange = { timezone = it },
                label = { Text("Day starts at midnight in") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                "Everyone in the group needs the same seed, games per day and timezone: share a link to be sure.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(onClick = { vm.startSeed(text, levels, timezone) }, enabled = !vm.setupBusy) { Text("Start playing") }
            if (vm.setupBusy) CircularProgressIndicator()
            vm.setupError?.let { Text(it, color = ConflictColor) }
        }
    }
}

/** The seed's details and ways to bring others in, under the day's games. */
@Composable
fun SeedCard(vm: AppViewModel) {
    val profile = vm.seed ?: return
    val link = vm.shareLink() ?: return
    val context = LocalContext.current
    var message by remember { mutableStateOf<String?>(null) }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Seed ${profile.fingerprint}", fontWeight = FontWeight.SemiBold)
            Text(
                "${describe(profile.settings)}. Anyone with this link plays the same puzzles.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(link, style = MaterialTheme.typography.bodySmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { vm.shareSeedLink() }) { Text("Share link") }
                OutlinedButton(onClick = { copy(context, "Sudoku link", link); message = "Link copied." }) { Text("Copy link") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { copy(context, "Sudoku seed", profile.settings.seed); message = "Seed copied." }) { Text("Copy seed") }
                TextButton(onClick = { vm.leaveSeed() }) { Text("Leave seed") }
            }
            message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

/** Asks before a pasted link replaces the current seed or a server sign-in. */
@Composable
fun ConfirmSeedDialog(vm: AppViewModel) {
    val (incoming, fingerprint) = vm.pendingSeed ?: return
    val current = vm.seed
    AlertDialog(
        onDismissRequest = { vm.dismissPendingSeed() },
        title = { Text("Switch to this seed?") },
        text = {
            Text(
                "The link plays seed $fingerprint · ${describe(incoming)}. " +
                    (
                        current?.let { "You're playing seed ${it.fingerprint} now; its games and times are kept." }
                            ?: "You're signed in to a server; you can come back to it with \"Leave seed\"."
                        ),
            )
        },
        confirmButton = { TextButton(onClick = { vm.confirmPendingSeed() }) { Text("Switch") } },
        dismissButton = { TextButton(onClick = { vm.dismissPendingSeed() }) { Text("Keep current") } },
    )
}

/** Serverless play's history of solve times. */
@Composable
fun HistoryScreen(vm: AppViewModel) {
    val history = vm.history()
    Scaffold(topBar = { Bar("History", onBack = { vm.openToday() }) }) { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (history.isEmpty()) Text("Solved puzzles show up here.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            for ((day, results) in history.groupBy { it.date }) {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp)) {
                        Text(
                            if (day == vm.date) "Today" else "${day.dayOfWeek.name.lowercase().replaceFirstChar { it.uppercase() }} $day",
                            fontWeight = FontWeight.SemiBold,
                        )
                        for (r in results) TimeRow(r.title, r.elapsedMs)
                        HorizontalDivider()
                        TimeRow("Total (${results.size}/${results.first().levels})", results.sumOf { it.elapsedMs })
                    }
                }
            }
        }
    }
}

@Composable
private fun TimeRow(label: String, ms: Long) {
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Text(label, Modifier.weight(1f))
        Text(formatDuration(ms), fontWeight = FontWeight.SemiBold)
    }
}

private fun describe(settings: SeedSettings): String {
    val games = if (settings.levels == 1) "1 game a day" else "${settings.levels} games a day"
    return "$games, days in ${settings.timezone}"
}

private fun copy(context: Context, label: String, text: String) {
    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText(label, text))
}

private fun clipboardText(context: Context): String? =
    context.getSystemService(ClipboardManager::class.java)?.primaryClip
        ?.takeIf { it.itemCount > 0 }
        ?.getItemAt(0)?.coerceToText(context)?.toString()
