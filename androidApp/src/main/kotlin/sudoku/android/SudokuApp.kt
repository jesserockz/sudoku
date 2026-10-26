package sudoku.android

import android.app.Application
import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

class SudokuApp : Application() {
    lateinit var repository: SudokuRepository
        private set

    override fun onCreate() {
        super.onCreate()
        repository = SudokuRepository(AppStorage(filesDir), BuildConfig.DEFAULT_SERVER_URL)
    }

    /**
     * Uploads queued results as soon as there's a network, even if the app is
     * closed; WorkManager retries with backoff until the queue is empty.
     */
    fun scheduleUpload() {
        val request = OneTimeWorkRequestBuilder<UploadWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(this).enqueueUniqueWork("upload-results", ExistingWorkPolicy.REPLACE, request)
    }

    companion object {
        fun from(context: Context) = context.applicationContext as SudokuApp
    }
}

class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val repository = SudokuApp.from(applicationContext).repository
        if (!repository.isSignedIn) return Result.success()
        val report = repository.flush()
        return when {
            report.remaining.isEmpty() -> Result.success()
            // Signed out or token expired: the app uploads again after the next sign-in.
            report.isUnauthorized -> Result.success()
            else -> Result.retry()
        }
    }
}
