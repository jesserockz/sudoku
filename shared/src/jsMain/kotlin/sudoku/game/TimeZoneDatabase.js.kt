package sudoku.game

@JsModule("@js-joda/timezone")
@JsNonModule
private external object JsJodaTimeZoneModule

private var timeZoneModule: Any? = null

internal actual fun loadTimeZoneDatabase() {
    // Referencing the module forces it to load, which registers the IANA zones with js-joda.
    timeZoneModule = JsJodaTimeZoneModule
}
