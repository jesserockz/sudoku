package sudoku.android

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.testing.WorkManagerTestInitHelper
import com.github.takahirom.roborazzi.captureRoboImage
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import sudoku.api.Me
import sudoku.api.OidcConfig
import sudoku.api.WeekResponse
import sudoku.game.GameCalendar
import sudoku.generator.WeekSeed
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Drives the real app UI on Robolectric, offline: the server URL points at a
 * closed port, so this also checks that a cached week is enough to play.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w411dp-h891dp-xxhdpi")
class MainActivityTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val storage get() = AppStorage(context.filesDir)
    private var scenario: ActivityScenario<MainActivity>? = null

    @Before
    fun setUp() {
        WorkManagerTestInitHelper.initializeTestWorkManager(context)
        context.filesDir.listFiles()?.forEach { it.deleteRecursively() }
    }

    @After
    fun tearDown() {
        // Destroy explicitly so this test's Compose root is gone before the next test looks for one.
        scenario?.moveToState(Lifecycle.State.DESTROYED)
        scenario?.close()
        compose.waitForIdle()
    }

    private fun launch() {
        scenario = ActivityScenario.launch(MainActivity::class.java)
        compose.waitForIdle()
    }

    /** Signed in with this week's seed cached, as after a sync earlier in the week. */
    private fun signedInWithCachedWeek() {
        val w = GameCalendar.weekAt()
        storage.settings.write(Settings("http://127.0.0.1:9", DevUser("alice", "Alice")))
        storage.me.write(Me("1", "Alice"))
        storage.week.write(
            WeekResponse(w.isoWeek, WeekSeed.parse("9f2c4a1b7e30d5c8"), w.weekStart, w.weekEnd, w.today, w.dayOfWeek, "Pacific/Auckland"),
        )
    }

    @Test
    fun firstRunAsksForTheServer() {
        launch()
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/setup.png")
        compose.onNodeWithText("Server address").assertIsDisplayed()
        compose.onNodeWithText("Continue").assertIsDisplayed()
    }

    @Test
    fun playsAndSolvesAPuzzleOffline() {
        signedInWithCachedWeek()
        launch()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Offline", substring = true).fetchSemanticsNodes().isNotEmpty() }
        listOf("Easy", "Medium", "Hard", "Expert", "Diabolical").forEach { compose.onNodeWithText(it).assertIsDisplayed() }
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/today.png")

        compose.onAllNodesWithText("Play").onFirst().performClick()
        compose.waitForIdle()
        val puzzle = SudokuApp.from(context).repository.puzzles()!!.first()
        val empties = (0 until 81).filter { puzzle.givens[it] == '0' }

        // Notes on the first empty cell, then fill all but the last cell.
        cell(empties[0]).performClick()
        compose.onNodeWithText("Notes off").performClick()
        digit(1).performClick()
        digit(2).performClick()
        compose.onNodeWithText("Notes on").performClick()
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/notes.png")
        for (i in empties.dropLast(1)) {
            cell(i).performClick()
            digit(puzzle.solution[i] - '0').performClick()
        }
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/play.png")

        // Backgrounding pauses the timer behind a cover.
        scenario!!.moveToState(Lifecycle.State.CREATED)
        scenario!!.moveToState(Lifecycle.State.RESUMED)
        compose.onNodeWithText("Paused").assertIsDisplayed()
        compose.onNodeWithText("Resume").performClick()

        val last = empties.last()
        cell(last).performClick()
        digit(puzzle.solution[last] - '0').performClick()
        compose.onNodeWithText("Solved in", substring = true).assertIsDisplayed()
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/solved.png")

        // The result waits in the offline queue for the upload worker.
        compose.waitUntil(5_000) { runBlocking { storage.pending.load().isNotEmpty() } }
        val pending = runBlocking { storage.pending.load() }
        assertEquals(1, pending.size)
        assertEquals(GameCalendar.today(), pending[0].date)
        assertEquals(1, pending[0].level)

        compose.onNodeWithText("Today's puzzles").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("not uploaded yet", substring = true).assertIsDisplayed()
    }

    @Test
    fun gameSurvivesRestart() {
        signedInWithCachedWeek()
        launch()
        compose.onAllNodesWithText("Play").onFirst().performClick()
        val puzzle = SudokuApp.from(context).repository.puzzles()!!.first()
        val i = puzzle.givens.indexOf('0')
        cell(i).performClick()
        digit(puzzle.solution[i] - '0').performClick()
        scenario!!.moveToState(Lifecycle.State.DESTROYED)
        scenario!!.close()

        launch()
        compose.waitForIdle()
        assertTrue(compose.onAllNodesWithText("In progress", substring = true).fetchSemanticsNodes().isNotEmpty())
        compose.onNodeWithText("Resume").performClick()
        compose.waitForIdle()
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/restored.png")
        compose.onNode(hasContentDescription("column ${i % 9 + 1}, ${puzzle.solution[i]}", substring = true)).assertIsDisplayed()
    }

    @Test
    fun oidcRedirectOpensTheApp() {
        val redirect = Intent(Intent.ACTION_VIEW, Uri.parse(SudokuRepository.REDIRECT_URI + "?code=c&state=s"))
            .addCategory(Intent.CATEGORY_BROWSABLE)
        val resolved = context.packageManager.resolveActivity(redirect, 0)
        assertEquals(MainActivity::class.java.name, resolved?.activityInfo?.name)

        // A redirect this app didn't ask for is rejected with a message.
        scenario = ActivityScenario.launch(redirect.setClass(context, MainActivity::class.java))
        compose.waitUntil(5_000) {
            compose.onAllNodesWithText("didn't match", substring = true).fetchSemanticsNodes().isNotEmpty()
        }
    }

    @Test
    fun expiredOidcSessionStillPlaysAndOffersSignIn() {
        signedInWithCachedWeek()
        storage.settings.write(
            Settings("http://127.0.0.1:9", oidc = OidcConfig("https://auth.example.com/o/sudoku/", "sudoku-android")),
        )
        launch()
        compose.onNodeWithText("Your sign-in has expired.").assertIsDisplayed()
        compose.onNodeWithText("Sign in again").assertIsDisplayed()
        compose.onAllNodesWithText("Play").onFirst().assertIsDisplayed()
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/expired.png")
    }

    private fun cell(i: Int) =
        compose.onNode(hasContentDescription("Row ${i / 9 + 1} column ${i % 9 + 1},", substring = true))

    private fun digit(d: Int) = compose.onNode(hasContentDescription("Enter $d,", substring = true))
}
