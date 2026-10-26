package sudoku.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import sudoku.android.ui.PlayScreen
import sudoku.android.ui.ScoresScreen
import sudoku.android.ui.SetupScreen
import sudoku.android.ui.SudokuTheme
import sudoku.android.ui.TodayScreen

class MainActivity : ComponentActivity() {
    private val vm: AppViewModel by viewModels {
        viewModelFactory { initializer { AppViewModel(application) } }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            SudokuTheme {
                // Coming back to the app (e.g. the next morning) syncs and catches up with the date.
                LifecycleEventEffect(Lifecycle.Event.ON_START) {
                    if (vm.screen !is Screen.Setup) vm.sync()
                }
                BackHandler(enabled = vm.screen is Screen.Play || vm.screen is Screen.Scores) { vm.back() }
                when (val screen = vm.screen) {
                    Screen.Setup -> SetupScreen(vm)
                    Screen.Today -> TodayScreen(vm)
                    is Screen.Play -> PlayScreen(vm, screen.level)
                    is Screen.Scores -> ScoresScreen(vm, screen)
                }
            }
        }
    }
}
