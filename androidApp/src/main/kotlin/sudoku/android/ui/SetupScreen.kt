package sudoku.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import sudoku.android.AppViewModel
import sudoku.api.AuthMode

@Composable
fun SetupScreen(vm: AppViewModel) {
    var url by rememberSaveable { mutableStateOf(vm.defaultServerUrl) }
    var sub by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }
    Scaffold(topBar = { Bar("Sudoku") }) { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Connect to your family's Sudoku server.", style = MaterialTheme.typography.bodyLarge)
            OutlinedTextField(
                value = url,
                onValueChange = { url = it },
                label = { Text("Server address") },
                placeholder = { Text("https://sudoku.example.com") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth(),
            )
            when (vm.setupAuthMode) {
                null -> Button(onClick = { vm.checkServer(url) }, enabled = url.isNotBlank() && !vm.setupBusy) {
                    Text("Continue")
                }
                AuthMode.DEV -> {
                    Text("This server is in dev auth mode: pick any user id and name.", style = MaterialTheme.typography.bodyMedium)
                    OutlinedTextField(sub, { sub = it }, label = { Text("User id") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(name, { name = it }, label = { Text("Display name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    Button(onClick = { vm.signInDev(url, sub, name) }, enabled = !vm.setupBusy) { Text("Sign in") }
                }
                AuthMode.OIDC -> Text(
                    "This server uses OIDC sign-in, which this build doesn't support yet.",
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            if (vm.setupBusy) CircularProgressIndicator()
            vm.setupError?.let { Text(it, color = ConflictColor) }
        }
    }
}
