package sudoku.web

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.browser.document
import kotlinx.browser.window
import kotlinx.coroutines.delay
import org.jetbrains.compose.web.attributes.disabled
import org.jetbrains.compose.web.dom.Button
import org.jetbrains.compose.web.dom.Div
import org.jetbrains.compose.web.dom.P
import org.jetbrains.compose.web.dom.Span
import org.jetbrains.compose.web.dom.Text
import org.w3c.dom.events.Event
import org.w3c.dom.events.KeyboardEvent
import sudoku.core.Board
import sudoku.core.Geometry
import sudoku.game.Game
import sudoku.game.formatDuration

@Composable
fun PlayScreen(app: AppController, level: Int) {
    val puzzle = app.puzzle(level) ?: return
    val game = app.games[level] ?: return
    var selected by remember(level) { mutableStateOf(-1) }
    var notesMode by remember(level) { mutableStateOf(false) }
    var paused by remember(level) { mutableStateOf(false) }
    var now by remember { mutableStateOf(app.ticker.nowMs()) }

    fun current(): Game? = app.games[level]

    fun pause() {
        app.update(level) { it.pause(app.ticker.nowMs()) }
        if (current()?.isComplete == false) paused = true
    }

    fun resume() {
        paused = false
        app.update(level) { it.resume(app.ticker.nowMs()) }
    }

    fun input(digit: Int) {
        val g = current() ?: return
        val i = selected
        if (i < 0 || paused || g.board.isGiven(i)) return
        app.update(level) {
            when {
                notesMode -> it.toggleNote(i, digit)
                it.board[i] == digit -> it.erase(i)
                else -> it.place(i, digit, app.ticker.nowMs())
            }
        }
    }

    fun erase() {
        if (selected >= 0 && !paused) app.update(level) { it.erase(selected) }
    }

    fun undo() {
        if (!paused) app.update(level) { it.undo() }
    }

    fun move(dRow: Int, dCol: Int) {
        val i = if (selected < 0) 40 else selected
        val r = (Geometry.rowOf(i) + dRow + 9) % 9
        val c = (Geometry.colOf(i) + dCol + 9) % 9
        selected = Geometry.index(r, c)
    }

    // The timer runs only while this screen is open and the page is visible.
    DisposableEffect(level) {
        app.update(level) { it.resume(app.ticker.nowMs()) }
        val onVisibility: (Event) -> Unit = {
            if (document.asDynamic().hidden == true) pause()
        }
        val onKey: (Event) -> Unit = handler@{ e ->
            val k = e as KeyboardEvent
            if (k.altKey) return@handler
            if ((k.ctrlKey || k.metaKey) && k.key.lowercase() == "z") {
                undo()
                k.preventDefault()
                return@handler
            }
            if (k.ctrlKey || k.metaKey) return@handler
            when (k.key) {
                in "123456789" -> if (k.key.length == 1) input(k.key[0] - '0') else return@handler
                "Backspace", "Delete", "0" -> erase()
                "ArrowUp" -> move(-1, 0)
                "ArrowDown" -> move(1, 0)
                "ArrowLeft" -> move(0, -1)
                "ArrowRight" -> move(0, 1)
                "n", "N" -> notesMode = !notesMode
                "Escape" -> selected = -1
                else -> return@handler
            }
            k.preventDefault()
        }
        document.addEventListener("visibilitychange", onVisibility)
        window.addEventListener("keydown", onKey)
        onDispose {
            document.removeEventListener("visibilitychange", onVisibility)
            window.removeEventListener("keydown", onKey)
            app.update(level) { it.pause(app.ticker.nowMs()) }
        }
    }

    LaunchedEffect(level) {
        while (true) {
            now = app.ticker.nowMs()
            delay(250)
        }
    }

    TopBar(puzzle.title, onBack = { app.openToday() }) {
        if (!game.isComplete && !paused) Button({ classes("link"); onClick { pause() } }) { Text("Pause") }
    }

    Div({ classes("play-head") }) {
        Span({ classes("muted") }) { Text("${app.today} · ${puzzle.givenCount} givens") }
        Span({ classes("timer") }) { Text(formatDuration(game.elapsedMs(now))) }
    }

    Div({ classes("board-wrap") }) {
        BoardView(game.board, game, selected) { selected = it }
        if (paused && !game.isComplete) {
            Div({ classes("paused") }) {
                P { Text("Paused") }
                Button({ classes("primary"); onClick { resume() } }) { Text("Resume") }
            }
        }
    }

    if (game.isComplete) {
        Div({ classes("solved") }) {
            P({ classes("big") }) { Text("Solved in ${formatDuration(game.completedElapsedMs ?: 0)}") }
            Div({ classes("actions") }) {
                if (app.seed != null) {
                    ShareResultsButton(app, primary = true)
                } else {
                    Button({ classes("primary"); onClick { app.openScores(level) } }) { Text("See scores") }
                }
                Button({ onClick { app.openToday() } }) { Text("Today's puzzles") }
            }
        }
    } else {
        Div({ classes("controls") }) {
            Button({ if (!game.canUndo || paused) disabled(); onClick { undo() } }) { Text("Undo") }
            Button({ if (paused) disabled(); onClick { erase() } }) { Text("Erase") }
            Button({
                if (!game.canClearAll || paused) disabled()
                attr("aria-label", "Clear board")
                onClick { app.update(level) { it.clearAll() } }
            }) { Text("Clear") }
            Button({
                if (notesMode) classes("active")
                attr("aria-pressed", notesMode.toString())
                onClick { notesMode = !notesMode }
            }) { Text(if (notesMode) "Notes on" else "Notes off") }
        }
        val counts = IntArray(10).also { c -> for (i in 0 until Geometry.CELLS) c[game.board[i]]++ }
        Div({ classes("keypad") }) {
            for (d in 1..9) {
                val left = 9 - counts[d]
                Button({
                    if (paused || (left <= 0 && !notesMode)) disabled()
                    attr("aria-label", "$d, $left left")
                    onClick { input(d) }
                }) {
                    Text("$d")
                    Span({ classes("left") }) { Text(if (left > 0) "$left" else "") }
                }
            }
        }
    }
}

@Composable
private fun BoardView(board: Board, game: Game, selected: Int, onSelect: (Int) -> Unit) {
    val conflicts = board.conflicts().toSet()
    val selectedDigit = if (selected >= 0) board[selected] else 0
    Div({ classes("board"); attr("role", "grid"); attr("aria-label", "Sudoku board") }) {
        for (i in 0 until Geometry.CELLS) {
            val r = Geometry.rowOf(i)
            val c = Geometry.colOf(i)
            val value = board[i]
            Div({
                classes("cell", "r$r", "c$c")
                if (board.isGiven(i)) classes("given")
                if (selected >= 0 && i != selected && i in Geometry.peers[selected]) classes("peer")
                if (selectedDigit != 0 && value == selectedDigit && i != selected) classes("same")
                if (i == selected) classes("selected")
                if (i in conflicts) classes("conflict")
                attr("role", "gridcell")
                attr("aria-label", "Row ${r + 1} column ${c + 1}, ${if (value == 0) "empty" else "$value"}")
                onClick { onSelect(i) }
            }) {
                if (value != 0) {
                    Text("$value")
                } else if (!game.notes.isEmpty(i)) {
                    Div({ classes("notes") }) {
                        for (d in 1..9) Span { Text(if (game.notes.has(i, d)) "$d" else "") }
                    }
                }
            }
        }
    }
}
