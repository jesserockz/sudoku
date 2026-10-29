package sudoku.web

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import kotlinx.coroutines.launch
import org.jetbrains.compose.web.attributes.InputType
import org.jetbrains.compose.web.attributes.readOnly
import org.jetbrains.compose.web.attributes.selected
import org.jetbrains.compose.web.dom.Button
import org.jetbrains.compose.web.dom.Div
import org.jetbrains.compose.web.dom.Form
import org.jetbrains.compose.web.dom.H2
import org.jetbrains.compose.web.dom.Input
import org.jetbrains.compose.web.dom.Label
import org.jetbrains.compose.web.dom.Option
import org.jetbrains.compose.web.dom.P
import org.jetbrains.compose.web.dom.Select
import org.jetbrains.compose.web.dom.Table
import org.jetbrains.compose.web.dom.Tbody
import org.jetbrains.compose.web.dom.Td
import org.jetbrains.compose.web.dom.Text
import org.jetbrains.compose.web.dom.Tr
import sudoku.game.GameCalendar
import sudoku.game.formatDuration
import sudoku.generator.Generator
import sudoku.serverless.PlaySeed
import sudoku.serverless.SeedSettings
import sudoku.serverless.ShareLink

/** Enter, paste or generate a seed, and the settings the group shares. */
@Composable
fun SeedSetupScreen(app: AppController, phase: Phase.SeedSetup) {
    var seedText by remember { mutableStateOf("") }
    var levels by remember { mutableStateOf(Generator.DEFAULT_LEVELS) }
    var timezone by remember { mutableStateOf(GameCalendar.TIMEZONE_ID) }
    var error by remember { mutableStateOf<String?>(null) }
    TopBar("Sudoku", onBack = phase.server?.let { { app.cancelSeed() } })
    app.notice?.let { Div({ classes("notice") }) { Text(it) } }
    Div({ classes("card") }) {
        H2 { Text("Play with a seed") }
        if (phase.server == null) {
            P({ classes("muted") }) { Text("There's no Sudoku server here, so play with a seed instead.") }
        }
        P({ classes("muted") }) {
            Text(
                "Everyone who enters the same seed gets the same puzzles each day. " +
                    "Make one up, generate one, or paste a link someone shared.",
            )
        }
        Form(attrs = {
            classes("login")
            addEventListener("submit") {
                it.preventDefault()
                val settings = settingsFrom(seedText, levels, timezone)
                if (settings == null) {
                    error = "Enter a seed (or a share link), and a timezone like Pacific/Auckland."
                } else {
                    error = null
                    app.useSeed(settings)
                }
            }
        }) {
            Label(forId = "seed") { Text("Seed or share link") }
            Div({ classes("inline") }) {
                Input(InputType.Text) {
                    id("seed")
                    value(seedText)
                    attr("autocomplete", "off")
                    attr("autocapitalize", "none")
                    attr("spellcheck", "false")
                    onInput { seedText = it.value }
                }
                Button({ attr("type", "button"); onClick { seedText = PlaySeed.generate() } }) { Text("Generate") }
            }
            Label(forId = "levels") { Text("Games per day") }
            Select({
                id("levels")
                onChange { e -> e.value?.toIntOrNull()?.let { levels = it } }
            }) {
                for (n in 1..Generator.MAX_LEVELS) Option("$n", { if (n == levels) selected() }) { Text("$n") }
            }
            Label(forId = "tz") { Text("Day starts at midnight in") }
            Input(InputType.Text) {
                id("tz")
                value(timezone)
                attr("autocapitalize", "none")
                onInput { timezone = it.value }
            }
            P({ classes("muted") }) { Text("Everyone in the group needs the same seed, games per day and timezone: share a link to be sure.") }
            error?.let { P({ classes("error") }) { Text(it) } }
            Button({ classes("primary"); attr("type", "submit") }) { Text("Start playing") }
        }
        if (phase.server == null) {
            Div({ classes("actions") }) {
                Button({ classes("link"); onClick { app.reload() } }) { Text("Look for a server again") }
            }
        }
    }
}

/** A pasted share link wins over the form; otherwise the typed seed with the chosen settings. */
private fun settingsFrom(text: String, levels: Int, timezone: String): SeedSettings? {
    ShareLink.parse(text)?.let { return it }
    val seed = PlaySeed.normalize(text)
    val zone = timezone.trim().ifEmpty { GameCalendar.TIMEZONE_ID }
    if (seed.isEmpty() || runCatching { GameCalendar.zone(zone) }.isFailure) return null
    return SeedSettings(seed, levels, zone)
}

