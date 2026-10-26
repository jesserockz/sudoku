package sudoku.api

import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.engine.java.Java

internal actual fun defaultEngine(): HttpClientEngine = Java.create()
