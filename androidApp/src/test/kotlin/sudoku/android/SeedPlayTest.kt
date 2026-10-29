package sudoku.android

import android.content.Context
import android.content.Intent
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
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
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import sudoku.game.GameCalendar
import sudoku.generator.Generator
import sudoku.serverless.PlaySeed
import sudoku.serverless.SeedRepository
import sudoku.serverless.SeedSettings
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Serverless play on Robolectric: seed setup, share links, and identical puzzles for the same seed. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w411dp-h891dp-xxhdpi")
class SeedPlayTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val seeds get() = SudokuApp.from(context).seeds
    private var scenario: ActivityScenario<MainActivity>? = null

    @Before
    fun setUp() {
        WorkManagerTestInitHelper.initializeTestWorkManager(context)
        context.filesDir.listFiles()?.forEach { it.deleteRecursively() }
    }

    @After
    fun tearDown() {
        scenario?.moveToState(Lifecycle.State.DESTROYED)
        scenario?.close()
        compose.waitForIdle()
    }

    private fun launch(intent: Intent? = null) {
        scenario = if (intent == null) {
            ActivityScenario.launch(MainActivity::class.java)
        } else {
            ActivityScenario.launch(intent.setClass(context, MainActivity::class.java))
        }
        compose.waitForIdle()
    }

    private fun waitForText(text: String, substring: Boolean = false) =
        compose.waitUntil(5_000) { compose.onAllNodesWithText(text, substring = substring).fetchSemanticsNodes().isNotEmpty() }

    private fun openSeedSetup() {
        compose.onNodeWithText("Play with a seed").performScrollTo().performClick()
        waitForText("Start playing")
    }

    @Test
    fun firstRunGeneratesASeedAndPlaysItOffline() {
        launch()
        openSeedSetup()
        compose.onNodeWithText("Generate").performClick()
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/seed-setup.png")
        compose.onNodeWithText("Start playing").performClick()
        waitForText("Diabolical")
        listOf("Easy", "Medium", "Hard", "Expert", "Diabolical").forEach { compose.onNodeWithText(it).assertIsDisplayed() }
        compose.onNodeWithText("Share results").assertExists()
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/seed-today.png")

        // The seed is generated, kept in app storage, and gives the Generator's puzzles for its week seed.
        val profile = assertNotNull(seeds.profile())
        assertTrue(Regex("^[0-9a-hjkmnp-tv-z]{5}(-[0-9a-hjkmnp-tv-z]{5}){3}$").matches(profile.settings.seed), profile.settings.seed)
        assertTrue(File(context.filesDir, "seed.json").exists())
        val today = GameCalendar.today()
        val expected = runBlocking {
            Generator.generateDay(PlaySeed.weekSeed(profile.settings.seed, GameCalendar.isoWeek(today)), GameCalendar.dayOfWeek(today), 5)
        }
        assertEquals(expected, runBlocking { seeds.puzzles() })

        // No server: nothing is queued for upload when a game is solved, but it's in the history.
        compose.onAllNodesWithText("Play").onFirst().performClick()
        val puzzle = expected.first()
        for (i in 0 until 81) {
            if (puzzle.givens[i] != '0') continue
            cell(i).performClick()
            digit(puzzle.solution[i] - '0').performClick()
        }
        compose.onNodeWithText("Solved in", substring = true).assertIsDisplayed()
        compose.onNodeWithText("Share results").performClick()
        compose.waitForIdle()
        var activity: MainActivity? = null
        scenario!!.onActivity { activity = it }
        val chooser = shadowOf(activity!!).nextStartedActivity
        assertEquals(Intent.ACTION_CHOOSER, chooser.action)
        @Suppress("DEPRECATION")
        val sent = chooser.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
        val summary = sent?.getStringExtra(Intent.EXTRA_TEXT).orEmpty()
        assertTrue(summary.startsWith("Sudoku $today ${profile.fingerprint}\nEasy "), summary)
        assertTrue(profile.settings.seed !in summary)
        assertEquals(1, seeds.history().size)
        assertNull(AppStorage(context.filesDir).pending.value.read())
    }

    @Test
    fun aPastedLinkSetsTheGroupsSettingsAndTheSameSeedGivesTheSamePuzzles() {
        launch()
        openSeedSetup()
        compose.onNode(hasSetTextAction() and hasText("Seed or share link")).performTextInput(
            "https://example.github.io/sudoku/#seed=K%C5%8Dwhai%20%F0%9F%8C%BC&levels=3&tz=Europe%2FLondon",
        )
        compose.onNodeWithText("Start playing").performClick()
        waitForText("Diabolical")
        assertEquals(3, compose.onAllNodesWithText("Play").fetchSemanticsNodes().size)
        assertEquals(SeedSettings("Kōwhai 🌼", 3, "Europe/London"), seeds.profile()?.settings)

        // Another device (its own storage) with the same seed gets the same puzzles.
        val other = SeedRepository(FileKeyValueStore(File(context.cacheDir, "other-device")))
        runBlocking {
            other.use(SeedSettings("Kōwhai 🌼", 3, "Europe/London"))
            assertEquals(other.puzzles(), seeds.puzzles())
        }
    }

    @Test
    fun aSharedLinkAsksBeforeReplacingTheSeed() {
        runBlocking { seeds.use(SeedSettings("first-group")) }
        // A new intent each time: the activity clears a handled intent's action so it isn't replayed.
        fun share() = Intent(Intent.ACTION_SEND).setType("text/plain")
            .putExtra(Intent.EXTRA_TEXT, "Play with us! https://example.com/#seed=second-group&levels=5 see you")
        val resolved = context.packageManager.resolveActivity(share(), 0)
        assertEquals(MainActivity::class.java.name, resolved?.activityInfo?.name)

        launch(share())
        waitForText("Switch to this seed?")
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/seed-confirm.png")
        compose.onNodeWithText("Keep current").performClick()
        compose.waitForIdle()
        assertEquals("first-group", seeds.profile()?.settings?.seed)
        compose.onNodeWithText("seed=first-group", substring = true).assertExists()

        scenario!!.moveToState(Lifecycle.State.DESTROYED)
        scenario!!.close()
        launch(share())
        waitForText("Switch to this seed?")
        compose.onNodeWithText("Switch").performClick()
        compose.waitUntil(5_000) { seeds.profile()?.settings?.seed == "second-group" }
        waitForText("seed=second-group", substring = true)
    }

    @Test
    fun leavingTheSeedReturnsToFirstRunAndKeepsItsProgress() {
        runBlocking { seeds.use(SeedSettings("kauri")) }
        launch()
        waitForText("Easy")
        compose.onAllNodesWithText("Play").onFirst().performClick()
        val puzzle = runBlocking { seeds.puzzles() }.first()
        val i = puzzle.givens.indexOf('0')
        cell(i).performClick()
        digit(puzzle.solution[i] - '0').performClick()
        compose.onNode(hasContentDescription("Back")).performClick()
        compose.onNodeWithText("Leave seed").performScrollTo().performClick()
        waitForText("Server address")
        assertNull(seeds.profile())

        openSeedSetup()
        compose.onNode(hasSetTextAction() and hasText("Seed or share link")).performTextInput("kauri")
        compose.onNodeWithText("Start playing").performClick()
        waitForText("In progress", substring = true)
    }

    private fun cell(i: Int) =
        compose.onNode(hasContentDescription("Row ${i / 9 + 1} column ${i % 9 + 1},", substring = true))

    private fun digit(d: Int) = compose.onNode(hasContentDescription("Enter $d,", substring = true))
}
