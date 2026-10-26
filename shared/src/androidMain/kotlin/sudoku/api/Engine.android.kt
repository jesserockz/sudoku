package sudoku.api

import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.engine.okhttp.OkHttp

internal actual fun defaultEngine(): HttpClientEngine = OkHttp.create()
