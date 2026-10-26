package sudoku.web

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import org.jetbrains.compose.web.attributes.InputType
import org.jetbrains.compose.web.attributes.disabled
import org.jetbrains.compose.web.dom.Button
import org.jetbrains.compose.web.dom.Div
import org.jetbrains.compose.web.dom.Form
import org.jetbrains.compose.web.dom.H1
import org.jetbrains.compose.web.dom.H2
import org.jetbrains.compose.web.dom.Header
import org.jetbrains.compose.web.dom.Input
import org.jetbrains.compose.web.dom.Label
import org.jetbrains.compose.web.dom.Li
import org.jetbrains.compose.web.dom.P
import org.jetbrains.compose.web.dom.Span
import org.jetbrains.compose.web.dom.Table
import org.jetbrains.compose.web.dom.Tbody
import org.jetbrains.compose.web.dom.Td
import org.jetbrains.compose.web.dom.Text
import org.jetbrains.compose.web.dom.Tr
import org.jetbrains.compose.web.dom.Ul
import sudoku.api.AppConfig
import sudoku.api.AuthMode
import sudoku.generator.Difficulty
import sudoku.game.formatDuration

@Composable
fun App(app: AppController) {
    Div({ classes("app") }) {
        when (val phase = app.phase) {
            Phase.Loading -> P({ classes("boot") }) { Text("Loading…") }
            is Phase.Failed -> FailedScreen(phase.message) { app.reload() }
            is Phase.SignIn -> SignInScreen(app, phase.config)
            Phase.Ready -> when (val screen = app.screen) {
                Screen.Today -> TodayScreen(app)
                is Screen.Play -> PlayScreen(app, screen.level)
                is Screen.Scores -> ScoresScreen(app, screen)
            }
        }
    }
}

@Composable
fun TopBar(title: String, onBack: (() -> Unit)? = null, trailing: @Composable () -> Unit = {}) {
    Header({ classes("bar") }) {
        if (onBack != null) {
            Button({ classes("link"); onClick { onBack() } }) { Text("‹ Back") }
        }
        H1 { Text(title) }
        Div { trailing() }
    }
}

@Composable
private fun FailedScreen(message: String, onRetry: () -> Unit) {
    TopBar("Sudoku")
    Div({ classes("card", "center") }) {
        P({ classes("error") }) { Text(message) }
        Button({ classes("primary"); onClick { onRetry() } }) { Text("Try again") }
    }
}

@Composable
private fun SignInScreen(app: AppController, config: AppConfig) {
    TopBar("Sudoku")
    when (config.authMode) {
        AuthMode.DEV -> DevSignIn(app)
        AuthMode.OIDC -> Div({ classes("card") }) {
            P { Text("This server uses OIDC sign-in, which this build doesn't support yet.") }
        }
    }
}

@Composable
private fun DevSignIn(app: AppController) {
    var sub by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    Div({ classes("card") }) {
        H2 { Text("Dev sign-in") }
        P({ classes("muted") }) { Text("The server is in dev auth mode. Pick any user id and display name.") }
        Form(attrs = {
            classes("login")
            addEventListener("submit") {
                it.preventDefault()
                val auth = app.auth as? DevWebAuth ?: return@addEventListener
                try {
                    auth.signIn(sub.trim(), name.trim())
                    app.reload()
                } catch (e: IllegalArgumentException) {
                    error = "User id can't be empty or contain ':', and a name is required."
                }
            }
        }) {
            Label(forId = "sub") { Text("User id") }
            Input(InputType.Text) {
                id("sub")
                value(sub)
                attr("autocomplete", "username")
                attr("autocapitalize", "none")
                onInput { sub = it.value }
            }
            Label(forId = "name") { Text("Display name") }
            Input(InputType.Text) {
                id("name")
                value(name)
                onInput { name = it.value }
            }
            error?.let { P({ classes("error") }) { Text(it) } }
            Button({ classes("primary"); attr("type", "submit") }) { Text("Sign in") }
        }
    }
}

