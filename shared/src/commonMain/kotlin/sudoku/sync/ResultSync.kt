package sudoku.sync

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.datetime.LocalDate
import sudoku.api.ApiException
import sudoku.api.GameResult
import sudoku.api.SubmitOutcome

/** Durable storage for results not yet accepted by the server. */
interface PendingResultStore {
    suspend fun load(): List<GameResult>

    suspend fun save(results: List<GameResult>)
}

/** In-memory [PendingResultStore], for tests and as a fallback. */
class InMemoryPendingResultStore(initial: List<GameResult> = emptyList()) : PendingResultStore {
    private var results = initial

    override suspend fun load() = results

    override suspend fun save(results: List<GameResult>) {
        this.results = results
    }
}

/** What one [ResultSync.flush] did. */
data class FlushReport(
    /** Accepted by the server (`201`) or already stored there (`200`). */
    val accepted: List<GameResult>,
    /** Rejected with `400`: dropped, never retried. */
    val rejected: List<GameResult>,
    /** Still queued because the server couldn't be reached or failed. */
    val remaining: List<GameResult>,
    /** Why the flush stopped early, if it did. */
    val failure: Throwable?,
) {
    val isUnauthorized: Boolean get() = (failure as? ApiException)?.isUnauthorized == true
}

/**
 * The offline result queue: completed puzzles are queued durably, then sent
 * oldest first. Per `docs/API.md`, `200`/`201` and `400` remove a result from the
 * queue; anything else (network failure, `401`, `5xx`) leaves it and the rest
 * queued for the next flush.
 *
 * At most one result per `(date, level)` is queued; the first one wins, as on
 * the server.
 */
class ResultSync(
    private val store: PendingResultStore,
    private val submit: suspend (GameResult) -> SubmitOutcome,
) {
    private val mutex = Mutex()

    suspend fun pending(): List<GameResult> = mutex.withLock { store.load() }

    suspend fun enqueue(result: GameResult) = mutex.withLock {
        val queued = store.load()
        if (queued.none { it.date == result.date && it.level == result.level }) store.save(queued + result)
    }

    suspend fun isPending(date: LocalDate, level: Int): Boolean =
        pending().any { it.date == date && it.level == level }

    suspend fun flush(): FlushReport = mutex.withLock {
        val queue = store.load().toMutableList()
        val accepted = mutableListOf<GameResult>()
        val rejected = mutableListOf<GameResult>()
        var failure: Throwable? = null
        while (queue.isNotEmpty()) {
            val next = queue.first()
            val outcome = try {
                submit(next)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                failure = e
                break
            }
            when (outcome) {
                is SubmitOutcome.Created, is SubmitOutcome.AlreadyStored -> accepted += next
                is SubmitOutcome.Rejected -> rejected += next
            }
            queue.removeAt(0)
            store.save(queue.toList())
        }
        FlushReport(accepted, rejected, queue.toList(), failure)
    }
}
