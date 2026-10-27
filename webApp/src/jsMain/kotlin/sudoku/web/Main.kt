package sudoku.web

import kotlinx.browser.document
import kotlinx.browser.localStorage
import kotlinx.browser.window
import kotlinx.coroutines.MainScope
import org.jetbrains.compose.web.renderComposable
import sudoku.data.AppStorage
import sudoku.data.SudokuRepository
import sudoku.data.WebStorageKeyValueStore

fun main() {
    val storage = AppStorage(WebStorageKeyValueStore({ localStorage }))
    val repo = SudokuRepository(storage, window.location.origin + AppController.CALLBACK_PATH, window.location.origin)
    val app = AppController(MainScope(), storage, repo)
    // Background sync: no Background Sync API on iOS, so sync whenever the app could have a connection again.
    window.addEventListener("online", { app.sync() })
    document.addEventListener("visibilitychange", { if (document.asDynamic().hidden != true) app.sync() })
    registerServiceWorker()
    document.getElementById("root")?.innerHTML = ""
    renderComposable(rootElementId = "root") { App(app) }
}

/** Caches the app shell for offline starts (`sw.js`). Needs a secure context (HTTPS or localhost). */
private fun registerServiceWorker() {
    val serviceWorker = window.navigator.asDynamic().serviceWorker ?: return
    serviceWorker.register("/sw.js").catch { e: dynamic -> console.warn("Service worker registration failed", e) }
}
