package sudoku.web

import kotlinx.browser.document
import kotlinx.browser.window
import kotlinx.coroutines.MainScope
import org.jetbrains.compose.web.renderComposable

fun main() {
    val app = AppController(MainScope(), AppController::defaultAuth)
    window.addEventListener("online", { app.retryUploads() })
    document.getElementById("root")?.innerHTML = ""
    renderComposable(rootElementId = "root") { App(app) }
}
