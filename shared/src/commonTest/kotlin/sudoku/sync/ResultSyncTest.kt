package sudoku.sync

import kotlinx.coroutines.test.runTest
import kotlinx.datetime.LocalDate
import sudoku.api.ApiError
import sudoku.api.ApiException
import sudoku.api.GameResult
import sudoku.api.SubmitOutcome
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ResultSyncTest {
    private fun result(level: Int, day: Int = 26) =
        GameResult(LocalDate(2026, 10, day), level, 60_000L * level, "2026-10-${day}T09:00:00+13:00")

    @Test
    fun acceptedAndDuplicateResultsLeaveTheQueue() = runTest {
        val store = InMemoryPendingResultStore()
        val sent = mutableListOf<GameResult>()
        val sync = ResultSync(store) {
            sent += it
            if (it.level == 1) SubmitOutcome.Created(it) else SubmitOutcome.AlreadyStored(it.copy(elapsedMs = 1))
        }
        sync.enqueue(result(1))
        sync.enqueue(result(2))
        val report = sync.flush()
        assertEquals(listOf(result(1), result(2)), sent)
        assertEquals(listOf(result(1), result(2)), report.accepted)
        assertTrue(report.remaining.isEmpty())
        assertNull(report.failure)
        assertTrue(store.load().isEmpty())
    }

    @Test
    fun rejectedResultsAreDroppedNotRetried() = runTest {
        val store = InMemoryPendingResultStore()
        var calls = 0
        val sync = ResultSync(store) {
            calls++
            if (it.level == 1) SubmitOutcome.Rejected(ApiError("invalid_result", "too fast")) else SubmitOutcome.Created(it)
        }
        sync.enqueue(result(1))
        sync.enqueue(result(2))
        val report = sync.flush()
        assertEquals(listOf(result(1)), report.rejected)
        assertEquals(listOf(result(2)), report.accepted)
        assertTrue(store.load().isEmpty())
        sync.flush()
        assertEquals(2, calls)
    }

    @Test
    fun failuresKeepTheRestQueuedInOrder() = runTest {
        val store = InMemoryPendingResultStore()
        var online = false
        val sync = ResultSync(store) {
            if (!online && it.level == 2) throw RuntimeException("offline")
            SubmitOutcome.Created(it)
        }
        listOf(1, 2, 3).forEach { sync.enqueue(result(it)) }
        val first = sync.flush()
        assertEquals(listOf(result(1)), first.accepted)
        assertEquals(listOf(result(2), result(3)), first.remaining)
        assertEquals("offline", first.failure?.message)
        assertEquals(listOf(result(2), result(3)), store.load())
        assertTrue(sync.isPending(LocalDate(2026, 10, 26), 2))

        online = true
        val second = sync.flush()
        assertEquals(listOf(result(2), result(3)), second.accepted)
        assertTrue(store.load().isEmpty())
        assertFalse(sync.isPending(LocalDate(2026, 10, 26), 2))
    }

    @Test
    fun unauthorizedStopsTheFlush() = runTest {
        val sync = ResultSync(InMemoryPendingResultStore(listOf(result(1)))) {
            throw ApiException(401, ApiError("unauthorized", "expired"))
        }
        val report = sync.flush()
        assertTrue(report.isUnauthorized)
        assertEquals(listOf(result(1)), report.remaining)
    }

    @Test
    fun onePendingResultPerPuzzle() = runTest {
        val store = InMemoryPendingResultStore()
        val sync = ResultSync(store) { SubmitOutcome.Created(it) }
        sync.enqueue(result(1))
        sync.enqueue(result(1).copy(elapsedMs = 1))
        sync.enqueue(result(1, day = 25))
        assertEquals(listOf(result(1), result(1, day = 25)), store.load())
    }
}