@Composable
private fun TodayScreen(app: AppController) {
    val week = app.week ?: return
    TopBar("Sudoku") {
        Button({ classes("link"); onClick { app.signOut() } }) { Text("Sign out") }
    }
    app.notice?.let { Div({ classes("notice") }) { Text(it) } }
    Div({ classes("card") }) {
        P({ classes("muted") }) {
            Text("${week.today.dayOfWeek.name.lowercase().replaceFirstChar { it.uppercase() }} ${week.today}")
            app.me?.let { Text(" · ${it.displayName}") }
        }
        Ul({ classes("puzzles") }) {
            for (p in app.puzzles) {
                val level = p.difficulty.level
                val status = app.statusOf(level)
                Li {
                    Div {
                        Div({ classes("name") }) { Text(p.difficulty.displayName) }
                        Div({ classes("status") ; if (status is PuzzleStatus.Done) classes("done") }) {
                            Text(
                                when (status) {
                                    PuzzleStatus.New -> "${p.givenCount} givens"
                                    is PuzzleStatus.InProgress -> "In progress · ${formatDuration(status.elapsedMs)}"
                                    is PuzzleStatus.Done ->
                                        "Solved in ${formatDuration(status.elapsedMs)}" + if (status.synced) "" else " · not uploaded yet"
                                },
                            )
                        }
                    }
                    when (status) {
                        PuzzleStatus.New -> Button({ classes("primary"); onClick { app.openPuzzle(level) } }) { Text("Play") }
                        is PuzzleStatus.InProgress -> Button({ classes("primary"); onClick { app.openPuzzle(level) } }) { Text("Resume") }
                        is PuzzleStatus.Done -> Button({ onClick { app.openScores(level) } }) { Text("Scores") }
                    }
                }
            }
        }
    }
    Div({ classes("actions") }) {
        Button({ onClick { app.openScores(0) } }) { Text("Leaderboard") }
    }
}

@Composable
private fun ScoresScreen(app: AppController, screen: Screen.Scores) {
    TopBar("Leaderboard", onBack = { app.openToday() })
    val today = app.today
    Div({ classes("date-nav") }) {
        Button({
            classes("link")
            if (today == null || screen.date <= today.minusDays(8)) disabled()
            onClick { app.shiftScoresDate(-1) }
        }) { Text("‹ Earlier") }
        Span { Text(if (screen.date == today) "Today" else screen.date.toString()) }
        Button({
            classes("link")
            if (today == null || screen.date >= today) disabled()
            onClick { app.shiftScoresDate(1) }
        }) { Text("Later ›") }
    }
    Div({ classes("tabs") }) {
        TabButton("Total", screen.tab == 0) { app.showScoresTab(0) }
        for (d in Difficulty.entries) TabButton(d.displayName, screen.tab == d.level) { app.showScoresTab(d.level) }
    }
    val board = app.leaderboard
    val error = app.leaderboardError
    Div({ classes("card") }) {
        when {
            error != null -> P({ classes("error") }) { Text(error) }
            board == null || board.date != screen.date -> P({ classes("muted") }) { Text("Loading…") }
            screen.tab == 0 -> {
                if (board.total.entries.isEmpty()) {
                    P({ classes("muted") }) { Text("Nobody has finished all five yet.") }
                } else {
                    Table({ classes("board-table") }) {
                        Tbody {
                            for (e in board.total.entries) {
                                ScoreRow(e.rank, e.displayName, e.totalMs, e.userId == app.me?.id)
                            }
                        }
                    }
                }
            }
            else -> {
                val entries = board.puzzles.firstOrNull { it.level == screen.tab }?.entries.orEmpty()
                if (entries.isEmpty()) {
                    P({ classes("muted") }) { Text("No one has solved this one yet.") }
                } else {
                    Table({ classes("board-table") }) {
                        Tbody {
                            for (e in entries) ScoreRow(e.rank, e.displayName, e.elapsedMs, e.userId == app.me?.id)
                        }
                    }
                }
            }
        }
    }
    if (board != null && board.date == screen.date && board.players.isNotEmpty()) {
        Div({ classes("card") }) {
            H2 { Text("Progress") }
            Table({ classes("board-table") }) {
                Tbody {
                    for (p in board.players.sortedWith(compareBy({ -it.completedLevels.size }, { it.displayName }))) {
                        Tr({ if (p.userId == app.me?.id) classes("me") }) {
                            Td { Text(p.displayName) }
                            Td({ classes("time") }) {
                                Span({ classes("levels") }) {
                                    for (level in 1..5) {
                                        Span({ if (level in p.completedLevels) classes("on") }) { Text("$level") }
                                    }
                                }
                                Text(" ${p.completedLevels.size}/5")
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TabButton(label: String, active: Boolean, onClick: () -> Unit) {
    Button({ if (active) classes("active"); onClick { onClick() } }) { Text(label) }
}

@Composable
private fun ScoreRow(rank: Int, name: String, ms: Long, isMe: Boolean) {
    Tr({ if (isMe) classes("me") }) {
        Td({ classes("rank") }) { Text("$rank") }
        Td { Text(name) }
        Td({ classes("time") }) { Text(formatDuration(ms)) }
    }
}

private fun kotlinx.datetime.LocalDate.minusDays(n: Int) =
    kotlinx.datetime.LocalDate.fromEpochDays(toEpochDays() - n)