/** A share link was opened while another seed (or a server sign-in) is in use. */
@Composable
fun ConfirmSeedScreen(app: AppController, phase: Phase.ConfirmSeed) {
    TopBar("Sudoku")
    Div({ classes("card", "center") }) {
        H2 { Text("Switch to this seed?") }
        P { Text("The link plays seed ${phase.incomingFingerprint} · ${describe(phase.incoming)}.") }
        P({ classes("muted") }) {
            Text(
                phase.current?.let { "You're playing seed ${it.fingerprint} now. Its games and times are kept if you switch." }
                    ?: "You're signed in to this server. You can come back to it later with \"Leave seed\".",
            )
        }
        Div({ classes("actions") }) {
            Button({ classes("primary"); onClick { app.useSeed(phase.incoming) } }) { Text("Switch") }
            Button({ onClick { app.cancelSeed() } }) { Text(if (phase.current != null) "Keep current seed" else "Stay signed in") }
        }
    }
}

/** The seed's details and ways to bring others in, under the day's games. */
@Composable
fun SeedGroupCard(app: AppController) {
    val profile = app.seed ?: return
    val link = app.shareLink() ?: return
    val scope = rememberCoroutineScope()
    var message by remember { mutableStateOf<String?>(null) }
    Div({ classes("card") }) {
        H2 { Text("Seed ${profile.fingerprint}") }
        P({ classes("muted") }) { Text("${describe(profile.settings)}. Anyone with this link plays the same puzzles.") }
        Input(InputType.Text) {
            id("share-link")
            classes("share-link")
            value(link)
            readOnly()
            attr("aria-label", "Share link")
            onFocus { it.target.asDynamic().select() }
        }
        Div({ classes("actions") }) {
            Button({
                onClick {
                    scope.launch { message = if (copyText(link)) "Link copied." else "Couldn't copy: select the link above and copy it." }
                }
            }) { Text("Copy link") }
            if (canShare) {
                Button({ onClick { scope.launch { share("Sudoku", "Play today's Sudoku with us", link) } } }) { Text("Share…") }
            }
            Button({
                onClick {
                    scope.launch { message = if (copyText(profile.settings.seed)) "Seed copied." else "Couldn't copy the seed." }
                }
            }) { Text("Copy seed") }
            Button({ classes("link"); onClick { app.leaveSeed() } }) { Text("Leave seed") }
        }
        message?.let { P({ classes("muted", "center") }) { Text(it) } }
    }
}

/** "Share results": the day's times as text, through the share sheet or the clipboard. */
@Composable
fun ShareResultsButton(app: AppController, primary: Boolean = false) {
    val scope = rememberCoroutineScope()
    var message by remember { mutableStateOf<String?>(null) }
    Button({
        if (primary) classes("primary")
        onClick {
            scope.launch {
                val text = app.resultsSummary()
                message = when {
                    share("Sudoku results", text) -> null
                    copyText(text) -> "Results copied: paste them into a message."
                    else -> "Couldn't copy your results."
                }
            }
        }
    }) { Text("Share results") }
    message?.let { P({ classes("muted", "center", "share-message") }) { Text(it) } }
}

/** Serverless play's history of solve times. */
@Composable
fun HistoryScreen(app: AppController) {
    TopBar("History", onBack = { app.openToday() })
    val history = app.history()
    if (history.isEmpty()) {
        Div({ classes("card", "center") }) { P({ classes("muted") }) { Text("Solved puzzles show up here.") } }
        return
    }
    for ((date, results) in history.groupBy { it.date }) {
        Div({ classes("card") }) {
            H2 { Text(if (date == app.today) "Today" else "${date.dayOfWeek.name.lowercase().replaceFirstChar { it.uppercase() }} $date") }
            Table({ classes("board-table") }) {
                Tbody {
                    for (r in results) {
                        Tr {
                            Td { Text(r.title) }
                            Td({ classes("time") }) { Text(formatDuration(r.elapsedMs)) }
                        }
                    }
                    Tr {
                        Td { Text("Total (${results.size}/${results.first().levels})") }
                        Td({ classes("time") }) { Text(formatDuration(results.sumOf { it.elapsedMs })) }
                    }
                }
            }
        }
    }
}

private fun describe(settings: SeedSettings): String {
    val games = if (settings.levels == 1) "1 game a day" else "${settings.levels} games a day"
    return "$games, days in ${settings.timezone}"
}
