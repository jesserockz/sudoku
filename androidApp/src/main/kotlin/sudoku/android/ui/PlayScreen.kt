package sudoku.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Button
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import kotlinx.coroutines.delay
import sudoku.android.AppViewModel
import sudoku.core.Geometry
import sudoku.game.Game
import sudoku.game.formatDuration

@Composable
fun PlayScreen(vm: AppViewModel, level: Int) {
    val puzzle = vm.puzzle(level) ?: return
    val game = vm.games[level] ?: return
    var selected by rememberSaveable(level) { mutableStateOf(-1) }
    var notesMode by rememberSaveable(level) { mutableStateOf(false) }
    var paused by rememberSaveable(level) { mutableStateOf(false) }
    var now by androidx.compose.runtime.remember { mutableLongStateOf(vm.ticker.nowMs()) }

    fun pause() {
        vm.update(level) { it.pause(vm.ticker.nowMs()) }
        if (vm.games[level]?.isComplete == false) paused = true
    }

    fun resume() {
        paused = false
        vm.update(level) { it.resume(vm.ticker.nowMs()) }
    }

    fun input(digit: Int) {
        val g = vm.games[level] ?: return
        val i = selected
        if (i < 0 || paused || g.board.isGiven(i)) return
        vm.update(level) {
            when {
                notesMode -> it.toggleNote(i, digit)
                it.board[i] == digit -> it.erase(i)
                else -> it.place(i, digit, vm.ticker.nowMs())
            }
        }
    }

    // The timer runs only while this screen is open and the app is in the foreground.
    DisposableEffect(level) {
        if (!paused) vm.update(level) { it.resume(vm.ticker.nowMs()) }
        onDispose { vm.update(level) { it.pause(vm.ticker.nowMs()) } }
    }
    LifecycleEventEffect(Lifecycle.Event.ON_STOP) { pause() }

    LaunchedEffect(level) {
        while (true) {
            now = vm.ticker.nowMs()
            delay(250)
        }
    }

    Scaffold(topBar = {
        Bar(puzzle.difficulty.displayName, onBack = { vm.openToday() }) {
            if (!game.isComplete && !paused) TextButton(onClick = { pause() }) { Text("Pause") }
        }
    }) { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().padding(horizontal = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 520.dp)) {
                Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "${puzzle.givenCount} givens",
                        Modifier.weight(1f),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(formatDuration(game.elapsedMs(now)), fontWeight = FontWeight.SemiBold, fontSize = 20.sp)
                }
                Box {
                    BoardView(game, selected) { selected = it }
                    if (paused && !game.isComplete) {
                        Column(
                            Modifier.matchParentSize().background(MaterialTheme.colorScheme.surface),
                            verticalArrangement = Arrangement.Center,
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            Text("Paused", style = MaterialTheme.typography.titleLarge)
                            Button(onClick = { resume() }, Modifier.padding(top = 12.dp)) { Text("Resume") }
                        }
                    }
                }
                if (game.isComplete) {
                    Column(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            "Solved in ${formatDuration(game.completedElapsedMs ?: 0)}",
                            style = MaterialTheme.typography.headlineSmall,
                            color = DoneColor,
                            fontWeight = FontWeight.Bold,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 12.dp)) {
                            Button(onClick = { vm.openScores(level) }) { Text("See scores") }
                            OutlinedButton(onClick = { vm.openToday() }) { Text("Today's puzzles") }
                        }
                    }
                } else {
                    Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton({ vm.update(level) { it.undo() } }, Modifier.weight(1f), enabled = game.canUndo && !paused) {
                            Text("Undo")
                        }
                        OutlinedButton({ if (selected >= 0) vm.update(level) { it.erase(selected) } }, Modifier.weight(1f), enabled = !paused) {
                            Text("Erase")
                        }
                        if (notesMode) {
                            Button({ notesMode = false }, Modifier.weight(1f)) { Text("Notes on") }
                        } else {
                            OutlinedButton({ notesMode = true }, Modifier.weight(1f)) { Text("Notes off") }
                        }
                    }
                    Keypad(game, enabled = !paused, notesMode = notesMode, onDigit = ::input)
                }
            }
        }
    }
}

