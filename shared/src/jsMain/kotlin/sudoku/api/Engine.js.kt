package sudoku.api

import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.engine.js.Js

internal actual fun defaultEngine(): HttpClientEngine = Js.create()
