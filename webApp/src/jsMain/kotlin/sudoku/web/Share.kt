package sudoku.web

import kotlinx.browser.document
import kotlinx.browser.window
import kotlinx.coroutines.await
import org.w3c.dom.HTMLTextAreaElement
import kotlin.js.Promise

/** Whether the browser has the Web Share API (mostly phones): it opens the system share sheet. */
val canShare: Boolean get() = window.navigator.asDynamic().share != null

/**
 * Opens the share sheet with [text] and/or [url]. Returns false if the
 * browser can't share or the player cancelled.
 */
suspend fun share(title: String, text: String? = null, url: String? = null): Boolean {
    if (!canShare) return false
    val data = js("({})")
    data.title = title
    if (text != null) data.text = text
    if (url != null) data.url = url
    return try {
        (window.navigator.asDynamic().share(data) as Promise<Any?>).await()
        true
    } catch (e: Throwable) {
        false
    }
}

/** Copies [text] to the clipboard. The async Clipboard API needs a secure context; older browsers use a hidden text area. */
suspend fun copyText(text: String): Boolean {
    val clipboard = window.navigator.asDynamic().clipboard
    if (clipboard != null) {
        try {
            (clipboard.writeText(text) as Promise<Any?>).await()
            return true
        } catch (e: Throwable) {
            // Fall through to the legacy way.
        }
    }
    val area = document.createElement("textarea") as HTMLTextAreaElement
    area.value = text
    area.setAttribute("readonly", "")
    area.style.position = "fixed"
    area.style.opacity = "0"
    document.body?.appendChild(area)
    area.select()
    val copied = try {
        document.asDynamic().execCommand("copy") as Boolean
    } catch (e: Throwable) {
        false
    }
    area.remove()
    return copied
}