@Composable
private fun Keypad(game: Game, enabled: Boolean, notesMode: Boolean, onDigit: (Int) -> Unit) {
    val counts = IntArray(10).also { c -> for (i in 0 until Geometry.CELLS) c[game.board[i]]++ }
    Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        for (d in 1..9) {
            val left = 9 - counts[d]
            FilledTonalButton(
                onClick = { onDigit(d) },
                enabled = enabled && (left > 0 || notesMode),
                modifier = Modifier.weight(1f).height(60.dp).semantics { contentDescription = "Enter $d, $left left" },
                contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
                shape = MaterialTheme.shapes.small,
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("$d", fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
                    Text(if (left > 0) "$left" else " ", fontSize = 10.sp)
                }
            }
        }
    }
}

@Composable
private fun BoardView(game: Game, selected: Int, onSelect: (Int) -> Unit) {
    val board = game.board
    val conflicts = board.conflicts().toSet()
    val selectedDigit = if (selected >= 0) board[selected] else 0
    val colors = MaterialTheme.colorScheme
    val thin = colors.outlineVariant
    val thick = colors.onSurface
    Column(
        Modifier
            .fillMaxWidth()
            .aspectRatio(1f)
            .border(2.dp, thick)
            .drawWithContent {
                drawContent()
                val cell = size.width / 9
                for (k in 1 until 9) {
                    val w = if (k % 3 == 0) 2.dp.toPx() else 1.dp.toPx()
                    val c = if (k % 3 == 0) thick else thin
                    drawLine(c, Offset(k * cell, 0f), Offset(k * cell, size.height), w)
                    drawLine(c, Offset(0f, k * cell), Offset(size.width, k * cell), w)
                }
            },
    ) {
        for (r in 0 until 9) {
            Row(Modifier.weight(1f)) {
                for (c in 0 until 9) {
                    val i = r * 9 + c
                    val value = board[i]
                    val bg = when {
                        // Translucent tints keep digits readable in light and dark themes.
                        i == selected -> colors.primary.copy(alpha = 0.32f)
                        i in conflicts -> ConflictColor.copy(alpha = 0.15f)
                        selectedDigit != 0 && value == selectedDigit -> colors.primary.copy(alpha = 0.18f)
                        selected >= 0 && i in Geometry.peers[selected] -> colors.onSurface.copy(alpha = 0.06f)
                        else -> Color.Transparent
                    }
                    Box(
                        Modifier
                            .weight(1f)
                            .fillMaxSize()
                            .background(bg)
                            .clickable { onSelect(i) }
                            .semantics {
                                contentDescription = "Row ${r + 1} column ${c + 1}, ${if (value == 0) "empty" else "$value"}"
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        if (value != 0) {
                            Text(
                                "$value",
                                fontSize = 24.sp,
                                fontWeight = if (board.isGiven(i)) FontWeight.SemiBold else FontWeight.Normal,
                                color = when {
                                    i in conflicts -> ConflictColor
                                    board.isGiven(i) -> colors.onSurface
                                    else -> colors.primary
                                },
                            )
                        } else if (!game.notes.isEmpty(i)) {
                            Notes(game, i)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Notes(game: Game, index: Int) {
    Column(Modifier.fillMaxSize().padding(1.dp)) {
        for (r in 0 until 3) {
            Row(Modifier.weight(1f)) {
                for (c in 0 until 3) {
                    val d = r * 3 + c + 1
                    Text(
                        if (game.notes.has(index, d)) "$d" else "",
                        Modifier.weight(1f),
                        fontSize = 9.sp,
                        lineHeight = 10.sp,
                        textAlign = TextAlign.Center,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}
